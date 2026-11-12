# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The Memory domain - the Obsidian backend: notes, and memory's fallback.

Value: the world remembers, and the notes are the user's own. The vault is a directory of
Markdown notes on the machine (NOTCHFOLK_MCP_VAULT, or the first vault found under the home
directory - a folder with an .obsidian marker); every path goes through one gate, and the
gate is the whole safety story: vault-relative POSIX paths only, no absolute paths, no
`..`, no hidden parts (the private internals - .obsidian, .git, .trash - live there and are
never reachable), every part symlink-checked while descending, the resolved path kept inside
the vault.

The read tools - the overview, the guide, the sync status, search, list, read, recent,
backlinks, the templates and the workflow skills - ride the default key's notes:read. The
four that change something - create, update, patch, move - sit behind notes:write. Create
never overwrites (O_EXCL); updates and moves require the current SHA-256, so a note that
changed since it was read is a conflict, not a silent loss; there is no delete tool, by
design - archive or move notes instead of permanent deletion.

The domain is offered only when a vault answers (the spec's availability rule); a vault
that disappears between calls answers as a normal, isolated error (AC-5).
"""

import hashlib
import os
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

VAULT = os.getenv("NOTCHFOLK_MCP_VAULT", "")
"""Where the workflow skills live, beside the vault's own notes."""
SKILLS = os.getenv("NOTCHFOLK_MCP_SKILLS", str(Path.home() / ".local/share/notchfolk/skills"))

TEMPLATE_DIR = "_System/Templates"
PRIVATE = {".obsidian", ".claudian", ".git", ".trash"}
MAX_NOTE_BYTES = 512_000
TEMPLATE_MAX = 40_000
SKILL_MAX = 100_000
SYNC_TIMEOUT = 8

READ_SCOPES = {
    "obsidian_overview": "notes:read", "obsidian_guide": "notes:read",
    "obsidian_sync_status": "notes:read", "obsidian_search": "notes:read",
    "obsidian_list": "notes:read", "obsidian_read": "notes:read",
    "obsidian_recent": "notes:read", "obsidian_backlinks": "notes:read",
    "obsidian_templates_list": "notes:read", "obsidian_template_read": "notes:read",
    "obsidian_skills_list": "notes:read", "obsidian_skill_get": "notes:read",
}

WRITE_SCOPES = {
    "obsidian_create_note": "notes:write", "obsidian_update_note": "notes:write",
    "obsidian_patch_note": "notes:write", "obsidian_move_note": "notes:write",
}


def vault_path() -> Path | None:
    """The configured vault, or the first one found under the home directory."""
    if VAULT:
        path = Path(VAULT).expanduser()
        return path if path.is_dir() else None
    home = Path.home()
    for candidate in [home, *sorted(home.glob("*")), *sorted((home / "Documents").glob("*"))]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def available() -> bool:
    """Whether a vault answers - the spec's availability rule."""
    return vault_path() is not None


def _ok(**fields) -> dict:
    return {"ok": True, **fields}


def _fail(message: str, **fields) -> dict:
    return {"ok": False, "error": message, **fields}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _modified(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")


def _safe_path(vault: Path, relative: str) -> Path | dict:
    """The one gate every path goes through: vault-relative POSIX paths, no backslashes,
    no absolute paths, no `..`, no empty or hidden parts, every part symlink-checked while
    descending, the resolved path kept inside the vault."""
    if not relative or "\\" in relative or relative.startswith("/"):
        return _fail(f"not a vault-relative path: {relative!r}")
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts) or any(
            part.startswith(".") for part in parts):
        return _fail(f"the path has a part that is not allowed: {relative!r}")
    walked = vault
    for part in parts:
        walked = walked / part
        if walked.is_symlink():
            return _fail(f"the path leaves the vault through a symlink: {relative!r}")
    try:
        walked.resolve().relative_to(vault.resolve())
    except ValueError:
        return _fail(f"the path leaves the vault: {relative!r}")
    return walked


def _notes(vault: Path, include_templates: bool = False):
    """Every note in the vault, as (path, title). The walk never descends into a hidden
    or private folder (pruned at the folder, not filtered after), never follows a
    directory symlink, and skips a symlinked or over-cap note it meets."""
    for root, folders, files in os.walk(vault, followlinks=False):
        folders[:] = sorted(folder for folder in folders
                           if not folder.startswith(".") and folder not in PRIVATE)
        for name in sorted(files):
            if not name.endswith(".md"):
                continue
            path = Path(root) / name
            relative = path.relative_to(vault)
            if path.is_symlink():
                continue
            if not include_templates and TEMPLATE_DIR in relative.parts:
                continue
            if path.stat().st_size > MAX_NOTE_BYTES:
                continue
            yield path, relative


def _write_atomic(path: Path, data: bytes) -> None:
    """The temp file beside the target, the same mode, then os.replace."""
    temp = path.with_name(path.name + ".tmp")
    with open(temp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temp, path.stat().st_mode if path.exists() else 0o600)
    os.replace(temp, path)


def register(mcp, authorize, write):
    """Registers the Obsidian backend's tools - only when a vault answers."""
    if not available():
        return

    @mcp.tool
    async def obsidian_overview() -> dict:
        """The vault at a glance: how many notes, its top-level folders, its sections."""
        await authorize("obsidian_overview")
        vault = vault_path()
        notes = list(_notes(vault, include_templates=True))
        folders = sorted(p.name for p in vault.iterdir()
                         if p.is_dir() and not p.name.startswith(".") and p.name not in PRIVATE)
        by_section = {}
        for _, relative in notes:
            section = relative.parts[0] if len(relative.parts) > 1 else "(root)"
            by_section[section] = by_section.get(section, 0) + 1
        return _ok(vault_name=vault.name, vault_path=str(vault), markdown_notes=len(notes),
                   top_level_folders=folders, notes_by_section=by_section,
                   templates_path=TEMPLATE_DIR,
                   private_internal_paths_excluded=sorted(PRIVATE),
                   write_safety="Create never overwrites. Updates and moves require the current SHA-256.",
                   delete_tool="Not exposed; archive or move notes instead of permanent deletion.")

    @mcp.tool
    async def obsidian_guide(topic: str = "overview") -> dict:
        """The vault's own guide: overview, structure, workflow, safety or updates."""
        await authorize("obsidian_guide")
        vault = vault_path()
        guides = {
            "overview": "Notes as Markdown in folders; links between them by [[name]]; everything stays inside the vault.",
            "structure": f"Folders of the user's own; templates under {TEMPLATE_DIR}; the private internals are never reachable.",
            "workflow": "Search or list to find, read before changing, create for new notes, update or patch with the SHA-256 from the read, move to refile.",
            "safety": "Create never overwrites; updates and moves need the current SHA-256, so a changed note is a conflict, not a loss; there is no delete.",
            "updates": "The SHA-256 of the latest read must match; a mismatch means the note changed since - read it again and re-apply the edit.",
        }
        if topic not in guides:
            return _fail(f"unknown topic {topic!r}: {'/'.join(guides)}")
        return _ok(topic=topic, guide=guides[topic], vault=vault.name)

    @mcp.tool
    async def obsidian_sync_status() -> dict:
        """The vault's sync, when Syncthing runs it; unavailable when it does not."""
        await authorize("obsidian_sync_status")
        if not shutil.which("syncthing"):
            return _fail("Syncthing is not installed; the vault's sync is unavailable.",
                         available=False)
        try:
            system = subprocess.run(["syncthing", "show", "system"], capture_output=True,
                                    text=True, timeout=SYNC_TIMEOUT).stdout
            connections = subprocess.run(["syncthing", "show", "connections"], capture_output=True,
                                         text=True, timeout=SYNC_TIMEOUT).stdout
        except (subprocess.SubprocessError, OSError):
            return _fail("Syncthing did not answer; the vault's sync is unavailable.",
                         available=False)
        return _ok(available=True, system=system[:4000], connections=connections[:4000])

    @mcp.tool
    async def obsidian_search(query: str, limit: int = 20, include_templates: bool = False) -> dict:
        """Searches the notes: every term must appear, the closest matches first."""
        await authorize("obsidian_search")
        vault = vault_path()
        terms = [term for term in re.split(r"\W", query.casefold()) if term]
        if not terms:
            return _fail("the query is empty")
        limit = max(1, min(100, limit))
        results = []
        total = 0
        for path, relative in _notes(vault, include_templates):
            text = path.read_text(encoding="utf-8-sig", errors="replace")
            folded = text.casefold()
            if not all(term in folded for term in terms):
                continue
            counts = [folded.count(term) for term in terms]
            score = sum(counts)
            total += 1
            first = folded.find(terms[0])
            snippet = text[max(0, first - 180):first + 420] if first >= 0 else text[:260]
            snippet = re.sub(r"\s+", " ", snippet)[:600]
            results.append({"path": relative.as_posix(), "title": path.stem, "score": score,
                            "modified_at": _modified(path), "snippet": snippet})
        results.sort(key=lambda result: (-result["score"], result["path"]))
        return _ok(query=query, count=min(limit, len(results)), total_matches=total,
                   results=results[:limit])

    @mcp.tool
    async def obsidian_list(relative: str = "", limit: int = 200) -> dict:
        """Lists a folder of the vault: directories first, then the files by name."""
        await authorize("obsidian_list")
        vault = vault_path()
    # The one gate, even for listing.
        target = _safe_path(vault, relative) if relative else vault
        if isinstance(target, dict):
            return target
        if not target.is_dir():
            return _fail(f"not a folder of the vault: {relative!r}")
        limit = max(1, min(500, limit))
        entries = []
        for child in sorted(target.iterdir(),
                            key=lambda p: (p.is_file(), p.name.casefold())):
            name = child.name
            if name.startswith(".") or name in PRIVATE or child.is_symlink():
                continue
            entry = {"name": name, "path": child.relative_to(vault).as_posix()}
            if child.is_dir():
                entry["type"] = "directory"
            else:
                entry.update(type="file", extension=child.suffix.lstrip("."),
                             size_bytes=child.stat().st_size, modified_at=_modified(child))
            entries.append(entry)
        return _ok(entries=entries[:limit])

    @mcp.tool
    async def obsidian_read(relative: str, max_chars: int = 60000) -> dict:
        """Reads one note whole, with its SHA-256 for the change that follows."""
        await authorize("obsidian_read")
        vault = vault_path()
        target = _safe_path(vault, relative)
        if isinstance(target, dict):
            return target
        if target.suffix != ".md" or not target.is_file():
            return _fail(f"not a note of the vault: {relative!r}")
        size = target.stat().st_size
        if size > MAX_NOTE_BYTES:
            return _fail(f"the note is over the size cap ({MAX_NOTE_BYTES} bytes)")
        max_chars = max(1000, min(100_000, max_chars))
        data = target.read_bytes()
        text = data.decode("utf-8-sig", errors="replace")
        return _ok(path=relative, content=text[:max_chars], sha256=_sha256(data),
                   size_bytes=size, modified_at=_modified(target),
                   truncated=len(text) > max_chars)

    @mcp.tool
    async def obsidian_create_note(title: str, folder: str, content: str,
                                   template_name: str = "") -> dict:
        """Creates a note; it never overwrites one that is already there."""
        await write("obsidian_create_note")
        vault = vault_path()
        title = title.strip()
        if not title or title in (".", "..") or title.startswith(".") or len(title) > 180 \
                or any(char in title for char in '/\\:*?"<>|'):
            return _fail(f"not a note title: {title!r}")
        home = _safe_path(vault, folder) if folder else vault
        if isinstance(home, dict):
            return home
        if not home.is_dir():
            return _fail(f"not a folder of the vault: {folder!r}")
        if template_name:
            if "/" in template_name or "\\" in template_name or template_name.startswith("."):
                return _fail(f"not a template name: {template_name!r}")
            template = vault / TEMPLATE_DIR / template_name
            if not template.is_file():
                return _fail(f"no such template: {template_name!r}")
            content = template.read_text(encoding="utf-8-sig").replace(
                "{{title}}", title).replace("{{date}}", datetime.now().strftime("%Y-%m-%d"))
        data = content.encode("utf-8")
        if len(data) > MAX_NOTE_BYTES:
            return _fail(f"the note is over the size cap ({MAX_NOTE_BYTES} bytes)")
        name = title if title.endswith(".md") else title + ".md"
        target = home / name
        try:
            handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return _fail("A note with that name already exists; read it before deciding what to do.")
        with os.fdopen(handle, "wb") as note:
            note.write(data)
            note.flush()
            os.fsync(note.fileno())
        return _ok(created=True, path=target.relative_to(vault).as_posix(),
                   sha256=_sha256(data), size_bytes=len(data))

    @mcp.tool
    async def obsidian_update_note(relative: str, content: str, expected_sha256: str) -> dict:
        """Rewrites a note, whole - with the SHA-256 of the latest read, so a note that
        changed since it was read is a conflict, not a loss."""
        await write("obsidian_update_note")
        vault = vault_path()
        target = _safe_path(vault, relative)
        if isinstance(target, dict):
            return target
        if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256 or ""):
            return _fail("expected_sha256 (from the latest read) is required.")
        if not target.is_file():
            return _fail(f"no such note: {relative!r}")
        current = _sha256(target.read_bytes())
        if current != expected_sha256:
            return _fail("Note changed since it was read. Read it again and re-apply the intended edit.",
                         conflict=True, path=relative, current_sha256=current)
        data = content.encode("utf-8")
        if len(data) > MAX_NOTE_BYTES:
            return _fail(f"the note is over the size cap ({MAX_NOTE_BYTES} bytes)")
        _write_atomic(target, data)
        return _ok(updated=True, path=relative, previous_sha256=expected_sha256,
                   sha256=_sha256(data))

    @mcp.tool
    async def obsidian_patch_note(relative: str, find_text: str, replace_text: str,
                                  expected_sha256: str) -> dict:
        """Patches a note: the text must appear exactly once, and be replaced once."""
        await write("obsidian_patch_note")
        vault = vault_path()
        target = _safe_path(vault, relative)
        if isinstance(target, dict):
            return target
        if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256 or ""):
            return _fail("expected_sha256 (from the latest read) is required.")
        if not find_text:
            return _fail("find_text is required")
        if not target.is_file():
            return _fail(f"no such note: {relative!r}")
        current = _sha256(target.read_bytes())
        if current != expected_sha256:
            return _fail("Note changed since it was read. Read it again and re-apply the intended edit.",
                         conflict=True, path=relative, current_sha256=current)
        text = target.read_text(encoding="utf-8-sig")
        found = text.count(find_text)
        if found != 1:
            return _fail(f"find_text must match exactly once; found {found} occurrences.")
        patched = text.replace(find_text, replace_text)
        data = patched.encode("utf-8")
        _write_atomic(target, data)
        return _ok(updated=True, path=relative, sha256=_sha256(data), replacements=1)

    @mcp.tool
    async def obsidian_move_note(source: str, destination: str, expected_sha256: str) -> dict:
        """Moves a note; the destination must not exist, refusing to overwrite."""
        await write("obsidian_move_note")
        vault = vault_path()
        origin = _safe_path(vault, source)
        if isinstance(origin, dict):
            return origin
        dest = _safe_path(vault, destination)
        if isinstance(dest, dict):
            return dest
        if origin.suffix != ".md" or dest.suffix != ".md":
            return _fail("both source and destination must be notes (.md)")
        if not origin.is_file():
            return _fail(f"no such note: {source!r}")
        if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256 or ""):
            return _fail("expected_sha256 (from the latest read) is required.")
        if _sha256(origin.read_bytes()) != expected_sha256:
            return _fail("Note changed since it was read. Read it again and re-apply the intended edit.",
                         conflict=True, path=source, current_sha256=_sha256(origin.read_bytes()))
        if dest.exists():
            return _fail("Destination already exists; refusing to overwrite.")
        if not dest.parent.is_dir():
            return _fail(f"the destination's folder is not there: {destination!r}")
        _write_atomic(dest, origin.read_bytes())
        origin.unlink()
        return _ok(moved=True, **{"from": source, "to": destination,
                                  "sha256": _sha256(dest.read_bytes())})

    @mcp.tool
    async def obsidian_recent(limit: int = 20) -> dict:
        """The notes by their last touch, newest first."""
        await authorize("obsidian_recent")
        vault = vault_path()
        limit = max(1, min(100, limit))
        notes = sorted(_notes(vault), key=lambda pair: pair[0].stat().st_mtime, reverse=True)
        results = [{"path": relative.as_posix(), "title": path.stem,
                    "modified_at": _modified(path), "size_bytes": path.stat().st_size}
                   for path, relative in notes[:limit]]
        return _ok(count=len(results), results=results)

    @mcp.tool
    async def obsidian_backlinks(relative: str) -> dict:
        """The links around one note: which notes point at it, and which it points at."""
        await authorize("obsidian_backlinks")
        vault = vault_path()
        target = _safe_path(vault, relative)
        if isinstance(target, dict):
            return target
        if not target.is_file():
            return _fail(f"no such note: {relative!r}")
        name = target.stem
        wikilink = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
        markdown = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
        # The asked note's own links are the outgoing ones - its wikilinks (the fragment
        # after # already dropped by the pattern) and its markdown targets, the private
        # ones dropped; the incoming are the notes that point at it, each scanned once.
        text = target.read_text(encoding="utf-8-sig", errors="replace")
        outgoing = [wanted.strip() for wanted in wikilink.findall(text)]
        outgoing += [link for link in markdown.findall(text)
                     if not link.startswith(("http:", "https:", "mailto:", "#"))]
        incoming = []
        for path, note in _notes(vault, include_templates=True):
            if note == Path(relative):
                continue
            for wanted in wikilink.findall(path.read_text(encoding="utf-8-sig", errors="replace")):
                if wanted.strip() == name:
                    incoming.append({"path": note.as_posix(), "title": path.stem})
                    break
        return _ok(path=relative, incoming=incoming, outgoing=outgoing)

    @mcp.tool
    async def obsidian_templates_list() -> dict:
        """The vault's templates, under its templates folder."""
        await authorize("obsidian_templates_list")
        vault = vault_path()
        folder = vault / TEMPLATE_DIR
        if not folder.is_dir():
            return _ok(path=TEMPLATE_DIR, templates=[])
        templates = sorted(path.name for path in folder.glob("*.md"))
        return _ok(path=TEMPLATE_DIR, templates=templates)

    @mcp.tool
    async def obsidian_template_read(name: str) -> dict:
        """Reads one template, whole."""
        await authorize("obsidian_template_read")
        vault = vault_path()
        if "/" in name or "\\" in name or name.startswith("."):
            return _fail(f"not a template name: {name!r}")
        template = vault / TEMPLATE_DIR / name
        if not template.is_file():
            return _fail(f"no such template: {name!r}")
        text = template.read_text(encoding="utf-8-sig")
        if len(text) > TEMPLATE_MAX:
            return _fail("the template is too large")
        return _ok(name=name, content=text)

    @mcp.tool
    async def obsidian_skills_list() -> dict:
        """The workflow skills beside the vault: one document each."""
        await authorize("obsidian_skills_list")
        folder = Path(SKILLS).expanduser()
        skills = []
        if folder.is_dir():
            for skill in sorted(folder.glob("*/SKILL.md")):
                description = ""
                for line in skill.read_text(encoding="utf-8-sig", errors="replace").splitlines():
                    if line.strip().startswith("description:"):
                        description = line.split(":", 1)[1].strip()
                        break
                skills.append({"skill_id": skill.parent.name, "name": skill.parent.name,
                               "description": description})
        return _ok(count=len(skills), skills=skills)

    @mcp.tool
    async def obsidian_skill_get(skill_id: str) -> dict:
        """Reads one workflow skill, whole."""
        await authorize("obsidian_skill_get")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,80}", skill_id or ""):
            return _fail(f"not a skill id: {skill_id!r}")
        skill = Path(SKILLS).expanduser() / skill_id / "SKILL.md"
        try:
            skill.resolve().relative_to(Path(SKILLS).expanduser().resolve())
        except ValueError:
            return _fail(f"the skill is not where the skills live: {skill_id!r}")
        if skill.is_symlink() or not skill.is_file():
            return _fail(f"no such skill: {skill_id!r}")
        text = skill.read_text(encoding="utf-8-sig")
        if len(text) > SKILL_MAX:
            return _fail("Skill document is too large.")
        return _ok(skill_id=skill_id, content=text)
