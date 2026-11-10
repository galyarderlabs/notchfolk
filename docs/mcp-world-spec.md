# Notchfolk MCP tools — a little world in your notch

Status: **approved by Galih 10 Nov 2026 — implementation may start**. This document replaces both previous specs in full.

This is a list of Notchfolk's own MCP tools, named by value: what each part of the little world is for, which tools carry that value, what each tool does, and who may call it by default. The tools are Notchfolk's. They are modelled on the MCPs already in use — the system tools follow the VPS MCP, the browser tools follow the browser MCP — but they belong to Notchfolk's MCP, on the machine where Notchfolk runs.

## How access is classified

Every tool in this document carries one of two classifications.

- **Read-only — allow by default.** The tool only reads or observes. It changes nothing: no writes, no execution, no deletion, no state change.
- **Restricted — explicit scope required.** The tool writes, executes, deletes, or changes state in any way. A client may call it only when its key carries the scope for it.

Enforcement follows Notchfolk's existing key model: per-client scoped keys, where the default key is read-only. A restricted tool is not visible as callable to a client whose key does not carry its scope.

## Who uses these tools

These tools are used by agents outside the notch that connect to Notchfolk's MCP, and they can also be used by an agent inside the notch: add Notchfolk's MCP to that AI runtime's own MCP config — Claude Code via `--mcp-config`, Codex via `[mcp_servers]` in `config.toml`, OpenCode via its MCP config. Agy's mechanism is not verified, so nothing is claimed about it here.

The current sandbox — OpenCode configured with an empty MCP set, Claude with `--strict-mcp-config` — is daemon policy against untrusted MCP servers, not a technical limit. Notchfolk's own MCP is first-party and trusted.

## 1. System MCP

Value: the world can maintain and repair the ground it stands on — its own machine.

These tools mirror the tools of the VPS MCP already in use, applied to the machine Notchfolk runs on. The toolchain does not hardcode a single package manager: any tool that needs one reads `/etc/os-release` (fields `ID` and `ID_LIKE`) to detect the distro in use, then uses the matching package manager — big distros only: Arch → `pacman`, Debian/Ubuntu → `apt`, Fedora/RHEL → `dnf`, openSUSE → `zypper`. AUR helpers (`yay`/`paru`) apply only on the Arch family, and which one is installed is detected at runtime. Flatpak is distro-agnostic, for store apps. An unknown distro is reported as unsupported — the tool does not guess a package manager. CachyOS is an example target (`ID_LIKE=arch` → `pacman`), not the only distro supported.

Bun is included — the toolchain covers the package managers commonly used to install or update things (uv, npm, bun), plus the detected distro package manager and local update/upgrade scripts.

A toolchain domain is offered only when its binary is present on the machine; when it is not present, that domain is reported as unavailable, not as an error.

| Tool | What it does | Access |
|---|---|---|
| `system_stats` | Reports CPU, memory, disk, and load | Read-only |
| `system_logs` | Reads system and service logs | Read-only |
| `system_list_files` | Lists files in a directory | Read-only |
| `system_read_file` | Reads a file's contents | Read-only |
| `system_search_files` | Searches files by name or content | Read-only |
| `system_toolchain_status` | Checks installed toolchains and versions | Read-only |
| `system_list_processes` | Lists running processes | Read-only |
| `system_exec` | Runs a shell command | Restricted |
| `system_write_file` | Writes or creates a file | Restricted |
| `system_patch_file` | Applies an edit to an existing file | Restricted |
| `system_file_ops` | Moves, copies, deletes, creates directories, changes permissions | Restricted |
| `system_service` | Starts, stops, or restarts a systemd service | Restricted |
| `system_kill_process` | Terminates a running process | Restricted |
| `system_update` | Updates the system or a toolchain — distro package manager (detected per the rule above, with AUR helper on the Arch family), flatpak, uv, npm, bun, and local update/upgrade scripts; requires confirmation | Restricted |

## 2. Browser MCP

