# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The Browser domain: the world sees and uses the web through a real browser.

The Camoufox backend talks the REST contract recorded in Phase 0
(docs/mcp-world-apis.md §2): plain HTTP to the Camoufox server on the
machine, at the address the user configured (the package's own default
http://localhost:9377), the access key the user set on it, if any. Notchfolk
does not run the adapter and does not speak CDP here — it talks the same
REST contract the adapter talks.

The domain is offered only when its backend answers (Camoufox its /health,
CDP its /json/version); when it is not there, the domain is not offered at
all (the spec's availability rule), and a backend that dies between calls
answers as a normal, isolated error (AC-5).

The CDP backend is the opt-in second way to the same ten tools, for a
Chromium-family browser of the user's own (spec section 2): NOTCHFOLK_MCP_BROWSER=cdp
points the domain at the browser's debug port, NOTCHFOLK_MCP_CDP_PORT (default
9222, the protocol's own). CDP carries no key — an open debug port is reachable
by any local process, which is what the opt-in says in the spec; Chrome 136 and
later keep the port away from the default profile, so the attached browser is a
dedicated profile. Firefox is out: it removed its CDP support.
"""

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request

import websockets
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
# what key. The defaults are the packages' own, not a choice made here.
BACKEND = os.getenv("NOTCHFOLK_MCP_BROWSER", "camoufox").lower()
CAMOFOX_URL = os.getenv("NOTCHFOLK_MCP_CAMOFOX_URL", "http://localhost:9377").rstrip("/")
CAMOFOX_KEY = os.getenv("NOTCHFOLK_MCP_CAMOFOX_KEY", "")
CDP_URL = os.getenv("NOTCHFOLK_MCP_CDP_URL", f"http://localhost:{os.getenv('NOTCHFOLK_MCP_CDP_PORT', '9222')}")

# One ceiling for a CDP call — connect, send, and the wait for the answer:
# a browser that dies mid-call answers as an isolated timeout (AC-5), not a
# hang. The Camoufox REST calls cap at 30s the same way.
CDP_CALL_TIMEOUT = 30
USER_ID = os.getenv("NOTCHFOLK_MCP_BROWSER_USER", "notchfolk")
SESSION_KEY = os.getenv("NOTCHFOLK_MCP_BROWSER_SESSION", "default")

# CDP's search macros, where a Camoufox macro has a plain URL: the same words
# the adapter's macros resolve to, spelt as their sites' own search URLs.
CDP_MACROS = {"@google_search": "https://www.google.com/search?q=", "@youtube_search": "https://www.youtube.com/results?search_query=",
              "@wikipedia_search": "https://en.wikipedia.org/w/index.php?search=", "@reddit_search": "https://www.reddit.com/search/?q=",
              "@amazon_search": "https://www.amazon.com/s?k=", "@twitter_search": "https://twitter.com/search?q="}


def cdp_available() -> bool:
    """Whether a Chromium-family browser answers its debug port."""
    try:
        urllib.request.urlopen(f"{CDP_URL}/json/version", timeout=5).read()
        return True
    except Exception:
        return False


def cdp_tabs() -> list:
    """The browser's targets, as the protocol lists them."""
    with urllib.request.urlopen(f"{CDP_URL}/json/list", timeout=10) as response:
        return json.load(response)


def cdp_websocket(tab_id: str) -> str:
    """The tab's debugging socket; the tab must be there, else an isolated error."""
    for tab in cdp_tabs():
        if tab.get("id") == tab_id:
            return tab["webSocketDebuggerUrl"]
    raise RuntimeError(f"no tab {tab_id}: the browser lists no such target")


async def cdp_call(tab_id: str, method: str, params: dict | None = None) -> dict:
    """One DevTools call on the tab's socket; its result, or its error as one.

    A browser that dies mid-call answers as an isolated timeout, not a hang
    (AC-5): the connect, the send, and the wait for the answer share one
    ceiling, and the timeout comes back as a RuntimeError like every other
    failure here.
    """
    try:
        return await asyncio.wait_for(_cdp_call_once(tab_id, method, params), timeout=CDP_CALL_TIMEOUT)
    except asyncio.TimeoutError:
        raise RuntimeError(
            f"cdp: {method} timed out after {CDP_CALL_TIMEOUT}s: the browser stopped answering") from None


async def _cdp_call_once(tab_id: str, method: str, params: dict | None = None) -> dict:
    """The call itself: connect, send, wait for the answer with this id."""
    async with websockets.connect(cdp_websocket(tab_id)) as socket:
        await socket.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            answer = json.loads(await socket.recv())
            if "id" not in answer:
                continue
            if "error" in answer:
                raise RuntimeError(f"cdp: {answer['error'].get('message', answer['error'])}")
            return answer.get("result", {})


async def cdp_evaluate(tab_id: str, expression: str) -> object:
    """Runs JavaScript in the tab and returns its value."""
    result = await cdp_call(tab_id, "Runtime.evaluate",
                            {"expression": expression, "returnByValue": True})
    if result.get("exceptionDetails"):
        raise RuntimeError(f"cdp: {result['exceptionDetails'].get('text', 'the expression failed')}")
    return result.get("result", {}).get("value")


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
    """Registers the Browser domain's tools on the configured backend — only
    when that backend answers; absent, the domain is not offered at all."""
    if BACKEND == "cdp":
        if cdp_available():
            register_cdp(mcp, authorize, write)
        return
    if available():
        register_camoufox(mcp, authorize, write)


def register_camoufox(mcp, authorize, write):
    """The Camoufox backend: the ten tools over the recorded REST contract."""

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


def register_cdp(mcp, authorize, write):
    """The CDP backend: the same ten tools over the DevTools protocol, for a
    Chromium-family browser of the user's own (the opt-in)."""

    @mcp.tool
    async def browser_navigate(tab_id: str, url: str | None = None, macro: str | None = None,
                               query: str | None = None) -> dict:
        """Opens a URL in the tab — or a search macro (@google_search, …) with a query."""
        await authorize("browser_navigate")
        if not url and macro:
            if macro not in CDP_MACROS:
                raise RuntimeError(f"unknown macro {macro}: {'/'.join(CDP_MACROS)}")
            url = CDP_MACROS[macro] + urllib.parse.quote_plus(query or "")
        if not url:
            raise RuntimeError("navigate needs a url, or a macro with a query")
        return {"ok": True, "result": await cdp_call(tab_id, "Page.navigate", {"url": url})}

    @mcp.tool
    async def browser_snapshot(tab_id: str, offset: int | None = None) -> dict:
        """The tab's structure and text, with element refs (e1, e2, …) to click or
        type into; the offset is Camoufox's pagination, unused here."""
        await authorize("browser_snapshot")
        page = await cdp_evaluate(tab_id, """
            (() => {
                const interactive = [...document.querySelectorAll(
                    'a, button, input, textarea, select, [role="button"], [onclick]')].slice(0, 50);
                interactive.forEach((el, index) => el.setAttribute('data-nf-ref', `e${index + 1}`));
                return {url: location.href, title: document.title,
                        text: (document.body.innerText || '').slice(0, 5000),
                        elements: interactive.map((el, index) => ({
                            ref: `e${index + 1}`, tag: el.tagName.toLowerCase(),
                            text: (el.innerText || el.value || '').slice(0, 80)}))};
            })()""")
        return {"ok": True, "result": page}

    @mcp.tool
    async def browser_screenshot(tab_id: str) -> Image:
        """The tab as it looks, as an image."""
        await authorize("browser_screenshot")
        import base64
        shot = await cdp_call(tab_id, "Page.captureScreenshot", {"format": "png"})
        return Image(data=base64.b64decode(shot["data"]), format="image/png")

    @mcp.tool
    async def browser_scroll(tab_id: str, direction: str = "down", amount: int = 500) -> dict:
        """Scrolls the tab: up, down, left or right, by so many pixels."""
        await authorize("browser_scroll")
        if direction not in {"up", "down", "left", "right"}:
            raise RuntimeError(f"unknown direction {direction}: up, down, left or right")
        by = {"up": f"window.scrollBy(0, -{int(amount)})", "down": f"window.scrollBy(0, {int(amount)})",
              "left": f"window.scrollBy(-{int(amount)}, 0)", "right": f"window.scrollBy({int(amount)}, 0)"}[direction]
        return {"ok": True, "result": await cdp_evaluate(tab_id, by)}

    @mcp.tool
    async def browser_list_tabs() -> dict:
        """The open tabs, with their ids and titles."""
        await authorize("browser_list_tabs")
        tabs = [{"tabId": tab["id"], "title": tab.get("title", ""), "url": tab.get("url", "")}
                for tab in cdp_tabs() if tab.get("type") == "page"]
        return {"ok": True, "result": {"tabs": tabs}}

    @mcp.tool
    async def browser_click(tab_id: str, ref: str | None = None, selector: str | None = None) -> dict:
        """Clicks an element: a snapshot's ref (e1, e2, …) or a CSS selector."""
        await write("browser_click")
        where = f'[data-nf-ref="{ref}"]' if ref else selector
        if not where:
            raise RuntimeError("click needs a ref or a selector")
        # The element may have gone while the page moved on: ask for it and
        # click it in one script, so a missing element is a plain error
        # ("element not found"), not a TypeError on null.
        script = ("(() => { const el = document.querySelector(" + json.dumps(where) + ");" +
                  " if (!el) return false; el.click(); return true; })()")
        if not await cdp_evaluate(tab_id, script):
            raise RuntimeError(f"click: element not found: {where}")
        return {"ok": True}

    @mcp.tool
    async def browser_type(tab_id: str, text: str, ref: str | None = None,
                           selector: str | None = None, press_enter: bool = False) -> dict:
        """Types text into the tab's element: a snapshot's ref or a CSS selector,
        pressing Enter after it when asked."""
        await write("browser_type")
        where = f'[data-nf-ref="{ref}"]' if ref else selector
        if not where:
            raise RuntimeError("type needs a ref or a selector")
        # One script, as with click: the element may have gone while the page
        # moved on, so a missing element is a plain "element not found", not a
        # TypeError on null. The Enter key goes to the same element, in the
        # same script — the old form built an arrow function it never called,
        # so Enter was never dispatched at all.
        script = ("(() => { const el = document.querySelector(" + json.dumps(where) + ");" +
                  " if (!el) return false; el.focus(); el.value = " + json.dumps(text) + ";" +
                  " el.dispatchEvent(new Event('input', {bubbles: true}));" +
                  (" el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));"
                   if press_enter else "") +
                  " return true; })()")
        if not await cdp_evaluate(tab_id, script):
            raise RuntimeError(f"type: element not found: {where}")
        return {"ok": True}

    @mcp.tool
    async def browser_evaluate(tab_id: str, expression: str) -> dict:
        """Runs JavaScript in the tab and returns its value."""
        await write("browser_evaluate")
        return {"ok": True, "result": await cdp_evaluate(tab_id, expression)}

    @mcp.tool
    async def browser_create_tab(url: str) -> dict:
        """Opens a new tab on the URL."""
        await write("browser_create_tab")
        call = urllib.request.Request(f"{CDP_URL}/json/new?{urllib.parse.quote(url)}", method="PUT")
        try:
            with urllib.request.urlopen(call, timeout=15) as response:
                return {"ok": True, "result": json.load(response)}
        except urllib.error.HTTPError:
            # Older Chromiums take the same route as GET.
            with urllib.request.urlopen(f"{CDP_URL}/json/new?{urllib.parse.quote(url)}", timeout=15) as response:
                return {"ok": True, "result": json.load(response)}

    @mcp.tool
    async def browser_close_tab(tab_id: str) -> dict:
        """Closes the tab."""
        await write("browser_close_tab")
        with urllib.request.urlopen(f"{CDP_URL}/json/close/{tab_id}", timeout=15) as response:
            return {"ok": True, "result": response.read().decode()}
