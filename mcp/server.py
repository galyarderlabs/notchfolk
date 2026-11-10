# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs
"""MCP tools for Notchfolk's local D-Bus services."""

import asyncio
import json
import logging
import os
import re
from datetime import datetime, date as calendar_date
from pathlib import Path
from urllib.parse import urlsplit

from fastmcp import FastMCP
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
from fastmcp.server.dependencies import get_access_token
from fastmcp.server.middleware import Middleware
from dbus_next import BusType, Message
from dbus_next.aio import MessageBus
from notchfolk_oauth import NotchfolkOAuthProvider

BUS = "io.galyarderlabs.notchfolk.Daemon"
PATH = "/io/galyarderlabs/notchfolk/Daemon"
SHELL_BUS = "org.gnome.Shell"
SHELL_PATH = "/io/galyarderlabs/notchfolk/Shell"
SHELL_INTERFACE = "io.galyarderlabs.notchfolk.Shell1"
WRITE_TOOLS = {item.strip() for item in os.getenv("NOTCHFOLK_MCP_WRITE_TOOLS", "").split(",") if item.strip()}
HOST = os.getenv("NOTCHFOLK_MCP_HOST", "127.0.0.1")
PORT = int(os.getenv("NOTCHFOLK_MCP_PORT", "8765"))
TOKEN = os.getenv("NOTCHFOLK_MCP_TOKEN", "")
CLIENTS_PATH = os.getenv("NOTCHFOLK_MCP_CLIENTS_FILE", os.path.expanduser("~/.config/notchfolk/mcp-clients.json"))
try:
    if os.path.exists(CLIENTS_PATH) and os.stat(CLIENTS_PATH).st_mode & 0o077:
        raise SystemExit(f"{CLIENTS_PATH} must be private (chmod 600)")
    with open(CLIENTS_PATH, encoding="utf-8") as client_file:
        CLIENTS = json.load(client_file)
except FileNotFoundError:
    CLIENTS = json.loads(os.getenv("NOTCHFOLK_MCP_CLIENTS", "{}"))
LOG = logging.getLogger("notchfolk-mcp")

if TOKEN and not CLIENTS:
    CLIENTS = {"default": {"token": TOKEN, "scopes": ["*:read"]}}
TOKENS = {entry["token"]: {"sub": name, "client_id": name, "scopes": entry.get("scopes", [])}
          for name, entry in CLIENTS.items() if entry.get("token")}
if HOST not in {"127.0.0.1", "::1", "localhost"} and not TOKENS:
    raise SystemExit("Configure NOTCHFOLK_MCP_TOKEN or a private NOTCHFOLK_MCP_CLIENTS_FILE before binding beyond loopback")
bus: MessageBus | None = None


async def call(interface: str, member: str, signature: str = "", *args, bus_name: str = BUS, path: str = PATH):
    if bus is None:
        raise RuntimeError("Notchfolk MCP server is not connected to the session bus")
    response = await bus.call(Message(destination=bus_name, path=path, interface=interface,
                                      member=member, signature=signature, body=list(args)))
    if response.message_type.name == "ERROR":
        error = RuntimeError(response.body[0] if response.body else response.error_name)
        error.dbus_error = response.error_name
        raise error
    return response.body[0] if response.body else None


async def shell_call(member: str, signature: str = "", *args):
    """Asks the Notchfolk extension, in GNOME Shell's name, for what notchfolkd tells only Shell.

    The extension exports Shell1 (see gnome-extension/src/shellProxy.js); without it there is
    nothing at that address, and the caller hears that as the reason. Anything else — the bus
    itself failing, or the extension refusing — keeps its own words.
    """
    try:
        return await call(SHELL_INTERFACE, member, signature, *args,
                          bus_name=SHELL_BUS, path=SHELL_PATH)
    except RuntimeError as error:
        if getattr(error, "dbus_error", None) in {
            "org.freedesktop.DBus.Error.UnknownObject",
            "org.freedesktop.DBus.Error.UnknownInterface",
            "org.freedesktop.DBus.Error.UnknownMethod",
            "org.freedesktop.DBus.Error.ServiceUnknown",
            "org.freedesktop.DBus.Error.NameHasNoOwner",
        }:
            raise RuntimeError(f"{member} needs Notchfolk's GNOME Shell extension: {error}") from error
        raise


