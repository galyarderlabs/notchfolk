# Notchfolk Vitals — the machine's own pulse, in the island

**Status: planning** | **Owner: Galih** | **Goal: one less extension (Vitals) on the machine**

## The value

The machine's vitals — CPU, memory, temperature, network, disk, battery — live in the
island, not in a stranger's top-bar extension. The island is already the machine's
face; its pulse belongs there.

## What it is

A **Vitals page** in the expanded island (beside Weather, Music, Calendar...), fed by
the daemon's own periodic sampling. No new processes, no new binaries — the daemon
reads `/proc` and `sysfs` as it already does for its System domain, and publishes the
vitals over D-Bus as it does the weather.

## The data (sampled by the daemon, every 2 s)

| Vital | Source | Shown as |
|---|---|---|
| **CPU** — usage % (aggregate + per-core) | `/proc/stat` deltas | A ring, the % in the centre; per-core as small bars |
| **Memory** — used / total | `/proc/meminfo` | A bar, the % and GB beside it |
| **Swap** — used / total | `/proc/meminfo` | A thin bar under memory (only when swap exists) |
| **Temperature** — the hottest thermal zone | `/sys/class/thermal/thermal_zone*/temp` | The °C, colour-coded (green < 60, amber < 75, red ≥ 75) |
| **Network** — up/down bytes/s | `/proc/net/dev` deltas | Two small numbers with arrows (↓ 1.2 MB/s ↑ 340 KB/s) |
| **Disk** — the root filesystem's used / total | `statvfs("/")` | A thin bar with the % and GB |
| **Battery** — % and charging | UPower (already followed) | The % with the plug or the bolt (already in the closed island) |

## The page (expanded island)

A new tab — **Vitals**, its icon a heartbeat line. The page:

- **Top row**: the CPU ring (left) and the temperature (right), the two that matter at a glance.
- **Middle**: the memory bar (with swap under it when there is one), then the disk bar.
- **Bottom**: the network's up/down, and the battery (when the machine has one).
- **Colour**: each vital's bar/ring fills in the island's own warm gold; the temperature
  alone carries the traffic-light (green/amber/red) — the one vital that can hurt.
- **Live**: the page ticks with the daemon's samples (2 s); the numbers do not jump —
  they ease to their new values, as the island's own springs do.

## The closed island (optional, off by default)

A setting puts **one** vital in the closed island's right side (beside the wave):
the temperature alone (the one that can hurt), or the CPU, or none. One number, small,
the island's own style — never a stranger's top-bar tray.

## The settings (Settings → the island's own page)

| Row | Default | What it does |
|---|---|---|
| **Vitals in the closed island** | off (none) | none / temperature / CPU |
| **Temperature unit** | °C | °C or °F |
| **Sample every** | 2 s | 1 s / 2 s / 5 s / 10 s |

No thresholds, no alerts for now — the page is for looking, not for nagging. (The
battery's own low alert already exists.)

## The MCP (the world)

The System domain's `system_stats` already reads CPU, memory and disk through
subprocess calls. The vitals' own sampling (the daemon's, always on for the page)
joins it as a faster, cleaner source: `system_stats` gains the vitals' own live
numbers (CPU %, memory %, temperature, network rates) alongside its process list —
one source of truth, two consumers.

## The plan (task by task)

### Task 1 — The daemon samples the vitals (Rust)

`crates/notchfolk-daemon/src/vitals.rs`:
- A `Vitals` struct: cpu_percent (aggregate + per-core Vec), memory (used_bytes,
  total_bytes), swap (used_bytes, total_bytes), temperature_c (the hottest zone),
  network (down_bytes_per_s, up_bytes_per_s), disk (used_bytes, total_bytes).
- Sampled every 2 s (the setting's own value), published over D-Bus as
  `io.galyarderlabs.notchfolk.Vitals` with a `VitalsChanged` signal, the shape the
  weather and the media already use.
- `/proc/stat` read twice, 250 ms apart, for the CPU delta (the first sample is
  the idle baseline); `/proc/meminfo` for memory and swap; `/sys/class/thermal` for
  the temperature (the max of the zones that read); `/proc/net/dev` deltas for the
  network; `statvfs("/")` for the disk.
- The battery stays where it is (UPower, `system/power.rs`) — the page reads it
  from the state it already publishes.

### Task 2 — The Vitals page (extension JS)

`gnome-extension/src/pages/vitals.js`:
- The page itself: the CPU ring (a `Ring` like the weather's own), the temperature
  (a label, colour-coded), the memory and disk bars (a `Bar` like the header's own),
  the network's two numbers, the battery.
- The tab's own icon: a heartbeat line drawn as an SVG symbolic
  (`notchfolk-vitals-symbolic`), added to `gnome-extension/icons/`.
- The numbers ease to their new values (the page's own 2 s tick, reading the
  daemon's `Vitals` state).

### Task 3 — The closed island's vital (extension JS)

- The compact's right side gains a small label (the temperature or the CPU %),
  beside the wave, when the setting says so. The clock and the date give way as
  the karaoke does — the vital is a visitor, not a resident.

### Task 4 — The settings (extension JS)

- Settings' island page gains the three rows (the closed island's vital, the
  temperature unit, the sample interval), written to the daemon's own settings
  (GSettings, as the island's other settings are).

### Task 5 — The MCP joins (Python)

- `mcp/tools/system.py`'s `system_stats` reads the daemon's vitals (the same D-Bus
  state the page reads) for its CPU/memory/temperature/network numbers — the
  subprocess calls (`free -h`, `ps aux`) stay for the process list alone.

### Task 6 — The paper trail (docs)

- `CHANGELOG.md`, `docs/product-spec.md` (section 5 gains the page, section 4 the
  closed island's vital), the site's copy (the page named), and `SECURITY.md`
  (nothing new goes online — `/proc` and `sysfs` are the machine's own).

## What it is not

- Not a process manager — no kill buttons, no per-process rows (the MCP's
  `system_processes` is the agent's own tool for that).
- Not an alert engine — no thresholds, no notifications (the battery's own low
  alert already exists).
- Not a graph — numbers and bars, not scrolling plots (the island is a face,
  not a dashboard).
