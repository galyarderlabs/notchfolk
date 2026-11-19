# Camera capture — plan

Take a photo, or record a video, with the computer's camera, from the notch.
The last feature for 18 Nov 2026 (Galih's last day on Notchfolk) — his pick, over
viewing photos from the gallery.

## What it is

A Camera page in the open island: a shutter button for a photo, a record button
that starts and stops a video, and the last capture as a thumbnail — tap it and
it opens in the default viewer. No live preview in v1 (see the open question).

## What exists today (verified on main `2398327`)

- The daemon only *watches* the camera: `crates/notchfolk-daemon/src/system/camera.rs`
  counts inotify opens/closes of `/dev/video*` and publishes `camera_in_use`
  (the privacy dot, `gnome-extension/src/privacy.js:143`). It captures nothing.
- The daemon already shells out to ffmpeg: `crates/notchfolk-daemon/src/assistant/cloud.rs:191`
  runs `ffmpeg -i pipe:0` to decode the spoken reply. README already tells users
  to install it (`sudo pacman -S ffmpeg`). Capture through ffmpeg follows that
  pattern — no new dependency class.
- The extension has no Gst/ClutterGst anywhere. A live preview would introduce it
  into the shell process for the first time.
- Pages are fixed height (`PAGE_HEIGHT` 150 / `LARGE_PAGE_HEIGHT` 210,
  `gnome-extension/src/pages/page.js`). A page is a lazy maker in
  `controller.js` `_pageMakers()`, a tab in `expanded.js` `TABS` keyed by
  `page.name`, and a toggle in `prefs.js` `PAGES` (shortcuts come free through
  `SHORTCUT_PAGES`). `devices.js` is the template: daemon-state-driven cards.
- Thumbnails exist: `gnome-extension/src/thumbnails.js` (`Thumbnails`, 104 px,
  Gio `thumbnail::path`), used by the shelf/files pages. Opening a file is
  `Gio.AppInfo.launch_default_for_uri_async` (`pages/files.js:517`).
- D-Bus is one interface per domain, `io.galyarderlabs.notchfolk.<Domain>1`;
  the extension builds a proxy per entry in `daemon.js` `INTERFACES` and calls
  it with `daemon.call(name, method, ...)` (`daemon.js:414`).
- No camera tab icon exists (`gnome-extension/icons/` has no `notchfolk-camera*`).
  The Devices page reuses the system `camera-web-symbolic` for its row; tabs use
  the notchfolk-* SVGs.
- The daemon already enumerates camera nodes: `camera_paths()` in `system/camera.rs`
  lists `/dev/video*`. The system state also classes USB devices (`system/mod.rs:95`),
  camera among them, which the Devices page shows.

## Design

The daemon owns capture; the extension never touches `/dev/video*`.

- New daemon interface `Camera1` (`io.galyarderlabs.notchfolk.Camera1`), new module
  next to `system/camera.rs` (e.g. `crates/notchfolk-daemon/src/camera.rs`), with a
  `State` property (JSON) mirrored to `daemon.state.camera` and three methods:
  - `CapturePhoto` → path of the saved JPEG (string out), or a refused error.
  - `StartRecording` → path of the recording (string out).
  - `StopRecording` → path of the finished file (string out).
- Photo: `ffmpeg -hide_banner -loglevel error -f v4l2 -i <device> -frames:v 1 <file>.jpg`.
  Video: `ffmpeg -hide_banner -loglevel error -f v4l2 -i <device> -c:v libx264 -pix_fmt yuv420p <file>.mp4`
  as a long-running child the daemon keeps; stop sends SIGINT so the mp4 trailer
  is written cleanly. If libx264 is absent, fall back to the ffmpeg default mpeg4
  and say so in the error/state — never fail silently.
- Device: reuse `camera_paths()`; take the first node ffmpeg can open (probe with a
  one-frame grab). Laptops with a second node (IR/metadata) must not end up recording
  the wrong one: a node that yields no frames is skipped, and the chosen node is
  named in the state.
- Missing pieces report themselves, they do not hide: no `/dev/video*` → the page
  says there is no camera; no ffmpeg on PATH → the page says ffmpeg is missing
  (README already documents the install). A refused call returns the daemon's own
  words (`Failed`), as `daemon.js` already surfaces them.
- Save location: the XDG Pictures dir, flat, `notchfolk-YYYYMMDD-HHMMSS.jpg` /
  `.mp4`. The extension resolves it the same way `downloads.js` does
  (`GLib.get_user_special_dir(DIRECTORY_PICTURES)`); the daemon resolves it on its
  side for the state paths. No new schema key in v1.
- State JSON (`Camera1.State`): `{available, device, recording, recording_path,
  recording_started, last_capture: {path, kind, time}}`. The page derives the
  recording elapsed time from `recording_started`; the daemon owns the truth.
- Privacy, honestly: our own capture opens `/dev/video0`, so `camera_in_use` goes
  true and the privacy dot lights while a photo is taken or a video records. That
  is correct — the dot must not be suppressed for our own use.
- Extension: `gnome-extension/src/pages/camera.js`, `CameraPage extends Page`,
  LARGE height (210): shutter button, record toggle with elapsed time, last-capture
  thumbnail (the `Thumbnails` class), tap-to-open in the default viewer. Maker in
  `controller.js` `_pageMakers()` with `[this._daemon, this._settings, size]`;
  `camera` entry in `expanded.js` `TABS` with a new `notchfolk-camera*.svg`;
  `['camera', 'Camera', 'camera-web-symbolic', ...]` in `prefs.js` `PAGES`
  (shortcut row comes with it). The page is off by default until its Settings
  switch is on, as the Devices page is.

## Out of scope in v1

- Live preview (see the open question).
- Playing a video inside the island — the thumbnail opens externally.
- Choosing between cameras when several work — first working node wins.
- Burst, timer, or a save-location setting.

## Live preview (v2 — decided 19 Nov 2026)

The shutter proved itself on Galih's laptop (photo saved + thumbnail shown,
19 Nov), so the preview is no longer deferred. The page without it is a black
void with two buttons — that is the bug report that decided it, not a nice-to-have.