READ_SCOPES = {
    "list_tasks": "tasks:read", "list_calendar_events": "calendar:read", "list_reminders": "reminders:read",
    "list_reminder_history": "reminders:read",
    "list_food_entries": "calories:read", "get_water_entries": "water:read", "prayer_schedule": "prayer:read",
    "now_playing": "media:read", "focus_state": "focus:read", "get_app_usage": "apps:read",
    "get_system_state": "system:read", "list_shelf_items": "shelf:read", "search_clipboard": "clipboard:read",
    "get_clipboard_text": "clipboard:read", "get_router_stats": "router:read", "get_usage_quota": "usage:read",
    "list_calendars": "calendar:read", "get_meeting_link": "calendar:read", "parse_event_text": "calendar:read",
    "get_latest_update": "system:read", "list_media_players": "media:read", "get_lyrics": "media:read",
    "focus_config": "focus:read",
}
WRITE_SCOPES = {
    "add_task": "tasks:write", "set_task_done": "tasks:write", "rename_task": "tasks:write",
    "remove_task": "tasks:write", "clear_done_tasks": "tasks:write",
    "add_calendar_event": "calendar:write", "add_calendar_event_to": "calendar:write",
    "remove_calendar_event": "calendar:write", "add_reminder": "reminders:write", "dismiss_reminder": "reminders:write",
    "add_food_entry": "calories:write",
    "update_food_entry": "calories:write", "remove_food_entry": "calories:write", "log_water": "water:write",
    "remove_water_entry": "water:write", "set_prayer_location": "prayer:write",
    "control_media": "media:write", "media_seek": "media:write", "raise_media": "media:write",
    "choose_media_player": "media:write", "start_focus": "focus:write", "pause_focus": "focus:write",
    "stop_focus": "focus:write", "skip_focus": "focus:write", "start_focus_phase": "focus:write",
    "add_shelf_files": "shelf:write", "remove_shelf_item": "shelf:write", "clear_shelf": "shelf:write",
    "refresh_shelf": "shelf:write",
    "pin_clipboard": "clipboard:write", "remove_clipboard_item": "clipboard:write",
    "open_url": "desktop:write",
}


def public_mcp_url() -> str | None:
    """Find the public HTTPS origin used by the named Cloudflare tunnel."""
    configured = os.getenv("NOTCHFOLK_MCP_PUBLIC_URL", "").strip()
    hostname = ""
    if configured:
        parsed = urlsplit(configured)
        if parsed.scheme != "https" or not parsed.hostname or parsed.query or parsed.fragment:
            raise SystemExit("NOTCHFOLK_MCP_PUBLIC_URL must be an https origin")
        hostname = parsed.hostname
    else:
        config_home = Path(os.getenv("XDG_CONFIG_HOME", Path.home() / ".config"))
        tunnel_config = config_home / "notchfolk" / "cloudflared" / "config.yml"
        try:
            config = tunnel_config.read_text(encoding="utf-8")
        except OSError:
            return None
        match = re.search(r"^\s*-\s*hostname:\s*([A-Za-z0-9.-]+)\s*$", config, re.MULTILINE)
        if not match:
            return None
        hostname = match.group(1)
    return f"https://{hostname}"


from tools import register as register_domains, scopes as domain_scopes
DOMAIN_READ_SCOPES, DOMAIN_WRITE_SCOPES = domain_scopes()
READ_SCOPES.update(DOMAIN_READ_SCOPES)
WRITE_SCOPES.update(DOMAIN_WRITE_SCOPES)

