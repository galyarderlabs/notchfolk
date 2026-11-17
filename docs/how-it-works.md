# How Notchfolk works

The moving parts, and what they cost. The D-Bus interfaces are documented separately in [dbus-api.md](dbus-api.md).

## How it works

```
┌────────────────── notchfolkd (Rust) ──────────────────┐
│ MPRIS · lyrics · timer · tasks · calendar · shelf│
│ UPower · NetworkManager · BlueZ                  │
│ voice assistant · AI usage · AI agents · meetings│
│            exposed on D-Bus (zbus)               │
└────────────────────────┬─────────────────────────┘
           ┌─────────────┴──────────────┐
  GNOME Shell extension (JS)      notchfolk-shelf (Rust, GTK 4)
  draws the island and its        drag-and-drop window laid
  animations                      over the files tray
```

GNOME Shell extensions are written in JavaScript, and on Wayland only the
shell can draw into the top bar. So the extension only draws, and everything
else lives in Rust behind a D-Bus API.

| Path | Contents |
|---|---|
| `crates/notchfolk-core` | Platform-independent logic: LRC parsing, track-title clean-up, Pomodoro, tasks, calendar, shelf, clipboard history. Unit tested. |
| `crates/notchfolk-daemon` | `notchfolkd`, the D-Bus service; `src/assistant` is the voice assistant (speech, the three AIs, the agent loop, its tools), `src/usage.rs` the AI usage, `src/agents` the AI agents' hooks, `src/meeting.rs` meeting links, `src/updates.rs` the look for new versions, and `src/caller.rs` who may call what. |
| `crates/notchfolk-shelf` | `notchfolk-shelf`, the files tray's drag-and-drop window. |
| `crates/notchfolk-whisper` | `notchfolk-whisper`, the voice assistant's speech recognition: whisper.cpp, on the GPU through Vulkan or on the processor. |
| `gnome-extension` | The GNOME Shell extension; `src/actionRules.js` holds the assistant's rules that need no GNOME, so they are tested anywhere. |
| `tests/extension` | Tests of the extension's GNOME-free parts (`node --test`, and `gjs -m` for those that use GLib). |
| `data` | systemd and D-Bus activation files, and the Inter typeface. |
| `scripts` | `setup-voice.sh` (installed as `notchfolk-setup-voice`), `notchfolk-charge-limit`, and `package.sh`, which makes a release. |
| `docs/product-spec.md` | How the island looks and behaves: sizes, motion, pages, alerts. |
| `docs/dbus-api.md` | The D-Bus interfaces of `notchfolkd` and `notchfolk-shelf`. |

The daemon also samples the machine's vitals every 2 s from `/proc`, `sysfs` and
`df` — CPU, memory, swap, temperature, network, disk, battery, uptime, load,
processes, the CPU's frequency — and publishes them over D-Bus as it does the
weather; the Vitals page and (optionally) the closed island's own vital read them.

## Resource usage

Notchfolk is built to run all day unnoticed. Measured on Ubuntu 24.04 with
GNOME 46 (version 1.0.0):

| Part | Memory | CPU when idle |
|---|---|---|
| `notchfolkd` (background service) | about 10 MB resident, of which under 1 MB its own | 0% (no polling: it wakes for real events and deadlines only) |
| Extension, inside GNOME Shell | about 10 MB more for the shell, flat over hours of use | 0% when nothing moves |
| `notchfolk-shelf` (drag and drop) | about 43 MB (GTK 4, drawn on the CPU, no GPU driver loaded); only while the files tray is open, and 20 seconds after | 0% |
| Voice assistant | the AI only while it works and for 3 minutes after, so a follow-up starts at once (Claude Code about 290 MB, Codex about 160 MB); speech recognition only while the island listens | 0% between requests |

| On disk | Size |
|---|---|
| Programs (`notchfolkd` 6.8 MB, `notchfolk-shelf` 0.7 MB) | 7.5 MB |
| Speech recognition (`notchfolk-whisper` 29 MB, most of it GPU code; the `small` model 265 MB), only once set up | 294 MB |
| Extension | 0.8 MB |
| Inter typeface | 0.9 MB |
| Cache (`~/.cache/notchfolk`) | about 100 KB per song's cover and 6 KB per lyrics |

Animations run on the display's frame clock only while a spring moves and
stop when it settles: closed and idle, Notchfolk draws no frames at all, and over 40
openings, page changes, lyrics and alerts 99.8% of frames came in time for 60 Hz. The clock wakes once a minute, lyrics exactly when the
next line starts, and pages only tick while they are open; only while the
music page shows does Notchfolk ask the player where it is, once a second. The call preview
reuses the window's picture already on the graphics card, so it costs about
nothing, and only exists while the Call page is open; Notchfolk never opens the
camera or the microphone itself.
