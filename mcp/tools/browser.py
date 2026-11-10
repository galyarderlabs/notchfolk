# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The Browser domain: the world sees and uses the web through a real browser.

The Camoufox backend talks the REST contract recorded in Phase 0
(docs/mcp-world-apis.md §2): plain HTTP to the Camoufox server on the
machine, at the address the user configured (the package's own default
http://localhost:9377), the access key the user set on it, if any. Notchfolk
does not run the adapter and does not speak CDP here — it talks the same
REST contract the adapter talks.

The domain is offered only when the server answers its /health; when it is
not there, the domain is not offered at all (the spec's availability rule),
and a backend that dies between calls answers as a normal, isolated error
(AC-5). The CDP backend is the opt-in second way to the same ten tools,
for a Chromium-family browser of the user's own; it follows in its own
pull request, as the tasks list it.
"""

import json
import os
import urllib.error
import urllib.request

from fastmcp.utilities.types import Image

READ_SCOPES = {
    "browser_navigate": "browser:read",
    "browser_snapshot": "browser:read",
    "browser_screenshot": "browser:read",
    "browser_scroll": "browser:read",
    "browser_list_tabs": "browser:read",
}

WRITE_SCOPES = {
    "browser_click": "browser:write",
    "browser_type": "browser:write",
    "browser_evaluate": "browser:write",
    "browser_create_tab": "browser:write",
    "browser_close_tab": "browser:write",
}

# The user's own configuration (the mcp.env model): which backend, where, with
# what key. The defaults are the Camoufox package's own, not a choice made here.
CAMOFOX_URL = os.getenv("NOTCHFOLK_MCP_CAMOFOX_URL", "http://localhost:9377").rstrip("/")
CAMOFOX_KEY = os.getenv("NOTCHFOLK_MCP_CAMOFOX_KEY", "")
USER_ID = os.getenv("NOTCHFOLK_MCP_BROWSER_USER", "notchfolk")
SESSION_KEY = os.getenv("NOTCHFOLK_MCP_BROWSER_SESSION", "default")


def available() -> bool:
    """Whether the Camoufox server answers its health route."""
    try:
        request("GET", "/health")
        return True
    except Exception:
        return False


def request(method: str, route: str, body: dict | None = None) -> object:
    """One REST call to the Camoufox server, with the access key when set.

    A non-2xx answer is a normal, isolated error carrying the server's own
    words; no secret rides along (AC-5).
    """
    payload = json.dumps(body).encode() if body is not None else None
    call = urllib.request.Request(f"{CAMOFOX_URL}{route}", data=payload, method=method)
    if payload is not None:
        call.add_header("Content-Type", "application/json")
    if CAMOFOX_KEY:
        call.add_header("Authorization", f"Bearer {CAMOFOX_KEY}")
    try:
        with urllib.request.urlopen(call, timeout=30) as response:
            content = response.read()
            if (response.headers.get("Content-Type") or "").startswith("image/"):
                return content
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{error.code}: {error.read().decode(errors='replace')[:2000]}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"the Camoufox server is unreachable: {error.reason}") from None


def register(mcp, authorize, write):
    """Registers the Browser domain's tools — only when the server answers."""
    if not available():
        return

    @mcp.tool
    async def browser_navigate(tab_id: str, url: str | None = None, macro: str | None = None,
                               query: str | None = None) -> dict:
        """Opens a URL in the tab — or a search macro (@google_search, …) with a query."""
        await authorize("browser_navigate")
        body = {"userId": USER_ID}
        if url:
            body["url"] = url
        else:
            body["macro"] = macro
            body["query"] = query
        return {"ok": True, "result": request("POST", f"/tabs/{tab_id}/navigate", body)}

    @mcp.tool
    async def browser_snapshot(tab_id: str, offset: int | None = None) -> dict:
        """The tab's structure and text, with element refs (e1, e2, …) to click or
        type into. A large page truncates: call again with the returned next_offset."""
        await authorize("browser_snapshot")
        route = f"/tabs/{tab_id}/snapshot?userId={USER_ID}&includeScreenshot=true"
        if offset is not None:
            route += f"&offset={int(offset)}"
        result = request("GET", route)
        return {"ok": True, "result": result}

    @mcp.tool
    async def browser_screenshot(tab_id: str) -> Image:
        """The tab as it looks, as an image."""
        await authorize("browser_screenshot")
        image = request("GET", f"/tabs/{tab_id}/screenshot?userId={USER_ID}")
        if not isinstance(image, bytes):
            raise RuntimeError("Screenshot failed: the server answered no image")
        return Image(data=image, format="image/png")

    @mcp.tool
    async def browser_scroll(tab_id: str, direction: str = "down", amount: int = 500) -> dict:
        """Scrolls the tab: up, down, left or right, by so many pixels."""
        await authorize("browser_scroll")
        if direction not in {"up", "down", "left", "right"}:
            raise RuntimeError(f"unknown direction {direction}: up, down, left or right")
        return {"ok": True, "result": request("POST", f"/tabs/{tab_id}/scroll",
                {"direction": direction, "amount": int(amount), "userId": USER_ID})}

    @mcp.tool
    async def browser_list_tabs() -> dict:
        """The open tabs, with their ids and titles."""
        await authorize("browser_list_tabs")
        return {"ok": True, "result": request("GET", f"/tabs?userId={USER_ID}")}

    @mcp.tool
    async def browser_click(tab_id: str, ref: str | None = None, selector: str | None = None) -> dict:
        """Clicks an element: a snapshot's ref (e1, e2, …) or a CSS selector."""
        await write("browser_click")
        body = {"userId": USER_ID, **({"ref": ref} if ref else {}), **({"selector": selector} if selector else {})}
        return {"ok": True, "result": request("POST", f"/tabs/{tab_id}/click", body)}

    @mcp.tool
    async def browser_type(tab_id: str, text: str, ref: str | None = None,
                           selector: str | None = None, press_enter: bool = False) -> dict:
        """Types text into the tab's element: a snapshot's ref or a CSS selector,
        pressing Enter after it when asked."""
        await write("browser_type")
        body = {"userId": USER_ID, "text": text, "pressEnter": press_enter,
                **({"ref": ref} if ref else {}), **({"selector": selector} if selector else {})}
        return {"ok": True, "result": request("POST", f"/tabs/{tab_id}/type", body)}

    @mcp.tool
    async def browser_evaluate(tab_id: str, expression: str) -> dict:
        """Runs JavaScript in the tab and returns its value."""
        await write("browser_evaluate")
        return {"ok": True, "result": request("POST", f"/tabs/{tab_id}/evaluate",
                {"userId": USER_ID, "expression": expression})}

    @mcp.tool
    async def browser_create_tab(url: str) -> dict:
        """Opens a new tab on the URL."""
        await write("browser_create_tab")
        return {"ok": True, "result": request("POST", "/tabs",
                {"url": url, "userId": USER_ID, "sessionKey": SESSION_KEY})}

    @mcp.tool
    async def browser_close_tab(tab_id: str) -> dict:
        """Closes the tab."""
        await write("browser_close_tab")
        return {"ok": True, "result": request("DELETE", f"/tabs/{tab_id}?userId={USER_ID}")}
