# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""Proves the Browser domain against the recorded REST contract: a mock
Camoufox server implements the Phase 0 routes, and the tools must talk them
exactly — routes, bodies, the access key, and the response shaping.

Also proves the availability rule: with no server answering, the domain is
not offered at all.

Run from the repo root:  python3 tests/mcp/test_browser.py
"""

import asyncio
import base64
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "mcp"))

from fastmcp import Client
from fastmcp.client.auth import BearerAuth
from fastmcp.client.transports import StreamableHttpTransport

READER_TOKEN = "t" + "r" * 39
ADMIN_TOKEN = "t" + "a" * 39

CALLS = []


class MockCamoufox(BaseHTTPRequestHandler):
    """The Phase 0 contract, exactly as recorded: routes, bodies, auth."""

    def _answer(self, code, body, content_type="application/json"):
        payload = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _record(self, body=None):
        CALLS.append({"method": self.command, "path": self.path,
                      "auth": self.headers.get("Authorization"), "body": body})

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        self._record()
        if self.path == "/health":
            self._answer(200, {"status": "ok"})
        elif self.path.startswith("/tabs") and "snapshot" in self.path:
            self._answer(200, {"url": "https://example.com", "text": "Example Domain",
                               "elements": [{"ref": "e1", "tag": "a", "text": "More information"}],
                               "hasMore": False})
        elif self.path.startswith("/tabs") and "screenshot" in self.path:
            self._answer(200, base64.b64decode("iVBORw0KGgo="), content_type="image/png")
        elif self.path.startswith("/tabs"):
            self._answer(200, {"tabs": [{"tabId": "tab-1", "title": "Example", "url": "https://example.com"}]})
        else:
            self._answer(404, {"error": "no such route"})

    def do_POST(self):
        body = self._read_body()
        self._record(body)
        self._answer(200, {"done": True, "path": self.path, **body})

    def do_DELETE(self):
        self._record()
        self._answer(200, {"closed": self.path.split("/")[2]})

    def log_message(self, *args):
        pass


def clients_file():
    clients = {"reader": {"token": READER_TOKEN, "scopes": ["*:read"]},
               "admin": {"token": ADMIN_TOKEN, "scopes": ["*:read", "browser:write"]}}
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

    # The availability rule first: with no server at a dead port, the domain is
    # not offered at all.
    os.environ["NOTCHFOLK_MCP_CLIENTS_FILE"] = clients_file()
    dead = free_port()
    os.environ["NOTCHFOLK_MCP_CAMOFOX_URL"] = f"http://127.0.0.1:{dead}"
    import importlib
    import tools.browser as browser_module
    importlib.reload(browser_module)
    import server as server_module
    importlib.reload(server_module)
    # Start the real server against the dead Camoufox and list its tools.
    port = free_port()

    import contextlib
    import urllib.request as urlrequest

    def run_server():
        asyncio.run(server_module.mcp.run_async(transport="http", host="127.0.0.1", port=port))

    threading.Thread(target=run_server, daemon=True).start()
    for _ in range(100):
        with contextlib.suppress(Exception):
            urlrequest.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            break
        await asyncio.sleep(0.1)

    def transport():
        return StreamableHttpTransport(f"http://127.0.0.1:{port}/mcp")

    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-5 no Camoufox: the domain is not offered", "browser_navigate" not in listed,
              str(sorted(n for n in listed if n.startswith("browser"))))

    # Now the mock Camoufox, on its own port, and the server restarted against it.
    camofox_port = free_port()
    camofox = ThreadingHTTPServer(("127.0.0.1", camofox_port), MockCamoufox)
    threading.Thread(target=camofox.serve_forever, daemon=True).start()
    os.environ["NOTCHFOLK_MCP_CAMOFOX_URL"] = f"http://127.0.0.1:{camofox_port}"
    os.environ["NOTCHFOLK_MCP_CAMOFOX_KEY"] = "camofox-test-key"
    importlib.reload(browser_module)
    server_module.mcp = None
    import server
    importlib.reload(server)
    port = free_port()

    def run_server_again():
        asyncio.run(server.mcp.run_async(transport="http", host="127.0.0.1", port=port))

    threading.Thread(target=run_server_again, daemon=True).start()
    for _ in range(100):
        with contextlib.suppress(Exception):
            urlrequest.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            break
        await asyncio.sleep(0.1)

    def transport():
        return StreamableHttpTransport(f"http://127.0.0.1:{port}/mcp")

    CALLS.clear()
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-1 reader sees browser_navigate", "browser_navigate" in listed)
        check("AC-4 reader does not see browser_click", "browser_click" not in listed)
        check("AC-4 reader does not see browser_create_tab", "browser_create_tab" not in listed)

        snapshot = await reader.call_tool("browser_snapshot", {"tab_id": "tab-1"})
        snapshot = snapshot.data if hasattr(snapshot, "data") else snapshot
        check("AC-2/3 browser_snapshot", snapshot["result"]["elements"][0]["ref"] == "e1", str(snapshot))
        tabs = await reader.call_tool("browser_list_tabs", {})
        tabs = tabs.data if hasattr(tabs, "data") else tabs
        check("AC-2/3 browser_list_tabs", tabs["result"]["tabs"][0]["tabId"] == "tab-1", str(tabs))
        navigate = await reader.call_tool("browser_navigate", {"tab_id": "tab-1", "url": "https://example.com"})
        check("AC-2/3 browser_navigate", navigate.data["result"]["url"] == "https://example.com")
        screenshot = await reader.call_tool("browser_screenshot", {"tab_id": "tab-1"})
        check("AC-2/3 browser_screenshot returns an image",
              any(block.type == "image" for block in screenshot.content), str(screenshot.content))
        scroll = await reader.call_tool("browser_scroll", {"tab_id": "tab-1", "direction": "up", "amount": 200})
        check("AC-2/3 browser_scroll", scroll.data["result"]["amount"] == 200)

    async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as admin:
        listed = {tool.name for tool in await admin.list_tools()}
        check("AC-4 admin sees browser_click", "browser_click" in listed)
        await admin.call_tool("browser_create_tab", {"url": "https://example.com"})
        await admin.call_tool("browser_click", {"tab_id": "tab-1", "ref": "e1"})
        await admin.call_tool("browser_type", {"tab_id": "tab-1", "text": "notchfolk", "ref": "e1"})
        await admin.call_tool("browser_evaluate", {"tab_id": "tab-1", "expression": "1 + 1"})
        await admin.call_tool("browser_close_tab", {"tab_id": "tab-1"})

    # The contract itself: every call went to the right route with the right
    # body and the access key the user set.
    by_route = {call["path"].split("?")[0] + " " + call["method"]: call for call in CALLS}
    check("contract: navigate route", "/tabs/tab-1/navigate POST" in by_route)
    check("contract: navigate body", by_route.get("/tabs/tab-1/navigate POST", {}).get("body", {}).get("url") == "https://example.com")
    check("contract: snapshot route", any("snapshot" in path for path in by_route if " GET" in path))
    check("contract: screenshot route", any("screenshot" in path for path in by_route if " GET" in path))
    check("contract: tabs list route", "/tabs GET" in by_route)
    check("contract: create tab route and body",
          by_route.get("/tabs POST", {}).get("body", {}).get("sessionKey") == "default")
    check("contract: click body", by_route.get("/tabs/tab-1/click POST", {}).get("body", {}).get("ref") == "e1")
    check("contract: type body", by_route.get("/tabs/tab-1/type POST", {}).get("body", {}).get("text") == "notchfolk")
    check("contract: evaluate body",
          by_route.get("/tabs/tab-1/evaluate POST", {}).get("body", {}).get("expression") == "1 + 1")
    check("contract: close route", "/tabs/tab-1 DELETE" in by_route)
    check("contract: the access key rides along",
          all(call["auth"] == "Bearer camofox-test-key" for call in CALLS), str({c["auth"] for c in CALLS}))

    camofox.shutdown()
    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
