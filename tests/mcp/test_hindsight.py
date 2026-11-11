# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""Proves the Memory domain's Hindsight backend against the engine's own shape:
a mock Hindsight - a real FastMCP HTTP server exposing the 39 tool names - answers,
and Notchfolk's proxies must carry the calls through: the availability rule (no
engine, no domain), the scope split (18 read-only on the default key, 21 restricted
invisible without memory:write), and the answers passing back.

Run from the repo root:  python3 tests/mcp/test_hindsight.py
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

THE_39 = ["recall", "reflect", "retain", "sync_retain", "list_banks", "get_bank",
          "get_bank_stats", "create_bank", "update_bank", "delete_bank", "clear_memories",
          "list_mental_models", "get_mental_model", "create_mental_model", "update_mental_model",
          "delete_mental_model", "refresh_mental_model", "clear_mental_model",
          "get_knowledge_base_tree", "search_knowledge_base", "get_knowledge_page",
          "create_knowledge_folder", "create_knowledge_page", "update_knowledge_node",
          "delete_knowledge_node", "list_directives", "create_directive", "delete_directive",
          "list_memories", "get_memory", "update_memory", "invalidate_memory",
          "list_documents", "get_document", "delete_document", "list_operations",
          "get_operation", "cancel_operation", "list_tags"]
READ_ONLY = {"recall", "reflect", "list_banks", "get_bank", "get_bank_stats", "list_mental_models",
             "get_mental_model", "get_knowledge_base_tree", "search_knowledge_base",
             "get_knowledge_page", "list_directives", "list_memories", "get_memory",
             "list_documents", "get_document", "list_operations", "get_operation", "list_tags"}

CALLED = []


# The union of every argument the proxies can send (their defaults ride along), so a
# stub that accepts them all is a stub that accepts whatever the proxies build.
STUB_PARAMS = ["query: str | None = None", "max_tokens: int | None = None", "budget: str | None = None",
    "types: list[str] | None = None", "prefer_observations: bool | None = None", "tags: list[str] | None = None",
    "tags_match: str | None = None", "query_timestamp: str | None = None", "include_chunks: bool | None = None",
    "max_chunk_tokens: int | None = None", "include_entities: bool | None = None",
    "max_entity_tokens: int | None = None", "include_source_facts: bool | None = None",
    "max_source_facts_tokens: int | None = None", "tag_groups: list[dict] | None = None",
    "min_scores: dict | None = None", "temporal_window: dict | None = None", "rerank: dict | None = None",
    "context: str | None = None", "response_schema: dict | None = None", "apply_all_directives: bool | None = None",
    "include_based_on: bool | None = None", "include_trace: bool | None = None", "content: str | None = None",
    "timestamp: str | None = None", "metadata: dict[str, str] | None = None", "document_id: str | None = None",
    "strategy: str | None = None", "update_mode: str | None = None", "bank_id: str | None = None",
    "name: str | None = None", "config: dict | None = None", "model_id: str | None = None",
    "changes: dict | None = None", "parent_id: str | None = None", "node_id: str | None = None",
    "page_id: str | None = None", "directive_id: str | None = None", "memory_id: str | None = None",
    "options: dict | None = None", "limit: int | None = None", "offset: int | None = None",
    "status: str | None = None", "operation_id: str | None = None"]


def build_engine():
    """The mock Hindsight: 39 stub tools, each answering what it was called with."""
    engine = FastMCP(name="hindsight")
    for tool_name in THE_39:
        # The engine's own name rides in the namespace, not a parameter - several tools
        # take a `name` argument of their own, and a parameter would shadow it.
        namespace = {"CALLED": CALLED, "engine_name": tool_name}
        exec("async def stub(" + ", ".join(STUB_PARAMS) + "):\n"
             "    given = dict(locals())\n"
             "    arguments = {key: value for key, value in given.items() if value is not None}\n"
             "    CALLED.append((engine_name, arguments))\n"
             "    return {'engine': engine_name, 'arguments': arguments}", namespace)
        engine.tool(namespace["stub"], name=tool_name)
    return engine


def clients_file():
    clients = {"reader": {"token": READER_TOKEN, "scopes": ["*:read"]},
               "admin": {"token": ADMIN_TOKEN, "scopes": ["*:read", "memory:write"]}}
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
    os.environ["NOTCHFOLK_MCP_HINDSIGHT"] = f"http://localhost:{free_port()}/mcp/"  # nothing there yet

    import importlib
    import tools.hindsight as hindsight
    importlib.reload(hindsight)
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

    # The availability rule: no engine answering, the domain is not offered.
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        check("AC-5 no Hindsight: the domain is not offered", "recall" not in listed)

    # Now the mock engine, on its own port.
    engine = build_engine()
    engine_port = free_port()

    def serve_engine():
        asyncio.run(engine.run_async(transport="http", host="127.0.0.1", port=engine_port))

    threading.Thread(target=serve_engine, daemon=True).start()
    for _ in range(100):
        with contextlib.suppress(Exception):
            urlrequest.urlopen(f"http://127.0.0.1:{engine_port}/", timeout=1)
            break
        await asyncio.sleep(0.1)

    os.environ["NOTCHFOLK_MCP_HINDSIGHT"] = f"http://localhost:{engine_port}/mcp/"
    importlib.reload(hindsight)
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

    CALLED.clear()
    async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as admin:
        listed = {tool.name for tool in await admin.list_tools()}
        check("AC-1 the 39 are offered", set(THE_39) <= listed, f"{len(set(THE_39) & listed)}/39")
    async with Client(transport(), auth=BearerAuth(READER_TOKEN)) as reader:
        listed = {tool.name for tool in await reader.list_tools()}
        offered = listed & set(THE_39)
        check("AC-4 reader sees only the 18 read-only", offered == READ_ONLY,
              f"extra: {sorted(offered - READ_ONLY)[:3]}")
        recall = await reader.call_tool("recall", {"query": "what did I learn about rust"})
        recall = recall.data if hasattr(recall, "data") else recall
        check("AC-2/3 recall carries through", recall["engine"] == "recall"
              and recall["arguments"]["query"] == "what did I learn about rust", str(recall))
        banks = await reader.call_tool("list_banks", {})
        banks = banks.data if hasattr(banks, "data") else banks
        check("AC-2/3 list_banks", banks["engine"] == "list_banks")

    async with Client(transport(), auth=BearerAuth(ADMIN_TOKEN)) as admin:
        listed = {tool.name for tool in await admin.list_tools()}
        check("AC-4 admin sees all 39", set(THE_39) <= listed, f"{len(set(THE_39) & listed)}/39")
        stored = await admin.call_tool("sync_retain", {"content": "Galih prefers the quiet compact"})
        stored = stored.data if hasattr(stored, "data") else stored
        check("AC-2/3 sync_retain carries through",
              stored["result"]["engine"] == "sync_retain"
              and stored["result"]["arguments"]["content"] == "Galih prefers the quiet compact", str(stored))
        cancelled = await admin.call_tool("cancel_operation", {"operation_id": "op-1"})
        check("AC-2/3 cancel_operation", any(name == "cancel_operation" for name, _ in CALLED))
        tags = await admin.call_tool("list_tags", {})
        check("AC-2/3 list_tags", any(name == "list_tags" for name, _ in CALLED))

    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
