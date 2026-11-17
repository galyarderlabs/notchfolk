# Notchfolk data and network

What is kept where, and what leaves your computer. Also see [SECURITY.md](../SECURITY.md) and the [MCP guide](mcp.md).

## Data & network

Notchfolk has no Notchfolk-operated server and no telemetry; your clipboard history, reminders,
events, timer, app usage, the assistant's chats and the machine's vitals (sampled from
`/proc`, `sysfs` and `df` every 2 s, kept on this computer only) stay in `~/.local/share/notchfolk`, and
speech is recognised on this computer. It goes online only for synced lyrics
([LRCLIB](https://lrclib.net)) and cover art, once per song (lyrics can be
turned off in Settings); your Claude plan's usage (`api.anthropic.com`, with
Claude Code's own sign-in); a look for a newer Notchfolk on GitHub at most once a
day (also in Settings); the speech model, downloaded once from Hugging Face
when you set up voice; and the voice assistant, whose requests go to the AI
you picked and may include a web search by it. A meeting's link is read
from the event on this computer, and only opened when you click Join.
Sharing the Shelf with your phone runs a small web server on your local
network only while you share: a secret address in the QR code, your Allow on
the island for each phone (matching the code it shows), the Shelf's files and nothing else, and it stops
after 10 idle minutes, on Stop, or when the screen locks
([how it is kept safe](../SECURITY.md#sharing-the-shelf-with-a-phone)).
Copies from password managers
are never kept, and only GNOME Shell may read the clipboard history from
Notchfolk's service or steer its assistant. The call preview is drawn by GNOME
Shell from what is on screen and never recorded.

The optional MCP service is off until you set it up and enable it. It offers
read tools and enables only the writes you list in `~/.config/notchfolk/mcp.env`;
it listens on loopback by default. Food and water logs stay on this computer
in `~/.local/share/notchfolk/calories.json` and `~/.local/share/notchfolk/water.json`.
Custom instructions in Settings → Assistant are sent with requests to Claude
Code and Codex; Antigravity manages its own personality. See the
[MCP setup guide](mcp.md) for remote access and write permissions.
[SECURITY.md](../SECURITY.md#what-leaves-your-computer) lists exactly what is
sent where, and the assistant's safety rules.
