# Notchfolk MCP — API reference (Phase 0)

Status: **Phase 0 complete, 10 Nov 2026.** This file records the exact API
details for every world domain, from a first-hand, line-by-line reading of
the source MCP code. Nothing here is invented. Where a value comes from the
reference deployment rather than from the code itself, it is marked
**reference** — the product does not copy it.

The spec is [mcp-world-spec.md](mcp-world-spec.md); the plan is
[mcp-world-plan.md](mcp-world-plan.md); the work is tracked in
[mcp-world-tasks.md](mcp-world-tasks.md).

## How to read this file

- **Product rule (binding).** Notchfolk's MCP runs on each user's own
  machine. Nothing is hardcoded: every path is home-relative (`~`), every
  port and address comes from the user's own configuration or from the
  backend package's own default, every package list and service list is
  detected at runtime, and a missing backend means its tools report
  "unavailable" — never a crash, never a guess. A value that only existed
  on the reference machine is marked **reference** and is not a product
  default.
- **Reference vs product.** The reference deployment ran six separate MCP
  servers, one per domain, each on its own localhost port. Notchfolk is
  **one** server (`mcp/server.py`, FastMCP `"Notchfolk"`, `127.0.0.1:8765`
  `/mcp`) with the value tools as `@mcp.tool` functions reusing
  `authorize()` and the `READ_SCOPES` / `WRITE_SCOPES` maps. The six
  reference servers are the source for **tool logic** (signatures, guards,
  flows) — not for deployment shape. Their ports, service names, and
  package lists do not apply to Notchfolk.
- **Closed-source binaries are probed, not read.** `officecli` and the
  Composio CLI are closed-source binaries: their exact syntax comes from
  probing them (`--help`, `--version`) and from their upstream projects,
  never from source. The Camofox REST server's `server.js` was not read
  line by line either; the MCP-layer contract (routes, payloads, auth) was
  read in full and is complete for the implementation.
- **What was not read.** The Hindsight engine's `config.py` (config
  defaults), its storage internals (Postgres, vector index), test files,
  and the Camofox REST server's internals. Notchfolk runs those engines;
  it does not reimplement them.

## 0. The shared skeleton (all six reference servers)

Every reference server is a Python FastMCP app with the same shape. The
shape is worth copying; the deployment values are not.

- **Transport and flags.** `--transport {stdio,http,sse}` (default stdio),
  `--host 127.0.0.1`, `--port <configured>`, `--path /mcp`. HTTP mode adds
  an auth middleware and the OAuth discovery routes.
- **Auth.** A bearer token from the server's `.env`, accepted as
  `Authorization: Bearer <token>` or `X-Api-Key: <token>`. The OAuth shim:
  `/authorize` takes the bearer as a "secret" and issues a 5-minute
  single-use code (`mcp_` + 16 hex); `/token` exchanges it for the bearer
  (`expires_in` 3600, and the same bearer back as `refresh_token` — no real
  rotation). Unauthenticated bypasses: `/health`, `/healthz`,
  `/.well-known/*`, `/authorize`, `/token`, `/register`, `/export/*`. CORS
  allows `*` with `Authorization, Content-Type, X-Api-Key,
  MCP-Protocol-Version`.
- **Dependencies (all six).** `requires-python >= 3.11`;
  `fastmcp>=4.1.0`, `mcp>=1.0`, `pydantic>=2.0` (the Obsidian server omits
  pydantic), `python-dotenv>=1.0`, `uvicorn>=0.30`, `starlette>=0.40`.
- **Deployment (reference).** Six plain directories — **not git
  repositories, no remote to clone**. One shared Python virtualenv runs all
  six. Each has a systemd user service: `WorkingDirectory` = its repo dir,
  `EnvironmentFile` = its `.env` (optional), `ExecStart` = the venv Python
  running the server with the flags above, `Restart=always`,
  `RestartSec=3`.
- **Notchfolk's use.** None of this is deployed. Notchfolk keeps its one
  server and its own key model (per-client scoped keys, default key
  read-only). What is copied is the tool logic in §1–§6 below.

## 1. System

Value: the world maintains and repairs the machine it stands on.

### Install

No separate install. The tools are native: local subprocess, systemd,
and the filesystem, implemented in `server.py` (or the `tools/system.py`
module per the plan). The reference implementation is a Python FastMCP
server; Notchfolk reimplements its logic natively — it does not run or
proxy that server.

### Run

- **Executor.** Every command runs through one helper:
  `subprocess.run(cmd, shell=True, cwd=<workdir>, capture_output=True,
  text=True, timeout=<timeout>, env={**os.environ, "HOME": <home>})`.
  stdout is truncated to 20,000 chars, stderr to 8,000. A timeout returns
  `{ok: False, error: "timeout after {timeout}s", command}`. The return
  shape is `{ok, exit_code, stdout, stderr, command}`.
- **Audit.** Every mutating tool also appends one JSONL line to a
  per-day log file (`exec-YYYY-MM-DD.jsonl` under the MCP log dir):
  tool, args, and an 800-char result preview. Whether Notchfolk mirrors
  this audit log is an open implementation decision; the pattern is
  recorded here.
- **Distro detection.** Read `/etc/os-release` (`ID` and `ID_LIKE`).
  Big distros only: Arch → `pacman`, Debian/Ubuntu → `apt`, Fedora/RHEL
  → `dnf`, openSUSE → `zypper`. AUR helpers (`yay`/`paru`) apply only on
  the Arch family, detected at runtime. Flatpak is distro-agnostic. An
  unknown distro is reported as unsupported — never guessed.

### Call shape — reference tools and their Notchfolk mapping

The reference server has 15 tools. Fourteen map onto the spec's System
tools; two have no Notchfolk counterpart (noted below).

