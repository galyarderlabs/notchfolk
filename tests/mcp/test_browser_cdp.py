# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""Proves the Browser domain's CDP backend against the public DevTools
protocol: a mock Chromium answers /json/version, /json/list, PUT /json/new
and /json/close over HTTP, and Page.navigate, Runtime.evaluate and
Page.captureScreenshot over the debugging websocket. The tools must talk
the protocol exactly, and the availability rule must hold: no browser
answering, no domain offered.

Run from the repo root:  python3 tests/mcp/test_browser_cdp.py
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

import websockets
from fastmcp import Client
from fastmcp.client.auth import BearerAuth
from fastmcp.client.transports import StreamableHttpTransport

READER_TOKEN = "t" + "r" * 39
ADMIN_TOKEN = "t" + "a" * 39

EVALUATED = []
TABS = [{"id": "tab-1", "type": "page", "title": "Example", "url": "https://example.com",
         "webSocketDebuggerUrl": "WS-URL"}]


class MockChromium(BaseHTTPRequestHandler):
    """The CDP HTTP endpoints, as the protocol defines them."""

    def _answer(self, code, body):
        payload = json.dumps(body).encode() if not isinstance(body, bytes) else body
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/json/version":
            self._answer(200, {"Browser": "chrome/136.0.0.0", "webSocketDebuggerUrl": "WS-URL"})
        elif self.path == "/json/list":
            self._answer(200, TABS)
        elif self.path.startswith("/json/close/"):
            self._answer(200, f"Target {self.path.split('/')[3]} is closing")
        else:
            self._answer(404, {})

    def do_PUT(self):
        if self.path.startswith("/json/new"):
            TABS.append({"id": "tab-2", "type": "page", "title": "New", "url": self.path.split("?", 1)[1],
                         "webSocketDebuggerUrl": "WS-URL"})
            self._answer(200, {"id": "tab-2", "type": "page"})
        else:
            self._answer(404, {})

    def log_message(self, *args):
        pass


