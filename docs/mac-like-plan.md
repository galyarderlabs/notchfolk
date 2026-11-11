# Mac-like plan (MacOs-CC integration)

Bring the full MacOs-CC-Gnome experience into Notchfolk so it becomes Mac-like in
one extension: the macOS-style Control Center, Spotlight search, and the top-bar
panel buttons + customization. Built natively as Notchfolk island features, using
MacOs-CC as the reference rather than a verbatim port.

Task breakdown: `mac-like-tasks.md`.

## Source (read first-hand, 11 Nov 2026)

- Repo: https://github.com/Keyunge/MacOs-CC-Gnome (cloned at `~/workspace/macos-cc-gnome`,
  HEAD `7f958a2`). ~10,800 lines JS: controlCenterPanel.js 6503, spotlight.js 2737,
  extension.js 588, prefs.js 516, appearance.js 132, icons.js 192, shortcuts.js 135.
- License: NO LICENSE file at root. 11 of 13 `.js` files carry
  `SPDX-License-Identifier: MIT` headers (extension.js, controlCenterPanel.js, prefs.js,
  spotlight.js, appearance.js, blur.js, glass.js, glassSurface.js, dockGlass.js, icons.js,
  shortcuts.js). `lg/LICENSE` is the MIT text (copyright Ryosuke Watanabe, Liquid Glass).
  Only `monitor.js` (547 lines, glass perf monitor) and `logging.js` (28 lines) lack
  headers — neither is needed for the features. MIT is GPL-3.0-compatible (keep the MIT
  notice). Notchfolk is GPL-3.0-or-later.

## What the reference actually contains

This is not a thin skin. It is a complete macOS menu-bar + Control Center +
Spotlight system, and the plan below is built from reading its code, not its README.

### Top bar (extension.js, 588 lines)

The extension rebuilds GNOME's top-right into a Mac menu bar: battery, Bluetooth,
Wi-Fi, Spotlight button, Control Center button, then the clock moved to the far
right. Each glyph is a `PanelMenu.Button` with its own dropdown; the order is
enforced by reparenting the actors into `Main.panel._rightBox` in that order.
Icon size comes from settings (14–26) scaled by panel height / 32; the two
primary icons (Control Center, Spotlight) are 1.2x larger; the battery glyph has
Mac proportions (22–23px wide body, ~12px tall). The clock label is rewritten to
"Sun Nov 11 5:30 PM" (EN/ES, 12/24h), refreshed every 30s, restored on disable.
The Wi-Fi, Bluetooth and battery menus are deliberately EXCLUDED from Liquid Glass
(kept as a lightweight blur) via the Liquid Glass extension's `disabled-extra-menus`.

### Control Center dropdown (controlCenterPanel.js, 6503 lines)

A `PanelMenu.Button` whose menu is, top to bottom:

- **Toggle grid** (`Clutter.GridLayout`, homogeneous cells, 10px spacing). Built-in
  modules in slot order, each with a cell span: Wi-Fi pill (2x1, shows the SSID
  chip), Media card (2x2, spans two rows, square beside the tiles), Bluetooth pill
  (2x1, subtitle), AirDrop pill (2x1, NOT a toggle — it opens a file-transfer app),
  Screen Mirroring (1x1 round button, opens the mirroring dialog), Screenshot (1x1
  round button, opens the screenshot UI), Dark Mode (1x1 round toggle), Screen
  Recording (1x1 round toggle), Focus pill (2x1). Modules pack into the first free
  cell, so removing one closes the gap instead of leaving a hole.
- **Custom grid** (4 columns): toggles **adopted from GNOME Shell's Quick Settings /
  other extensions**. This is the Quick Settings integration: the panel absorbs
  GNOME's own toggles into itself. An edit/arrange mode puts a "−" badge on each
  control; removing an adopted control sends it back to Quick Settings, removing a
  built-in module hides it. Layout is persisted in GSettings (`adopted-toggles`,
  `custom-layout`, `hidden-builtins`), size version 2.
