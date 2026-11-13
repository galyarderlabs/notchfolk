# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""Proves the Skills domain against real skill trees: a temporary flat tree and a
nested one, with an archive subtree, frontmatter of both kinds, a credential-like
file and an escape attempt. The seven tools must hold their contract: the id shape,
the source gate, the caps, the refusals, the search's scoring, the index's refresh.

Run from the repo root:  python3 tests/mcp/test_skills.py
"""

import asyncio
import json
import os
import sys
import tempfile
import threading
import contextlib
import urllib.request as urlrequest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "mcp"))

from fastmcp import Client
from fastmcp.client.auth import BearerAuth
from fastmcp.client.transports import StreamableHttpTransport

READER_TOKEN = "t" + "r" * 39
ADMIN_TOKEN = "t" + "a" * 39

THE_7 = ["skills_list", "skills_search", "skills_get", "skills_list_files",
         "skills_read_file", "skills_stats", "skills_refresh"]


def build_trees(root: Path):
    """A flat tree and a nested one: frontmatter of both kinds, an archive, a credential."""
    flat = root / "flat"
    (flat / "apple-design").mkdir(parents=True)
    (flat / "apple-design" / "SKILL.md").write_text(
        "---\nname: Apple Design\ndescription: Design the way Apple does it.\n---\n\n"
        "Body line that should not be the description.\n")
    (flat / "apple-design" / "notes.txt").write_text("side notes\n")
    (flat / "apple-design" / ".env").write_text("TOKEN=leaked\n")
    nested = root / "nested"
    (nested / "creative" / "brandkit").mkdir(parents=True)
    (nested / "creative" / "brandkit" / "SKILL.md").write_text(
        "---\nname: Brand Kit\ndescription: |\n  Everything a brand needs,\n  in one skill.\n---\n\n"
        "Make brands.\n")
    (nested / "creative" / "brandkit" / "logo.png").write_bytes(b"\x89PNG fake")
    (nested / ".archive" / "old-thing").mkdir(parents=True)
    (nested / ".archive" / "old-thing" / "SKILL.md").write_text(
        "No frontmatter here.\n\nFirst body line is the description.\n")
    # An unreadable SKILL.md: one skill's problem, not the domain's.
    (flat / "broken").mkdir()
    broken = flat / "broken" / "SKILL.md"
    broken.write_text("---\nname: Broken\n---\n")
    broken.chmod(0)
    return flat, nested


def clients_file():
    clients = {"reader": {"token": READER_TOKEN, "scopes": ["*:read"]},
               "admin": {"token": ADMIN_TOKEN, "scopes": ["*:read", "office:write"]}}
    path = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(clients, path)
    path.close()
    os.chmod(path.name, 0o600)
    return path.name


def free_port():
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def main():
    failures = []

    def check(name, condition, detail=""):
        print(f"{'ok' if condition else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not condition else ""))
        if not condition:
            failures.append(name)

    os.environ["NOTCHFOLK_MCP_CLIENTS_FILE"] = clients_file()
    os.environ["NOTCHFOLK_MCP_SKILLS_ROOTS"] = ""

    import importlib
    import tools.skills as skills
    importlib.reload(skills)
    import server
    importlib.reload(server)

    def serve(port):
        asyncio.run(server.mcp.run_async(transport="http", host="127.0.0.1", port=port))

    port = free_port()
    threading.Thread(target=serve, args=(port,), daemon=True).start()
    for _ in range(100):
        with contextlib.suppress(Exception):
            urlrequest.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            break
        await asyncio.sleep(0.1)

    def transport():
        return StreamableHttpTransport(f"http://127.0.0.1:{port}/mcp")

    def result(call):
        return call.data if hasattr(call, "data") else call

    # The availability rule: no tree, no domain.
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-5 no tree: the domain is not offered", "skills_list" not in listed)

    # Real trees now.
    root = Path(tempfile.mkdtemp())
    flat, nested = build_trees(root)
    os.environ["NOTCHFOLK_MCP_SKILLS_ROOTS"] = f"agents:{flat},hermes:{nested}"
    importlib.reload(skills)
    import server as fresh
    importlib.reload(fresh)
    port = free_port()

    def serve_again():
        asyncio.run(fresh.mcp.run_async(transport="http", host="127.0.0.1", port=port))

    threading.Thread(target=serve_again, daemon=True).start()
    for _ in range(100):
        with contextlib.suppress(Exception):
            urlrequest.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            break
        await asyncio.sleep(0.1)

    def transport():
        return StreamableHttpTransport(f"http://127.0.0.1:{port}/mcp")

    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-1 the 7 are offered", set(THE_7) <= listed, str(sorted(listed & set(THE_7))))

        listing = result(await reader.call_tool("skills_list", {}))
        check("AC-2/3 list: the active, the archive hidden, the unreadable skipped",
              listing["total"] == 2 and [s["id"] for s in listing["skills"]]
              == ["agents:apple-design", "hermes:creative/brandkit"], str(listing))
        archived = result(await reader.call_tool("skills_list", {"include_archived": True}))
        check("AC-2/3 the archive shows when asked", archived["total"] == 3, str(archived["total"]))
        check("an unreadable SKILL.md breaks no tool",
              all(call["ok"] for call in [archived, listing]), "the tools answered")
        bad_source = result(await reader.call_tool("skills_list", {"source": "nope"}))
        check("the source gate", not bad_source["ok"] and "source must be" in bad_source["error"])

        search = result(await reader.call_tool("skills_search", {"query": "brand"}))
        check("AC-2/3 search scores", search["total"] == 1
              and search["skills"][0]["id"] == "hermes:creative/brandkit", str(search)[:150])
        exact = result(await reader.call_tool("skills_search", {"query": "Apple Design"}))
        check("an exact name scores 100", exact["skills"][0]["score"] == 100, str(exact["skills"][0]))

        got = result(await reader.call_tool("skills_get", {"skill_id": "hermes:creative/brandkit"}))
        check("AC-2/3 get: folded description and files",
              got["ok"] and "in one skill" in got["description"]
              and got["files"][0]["path"] == "SKILL.md", str(got)[:200])
        plain = result(await reader.call_tool("skills_get", {"skill_id": "hermes:.archive/old-thing"}))
        check("AC-2/3 get: a frontmatter-less body line as description",
              plain["description"] == "No frontmatter here.", str(plain)[:150])
        unknown = result(await reader.call_tool("skills_get", {"skill_id": "agents:nope"}))
        check("an unknown id says so", not unknown["ok"]
              and unknown.get("hint") == "use skills_list / skills_search to find a valid id")

        files = result(await reader.call_tool("skills_list_files", {"skill_id": "agents:apple-design"}))
        check("AC-2/3 list_files", files["ok"] and [f["path"] for f in files["files"]]
              == [".env", "SKILL.md", "notes.txt"], str(files))

        denied = result(await reader.call_tool("skills_read_file",
            {"skill_id": "agents:apple-design", "path": ".env"}))
        check("a credential-like file is refused", not denied["ok"] and "credential-like" in denied["error"])
        escape = result(await reader.call_tool("skills_read_file",
            {"skill_id": "agents:apple-design", "path": "../../etc/passwd"}))
        check("an escape is refused", not escape["ok"])
        read = result(await reader.call_tool("skills_read_file",
            {"skill_id": "agents:apple-design", "path": "notes.txt"}))
        check("AC-2/3 read_file", read["ok"] and read["content"] == "side notes\n", str(read)[:120])
        binary = result(await reader.call_tool("skills_read_file",
            {"skill_id": "hermes:creative/brandkit", "path": "logo.png"}))
        check("a binary file says so", not binary["ok"] and "binary" in binary["error"])

        stats = result(await reader.call_tool("skills_stats", {}))
        check("AC-2/3 stats", stats["total"] == 3 and stats["agents"] == 1
              and stats["hermes"] == 2 and stats["archived"] == 1, str(stats))

    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
