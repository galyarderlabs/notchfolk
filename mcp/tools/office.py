# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The Office domain - the world makes documents.

The backend is the OfficeCLI binary (upstream: iOfficeAI/OfficeCLI; a self-contained
document server, no Office install): Notchfolk spawns its `mcp` subcommand over stdio
and proxies it, the subprocess kept warm across calls. The domain exposes exactly one
tool, office_create_document, behind office:write - the spec's closed design: no shell,
no system access, paths under the user's home or /tmp.

The domain is offered only when the binary answers (the spec's availability rule).
"""

import asyncio
import json
import os
import shutil
from pathlib import Path

from fastmcp import Client
from fastmcp.client.transports import StdioTransport

OFFICE_BIN = os.getenv("NOTCHFOLK_MCP_OFFICE",
                       str(Path.home() / ".local/bin/officecli"))

READ_SCOPES = {}
WRITE_SCOPES = {"office_create_document": "office:write"}

# The reference's own instructions, carried to the proxied tool: the workflow, and the
# boundary of what the tool is for.
INSTRUCTIONS = (
    "Create, read and modify .docx/.xlsx/.pptx documents via officecli. "
    "Paths must be under the user's home directory or /tmp. "
    "Workflow: view outline/stats first, then get/query, then set/add/remove, "
    "then validate and view issues, then save. For 3 or more mutations use batch. "
    "Always end with save."
)


def available() -> bool:
    """Whether the OfficeCLI binary answers - the spec's availability rule."""
    return Path(OFFICE_BIN).is_file() or bool(shutil.which("officecli"))


def _binary() -> str:
    return OFFICE_BIN if Path(OFFICE_BIN).is_file() else shutil.which("officecli")


_CLIENT: Client | None = None
_STARTING: asyncio.Lock | None = None


async def _client() -> Client:
    """The warm proxy: one subprocess, kept alive across calls. The lock holds the
    first start whole - a concurrent call cannot see a client half-entered."""
    global _CLIENT, _STARTING
    if _CLIENT is None:
        if _STARTING is None:
            _STARTING = asyncio.Lock()
        async with _STARTING:
            if _CLIENT is None:
                _CLIENT = Client(StdioTransport(_binary(), ["mcp"], keep_alive=True))
                await _CLIENT.__aenter__()
    return _CLIENT


def register(mcp, authorize, write):
    """Registers the Office domain's one tool - only when the binary answers."""
    if not available():
        return

    @mcp.tool
    async def office_create_document(instructions: str) -> dict:
        """Makes documents - .docx, .xlsx, .pptx - through the resident OfficeCLI server.
        No shell, no system access: paths under the user's home or /tmp."""
        await write("office_create_document")
        try:
            client = await _client()
            result = await client.call_tool("officecli",
                                            {"instructions": INSTRUCTIONS + " " + instructions})
        except Exception as err:
            # A backend that dies between calls answers as a normal, isolated error (AC-5).
            return {"ok": False, "error": f"officecli is unreachable: {err}"}
        # A failed operation is a failure, not a silent success: the reference's own
        # exit codes (1: file_exists, file_locked) arrive as the tool's error.
        if getattr(result, "is_error", False):
            for block in getattr(result, "content", []):
                if hasattr(block, "text"):
                    return {"ok": False, "error": block.text}
            return {"ok": False, "error": "officecli failed"}
        for block in getattr(result, "content", []):
            if hasattr(block, "text"):
                try:
                    return {"ok": True, "result": json.loads(block.text)}
                except (ValueError, TypeError):
                    return {"ok": True, "result": block.text}
        return {"ok": True, "result": result.data if hasattr(result, "data") else str(result)}