| Notchfolk tool | Reference tool and exact signature |
|---|---|
| `system_stats` | `vps_system_stats()` — one call: `uptime`; `free -h`; `df -h / <home>`; `ss -ltnp \| head -n 30`; `ps aux --sort=-%cpu \| head -n 15` |
| `system_logs` | `vps_logs(service: str, lines: int = 100 [1–500])` — `journalctl --user -u <svc> -n <lines> --no-pager \| tail -n <lines>` |
| `system_list_files` | `vps_list_dir(path: str = <home>, limit: int = 80 [1–500])` — sorted entries `{name, is_dir, size, mtime}`; returns `{ok, path, count, entries}` |
| `system_read_file` | `vps_read_file(path: str, max_bytes: int = 80000 [1–200000])` — returns `{ok, path, size, truncated, content}`; directories refused |
| `system_search_files` | `vps_search(pattern: str, path: str = <home>, glob: str = "*", limit: int = 50 [1–200])` — runs `grep -R -n --include='<glob>' -E <pattern> <path> \| head -n <limit>`; exit 1 + empty stdout = no matches (`{ok: True, matches: [], count: 0}`) |
| `system_toolchain_status` | `vps_toolchain_status()` — read-only checks, each capped (4,000 chars per check); returns `{ok: True, checks: {name: {ok, exit_code, output}}}` |
| `system_list_processes` | `vps_process(action="list")` — `ps aux --sort=-%cpu \| head -n 30` + `ps aux --sort=-%mem \| head -n 20` |
| `system_exec` | `vps_exec(command: str, timeout: int = 30 [1–120], workdir: str = <home>)` — the executor above + audit |
| `system_write_file` | `vps_write_file(path: str, content: str, mode: str = "644")` — write roots only, `mkdir -p` parents, `chmod` mode, audited; returns `{ok, path, bytes}` |
| `system_patch_file` | `vps_patch_file(path, old_string, new_string, replace_all: bool = False)` — `old_string` must be present and unique unless `replace_all`; audited; returns `{ok, path, bytes, replaced}` |
| `system_file_ops` | `vps_file_ops(action: Literal["move","copy","delete","mkdir","chmod"], source: str, destination: str = "", mode: str = "")` — allowlist on source and destination; move/copy `mkdir -p` the destination parent; copy uses `shutil.copytree(dirs_exist_ok=True)` / `copy2`; audited |
| `system_service` | `vps_systemctl(action: Literal["status","start","stop","restart","reload","enable","disable","is-active","is-enabled","daemon-reload"], service: str = "")` — `daemon-reload` ignores the service; mutating actions check the whitelist (below); status reads `systemctl --user status <svc> --no-pager -l \| head -n 120`; audited |
| `system_kill_process` | `vps_process(action: Literal["kill","killall"], target: str = "", signal: str = "TERM")` — kill = `kill -s <SIG> <PID>` (numeric PID only, audited); killall = `pkill -<SIG> -f <name>` (protected names refused, audited) |
| `system_update` | `vps_toolchain_update(domain, action: Literal["check","update"] = "check", confirm: bool = False)` — see the confirmation rule below |
| — (no counterpart) | `vps_export_file(path, ttl_seconds: int = 600 [60–3600])` — HMAC-signed temp HTTPS link; max 80 MB; and `vps_get_file(path)` — inline return, max 700 KB, `ImageContent` for images. Notchfolk does not carry these. |

### Guards (copied, with home-relative roots)

- **Allowed roots.** Write roots: the user's home and `/tmp`. Read
  roots: the same, plus `/var/log` and `/etc/systemd`. Every file tool
  resolves the path and enforces them.
- **Service whitelist.** Mutating `systemctl` actions require the service
  to be on the machine's whitelist **or** to have a unit file in
  `~/.config/systemd/user`. The whitelist contents are per-machine
  configuration — the reference deployment's list is **reference**, not a
  product default.
- **Blocked command fragments.** `rm -rf /`, `rm -rf /*`, `rm -rf ~`,
  `rm -rf $HOME`; the fork bomb `:(){:|:&};:`; `mkfs`; `dd if=`;
  `>/dev/sda`, `>/dev/nvme`, `>/dev/vda`; `chmod -R 777 /`; `chmod 777 /`;
  `chown -R /`. Blocked patterns: `rm ... /` at the end; `shutdown`,
  `reboot`, `halt`, `poweroff`, `init 0`; `> /dev/(sda|nvme|vda|hda)`;
  `curl ... | bash`; `wget ... | bash`.
- **Kill rules.** Signals restricted to `TERM, KILL, HUP, INT, QUIT, USR1,
  USR2`. Kill target must be a numeric PID. `killall` refuses protected
  names (the machine's own protected services, configured per machine).
- **Delete refusal.** `system_file_ops` delete refuses `/`, `/home`, the
  user's home, and `/tmp`.

### `system_update` — the confirmation rule (Phase 0 answer)

The reference mechanism is a **one-shot `confirm` argument, paired with
check-first**:

- `action="check"` (default) only reports what would change.
- `action="update"` without `confirm=true` is refused:
  `{ok: False, error: "confirm=true required for action=update. Run
  action=check first."}`.
- `action="update"` with `confirm=true` runs the update, audited.

Notchfolk copies this: `system_update` takes the same `check` /
`update` + `confirm` shape. The domains it covers are the spec's: the
detected distro package manager (with the AUR helper on the Arch
family), flatpak, uv, npm, bun, and local update/upgrade scripts. The
reference deployment's domain list (which included deployment-specific
tools) is **reference** — Notchfolk's domains are the spec's list, and a
domain is offered only when its binary is present on the machine.

Reference per-target timeouts (for sizing, not a product rule): apt 600
s, uv 900 s, npm 600 s, officecli 300 s, open-webui 600 s, default 180 s
update / 120 s check. Reference update commands (the pattern, not the
list): reinstall the tool from its upstream installer, upgrade its
managed packages, restart its service only if the version changed
(before/after version read, `sleep 2`, `is-active` check).

### `system_toolchain_status` — the checks

