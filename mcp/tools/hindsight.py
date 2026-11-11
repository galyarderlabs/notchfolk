# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The Memory domain - the Hindsight backend.

Value: the world remembers. An agent with these tools keeps what it learned across
conversations - storing it (retain), finding it back (recall), reasoning over it
(reflect) - and tends its memory: banks, mental models, directives, documents,
operations, tags.

The backend is the Hindsight engine's own MCP endpoint (reference: hindsight-api-slim
1.2.0, MIT), an HTTP MCP server the user runs and points Notchfolk at
(NOTCHFOLK_MCP_HINDSIGHT, default the local entry point's own
http://localhost:8888/mcp/). Notchfolk's tools are the engine's, verbatim - the 39
names the spec fixes - each a thin proxy: build the arguments, call the engine,
return its answer. Retain is the engine's async storage (it answers an operation_id,
not the stored memory); sync_retain blocks until stored.

The domain is offered only when the engine answers its endpoint (the spec's
availability rule); an engine that dies between calls answers as a normal, isolated
error (AC-5). The 18 read-only tools ride the default key's memory:read; the 21 that
change something sit behind memory:write, and are not even visible to a key without
it (AC-4).
"""

import json
import os
import urllib.error
import urllib.request

from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport

HINDSIGHT_URL = os.getenv("NOTCHFOLK_MCP_HINDSIGHT", "http://localhost:8888/mcp/").rstrip("/")

READ_SCOPES = {
    "recall": "memory:read", "reflect": "memory:read",
    "list_banks": "memory:read", "get_bank": "memory:read", "get_bank_stats": "memory:read",
    "list_mental_models": "memory:read", "get_mental_model": "memory:read",
    "get_knowledge_base_tree": "memory:read", "search_knowledge_base": "memory:read",
    "get_knowledge_page": "memory:read",
    "list_directives": "memory:read",
    "list_memories": "memory:read", "get_memory": "memory:read",
    "list_documents": "memory:read", "get_document": "memory:read",
    "list_operations": "memory:read", "get_operation": "memory:read",
    "list_tags": "memory:read",
}

WRITE_SCOPES = {
    "retain": "memory:write", "sync_retain": "memory:write",
    "create_bank": "memory:write", "update_bank": "memory:write", "delete_bank": "memory:write",
    "clear_memories": "memory:write",
    "create_mental_model": "memory:write", "update_mental_model": "memory:write",
    "delete_mental_model": "memory:write", "refresh_mental_model": "memory:write",
    "clear_mental_model": "memory:write",
    "create_knowledge_folder": "memory:write", "create_knowledge_page": "memory:write",
    "update_knowledge_node": "memory:write", "delete_knowledge_node": "memory:write",
    "create_directive": "memory:write", "delete_directive": "memory:write",
    "update_memory": "memory:write", "invalidate_memory": "memory:write",
    "delete_document": "memory:write", "cancel_operation": "memory:write",
}


def available() -> bool:
    """Whether the Hindsight engine answers its MCP endpoint. A GET probe without a
    session id is the reference's own health check; an HTTP answer at all - whatever
    its status - says the engine is there, only a connection error says it is not."""
    try:
        urllib.request.urlopen(f"{HINDSIGHT_URL}/", timeout=5)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


async def _call(name: str, arguments: dict) -> object:
    """One call to the engine's MCP endpoint; its answer, or its error as one."""
    async with Client(StreamableHttpTransport(HINDSIGHT_URL)) as client:
        result = await client.call_tool(name, arguments)
        if hasattr(result, "data") and result.data is not None:
            return result.data
        for block in getattr(result, "content", []):
            if hasattr(block, "text"):
                try:
                    return json.loads(block.text)
                except (ValueError, TypeError):
                    return block.text
        return None


def _args(**kwargs) -> dict:
    """The arguments the caller actually gave - the engine strips the rest anyway. A
    closure's locals() carries its cells too (the authorize and write helpers), and a
    callable is never an argument: both are dropped here."""
    return {key: value for key, value in kwargs.items()
            if value is not None and not callable(value)}


