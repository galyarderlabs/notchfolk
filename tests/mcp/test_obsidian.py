# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""Proves the Memory domain's Obsidian backend against a real vault: a temporary folder
of Markdown notes, its templates and its skills, with the private internals in place.
The gate must hold (no absolute paths, no `..`, no hidden parts, no symlinks out), create
must never overwrite, updates and moves must conflict on a stale SHA-256, and there is
no delete tool. The availability rule: no vault, no domain.

Run from the repo root:  python3 tests/mcp/test_obsidian.py
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


def build_vault(root: Path):
    """A real vault: notes in folders, a template, private internals, a symlink out."""
    (root / "Journal").mkdir()
    (root / "Journal" / "today.md").write_text("# Today\n\nBought coffee for the shelf.\n")
    (root / "Journal" / "yesterday.md").write_text(
        "Walked by the river, thought of rust. [[plans]] for tomorrow.\n")
    (root / "Projects").mkdir()
    (root / "Projects" / "notchfolk.md").write_text(
        "# Notchfolk\n\nThe notch [[today]] links here. See also [[notchfolk]] and "
        "[[yesterday]]'s page.\n")
    (root / "loose.md").write_text("A loose note, for search and recent.\n")
    (root / "_System" / "Templates").mkdir(parents=True)
    (root / "_System" / "Templates" / "daily.md").write_text(
        "# {{title}}\n\n{{date}}\n\n- \n")
    (root / ".obsidian").mkdir()
    (root / ".obsidian" / "workspace.json").write_text("{}")
    (root / ".git").mkdir()
    (root / "outside.txt").write_text("outside the vault")
    os.symlink(REPO / "README.md", root / "README.md")
    return root


