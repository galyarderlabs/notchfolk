# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The world domains of Notchfolk's MCP: the values around the notch.

Each domain module registers its tools on the shared FastMCP instance and
declares its scopes; a domain whose backend is absent is not offered at all
(the spec's availability rule). The internal data tools stay in server.py.
"""

from . import browser, composio, hindsight, office, obsidian, skills, system

DOMAINS = [browser, composio, hindsight, office, obsidian, skills, system]


def register(mcp, authorize, write):
    """Registers every present domain's tools; absent backends stay unoffered."""
    for domain in DOMAINS:
        domain.register(mcp, authorize, write)


def scopes():
    """Every domain's scope maps, merged: {tool: scope} for read and for write."""
    read, written = {}, {}
    for domain in DOMAINS:
        read.update(domain.READ_SCOPES)
        written.update(domain.WRITE_SCOPES)
    return read, written
