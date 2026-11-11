# Mac-like plan (MacOs-CC integration)

Bring the full MacOs-CC-Gnome experience into Notchfolk so it becomes Mac-like in
one extension: the macOS-style Control Center, Spotlight search, and the top-bar
panel buttons + customization. Built natively as Notchfolk island features, using
MacOs-CC as the reference rather than a verbatim port.

Task breakdown: `mac-like-tasks.md`.

## Source

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

## Feature inventory → Notchfolk mapping

| MacOs-CC feature | Size | Notchfolk mapping | Notes |
|---|---|---|---|
| Control Center dropdown (brightness + volume sliders; Wi-Fi, Bluetooth, AirDrop pills; Dark Mode, Focus, Screen Recording toggles; media MPRIS) | 6503 | NEW island page "Control Center" (macOS tile grid) | Reuse Notchfolk page system + glass; Wi-Fi/BT/AirDrop/brightness/volume are NEW; media overlaps existing media page (reuse MPRIS); Focus overlaps existing focusMode; Dark Mode = GNOME appearance |
| Spotlight search (apps, files ≤60, recent files; Shell D-Bus providers + app provider) | 2737 | NEW search (overlay opened from island, or a search page) | No Notchfolk equivalent; biggest single new surface after Control Center |
| Top-bar panel buttons (Control Center, Spotlight, Wi-Fi, Bluetooth, Battery) | in extension.js 588 | Entry points: island button/page + OPTIONAL separate top-bar buttons (setting) | Separate buttons fight the one-island model; default = island entry, buttons opt-in for the full Mac menu-bar look |
| Panel settings (clock language 12/24h; icon size 14–26; spacing 3–16; which buttons show) | in prefs.js 516 | Notchfolk Settings (new "Mac" section) | Clock format = GNOME panel clock; Notchfolk shows its own clock in the island |
| Appearance (light/dark per-mode shell/GTK/icon/cursor themes + wallpapers) | 132 | Overlaps Notchfolk theme settings; fold in only what is missing | Small; mostly already covered |
| Global shortcuts | 135 | Notchfork shortcuts/settings | Small |
| Liquid Glass renderer (lg/ + glass files) | vendored MIT | Reference for the glass look (already being chased via dome/bright variant); NOT a port target here | The glass-aesthetic thread is separate and still open |

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

## Phases

1. **Control Center page** — the quick-toggles tile grid (Wi-Fi, Bluetooth, AirDrop,
   brightness, volume, Dark Mode, Focus, Screen Recording, media) as a new island page.
   Highest value; the core Mac surface.
2. **Spotlight search** — apps + files + recent, opened from the island.
3. **Panel buttons + settings** — the macOS-style top-bar buttons as an opt-in setting,
   plus Panel settings (icon size/spacing, clock format, which buttons show). Decide here
   whether to offer hiding GNOME's aggregate menu for a clean Mac bar.
4. **Appearance + shortcuts + dock glass** — fold in only the missing bits (per-mode
   themes, global shortcuts, Liquid Glass for an existing dock).

## Verification rules (every phase)

- `node --check` passes on every touched JS file.
- Every Notchfolk API called is verified to exist in the repo.
- Every icon used exists in `gnome-extension/icons/`.
- Stylesheet braces balanced.
- No runtime test is possible on this VM — device test on Galih's laptop is the proof.
- A phase is done only when its draft PR is open AND Galih has device-tested it.

## Open questions

- Phase 2: does Spotlight open as a full page or as an overlay on top of the island?
  MacOs-CC uses a dropdown panel; Notchfolk's page system suggests a page. Decide in
  task 2.1 before coding.
- Phase 3: offer hiding GNOME's aggregate menu / Quick Settings for a clean Mac bar,
  or leave it always visible? Galih's call (task 3.1).

## Order of work

1. Galih reads this plan and approves (or corrects) it.
2. A phase starts only after that approval — tasks first, code second.
3. Each phase: implement its tasks → verify → draft PR → Galih device-tests → merge or fix.
4. No phase is started while the previous phase's device verdict is still open,
   unless Galih says otherwise.
