# Notchfolk MCP — a little world in your notch: Work

This tracks the target in [mcp-world-plan.md](mcp-world-plan.md), defined by
[mcp-world-spec.md](mcp-world-spec.md). Each phase ends in something a user
can see; nothing in a later phase starts before the phase before it is
verified on a live desktop. The acceptance criteria (AC-1…AC-5) are the
spec's; every task names the ones it must prove.

## Ordered work

### 0. Read the source MCPs on the VPS — the agreed step before implementation

- [x] `docs/mcp-world-apis.md` created, one section per domain, each naming
  the source MCP it was read from. A domain's section is the gate for that
  domain's implementation: nothing below starts for a domain whose section
  does not exist yet. **Done 10 Nov 2026 — Phase 0 complete.**
- [x] niyatna-mcp read: the 14 system tools' argument shapes, the
  `system_update` confirmation mechanism (one-shot `confirm` argument +
  check first — copied, not invented), the distro-detection rule as
  implemented, and the log-reading approach. Recorded in
  `mcp-world-apis.md` §1.
- [x] browser-mcp / Camoufox read: the REST routes and payloads for all 10
  tools, and the answer recorded — **Playwright** behind the REST server
  (Camoufox via `firefox.launch`). The MCP-layer contract is complete;
  `server.js` internals were not read line by line (third-party driver
  internals — see the boundary note in `mcp-world-apis.md`). Recorded in
  `mcp-world-apis.md` §2.
- [x] office-mcp read: the office service's call shape for
  `office_create_document` (stdio proxy to `officecli mcp`, `batch` idiom,
  resident model, install command). Recorded in `mcp-world-apis.md` §3.
- [x] skills-mcp read: the catalogue's shape — what a skill, a file and the
  index view look like for the 7 tools. Recorded in `mcp-world-apis.md` §4.
- [x] hindsight-mcp read: the API's endpoints and payloads for the 39 tools,
  the operation model behind `list_operations` / `cancel_operation`, and the
  bank / mental model / knowledge-base shapes. Recorded in
  `mcp-world-apis.md` §5.1. (Open: laptop runs its own engine vs a hosted
  endpoint — undecided, recorded in the apis doc, not chosen here.)
- [x] obsidian-mcp read: the vault access shape for the 14 tools, and how
  sync status is reported. Recorded in `mcp-world-apis.md` §5.2.
- [x] composio read: the CLI's invocation shapes for the 8 tools, and its
  OAuth flow (never a bearer token in the keyring). Install, login, link,
  search, execute — all from the CLI's own `--help` (0.4.0); the CLI has no
  `mcp` subcommand, so Notchfolk invokes it as a subprocess. Recorded in
  `mcp-world-apis.md` §6.

### 1. Ground: the domain framework

- [ ] The `mcp/tools/` package with its registry: a domain module registers
  its tools on the shared FastMCP instance, and probes its backend
  (binaries on `PATH`, a port answering, a vault path) at startup and on
  demand. A domain whose backend is absent is not offered (the spec's
  availability rule).
- [ ] Scope maps extended per the plan's naming (`system:*`, `browser:*`,
  `office:write`, `skills:read`, `memory:*`, `notes:*`, `composio:*`), the
  spec's tables deciding which tools are read-only and which restricted.
  **AC-1.**
- [ ] `tools/list` filtered by the caller's token: a restricted tool is not
  visible to a key without its scope — the spec's AC-4, and the one real
  change to the existing machinery. Verified against a real read-only key
  and a real scoped key. **AC-3, AC-4.**
- [ ] The existing 55 tools behave exactly as before: the same list for the
  same keys, the same call results, the same OAuth scopes. Proven by
  running the daemon and a client before and after.
- [ ] A backend-down domain answers as a normal, isolated error — local tools
  unaffected, no secret in the message. **AC-5.**
