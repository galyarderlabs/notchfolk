<div align="center">

![Notchfolk — a little world in your notch](docs/images/banner.png)

Your desktop notch, alive — GNOME today, Windows and macOS next. Music with synced lyrics, calls, a focus timer, calendar, food and water tracking, prayer times, weather, a file shelf, app usage, phone integration, and AI agents (Hermes, Claude Code, Grok, Codex, OMP) through a built-in MCP server — with AI router analytics and subscription usage quota tracking.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
![GNOME Shell 46–51](https://img.shields.io/badge/GNOME%20Shell-46%E2%80%9351-4a86cf.svg)
![Rust 1.92+](https://img.shields.io/badge/Rust-1.92%2B-orange.svg)
[![MCP Enabled](https://img.shields.io/badge/MCP-Enabled-8A2BE2.svg)](https://modelcontextprotocol.io)
[![Voice](https://img.shields.io/badge/Voice-Cloud%20or%20Local%20Whisper-success.svg)](https://github.com/ggerganov/whisper.cpp)
[![Sponsor](https://img.shields.io/badge/sponsor-support-ff69b4?logo=githubsponsors)](https://github.com/sponsors/galyarderlabs)

Notchfolk turns the centre of the top bar into a black notch. At rest, the
clock sits in the middle with what's running beside it — a song, a call, a
timer. Rest the pointer on it and it springs open into a small panel with
tabs for each page.

</div>

## Features

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/images/music.png" alt="Music page: Little Dark Age by MGMT at 2:08" width="100%"><br>
<b>Music.</b> Spotify, YouTube in your browser, or any MPRIS player: cover, scrubber and controls, with the playing app's icon on the cover. Volume and output switching one click away.
</td>
<td width="50%" valign="top">
<img src="docs/images/lyrics.png" alt="Synced lyrics: the line being sung large and bright, Little Dark Age by MGMT" width="100%"><br>
<b>Synced lyrics</b> from <a href="https://lrclib.net">LRCLIB</a>: the line being sung large and bright, pauses as breathing dots; click a line to jump. The island widens and takes the cover's colour.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/call.png" alt="A Telegram voice call in the island: 0:08, with Mute and Open" width="100%"><br>
<b>Calls</b> in WhatsApp, Telegram, Zoom, Meet and other call apps, or call pages in a browser: a green phone in the closed island, the call's length on the Call page. Open it to watch live while you work elsewhere, mute, or jump back to the call.
</td>
<td width="50%" valign="top">
<img src="docs/images/timer.png" alt="Timer page: the ring at 40:42, Work 60 and Break 15, with Pause" width="100%"><br>
<b>Timer.</b> A Pomodoro timer with breaks and Do Not Disturb while you focus: a ring with the time left, work and break lengths to type or step with − and + (locked from Start until Reset). Its time left stays in the closed island; beside a song or a call it shows as a small ring.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/reminders.png" alt="Reminders page: 1/1 tasks completed, with a checked task" width="100%"><br>
<b>Reminders</b>, with the number still open beside the list: add tasks, rename in place, tick to finish — done ones clear at midnight. A long title wraps as far as it needs.
</td>
<td width="50%" valign="top">
<img src="docs/images/clipboard.png" alt="Shelf: clipboard history of images, with their sizes" width="100%"><br>
<img src="docs/images/files.png" alt="The files tray with six files, full" width="100%"><br>
<img src="docs/images/phone.png" alt="Shelf on your phone: scan the QR code to access the shelf files" width="100%"><br>
<img src="docs/images/devices.png" alt="Devices: galyarder connected via GSConnect, battery 50%, not charging, with Ring phone and Send clipboard" width="100%"><br>
<b>Shelf.</b> Clipboard history of text, links, images and files — search, filter, pin; Super+V to paste. Files tray: drop up to 6 files on the island, drag them into any app or click to copy. Phone: scan the QR to save shelf files on your phone or send files back, in the browser, same Wi-Fi, nothing through the internet.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<b>Weather.</b> Choose a city in Settings, or follow the GNOME World Clock nearest your time zone. See current conditions, humidity, wind, sunrise and sunset, an hourly curve colored by each forecast condition, and the five-day forecast. Nearby earthquakes use BMKG in Indonesia and USGS elsewhere; USGS fills in when BMKG has no nearby recent event. The closed island stays quiet.
</td>
<td width="50%" valign="top">
<img src="docs/images/calendar.png" alt="Calendar: November 2026 beside today's events, R&D OAA and Design GBots" width="100%"><br>
<b>Calendar.</b> The month beside the chosen day's events, from your desktop calendars (Google and others through Online Accounts). Add an event in one line: "Dinner 8:00 pm". A reminder 5 minutes before, with <b>Join</b> for Meet, Zoom, Teams or Webex. World clocks underneath.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/notifications.png" alt="Notifications: a Telegram notification, with Clear" width="100%"><br>
<b>Notifications.</b> GNOME's notifications as a plain list, newest first, with their buttons under the pointer, Clear, and Do Not Disturb a click away.
</td>
<td width="50%" valign="top">
<img src="docs/images/voice.png" alt="Install vlc running in the closed island" width="100%"><br>
<b>Voice assistant.</b> Press Super+I and ask, in English or Indonesian: play a song, find a file, add a reminder. It works as an agent: a request with several steps is done one after another, each step checked, with the AI you already use (Claude Code, Codex, Grok, Hermes, Oh My Pi, opencode or Antigravity).
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/command.png" alt="The install command running: sudo pacman -S --needed vlc, asking to proceed" width="100%"><br>
<b>Installs and fixes things.</b> "Install LibreOffice", "pasang codex": it checks what your Linux has, searches the web when unsure, and shows the one command it wants to run, with what to know first. Press <b>Run</b> or <b>Deny</b>. It runs in the background while you carry on, and the assistant checks it worked before saying so.
</td>
<td width="50%" valign="top">
<img src="docs/images/conversation.png" alt="Chatting with the AI: asking where Notchfolk runs" width="100%"><br>
<b>Speak or type, and talk it through.</b> It listens as soon as it opens; start typing to type instead. Scroll up for the conversation so far; select text to copy it, + for a new one. The bot turns to the pointer, blinks, and bounces as you speak; close the island and it carries on in the background.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/bot-looks.png" alt="The bot in eight shapes and several colours, with matching glows" width="100%"><br>
<b>A bot of your own.</b> Eight shapes, from a circle to a cloud or a ghost, eleven colours or your own, softly shaded, and a glow round the island that matches it.
</td>
<td width="50%" valign="top">
<img src="docs/images/usage.png" alt="AI usage: Claude Max, 5 hours 42% (resets in 2h 18m), Week 18% (resets in 4d)" width="100%"><br>
<b>AI usage.</b> How much of your Claude and ChatGPT plan limits is used: one plan at a time with its logo, a bar per limit and when each resets; scroll or click the dots to switch. A warning comes as one nears its end; only plans you're signed in to show.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/prayer-alert.png" alt="Prayer alert: Dzuhur, it's time to pray in Bogor, 11:36" width="100%"><br>
<b>Alerts</b> for volume, brightness, Caps Lock, charging, low battery, Bluetooth battery, going offline, reminders, meetings about to start, AI plan limits and GNOME notifications with their buttons — in the same place instead of the middle of the screen. Hold the pointer on one to keep it; × or swipe up to put it away.
</td>
<td width="50%" valign="top">
<img src="docs/images/approvals.png" alt="Notchfolk wants to run sudo pacman -S --needed vlc, with Deny and Run" width="100%"><br>
<b>AI agents.</b> When Claude Code or Codex asks permission to run something, answer from the island: <b>Deny</b>, <b>Allow</b> or, for Claude Code, <b>Always</b>. When one is done, the island says what it did. Nothing shows while you are in its window.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/apps.png" alt="App usage: Firefox 1h 36m today, then ChatGPT, Muse and Files" width="100%"><br>
<b>App usage.</b> Where your time goes: the app in front today, over the last seven days, or the last 30, with its icon, a bar and its time. Off until you turn it on; five idle minutes pause it, locking the screen stops it; kept on this computer for 30 days.
</td>
<td width="50%" valign="top">
<img src="docs/images/glass.png" alt="The conversation in the glass island, the desktop behind it showing through, blurred" width="100%"><br>
<b>Glass.</b> The island in clear dark glass instead of black, if you prefer: what is behind it shows through, blurred, as you work. Choose it in Settings → Appearance → Island.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/router.png" alt="Router: 3,786 requests, 68M / 2.7M tokens, $37.11 estimated cost, connected" width="100%"><br>
<img src="docs/images/router-settings.png" alt="Router settings: Local or Remote connection, Base URL, proxy API key, period" width="100%"><br>
<b>Router.</b> What your AI gateway reports: requests, tokens in and out, its cost estimate, the top models as bars, and the last ten requests. A health dot once connected; off by default.
</td>
<td width="50%" valign="top">
<img src="docs/images/calories.png" alt="Calories: today's intake 650 of 2,000 kcal, with a meal logged" width="100%"><br>
<img src="docs/images/water.png" alt="Water: 0.8 of 2.0 L today, with the intake chart" width="100%"><br>
<img src="docs/images/prayer.png" alt="Prayer: Dzuhur next at 11:36, with the day's prayer times" width="100%"><br>
<b>Everyday tools.</b> Water and calories logged through the day, and prayer times for your city, all kept on this computer.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/mcp-settings.png" alt="MCP settings: access scopes, remote access with a public hostname, and the tunnel setup" width="100%"><br>
<img src="docs/images/mcp-app.png" alt="NotchFolks in the ChatGPT Apps directory" width="100%"><br>
<b>MCP server.</b> An optional MCP server for agents outside Notchfolk: read tools for your data and actions, writes only what you list in <code>~/.config/notchfolk/mcp.env</code>, on loopback by default and remote access through an authenticated tunnel. Beyond the island's own data, the world domains: <b>System</b> (the machine itself — stats, logs, files, processes, updates, the sharp tools behind their own scope), <b>Browser</b> (the web through a real browser: Camoufox, or your own Chromium over CDP) and <b>Memory</b> (the Hindsight engine's 39 tools — what the agent learns, kept across conversations). A domain whose backend is absent is not offered at all; a restricted tool is not even visible to a key without its scope.
</td>
<td width="50%" valign="top">
<img src="docs/images/more-ais.png" alt="The AI picker: Claude Code, Codex, Hermes Agent, OpenAI-compatible API, Oh My Pi, opencode, Antigravity" width="100%"><br>
<img src="docs/images/more-ais-omp.png" alt="Oh My Pi selected, with Custom instructions for its identity" width="100%"><br>
<b>More AIs.</b> The assistant also runs Hermes and Oh My Pi with the providers they are configured for, plus any OpenAI-compatible API.
</td>
</tr>
</table>

Also: privacy dots while the camera, microphone or screen sharing is in use,
a recording timer with a stop button, and a slim glass top bar that leaves
your windows uncovered.

## Requirements

- **GNOME Shell 46 to 51** (Ubuntu 24.04 to 26.10, Fedora 40 to 45,
  Debian 13, …), on a 64-bit Intel or AMD PC (x86_64). Check with
  `gnome-shell --version`.
- `curl`, which most systems have (if not: `sudo apt install curl`). Install
  Notchfolk as yourself, not with `sudo`.
- For the voice assistant (optional): a microphone and
  one of Claude Code, Codex, Grok, opencode or Antigravity signed in (Codex and the npm
  install of Claude Code need Node.js 18 or newer); see
  [assistant guide](docs/assistant.md). To have the answers spoken aloud, `ffmpeg`
  (`sudo pacman -S ffmpeg`, `sudo apt install ffmpeg`), which turns the router's audio
  into what `pw-play` plays.

## Installation

1. Run this in a terminal:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/galyarderlabs/notchfolk/main/get.sh | bash
   ```

2. **Log out and back in**: GNOME Shell on Wayland only loads a new
   extension at login (on GNOME 46 to 48 with X11, press Alt+F2, type `r`
   and press Enter instead).

That's all. The script downloads the latest release, checks it, and installs
it for your user only: no root, no compiler and no cloning needed. Run the
same command again to update; your settings stay as you set them.

The [installation guide](docs/install.md) goes through it step by step, with
updating, uninstalling, installing offline and what to do if the island does
not appear.

> [!NOTE]
> The installer never changes other extensions. When one would fight with
> the island (Blur my Shell's top bar blur, or an extension that takes the
> same place in the top bar), it says so and how to turn that off. Notchfolk's
> look is the same on every desktop: a slim top bar with no colour of its
> own, and the island as a black notch.

## Documentation

- [Usage and settings](docs/usage.md) — every gesture and shortcut, the
  Settings pages, troubleshooting and uninstalling
- [Assistant guide](docs/assistant.md) — the voice assistant, the AIs it
  runs (Claude Code, Codex, Grok, Hermes, Oh My Pi, opencode, Antigravity),
  agent approvals and AI plan usage
- [Installation guide](docs/install.md) — step by step, packages, AUR,
  offline install and other ways to install
- [MCP server](docs/mcp.md) — the optional MCP server and its permissions
- [Data and network](docs/data-and-network.md) — what is kept where and what
  leaves your computer; also [SECURITY.md](SECURITY.md)
- [How it works](docs/how-it-works.md) — the moving parts, D-Bus interfaces
  ([dbus-api.md](docs/dbus-api.md)) and resource usage

## Contributing

Bug reports, ideas and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test and send changes,
and [CHANGELOG.md](CHANGELOG.md) for what changed. Everyone taking part
follows the [Code of Conduct](CODE_OF_CONDUCT.md); please report security
problems privately as described in [SECURITY.md](SECURITY.md).

### Author

- [@muhamadgalihsaputra](https://github.com/muhamadgalihsaputra) — Galih:
  Notchfolk itself. Every change since the fork of Isle — the quiet island,
  the Weather page, the world MCP — and the direction behind them.

### Contributors

Thanks to everyone who has made Notchfolk better:

- [@caffeinepx](https://github.com/caffeinepx): Grok in the voice assistant
  and on the AI usage page; music from Zen and Firefox that keeps its place;
  a sun or a moon by each World Clock.
- [@Ashishranjan980](https://github.com/Ashishranjan980): the Apps page, where
  your time in each app goes.
- [@daotheone](https://github.com/daotheone): the DeepSeek request that became
  the assistant's shared endpoint rows — one Base URL and one API key, in
  Settings instead of a file.

## Support

Notchfolk is free and always will be. If it makes your desktop nicer, you can
[sponsor Galyarder Labs on GitHub](https://github.com/sponsors/galyarderlabs).
A star, a bug report or telling a friend helps just as much.

## License

Notchfolk is a modified version of [Isle](https://github.com/zickrian/isle) by
zickrian, used under GPL-3.0-or-later. Copyright © 2026 zickrian for the
upstream work; Copyright © 2026 Galyarder Labs for the modifications — both
published under the same licence.

Notchfolk is free software: you can redistribute it and/or modify it under the
terms of the [GNU General Public License](LICENSE) as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE)
for more details.

The bundled [Inter](https://rsms.me/inter/) typeface (`data/fonts`) is under
the [SIL Open Font License 1.1](data/fonts/Inter-LICENSE.txt). Lyrics come
from [LRCLIB](https://lrclib.net). The Claude and OpenAI logos on the AI usage page
come from [Simple Icons](https://simpleicons.org) (CC0); they are trademarks of
Anthropic and OpenAI, shown only to name their plans. The assistant's face
takes its expressions from [bloub](https://github.com/jeremy-prt/bloub) by
Jérémy Perret, under the MIT License
([notice](gnome-extension/NOTICE-bloub.txt)). The calendar icon takes its shape
from [Lucide](https://lucide.dev)'s "calendar-days", under the ISC License
([notice](gnome-extension/NOTICE-lucide.txt)).

---

<div align="center">

[![Give Notchfolk a star](docs/images/footer.png)](https://github.com/galyarderlabs/notchfolk)

</div>