Value: the world can see and use the web through a real browser, driven over plain REST HTTP to the Camoufox server (localhost:9377 by the package's own default). The REST server drives the browser through Playwright: it launches Camoufox (anti-detection Firefox) via Playwright's `firefox.launch` with camoufox-js options. (Verified from the REST server's launch code and its cookie handling, which uses Playwright's `context.addCookies()`.)

| Tool | What it does | Access |
|---|---|---|
| `browser_navigate` | Opens a URL in the browser | Read-only |
| `browser_snapshot` | Returns the current page structure and text | Read-only |
| `browser_screenshot` | Captures the current page as an image | Read-only |
| `browser_scroll` | Scrolls the current page | Read-only |
| `browser_list_tabs` | Lists open tabs | Read-only |
| `browser_click` | Clicks an element on the page | Restricted |
| `browser_type` | Types text into the page | Restricted |
| `browser_evaluate` | Runs JavaScript in the page | Restricted |
| `browser_create_tab` | Opens a new tab | Restricted |
| `browser_close_tab` | Closes a tab | Restricted |

## 3. Office MCP

Value: the world can make documents.

| Tool | What it does | Access |
|---|---|---|
| `office_create_document` | Creates a report or document, written to the laptop | Restricted |

The Office MCP has one tool. It has no shell and no access to the system.

## 4. Skills

Value: the world knows how to do things.

All seven tools are read-only and allowed by default.

| Tool | What it does | Access |
|---|---|---|
| `skills_list` | Lists the skills catalogue | Read-only |
| `skills_search` | Searches skills by name or topic | Read-only |
| `skills_get` | Gets one skill's full definition | Read-only |
| `skills_list_files` | Lists the files inside a skill | Read-only |
| `skills_read_file` | Reads one file inside a skill | Read-only |
| `skills_stats` | Reports catalogue size and coverage | Read-only |
| `skills_refresh` | Refreshes the catalogue index view | Read-only |

## 5. Memory

Value: the world remembers.

Memory is one value with one backend rule: Hindsight is the implementation when it is available; when it is not, Obsidian is enough. Obsidian also carries a second value of its own — notes, the writing the user keeps.

### 5.1 Hindsight backend

Read-only tools, allowed by default: `recall`, `reflect`, `list_banks`, `get_bank`, `get_bank_stats`, `list_mental_models`, `get_mental_model`, `list_directives`, `list_memories`, `get_memory`, `list_documents`, `get_document`, `list_operations`, `get_operation`, `list_tags`, `get_knowledge_base_tree`, `search_knowledge_base`, `get_knowledge_page`.

Restricted tools, explicit scope required: `retain`, `sync_retain`, `create_bank`, `update_bank`, `delete_bank`, `create_mental_model`, `update_mental_model`, `delete_mental_model`, `refresh_mental_model`, `clear_mental_model`, `create_directive`, `delete_directive`, `update_memory`, `invalidate_memory`, `clear_memories`, `delete_document`, `cancel_operation`, `create_knowledge_page`, `create_knowledge_folder`, `update_knowledge_node`, `delete_knowledge_node`.

### 5.2 Obsidian backend — memory fallback and notes

Read-only tools, allowed by default: `obsidian_overview`, `obsidian_guide`, `obsidian_sync_status`, `obsidian_search`, `obsidian_list`, `obsidian_read`, `obsidian_recent`, `obsidian_backlinks`, `obsidian_templates_list`, `obsidian_template_read`.

Restricted tools, explicit scope required: `obsidian_create_note`, `obsidian_update_note`, `obsidian_patch_note`, `obsidian_move_note`.

## 6. Composio

Value: the world reaches your accounts — mail and drive.

Conditional: this value is present only when the machine has the Composio CLI. Authentication follows Composio's OAuth, not a bearer token in the keyring. Install, login, link, search, and execute shapes — and the fact that the CLI has no `mcp` subcommand, so Notchfolk invokes it as a subprocess — are in [mcp-world-apis.md](mcp-world-apis.md) §6.

Read-only: `composio_search_mail`, `composio_read_mail`, `composio_search_drive`, `composio_read_drive_file`.
Restricted: `composio_send_mail`, `composio_delete_mail`, `composio_share_drive_file`, `composio_write_drive_file`.

## 7. Software like ArtCraft

Value: the world can make visual things, through creative software.

Conditional: this value is present only when needed. Its tool list is **TBD** — it will be defined when a specific application is named, from what that application actually exposes. No tools are defined in this document for it.

## Tool mapping, acceptance criteria, and integration

Exact API details are recorded in [mcp-world-apis.md](mcp-world-apis.md), from a first-hand reading of the source MCP code (Phase 0, complete 10 Nov 2026). Nothing there is invented; where a value comes from the reference deployment rather than from the code, it is marked reference and is not a product default.

Acceptance criteria used for every tool:

- **AC-1 Listed:** the tool is registered at the endpoint and appears in `tools/list` for a key that carries its scope.
- **AC-2 Correct:** the tool returns the correct result for a known input.
- **AC-3 Read-only access:** a read-only tool runs on the default read-only key.
- **AC-4 Restricted access:** a restricted tool is not visible / is rejected on a read-only key.
- **AC-5 Isolated failure:** if its backend is down, the failure is isolated — local tools are unaffected, the error is a normal error, and no secret leaks.

Read-only tools must meet AC-1, AC-2, AC-3, and AC-5. Restricted tools must meet AC-1, AC-2, AC-4, and AC-5.

Integration backends (all local, on the user's own machine): system tools — local subprocess / systemd / filesystem in `server.py`, following the reference implementation's logic; browser tools — REST HTTP to the Camoufox server on localhost (package default port 9377, from the user's own config); office — spawn the `officecli` binary's `mcp` subcommand over stdio; skills — read the skill trees on the machine directly; Hindsight — the Hindsight engine's MCP endpoint on localhost, at the address the user configured; Obsidian — the vault on the machine, at the path the user configured; Composio — invoke the Composio CLI on the machine, only when the machine has it (the one cloud-touching value).

## Out of scope

- **NotebookLM** — out.
- **Multica** — out.
- **REA** — out.
- **A2A** — out. A2A is Galih's personal MCP; it stays his, not part of Notchfolk.

## Is it enough?

The essence of "a little world in your notch" is a whole digital life made small: little is the size, not the scope. Every part of the essence has a value carrying it: the place — the 55 tools Notchfolk already has; the ground — System MCP; the window to the web — Browser MCP; making things — Office MCP and software like ArtCraft when needed; knowing how — Skills; remembering — Memory; reaching outward — Composio. The value set is enough, on Galih's verdict.

## Distribution

Each machine configures its own tools: which values are present, which backends they use, and which scopes its keys carry are that machine's own configuration. Nothing from Galih's fleet or configuration is bundled for other users.