OAUTH_SCOPES = sorted({"*:read", *READ_SCOPES.values(), *WRITE_SCOPES.values()})
PUBLIC_MCP_URL = public_mcp_url()
if PUBLIC_MCP_URL:
    oauth_state = Path(os.getenv("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    auth = NotchfolkOAuthProvider(
        base_url=PUBLIC_MCP_URL,
        legacy_tokens=TOKENS,
        scopes=OAUTH_SCOPES,
        db_path=os.getenv("NOTCHFOLK_MCP_OAUTH_DB", str(oauth_state / "notchfolk" / "mcp-oauth.sqlite3")),
    )
else:
    auth = StaticTokenVerifier(tokens=TOKENS) if TOKENS else None
mcp = FastMCP("Notchfolk", auth=auth)


class ScopedListing(Middleware):
    """A restricted tool is not visible as callable to a key without its scope (the
    spec's AC-4): tools/list answers with only what the calling key may call."""

    async def on_list_tools(self, context, call_next):
        tools = await call_next(context)
        token = get_access_token() if auth else None
        if not auth or token is None:
            return tools
        scopes = set(token.scopes)
        def visible(tool):
            scope = WRITE_SCOPES.get(tool.name)
            return scope is None or scope in scopes
        return [tool for tool in tools if visible(tool)]


mcp.add_middleware(ScopedListing())


async def authorize(tool: str, *, write_access: bool = False):
    token = get_access_token() if auth else None
    if auth and token is None:
        raise PermissionError("authentication is required")
    if token is None:
        return
    scope = (WRITE_SCOPES if write_access else READ_SCOPES).get(tool)
    if scope is None:
        raise PermissionError(f"{tool} has no permission mapping")
    if scope not in token.scopes and not (scope.endswith(":read") and "*:read" in token.scopes):
        LOG.warning("MCP permission denied: client=%s tool=%s required=%s", token.client_id, tool, scope)
        raise PermissionError(f"{tool} requires {scope} permission")


def parse_date(value: str) -> calendar_date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise ValueError(f"{value!r} must be a YYYY-MM-DD date")


def filter_entries(entries: list, entry_date, day: str | None = None,
                   start_date: str | None = None, end_date: str | None = None) -> list:
    if day is None and start_date is None and end_date is None:
        return entries
    day = parse_date(day) if day else None
    start = parse_date(start_date) if start_date else None
    end = parse_date(end_date) if end_date else None
    if callable(entry_date):
        key = entry_date
    else:
        key = lambda entry: datetime.fromtimestamp(entry[entry_date] / 1000).date()
    return [entry for entry in entries
            if ((day is None or key(entry) == day)
                and (start is None or key(entry) >= start)
                and (end is None or key(entry) <= end))]


async def read(tool: str, interface: str, prop: str):
    await authorize(tool)
    token = get_access_token() if auth else None
    LOG.info("MCP read tool called: client=%s tool=%s", token.client_id if token else "loopback", tool)
    variant = await call("org.freedesktop.DBus.Properties", "Get", "ss", interface, prop)
    return json.loads(variant.value)


async def read_text(tool: str, interface: str, prop: str):
    """As `read`, for a property that is a plain string rather than JSON (Updates1.Latest)."""
    await authorize(tool)
    token = get_access_token() if auth else None
    LOG.info("MCP read tool called: client=%s tool=%s", token.client_id if token else "loopback", tool)
    variant = await call("org.freedesktop.DBus.Properties", "Get", "ss", interface, prop)
    return variant.value


async def write(tool: str):
    await authorize(tool, write_access=True)
    token = get_access_token() if auth else None
    if token is None and tool not in WRITE_TOOLS:
        LOG.warning("MCP write denied: client=loopback tool=%s", tool)
        raise PermissionError(f"{tool} is disabled; add it to NOTCHFOLK_MCP_WRITE_TOOLS to allow it")
    LOG.info("MCP write tool called: client=%s tool=%s", token.client_id if token else "loopback", tool)


register_domains(mcp, authorize, write)


@mcp.tool
async def list_tasks() -> list:
    """List Notchfolk to-do items."""
    return await read("list_tasks", "io.galyarderlabs.notchfolk.Todo1", "Items")


@mcp.tool
async def add_task(title: str) -> int:
    """Add a to-do item in Notchfolk. Requires add_task write permission."""
    await write("add_task")
    return await call("io.galyarderlabs.notchfolk.Todo1", "Add", "s", title)


@mcp.tool
async def set_task_done(task_id: int, done: bool = True) -> str:
    """Mark an Notchfolk to-do item done or reopen it. Requires set_task_done permission."""
    await write("set_task_done")
    await call("io.galyarderlabs.notchfolk.Todo1", "SetDone", "tb", task_id, done)
    return "updated"


@mcp.tool
async def rename_task(task_id: int, title: str) -> str:
    """Rename an Notchfolk to-do item. Requires rename_task permission."""
    await write("rename_task")
    await call("io.galyarderlabs.notchfolk.Todo1", "Rename", "ts", task_id, title)
    return "renamed"


@mcp.tool
async def remove_task(task_id: int) -> str:
    """Remove an Notchfolk to-do item. Requires remove_task permission."""
    await write("remove_task")
    await call("io.galyarderlabs.notchfolk.Todo1", "Remove", "t", task_id)
    return "removed"


@mcp.tool
async def clear_done_tasks() -> str:
    """Remove every finished to-do item. Requires clear_done_tasks permission."""
    await write("clear_done_tasks")
    await call("io.galyarderlabs.notchfolk.Todo1", "ClearDone")
    return "cleared"


@mcp.tool
async def list_calendar_events(date: str | None = None, start_date: str | None = None,
                                end_date: str | None = None) -> list:
    """List Notchfolk's own calendar events, optionally filtered by date or date range (YYYY-MM-DD)."""
    events = await read("list_calendar_events", "io.galyarderlabs.notchfolk.Calendar1", "Events")
    return filter_entries(events, lambda entry: parse_date(entry["date"]),
                          date, start_date, end_date)


@mcp.tool
async def add_calendar_event(date: str, text: str) -> int:
    """Add a calendar event on YYYY-MM-DD. Requires add_calendar_event permission."""
    await write("add_calendar_event")
    return await call("io.galyarderlabs.notchfolk.Calendar1", "Add", "ss", date, text)


@mcp.tool
async def remove_calendar_event(event_id: int) -> str:
    """Remove one Notchfolk calendar event. Requires remove_calendar_event permission."""
    await write("remove_calendar_event")
    await call("io.galyarderlabs.notchfolk.Calendar1", "Remove", "t", event_id)
    return "removed"


@mcp.tool
async def add_calendar_event_to(calendar: str, date: str, text: str) -> str:
    """Add an event to a desktop calendar by uid (or "notchfolk" for Notchfolk's own).
    Requires add_calendar_event_to permission."""
    await write("add_calendar_event_to")
    return await call("io.galyarderlabs.notchfolk.Calendar1", "AddTo", "sss", calendar, date, text) or ""


@mcp.tool
async def list_calendars() -> list:
    """List the desktop calendars a new event can go to."""
    await authorize("list_calendars")
    token = get_access_token() if auth else None
    LOG.info("MCP read tool called: client=%s tool=%s", token.client_id if token else "loopback", "list_calendars")
    return json.loads(await call("io.galyarderlabs.notchfolk.Calendar1", "Calendars"))


@mcp.tool
async def get_meeting_link(source_uid: str, event_uid: str) -> str:
    """Read a desktop calendar event's meeting link (Meet, Zoom, Teams, Webex), or an empty string."""
    await authorize("get_meeting_link")
    token = get_access_token() if auth else None
    LOG.info("MCP read tool called: client=%s tool=%s", token.client_id if token else "loopback", "get_meeting_link")
    return await call("io.galyarderlabs.notchfolk.Calendar1", "MeetingLink", "ss", source_uid, event_uid)


@mcp.tool
async def parse_event_text(text: str) -> dict:
    """See how a calendar event text parses (title and times), without adding it."""
    await authorize("parse_event_text")
    token = get_access_token() if auth else None
    LOG.info("MCP read tool called: client=%s tool=%s", token.client_id if token else "loopback", "parse_event_text")
    return json.loads(await call("io.galyarderlabs.notchfolk.Calendar1", "Parse", "s", text))


@mcp.tool
async def list_reminders() -> list:
    """List scheduled Notchfolk reminders."""
    return await read("list_reminders", "io.galyarderlabs.notchfolk.Reminders1", "Items")


@mcp.tool
async def list_reminder_history() -> list:
    """List the reminders shown in the last 7 days, newest first, with their due and shown times."""
    return await read("list_reminder_history", "io.galyarderlabs.notchfolk.Reminders1", "History")


@mcp.tool
async def add_reminder(text: str, delay_minutes: int) -> int:
    """Schedule an Notchfolk reminder up to one week away. Requires add_reminder permission."""
    await write("add_reminder")
    if not 0 <= delay_minutes <= 10_080:
        raise ValueError("delay_minutes must be between 0 and 10080")
    return await call("io.galyarderlabs.notchfolk.Reminders1", "Add", "ts", delay_minutes * 60_000, text)


@mcp.tool
async def dismiss_reminder(reminder_id: int) -> str:
    """Cancel a scheduled reminder. Requires dismiss_reminder permission."""
    await write("dismiss_reminder")
    await call("io.galyarderlabs.notchfolk.Reminders1", "Dismiss", "t", reminder_id)
    return "dismissed"


@mcp.tool
async def list_food_entries(date: str | None = None, start_date: str | None = None,
                             end_date: str | None = None) -> list:
    """List calorie entries, optionally filtered by date or date range (YYYY-MM-DD)."""
    entries = await read("list_food_entries", "io.galyarderlabs.notchfolk.Calories1", "Entries")
    return filter_entries(entries, "at_ms", date, start_date, end_date)


@mcp.tool
async def get_water_entries(date: str | None = None, start_date: str | None = None,
                             end_date: str | None = None) -> list:
    """List water log entries, optionally filtered by date or date range (YYYY-MM-DD)."""
    entries = await read("get_water_entries", "io.galyarderlabs.notchfolk.Water1", "Entries")
    return filter_entries(entries, "at_ms", date, start_date, end_date)


@mcp.tool
async def log_water(amount_ml: int) -> int:
    """Log a water drink of 50-3000 ml. Requires log_water permission."""
    await write("log_water")
    if not 50 <= amount_ml <= 3000:
        raise ValueError("amount_ml must be between 50 and 3000")
    return await call("io.galyarderlabs.notchfolk.Water1", "Drink", "u", amount_ml)


@mcp.tool
async def remove_water_entry(entry_id: int) -> str:
    """Remove a water log entry. Requires remove_water_entry permission."""
    await write("remove_water_entry")
    await call("io.galyarderlabs.notchfolk.Water1", "Remove", "t", entry_id)
    return "removed"


@mcp.tool
async def add_food_entry(food: str, calories: int) -> int:
    """Log food and its calorie count locally. Requires add_food_entry permission."""
    await write("add_food_entry")
    return await call("io.galyarderlabs.notchfolk.Calories1", "Add", "su", food, calories)


@mcp.tool
async def update_food_entry(entry_id: int, food: str, calories: int) -> str:
    """Edit a calorie entry. Requires update_food_entry permission."""
    await write("update_food_entry")
    await call("io.galyarderlabs.notchfolk.Calories1", "Update", "tsu", entry_id, food, calories)
    return "updated"


@mcp.tool
async def remove_food_entry(entry_id: int) -> str:
    """Remove a calorie entry. Requires remove_food_entry permission."""
    await write("remove_food_entry")
    await call("io.galyarderlabs.notchfolk.Calories1", "Remove", "t", entry_id)
    return "removed"


@mcp.tool
async def prayer_schedule(date: str | None = None) -> dict:
    """Get prayer times for today or a given date (YYYY-MM-DD) at the configured location."""
    if date is None:
        await call("io.galyarderlabs.notchfolk.Prayer1", "RefreshNow")
    else:
        await call("io.galyarderlabs.notchfolk.Prayer1", "RefreshForDate", "s", parse_date(date).isoformat())
    return await read("prayer_schedule", "io.galyarderlabs.notchfolk.Prayer1", "Schedule")


@mcp.tool
async def set_prayer_location(city: str, country: str) -> str:
    """Set the city used for prayer times. Requires set_prayer_location permission."""
    await write("set_prayer_location")
    await call("io.galyarderlabs.notchfolk.Prayer1", "SetLocation", "ss", city, country)
    return "updated"


@mcp.tool
async def now_playing() -> dict:
    """Read the current Notchfolk media player and track."""
    return await read("now_playing", "io.galyarderlabs.notchfolk.Media1", "NowPlaying")


@mcp.tool
async def list_media_players() -> list:
    """List the running media players, with which one is active."""
    return await read("list_media_players", "io.galyarderlabs.notchfolk.Media1", "Players")


@mcp.tool
async def get_lyrics() -> dict:
    """Read the current track's looked-up lyrics."""
    return await read("get_lyrics", "io.galyarderlabs.notchfolk.Media1", "Lyrics")


@mcp.tool
async def media_seek(position_us: int) -> str:
    """Seek the active player to an absolute position in microseconds. Requires media_seek permission."""
    await write("media_seek")
    if position_us < 0:
        raise ValueError("position_us must not be negative")
    await call("io.galyarderlabs.notchfolk.Media1", "SetPosition", "x", position_us)
    return "sent"


@mcp.tool
async def raise_media() -> str:
    """Bring the active media player's window to the front. Requires raise_media permission."""
    await write("raise_media")
    await call("io.galyarderlabs.notchfolk.Media1", "Raise")
    return "raised"


@mcp.tool
async def choose_media_player(name: str) -> str:
    """Control the player named by list_media_players. Requires choose_media_player permission."""
    await write("choose_media_player")
    await call("io.galyarderlabs.notchfolk.Media1", "Choose", "s", name)
    return "chosen"


@mcp.tool
async def control_media(command: str) -> str:
    """Control the active player: play_pause, next, or previous. Requires control_media permission."""
    await write("control_media")
    methods = {"play_pause": "PlayPause", "next": "Next", "previous": "Previous"}
    method = methods.get(command)
    if method is None:
        raise ValueError("command must be play_pause, next, or previous")
    await call("io.galyarderlabs.notchfolk.Media1", method)
    return "sent"


@mcp.tool
async def focus_state() -> dict:
    """Read Notchfolk's focus timer and today's completed focus sessions."""
    return await read("focus_state", "io.galyarderlabs.notchfolk.Pomodoro1", "State")


@mcp.tool
async def focus_config() -> dict:
    """Read the focus timer's configuration (durations and auto-start)."""
    return await read("focus_config", "io.galyarderlabs.notchfolk.Pomodoro1", "Config")


@mcp.tool
async def open_url(url: str) -> str:
    """Open an HTTP or HTTPS URL in the desktop browser. Requires desktop:write and open_url allowlist permission."""
    await write("open_url")
    if not url.startswith(("https://", "http://")) or any(ord(char) < 32 for char in url):
        raise ValueError("url must be an HTTP or HTTPS URL")
    response = await bus.call(Message(destination="org.freedesktop.portal.Desktop",
        path="/org/freedesktop/portal/desktop", interface="org.freedesktop.portal.OpenURI",
        member="OpenURI", signature="ssa{sv}", body=["", url, {}]))
    if response.message_type.name == "ERROR":
        raise RuntimeError(response.body[0] if response.body else response.error_name)
    return "opened"


@mcp.tool
async def start_focus() -> str:
    """Start or resume Notchfolk's focus timer. Requires start_focus permission."""
    await write("start_focus")
    await call("io.galyarderlabs.notchfolk.Pomodoro1", "Start")
    return "started"


@mcp.tool
async def pause_focus() -> str:
    """Pause Notchfolk's focus timer. Requires pause_focus permission."""
    await write("pause_focus")
    await call("io.galyarderlabs.notchfolk.Pomodoro1", "Pause")
    return "paused"


@mcp.tool
async def stop_focus() -> str:
    """Stop Notchfolk's focus timer. Requires stop_focus permission."""
    await write("stop_focus")
    await call("io.galyarderlabs.notchfolk.Pomodoro1", "Stop")
    return "stopped"


@mcp.tool
async def skip_focus() -> str:
    """End the focus phase early without counting it. Requires skip_focus permission."""
    await write("skip_focus")
    await call("io.galyarderlabs.notchfolk.Pomodoro1", "Skip")
    return "skipped"


@mcp.tool
async def start_focus_phase(phase: str) -> str:
    """Start a focus phase right away: focus, short_break, or long_break. Requires start_focus_phase permission."""
    await write("start_focus_phase")
    if phase not in {"focus", "short_break", "long_break"}:
        raise ValueError("phase must be focus, short_break, or long_break")
    await call("io.galyarderlabs.notchfolk.Pomodoro1", "StartPhase", "s", phase)
    return "started"


@mcp.tool
async def get_app_usage() -> dict:
    """Read where screen time went: app usage for today, this week, and this month."""
    await authorize("get_app_usage")
    token = get_access_token() if auth else None
    LOG.info("MCP read tool called: client=%s tool=%s", token.client_id if token else "loopback", "get_app_usage")
    return json.loads(await shell_call("GetAppStats"))


@mcp.tool
async def get_system_state() -> dict:
    """Read battery, network, bluetooth, and camera-in-use state."""
    return await read("get_system_state", "io.galyarderlabs.notchfolk.System1", "State")


@mcp.tool
async def get_router_stats() -> dict:
    """Read the AI gateway state: requests, tokens, estimated cost, and models."""
    return await read("get_router_stats", "io.galyarderlabs.notchfolk.Router1", "State")


@mcp.tool
async def get_usage_quota() -> dict:
    """Read how much of the user's AI plans is used, per provider."""
    return await read("get_usage_quota", "io.galyarderlabs.notchfolk.Usage1", "Usage")


@mcp.tool
async def list_shelf_items() -> list:
    """List the files kept close in Notchfolk's shelf."""
    return await read("list_shelf_items", "io.galyarderlabs.notchfolk.Shelf1", "Items")


@mcp.tool
async def add_shelf_files(uris: list[str]) -> str:
    """Add local file URIs to the shelf (at most 6 files). Requires add_shelf_files permission."""
    await write("add_shelf_files")
    await call("io.galyarderlabs.notchfolk.Shelf1", "Add", "as", uris)
    return "added"


@mcp.tool
async def remove_shelf_item(uri: str) -> str:
    """Remove one file from the shelf. Requires remove_shelf_item permission."""
    await write("remove_shelf_item")
    await call("io.galyarderlabs.notchfolk.Shelf1", "Remove", "s", uri)
    return "removed"


@mcp.tool
async def clear_shelf() -> str:
    """Empty the shelf. Requires clear_shelf permission."""
    await write("clear_shelf")
    await call("io.galyarderlabs.notchfolk.Shelf1", "Clear")
    return "cleared"


@mcp.tool
async def refresh_shelf() -> str:
    """Drop shelf items whose files no longer exist. Requires refresh_shelf permission."""
    await write("refresh_shelf")
    await call("io.galyarderlabs.notchfolk.Shelf1", "Refresh")
    return "refreshed"


@mcp.tool
async def get_latest_update() -> str:
    """Read the newer Notchfolk version, when one is out; empty otherwise."""
    return await read_text("get_latest_update", "io.galyarderlabs.notchfolk.Updates1", "Latest")


@mcp.tool
async def search_clipboard(query: str) -> list:
    """Search clipboard history; returns matching item ids, newest first."""
    await authorize("search_clipboard")
    token = get_access_token() if auth else None
    LOG.info("MCP read tool called: client=%s tool=%s", token.client_id if token else "loopback", "search_clipboard")
    return list(await shell_call("SearchClipboard", "s", query))


@mcp.tool
async def get_clipboard_text(item_id: int) -> str:
    """Read one clipboard history item's content by id. Requires clipboard:read permission."""
    await authorize("get_clipboard_text")
    token = get_access_token() if auth else None
    LOG.info("MCP read tool called: client=%s tool=%s", token.client_id if token else "loopback", "get_clipboard_text")
    return await shell_call("GetClipboardText", "t", item_id)


@mcp.tool
async def pin_clipboard(item_id: int, pinned: bool = True) -> str:
    """Pin or unpin a clipboard history item (at most 10 pinned). Requires pin_clipboard permission."""
    await write("pin_clipboard")
    await call("io.galyarderlabs.notchfolk.Clipboard1", "SetPinned", "tb", item_id, pinned)
    return "updated"


@mcp.tool
async def remove_clipboard_item(item_id: int) -> str:
    """Remove one clipboard history item. Requires remove_clipboard_item permission."""
    await write("remove_clipboard_item")
    await call("io.galyarderlabs.notchfolk.Clipboard1", "Remove", "t", item_id)
    return "removed"


async def serve():
    global bus
    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    await mcp.run_async(transport="http", host=HOST, port=PORT, path="/mcp")


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("NOTCHFOLK_MCP_LOG", "INFO"))
    asyncio.run(serve())