def clients_file():
    clients = {"reader": {"token": READER_TOKEN, "scopes": ["*:read"]},
               "admin": {"token": ADMIN_TOKEN, "scopes": ["*:read", "notes:write"]}}
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
    os.environ["NOTCHFOLK_MCP_VAULT"] = str(Path(tempfile.mkdtemp()) / "no-such-vault")

    import importlib
    import tools.obsidian as obsidian
    importlib.reload(obsidian)
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

    # The availability rule: no vault, the domain is not offered.
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-5 no vault: the domain is not offered", "obsidian_overview" not in listed)

    # Now a real vault.
    vault = build_vault(Path(tempfile.mkdtemp()))
    os.environ["NOTCHFOLK_MCP_VAULT"] = str(vault)
    skills = Path(tempfile.mkdtemp()) / "skills"
    os.environ["NOTCHFOLK_MCP_SKILLS"] = str(skills)
    (skills / "journaling").mkdir(parents=True, exist_ok=True)
    (skills / "journaling" / "SKILL.md").write_text(
        "---\ndescription: how the journal is kept\n---\n\nWrite every day.\n")
    importlib.reload(obsidian)
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

    def result(call):
        return call.data if hasattr(call, "data") else call

    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-1 the 12 read-only are offered",
              len([n for n in listed if n.startswith("obsidian_")]) == 12,
              str(sorted(n for n in listed if n.startswith("obsidian_"))))
        check("AC-4 reader sees no write tool", "obsidian_create_note" not in listed)

        overview = result(await reader.call_tool("obsidian_overview", {}))
        check("AC-2/3 overview", overview["ok"] and overview["markdown_notes"] == 5, str(overview))
        read = result(await reader.call_tool("obsidian_read", {"relative": "Journal/today.md"}))
        check("AC-2/3 read carries the sha", read["ok"] and len(read["sha256"]) == 64, str(read)[:120])
        search = result(await reader.call_tool("obsidian_search", {"query": "coffee shelf"}))
        check("AC-2/3 search finds the note", search["ok"] and search["total_matches"] == 1
              and search["results"][0]["path"] == "Journal/today.md", str(search)[:150])
        recent = result(await reader.call_tool("obsidian_recent", {}))
        check("the templates stay out of the notes",
              all("_System" not in entry["path"] for entry in recent["results"]),
              str([e["path"] for e in recent["results"]]))
        listing = result(await reader.call_tool("obsidian_list", {"relative": "Journal"}))
        check("AC-2/3 list", listing["ok"] and [e["name"] for e in listing["entries"]] == ["today.md", "yesterday.md"],
              str(listing))
        backlinks = result(await reader.call_tool("obsidian_backlinks", {"relative": "Journal/today.md"}))
        check("AC-2/3 backlinks", backlinks["ok"] and len(backlinks["incoming"]) == 1
              and backlinks["incoming"][0]["path"] == "Projects/notchfolk.md", str(backlinks)[:150])
        notchlinks = result(await reader.call_tool("obsidian_backlinks", {"relative": "Projects/notchfolk.md"}))
        check("backlinks' outgoing are the note's own",
              sorted(notchlinks["outgoing"]) == ["notchfolk", "today", "yesterday"],
              str(notchlinks["outgoing"]))
        templates = result(await reader.call_tool("obsidian_templates_list", {}))
        check("AC-2/3 templates_list", templates["ok"] and templates["templates"] == ["daily.md"])
        skills = result(await reader.call_tool("obsidian_skills_list", {}))
        check("AC-2/3 skills_list", skills["ok"] and skills["skills"][0]["name"] == "journaling")

        # The gate: every escape refused.
        for bad in ["../outside.txt", "/etc/passwd", ".obsidian/workspace.json", "README.md",
                    "Journal\\today.md"]:
            answer = result(await reader.call_tool("obsidian_read", {"relative": bad}))
            check(f"gate refuses {bad!r}", not answer["ok"], str(answer)[:100])

    async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as admin:
        listed = {tool.name for tool in await admin.list_tools()}
        check("AC-4 admin sees the write tools", "obsidian_create_note" in listed
              and len([n for n in listed if n.startswith("obsidian_")]) == 16)

        created = result(await admin.call_tool("obsidian_create_note",
            {"title": "plans", "folder": "Projects", "content": "New note body."}))
        check("AC-2/3 create", created["ok"] and created["path"] == "Projects/plans.md", str(created))
        traversal = result(await admin.call_tool("obsidian_create_note",
            {"title": "escape", "folder": "Projects", "content": "x",
             "template_name": "../../etc/passwd"}))
        check("create's template name is gated", not traversal["ok"], str(traversal))
        huge = result(await admin.call_tool("obsidian_create_note",
            {"title": "huge", "folder": "Projects", "content": "x" * 600_000}))
        check("create obeys the size cap", not huge["ok"], str(huge)[:100])
        again = result(await admin.call_tool("obsidian_create_note",
            {"title": "plans", "folder": "Projects", "content": "Again."}))
        check("create never overwrites", not again["ok"] and "already exists" in again["error"], str(again))
        templated = result(await admin.call_tool("obsidian_create_note",
            {"title": "templated", "folder": "", "content": "", "template_name": "daily.md"}))
        check("create from a template", templated["ok"] and "# templated" in
              (vault / "templated.md").read_text(), str(templated))

        stale = result(await admin.call_tool("obsidian_update_note",
            {"relative": "Journal/today.md", "content": "x", "expected_sha256": "0" * 64}))
        check("update with a stale sha conflicts", not stale["ok"] and stale.get("conflict"), str(stale))
        read = result(await admin.call_tool("obsidian_read", {"relative": "Journal/today.md"}))
        updated = result(await admin.call_tool("obsidian_update_note",
            {"relative": "Journal/today.md", "content": "Rewritten whole.",
             "expected_sha256": read["sha256"]}))
        check("AC-2/3 update with the current sha", updated["ok"], str(updated))
        patched = result(await admin.call_tool("obsidian_patch_note",
            {"relative": "Journal/today.md", "find_text": "whole", "replace_text": "entirely",
             "expected_sha256": updated["sha256"]}))
        check("AC-2/3 patch once", patched["ok"] and patched["replacements"] == 1, str(patched))
        twice = result(await admin.call_tool("obsidian_patch_note",
            {"relative": "Projects/notchfolk.md", "find_text": "notchfolk", "replace_text": "x",
             "expected_sha256": "0" * 64}))
        check("patch needs the sha", not twice["ok"])
        moved = result(await admin.call_tool("obsidian_move_note",
            {"source": "Journal/yesterday.md", "destination": "Projects/yesterday.md",
             "expected_sha256": result(await admin.call_tool(
                 "obsidian_read", {"relative": "Journal/yesterday.md"}))["sha256"]}))
        check("AC-2/3 move", moved["ok"] and (vault / "Projects/yesterday.md").is_file()
              and not (vault / "Journal/yesterday.md").exists(), str(moved))
        overwrite = result(await admin.call_tool("obsidian_move_note",
            {"source": "Projects/plans.md", "destination": "Projects/notchfolk.md",
             "expected_sha256": "0" * 64}))
        check("move refuses to overwrite", not overwrite["ok"])

    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
