# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The Skills domain - the world knows how to do things.

A skill is a directory with a SKILL.md (YAML frontmatter `name:` + `description:`, then
the body). The catalogue is the skill trees on the machine - two roots, configured per
machine (NOTCHFOLK_MCP_SKILLS_ROOTS, `name:path` pairs, comma-separated; a root that is
not a directory is skipped): a flat tree (one SKILL.md per directory, no nesting) and a
nested one (categories as subdirectories, plus an archive subtree hidden by default).
Notchfolk reads the trees directly; it runs or proxies nothing.

The id is `<source>:<relative-dir>`; same-named skills in both trees are different ids.
The index is built once at import and rebuilt by `skills_refresh`. The design constraint
from the reference holds: no one tool per skill - the MCP surface stays at these seven
coarse tools, all read-only on the default key's skills:read, the skill's identity and
content travelling as parameters and return values.

Reads are capped (a SKILL.md at 150,000 bytes, a single file at 200,000, a listing at
1,000 files), and credential-like files are refused on read altogether - `.env` by
basename, `.pem`/`.key`/`.p12`/.pfx` by suffix, `credential`/`secret`/`token`/
`private_key` by substring in the lowercase basename.

The domain is offered only when a root answers (the spec's availability rule).
"""

import os
import re
from pathlib import Path

SKILL_MD = "SKILL.md"
SKILL_MD_CAP = 150_000
FILE_CAP = 200_000
LIST_CAP = 1_000
DENIED_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
DENIED_SUBSTRINGS = ("credential", "secret", "token", "private_key")

READ_SCOPES = {
    "skills_list": "skills:read", "skills_search": "skills:read",
    "skills_get": "skills:read", "skills_list_files": "skills:read",
    "skills_read_file": "skills:read", "skills_stats": "skills:read",
    "skills_refresh": "skills:read",
}

WRITE_SCOPES = {}


def _roots() -> dict:
    """The configured skill trees, `{source: root}`; a root that is not a directory is skipped."""
    raw = os.getenv("NOTCHFOLK_MCP_SKILLS_ROOTS",
                    "agents:~/.agents/skills,hermes:~/.hermes/skills")
    roots = {}
    for pair in raw.split(","):
        name, _, path = pair.partition(":")
        name, path = name.strip(), (path or "").strip()
        if name and path:
            root = Path(path).expanduser()
            if root.is_dir():
                roots[name] = root
    return roots


def available() -> bool:
    """Whether a skill tree answers - the spec's availability rule."""
    return bool(_roots())


def _ok(**fields) -> dict:
    return {"ok": True, **fields}


def _fail(message: str, **fields) -> dict:
    return {"ok": False, "error": message, **fields}


def _description(text: str) -> str:
    """The frontmatter's description (folded `>`, `>-`, `|`, `|-` forms join indented lines
    with spaces), else the first non-heading non-empty body line (first 300 chars)."""
    if not text.startswith("---"):
        body = text
        frontmatter = ""
    else:
        frontmatter, _, body = text.partition("\n---")
    if text.startswith("---"):
        match = re.search(r"^description:\s*>?-?\|?-?\s*\n((?:[ \t]+.*\n?)+)", frontmatter, re.M)
        if match:
            return " ".join(line.strip() for line in match.group(1).splitlines() if line.strip())[:300]
        match = re.search(r"^description:\s*(.+)$", frontmatter, re.M)
        if match:
            return match.group(1).strip()[:300]
    for line in body.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped[:300]
    return ""


def _index() -> list:
    """Every skill in the trees, sorted: {id, source, rel, name, description, archived, dir}."""
    skills = []
    for source, root in sorted(_roots().items()):
        for skill_md in sorted(root.rglob(SKILL_MD)):
            directory = skill_md.parent
            rel = directory.relative_to(root).as_posix()
            text = skill_md.read_text(encoding="utf-8-sig", errors="replace")[:SKILL_MD_CAP]
            frontmatter = text[3:].partition("\n---")[0] if text.startswith("---") else ""
            name = re.search(r"^name:\s*(.+)$", frontmatter, re.M)
            skills.append({
                "id": f"{source}:{rel}",
                "source": source,
                "rel": rel,
                "name": (name.group(1).strip() if name else directory.name),
                "description": _description(text),
                "archived": ".archive" in rel,
                "dir": directory,
            })
    return skills


_INDEX = None


def _skills() -> list:
    """The index, built once at import (see `skills_refresh` for the rebuilding)."""
    global _INDEX
    if _INDEX is None:
        _INDEX = _index()
    return _INDEX


def _find(skill_id: str):
    return next((skill for skill in _skills() if skill["id"] == skill_id), None)


def _denied(path: Path) -> bool:
    """Whether the file looks like it carries credentials: refused on read altogether."""
    name = path.name.lower()
    return (name == ".env" or name.endswith(DENIED_SUFFIXES)
            or any(substring in name for substring in DENIED_SUBSTRINGS))


def register(mcp, authorize, write):
    """Registers the Skills domain's tools - only when a tree answers."""
    if not available():
        return

    @mcp.tool
    async def skills_list(source: str = "all", query: str = "", include_archived: bool = False,
                          limit: int = 50, offset: int = 0) -> dict:
        """The catalogue's skills, filtered and paged."""
        await authorize("skills_list")
        sources = _roots()
        if source != "all" and source not in sources:
            return _fail(f"source must be all or one of: {', '.join(['all', *sources])}")
        limit = max(1, min(200, limit))
        query = query.casefold()
        found = [skill for skill in _skills()
                 if (source == "all" or skill["source"] == source)
                 and (include_archived or not skill["archived"])
                 and (not query or query in skill["name"].casefold()
                      or query in skill["rel"].casefold() or query in skill["description"].casefold())]
        return _ok(total=len(found), limit=limit, offset=offset,
                   skills=[{key: skill[key] for key in ("id", "source", "rel", "name", "description", "archived")}
                           for skill in found[offset:offset + limit]])

    @mcp.tool
    async def skills_search(query: str, source: str = "all", include_archived: bool = False,
                            limit: int = 20) -> dict:
        """Searches the catalogue: the closest matches first."""
        await authorize("skills_search")
        if not query:
            return _ok(query=query, total=0, skills=[])
        sources = _roots()
        if source != "all" and source not in sources:
            return _fail(f"source must be all or one of: {', '.join(['all', *sources])}")
        limit = max(1, min(100, limit))
        query_folded = query.casefold()

        def score(skill) -> int:
            name = skill["name"].casefold()
            if query_folded == name:
                return 100
            if query_folded in name:
                return 80
            if query_folded in skill["rel"].casefold():
                return 60
            if query_folded in skill["description"].casefold():
                return 40
            return 0

        found = [(skill, score(skill)) for skill in _skills()
                  if (source == "all" or skill["source"] == source)
                  and (include_archived or not skill["archived"])]
        found = sorted(((skill, value) for skill, value in found if value > 0),
                       key=lambda pair: (-pair[1], pair[0]["name"]))
        return _ok(query=query, total=len(found),
                   skills=[{**{key: skill[key] for key in ("id", "source", "rel", "name", "description", "archived")}, "score": value}
                           for skill, value in found[:limit]])

    @mcp.tool
    async def skills_get(skill_id: str) -> dict:
        """One skill whole: its SKILL.md and the first of its files."""
        await authorize("skills_get")
        skill = _find(skill_id)
        if not skill:
            return _fail(f"unknown skill_id: {skill_id}",
                         hint="use skills_list / skills_search to find a valid id")
        data = (skill["dir"] / SKILL_MD).read_bytes()[:SKILL_MD_CAP + 1]
        return _ok(skill=skill_id,
                   **{key: skill[key] for key in ("source", "rel", "name", "description", "archived")},
                   content=data[:SKILL_MD_CAP].decode("utf-8-sig", errors="replace"),
                   truncated=len(data) > SKILL_MD_CAP,
                   files=(await skills_list_files(skill_id)).get("files", [])[:200])

    @mcp.tool
    async def skills_list_files(skill_id: str) -> dict:
        """The skill's files, sorted, with their sizes."""
        await authorize("skills_list_files")
        skill = _find(skill_id)
        if not skill:
            return _fail(f"unknown skill_id: {skill_id}",
                         hint="use skills_list / skills_search to find a valid id")
        files = [{"path": path.relative_to(skill["dir"]).as_posix(), "bytes": path.stat().st_size}
                 for path in sorted(p for p in skill["dir"].rglob("*") if p.is_file())][:LIST_CAP]
        return _ok(skill=skill_id, files=files)

    @mcp.tool
    async def skills_read_file(skill_id: str, path: str) -> dict:
        """Reads one file of the skill - relative, inside it, and never a credential-like one."""
        await authorize("skills_read_file")
        skill = _find(skill_id)
        if not skill:
            return _fail(f"unknown skill_id: {skill_id}",
                         hint="use skills_list / skills_search to find a valid id")
        if not path or path.startswith("/") or ".." in Path(path).parts:
            return _fail("refused: path escapes the skill directory")
        target = (skill["dir"] / path)
        try:
            target.resolve().relative_to(skill["dir"].resolve())
        except ValueError:
            return _fail("refused: path escapes the skill directory")
        if _denied(target):
            return _fail("refused: credential-like file")
        if not target.is_file():
            return _fail(f"no such file: {path}")
        data = target.read_bytes()
        if len(data) > FILE_CAP:
            return _fail("file too large")
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            return _fail("not a readable text file (binary or unreadable)")
        return _ok(skill=skill_id, path=path, bytes=len(data), content=content)

    @mcp.tool
    async def skills_stats() -> dict:
        """The catalogue's numbers: per source, per archive, and the roots."""
        await authorize("skills_stats")
        return _ok(**_stats())

    @mcp.tool
    async def skills_refresh() -> dict:
        """Rebuilds the index - new skills appear, removed ones go."""
        await authorize("skills_refresh")
        global _INDEX
        _INDEX = _index()
        return _ok(refreshed=True, **_stats())


def _stats() -> dict:
    skills = _skills()
    stats = {"total": len(skills)}
    for source, root in _roots().items():
        stats[source] = sum(1 for skill in skills if skill["source"] == source)
    stats["archived"] = sum(1 for skill in skills if skill["archived"])
    stats["active"] = stats["total"] - stats["archived"]
    stats["roots"] = {source: str(root) for source, root in _roots().items()}
    return stats
