<div align="center">

![Notchfolk — a little world in your notch](docs/images/banner.png)

Your desktop notch, alive — GNOME today, Windows and macOS next. Music with synced lyrics and karaoke, calls, a focus timer, calendar, food and water tracking, prayer times, weather, system vitals, a file shelf, app usage, phone integration, and AI agents (Hermes, Claude Code, Grok, Codex, OMP) through a built-in MCP server — with AI router analytics and subscription usage quota tracking.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
![GNOME Shell 46–51](https://img.shields.io/badge/GNOME%20Shell-46%E2%80%9351-4a86cf.svg)
![Rust 1.92+](https://img.shields.io/badge/Rust-1.92%2B-orange.svg)
[![MCP Enabled](https://img.shields.io/badge/MCP-Enabled-8A2BE2.svg)](https://modelcontextprotocol.io)
[![Voice](https://img.shields.io/badge/Voice-Cloud%20or%20Local%20Whisper-success.svg)](https://github.com/ggerganov/whisper.cpp)
[![Sponsor](https://img.shields.io/badge/sponsor-support-ff69b4?logo=githubsponsors)](https://github.com/sponsors/galyarderlabs)

Notchfolk turns the centre of the top bar into a black notch. At rest, the
clock sits in the middle with what's running beside it — a song, a call, a
timer. Rest the pointer on it and it springs open into a small panel with
tabs for each page; pin it open to keep it there while you work elsewhere.

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/images/pill.png" alt="The closed island as a floating pill: avatar, time, mascot, date, signal" width="100%"><br>
</td>
<td width="50%" valign="top">
<img src="docs/images/notch.png" alt="The closed island as a notch attached to the top edge: avatar, time, mascot, date, signal" width="100%"><br>
</td>
</tr>
</table>

</div>

## Features

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/images/music.png" alt="Music page: Merry Christmas, Please Don't Call by Bleachers at 0:15, with Karaoke" width="100%"><br>
<b>Music.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/lyrics.png" alt="Synced lyrics: the line being sung large and bright, Little Dark Age by MGMT" width="100%"><br>
<b>Synced lyrics.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/call.png" alt="A Telegram voice call in the island: 0:08, with Mute and Open" width="100%"><br>
<b>Calls.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/timer.png" alt="Timer page: the ring at 40:42, Work 60 and Break 15, with Pause" width="100%"><br>
<b>Timer.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/reminders.png" alt="Reminders page: 1/1 tasks completed, with a checked task" width="100%"><br>
<b>Reminders.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/clipboard.png" alt="Shelf: clipboard history of images, with their sizes" width="100%"><br>
Clipboard history<br>
<img src="docs/images/files.png" alt="The files tray: 13 of 14 files, click to copy or drag into any app" width="100%"><br>
Files tray<br>
<img src="docs/images/phone.png" alt="Shelf on your phone: scan the QR code to access the shelf files" width="100%"><br>
Shelf on your phone<br>
<img src="docs/images/devices.png" alt="Devices: galyarder connected via GSConnect, battery 50%, not charging, with Ring phone and Send clipboard" width="100%"><br>
Devices<br>
<b>Shelf.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/weather.png" alt="Weather page: Bogor conditions, hourly temperature chart, five-day forecast and a recent earthquake" width="100%"><br>
<b>Weather.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/calendar.png" alt="Calendar: November 2026 beside today's events, R&D OAA and Design GBots" width="100%"><br>
<b>Calendar.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/notifications.png" alt="Notifications: a Telegram notification, with Clear" width="100%"><br>
<b>Notifications.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/voice.png" alt="Voice assistant: the island asking “How can I help?”, with History" width="100%"><br>
<b>Voice assistant.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/command.png" alt="The install command running: sudo pacman -S --needed vlc, asking to proceed" width="100%"><br>
<b>Installs and fixes things.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/conversation.png" alt="Chatting with the AI: it remembers the unfinished filmcraft build after four hours" width="100%"><br>
Conversation<br>
<img src="docs/images/chat-history.png" alt="Chat history: past conversations with their message counts, New chat and Conversation" width="100%"><br>
Chat history<br>
<b>Speak or type, and talk it through.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/bot-looks.png" alt="The bot in eight shapes and several colours, with matching glows" width="100%"><br>
<b>A bot of your own.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/usage.png" alt="AI usage: Claude Max, 5 hours 42% (resets in 2h 18m), Week 18% (resets in 4d)" width="100%"><br>
<b>AI usage.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/prayer-alert.png" alt="Prayer alert: Dzuhur, it's time to pray in Bogor, 11:36" width="100%"><br>
<b>Alerts.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/approvals.png" alt="Notchfolk wants to run sudo pacman -S --needed vlc, with Deny and Run" width="100%"><br>
<b>AI agents.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/apps.png" alt="App usage: Firefox 1h 36m today, then ChatGPT, Muse and Files" width="100%"><br>
<b>App usage.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/glass.png" alt="App usage in the glass island: Ghostty 2h 54m today, the desktop behind it showing through, blurred" width="100%"><br>
<b>Glass.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/vitals.png" alt="Vitals page: CPU load with its sparkline, temperature, cores, memory and disk bars, network and uptime" width="100%"><br>
<b>Vitals.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/karaoke.png" alt="Karaoke in the closed island: the line being sung centred between the cover and the wave" width="100%"><br>
<b>Karaoke.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/router.png" alt="Router: 7,349 requests, 643.8M / 4.8M tokens, $54.53 estimated cost, connected" width="100%"><br>
Router<br>
<img src="docs/images/router-settings.png" alt="Router settings: Remote connection to router.niyatna.com, Compatible proxy API key saved in GNOME Keyring, Last 7 days period, Show on the notch on, connected" width="100%"><br>
Router settings<br>
<b>Router.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/calories.png" alt="Calories: today's intake 650 of 2,000 kcal, with a meal logged" width="100%"><br>
Calories<br>
<img src="docs/images/water.png" alt="Water: 0.8 of 2.0 L today, with the intake chart" width="100%"><br>
Water<br>
<img src="docs/images/prayer.png" alt="Prayer: Isya next at 19:04 in 42 minutes, with the day's prayer times on a sun arc" width="100%"><br>
Prayer<br>
<b>Everyday tools.</b>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/mcp-settings.png" alt="MCP settings: External AI agents, service running on 127.0.0.1:8765/mcp, client key folky with write scopes" width="100%"><br>
MCP settings<br>
<img src="docs/images/mcp-access-remote.png" alt="MCP settings: Access scopes with Read access and Write actions off, Remote access via Cloudflare Tunnel with public hostname" width="100%"><br>
MCP access<br>
<img src="docs/images/mcp-world.png" alt="The world: camofox browser backend, CDP port 9222, Hindsight endpoint, skill trees, OfficeCLI path" width="100%"><br>
The world<br>
<b>MCP server.</b>
</td>
<td width="50%" valign="top">
<img src="docs/images/more-ais.png" alt="The AI picker: OpenAI-compatible API selected, with the provider list open — Automatic, Claude Code, Codex, Hermes Agent, Oh My Pi, opencode, Antigravity" width="100%"><br>
The AI picker<br>
<img src="docs/images/more-ais-compatible.png" alt="OpenAI-compatible API selected, with model claude-mythos-5" width="100%"><br>
OpenAI-compatible API<br>
<img src="docs/images/more-ais-hermes.png" alt="Hermes Agent selected, with its endpoint at 100.85.83.76:8642/v1" width="100%"><br>
Hermes Agent<br>
<b>More AIs.</b>
</td>
</tr>
</table>

**Music.**
Your music in the island — cover, scrubber and controls.

| Do this | To |
|---|---|
| Play from Spotify, YouTube in your browser, or any MPRIS player | Cover, scrubber and controls, with the playing app's icon on the cover |
| Middle-click the notch | Play or pause |
| Right-click the notch | Bring the music player to the front |
| Click the other player's icon | Switch players, with two music players running |

**Synced lyrics.**
The line being sung, large and bright.

| Do this | To |
|---|---|
| Turn on lyrics online | Lyrics load from LRCLIB while songs play |
| Click a line | Jump to it |
| Play a song LRCLIB does not know | Shows "No lyrics found" |

**Calls.**
Your calls in the island.

| Do this | To |
|---|---|
| Take a call in WhatsApp, Telegram, Zoom, Meet or a browser call page | A green phone in the closed island, the call's length on the Call page |
| Open the call | Watch it live while you work elsewhere, mute, or jump back to the call |
| Right-click the notch | Bring the call to the front |

**Timer.**
A Pomodoro timer with breaks and Do Not Disturb while you focus.

| Do this | To |
|---|---|
| Type or step with − and + | Set the work and break lengths (locked from Start until Reset) |
| Press Start | The timer runs; Do Not Disturb stays on while you focus |
| Glance at the closed island | The time left stays there; beside a song or a call it shows as a small ring |

**Reminders.**
Tasks that clear themselves at midnight.

| Do this | To |
|---|---|
| Add a task | It joins the list, with the number still open beside it |
| Rename in place | Change a task's title |
| Tick a task | Finish it — done ones clear at midnight |

**Shelf.**
Clipboard, files and your phone, in the island.

| Do this | To |
|---|---|
| Press Super+V | Open the clipboard history with search ready; Enter pastes |
| Search, filter, pin | Find text, links, images and files you copied |
| Drag a file towards the notch | Open the files tray to drop it — as many as you set in Settings; a long row scrolls |
| Drag a file out of the tray, or click it | Drop it into any app, or copy it |
| Scan the QR | Save shelf files on your phone or send files back, in the browser, same Wi-Fi, nothing through the internet |
| Ring phone, Send clipboard | Reach your GSConnect phone from the Devices image |

**Weather.**
Your city's weather and the week ahead.

| Do this | To |
|---|---|
| Choose a city in Settings, or follow the GNOME World Clock | The forecast for that city, or the one nearest your time zone |
| Set the temperature's unit | Auto, Celsius or Fahrenheit |
| Open the page | Current conditions, humidity, wind, sunrise and sunset, an hourly curve colored by each forecast condition, and the five-day forecast |
| Look for earthquakes | Nearby ones from BMKG in Indonesia and USGS elsewhere; USGS fills in when BMKG has no nearby recent event |

**Calendar.**
The month beside the chosen day's events.

| Do this | To |
|---|---|
| Connect your desktop calendars | Google and others through Online Accounts |
| Type "Dinner 8:00 pm" | Add an event in one line |
| Wait 5 minutes before | A reminder, with Join for Meet, Zoom, Teams or Webex |
| Look underneath | World clocks |

**Notifications.**
GNOME's notifications as a plain list.

| Do this | To |
|---|---|
| Open the list | Newest first, with their buttons under the pointer |
| Press Clear | Clear the list |
| Rest the pointer on an alert | Keep it until the pointer leaves |
| Swipe up or down on an alert (touchpad) | Put it away, or open it |
| Right-click the notch | Put an alert away |

**Voice assistant.**
Press Super+I and ask, in English or Indonesian.

| Do this | To |
|---|---|
| Press Super+I, then speak | Ask: play a song, find a file, add a reminder |
| Press Super+I again | Finish speaking, or after an answer, ask more |
| Start typing (or click the keyboard) | Type the request instead |
| Ask for something with several steps | It is done one step after another, each step checked |
| Pick the AI in Settings | Claude Code, Codex, Grok, Hermes, Oh My Pi, opencode or Antigravity answers |

**Installs and fixes things.**
Ask it to install or fix something on your Linux.

| Do this | To |
|---|---|
| Say "Install LibreOffice" or "pasang codex" | It checks what your Linux has, searches the web when unsure, and shows the one command it wants to run, with what to know first |
| Press Run | It runs in the background while you carry on |
| Press Deny | It does not run |
| Wait for the answer | The assistant checks it worked before saying so |

**Speak or type, and talk it through.**
The conversation is the chat itself.

| Do this | To |
|---|---|
| Type in Ask anything at the bottom | Keep talking |
| Pick a past conversation | Reopen it, with its message count beside it |
| Press + New chat | Start a new one |

**A bot of your own.**
Eight shapes, eleven colours, one glow to match.

| Do this | To |
|---|---|
| Pick a shape in Settings | From a circle to a cloud or a ghost |
| Pick a colour, or your own | The glow round the island matches it |
| Open the live preview | See the bot before you pick it |

**AI usage.**
How much of your Claude and ChatGPT plan limits is used.

| Do this | To |
|---|---|
| Open the page | One plan at a time with its logo, a bar per limit and when each resets |
| Scroll or click the dots | Switch plans |
| Choose plans in Settings | Only those plans show; only plans you're signed in to show at all |
| Watch for the warning | One comes as a limit nears its end |

**Alerts.**
Everything that needs you, in one place instead of the middle of the screen.

| Do this | To |
|---|---|
| Wait for an alert | Volume, brightness, Caps Lock, charging, low battery, Bluetooth battery, going offline, reminders, meetings about to start, AI plan limits and GNOME notifications with their buttons |
| Hold the pointer on one | Keep it |
| Press × or swipe up | Put it away |
| Switch each alert on or off in Settings | Only those alerts show |

**AI agents.**
Answer agent permission requests from the island.

| Do this | To |
|---|---|
| Press Deny | It does not run |
| Press Allow | It runs once |
| Press Always (Claude Code) | Always allow it |
| Wait for the island | When one is done, it says what it did |
| Switch an agent off in Settings | Its approvals stop showing |

**App usage.**
Where your time goes.

| Do this | To |
|---|---|
| Turn it on | Tracking starts — off until you turn it on |
| Pick today, the last seven days, or the last 30 | The app in front then, with its icon, a bar and its time |
| Leave the computer idle for five minutes | Tracking pauses; locking the screen stops it |
| Look back later | Kept on this computer for 30 days |

**Glass.**
The island in clear dark glass instead of black, if you prefer.

| Do this | To |
|---|---|
| Choose Glass in Settings → Appearance → Island | What is behind it shows through, blurred, as you work |
| Move the slider | From clear to dark smoked glass |

**Vitals.**
The machine's own pulse in the island.

| Do this | To |
|---|---|
| Open the page | CPU load and temperature big with the last minute drawn as a sparkline between them, each core a bar, the load averages and the process count, memory / swap / disk bars with their bytes, the network's rates, the battery and the uptime |
| Wait 2 s | Fresh numbers, sampled from /proc, no extension needed |
| Pick a vital in Settings | It rides the closed island beside the wave |
| Set the temperature's unit | Auto, Celsius or Fahrenheit |

**Karaoke.**
The line being sung, in the closed island.

| Do this | To |
|---|---|
| Play a song with synced lyrics | The closed island's centre becomes the line being sung — the cover left, the wave right, the clock waiting |
| Sing along | The line holds one width for the whole song, so the island never pumps; a short line centres in the room its last long line held |

**Router.**
What your AI gateway reports.

| Do this | To |
|---|---|
| Connect | Requests, tokens in and out, its cost estimate, the top models as bars, and the last ten requests — a health dot once connected |
| Set the period | Last 7 days, or your choice |
| Turn on Show on the notch | Router stats ride the closed island |

**Everyday tools.**
Water, calories and prayer times.

| Do this | To |
|---|---|
| Log water and calories through the day | Today's totals, kept on this computer |
| Open the Prayer page | The day's prayer times on a sun arc, with the next one and how long until it |

**MCP server.**
An optional MCP server for agents outside Notchfolk.

| Do this | To |
|---|---|
| List writes in <code>~/.config/notchfolk/mcp.env</code> | Those writes are allowed; read tools work for your data and actions |
| Give a key no scope | Its restricted tools are not even visible to it |
| Open remote access | Reach it through an authenticated tunnel; on loopback by default |
| Look at the world domains | Seven, 150 tools in all: System (the machine itself — stats, logs, files, processes, updates, the sharp tools behind their own scope), Browser (the web through a real browser: Camoufox, or your own Chromium over CDP), Memory (the Hindsight engine's 39 tools — what the agent learns, kept across conversations), Notes (your own vault of Markdown notes, and memory's fallback), Skills (the world knows how to do things: the skill trees on the machine), Office (the world makes documents) and Composio (the world reaches your accounts — mail and drive, read on the default key, writes behind their own scope) |
| Run without a backend | A domain whose backend is absent is not offered at all |

**More AIs.**
More AIs for the assistant.

| Do this | To |
|---|---|
| Pick a provider in Settings | The assistant runs Hermes and Oh My Pi with the providers they are configured for |
| Choose OpenAI-compatible API | Any OpenAI-compatible API answers |

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