async def cdp_socket(socket):
    """The debugging websocket: the three DevTools methods the tools use."""
    async for raw in socket:
        call = json.loads(raw)
        method, call_id = call["method"], call["id"]
        if method == "Page.navigate":
            EVALUATED.append(("navigate", call["params"]["url"]))
            await socket.send(json.dumps({"id": call_id, "result": {"frameId": "f1", "loaderId": "l1"}}))
        elif method == "Page.captureScreenshot":
            await socket.send(json.dumps({"id": call_id,
                                          "result": {"data": base64.b64encode(b"png-bytes").decode()}}))
        elif method == "Runtime.evaluate":
            EVALUATED.append(("evaluate", call["params"]["expression"]))
            expression = call["params"]["expression"]
            if "document.querySelectorAll" in expression and "data-nf-ref" in expression:
                await socket.send(json.dumps({"id": call_id, "result": {"result": {"type": "object", "value": {
                    "url": "https://example.com", "title": "Example", "text": "Example Domain",
                    "elements": [{"ref": "e1", "tag": "a", "text": "More information"}]}}}}))
            else:
                await socket.send(json.dumps({"id": call_id, "result": {"result": {"type": "number", "value": 2}}}))
        else:
            await socket.send(json.dumps({"id": call_id, "error": {"message": f"{method} not mocked"}}))


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

    os.environ["NOTCHFOLK_MCP_CLIENTS_FILE"] = clients_file()
    os.environ["NOTCHFOLK_MCP_BROWSER"] = "cdp"
    os.environ["NOTCHFOLK_MCP_CDP_PORT"] = str(free_port())  # nothing there yet

    import contextlib
    import importlib
    import urllib.request as urlrequest

    import tools.browser as browser_module
    importlib.reload(browser_module)
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

    # The availability rule: no browser answering its debug port, no domain.
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-5 no Chromium: the domain is not offered", "browser_navigate" not in listed)

    # Now the mock Chromium: HTTP endpoints and the debugging websocket.
    http_port = free_port()
    mock = ThreadingHTTPServer(("127.0.0.1", http_port), MockChromium)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    ws_port = free_port()
    ws_server = await websockets.serve(cdp_socket, "127.0.0.1", ws_port)

    # The mock's websocket URL points at the real websocket port.
    global TABS
    TABS[0]["webSocketDebuggerUrl"] = f"ws://127.0.0.1:{ws_port}"
    TABS = [dict(tab) for tab in TABS]

    os.environ["NOTCHFOLK_MCP_CDP_PORT"] = str(http_port)
    importlib.reload(browser_module)
    import server as server_module
    server_module.mcp = None
    import server as fresh_server
    importlib.reload(fresh_server)
    port = free_port()

    def serve_again():
        asyncio.run(fresh_server.mcp.run_async(transport="http", host="127.0.0.1", port=port))

    threading.Thread(target=serve_again, daemon=True).start()
    for _ in range(100):
        with contextlib.suppress(Exception):
            urlrequest.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            break
        await asyncio.sleep(0.1)

    def transport():
        return StreamableHttpTransport(f"http://127.0.0.1:{port}/mcp")

    EVALUATED.clear()
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-1 reader sees browser_navigate", "browser_navigate" in listed)
        check("AC-4 reader does not see browser_click", "browser_click" not in listed)

        tabs = await reader.call_tool("browser_list_tabs", {})
        tabs = tabs.data if hasattr(tabs, "data") else tabs
        check("AC-2/3 browser_list_tabs", tabs["result"]["tabs"][0]["tabId"] == "tab-1", str(tabs))
        snapshot = await reader.call_tool("browser_snapshot", {"tab_id": "tab-1"})
        snapshot = snapshot.data if hasattr(snapshot, "data") else snapshot
        check("AC-2/3 browser_snapshot", snapshot["result"]["elements"][0]["ref"] == "e1", str(snapshot))
        navigate = await reader.call_tool("browser_navigate", {"tab_id": "tab-1", "url": "https://example.com"})
        check("AC-2/3 browser_navigate", navigate.data["result"]["frameId"] == "f1")
        macro = await reader.call_tool("browser_navigate",
                                       {"tab_id": "tab-1", "macro": "@google_search", "query": "notchfolk"})
        check("AC-2/3 navigate by macro",
              any(url == "https://www.google.com/search?q=notchfolk" for _, url in EVALUATED if url and "google" in str(url)),
              str(EVALUATED))
        screenshot = await reader.call_tool("browser_screenshot", {"tab_id": "tab-1"})
        check("AC-2/3 browser_screenshot returns an image",
              any(block.type == "image" for block in screenshot.content), str(screenshot.content))
        scroll = await reader.call_tool("browser_scroll", {"tab_id": "tab-1", "direction": "up", "amount": 200})
        check("AC-2/3 browser_scroll", any("window.scrollBy(0, -200)" in expr for _, expr in EVALUATED))

    async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as admin:
        listed = {tool.name for tool in await admin.list_tools()}
        check("AC-4 admin sees browser_click", "browser_click" in listed)
        await admin.call_tool("browser_click", {"tab_id": "tab-1", "ref": "e1"})
        check("contract: click by the snapshot's ref",
              any("data-nf-ref" in expr and "e1" in expr and ".click()" in expr
                  for _, expr in EVALUATED), str(EVALUATED[-3:]))
        await admin.call_tool("browser_type", {"tab_id": "tab-1", "text": "notchfolk", "selector": "#q"})
        check("contract: type sets the value and dispatches input",
              any("el.value" in expr and "new Event('input'" in expr for _, expr in EVALUATED))
        evaluate = await admin.call_tool("browser_evaluate", {"tab_id": "tab-1", "expression": "1 + 1"})
        evaluate = evaluate.data if hasattr(evaluate, "data") else evaluate
        check("AC-2 browser_evaluate", evaluate["result"] == 2, str(evaluate))
        created = await admin.call_tool("browser_create_tab", {"url": "https://example.com/new"})
        created = created.data if hasattr(created, "data") else created
        check("AC-2 browser_create_tab (PUT /json/new)", created["result"]["id"] == "tab-2", str(created))
        closed = await admin.call_tool("browser_close_tab", {"tab_id": "tab-1"})
        closed = closed.data if hasattr(closed, "data") else closed
        check("AC-2 browser_close_tab", "closing" in closed["result"], str(closed))

    mock.shutdown()
    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
