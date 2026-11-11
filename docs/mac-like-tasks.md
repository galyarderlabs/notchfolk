# Mac-like tasks (MacOs-CC integration)

Task breakdown for the plan in `mac-like-plan.md`. No phase starts implementation
until its tasks are listed here and Galih has seen the plan. Phase 1 was implemented
before this plan existed — its tasks are listed retroactively and marked done so the
record is complete.

## Phase 1 — Control Center page ✅ DONE, subset (PR #71)

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

### Phase 1 follow-ups — the reference has more than 1.1–1.10 (NOT STARTED)

The reference's Control Center also has these. They were not in Phase 1; they are
listed here so the gap is explicit, not hidden. Galih decides whether they are
Phase 1b (do next) or fold into a later phase.

| # | Task | Files (expected) | Acceptance |
|---|------|------------------|------------|
| 1.11 | Screen Mirroring round button (1x1) — opens the mirroring dialog | controlCenter.js | button opens the mirroring dialog |
| 1.12 | Screenshot round button (1x1) — opens the screenshot UI | controlCenter.js | button opens the screenshot UI |
| 1.13 | Adopted-toggles grid: absorb GNOME Quick Settings toggles into the Control Center page (4-column grid, layout persisted in GSettings) | controlCenter.js + new adopted-toggles module | a Quick Settings toggle appears in the island; removing it sends it back |
| 1.14 | Edit/arrange mode: "−" badge removes an adopted toggle (back to Quick Settings) or hides a built-in module; removing closes the gap (first-free-cell packing) | controlCenter.js | edit mode works; layout persists across restarts |
| 1.15 | Gallery section listing the controls (built-in + adopted) + bottom bar | controlCenter.js | gallery lists what is in the panel |
| 1.16 | Verify: node --check, icons, APIs exist; draft PR; device test by Galih | — | PR open, device-tested |

## Phase 2 — Spotlight search (NOT STARTED — needs plan approval first)

A full-screen glass overlay opened from the island (Alt+Space). A launcher, not
just a search box.

| # | Task | Files (expected) | Acceptance |
|---|------|------------------|------------|
| 2.1 | Decide the surface: full-screen overlay (like the reference) vs a search page in the island. Pick one, write it down before coding. | — | decision recorded here |
| 2.2 | App provider: list matching apps, launch on select | new `gnome-extension/src/pages/spotlight.js` (or overlay) | typing finds installed apps; Enter launches |
| 2.3 | File search: indexed files, max 60 results | spotlight.js | files appear, capped at 60 |
| 2.4 | Recent files provider | spotlight.js | recent files appear first when query is empty |
| 2.5 | Actions provider: Lock Screen, Suspend, Log Out, Restart, Power Off, Toggle Dark Style, Toggle Night Light, Toggle Do Not Disturb, Take a Screenshot, Open Settings | spotlight.js | each action runs when selected |
| 2.6 | Clipboard provider: in-memory history from enable, nothing on disk, gone on session end | spotlight.js | copied text appears in Spotlight; nothing persisted |
| 2.7 | Remote Shell D-Bus search providers | spotlight.js | providers return results |
| 2.8 | App grid view (tiles) + keyboard: type to filter, arrows to move, Enter to open, Esc to close, click outside dismisses | spotlight.js | full keyboard flow works; grid shows apps |
| 2.9 | Register entry point (island button / tab / shortcut) + styles | `controller.js`, `expanded.js`, `prefs.js`, `stylesheet.css` | entry visible, overlay opens |
| 2.10 | Verify: node --check, icons, APIs exist; draft PR; device test by Galih | — | PR open, device-tested |

## Phase 3 — Panel buttons + settings (NOT STARTED)

The macOS-style top-bar buttons, opt-in only. Default entry stays the island.

| # | Task | Files (expected) | Acceptance |
|---|------|------------------|------------|
| 3.1 | **Decision (Galih):** offer hiding GNOME's aggregate menu / Quick Settings for a clean Mac bar, or leave it always visible? | — | decision recorded here |
| 3.2 | Top-bar buttons (Control Center, Spotlight, Wi-Fi, Bluetooth, Battery) as an opt-in setting, default off; order: battery, Bluetooth, Wi-Fi, Spotlight, Control Center | `extension.js` / new panel module | buttons appear only when enabled, in that order; each opens its surface |
| 3.3 | Clock moved to the far right; label rewritten to "Sun Nov 11 5:30 PM" (EN/ES, 12/24h); restored on disable | panel module | clock sits far right with the Mac format; disabling restores it |
| 3.4 | Adaptive panel sizing: icon size 14–26 scaled by panel height; primary icons (Control Center, Spotlight) larger; battery Mac proportions | panel module | icons scale with panel height; battery reads Mac-like |
| 3.5 | Wi-Fi dropdown: network list (access points via NetworkManager + settings) | panel module | nearby networks listed; connecting works |
| 3.6 | Bluetooth dropdown: device list via BlueZ | panel module | nearby devices listed; pairing works |
| 3.7 | Battery dropdown: UPower + PowerProfiles | panel module | battery status + power modes shown |
| 3.8 | Panel settings: icon size 14–26, spacing 3–16, which buttons show, clock 12/24h + language | `prefs.js` (new "Mac" section) | settings persist and apply |
| 3.9 | Verify: node --check, icons, APIs exist; draft PR; device test by Galih | — | PR open, device-tested |

## Phase 4 — Appearance + shortcuts + dock glass (NOT STARTED)

Fold in only what Notchfolk is missing. Includes the glass decision.

| # | Task | Files (expected) | Acceptance |
|---|------|------------------|------------|
| 4.1 | **Decision (Galih):** adopt the MacOs-CC Liquid Glass renderer, or keep improving Notchfolk's own glass? | — | decision recorded here |
| 4.2 | Per-mode themes: light/dark shell/GTK/icon/cursor themes + wallpapers (only the missing bits vs Notchfolk's existing theme settings); baseline captured, applied on `color-scheme` change | theme module | switching mode changes shell + apps + wallpaper |
| 4.3 | Global shortcuts: Spotlight Alt+Space, Control Center Super+C, configurable via click-to-capture; Alt+Space frees GNOME's `activate-window-menu` binding and restores it on release | shortcuts module | shortcuts work anywhere in GNOME; Alt+Space does not fight the window menu |
| 4.4 | Dock glass: Liquid Glass for an EXISTING dock (Dash to Dock / Ubuntu Dock / Dash2Dock Animated / Glide Dock, generic fallback). Only if a dock is present; silent otherwise. | new dock-glass module | dock background becomes Liquid Glass; no dock → nothing happens |
| 4.5 | Liquid Glass settings page: per-surface blur / tint / brightness / saturation for menus, Spotlight, dock; dock on/off + corner radius; corner smoothing 0–1; reset | `prefs.js` (Liquid Glass page) | settings apply live; reset restores defaults |
| 4.6 | Verify: node --check, icons, APIs exist; draft PR; device test by Galih | — | PR open, device-tested |