- **Slider cards**: "Display" (brightness, small/large sun) and "Sound" (volume,
  speaker-low/high) — each a card with a title and a slider row.
- **Bottom bar** and a **Gallery**: a gallery listing the controls (built-in +
  adopted) with the line "An adopted switch leaves the standard Quick Settings
  until you remove it."
- **Media card**: MPRIS (MprisController), 2x2.
- **Status indicators**: Wi-Fi (full network list via NetworkManager + settings),
  Bluetooth (device list via BlueZ), Battery (UPower + PowerProfiles) — each a
  separate dropdown menu in the top bar.
- **Glass**: cards get a blur (sigma 22, radius 28); the menu glass is a LIVE
  surface — a GlassSurface actor inserted below the menu in uiGroup, with a
  FrameLoop syncing the visible bubble rects (cut to scroll views) every frame.

### Spotlight (spotlight.js, 2737 lines)

A full-screen overlay (backdrop + column placed by hand, glass surface fills it),
not just a search box. Providers: Applications, Recent files (FileIndex, max 60),
Actions (Lock Screen, Suspend, Log Out, Restart, Power Off, Toggle Dark Style,
Toggle Night Light, Toggle Do Not Disturb, Take a Screenshot, Open Settings),
Clipboard (in-memory only, records from enable, gone on session end, nothing on
disk), plus remote Shell D-Bus search providers. UI: header with entry, ghost text,
badge, top-hit icon; result list (scroll) + an app grid (tiles); keyboard
navigation; pop-in animations; adaptive text; Esc closes; click outside dismisses.

### Appearance (appearance.js, 132 lines)

Per-mode (light/dark) shell theme, GTK theme, icon theme, cursor theme, wallpapers.
Baseline captured at construction; the right mode's themes are applied whenever
`color-scheme` changes. `setDark()` flips the scheme and applies.

### Shortcuts (shortcuts.js, 135 lines)

Global shortcuts via Mutter `grab_accelerator`. Defaults: Spotlight = Alt+Space,
Control Center = Super+C. Alt+Space frees GNOME's `activate-window-menu` binding
(which uses Alt+Space by default) and restores it on release. Retries up to 12x
if the accelerator is busy. Configurable via click-to-capture in prefs.

### Settings (prefs.js, 516 lines) — 5 pages

- **Panel Clock**: language EN/ES, 12/24h.
- **Panel**: icon size 14–26, spacing 3–16, 5 switches (Control Center, Spotlight,
  Wi-Fi, Bluetooth, Battery — battery only when a battery is detected).
- **Appearance**: light/dark — shell, GTK, icon, cursor theme + wallpaper each
  (themes read from the installed XDG theme dirs).
- **Shortcuts**: Spotlight + Control Center, click-to-capture, Backspace clears.
- **Liquid Glass**: per-surface blur / tint / brightness / saturation for menus,
  Spotlight, and dock; dock glass on/off + corner radius; corner smoothing 0–1
  (0 = plain circular corner, 1 = continuous curve like macOS); reset button.

### Glass (glassSurface.js 807, glass.js 145, lg/)

The Liquid Glass is a LIVE renderer, not a static blur: a GlassSurface actor
inserted below the menu in uiGroup, a FrameLoop that syncs the visible bubble
rects every frame, sampling the backdrop. A GlassRim (pure-Cairo rim/sheen
overlay) sits on top. Settings are per surface group (menu, spot, dock) +
corner smoothing. The vendored `lg/` is the Liquid Glass renderer (MIT,
Ryosuke Watanabe).

### Dock glass (dockGlass.js, 905 lines)

A DockWatcher scans uiGroup / layoutManager.uiGroup for dock-like actors
(Dash to Dock, Ubuntu Dock, Dash2Dock Animated, Glide Dock, generic fallback
via a background actor), attaches a monitor-sized glass actor below the dock,
and rescans on monitors-changed and child-added. Silent when there is no dock.