- [ ] Settings picks the browser backend: a row offering Camoufox or CDP
  (with the debug port to fill in), written to the same mcp.env the
  service reads - the same way Settings already writes mcp-clients.json.
  The CDP choice carries its security note: an open debug port is
  reachable by any local process, and Chrome 136+ keeps the port away
  from the default profile.
- [ ] Settings keeps its UX short while the scopes grow. The key builder
  separates the two halves: **Notchfolk** — the internal data tools, the
  existing "Read access" / "Write actions" expanders as they are — and
  **The world** — one row per domain (System, Browser, Office, Skills,
  Memory, Notes, Composio), only the domains present on the machine
  offered. A domain row is one toggle: on grants that domain's read-only
  scope; its write scope is a second switch inside the row's expander,
  off by default — one line per domain, the read-only/restricted rule
  intact. A key made in Settings with a domain on authorises exactly
  that domain's tools — verified against the server, not just the file.

### 2. System MCP — the ground it stands on

- [ ] Distro detection: read `/etc/os-release` (`ID`, `ID_LIKE`); Arch →
  `pacman`, Debian/Ubuntu → `apt`, Fedora/RHEL → `dnf`, openSUSE → `zypper`;
  AUR helper (`yay`/`paru`) detected at runtime on the Arch family only;
  unknown → reported unsupported, never guessed.
- [ ] Read-only tools: `system_stats`, `system_logs`, `system_list_files`,
  `system_read_file`, `system_search_files`, `system_toolchain_status`,
  `system_list_processes`. Correct results for known inputs, running on the
  default read-only key. **AC-1, AC-2, AC-3, AC-5.**
- [ ] `system_toolchain_status` reports a domain as unavailable when its
  binary is absent — uv, npm, bun among them — not as an error.
- [ ] Restricted tools: `system_exec`, `system_write_file`,
  `system_patch_file`, `system_file_ops`, `system_service`,
  `system_kill_process`. Not visible on a read-only key; correct on a
  scoped key. **AC-1, AC-2, AC-4, AC-5.**
- [ ] `system_update` with the confirmation mechanism copied from
  niyatna-mcp (Phase 0): the detected distro package manager with AUR
  helper on the Arch family, flatpak, uv, npm, bun, and local update /
  upgrade scripts; requires confirmation. **AC-1, AC-2, AC-4, AC-5.**
- [ ] Verified on a live desktop: the read-only set on the default key, the
  restricted set on a scoped key, and an unknown distro reported
  unsupported.

### 3. Browser MCP — the window to the web

- [ ] The Camoufox REST client (localhost:9377), from the routes and
  payloads recorded in Phase 0.
- [ ] Read-only tools: `browser_navigate`, `browser_snapshot`,
  `browser_screenshot`, `browser_scroll`, `browser_list_tabs`. **AC-1,
  AC-2, AC-3, AC-5.**
- [ ] Restricted tools: `browser_click`, `browser_type`,
  `browser_evaluate`, `browser_create_tab`, `browser_close_tab`. **AC-1,
  AC-2, AC-4, AC-5.**
- [ ] Camoufox down: the domain is not offered, or answers isolated —
  local tools unaffected. **AC-5.**
- [ ] Verified against a live Camoufox server: navigate, snapshot and
  screenshot of a known page, a click and a type on it.
- [x] The CDP backend, opt-in: the same ten tools over the Chrome DevTools
  Protocol against a Chromium-family browser the user points at
  (`NOTCHFOLK_MCP_BROWSER=cdp`, the debug port the user's own
  configuration; Chrome 136+ needs a --user-data-dir away from the
  default profile). The opt-in carries the security note in the module's
  docstring: an open debugging port is reachable by any local process.
  **AC-1, AC-2, AC-3, AC-4, AC-5** proven against a mock Chromium over
  the real protocol (tests/mcp/test_browser_cdp.py); the Settings opt-in
  toggle follows with the Settings phase.
- [ ] Verified against a live Chromium browser over CDP: the same
  navigate, snapshot, click and type as Camoufox.

### 4. Skills and Office