The reference runs 17 read-only checks (apt upgradable list, `uv tool
list`, `uv --version`, `npm list -g`, `npm outdated -g`, node/npm/python
versions, and one version probe per managed tool, plus a JSON version
inventory script and a systemd status loop over the machine's services).
For Notchfolk, the checks are the ones that fit the machine: the distro
package manager, uv, npm, bun, flatpak, and the backends the machine
actually has. The reference's deployment-specific version probes are
**reference**, not product defaults. A domain whose binary is absent is
reported as unavailable, not as an error.

## 2. Browser

Value: the world sees and uses the web through a real browser, driven
over plain REST HTTP to the Camoufox server.

### Install

Two npm packages from the same upstream project
(`github.com/jo-inc/camofox-browser`, Jo Inc, MIT, Node ≥ 22):

```
npm install -g @askjo/camofox-browser       # the REST server
npm install -g @askjo/camofox-browser-mcp   # the MCP adapter (stdio)
```

- The REST server is `@askjo/camofox-browser` (reference version 1.13.1).
  Its bin is a 2-line file (`#!/usr/bin/env node` + `import
  '../server.js';`); `server.js` is the Express app. It is a plain npm
  package, **not** a system package.
- The adapter is `@askjo/camofox-browser-mcp` (reference version 1.18.1).
  Its bin is `camofox-browser-mcp` → `server.mjs`. Dependency:
  `@modelcontextprotocol/sdk ^1.30.0`.
- The browser binary itself comes from `npx camoufox-js fetch`, or from
  an external executable via `CAMOUFOX_EXECUTABLE` /
  `CAMOUFOX_EXECUTABLE_PATH` / `CAMOFOX_EXECUTABLE_PATH`.

### Run

- **REST server.** `camofox-browser --port <port>`. The port comes from
  `CAMOFOX_PORT` or `PORT`, default **9377** — that default is the
  package's own config, not a deployment choice. Env file (optional):
  `~/.camofox/.env`. The reference ran it as a systemd user service
  (`Restart=always`, `RestartSec=5`, `NODE_OPTIONS=--dns-result-order=ipv4first`).
  The adapter does **not** launch the browser — the REST server must
  already be running.
- **Driver (Phase 0 answer).** The REST server drives the browser through
  **Playwright**, not raw CDP: it launches Camoufox (anti-detection
  Firefox) via Playwright's `firefox.launch` with camoufox-js options
  (`launchOptions({proxy, geoip})`). Proven by the launch code and by the
  cookie handling, which uses Playwright's `context.addCookies()`.
- **Sessions.** `userId -> { context, tabGroups: Map<sessionKey,
  Map<tabId, TabState>>, lastAccess }`. `sessionKey` was previously called
  `listItemId` (both accepted). Per-user concurrency limit enforced.
  Defaults from the package config: max 3 concurrent per user, session
  timeout 600 s, tab inactivity 300 s, max 50 sessions, max 10 tabs per
  session, max 50 tabs global, navigate timeout 25 s, browser idle
  timeout 300 s.
- **Config dirs (package defaults).** Cookies `~/.camofox/cookies`,
  uploads `~/.camofox/uploads`, profiles `~/.camofox/profiles`, traces
  `~/.camofox/traces` (max 50 MB, TTL 24 h). Browser cache:
  `$XDG_CACHE_HOME/camoufox` or `~/.cache/camoufox` on Linux.
- **Auth.** `CAMOFOX_API_KEY` is primary; `CAMOFOX_ACCESS_KEY` is a
  superkey alternative (timing-safe compare). Loopback is allowed in
  non-production when no keys are set. The global access key is required
  on every route except `GET /health`, cookie/auth-session import (only
  when the API key is also set), and `POST /stop` (only when the admin key
  is also set). 401 carries `WWW-Authenticate: Bearer realm="camofox"`.

### NF connection

Notchfolk's browser tools are plain REST calls to the Camoufox server on
localhost, at the address the user configured (package default port
9377). Notchfolk does **not** run the adapter as a subprocess and does
not speak CDP — it talks the same REST contract the adapter talks. The
adapter's contract file (`lib/tool-contracts.mjs`) is the single source
of truth shared by the adapter and the OpenClaw plugin: tool names,
JSON-Schema parameters, REST routes, request bodies, auth, and response
shaping cannot drift between hosts.

### Call shape — the 11 tools and their exact REST routes

`userId` scopes the cookie/storage partition; `sessionKey` partitions
tabs within a user. All routes carry `auth: accessKey` except where
noted. `BASE_URL` is `CAMOFOX_BASE_URL` or
`http://localhost:<port>`.

| Notchfolk tool | Adapter tool | Exact REST call |
|---|---|---|
| `browser_create_tab` | `camofox_create_tab` (required `url`) | `POST /tabs`, body `{url, userId, sessionKey}` → json |
| `browser_navigate` | `camofox_navigate` (required `tabId`; `url` or `macro` + `query`) | `POST /tabs/{tabId}/navigate`, body `{...args minus tabId, userId}` → json. Macros: `@google_search, @youtube_search, @amazon_search, @reddit_search, @wikipedia_search, @twitter_search, @yelp_search, @spotify_search, @netflix_search, @linkedin_search, @instagram_search, @tiktok_search, @twitch_search` |
| `browser_snapshot` | `camofox_snapshot` (required `tabId`; optional `offset`) | `GET /tabs/{tabId}/snapshot?userId={userId}&includeScreenshot=true[&offset={offset}]` → snapshot. Returns element refs (`e1`, `e2`, …) + a screenshot; large pages truncate with `hasMore=true` + `nextOffset` — call again with that offset |
| `browser_click` | `camofox_click` (required `tabId`; `ref` e.g. `e1` or `selector` CSS) | `POST /tabs/{tabId}/click`, body `{...args minus tabId, userId}` → json |
| `browser_type` | `camofox_type` (required `tabId`, `text`; `ref` or `selector`; `pressEnter`) | `POST /tabs/{tabId}/type`, body `{...args minus tabId, userId}` → json |
| `browser_scroll` | `camofox_scroll` (required `tabId`, `direction` in `up/down/left/right`; `amount` px) | `POST /tabs/{tabId}/scroll`, body `{...args minus tabId, userId}` → json |
| `browser_screenshot` | `camofox_screenshot` (required `tabId`) | `GET /tabs/{tabId}/screenshot?userId={userId}` → image (requires `content-type` starting with `image/`, else `Screenshot failed: {text}`) |
| `browser_close_tab` | `camofox_close_tab` (required `tabId`) | `DELETE /tabs/{tabId}?userId={userId}` → json |
| `browser_evaluate` | `camofox_evaluate` (required `tabId`, `expression` JS) | `POST /tabs/{tabId}/evaluate`, body `{userId, expression}` → json (body limit from the package config, default `1mb`) |
| `browser_list_tabs` | `camofox_list_tabs` (no arguments) | `GET /tabs?userId={userId}` → json |
| — (no Notchfolk counterpart yet) | `camofox_import_cookies` (required `cookiesPath`, a relative Netscape `cookies.txt` inside the server cookies dir; optional `domainSuffix`) | `POST /sessions/{userId}/cookies`, `auth: apiKey`, body `{cookies}`. The cookie file is parsed **locally** first (path-containment checked before and after `realpath`; file > 5 MB refused; `domainSuffix` filters); the REST route accepts a parsed `{cookies: [...]}` body, never a path. Requires `CAMOFOX_API_KEY` on both the server and the caller, else it throws. Netscape `expires` 0 (session cookie) maps to `-1`, because Playwright's `addCookies()` reads 0 as 1970-01-01 and silently drops it. |

Response shaping: `image` → one image block; `snapshot` → the embedded
screenshot split out as an image block + a text block with the rest as
pretty-printed JSON; cookie import → a text block with `{imported,
userId, result}`; default → one text block with pretty-printed JSON.
Non-2xx throws `Error("{status}: {text}")`. Unknown tool →
`{isError: true, "Unknown tool: {name}"}`; a failed call →
`{isError: true, "camofox error: {message}"}`.

The REST server has 38 routes; the MCP contract exposes 11. The rest
(wait, upload, press, viewport, back/forward/refresh, links, downloads,
images, stats, extract, traces, group delete, legacy `/start` `/stop`
`/navigate` `/snapshot` `/act`, `/tabs/open`, `/metrics`,
`/pressure/cleanup`) exist on the server but are not MCP tools.

**Fix before reuse.** The reference browser proxy's instructions string
and variable names contain copy-paste errors from the office proxy (it
says "stdio officecli mcp", mentions `.docx`, and names the wrong
service in its authorize page). Notchfolk writes its own instructions
from the contract above; it does not copy that string.

## 3. Office

Value: the world makes documents.

### Install

One self-contained binary, no Office install, no runtime to manage.
Upstream project: `iOfficeAI/OfficeCLI` on GitHub. Install command
(macOS / Linux), verified against the upstream README:

```
curl -fsSL https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh | bash
```

Mirror: `curl -fsSL https://d.officecli.ai/install.sh | bash`.
Alternatives: `brew install officecli`, `npm install -g
@officecli/officecli`. Verify with `officecli --version`.

How the installer works (from the install script, read in full): it
resolves the latest tag from the `/releases/latest` redirect (mirror
first, GitHub fallback), then downloads from the **immutable** versioned
path `/releases/download/vX.Y.Z/<asset>` — the mutable
`/latest/download/` path is CDN-cached up to 4 h and can serve a stale
binary with a self-consistent stale checksum. Checksum via `SHA256SUMS`
with an exact filename-column match. Asset names by platform:
`officecli-mac-arm64`, `officecli-mac-x64`, `officecli-linux-x64`,
`officecli-linux-alpine-x64` (musl, detected via `ldd` or
`/etc/alpine-release`), `officecli-linux-arm64`,
`officecli-linux-alpine-arm64`. Install: if `officecli` already exists,
upgrade in place (install dir = dirname of the existing binary); else
`INSTALL_DIR=$HOME/.local/bin`. Atomic replace via `.new` + `mv` (never
overwrite in place — it would trash a running process's text segment).
It auto-adds the install dir to `PATH` in `.zshrc` / `.bashrc`. On first
install it drops a `SKILL.md` into every agent dir it detects
(`~/.claude`, `~/.copilot`, `~/.agents`, `~/.cursor`, `~/.windsurf`,
`~/.minimax`, `~/.openclaw`, `~/.nanobot/workspace`,
`~/.zeroclaw/workspace`, `~/.hermes`) at
`<dir>/skills/officecli/SKILL.md`.

Location after install: `~/.local/bin/officecli`. Reference version
1.0.160 (asset `officecli-linux-arm64`).

### Run

The binary is a resident document server, not a one-shot converter:

- `open` keeps the document in memory; `save` flushes to disk keeping
  the resident warm; `close` flushes and stops. A live resident
  auto-flushes shortly after going idle (adaptive 2–10 s;
  `OFFICECLI_RESIDENT_FLUSH`: `each|auto|<seconds>|off`).
- `create` refuses to overwrite (exit 1, `file_exists`) and refuses a
  file a live resident holds (exit 1, `file_locked`). Reliable
  clean-slate idiom: close → rm → create → batch → close.
- Exit codes: 0 landed, 1 failed, 2 ran with caveats (read `success`).
- Global flags: `--json`, `--version`. Schema reference: `officecli help
  <format>` (`docx`/`xlsx`/`pptx`; aliases `word`→`docx`,
  `excel`→`xlsx`, `ppt`/`powerpoint`→`pptx`); `help all --json/--jsonl`
  dumps every (format, element, property).

Subcommands (from `--help`, read in full): open, close, watch, unwatch,
view, get, query, set, add, remove, move, swap, refresh, raw, raw-set,
add-part, validate, save, batch, dump, import, create, merge, plugins,
mcp, skills, install, help.

### NF connection

Notchfolk spawns the binary's `mcp` subcommand over stdio and proxies
it — the same shape the reference server used:

```
StdioTransport(command="<home>/.local/bin/officecli", args=["mcp"], keep_alive=True)
create_proxy(transport, cache_ttl=60, cache_scope="private", mode="legacy")
```

The subprocess stays warm across calls (`keep_alive=True`). The proxy
exposes exactly one tool, `officecli`. The reference instructions
override (which the proxy would otherwise forward from upstream) is:
create/read/modify `.docx`/`.xlsx`/`.pptx` via `officecli`; paths under
the user's home or `/tmp`; workflow — view outline/stats first, then
get/query, then set/add/remove, then validate + view issues, then save;
for 3+ mutations use batch; always end with save.

### Call shape — `office_create_document` and the `batch` idiom

The spec's one office tool, `office_create_document`, is implemented
through the binary:

- `batch` takes a JSON array via `--commands`, stdin, or `--input`. Each
  item is an **object** whose `command` is the bare verb and the verb's
  arguments are **sibling fields** — not a CLI string. (Example shape:
  `{"command": "add", "path": "/slide[1]", "type": "slide", ...}`.)
- `dump` serializes a subtree into a replayable batch script.
- The tool writes to the user's machine (home or `/tmp`); it has no
  shell and no access to the system.

## 4. Skills

Value: the world knows how to do things.

### Install

No binary to install. A skill is a directory with a `SKILL.md` (YAML
frontmatter `name:` + `description:`, then the body). The catalogue is
the skill trees on the machine. Notchfolk reads the trees directly; it
does not run or proxy a skills server.

### Run

- **Trees.** Two roots, configured per machine (defaults below are
  home-relative; a root that is not a directory is skipped):
  - a **flat** tree (one `SKILL.md` per directory, no nesting),
  - a **nested** tree (categories as subdirectories, plus an archive
    subtree whose skills are hidden by default).
- **Skill id.** `<source>:<relative-dir>`, e.g. `agents:apple-design` or
  `hermes:creative/brandkit`. Same-named skills in both trees are
  different ids — the id disambiguates them.
- **Index.** Built once at import; rebuilt by `skills_refresh`. For each
  root it walks `SKILL.md` files (sorted); `rel` is the dir relative to
  the root; `archived` is true when `.archive` is in the path. Name comes
  from frontmatter `name:` or the dir name; description from frontmatter
  `description:` (folded `>`, `>-`, `|`, `|-` forms join indented lines
  with spaces), else the first non-heading non-empty body line (first
  300 chars). Frontmatter is parsed without PyYAML: the text must start
  with `---`, and the scan looks for `name:` / `description:` lines.
- **Caps.** `SKILL.md` read capped at 150,000 bytes; a single file read
  capped at 200,000 bytes; file listing capped at 1,000 files.
- **Denied on read.** Basenames `.env`; suffixes `.pem`, `.key`, `.p12`,
  `.pfx`; substrings `credential`, `secret`, `token`, `private_key`
  (checked against the lowercase basename) → `{ok: False, error:
  "refused: credential-like file"}`.
- **Design constraint (from the reference).** Do not expose one tool per
  skill. The MCP surface stays at 7 coarse tools; skill identity and
  content travel as parameters / return values.

### Call shape — the 7 tools (all read-only)

| Tool | Exact shape |
|---|---|
| `skills_list` | `list_skills(source="all", query="", include_archived=False, limit=50, offset=0)` — source must be `all` or one of the configured sources, else `{ok: False, error: "source must be ..."}`; substring filter over name/rel/description (lowercased); limit clamped to 1–200; returns `{total, limit, offset, skills: [...]}` |
| `skills_search` | `search(query, source="all", include_archived=False, limit=20)` — empty query → `{query, total: 0, skills: []}`; scoring: exact name 100, name substring 80, rel-path substring 60, description substring 40; sorted by `(-score, name)`; limit clamped to 1–100 |
| `skills_get` | `get(skill_id)` — unknown id → `{ok: False, error: "unknown skill_id: ...", hint: "use skills_list / skills_search to find a valid id"}`; reads `SKILL.md`; `truncated` when the bytes exceed the cap; `files` = the first 200 of `list_files` |
| `skills_list_files` | `list_files(skill_id)` — sorted files only, `{path (relative posix), bytes}`; stops at the cap |
| `skills_read_file` | `read_file(skill_id, path)` — path must be relative, no leading `/`, no `..`; denied names refused; resolves inside the skill dir (else "refused: path escapes the skill directory"); must be a file; too large → "file too large"; unreadable/binary → "not a readable text file (binary or unreadable)"; returns `{ok: True, skill, path, bytes, content}` |
| `skills_stats` | `stats()` — `{total, <per-source counts>, <archived/active counts>, roots: {source: path}}` |
| `skills_refresh` | rebuilds the index and returns `{ok: True, refreshed: True, **stats()}` |

## 5. Memory

Value: the world remembers. One value, one backend rule: Hindsight is
the implementation when it is available; when it is not, Obsidian is
enough. Obsidian also carries a second value of its own — notes.

### 5.1 Hindsight backend

#### Install

The engine is the PyPI package `hindsight-api-slim` (specifier
`>=1.2.0`), installed with uv:

```
uv tool install 'hindsight-api-slim>=1.2.0'
```

Reference version 1.2.0 (MIT, "Hindsight: Agent Memory That Learns",
requires Python ≥ 3.11). It lands in the uv tool dir
(`~/.local/share/uv/tools/hindsight-api-slim/`, Python 3.14, package
under `.../lib/python3.14/site-packages/hindsight_api/`) with
entrypoints in `~/.local/bin/`: `hindsight-admin`, `hindsight-api`,
`hindsight-local-mcp`, `hindsight-worker`.

#### Run

- **Engine (daemon).** `hindsight-api --host <host> --port <port>
  --log-level info`. The port and host come from the user's own
  configuration. It needs a database URL (Postgres) and an LLM API key
  for the decision model (`HINDSIGHT_API_LLM_API_KEY`, required;
  provider default `openai`, model default `gpt-4o-mini`). Startup is
  slow (the engine's lazy imports are load-bearing: module-level imports
  are paid by every spawned worker), so the service allows a long start
  timeout.
- **Local entry point.** `hindsight-local-mcp` (or `uvx
  hindsight-api@latest hindsight-local-mcp`) runs the full API on
  localhost with an embedded Postgres (`pg0://hindsight-mcp` by
  default), warning log level. Configure a client with e.g. `claude mcp
  add --transport http hindsight http://localhost:8888/mcp/` — or pinned
  to one bank, `http://localhost:8888/mcp/<bank>/`.
- **MCP endpoint.** The engine mounts MCP at `<host>:<port>/mcp`. Bank
  resolution, in priority order: (1) the URL path `/mcp/<bank>/` →
  single-bank mode (no `bank_id` param, scoped tools); (2) the
  `X-Bank-Id` header → multi-bank mode; (3) the `HINDSIGHT_MCP_BANK_ID`
  env (default `"default"`). Auth: a legacy static token
  (`MCP_AUTH_TOKEN`, checked first) or the tenant extension (the default
  requires no auth for local dev). A GET probe without `Mcp-Session-Id`
  returns 200 OK.
- **Open decision.** Whether a laptop runs its own engine (uv tool +
  Postgres/pg0) or points at a hosted Hindsight MCP endpoint is
  undecided. This file records both shapes; it does not choose.

#### NF connection

Notchfolk's Hindsight tools call the engine's MCP endpoint on
localhost, at the address the user configured. The reference ran a thin
proxy in front of it (Streamable HTTP to the engine's `/mcp`); Notchfolk
does not need the proxy — it calls the engine's endpoint directly, with
the same tool set. The engine exposes 39 tools; the spec's Hindsight
section names 18 read-only + 21 restricted (the same 39, minus none —
see the list below).

#### Call shape — the 39 tools

Every tool is registered **twice**: once taking an explicit `bank_id`
and returning JSON text (callers `json.loads` it — returning a dict
there would be a breaking change), and once resolving the bank from the
session and returning a dict. Both copies share one wrapper: resolve
the bank, reject a missing one, serialize, map errors. Errors are JSON
(`{"error": ...}`) — never a bare string, because a message containing a
quote or backslash would otherwise emit invalid JSON.

- **Core four.**
  - `retain(content: str, context: str = "general", timestamp: str | None
    = None, tags: list[str] | None, metadata: dict[str, str] | None,
    document_id: str | None, strategy: str | None, update_mode: str |
    None)` — `update_mode` `'replace'` (default) / `'append'`;
    `strategy` e.g. `'exact'` for verbatim storage (strategies are
    defined in the bank config). Calls the engine's async retain and
    returns `{status: "accepted", message: "Memory storage initiated",
    operation_id}`. **Retain is async — it returns an `operation_id`,
    not the stored memory.**
  - `sync_retain` — same params minus `update_mode`. Blocks until
    stored: `{status: "completed", message: "Memory stored
    successfully", memory_ids: [...]}`.
  - `recall(query: str, max_tokens: int = 4096, budget: str = "high",
    types: list[str] | None, prefer_observations: bool | None, tags:
    list[str] | None, tags_match: TagsMatch = "any", tag_groups:
    list[dict] | None, query_timestamp: str | None, min_scores: dict |
    None, temporal_window: dict | None, rerank: dict | None,
    include_chunks: bool = False, max_chunk_tokens: int = 8192,
    include_entities: bool = False, max_entity_tokens: int = 500,
    include_source_facts: bool = False, max_source_facts_tokens: int =
    4096)` — `max_tokens` counts only each result's `text` (ids, tags,
    scores, dates do not count, so the response is several times
    larger). `budget` `low`/`mid`/`high`. `tags_match`: `any`/`all`
    (untagged included), `any_strict`/`all_strict` (untagged excluded),
    `exact`. `tags` and `tag_groups` are mutually exclusive. `tag_groups`
    are compound boolean groups AND-ed together; a leaf is `{"tags":
    [...], "match": "any_strict"}` or a compound `{"and": [...]}`,
    `{"or": [...]}`, `{"not": {...}}`; a leaf may add `"resolve":
    "fuzzy"` for trigram-similarity tag matching. Recall fuses **four**
    arms — semantic, keyword, graph, temporal — and returns what **any**
    of them surfaced, so a result may report null or a lower score for an
    arm that did not surface it; `min_scores` `semantic`/`keyword` prune
    only the arm they name — use `reranker`/`final` (applied to every
    scored result) to make recall abstain. `temporal_window`
    (`{"start", "end"}`) ranks memories dated inside it higher; it does
    **not** drop memories outside it. `rerank` (`{"prune", "dedup"}`) has
    no effect unless a decision model is set up for recall.
  - `reflect(query: str, context: str | None = None, budget: str =
    "low", max_tokens: int = 4096, response_schema: dict | None = None,
    tags: list[str] | None, tags_match: TagsMatch = "any",
    apply_all_directives: bool = False, include_based_on: bool = False,
    include_trace: bool = False)` — by default directives are scoped
    like memories (untagged always apply, tagged only when tags match);
    `apply_all_directives=true` applies every active directive. Source
    facts (`based_on`) and the trace (`tool_trace`/`llm_trace`/
    `directives_applied`) are popped unless explicitly included, because
    they can be tens of KB and overflow client context. `recall` returns
    raw facts (fast lookup); `reflect` reasons across memories into a
    synthesized answer (deeper analysis).
- **The other 35.** Each is a mechanical wrapper — validate args, call
  the matching `MemoryEngine` method, return the result — following the
  pattern of the four core tools: `list_banks`, `create_bank`,
  `list_mental_models`, `get_mental_model`, `create_mental_model`,
  `update_mental_model`, `delete_mental_model`, `refresh_mental_model`,
  `clear_mental_model`, `get_knowledge_base_tree`,
  `search_knowledge_base`, `get_knowledge_page`,
  `create_knowledge_folder`, `create_knowledge_page`,
  `update_knowledge_node`, `delete_knowledge_node`, `list_directives`,
  `create_directive`, `delete_directive`, `list_memories`, `get_memory`,
  `update_memory`, `invalidate_memory`, `list_documents`, `get_document`,
  `delete_document`, `list_operations`, `get_operation`,
  `cancel_operation`, `list_tags`, `get_bank`, `get_bank_stats`,
  `update_bank`, `delete_bank`, `clear_memories`. Notable behaviours:
  `clear_memories` deletes a bank's facts (it calls the engine's delete
  with the bank profile kept); `update_memory` carries
  resolve-entities semantics; `get_document` drops attachment filenames;
  the knowledge-base root parent is `"root"`; `export_knowledge_base`
  is deliberately **not** exposed as a tool. A coding agent needing one
  body reads it from the installed package.
- **Bank-level filtering.** Two layers, applied to both `tools/list`
  and invocation: layer 1 is the bank config's `mcp_enabled_tools`;
  layer 2 is the operation validator — it can only **narrow**, never
  expand beyond the bank-config ceiling. A disabled tool returns
  `NotFoundError` (FastMCP 3) or `ValueError("Tool '<name>' is not
  enabled for bank '<id>'")` (FastMCP 2).
- **Audit.** Read-only tools are not audited (like the HTTP GET routes).
  Every other tool call is logged (`tool`, `bank`, `status`,
  `duration_ms`) and, when allowed, written as an audit row with the
  request arguments and the first 4,096 chars of the response. The
  unaudited set is a deny-list, so a new write tool is audited without
  anyone remembering to add it.
- **Tolerance.** The engine strips unknown arguments (LLMs add
  `explanation`/`reasoning`) and coerces string-encoded JSON for
  list/dict params (e.g. `tags='["a","b"]'` → `tags=["a","b"]`).

### 5.2 Obsidian backend — memory fallback and notes

#### Install

No package to install. The vault is a directory of Markdown notes on
the machine. The vault path comes from the user's own configuration
(env `OBSIDIAN_VAULT_PATH` or the user's pick in Settings); Notchfolk
detects common vault locations under home and asks the user to pick when
there is more than one. The reference server read its vault from an env
var with a home-relative default.

#### Run

- **Vault layout.** Top-level folders of the user's own vault; templates
  live under `_System/Templates` (a code constant, `TEMPLATE_DIR`).
  Private internals are never reachable through the MCP:
  `.obsidian`, `.claudian`, `.git`, `.trash`.
- **Sync.** The MCP itself does no syncing. The reference deployment
  used Syncthing (CLI + config, folder id `obsidian-vault`) and reported
  its status through the MCP; on a laptop the sync is whatever the user
  runs (Syncthing, iCloud, or none) — the `obsidian_sync_status` tool
  reports it when the sync tool is present, and reports unavailable
  when it is not.
- **Limits.** Max note size 512,000 bytes (`MAX_NOTE_BYTES`). Read
  default 60,000 chars (clamped 1,000–100,000). List default 200
  (clamped 1–500). Search default 20 (clamped 1–100). Recent default 20
  (clamped 1–100).

#### Call shape — the 16 tools

Every path goes through one gate (`_safe_path`): vault-relative POSIX
paths with forward slashes (no backslashes, no absolute paths, no `..`,
no empty parts, no hidden parts); every part is symlink-checked while
descending; the resolved path must stay inside the vault. A violation
raises `VaultError`, returned as `{ok: False, error: ...}`.

| Tool | Exact shape |
|---|---|
| `obsidian_overview` | `{ok, vault_name, vault_path, markdown_notes, top_level_folders, notes_by_section, templates_path: "_System/Templates", private_internal_paths_excluded, write_safety: "Create never overwrites. Updates and moves require the current SHA-256.", delete_tool: "Not exposed; archive or move notes instead of permanent deletion."}` |
| `obsidian_guide` | `guide(topic: str = "overview")` — topics `overview\|structure\|workflow\|safety\|updates`; unknown topic → `{ok: False, error: ...}`; returns `{ok, topic, guide, vault}` |
| `obsidian_sync_status` | Runs the sync CLI (`show system`, `show connections`, 8 s each) and parses its config for the vault folder; per remote device `{name, connected, paused, client_version}`; warnings for a paused folder / paused devices / offline devices; missing CLI or config → `{ok: False, available: False, message: "…unavailable."}` |
| `obsidian_search` | `search(query, limit=20, include_templates=False)` — empty query → error; terms = word characters (casefolded); **all** terms must appear; score = sum of term counts; snippet = 180 chars before + 420 after the first term (or the first 260 chars), whitespace-collapsed, capped 600; skips templates unless asked; skips notes over the size cap; sorted by `(-score, path)`; returns `{ok, query, count, total_matches, results: [{path, title, score, modified_at, snippet}]}` |
| `obsidian_list` | `list_directory(relative="", limit=200)` — children sorted dirs-first then by name (casefold); skips hidden / private / symlink / outside-root; dir entries `{name, path, type: "directory"}`; file entries `{name, path, type: "file", extension, size_bytes, modified_at}` |
| `obsidian_read` | `read_note(relative, max_chars=60000)` — must be a `.md` file; over the size cap → error; decoded `utf-8-sig`; returns `{ok, path, content, sha256, size_bytes, modified_at, truncated}` |
| `obsidian_create_note` | `create_note(title, folder, content, template_name="")` — title: stripped, non-empty, not `.`/`..`, no `/\:*?"<>|`, not starting with `.`, ≤ 180 chars; folder must exist as a dir; name = title + `.md` unless already `.md`; **create never overwrites** (`O_EXCL` — an existing name returns "A note with that name already exists; read it before deciding what to do."); write + flush + fsync; returns `{ok, created: True, path, sha256, size_bytes}`. With `template_name`: reads the template first and substitutes `{{title}}` and `{{date}}` (today, in the machine's local timezone) |
| `obsidian_update_note` | `update_note(relative, content, expected_sha256)` — `expected_sha256` must be a 64-hex string, else "expected_sha256 (from the latest read) is required."; hash mismatch → `{ok: False, conflict: True, path, current_sha256, message: "Note changed since it was read. Read it again and re-apply the intended edit."}`; write is atomic (temp file in the same dir, same mode, `os.replace`); returns `{ok, updated: True, path, previous_sha256, sha256}` |
| `obsidian_patch_note` | `patch_note(relative, find_text, replace_text, expected_sha256)` — same guards; `find_text` non-empty; it must match **exactly once** (else "find_text must match exactly once; found N occurrences."); returns `{ok, updated: True, path, sha256, replacements: 1}` |
| `obsidian_move_note` | `move_note(source, destination, expected_sha256)` — both must be `.md`; destination parent must be a dir; destination must **not** exist ("Destination already exists; refusing to overwrite."); same sha conflict check; `os.replace`; returns `{ok, moved: True, from, to, sha256}` |
| `obsidian_recent` | `recent(limit=20)` — all notes as `{path, title, modified_at, size_bytes}`, newest first; returns `{ok, count, results}` |
| `obsidian_backlinks` | `backlinks(relative)` — wikilinks `[[...]]` (fragment after `#` dropped) + markdown `[..](..)` targets; drops `http:`, `https:`, `mailto:`, `#` targets; returns `{ok, path, incoming: [{path, title}], outgoing: [links]}` |
| `obsidian_templates_list` | `list_templates()` — sorted `*.md` under `_System/Templates` (not a dir → `{ok, path, templates: []}`) |
| `obsidian_template_read` | `read_template(name)` — no `/`, `\`, or leading `.`; reads `_System/Templates/<name>` (max 40,000 chars) |
| `obsidian_skills_list` | reads the bundled workflow skills dir (`<repo>/skills/*/SKILL.md`); per skill `{skill_id: rel, name: dir name, description: first "description:" line}`; returns `{ok, count, skills}` |
| `obsidian_skill_get` | `skill_get(skill_id)` — id must match `[a-z0-9][a-z0-9-]{0,80}`; path must resolve inside the skills dir and be a file, not a symlink; > 100,000 chars → "Skill document is too large."; returns `{ok, skill_id, content}` |

**There is no delete tool, by design.** Archive or move notes instead
of permanent deletion.

## 6. Composio

Value: the world reaches your accounts — mail and drive. This is the
**only** value that touches the cloud. Everything else in this file is
local.

### Install

One command, verified against the upstream docs
(`docs.composio.dev/docs/cli`):

```
curl -fsSL https://composio.dev/install | sh
```

The installer downloads and verifies the release bundle into
`~/.composio`, creates the `~/.local/bin/composio` entry point, and
configures the shell (`zsh`, `bash`, `fish` — a managed `# Composio
CLI` block in their startup files) so future terminals find `composio`
on `PATH`. Supports Linux x64, Linux ARM64, macOS Intel, macOS Apple
Silicon (Windows: inside WSL). Options: pin a version —
`curl -fsSL https://composio.dev/install | COMPOSIO_INSTALL_VERSION=0.3.1
COMPOSIO_INSTALL_PLUGINS=0 sh` (or `| sh -s -- @composio/cli@0.3.1`);
install-only without touching shell files —
`COMPOSIO_INSTALL_SHELL=none`. Reference version 0.4.0. After install,
open a new terminal and verify with `composio --version`.

Layout after install: the real binary is `~/.composio/composio`, with a
symlink `~/.local/bin/composio`. `~/.composio/` also holds the CLI's own
support files (`config.json`, `tool_definitions/`, `services/`,
`acp-adapters/`, `local-tools-binaries/`, run helpers) — that directory
is the CLI's install dir, not user data.

### Use — the four commands Notchfolk needs

All four were read from the installed CLI's own `--help` (version
0.4.0). There is **no `composio mcp` subcommand** in this version —
`composio mcp --help` prints the top-level help. Notchfolk therefore
does **not** speak MCP to Composio; it invokes the CLI as a subprocess.

```
# 1. Connect an account (OAuth, in the browser, waits for confirmation)
composio link <toolkit> [--alias <name>] [--no-wait] [--no-browser]
composio link github
composio link gmail --alias work
composio link github --list        # list connected accounts, no new link

# 2. Find the tool for a use case (JSON by default; --human for text)
composio search <query...> [--toolkits <slugs>] [--limit <n>] [--human]
composio search "send an email"
composio search "list calendar events" --toolkits google_calendar --limit 5

# 3. Run a tool by slug (validates inputs + connections first)
composio execute <slug> [-d, --data <json>] [--account <selector>] [--file <path>] [--dry-run] [--get-schema] [--parallel]
composio execute GMAIL_SEND_EMAIL -d '{ recipient_email: "a@b.com", subject: "Hello", body: "World" }'
composio execute GITHUB_CREATE_ISSUE --account work -d '{ owner: "acme", repo: "app", title: "Bug report", body: "Steps..." }'
composio execute SLACK_SEND_A_MESSAGE_TO_A_SLACK_CHANNEL --dry-run -d '{ channel: "general", text: "Hello" }'
composio execute GMAIL_SEND_EMAIL --get-schema        # what inputs it needs, without running
composio execute GITHUB_CREATE_ISSUE -d @issue.json   # args from a file
```

- `link` opens the browser for OAuth authorization and waits for
  confirmation. `--alias` is required when creating an additional
  account for the same toolkit. `--list` lists existing connected
  accounts for the toolkit instead of creating a new link.
- `search` takes one or more semantic use-case queries. `--toolkits`
  filters by toolkit slugs, comma-separated. `--limit` is 1–1000.
- `execute` validates inputs against cached schemas and checks the
  connection automatically — "just try it and it will tell you what to
  fix." `--account` selects a connected account by alias, word id, or
  connected account id. `--file` injects a local file path into the
  single file-uploadable input. `--dry-run` validates and previews
  without executing. `--get-schema` prints the CLI-facing input schema
  without executing. `-p/--parallel` runs repeated `<slug> -d <text>`
  groups concurrently. `--skip-connection-check`,
  `--skip-tool-params-check`, `--skip-checks` skip the checks.
- `login` signs in to the Composio account (`composio login` with a
  human present; `composio login --agent` unattended). `run` scripts
  workflows in TypeScript. `dev` is scaffolding/playground/logs for
  building agents. `proxy` proxies tool calls.

### NF connection

Notchfolk's Composio tools are subprocess calls to the CLI:

- **Presence probe.** `shutil.which("composio")` — the domain is offered
  only when the CLI is on the machine. No CLI → the tools report
  "unavailable", not an error.
- **Auth.** Composio's OAuth (`composio login` once, `composio link
  <toolkit>` per account). **Never a bearer token in the keyring.**
  The user's OAuth grants live in Composio; Notchfolk never sees them.
- **Calling a tool.** Each Notchfolk Composio tool shells out to
  `composio execute <slug> -d '<json>' [--account <alias>]`, and reads
  the JSON result from stdout. `--dry-run` first when the call must be
  previewed; `--get-schema` when the inputs are unknown.
- **Finding the slug.** Slugs are **not hardcoded** in Notchfolk: the
  available slugs depend on which toolkits the user linked. Each tool
  resolves its slug at runtime via `composio search "<use case>"
  --toolkits <toolkit>` (and caches the result in the machine's own
  config). The examples in this section (`GMAIL_SEND_EMAIL`,
  `GITHUB_CREATE_ISSUE`) show the **shape** of a slug and a call — they
  are the CLI's own documented examples, not the mail/drive slugs.
- **The hosted MCP endpoint is not used.** Composio also exposes
  `https://connect.composio.dev/mcp` (Streamable HTTP) — that is the
  path other integrations use, and it is the only cloud piece in the
  whole set. Notchfolk does not use it: Notchfolk's Composio tools call
  the **local CLI**, and the CLI talks to the cloud. That is the one
  cloud-touching value, and the boundary is explicit: the CLI is the
  only process that leaves the machine.

### Call shape — the 8 tools

| Notchfolk tool | CLI call pattern |
|---|---|
| `composio_search_mail` | `composio search "search mail" --toolkits gmail` → `composio execute <search-slug> -d '<query json>'` |
| `composio_read_mail` | `composio execute <read-slug> -d '<message id json>'` |
| `composio_search_drive` | `composio search "search drive files" --toolkits google_drive` → `composio execute <search-slug> -d '<query json>'` |
| `composio_read_drive_file` | `composio execute <read-slug> -d '<file id json>'` (use `--file` to inject a local path into a file-uploadable input) |
| `composio_send_mail` | `composio execute <send-slug> -d '<recipient, subject, body json>' [--account <alias>]` |
| `composio_delete_mail` | `composio execute <delete-slug> -d '<message id json>'` |
| `composio_share_drive_file` | `composio execute <share-slug> -d '<file id, share json>'` |
| `composio_write_drive_file` | `composio execute <write-slug> -d '<file json>'` (use `--file` for a local file) |

Read-only tools (`search_mail`, `read_mail`, `search_drive`,
`read_drive_file`) run on the default read-only key. Restricted tools
(`send_mail`, `delete_mail`, `share_drive_file`, `write_drive_file`)
need their scope. A call with no linked account fails at the CLI's
connection check, with the CLI telling the user what to fix
(`composio link <toolkit>`).

## 7. Software like ArtCraft

Value: the world can make visual things, through creative software.
Conditional: present only when needed. Its tool list is **TBD** — it
will be defined when a specific application is named, from what that
application actually exposes. No tools are defined in this document for
it. (Same rule as the spec: no tools are invented.)

## Out of scope

NotebookLM, Multica, REA, A2A — as the spec says. A2A is Galih's
personal MCP; it stays his.
