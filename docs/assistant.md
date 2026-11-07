# The Notchfolk assistant

The voice assistant and AI usage, in detail. For runtime setup (Hermes, OMP, MCP), see the [assistant runtimes guide](assistant-runtimes.md).

## Voice assistant

Press **Super+I** (or the mic in the open island) and speak. The island
listens until you pause, turns your words into text **on this computer**,
then asks the AI you picked; it shows each step ("Searching ~/Downloads for
“signature”…") and does what the answer asks.

It works as an **agent**: a request with several steps ("open Firefox, then
put it on the left", "find my CV and open it", "open Spotify, play some
jazz and turn the volume down to 30") is done one step after another, each
step seeing what the last one did (whether the app opened, which windows
are there). You can **close the island while it works**: it carries on in
the background, with a small mic in the closed island, and the answer comes
as an alert; click the island or press Super+I to watch it, and **Stop** to
end it. Its answer's own actions run before it answers, so it never
says "done" when a step failed: it tries another way, or says what did not
work.

**What it does:** music (play, pause, a given song on Spotify), apps and
windows (open, switch to, close, minimize, fullscreen, put side by side or
in a 2×2 grid: "split Chrome and VS Code 50/50"), files and folders
(find, open, show in Files), reminders, to-dos and calendar events (add,
change, remove), Wi-Fi, Bluetooth, Do Not Disturb, volume, brightness, dark
mode, Night Light, settings panels, screenshots, writing text where your
cursor is, answering questions (with a web search when it needs fresh
facts), telling you what makes the computer slow, and installing, removing
or fixing software with a command you approve. Ask a follow-up while the
answer shows, or later the same day: it remembers the conversation (see
[the conversation](#the-conversation)).

Notchfolk also provides an optional MCP server for agents outside Notchfolk. Its tool
set covers Notchfolk's data and actions (daily life, media, focus, shelf, clipboard
search, system, AI usage); keys, scopes and remote access are managed in
Settings → MCP or with `notchfolk-mcp-keygen` and `notchfolk-mcp-tunnel`. See
[the MCP server guide](mcp.md) for setup and permissions. See
[assistant runtime setup](assistant-runtimes.md) for Hermes, OMP, and MCP.
See [assistant platform status](assistant-platform-status.md) for implemented features and remaining verification.

**Installing and fixing things.** Ask "install LibreOffice" and it looks
first: which Linux this is, which ways to install it has (apt, dnf, pacman,
zypper, Flatpak, Snap, npm), whether the app is already there, and when
unsure, the vendor's own instructions on the web. Then the island shows a
card with the one command it proposes, why, and what to know about it:
**Needs your password** (it runs as root), **Runs a script from the web**,
or **Removes files or apps**. Press **Run** (Enter) or **Deny** (Esc); with
the island closed, the card comes as an alert. A command runs in the
background as a systemd unit of its own, so you can close the island or
lock the screen, and Notchfolk follows it to its end, even after notchfolkd restarts
(a command still running when you log out ends with your session); the card
shows how long it has run and its last lines, and **Stop** ends it (for a
package manager, press it twice: stopping one halfway can leave things half
done). When it ends, the assistant checks that it worked (`libreoffice
--version`) before saying so; denied, it does not try again. One command
runs at a time, and nothing waits forever: an unanswered card is denied
after 10 minutes, and a command is stopped after 30.

**Set up:**

1. Install and configure one AI command-line app (accounts, API keys, or
   providers depend on the app):

   | AI | Install | Set up | Notes |
   |---|---|---|---|
   | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `curl -fsSL https://claude.ai/install.sh \| bash` (or `npm i -g @anthropic-ai/claude-code`) | run `claude` | Uses your Claude plan; Sonnet by default; Haiku is the fastest but follows the request's language and tools less reliably |
   | [Codex](https://github.com/openai/codex) (ChatGPT) | `npm i -g @openai/codex` | `codex login` | How Notchfolk uses ChatGPT: your ChatGPT plan (Free works too, with lower limits), with the model your Codex uses |
   | [Oh My Pi](https://github.com/can1357/oh-my-pi) | `curl -fsSL https://omp.sh/install \| sh` (or `bun install -g @oh-my-pi/pi-coding-agent`) | run `omp` and configure its provider | Notchfolk uses OMP's configured provider and default model; in Settings, leave the model blank to use that default |
   | [Grok](https://x.ai/build) | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` | Uses your Grok plan (Free works too); Notchfolk runs it in its own folder, kept to answering |
   | [opencode](https://opencode.ai) | `curl -fsSL https://opencode.ai/install \| bash` | `opencode auth login` | Uses the providers you signed in to in opencode (your own API keys or subscriptions), with the model your opencode uses; Notchfolk runs it in its own folders with every tool but web search turned off. No usage page: the providers bill you directly |
   | [Antigravity](https://antigravity.google) | its installer | run `agy` | Its terms bar third-party tools from the service; Notchfolk only runs the official `agy`, at your own risk |

   For plan-backed assistants, Settings → Assistant lists the models your plan includes, by their full
   names, along with the plan name. If a subscription stops including the picked model, Notchfolk uses the
   plan's default and says so once, then restores the pick when it is available again. OMP uses its own
   configured default unless you enter a manual model ID. Claude's Fable models are not offered: they
   would use your usage credits without asking.
   opencode shows your OpenCode plan (Free models, OpenCode Zen or OpenCode Go; Go Plus and Go Teams
   show as Go, as they include the same models) and offers only: the models you used last in opencode,
   OpenCode's free models, and your plan's (Zen's, or Go's as OpenCode Go lists them now). Every one is a
   model `opencode models` lists for you; nothing else is offered. It needs no sign-in for the free
   models. Notchfolk uses only what you signed in to with `opencode auth login` (opencode 1.4.8 or newer):
   custom providers in your own `opencode.json` (a local Ollama, say) and API keys kept only in
   environment variables are not used.

2. Speech recognition needs no setup when the cloud engine is on (the default):
   **Settings → Assistant → Speech recognition → Cloud (OpenAI-compatible router)** sends each
   recording to the router's `/v1/audio/transcriptions`, with its base URL, model and API key set in
   Settings — nothing is assumed, not even the router; the key is kept in the desktop's secret store,
   never in a plain file. The endpoint paths (`audio/transcriptions`, `audio/speech`) are editable too, for a
   router that names its own. Local Whisper takes over by itself when the router cannot be reached (or is
   not configured), and **Local Whisper (offline)** in Settings makes it the only engine.

   **Speak the replies** sends each answer to the router's `/v1/audio/speech` as well as showing it, so
   the assistant answers out loud. It needs a text-to-speech model, a voice and the same API key as
   speech recognition; with the model or the voice blank, nothing is spoken and the answer is only
   shown. The model and the voice are the router's own names, and a router that names its voices in
   the model id takes them as one: `el/eleven_multilingual_v2` with voice `hpp4J3VqNfWAUOO0d1Us` is
   sent as `el/eleven_multilingual_v2/hpp4J3VqNfWAUOO0d1Us`, which is what ElevenLabs-shaped routers
   expect. What comes back is usually MP3 whatever was asked for, so Notchfolk decodes it with
   `ffmpeg` into a WAV in your runtime folder and plays that with `pw-play`; without `ffmpeg`
   installed the reply is shown but not spoken, and the log says so
   (`journalctl --user -u notchfolkd | grep -i speak`). A router that answers with an error speaks
   nothing and names the URL it tried, with how long it waited.

3. Set up local speech recognition, once: press **Set up** when the assistant asks
   for it, or run `~/.local/bin/notchfolk-setup-voice` in a terminal (`notchfolk-setup-voice` with a .deb,
   .rpm or AUR package; from the source folder: `scripts/setup-voice.sh`). It downloads the speech
   model chosen in Settings, `small` by default (265 MB; `tiny` 44 MB, `base`
   82 MB, `medium` 823 MB; `notchfolk-setup-voice base` names one and picks it in
   Settings), which `notchfolk-whisper` runs with
   [whisper.cpp](https://github.com/ggml-org/whisper.cpp): nothing else to
   install. On a computer with a graphics card (NVIDIA, AMD or Intel Arc,
   through Vulkan) it runs there, in about a second; otherwise on the
   processor, in several seconds (it needs AVX2: Intel since 2013, AMD since
   2015). An older Notchfolk's Python environment (up to 3 GB) is no longer
   needed: updating Notchfolk moves you over and deletes it by itself, or run
   `notchfolk-setup-voice --remove-old`.
4. Pick the AI in **Settings → Assistant**, or leave it on Automatic, which
   uses the first one signed in: Claude Code, Codex, Grok, Hermes, OpenAI-compatible
   API, Oh My Pi, opencode, then Antigravity. Select Oh My Pi explicitly when you
   want the Notchfolk assistant to use OMP. An AI installed later is found by itself.
5. Check with `~/.local/bin/notchfolkd --doctor` (`notchfolkd --doctor` with a
   package): it lists speech recognition (the models downloaded, and the GPU
   or processor it runs on) and each AI's installation and setup status as
   Notchfolk can determine it. OMP's provider authentication is managed by OMP.
   Notchfolk finds AIs installed with npm (also a prefix of your own), nvm,
   volta, fnm, pnpm, bun, Homebrew, mise, asdf, Nix or their own installers,
   and takes what your login shell sets for them (`CLAUDE_CONFIG_DIR`,
   `CODEX_HOME`, an API key, a proxy), as code editors do.

Without any of them, Super+I says what to install, and the rest of Notchfolk works
as before.

**Safety:** Notchfolk's desktop actions and command cards follow the permissions
below. OMP's native tools stay enabled and follow the permissions you set in
OMP; they are separate from Notchfolk's command cards. In an Notchfolk session, OMP
uses `always-ask`: read-only tools can run, and write or execution tools ask
through Notchfolk's Allow / Deny alert. Notchfolk preserves OMP's explicit deny rules
and changes an explicit `bash: allow` to `prompt` for that session, so shell
commands can be approved in Notchfolk. The global OMP config is not edited.
Dismissing the alert or being unable to show it denies the request. Other
interactive UI requests from OMP extensions are cancelled. Review OMP's tool
permissions before using it. Claude Code, Codex, and Antigravity use the
restricted tools described below.

- **Looking** runs at once, without asking, but only programs on a fixed
  list that only read (`uname`, `cat /etc/os-release`, `apt-cache policy`,
  `dpkg -s`, `rpm -q`, `dnf info`, `pacman -Qi`, `flatpak list`, `snap
  info`, `npm view`, `which`, `<program> --version`, `df`, `free`…), each run
  directly with its arguments, never through a shell, and never with an
  option that would install, remove or change anything.
- **Changing** anything is a command you see in full and run yourself with
  **Run**. Notchfolk starts exactly the command on the card and nothing else
  (GNOME Shell checks this before starting it); one that needs root asks
  with GNOME's password dialog, gets only the system's own folders on its
  `PATH`, and its output is written to its log as you, not as root. Commands
  that would wipe the system (`rm -rf /` or your home folder, `mkfs`, `dd`
  onto a disk, a fork bomb) are refused before you are even asked.
- **Files:** Notchfolk searches your files by name for it, reads small text
  files you ask about, opens documents and media but never programs, and
  never looks in hidden folders that hold keys or passwords (`.ssh`,
  `.gnupg`, keyrings), even through a link. Secrets in a command's output
  (keys, tokens, passwords) are blanked before the AI sees it.
- Text from other apps (your selection, notifications, window titles, a
  command's output, web pages) is passed as data, never as instructions.

**Resources:** the speech model runs only while you speak (on at most half
the processor's cores) and quits once your words are text. The AI starts as
you open the assistant, so it answers sooner, and quits 3 minutes after
your last request, taking anything it started with it. Both run at a lower
priority than your apps, so the desktop stays smooth while they work.

### The conversation

What you said and what it answered show as a conversation: scroll up on
the assistant, or click the line above the field. Select text to copy it,
click a command to copy that. **+** starts a new conversation; **Undo**
brings the last one back for 5 seconds. A conversation is kept until
midnight at the latest, or until it has been quiet for 30 minutes or 2
hours if you choose so in Settings; then it is deleted, with the AI's own
copy of it. **Settings → Assistant → Clear the conversation now** deletes it
at once. Your voice is never kept: the recording lives in memory only until
it is text. The conversation is kept in `~/.local/share/notchfolk/chat.json`,
readable by you alone, and the AI's copy apart from your own chats with it.

## AI usage

Notchfolk finds your plans from the apps you are signed in to: **Claude** with
Claude Code's sign-in, and **ChatGPT** with Codex's.
It shows each limit your plan has (a 5-hour window, the week, a model's
week), when it resets, and warns at 80% and 95% (set in Settings). A plan
you are not signed in to does not show at all.

Claude's numbers come from the same page Claude Code's `/usage` reads, and
ChatGPT's from the one Codex's `/status` reads; neither is a documented API,
so they may change. Notchfolk asks each every ten minutes (at
most every two while the Usage page is open), and not while the screen is
locked. Offline, as at login before the
network is up, it tries again within a minute; when Claude's server fails it
waits longer each time. It never signs in or refreshes a sign-in itself, and
with usage turned off it asks nothing at all. When ChatGPT can't be asked
(offline, or Codex's sign-in ran out), its numbers come from Codex's own
logs, as of your last use of Codex.

**AI agents.** Notchfolk connects to Claude Code and Codex when it finds them,
also when you install one later, and says so once. It adds its hooks to
`~/.claude/settings.json` (PermissionRequest, Notification and Stop) and to
`~/.codex/hooks.json` (PermissionRequest and Stop); Codex asks once, at its
next start, whether to trust them (or trust them in `/hooks`), and a Codex
older than 0.124 gets `notify` in its `config.toml` instead, for done
alerts only. Each hook runs `notchfolkd --agent-hook`, which asks the island and
waits for your answer. With no answer (the alert put away, the agent's
window in front, Do Not Disturb, notchfolkd not running) it says nothing, and the
agent asks in its terminal as it would without Notchfolk; answering in Claude
Code's terminal first takes the alert away. **Always** keeps the rule
Claude Code itself suggests, where it suggests it (usually the project's
`.claude/settings.local.json`). Your own hooks and settings are kept as they
are; turning a switch off in **Settings → AI Usage → AI Agents**, or
uninstalling Notchfolk, takes out Notchfolk's entries only. Nothing leaves the
computer.