def register(mcp, authorize, write):
    """Registers the Memory domain's tools - only when the engine answers."""
    if not available():
        return

    # The core four.

    @mcp.tool
    async def recall(query: str, max_tokens: int | None = 4096, budget: str | None = "high",
                     types: list[str] | None = None, prefer_observations: bool | None = None,
                     tags: list[str] | None = None, tags_match: str | None = "any",
                     query_timestamp: str | None = None, include_chunks: bool | None = False,
                     max_chunk_tokens: int | None = 8192, include_entities: bool | None = False,
                     max_entity_tokens: int | None = 500, include_source_facts: bool | None = False,
                     max_source_facts_tokens: int | None = 4096,
                     tag_groups: list[dict] | None = None, min_scores: dict | None = None,
                     temporal_window: dict | None = None, rerank: dict | None = None) -> object:
        """Finds what the memory holds for the query, fusing four arms - semantic,
        keyword, graph and temporal - and returning what any of them surfaced."""
        await authorize("recall")
        return await _call("recall", _args(**locals()))

    @mcp.tool
    async def reflect(query: str, context: str | None = None, budget: str | None = "low",
                      max_tokens: int | None = 4096, response_schema: dict | None = None,
                      tags: list[str] | None = None, tags_match: str | None = "any",
                      apply_all_directives: bool | None = False, include_based_on: bool | None = False,
                      include_trace: bool | None = False) -> object:
        """Reasons across the memories into a synthesized answer - the deeper analysis
        to recall's fast lookup; directives apply unless scoped away."""
        await authorize("reflect")
        return await _call("reflect", _args(**locals()))

    @mcp.tool
    async def retain(content: str, context: str | None = "general", timestamp: str | None = None,
                    tags: list[str] | None = None, metadata: dict[str, str] | None = None,
                    document_id: str | None = None, strategy: str | None = None,
                    update_mode: str | None = None) -> dict:
        """Stores what the agent learned. Async on the engine's side: it answers
        {status: accepted, operation_id} - the memory lands, or list_operations tells."""
        await write("retain")
        return {"ok": True, "result": await _call("retain", _args(**locals()))}

    @mcp.tool
    async def sync_retain(content: str, context: str | None = "general", timestamp: str | None = None,
                          tags: list[str] | None = None, metadata: dict[str, str] | None = None,
                          document_id: str | None = None, strategy: str | None = None) -> dict:
        """Stores what the agent learned, blocking until it is stored:
        {status: completed, memory_ids: [...]}, the ids of what landed."""
        await write("sync_retain")
        return {"ok": True, "result": await _call("sync_retain", _args(**locals()))}

    # The banks.

    @mcp.tool
    async def list_banks() -> object:
        """The memory's banks, one per purpose."""
        await authorize("list_banks")
        return await _call("list_banks", {})

    @mcp.tool
    async def get_bank(bank_id: str) -> object:
        """One bank's own settings."""
        await authorize("get_bank")
        return await _call("get_bank", {"bank_id": bank_id})

    @mcp.tool
    async def get_bank_stats(bank_id: str) -> object:
        """One bank's numbers - how much it holds."""
        await authorize("get_bank_stats")
        return await _call("get_bank_stats", {"bank_id": bank_id})

    @mcp.tool
    async def create_bank(bank_id: str, name: str | None = None,
                          config: dict | None = None) -> dict:
        """A new bank, one purpose of memory of its own."""
        await write("create_bank")
        return {"ok": True, "result": await _call("create_bank", _args(**locals()))}

    @mcp.tool
    async def update_bank(bank_id: str, config: dict | None = None) -> dict:
        """Changes a bank's settings."""
        await write("update_bank")
        return {"ok": True, "result": await _call("update_bank", _args(bank_id=bank_id, config=config))}

    @mcp.tool
    async def delete_bank(bank_id: str) -> dict:
        """Deletes a bank and everything it holds."""
        await write("delete_bank")
        return {"ok": True, "result": await _call("delete_bank", {"bank_id": bank_id})}

    @mcp.tool
    async def clear_memories(bank_id: str) -> dict:
        """Deletes a bank's facts, keeping the bank itself."""
        await write("clear_memories")
        return {"ok": True, "result": await _call("clear_memories", {"bank_id": bank_id})}

    # The mental models.

    @mcp.tool
    async def list_mental_models(bank_id: str | None = None) -> object:
        """The bank's mental models - what the memory has distilled into beliefs."""
        await authorize("list_mental_models")
        return await _call("list_mental_models", _args(**locals()))

    @mcp.tool
    async def get_mental_model(model_id: str, bank_id: str | None = None) -> object:
        """One mental model, read whole."""
        await authorize("get_mental_model")
        return await _call("get_mental_model", _args(**locals()))

    @mcp.tool
    async def create_mental_model(name: str, content: str, bank_id: str | None = None,
                                   config: dict | None = None) -> dict:
        """A new mental model, stated in its own words."""
        await write("create_mental_model")
        return {"ok": True, "result": await _call("create_mental_model", _args(**locals()))}

    @mcp.tool
    async def update_mental_model(model_id: str, bank_id: str | None = None,
                                   changes: dict | None = None) -> dict:
        """Changes a mental model's statement."""
        await write("update_mental_model")
        return {"ok": True, "result": await _call("update_mental_model", _args(model_id=model_id, changes=changes))}

    @mcp.tool
    async def delete_mental_model(model_id: str, bank_id: str | None = None) -> dict:
        """Deletes a mental model."""
        await write("delete_mental_model")
        return {"ok": True, "result": await _call("delete_mental_model", _args(**locals()))}

    @mcp.tool
    async def refresh_mental_model(model_id: str, bank_id: str | None = None) -> dict:
        """Rebuilds a mental model from the bank's memories."""
        await write("refresh_mental_model")
        return {"ok": True, "result": await _call("refresh_mental_model", _args(**locals()))}

    @mcp.tool
    async def clear_mental_model(model_id: str, bank_id: str | None = None) -> dict:
        """Empties a mental model's statement, keeping the model."""
        await write("clear_mental_model")
        return {"ok": True, "result": await _call("clear_mental_model", _args(**locals()))}

    # The knowledge base.

    @mcp.tool
    async def get_knowledge_base_tree(bank_id: str | None = None) -> object:
        """The knowledge base's whole tree - folders and pages."""
        await authorize("get_knowledge_base_tree")
        return await _call("get_knowledge_base_tree", _args(**locals()))

    @mcp.tool
    async def search_knowledge_base(query: str, bank_id: str | None = None,
                                    limit: int | None = None) -> object:
        """Searches the knowledge base's pages."""
        await authorize("search_knowledge_base")
        return await _call("search_knowledge_base", _args(**locals()))

    @mcp.tool
    async def get_knowledge_page(page_id: str, bank_id: str | None = None) -> object:
        """One knowledge page, read whole."""
        await authorize("get_knowledge_page")
        return await _call("get_knowledge_page", _args(**locals()))

    @mcp.tool
    async def create_knowledge_folder(name: str, parent_id: str | None = "root",
                                       bank_id: str | None = None) -> dict:
        """A new folder in the knowledge base (the root parent is "root")."""
        await write("create_knowledge_folder")
        return {"ok": True, "result": await _call("create_knowledge_folder", _args(**locals()))}

    @mcp.tool
    async def create_knowledge_page(name: str, parent_id: str, content: str,
                                     bank_id: str | None = None) -> dict:
        """A new page in the knowledge base, written whole."""
        await write("create_knowledge_page")
        return {"ok": True, "result": await _call("create_knowledge_page", _args(**locals()))}

    @mcp.tool
    async def update_knowledge_node(node_id: str, bank_id: str | None = None,
                                     changes: dict | None = None) -> dict:
        """Changes a knowledge folder or page."""
        await write("update_knowledge_node")
        return {"ok": True, "result": await _call("update_knowledge_node", _args(node_id=node_id, changes=changes))}

    @mcp.tool
    async def delete_knowledge_node(node_id: str, bank_id: str | None = None) -> dict:
        """Deletes a knowledge folder or page."""
        await write("delete_knowledge_node")
        return {"ok": True, "result": await _call("delete_knowledge_node", _args(**locals()))}

    # The directives.

    @mcp.tool
    async def list_directives(bank_id: str | None = None) -> object:
        """The bank's directives - the standing instructions the memory applies."""
        await authorize("list_directives")
        return await _call("list_directives", _args(**locals()))

    @mcp.tool
    async def create_directive(content: str, bank_id: str | None = None,
                               tags: list[str] | None = None) -> dict:
        """A new directive, stated once and applied from then on."""
        await write("create_directive")
        return {"ok": True, "result": await _call("create_directive", _args(**locals()))}

    @mcp.tool
    async def delete_directive(directive_id: str, bank_id: str | None = None) -> dict:
        """Deletes a directive."""
        await write("delete_directive")
        return {"ok": True, "result": await _call("delete_directive", _args(**locals()))}

    # The memories themselves.

    @mcp.tool
    async def list_memories(bank_id: str | None = None, limit: int | None = None,
                            offset: int | None = None, tags: list[str] | None = None) -> object:
        """The bank's memories, page by page."""
        await authorize("list_memories")
        return await _call("list_memories", _args(**locals()))

    @mcp.tool
    async def get_memory(memory_id: str, bank_id: str | None = None) -> object:
        """One memory, read whole."""
        await authorize("get_memory")
        return await _call("get_memory", _args(**locals()))

    @mcp.tool
    async def update_memory(memory_id: str, content: str, bank_id: str | None = None,
                             options: dict | None = None) -> dict:
        """Rewrites a memory (resolve-entities semantics on the engine's side)."""
        await write("update_memory")
        return {"ok": True, "result": await _call("update_memory", _args(memory_id=memory_id, content=content, options=options))}

    @mcp.tool
    async def invalidate_memory(memory_id: str, bank_id: str | None = None) -> dict:
        """Marks a memory wrong or out of date, without deleting it."""
        await write("invalidate_memory")
        return {"ok": True, "result": await _call("invalidate_memory", _args(**locals()))}

    # The documents.

    @mcp.tool
    async def list_documents(bank_id: str | None = None) -> object:
        """The bank's documents - the sources the memories came from."""
        await authorize("list_documents")
        return await _call("list_documents", _args(**locals()))

    @mcp.tool
    async def get_document(document_id: str, bank_id: str | None = None) -> object:
        """One document, read whole (attachment filenames dropped on the engine's side)."""
        await authorize("get_document")
        return await _call("get_document", _args(**locals()))

    @mcp.tool
    async def delete_document(document_id: str, bank_id: str | None = None) -> dict:
        """Deletes a document."""
        await write("delete_document")
        return {"ok": True, "result": await _call("delete_document", _args(**locals()))}

    # The operations - what the engine is doing.

    @mcp.tool
    async def list_operations(bank_id: str | None = None, status: str | None = None) -> object:
        """The engine's operations - retain's async work among them."""
        await authorize("list_operations")
        return await _call("list_operations", _args(**locals()))

    @mcp.tool
    async def get_operation(operation_id: str, bank_id: str | None = None) -> object:
        """One operation, read whole - retain's answer, later."""
        await authorize("get_operation")
        return await _call("get_operation", _args(**locals()))

    @mcp.tool
    async def cancel_operation(operation_id: str, bank_id: str | None = None) -> dict:
        """Cancels a running operation."""
        await write("cancel_operation")
        return {"ok": True, "result": await _call("cancel_operation", _args(**locals()))}

    # The tags.

    @mcp.tool
    async def list_tags(bank_id: str | None = None) -> object:
        """The bank's tags, one per way of cutting the memory."""
        await authorize("list_tags")
        return await _call("list_tags", _args(**locals()))