- [ ] Skills, all read-only: `skills_list`, `skills_search`, `skills_get`,
  `skills_list_files`, `skills_read_file`, `skills_stats`,
  `skills_refresh`. **AC-1, AC-2, AC-3, AC-5.**
- [ ] Office, one restricted tool: `office_create_document`, written to the
  laptop; no shell, no system access. **AC-1, AC-2, AC-4, AC-5.**
- [ ] Verified on a live desktop: a catalogue listed and a document
  created.

### 5. Memory — Hindsight, then Obsidian

- [x] Hindsight read-only (18 tools): `recall`, `reflect`, `list_banks`,
  `get_bank`, `get_bank_stats`, `list_mental_models`, `get_mental_model`,
  `list_directives`, `list_memories`, `get_memory`, `list_documents`,
  `get_document`, `list_operations`, `get_operation`, `list_tags`,
  `get_knowledge_base_tree`, `search_knowledge_base`,
  `get_knowledge_page`. **AC-1, AC-2, AC-3, AC-5.**
- [x] Hindsight restricted (21 tools): `retain`, `sync_retain`,
  `create_bank`, `update_bank`, `delete_bank`, `create_mental_model`,
  `update_mental_model`, `delete_mental_model`, `refresh_mental_model`,
  `clear_mental_model`, `create_directive`, `delete_directive`,
  `update_memory`, `invalidate_memory`, `clear_memories`,
  `delete_document`, `cancel_operation`, `create_knowledge_page`,
  `create_knowledge_folder`, `update_knowledge_node`,
  `delete_knowledge_node`. **AC-1, AC-2, AC-4, AC-5.**
- [x] Obsidian read-only (10 tools): `obsidian_overview`,
  `obsidian_guide`, `obsidian_sync_status`, `obsidian_search`,
  `obsidian_list`, `obsidian_read`, `obsidian_recent`,
  `obsidian_backlinks`, `obsidian_templates_list`,
  `obsidian_template_read`. **AC-1, AC-2, AC-3, AC-5.**
- [x] Obsidian restricted (4 tools): `obsidian_create_note`,
  `obsidian_update_note`, `obsidian_patch_note`, `obsidian_move_note`.
  **AC-1, AC-2, AC-4, AC-5.**
- [ ] The backend rule: Hindsight is the implementation when available;
  Obsidian is the fallback — the switch is availability, not configuration.
  Verified with Hindsight up, and with it down.
- [ ] Verified on a live desktop: a fact retained and recalled through
  Hindsight; a note created and read through Obsidian.

### 6. Composio — reaching outward

- [ ] The domain is offered only when the Composio CLI is on the machine;
  authentication follows Composio's OAuth, never a bearer token in the
  keyring.
- [ ] Read-only: `composio_search_mail`, `composio_read_mail`,
  `composio_search_drive`, `composio_read_drive_file`. **AC-1, AC-2, AC-3,
  AC-5.**
- [ ] Restricted: `composio_send_mail`, `composio_delete_mail`,
  `composio_share_drive_file`, `composio_write_drive_file`. **AC-1, AC-2,
  AC-4, AC-5.**
- [ ] Verified on a machine with the CLI: mail searched and read on the
  default key; a mail sent on a scoped key.

### 7. The paper trail

- [ ] `docs/mcp.md` rewritten around the values: what each part of the world
  is for, which tools carry it, and the read-only / restricted rule.
- [ ] `SECURITY.md`: every new endpoint and execution surface listed —
  the local subprocess tools, Camoufox on localhost, the Hindsight API,
  the Obsidian backend, Composio's cloud, and the scope that guards each.
- [ ] The site's MCP copy follows: the tool count, and the values named as
  the spec names them.
- [ ] `notchfolk-setup-mcp` and the packaging carry the new modules; a
  fresh install offers exactly what the machine has backends for.

## Deferred until named

- ArtCraft: no tools, no tasks. When a specific application is named, its
  tool list is defined from what that application actually exposes, and its
  tasks are added here.
