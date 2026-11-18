# Camera capture — tasks

Plan: `docs/camera-plan.md`. Branch: `vibe/camera-capture`.

## Phase 1 — daemon: `Camera1` + ffmpeg capture

- [ ] New module `crates/notchfolk-daemon/src/camera.rs` (wired into the daemon
      the way `system/camera.rs` is): `Camera1` interface
      (`io.galyarderlabs.notchfolk.Camera1`) with methods `CapturePhoto`,
      `StartRecording`, `StopRecording` and a `State` property (JSON).
- [ ] Device probe: reuse the `/dev/video*` enumeration (`camera_paths()` in
      `system/camera.rs`); take the first node a one-frame ffmpeg grab opens.
      A node that yields no frames is skipped; the chosen node is named in the
      state. No node → `available: false`, and calls refuse with the daemon's
      own words.
- [ ] Photo: `ffmpeg -hide_banner -loglevel error -f v4l2 -i <device> -frames:v 1
      <file>.jpg`, one-shot `tokio::process::Command` (same shape as the decode
      in `assistant/cloud.rs:191`). ffmpeg missing → the call refuses, it does
      not pretend.
- [ ] Video: spawn the ffmpeg child (`-f v4l2 -i <device> -c:v libx264 -pix_fmt
      yuv420p <file>.mp4`), keep the handle; `StopRecording` sends SIGINT so
      the mp4 trailer is written. libx264 absent → ffmpeg default mpeg4, and the
      state says so. Starting while already recording refuses; stopping while
      not recording refuses.
- [ ] Save location: XDG Pictures dir, flat, `notchfolk-YYYYMMDD-HHMMSS.jpg` /
      `.mp4`. State JSON: `{available, device, recording, recording_path,
      recording_started, last_capture: {path, kind, time}}`.
- [ ] Unit tests for the filename/device-probe logic; `cargo test`, clippy clean.

## Phase 2 — extension: the Camera page

- [ ] New `gnome-extension/src/pages/camera.js`, `CameraPage extends Page`
      (template: `pages/devices.js`), LARGE height (210): shutter button,
      record toggle with elapsed time from `recording_started`, last-capture
      thumbnail via the `Thumbnails` class, tap opens it with
      `Gio.AppInfo.launch_default_for_uri_async` (as `pages/files.js:517`).
- [ ] Empty states on the page itself: no camera, no ffmpeg, daemon refusing —
      each in the daemon's own words, never a blank page.
- [ ] New tab icon `gnome-extension/icons/notchfolk-camera*.svg` in the
      notchfolk icon style (none exists today).
- [ ] `camera` entry in `daemon.js` `INTERFACES` (xml + `State` → `camera`),
      so `daemon.call('camera', ...)` works and `daemon.state.camera` mirrors.

## Phase 3 — wiring

- [ ] Maker in `controller.js` `_pageMakers()`:
      `() => page('./pages/camera.js', 'CameraPage', [this._daemon, this._settings, size])`.
- [ ] `camera` entry in `expanded.js` `TABS` (icon + label).
- [ ] `['camera', 'Camera', 'camera-web-symbolic', ...]` in `prefs.js` `PAGES`
      (shortcut row comes through `SHORTCUT_PAGES`). Off by default until its
      Settings switch is on, as the Devices page is.
- [ ] `node --check`, eslint, `glib-compile-schemas --strict` (no new keys),
      `node --test tests/extension/*.test.js` green.

## Phase 4 — device test + docs

- [ ] Device test on Galih's laptop (GNOME 51, CachyOS) — the gate, since this
      VM has no `/dev/video*`: `which ffmpeg` first, then a photo, then
      start/stop a recording, then tap the thumbnail. Screenshot of the page
      on his machine is the evidence.
- [ ] README cell (Camera page image + one line, image from his screenshot)
      and CHANGELOG, as other pages did.
- [ ] Open questions from the plan answered before any follow-up: live preview
      (blind shutter in v1), save location (flat in Pictures in v1).
