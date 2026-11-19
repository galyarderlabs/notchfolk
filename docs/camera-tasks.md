# Camera capture — tasks

Plan: `docs/camera-plan.md`. Branch: `vibe/camera-capture`.

## Phase 1 — daemon: `Camera1` + ffmpeg capture — DONE (18 Nov, PR #123)

- [x] New module `crates/notchfolk-daemon/src/camera.rs` (wired into the daemon
      the way `system/camera.rs` is): `Camera1` interface
      (`io.galyarderlabs.notchfolk.Camera1`) with methods `CapturePhoto`,
      `StartRecording`, `StopRecording` and a `State` property (JSON).
- [x] Device probe: reuse the `/dev/video*` enumeration (`camera_paths()` in
      `system/camera.rs`); take the first node a one-frame ffmpeg grab opens.
      A node that yields no frames is skipped; the chosen node is named in the
      state. No node → `available: false`, and calls refuse with the daemon's
      own words.
- [x] Photo: `ffmpeg -hide_banner -loglevel error -f v4l2 -i <device> -frames:v 1
      <file>.jpg`, one-shot `tokio::process::Command` (same shape as the decode
      in `assistant/cloud.rs:191`). ffmpeg missing → the call refuses, it does
      not pretend.
- [x] Video: spawn the ffmpeg child (`-f v4l2 -i <device> -c:v libx264 -pix_fmt
      yuv420p <file>.mp4`), keep the handle; `StopRecording` sends SIGINT so
      the mp4 trailer is written. libx264 absent → ffmpeg default mpeg4, and the
      state says so. Starting while already recording refuses; stopping while
      not recording refuses.
- [x] Save location: XDG Pictures dir, flat, `notchfolk-YYYYMMDD-HHMMSS.jpg` /
      `.mp4`. State JSON: `{available, device, recording, recording_path,
      recording_started, last_capture: {path, kind, time}}`.
- [x] Unit tests for the filename/device-probe logic; `cargo test`, clippy clean.

## Phase 2 — extension: the Camera page — DONE (18 Nov, PR #123)

- [x] New `gnome-extension/src/pages/camera.js`, `CameraPage extends Page`
      (template: `pages/devices.js`), LARGE height (210): shutter button,
      record toggle with elapsed time from `recording_started`, last-capture
      thumbnail via the `Thumbnails` class, tap opens it with
      `Gio.AppInfo.launch_default_for_uri_async` (as `pages/files.js:517`).
- [x] Empty states on the page itself: no camera, no ffmpeg, daemon refusing —
      each in the daemon's own words, never a blank page.
- [x] New tab icon `gnome-extension/icons/notchfolk-camera*.svg` in the
      notchfolk icon style (none exists today).
- [x] `camera` entry in `daemon.js` `INTERFACES` (xml + `State` → `camera`),
      so `daemon.call('camera', ...)` works and `daemon.state.camera` mirrors.

## Phase 3 — wiring — DONE (18 Nov, PR #123)

- [x] Maker in `controller.js` `_pageMakers()`:
      `() => page('./pages/camera.js', 'CameraPage', [this._daemon, this._settings, size])`.
- [x] `camera` entry in `expanded.js` `TABS` (icon + label).
- [x] `['camera', 'Camera', 'camera-web-symbolic', ...]` in `prefs.js` `PAGES`
      (shortcut row comes through `SHORTCUT_PAGES`). Off by default until its
      Settings switch is on, as the Devices page is.
- [x] `node --check`, eslint, `glib-compile-schemas --strict` (no new keys),
      `node --test tests/extension/*.test.js` green.

## Phase 4 — device test + docs — PARTIAL (photo proven 19 Nov)

- [x] Device test on Galih's laptop (GNOME 51, CachyOS) — the gate, since this
      VM has no `/dev/video*`: `which ffmpeg` first, then a photo, then
      start/stop a recording, then tap the thumbnail. Screenshot of the page
      on his machine is the evidence. PHOTO PROVEN 19 Nov (file saved +
      thumbnail shown); video record + thumbnail tap still untested.
- [ ] README cell (Camera page image + one line, image from his screenshot)
      and CHANGELOG, as other pages did.
- [ ] Open questions from the plan answered before any follow-up: live preview
      (blind shutter in v1), save location (flat in Pictures in v1).

## Phase 5 — live preview (v2, decided 19 Nov)

Plan: `docs/camera-plan.md` § "Live preview (v2)". The shutter proved itself,
so the preview is no longer deferred.

- [ ] Daemon: `StartPreview` / `StopPreview` on `Camera1`; one ffmpeg child
      (`-vf fps=8,scale=640:-1 -q:v 5 -update 1`) overwriting
      `~/.cache/notchfolk/camera-preview.jpg`; `preview` + `preview_path`
      in the State JSON. `CapturePhoto` / `StartRecording` stop any running
      preview first; `StartPreview` while recording refuses; while already
      running it is a no-op success. Unit tests for the preview start/stop
      logic; `cargo test`, clippy clean.
- [ ] Extension: preview Bin filling the page body (JPEG decoded into a
      `St.ImageContent` as it changes, ~125 ms poll while active — never
      `Clutter.Image`, removed in Shell 48); a camera bar under the preview
      (last capture at the left, shutter and record centred, status at the
      right); start on page activate, stop on deactivate/destroy. A preview
      that cannot show says why in the bar (no file, no size, undecodable
      frame, image-content refusal), never a silent blank. `node --check`,
      eslint, extension tests green.
- [x] Extension XML: every daemon method must be declared in the
      `Camera1` XML in `gnome-extension/src/daemon.js` — `StartPreview` /
      `StopPreview` were missing there (added 19 Nov), so the proxy had no
      `StartPreviewRemote`, the call threw inside `attempt` (which swallows
      it into a null result), and the page went black with no reason.
      `tests/extension/cameraInterface.test.js` now derives the daemon's
      Camera1 methods from `camera.rs` and asserts the XML declares them
      all. `_startPreview` also says so in the bar when the call never
      reached the daemon (null result, no error).
- [x] Page painting: `St.ImageContent` reports only an explicit preferred
      size (default -1) and `set_data` never sets it, so the actor allocated
      0x0 and nothing painted even with the daemon writing frames (19 Nov:
      preview file existed, 12 KB, journal clean). `_tickPreview` now sets
      the preferred size from each decoded frame; `cameraPreviewPaint.test.js`
      guards it. — and the size must be set BEFORE `set_data`: that call is
      what invalidates the size, so setting it after left the actor at 0x0
      (the 522fac9 device test stayed black the same way). The test now
      guards the order too.
- [ ] Device test on Galih's laptop: preview appears and moves, stops during
      photo/record, resumes after; screenshot is the evidence.