## Feature inventory → Notchfolk mapping

| MacOs-CC feature | Size | Notchfolk mapping | Notes |
|---|---|---|---|
| Control Center dropdown (tile grid + sliders + media + adopted toggles + gallery) | 6503 | NEW island page "Control Center" | Reuse Notchfolk page system + glass; Wi-Fi/BT/AirDrop/brightness/volume are NEW; media overlaps existing media page (reuse MPRIS); Focus overlaps existing focusMode; Dark Mode = GNOME appearance; mirroring + screenshot are NEW round buttons; adopted-toggles grid + gallery + edit mode are NEW |
| Spotlight overlay (apps, files ≤60, recent, actions, clipboard, remote providers, app grid) | 2737 | NEW search overlay opened from the island | No Notchfolk equivalent; a launcher, not just a search box |
| Top-bar panel buttons (Control Center, Spotlight, Wi-Fi, Bluetooth, Battery) + clock move + adaptive sizing | in extension.js 588 | Entry points: island button/page + OPTIONAL separate top-bar buttons (setting) | Separate buttons fight the one-island model; default = island entry, buttons opt-in for the full Mac menu-bar look; clock move + sizing belong here |
| Panel settings (clock language 12/24h; icon size 14–26; spacing 3–16; which buttons show) | in prefs.js 516 | Notchfolk Settings (new "Mac" section) | Clock format = GNOME panel clock; Notchfolk shows its own clock in the island |
| Appearance (light/dark per-mode shell/GTK/icon/cursor themes + wallpapers) | 132 | Overlaps Notchfolk theme settings; fold in only what is missing | Small; mostly already covered |
| Global shortcuts (Spotlight Alt+Space, Control Center Super+C) | 135 | Notchfolk shortcuts/settings | Small; Alt+Space needs the window-menu free/restore handling |
| Liquid Glass renderer (lg/ + glass files) | vendored MIT | **Decision needed**: adopt the MacOs-CC Liquid Glass renderer, or keep improving Notchfolk's own glass (dome/bright variant)? | The glass-aesthetic thread is separate and still open in Galih's eyes — his verdict is that Notchfolk's glass still does NOT look like Liquid Glass. This is not a footnote; it is the look of the whole thing. |

## Approach (decided 11 Nov)

- BUILD NATIVELY as Notchfolk island features, MacOs-CC as the reference for look +
  behavior — NOT a verbatim 10.8k-line port. The MacOs-CC code is written for a
  standalone extension (own PanelMenu.Button, own glass, own schema); adapting it
  verbatim would duplicate Notchfolk's media/devices/focus pages and bloat the extension.
- One extension, one design model (the island). The Mac-ness comes from the controls +
  the tile-grid look, not from spreading separate buttons across the top bar.
- Galih is the sole grader on device; each phase ships as a PR for his device test.
- Windows/Mac ports are LATER, out of scope.
- Dock = Liquid Glass for an EXISTING dock (Dash to Dock etc.), not a new dock.
- MacOs-CC does NOT hide GNOME's Quick Settings — that is a separate decision (Phase 3).

## End state — what Notchfolk looks and feels like when this is done

Notchfolk is ONE island, not a menu bar, so the end state is not "the MacOs-CC
menu bar". It is: **the island becomes the Mac-like hub, and the Mac-ness is
expressed through the island, with the top-bar buttons as an opt-in.**

Concretely:

- **Open the island → Control Center page.** A tile grid: Wi-Fi pill showing the
  SSID, a media card, Bluetooth, AirDrop, Screen Mirroring, Screenshot, Dark Mode,
  Screen Recording, Focus — round-cornered glass tiles, Mac proportions. Below it,
  Display and Sound slider cards. The panel can also **adopt Quick Settings
  toggles**: a second grid that absorbs GNOME's own toggles into the island, with
  an edit mode where a "−" badge removes a toggle (adopted ones go back to Quick
  Settings) and the layout persists.
