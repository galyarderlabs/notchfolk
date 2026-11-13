# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The Composio domain - the world reaches your accounts: mail and drive.

The backend is the Composio CLI on the machine (installed by its one-line installer;
`~/.local/bin/composio`, the real binary `~/.composio/composio`): Notchfolk shells out to
it as a subprocess and reads the JSON from stdout - it does not speak MCP to Composio
(the CLI has no mcp subcommand) and does not use the hosted endpoint. The CLI is the
only process that leaves the machine; the boundary is explicit, and this is the one
cloud-touching value in the whole world set.

Authentication is Composio's own OAuth (`composio login` once, `composio link <toolkit>`
per account) - never a bearer token in the keyring; Notchfolk never sees the grants.

Slugs are not hardcoded: the available tools depend on which toolkits the user linked.
Each operation resolves its slug at runtime through `composio search "<use case>"
--toolkits <toolkit>` and caches it in the machine's own config. A call with no linked
account fails at the CLI's own connection check, with the CLI telling the user what
to fix (`composio link <toolkit>`).

The four read-only tools (search and read mail, search and read drive) ride the default
key's composio:read; the four that change something (send and delete mail, share and
write drive) sit behind composio:write. The domain is offered only when the CLI is on
the machine (the spec's availability rule); a CLI that dies between calls answers as
a normal, isolated error (AC-5).
"""

import json
import os
import shutil
import subprocess

COMPOSIO = os.getenv("NOTCHFOLK_MCP_COMPOSIO", "composio")
TIMEOUT = 30
SLUG_CACHE: dict[str, str] = {}

READ_SCOPES = {
    "composio_search_mail": "composio:read", "composio_read_mail": "composio:read",
    "composio_search_drive": "composio:read", "composio_read_drive_file": "composio:read",
}

WRITE_SCOPES = {
    "composio_send_mail": "composio:write", "composio_delete_mail": "composio:write",
    "composio_share_drive_file": "composio:write", "composio_write_drive_file": "composio:write",
}


def available() -> bool:
    """Whether the Composio CLI is on the machine - the spec's availability rule."""
    return bool(shutil.which(COMPOSIO))


def _ok(**fields) -> dict:
    return {"ok": True, **fields}


def _fail(message: str, **fields) -> dict:
    return {"ok": False, "error": message, **fields}


def _run(*args: str) -> dict:
    """One CLI call; its JSON from stdout, or its error as one isolated answer."""
    try:
        finished = subprocess.run([COMPOSIO, *args], capture_output=True, text=True,
                                  timeout=TIMEOUT)
    except (subprocess.SubprocessError, OSError) as err:
        return _fail(f"composio is unreachable: {err}")
    if finished.returncode != 0:
        detail = (finished.stderr or finished.stdout or "").strip()
        return _fail(detail or f"composio exited {finished.returncode}")
    return _ok(stdout=finished.stdout.strip())


def _slug(use_case: str, toolkit: str) -> str | dict:
    """The slug for a use case, resolved at runtime and cached - the available tools
    depend on which toolkits the user linked, so nothing is hardcoded."""
    cached = SLUG_CACHE.get(use_case)
    if cached:
        return cached
    answer = _run("search", use_case, "--toolkits", toolkit, "--limit", "1")
    if not answer["ok"]:
        return answer
    try:
        found = json.loads(answer["stdout"])
        slug = found[0]["slug"] if isinstance(found, list) else found.get("slug", "")
    except (ValueError, TypeError, IndexError, KeyError):
        return _fail(f"no tool found for {use_case!r} in {toolkit} - link the toolkit first "
                     f"(composio link {toolkit})")
    if not slug:
        return _fail(f"no tool found for {use_case!r} in {toolkit} - link the toolkit first "
                     f"(composio link {toolkit})")
    SLUG_CACHE[use_case] = slug
    return slug


def _execute(use_case: str, toolkit: str, data: dict, account: str | None = None) -> dict:
    """One operation: resolve the slug, run it, return the answer."""
    slug = _slug(use_case, toolkit)
    if isinstance(slug, dict):
        return slug
    args = ["execute", slug, "-d", json.dumps(data)]
    if account:
        args += ["--account", account]
    answer = _run(*args)
    if not answer["ok"]:
        return answer
    try:
        return _ok(result=json.loads(answer["stdout"]))
    except (ValueError, TypeError):
        return _ok(result=answer["stdout"])


def register(mcp, authorize, write):
    """Registers the Composio domain's tools - only when the CLI is on the machine."""
    if not available():
        return

    @mcp.tool
    async def composio_search_mail(query: str, account: str | None = None) -> dict:
        """Searches the mail for messages matching the query."""
        await authorize("composio_search_mail")
        return _execute("search mail", "gmail", {"query": query}, account)

    @mcp.tool
    async def composio_read_mail(message_id: str, account: str | None = None) -> dict:
        """Reads one mail message whole."""
        await authorize("composio_read_mail")
        return _execute("read mail message", "gmail", {"message_id": message_id}, account)

    @mcp.tool
    async def composio_search_drive(query: str, account: str | None = None) -> dict:
        """Searches the drive for files matching the query."""
        await authorize("composio_search_drive")
        return _execute("search drive files", "google_drive", {"query": query}, account)

    @mcp.tool
    async def composio_read_drive_file(file_id: str, account: str | None = None) -> dict:
        """Reads one drive file's content or metadata."""
        await authorize("composio_read_drive_file")
        return _execute("read drive file", "google_drive", {"file_id": file_id}, account)

    @mcp.tool
    async def composio_send_mail(recipient: str, subject: str, body: str,
                                 account: str | None = None) -> dict:
        """Sends an email."""
        await write("composio_send_mail")
        return _execute("send an email", "gmail",
                        {"recipient_email": recipient, "subject": subject, "body": body}, account)

    @mcp.tool
    async def composio_delete_mail(message_id: str, account: str | None = None) -> dict:
        """Deletes a mail message."""
        await write("composio_delete_mail")
        return _execute("delete mail message", "gmail", {"message_id": message_id}, account)

    @mcp.tool
    async def composio_share_drive_file(file_id: str, recipient: str,
                                         account: str | None = None) -> dict:
        """Shares a drive file with someone."""
        await write("composio_share_drive_file")
        return _execute("share drive file", "google_drive",
                        {"file_id": file_id, "recipient": recipient}, account)

    @mcp.tool
    async def composio_write_drive_file(file_id: str, content: str,
                                        account: str | None = None) -> dict:
        """Writes a drive file's content."""
        await write("composio_write_drive_file")
        return _execute("write drive file", "google_drive",
                        {"file_id": file_id, "content": content}, account)
