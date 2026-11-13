# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""Proves the Composio domain against a mock CLI: a stand-in composio that answers
search with a slug and execute with a result, logging its calls. The domain must
resolve slugs at runtime (never hardcoded), cache them, isolate a dead CLI, and
split its scopes - the four read-only on the default key, the four that change
something invisible without composio:write.

Run from the repo root:  python3 tests/mcp/test_composio.py
"""

import asyncio
import json
import os
import stat
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

THE_8 = ["composio_search_mail", "composio_read_mail", "composio_search_drive",
         "composio_read_drive_file", "composio_send_mail", "composio_delete_mail",
         "composio_share_drive_file", "composio_write_drive_file"]
READ_ONLY = {"composio_search_mail", "composio_read_mail",
             "composio_search_drive", "composio_read_drive_file"}


def mock_cli() -> Path:
    """A stand-in composio: search answers a slug, execute answers a result."""
    script = Path(tempfile.mkdtemp()) / "composio"
    script.write_text("""#!/usr/bin/env python3
import json
import sys

args = sys.argv[1:]
if args[:1] == ["search"]:
    use_case = args[1].replace(" ", "_").upper()
    print(json.dumps([{"slug": f"TOOL_{use_case}"}]))
elif args[:1] == ["execute"]:
    slug = args[1]
    print(json.dumps({"executed": slug, "data": json.loads(args[args.index("-d") + 1])}))
else:
    print(json.dumps([]))
""")
    script.chmod(0o755)
    return script


def clients_file():
    clients = {"reader": {"token": READER_TOKEN, "scopes": ["*:read"]},
               "admin": {"token": ADMIN_TOKEN, "scopes": ["*:read", "composio:write"]}}
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
    os.environ["NOTCHFOLK_MCP_COMPOSIO"] = str(Path(tempfile.mkdtemp()) / "nowhere")

    import importlib
    import tools.composio as composio
    importlib.reload(composio)
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

    # The availability rule: no CLI, no domain.
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-5 no CLI: the domain is not offered", "composio_search_mail" not in listed)

    # The mock CLI now.
    os.environ["NOTCHFOLK_MCP_COMPOSIO"] = str(mock_cli())
    composio.SLUG_CACHE.clear()
    importlib.reload(composio)
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
        offered = listed & set(THE_8)
        check("AC-1 the 4 read-only are offered", offered == READ_ONLY, str(sorted(offered)))
        check("AC-4 reader sees only the 4 read-only", offered == READ_ONLY,
              f"extra: {sorted(offered - READ_ONLY)[:3]}")
        search = result(await reader.call_tool("composio_search_mail",
                                              {"query": "quarterly report"}))
        check("AC-2/3 search_mail carries through",
              search["ok"] and search["result"]["data"]["query"] == "quarterly report",
              str(search)[:150])
        check("the slug is cached", "search mail" in composio.SLUG_CACHE, str(composio.SLUG_CACHE))
        drive = result(await reader.call_tool("composio_search_drive",
                                              {"query": "presentation"}))
        check("AC-2/3 search_drive carries through",
              drive["ok"] and drive["result"]["data"]["query"] == "presentation",
              str(drive)[:150])

    async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as admin:
        listed = {tool.name for tool in await admin.list_tools()}
        check("AC-4 admin sees all 8", set(THE_8) <= listed, str(len(set(THE_8) & listed)))
        sent = result(await admin.call_tool("composio_send_mail",
            {"recipient": "a@b.com", "subject": "Hello", "body": "World"}))
        check("AC-2/3 send_mail carries through",
              sent["ok"] and sent["result"]["data"]["recipient_email"] == "a@b.com",
              str(sent)[:150])
        shared = result(await admin.call_tool("composio_share_drive_file",
            {"file_id": "f1", "recipient": "c@d.com"}))
        check("AC-2/3 share_drive_file carries through",
              shared["ok"] and shared["result"]["data"]["file_id"] == "f1", str(shared)[:150])

    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
