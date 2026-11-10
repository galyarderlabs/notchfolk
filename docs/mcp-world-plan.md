# Notchfolk MCP — a little world in your notch: Plan

This is the plan for the tool set defined in [mcp-world-spec.md](mcp-world-spec.md)
(approved by Galih, 10 Nov 2026). The work is tracked in
[mcp-world-tasks.md](mcp-world-tasks.md). Nothing here changes the spec; where
the plan must choose, it says so and why.

## 1. Why

The island's MCP already carries its own world — tasks, calendar, reminders,
media, focus, shelf, clipboard, system — 55 tools over the daemon's D-Bus. The
spec adds the world *around* the notch: the machine itself, the web through a
real browser, documents, skills, memory and the user's accounts. The tools are
modelled on the MCPs already in use on the VPS, but they belong to Notchfolk's
MCP, on the machine where Notchfolk runs.

## 2. What is already there, and what it gives us

- **One server:** `mcp/server.py`, FastMCP (Python), stdio transport, wrapped by
  `scripts/notchfolk-mcp` into the venv that `notchfolk-setup-mcp` makes.
- **A key model that matches the spec's classification exactly:** per-client
  tokens in `~/.config/notchfolk/mcp.env`, each with scopes; the default key is
  `*:read`. `READ_SCOPES` / `WRITE_SCOPES` map every tool to
  `domain:read` / `domain:write`, and `authorize()` enforces it at call time.
  The spec's *Read-only* is a tool only in `READ_SCOPES`; *Restricted* is a
  tool in `WRITE_SCOPES`. No new enforcement mechanism is invented.
- **Remote access** through `notchfolk-mcp-tunnel` and the OAuth flow in
  `notchfolk_oauth.py`, with scopes already flowing through it
  (`OAUTH_SCOPES` is derived from the scope maps).

## 3. Shape of the code

`server.py` holds 55 tools in 658 lines; the spec adds about 90. The server
splits along its seams, and each domain becomes a module that registers its
tools on the shared FastMCP instance:

```
mcp/
  server.py            # the app, auth, scopes, D-Bus helpers — the existing 55 tools stay
  tools/
    __init__.py        # domain registry: probe → register
    system.py          # 14 tools, local subprocess / systemd / filesystem
    browser.py         # 10 tools, two backends: Camoufox REST (default) and CDP attach (opt-in)
    office.py          # 1 tool, the officecli binary's mcp subcommand over stdio
    skills.py          # 7 tools, the skill trees on the machine
    hindsight.py       # 39 tools, the Hindsight engine's MCP endpoint on localhost
    obsidian.py        # 14 tools, the vault on the machine
    composio.py        # 8 tools, the Composio CLI (subprocess; no mcp subcommand)
```

Rules the modules share:

- **Availability first.** A domain probes its backend once at startup and again
  on demand: binaries on `PATH` (composio, the toolchains), a port answering
  (Camoufox, Hindsight), a vault path (Obsidian). A domain whose backend is
  absent is **not offered** in `tools/list`; a backend that dies between calls
  answers as a normal, isolated error (AC-5) — never a crash, never a leak.
- **Settings stays short.** The key builder separates the internal data
  tools from the world domains: the former keep the existing "Read
  access" / "Write actions" expanders; each world domain is one row — on
  grants its read-only scope, and its write scope is a second switch
  inside the row, off by default. One line per domain, the spec's
  read-only/restricted rule intact.
- **Scope naming follows the value, not the backend.** `system:read` /
  `system:write` (the read scope already exists for `get_system_state`),
  `browser:*`, `office:write`, `skills:read`, `memory:*` (Hindsight — one
  value), `notes:*` (Obsidian — the notes value), `composio:*`. The spec's
  tables decide which tools land in which map.
- **AC-4 changes `tools/list`.** Today every tool is listed and rejected at
  call time; the spec wants a restricted tool *not visible as callable* to a
  key without its scope. The server therefore filters `tools/list` by the
  caller's token — the one real change to the existing machinery, and the
  first thing Phase 1 proves.

## 4. The prerequisite: read the source MCPs (Phase 0)

The spec is explicit: exact API details are not invented — they come from
reading the source MCP code (niyatna-mcp, browser-mcp/Camoufox, office-mcp,
skills-mcp, hindsight-mcp, obsidian-mcp, composio). That reading is
**Phase 0** and it gates every domain — and it is **complete** (10 Nov
2026): the details are recorded in `docs/mcp-world-apis.md`, one section
per domain, and nothing of a domain is implemented before its section
exists.

Two things Phase 0 had to answer precisely, because the spec left them
open — both answered:

- **`system_update`'s "requires confirmation"** — one-shot `confirm`
  argument, paired with check-first: `action=check` reports what would
  change, `action=update` without `confirm=true` is refused
  (`confirm=true required for action=update. Run action=check first.`),
  `action=update` with `confirm=true` runs it, audited. Copied, not
  invented.
- **Camoufox's driver** — **Playwright**, not raw CDP: the REST server
  launches Camoufox (anti-detection Firefox) via Playwright's
  `firefox.launch` with camoufox-js options, proven by the launch code
  and by cookie handling through Playwright's `context.addCookies()`.
  The browser tools are plain REST either way.

## 5. Phases

Each phase ends in something a user can see, and nothing in a later phase
starts before the phase before it is verified on a live desktop.

1. **Ground: the domain framework** — the `tools/` package, availability
   probing, scope-aware `tools/list` (AC-4), and the tests that prove AC-3 and
   AC-4 against real keys. No new value yet; the existing 55 tools must behave
   exactly as before.
2. **System** — read-only first (stats, logs, files, search, processes,
   toolchains), then restricted (exec, write, patch, file ops, service, kill),
   then `system_update` with the distro detection rule and its confirmation.
   The sharpest edge in the whole spec; its scope is never default.
3. **Browser** — the Camoufox REST client (the default backend), read-only
   first (navigate, snapshot, screenshot, scroll, tabs), then the restricted
   five; then the CDP backend as the opt-in second way to the same ten
   tools, for a Chromium-family browser of the user's own, with its
   security note in Settings.
4. **Skills and Office** — the two smallest domains; skills is all read-only,
   office is one restricted tool.
5. **Memory** — Hindsight first (the implementation when available), then
   Obsidian as the fallback and the notes value of its own.
6. **Composio** — conditional on the CLI; OAuth is Composio's, never a bearer
   token in the keyring.
7. **The paper trail** — `docs/mcp.md` rewritten around the values,
   `SECURITY.md` listing every new endpoint and execution surface, and the
   site's tool count and MCP section following.

## 6. Security posture

- `system_exec` and friends are the sharpest edges in the set: they run only
  for a key whose scope says so, are never in the default key, and are not
  listed for keys that cannot call them (AC-4).
- New network endpoints — Camoufox on localhost, the Hindsight API, the
  Obsidian backend, Composio's cloud — go into `SECURITY.md` in Phase 7, and
  each is reached only at the address the user configured. A backend that is
  down is an isolated error (AC-5); no secret crosses a backend boundary.
- Nothing from Galih's fleet or configuration is bundled for other users;
  which values are present is that machine's own configuration.

## 7. Out of scope

As the spec says: NotebookLM, Multica, REA, A2A. ArtCraft stays TBD — no
tools are defined until a specific application is named.
