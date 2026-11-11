# Mac-like plan (MacOs-CC integration)

Bring the full MacOs-CC-Gnome experience into Notchfolk so it becomes Mac-like in
one extension: the macOS-style Control Center, Spotlight search, and the top-bar
panel buttons + customization. Built natively as Notchfolk island features, using
MacOs-CC as the reference rather than a verbatim port.

Task breakdown: `mac-like-tasks.md`. Every task names the exact Notchfolk file to
touch, the exact MacOs-CC reference code to follow, and the exact API. If a task
does not name those, it is not ready to implement.

## Sources (both read first-hand, 11 Nov 2026)

- MacOs-CC: https://github.com/Keyunge/MacOs-CC-Gnome (cloned at
  `~/workspace/macos-cc-gnome`, HEAD `7f958a2`). ~10,800 lines JS. Read in full:
  extension.js (588), controlCenterPanel.js (6503, structure + build + indicators),
  spotlight.js (2737, providers + Spotlight class), prefs.js (516), appearance.js
  (132), shortcuts.js (135), glassSurface.js (MenuGlass + GlassSurface), glass.js
  (GlassRim), dockGlass.js (DockWatcher), icons.js.
- Notchfolk: this repo, origin/main `17ab79b`. Read in full: `gnome-extension/src/
  pages/page.js` (Page base class), `controller.js` (`_pageMakers`, `page()` helper),
  `expanded.js` (TABS, PAGE_HEIGHT), `daemon.js` (notchfolkd interfaces),
  `focusMode.js`, `glass.js` (GlassBackdrop + ShapeMask shader), `theme.js` (LOOKS),
  `shell.js` (TopBar), `widgets.js` (Slider), `audio.js` (AudioOutputs),
  `notifications.js` (NotificationCenter), `clipboard.js` (ClipboardHistory),
  `pages/media.js`, `pages/devices.js`, `pages/apps.js`, `prefs.js` (PAGES).
  Read in the Rust daemon: `crates/notchfolk-daemon/src/system/{mod,network,bluetooth}.rs`
  (SystemState: battery, network, bluetooth, camera, devices, usb).

License: MacOs-CC has NO LICENSE file at root. 11 of 13 `.js` files carry
`SPDX-License-Identifier: MIT` headers. `lg/LICENSE` is the MIT text (copyright
Ryosuke Watanabe, Liquid Glass). Only `monitor.js` and `logging.js` lack headers —
neither is needed. MIT is GPL-3.0-compatible (keep the MIT notice). Notchfolk is
GPL-3.0-or-later.

## The Notchfolk way — the ground rules this plan is built on

These are not preferences. They are how this repo actually works, read from its
code. A task that ignores one of them is wrong.

1. **Everything is a Page.** `gnome-extension/src/pages/page.js`: a Page extends
   `St.Widget`, has `this.name` (set in `_init`, e.g. `MediaPage` sets
   `this.name = 'music'`), a fixed height (`PAGE_HEIGHT = 150`,
   `LARGE_PAGE_HEIGHT = 210`, in `expanded.js`), and a lifecycle
   (`onActivate` / `onDeactivate`, `warmUp` / `coolDown`, `markCold`,
   `watch(keys, cb)` for daemon state, `later(name, ms, cb)` for timeouts,
   `request-keyboard` signal for text input). A page is registered as a maker
   in `controller.js` `_pageMakers()` — `() => page('./pages/x.js', 'XPage', args)`
   — which lazily imports the module. Its tab comes from `expanded.js` TABS
   (keyed by `page.name`), its hidden-pages entry and its shortcut come from
   `prefs.js` PAGES / SHORTCUT_PAGES. **A new surface that is not a Page must
   justify why it is not one.**
2. **The daemon owns system state; the extension reads it.** notchfolkd (Rust)
   publishes `daemon.state.system` (one JSON property, `System1.State`): `battery`
   (percent, plugged, charging), `network` (connected, connection "wifi"/"ethernet"/
   "other", name = SSID), `bluetooth` (connected devices: path, name, icon,
   battery), `camera_in_use`, `devices` (phone), `usb`. The extension reads this
   — e.g. `devices.js` shows Bluetooth devices from `daemon.state.system.bluetooth`,
   `controller.js` checks `daemon.state.system?.network?.connected`. **Display
   state comes from the daemon where it exists.**
