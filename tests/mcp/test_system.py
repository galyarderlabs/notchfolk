# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""Proves the System domain's acceptance criteria against the real server:
AC-2 (correct results), AC-3 (read-only tools on the default key) and AC-4
(a restricted tool is not visible to a key without its scope).

Run from the repo root:  python3 tests/mcp/test_system.py
Needs: fastmcp, dbus-next (pip install -r mcp/requirements.txt).
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "mcp"))

import threading
import urllib.request

from fastmcp import Client
from fastmcp.client.auth import BearerAuth
from fastmcp.client.transports import StreamableHttpTransport

READER_TOKEN = "t" + "r" * 39
ADMIN_TOKEN = "t" + "a" * 39


def clients_file():
    clients = {
        "reader": {"token": READER_TOKEN, "scopes": ["*:read"]},
        "admin": {"token": ADMIN_TOKEN, "scopes": ["*:read", "system:write"]},
    }
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
    os.environ["NOTCHFOLK_MCP_CLIENTS_FILE"] = clients_file()
    import server

    import contextlib
    port = free_port()
    def run_server():
        asyncio.run(server.mcp.run_async(transport="http", host="127.0.0.1", port=port))
    thread = threading.Thread(target=run_server, daemon=True)
    thread.start()
    for _ in range(100):
        with contextlib.suppress(Exception):
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            break
        await asyncio.sleep(0.1)

    def transport():
        return StreamableHttpTransport(f"http://127.0.0.1:{port}/mcp")

    failures = []

    def check(name, condition, detail=""):
        print(f"{'ok' if condition else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not condition else ""))
        if not condition:
            failures.append(name)

    # AC-4: the reader's tools/list hides the restricted tools; the admin's shows them.
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-4 reader does not see system_exec", "system_exec" not in listed)
        check("AC-4 reader does not see system_update", "system_update" not in listed)
        check("AC-1 reader sees system_stats", "system_stats" in listed)

        # AC-3 + AC-2: the read-only tools run on the default read-only key, correctly.
        stats = await reader.call_tool("system_stats", {})
        stats = stats.data if hasattr(stats, "data") else stats
        check("AC-2/3 system_stats", stats.get("ok") and "uptime" in stats and "memory" in stats, str(stats))
        fixture = os.path.join(os.path.expanduser("~"), "notchfolk-mcp-test")
        async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as maker:
            await maker.call_tool("system_write_file", {"path": f"{fixture}/probe.txt", "content": "notchfolk probe"})
        files = await reader.call_tool("system_list_files", {"path": fixture})
        files = files.data if hasattr(files, "data") else files
        names = {entry["name"] for entry in files["entries"]}
        check("AC-2/3 system_list_files", files.get("ok") and "probe.txt" in names, str(names))
        read = await reader.call_tool("system_read_file", {"path": f"{fixture}/probe.txt"})
        read = read.data if hasattr(read, "data") else read
        check("AC-2/3 system_read_file", read.get("ok") and read["content"] == "notchfolk probe", str(read))
        processes = await reader.call_tool("system_list_processes", {})
        processes = processes.data if hasattr(processes, "data") else processes
        check("AC-2/3 system_list_processes", processes.get("ok") and "by_cpu" in processes)
        toolchains = await reader.call_tool("system_toolchain_status", {})
        toolchains = toolchains.data if hasattr(toolchains, "data") else toolchains
        check("AC-2/3 system_toolchain_status", "distro_package_manager" in toolchains["checks"], str(toolchains))
        # The guards: a blocked command is refused, and a write outside the roots is refused.
        try:
            await reader.call_tool("system_read_file", {"path": "/etc/shadow"})
            check("guard: read outside the roots refused", False, "the read was allowed")
        except Exception:
            check("guard: read outside the roots refused", True)

        # A restricted tool is rejected at call time too, not only hidden.
        try:
            await reader.call_tool("system_exec", {"command": "true"})
            check("AC-4 reader cannot call system_exec", False, "the call was allowed")
        except Exception:
            check("AC-4 reader cannot call system_exec", True)

    async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as admin:
        listed = {tool.name for tool in await admin.list_tools()}
        check("AC-4 admin sees system_exec", "system_exec" in listed)
        result = await admin.call_tool("system_exec", {"command": "echo notchfolk"})
        result = result.data if hasattr(result, "data") else result
        check("AC-2 system_exec on a scoped key", result["ok"] and "notchfolk" in result["stdout"], str(result))
        # The critical guard: system_exec refuses the blocked fragments.
        try:
            await admin.call_tool("system_exec", {"command": "rm -rf /"})
            check("guard: system_exec refuses rm -rf /", False, "the command was allowed")
        except Exception:
            check("guard: system_exec refuses rm -rf /", True)
        # The spec's by-name search, beside the reference's content search.
        named = await admin.call_tool("system_search_files",
                                      {"pattern": "probe", "by": "name", "path": "~/notchfolk-mcp-test"})
        named = named.data if hasattr(named, "data") else named
        check("AC-2 system_search_files by name",
              named.get("ok") and any("probe.txt" in m for m in named["matches"]), str(named))

        # The reference's confirmation rule: update refuses without confirm.
        refused = await admin.call_tool("system_update", {"domain": "flatpak", "action": "update"})
        refused = refused.data if hasattr(refused, "data") else refused
        check("AC-2 system_update refuses without confirm",
              not refused.get("ok") and "confirm=true required" in refused.get("error", ""), str(refused))
        # An absent toolchain is reported unavailable, not an error (the spec's rule).
        unavailable = await admin.call_tool("system_update", {"domain": "flatpak", "action": "check"})
        unavailable = unavailable.data if hasattr(unavailable, "data") else unavailable
        check("AC-2 system_update check reports unavailable",
              unavailable.get("ok") and unavailable.get("unavailable") == "flatpak", str(unavailable))

    shutil.rmtree(os.path.join(os.path.expanduser("~"), "notchfolk-mcp-test"), ignore_errors=True)
    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
