# Mac-like tasks (MacOs-CC integration)

Task breakdown for the plan in `mac-like-plan.md`. No phase starts implementation
until its tasks are listed here and Galih has seen the plan. Phase 1 was implemented
before this plan existed — its tasks are listed retroactively and marked done so the
record is complete.

## Phase 1 — Control Center page ✅ DONE (PR #71)

Branch `vibe/control-center-page`, commit `c7f332a`, base origin/main `17ab79b`.
PR: https://github.com/galyarderlabs/notchfolk/pull/71 (draft).

| # | Task | Files | Status |
|---|------|-------|--------|
| 1.1 | New island page: 6 toggle tiles (Wi-Fi, Bluetooth, AirDrop, Dark Mode, Focus, Record) + brightness slider + volume slider + compact media strip | `gnome-extension/src/pages/controlCenter.js` (new, 628 lines) | done |
| 1.2 | Wi-Fi via NetworkManager system bus (`WirelessEnabled` + SSID from active connection) | controlCenter.js | done |
| 1.3 | Bluetooth via BlueZ ObjectManager (first adapter `Powered`; clear `Discoverable` before power-off) | controlCenter.js | done |
| 1.4 | AirDrop: launch LocalSend or Blip if installed, else disabled + 'Not installed' (no chooser dialog) | controlCenter.js | done |
| 1.5 | Brightness via `Main.brightnessManager` (GNOME 49+) with SettingsDaemon Power fallback; row hides if neither exists | controlCenter.js | done |
| 1.6 | Volume reuses Notchfolk `AudioOutputs`; Dark Mode sets `color-scheme`; Focus reuses notifications DND; Record via Shell Screencast to `~/Videos/`; media strip reuses daemon + playback | controlCenter.js | done |
| 1.7 | Register page (tab after Music, Settings hidden pages) | `controller.js`, `expanded.js`, `prefs.js` (+1 each) | done |
| 1.8 | Tile/slider/media styles (`.notchfolk-control-*`, checked = `#0a84ff`) | `stylesheet.css` (+20) | done |
| 1.9 | Verify: node --check on 4 JS files, icons exist, APIs exist | — | done |
| 1.10 | Device test by Galih (tab appears; each toggle flips real state; sliders move real brightness/volume; Record writes `~/Videos/`; media strip works) | — | **waiting** |

Known limits (state honestly): AirDrop prefers LocalSend, no chooser. Dark Mode is
scheme-only, not per-mode themes (Phase 4). Media is a compact strip, not a full MPRIS
card. `Main.brightnessManager` is unverified on device (falls back, does not crash).

## Phase 2 — Spotlight search (NOT STARTED — needs plan approval first)

Open the search from the island. Search apps, files, and recent files; launch on Enter.

| # | Task | Files (expected) | Acceptance |
|---|------|------------------|------------|
| 2.1 | Decide the surface: overlay opened from the island vs a search page. Pick one, write it down before coding. | — | decision recorded here |
| 2.2 | App provider: list matching apps, launch on select | new `gnome-extension/src/pages/spotlight.js` (or overlay) | typing finds installed apps; Enter launches |
| 2.3 | File search: indexed files, max 60 results | spotlight.js | files appear, capped at 60 |
| 2.4 | Recent files provider | spotlight.js | recent files appear first when query is empty |
| 2.5 | Shell D-Bus search providers (extend beyond apps/files if the reference supports it) | spotlight.js | providers return results |
| 2.6 | Keyboard: type to filter, arrows to move, Enter to open, Esc to close | spotlight.js | full keyboard flow works |
| 2.7 | Register entry point (island button / tab) + styles | `controller.js`, `expanded.js`, `prefs.js`, `stylesheet.css` | entry visible, page opens |
| 2.8 | Verify: node --check, icons, APIs exist; draft PR; device test by Galih | — | PR open, device-tested |

## Phase 3 — Panel buttons + settings (NOT STARTED)

The macOS-style top-bar buttons, opt-in only. Default entry stays the island.

| # | Task | Files (expected) | Acceptance |
|---|------|------------------|------------|
| 3.1 | **Decision (Galih):** offer hiding GNOME's aggregate menu / Quick Settings for a clean Mac bar, or leave it always visible? | — | decision recorded here |
| 3.2 | Top-bar buttons (Control Center, Spotlight, Wi-Fi, Bluetooth, Battery) as an opt-in setting, default off | `extension.js` / new panel module | buttons appear only when enabled; each opens its surface |
| 3.3 | Panel settings: icon size 14–26, spacing 3–16, which buttons show, clock 12/24h + language | `prefs.js` (new "Mac" section) | settings persist and apply |
| 3.4 | Wire each button to its island page / Spotlight | panel module | Wi-Fi button opens Control Center page, etc. |
| 3.5 | Verify: node --check, icons, APIs exist; draft PR; device test by Galih | — | PR open, device-tested |

## Phase 4 — Appearance + shortcuts + dock glass (NOT STARTED)

Fold in only what Notchfolk is missing.

| # | Task | Files (expected) | Acceptance |
|---|------|------------------|------------|
| 4.1 | Per-mode themes: light/dark shell/GTK/icon/cursor themes + wallpapers (only the missing bits vs Notchfolk's existing theme settings) | theme module | switching mode changes shell + apps |
| 4.2 | Global shortcuts (from MacOs-CC shortcuts.js, 135 lines) | shortcuts module | shortcuts trigger their actions |
| 4.3 | Dock glass: Liquid Glass for an EXISTING dock (Dash to Dock / Ubuntu Dock / Dash2Dock Animated / Glide Dock, generic fallback). Only if a dock is present. | new dock-glass module | dock background becomes Liquid Glass; no dock → nothing happens |
| 4.4 | Verify: node --check, icons, APIs exist; draft PR; device test by Galih | — | PR open, device-tested |