3. **But the daemon has no setters for these.** `System1` exposes only `State`
   (read) + `Event` (signal). There is no Wi-Fi on/off, no Bluetooth on/off, no
   brightness method in notchfolkd, and no `WirelessEnabled` / adapter-`Powered`
   in `SystemState`. So a toggle that flips Wi-Fi, Bluetooth or brightness MUST
   use direct D-Bus from the extension (NetworkManager system bus, BlueZ system
   bus, SettingsDaemon Power / Shell brightnessManager) — that is what Phase 1
   did, and it is the correct call for now. The long-term alternative (extend
   notchfolkd's `System1` with setters, in Rust, plus the MCP system tools) is a
   separate decision, not assumed here. See D1.
4. **Focus is the pomodoro, and FocusMode owns DND.** Notchfolk's "Focus" page
   is the Timer (`timer.js`, `this.name = 'focus'` — Pomodoro sessions). `focusMode.js`
   turns DND on for a focus session and only ever undoes what IT did (tracks
   `focus-dnd-owned` and `focus-dnd-declined` in settings, survives the lock screen).
   A Control Center Focus tile that just flips `notifications.dnd` can fight that
   ownership. Its semantics must be defined, not assumed. See D2.
5. **Notchfolk has no app launcher.** `pages/apps.js` is app USAGE (time in each
   app, from `appUsage.js` + notchfolkd `AppUsage1`) — not a launcher. Spotlight's
   app launching is genuinely new. The API is `Shell.AppSystem.search(query)`
   (GNOME 45+) with a `get_installed()` fallback, ranked by `Shell.AppUsage.compare`,
   launched by `lookup_app(id)?.activate()` — the same API MacOs-CC uses.
6. **Notchfolk HAS a persistent clipboard.** `clipboard.js` `ClipboardHistory`
   + notchfolkd `Clipboard1` (AddText/AddImage/AddFiles/GetText/Search/Touch/
   SetPinned/Remove/Clear) + the Shelf page (Super+V). Spotlight's clipboard
   reuses this — it does NOT build MacOs-CC's in-memory-only ClipboardProvider
   (records from enable, gone on session end, nothing on disk).
7. **Media is already a daemon pattern.** `daemon.state.nowPlaying` +
   `daemon.call('media', 'PlayPause')` (daemon.js Media1: PlayPause/Next/Previous/
   SetPosition/Raise/Choose/Dismiss/SetLyrics/SetWatching; NowPlaying/Lyrics/Players).
   Volume is `audio.js` `AudioOutputs` (volume 0..1, muted, hasOutput, toggleMuted,
   iconName, outputs, activate). The Control Center media strip and volume slider
   reuse these — they do not talk to MPRIS directly.
8. **The top bar is already owned.** `shell.js` `TopBar` (instantiated in
   `controller.js:339` as `new TopBar(this._settings)`) holds
   `Main.panel.statusArea.dateMenu`, overrides `Main.panel.toggleCalendar` (clicking
   the clock opens Notchfolk's calendar), restyles the panel via `panelStyle.js`
   (only its own rules, max 5 restyles/second so it does not fight other
   extensions), and sets the panel style classes. Panel buttons go through
   TopBar — not a separate extension.js. The clock-move must preserve the
   `toggleCalendar` override.
9. **Glass is a different renderer.** Notchfolk's glass (`glass.js`): `GlassBackdrop`
   clones what is under the island (wallpaper, windows, top bar) as `Clutter.Clone`
   actors (`AreaClone`), blurs them with GNOME Shell's `Shell.BlurEffect`
   (radius 22), and cuts/tones them with a GLSL shader (`ShapeMask`: dome
   refraction lens 64 / band 32 / spread 1.0 / rim 0.85 / rimWidth 1.5 / falloff 2.4,
   in a JS template literal — no backticks inside). Constants live in `theme.js`
   LOOKS (`glass`: fill [0.35, 0.38, 0.45, 0.30], blur radius 22, lo 0.08, span 0.78,
   deep 0.30, knee 0.35, sheen 0.14, glow 0.12; `DARK_GLASS` at tint 100). It is
   deliberately hidden in overview. MacOs-CC's Liquid Glass is a different
   renderer (StageCopier framebuffer copy + Dual Kawase blur + `glass.frag` ~940
   lines + Cairo GlassRim). Adopting it is a port, not a tweak. See D5.
10. **Settings need schema changes.** New settings keys need a GSettings schema
    change (the schemas under `gnome-extension/schemas/`) plus a new
    `Adw.PreferencesPage` (or group) in `prefs.js` — the existing pages are built
    that way (About, AI Usage, Router, MCP, Assistant, Clipboard, Island, Timer…).
    A task that adds a setting names the schema key and the prefs page.

## What the reference actually contains

Read from its code, not its README.

### Top bar (extension.js, 588 lines)

Rebuilds GNOME's top-right into a Mac menu bar: battery, Bluetooth, Wi-Fi,
Spotlight button, Control Center button, then the clock moved to the far right.
Each glyph is a `PanelMenu.Button` with its own dropdown; order is enforced by
reparenting actors into `Main.panel._rightBox` in that order. Icon size from
settings (14–26) scaled by panel height / 32; the two primary icons (Control
Center, Spotlight) are 1.2x larger; the battery glyph has Mac proportions
(22–23px wide body, ~12px tall). The clock label is rewritten to
"Sun Nov 11 5:30 PM" (EN/ES, 12/24h), refreshed every 30s, restored on disable.
The Wi-Fi, Bluetooth and battery menus are deliberately EXCLUDED from Liquid
Glass (kept as a lightweight blur) via the Liquid Glass extension's
`disabled-extra-menus`.

### Control Center dropdown (controlCenterPanel.js, 6503 lines)

A `PanelMenu.Button` whose menu is, top to bottom:

- **Toggle grid** (`Clutter.GridLayout`, homogeneous cells, 10px spacing).
  Built-in modules in slot order, each with a cell span: Wi-Fi pill (2x1, shows
  the SSID chip), Media card (2x2, spans two rows, square beside the tiles),
  Bluetooth pill (2x1, subtitle), AirDrop pill (2x1, NOT a toggle — it opens a
  file-transfer app), Screen Mirroring (1x1 round button, opens the mirroring
  dialog), Screenshot (1x1 round button, opens the screenshot UI), Dark Mode
  (1x1 round toggle), Screen Recording (1x1 round toggle), Focus pill (2x1).
  Modules pack into the first free cell, so removing one closes the gap.
- **Custom grid** (4 columns): toggles **adopted from GNOME Shell's Quick
  Settings / other extensions**. The panel absorbs GNOME's own toggles into
  itself. An edit/arrange mode puts a "−" badge on each control; removing an
  adopted control sends it back to Quick Settings, removing a built-in module
  hides it. Layout is persisted in GSettings (`adopted-toggles`,
  `custom-layout`, `hidden-builtins`), size version 2.
- **Slider cards**: "Display" (brightness, small/large sun) and "Sound"
  (volume, speaker-low/high) — each a card with a title and a slider row.
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
not just a search box. Providers: Applications (`Shell.AppSystem.search`, ranked
by `Shell.AppUsage.compare`), Recent files (reads `~/.local/share/recently-used.xbel`,
sorted by modified, max recent; plus a background FileIndex of the home folder
built a few ms at a time in idle, skipping hidden/symlinks, max depth/entries),
Actions (Lock Screen, Suspend, Log Out, Restart, Power Off via SystemActions;
Toggle Dark Style, Toggle Night Light, Toggle Do Not Disturb, Take a Screenshot
via `Main.screenshotUI`, Open Settings), Clipboard (in-memory only, records from
enable, gone on session end, nothing on disk), plus remote Shell D-Bus search
providers. UI: header with entry, ghost text, badge, top-hit icon; result list
(scroll) + an app grid (tiles); keyboard navigation; pop-in animations; adaptive
text; Esc closes; click outside dismisses.

### Appearance (appearance.js, 132 lines)

Per-mode (light/dark) shell theme, GTK theme, icon theme, cursor theme,
wallpapers. Baseline captured at construction; the right mode's themes are
applied whenever `color-scheme` changes. `setDark()` flips the scheme and applies.

### Shortcuts (shortcuts.js, 135 lines)

Global shortcuts via Mutter `grab_accelerator`. Defaults: Spotlight = Alt+Space,
Control Center = Super+C. Alt+Space frees GNOME's `activate-window-menu`
binding (which uses Alt+Space by default) and restores it on release. Retries up
to 12x if the accelerator is busy. Configurable via click-to-capture in prefs.

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

## Architectural decisions (recorded, not assumed)

- **D1 — Toggles use direct D-Bus; display state uses the daemon.** Wi-Fi /
  Bluetooth / brightness toggles call NetworkManager / BlueZ / Power directly
  from the extension, because notchfolkd has no setters for them. Where the
  daemon already provides the display state, use it: Wi-Fi SSID + connected
  from `daemon.state.system.network` (name, connected, connection), Bluetooth
  devices + battery from `daemon.state.system.bluetooth`. Do not re-read from
  D-Bus what the daemon already publishes. Long-term option (separate decision,
  not this plan): extend notchfolkd `System1` with setters (Rust + D-Bus +
  MCP system tools) so the extension stops doing direct D-Bus.
- **D2 — Focus tile semantics (open).** Notchfolk's Focus is the pomodoro
  (`timer.js`, `this.name = 'focus'`) and `focusMode.js` owns DND for a session.
  The Control Center Focus tile must be defined against that ownership before
  it is built: does it toggle DND directly, start/stop a pomodoro session, or
  show the pomodoro state? Decide in task 1.17 before the tile's behaviour is
  final. Until then the tile toggles `notifications.dnd` (Phase 1) and the
  conflict is a known open item, not a hidden one.
- **D3 — Spotlight is an overlay, not a Page.** A Page is fixed-height
  (150 / 210 px) and Spotlight needs a full-screen search + results + app grid.
  So Spotlight is built as an overlay (backdrop + column, like the reference),
  hosted outside the Page system, with its own keyboard grab (the Page
  `request-keyboard` signal does not apply). Its entry point is still a tab /
  button / shortcut like any other surface.
- **D4 — Clipboard reuses Notchfolk's persistent history.** Spotlight's
  clipboard section reads `clipboard.js` `ClipboardHistory` + notchfolkd
  `Clipboard1` (Search). It does NOT build the reference's in-memory-only
  ClipboardProvider. The Shelf page (Super+V) is the same source.
- **D5 — Glass: adopt vs tune (open, Galih's call).** Adopting the MacOs-CC
  Liquid Glass renderer means porting `lg/` + `glassSurface.js` (GlassSurface /
  FrameLoop / MenuGlass) + `glass.js` (GlassRim) + per-surface settings — a
  major port, because it replaces Notchfolk's clone + Shell-blur + GLSL-shader
  renderer (`glass.js` / `theme.js`). Tuning means continuing to adjust
  Notchfolk's own shader constants (`theme.js` LOOKS) toward the Liquid Glass
  look. This decides the look of everything. Decide in task 4.1 before any
  glass work is done.
- **D6 — Panel buttons go through TopBar.** `shell.js` `TopBar` owns the panel
  (`Main.panel.statusArea.dateMenu`, `toggleCalendar` override, `panelStyle.js`
  restyling). Phase 3 buttons are added via `Main.panel.addToStatusArea` with
  uuid-namespaced roles, managed by TopBar (destroy cleanup), in the order
  battery, Bluetooth, Wi-Fi, Spotlight, Control Center. The clock move must
  preserve the `toggleCalendar` override.

## End state — what Notchfolk looks and feels like when this is done

Notchfolk is ONE island, not a menu bar, so the end state is not "the MacOs-CC
menu bar". It is: **the island becomes the Mac-like hub, and the Mac-ness is
expressed through the island, with the top-bar buttons as an opt-in.**

Concretely:

- **Open the island → Control Center page.** A tile grid: Wi-Fi pill showing the
  SSID (from `daemon.state.system.network.name`), a media card
  (`daemon.state.nowPlaying`), Bluetooth, AirDrop, Screen Mirroring, Screenshot,
  Dark Mode, Screen Recording, Focus — round-cornered glass tiles, Mac proportions.
  Below it, Display and Sound slider cards (`widgets.js` Slider; volume from
  `AudioOutputs`). The panel can also **adopt Quick Settings toggles**: a second
  grid that absorbs GNOME's own toggles into the island, with an edit mode where
  a "−" badge removes a toggle (adopted ones go back to Quick Settings) and the
  layout persists in GSettings.
- **Alt+Space → Spotlight.** A full-screen glass overlay (D3): a search field with
  a top hit, results for apps (`Shell.AppSystem.search`), files (max 60, from
  `recently-used.xbel` + a background home-folder index), recent files, system
  actions (lock, suspend, dark style, night light, DND, screenshot, settings),
  clipboard history (Notchfolk's persistent `ClipboardHistory`, D4), plus Shell
  search providers — and an app grid view. Type, arrows, Enter, Esc. A launcher,
  not a search box.
- **Top bar (opt-in, default off).** Battery, Bluetooth, Wi-Fi, Spotlight, Control
  Center buttons (through `TopBar`, D6), clock moved to the far right, Mac
  proportions, adaptive sizing. Each button opens its surface; Wi-Fi / Bluetooth /
  Battery have their own dropdowns (network list, device list, battery + power
  profiles). Clock reads "Sun Nov 11 5:30 PM" (or 24h / ES if chosen). Clicking
  the clock still opens Notchfolk's calendar (`toggleCalendar` override).
- **Dark Mode** in the Control Center flips the whole system: per-mode shell, GTK,
  icon, cursor themes + wallpapers, configured in Settings.
- **Shortcuts**: Alt+Space = Spotlight, Super+C = Control Center, configurable
  (integrated with Notchfolk's existing shortcut system, not fighting it).
- **Dock**: if you run a dock (Dash to Dock etc.), it gets Liquid Glass behind it.
- **Glass**: the whole thing — Control Center, Spotlight, menus, dock — uses the
  Liquid Glass renderer (if D5 is "adopt") or Notchfolk's own tuned shader (if
  D5 is "tune"), with per-surface blur / tint / brightness / saturation +
  corner smoothing in Settings.

## Phases

1. **Control Center page** — the quick-toggles tile grid as a new island page
   (`pages/controlCenter.js`, `this.name = 'control'`). Highest value; the core
   Mac surface. Phase 1 built a subset — see the tasks file for the follow-ups
   (mirroring, screenshot, adopted toggles + gallery + edit mode, bottom bar,
   Focus semantics, daemon-state alignment).
2. **Spotlight search** — an overlay (D3) opened from the island: apps + files +
   recent + actions + clipboard (D4) + remote providers + app grid.
3. **Panel buttons + settings** — the macOS-style top-bar buttons as an opt-in
   setting (through `TopBar`, D6), plus Panel settings (icon size/spacing, clock
   format, which buttons show), clock move, adaptive sizing, and the Wi-Fi /
   Bluetooth / Battery dropdowns. Decide here whether to offer hiding GNOME's
   aggregate menu for a clean Mac bar.
4. **Appearance + shortcuts + dock glass** — fold in only the missing bits
   (per-mode themes, global shortcuts, Liquid Glass for an existing dock) +
   the glass decision (D5).

## Verification rules (every phase)

- `node --check` passes on every touched JS file.
- Every Notchfolk API called is verified to exist in the repo (named in the task).
- Every icon used exists in `gnome-extension/icons/` (Notchfolk's own icons are
  `notchfolk-*`; MacOs-CC's `ext:*` icons must be added or mapped, not assumed).
- Stylesheet braces balanced; new classes follow the existing `.notchfolk-*` naming.
- New GSettings keys are added to the schema AND to `prefs.js`; a key with no
  prefs UI is a bug.
- No runtime test is possible on this VM — device test on Galih's laptop is the proof.
- A phase is done only when its draft PR is open AND Galih has device-tested it.

## Open questions

- **D2 — Focus tile semantics.** Toggle DND, start/stop pomodoro, or show
  pomodoro state? Decide in task 1.17.
- **D5 — Glass: adopt the MacOs-CC Liquid Glass renderer, or keep tuning
  Notchfolk's own shader?** Galih's call. Decide in task 4.1 before any glass work.
- **D1 (long-term) — extend notchfolkd `System1` with Wi-Fi/Bluetooth/brightness
  setters?** Rust + D-Bus + MCP. Separate decision; not this plan's scope.
- Phase 3: offer hiding GNOME's aggregate menu / Quick Settings for a clean Mac
  bar, or leave it always visible? Galih's call (task 3.1).

## Order of work

1. Galih reads this plan and approves (or corrects) it.
2. A phase starts only after that approval — tasks first, code second.
3. Each phase: implement its tasks in order → verify → draft PR → Galih
   device-tests → merge or fix.
4. No phase is started while the previous phase's device verdict is still open,
   unless Galih says otherwise.
