# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""Proves the Office domain against a mock OfficeCLI: a real FastMCP stdio server
standing in for the binary, its `officecli` tool answering what it was told. The
proxy must stay warm (one subprocess), the availability rule must hold, and the
one tool must sit behind office:write - invisible to a key without it.

Run from the repo root:  python3 tests/mcp/test_office.py
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

from fastmcp import Client, FastMCP
from fastmcp.client.auth import BearerAuth
from fastmcp.client.transports import StreamableHttpTransport

READER_TOKEN = "t" + "r" * 39
ADMIN_TOKEN = "t" + "a" * 39

CALLS = []
LOG = Path(tempfile.mkdtemp()) / "calls.json"


def mock_binary() -> Path:
    """A stand-in for OfficeCLI: a FastMCP stdio server with the one `officecli` tool,
    its calls logged to a file - a subprocess shares no list with its parent."""
    script = Path(tempfile.mkdtemp()) / "officecli"
    script.write_text(f"""#!/usr/bin/env python3
import json
import sys
sys.path.insert(0, {str(REPO / 'mcp')!r})
from fastmcp import FastMCP

LOG = {str(LOG)!r}

mcp = FastMCP(name="officecli")

@mcp.tool
def officecli(instructions: str = "") -> dict:
    with open(LOG, "a") as log:
        log.write(json.dumps(instructions) + chr(10))
    if "file_exists" in instructions:
        raise RuntimeError("file_exists: the document is already there")
    return {{"made": True, "instructions": instructions}}

mcp.run(transport="stdio")
""")
    script.chmod(0o755)
    return script


def calls() -> list:
    if not LOG.is_file():
        return []
    return [json.loads(line) for line in LOG.read_text().splitlines() if line]


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
    os.environ["NOTCHFOLK_MCP_OFFICE"] = str(Path(tempfile.mkdtemp()) / "nowhere")

    import importlib
    import tools.office as office
    importlib.reload(office)
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

    # The availability rule: no binary, no domain.
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-5 no binary: the domain is not offered", "office_create_document" not in listed)

    # The mock binary now.
    CALLS.clear()
    os.environ["NOTCHFOLK_MCP_OFFICE"] = str(mock_binary())
    importlib.reload(office)
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
        check("AC-4 the reader does not see the tool", "office_create_document" not in listed)

    async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as admin:
        listed = {tool.name for tool in await admin.list_tools()}
        check("AC-1 the one tool is offered", "office_create_document" in listed)
        made = await admin.call_tool("office_create_document", {"instructions": "a quarterly report"})
        made = made.data if hasattr(made, "data") else made
        check("AC-2/3 the call carries through",
              made["ok"] and made["result"]["made"] is True, str(made)[:150])
        check("the reference's instructions ride along",
              any("Always end with save" in call for call in calls()), str(calls())[:150])
        await admin.call_tool("office_create_document", {"instructions": "a second one"})
        check("the proxy stays warm (one subprocess, two calls)", len(calls()) == 2, str(len(calls())))
        failed = await admin.call_tool("office_create_document",
                                       {"instructions": "make it: file_exists"})
        failed = failed.data if hasattr(failed, "data") else failed
        check("a failed operation reports failure, not silent success",
              failed["ok"] is False and "file_exists" in failed["error"], str(failed)[:150])

    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