**Decision: daemon-owned frame stream, not GStreamer in the Shell.** The
extension never touches `/dev/video*` (the plan's standing rule), and a
pipeline fault must not sit inside GNOME Shell — both rule out GJS Gst +
a Clutter sink for now. The 1 fps still-grab middle step is janky by nature
and stays out. Instead:

- Daemon `Camera1` gains `StartPreview` / `StopPreview` and `preview`
  (bool) + `preview_path` in the State JSON.
- Preview is one ffmpeg child: `ffmpeg -hide_banner -loglevel error -f v4l2
  -i <device> -vf fps=8,scale=640:-1 -q:v 5 -update 1 <cache>/camera-preview.jpg`,
  overwriting one JPEG ~8 times a second. No new dependency: ffmpeg is
  already required for capture. The file lives in the XDG cache dir
  (`~/.cache/notchfolk/camera-preview.jpg`), never in Pictures; the daemon
  publishes its path in the state so the extension never guesses it.
- Device contention is the daemon's problem, not the page's: `CapturePhoto`
  and `StartRecording` stop any running preview child first, then proceed.
  `StartPreview` while recording refuses (camera busy); called while already
  running it is a no-op success. Preview never auto-resumes; the page
  re-starts it when active and not recording.
- Extension: a preview Bin filling the page body, the JPEG decoded into a
  `St.ImageContent` as it changes (~125 ms poll while the page is active).
  Never `Clutter.Image`: removed in GNOME Shell 48, its replacement is
  `St.ImageContent` since Shell 45. Controls become a camera bar under the
  preview: last capture at the left, shutter and record centred, status at
  the right. Preview starts on page activate, stops on deactivate/destroy.
  A preview that cannot show says why in the bar (no file, no size,
  undecodable frame, image-content refusal), never a silent blank.
  Every daemon method must also be declared in the extension's `Camera1`
  XML (`gnome-extension/src/daemon.js`): a missing declaration means no
  `*Remote` on the proxy, and `attempt` swallows the throw into a null
  result — the page went black with no reason until `StartPreview` /
  `StopPreview` were added there (19 Nov). `cameraInterface.test.js`
  enforces the XML against `camera.rs`. And `St.ImageContent` reports only
  an explicit preferred size (default -1) which `set_data` never sets, so
  the page must set it from each decoded frame or the actor allocates 0x0
  and nothing paints — the second black-preview cause, found 19 Nov from
  the Shell source after the daemon was proven writing frames.
  `cameraPreviewPaint.test.js` guards it. The size must be set BEFORE
  `set_data`: that call is what invalidates the size, so setting it after
  left the actor at 0x0 anyway (the 522fac9 device test stayed black the
  same way); the test guards the order too.
- Privacy, honestly: preview opens `/dev/video0`, so `camera_in_use` goes
  true and the privacy dot lights while previewing. That is correct.
- If 8 fps proves too slow for framing, the upgrade is GStreamer in the
  Shell (GJS Gst + appsink into a `Clutter.Image`) — named here, not built.

## Open questions (Galih's call)

1. **Live preview, or blind shutter?** ANSWERED 19 Nov: preview, by the
   design above. v1 shipped blind; v2 adds the preview.
2. **Save location: flat in Pictures, or a `Notchfolk` subfolder?** The plan says
   flat (`~/Pictures/notchfolk-….jpg`), the way a camera app saves. A subfolder
   keeps the folder tidy but hides captures from apps that only look at the top
   level.

## Verification

- `node --check`, eslint, `glib-compile-schemas --strict` (no new keys), the
  extension tests (`node --test tests/extension/*.test.js`), daemon `cargo test`
  and clippy for the new module. New tests: the daemon's filename/device-probe
  logic, and the page's state handling as far as the existing page tests reach.
- No `/dev/video*` on this VM, so capture cannot be proven here. The gate is a
  device test on Galih's laptop (GNOME 51, CachyOS): `which ffmpeg` first, then
  photo, then start/stop a recording, then open the thumbnail. A screenshot of
  the page on his machine is the evidence.
- Docs: README cell (Camera page image + one line) and CHANGELOG, as other pages
  did. The README image needs his screenshot — same as the other README swaps.

## Interplay with the close-out

This is new feature work on the last day, not close-out. It sits beside the open
close-out items — PR #116 (hello greeting, merge or close), PR #121 (the
openai-compatible fix), issue #119 (chrono → jiff) — and Galih decides the order.
If the camera plan does not fit today, it parks with the rest; the branch holds
only the plan.