- **Alt+Space → Spotlight.** A full-screen glass overlay: a search field with a
  top hit, results for apps, files (max 60), recent files, system actions (lock,
  suspend, dark style, night light, DND, screenshot, settings), clipboard history
  (in-memory only), plus Shell search providers — and an app grid view. Type,
  arrows, Enter, Esc. A launcher, not a search box.
- **Top bar (opt-in, default off).** Battery, Bluetooth, Wi-Fi, Spotlight, Control
  Center buttons, clock moved to the far right, Mac proportions, adaptive sizing.
  Each button opens its surface; Wi-Fi / Bluetooth / Battery have their own
  dropdowns (network list, device list, battery + power profiles). Clock reads
  "Sun Nov 11 5:30 PM" (or 24h / ES if chosen).
- **Dark Mode** in the Control Center flips the whole system: per-mode shell, GTK,
  icon, cursor themes + wallpapers, configured in Settings.
- **Shortcuts**: Alt+Space = Spotlight, Super+C = Control Center, configurable.
- **Dock**: if you run a dock (Dash to Dock etc.), it gets Liquid Glass behind it.
- **Glass**: the whole thing — Control Center, Spotlight, menus, dock — uses the
  Liquid Glass renderer: a live surface sampling the backdrop, with per-surface
  blur / tint / brightness / saturation + corner smoothing in Settings. This is
  the glass Galih wants; Notchfolk's current glass (dome / bright variant) is
  the thing that does not yet match it.

## Phases

1. **Control Center page** — the quick-toggles tile grid (Wi-Fi, Bluetooth, AirDrop,
   brightness, volume, Dark Mode, Focus, Screen Recording, media) as a new island page.
   Highest value; the core Mac surface. (Phase 1 built a subset — see tasks file for
   the follow-ups: mirroring, screenshot, adopted toggles + gallery + edit mode,
   bottom bar.)
2. **Spotlight search** — apps + files + recent + actions + clipboard + remote
   providers + app grid, as an overlay opened from the island.
3. **Panel buttons + settings** — the macOS-style top-bar buttons as an opt-in setting,
   plus Panel settings (icon size/spacing, clock format, which buttons show), clock
   move, adaptive sizing, and the Wi-Fi / Bluetooth / Battery dropdowns. Decide here
   whether to offer hiding GNOME's aggregate menu for a clean Mac bar.
4. **Appearance + shortcuts + dock glass** — fold in only the missing bits (per-mode
   themes, global shortcuts, Liquid Glass for an existing dock) + the Liquid Glass
   renderer decision.

## Verification rules (every phase)

- `node --check` passes on every touched JS file.
- Every Notchfolk API called is verified to exist in the repo.
- Every icon used exists in `gnome-extension/icons/`.
- Stylesheet braces balanced.
- No runtime test is possible on this VM — device test on Galih's laptop is the proof.
- A phase is done only when its draft PR is open AND Galih has device-tested it.

## Open questions

- **Glass**: adopt the MacOs-CC Liquid Glass renderer, or keep improving Notchfolk's
  own glass? Galih's call. This decides the look of everything.
- Phase 2: does Spotlight open as a full page or as an overlay on top of the island?
  MacOs-CC uses a full-screen overlay; Notchfolk's page system suggests a page.
  Decide in task 2.1 before coding.
- Phase 3: offer hiding GNOME's aggregate menu / Quick Settings for a clean Mac bar,
  or leave it always visible? Galih's call (task 3.1).

## Order of work

1. Galih reads this plan and approves (or corrects) it.
2. A phase starts only after that approval — tasks first, code second.
3. Each phase: implement its tasks → verify → draft PR → Galih device-tests → merge or fix.
4. No phase is started while the previous phase's device verdict is still open,
   unless Galih says otherwise.
