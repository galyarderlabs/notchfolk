// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

//! The Camera1 D-Bus object: a photo, or a video, with the computer's camera,
//! from the notch. The daemon owns capture — ffmpeg, as the spoken-reply decode
//! in `assistant/cloud.rs` does — and the extension never touches `/dev/video*`.
//! A capture opens the camera, so the privacy dot lights while one runs; that is
//! correct, and is not suppressed for our own use.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use chrono::Local;
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::clock::now_ms;

/// How long a one-frame grab may take before the camera is called unanswering.
const GRAB_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a fresh recording has to prove it is really running.
const START_SETTLE: Duration = Duration::from_millis(300);
/// How long a recording gets to finish its file after being asked to stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// A capture the page shows as its last one.
#[derive(Serialize, Clone)]
struct Capture {
    path: String,
    /// `photo` or `video`.
    kind: &'static str,
    /// When it finished, in milliseconds since the epoch.
    time: i64,
}

/// What `Camera1.State` carries, as JSON.
#[derive(Serialize)]
struct CameraState {
    /// A working camera was found (and ffmpeg is there to drive it).
    available: bool,
    /// The node captures use, once one has answered.
    device: Option<String>,
    /// The last probe or capture refusal, in plain words, if any.
    error: Option<String>,
    recording: bool,
    recording_path: Option<String>,
    /// When the recording started, in milliseconds since the epoch.
    recording_started: Option<i64>,
    last_capture: Option<Capture>,
}

/// A recording in progress: ffmpeg's child, its file, and when it started.
struct Recording {
    child: Child,
    path: PathBuf,
    started_ms: i64,
}

/// notchfolkd's `Camera1` D-Bus object.
#[derive(Default)]
pub struct CameraService {
    /// The node a probe found answering, if any.
    device: Option<PathBuf>,
    /// Whether a probe has run at all (so the page can tell "not looked yet"
    /// from "looked, and there is no camera").
    probed: bool,
    /// The last probe or capture refusal, in plain words, if any.
    error: Option<String>,
    /// Whether ffmpeg's encoders include libx264, once looked up.
    has_x264: Option<bool>,
    recording: Option<Recording>,
    last_capture: Option<Capture>,
}

impl CameraService {
    /// The pictures folder captures go to: XDG Pictures, or `~/Pictures`.
    fn pictures_dir() -> PathBuf {
        dirs::picture_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Pictures"))
    }

    /// A file in the pictures folder that does not exist yet: `notchfolk-20261118-111500.jpg`,
    /// with `-2`, `-3` … when two captures land in the same second.
    fn fresh_path(kind: &str, ext: &str) -> std::io::Result<PathBuf> {
        let dir = Self::pictures_dir();
        fs::create_dir_all(&dir)?;
        let stamp = Local::now().format("%Y%m%d-%H%M%S");
        let stem = format!("notchfolk-{stamp}-{kind}");
        let mut path = dir.join(format!("{stem}.{ext}"));
        let mut n = 2;
        while path.exists() {
            path = dir.join(format!("{stem}-{n}.{ext}"));
            n += 1;
        }
        Ok(path)
    }

    /// The `/dev/video*` nodes there are now, in order, as `system/camera.rs` sees them.
    fn camera_nodes() -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir("/dev") else {
            return Vec::new();
        };
        let mut nodes: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("video"))
            })
            .collect();
        nodes.sort();
        nodes
    }

    /// One frame from `device` into `path`: the probe and the photo are the same
    /// command, so a node the probe accepts is one a photo can use.
    async fn grab_frame(device: &Path, path: &Path) -> fdo::Result<()> {
        let output = timeout(
            GRAB_TIMEOUT,
            Command::new("ffmpeg")
                .args(["-hide_banner", "-loglevel", "error"])
                .args(["-f", "v4l2", "-i"])
                .arg(device)
                .args(["-frames:v", "1", "-y"])
                .arg(path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| fdo::Error::Failed("the camera did not answer".into()))?
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                fdo::Error::Failed("ffmpeg is missing (sudo pacman -S ffmpeg)".into())
            } else {
                fdo::Error::Failed(format!("could not run ffmpeg: {err}"))
            }
        })?;
        if output.status.success() && path.exists() {
            return Ok(());
        }
        Err(fdo::Error::Failed(last_line(&output.stderr)))
    }

    /// The first node a one-frame grab answers on, if any. A node that yields no
    /// frames is skipped — laptops with a second node (IR, metadata) must not end
    /// up recording the wrong one.
    async fn probe_device(&mut self) -> fdo::Result<PathBuf> {
        if let Some(device) = &self.device {
            return Ok(device.clone());
        }
        self.probed = true;
        let tmp =
            std::env::temp_dir().join(format!("notchfolk-cam-probe-{}.jpg", std::process::id()));
        for node in Self::camera_nodes() {
            if Self::grab_frame(&node, &tmp).await.is_ok() {
                let _ = fs::remove_file(&tmp);
                self.device = Some(node.clone());
                self.error = None;
                return Ok(node);
            }
        }
        let _ = fs::remove_file(&tmp);
        let reason = if Self::camera_nodes().is_empty() {
            "no camera on this computer"
        } else {
            "no camera answered"
        };
        self.error = Some(reason.into());
        Err(fdo::Error::Failed(reason.into()))
    }

    /// Whether ffmpeg can encode H.264, looked up once: the recording command
    /// uses libx264 when it is there, the ffmpeg default otherwise.
    async fn has_x264(&mut self) -> bool {
        if let Some(has) = self.has_x264 {
            return has;
        }
        let has = Command::new("ffmpeg")
            .args(["-hide_banner", "-encoders"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("libx264")
            });
        self.has_x264 = Some(has);
        has
    }

    /// The state as the page reads it.
    fn snapshot(&self) -> CameraState {
        CameraState {
            available: self.device.is_some(),
            device: self
                .device
                .as_ref()
                .map(|device| device.to_string_lossy().into_owned()),
            error: self.error.clone(),
            recording: self.recording.is_some(),
            recording_path: self
                .recording
                .as_ref()
                .map(|recording| recording.path.to_string_lossy().into_owned()),
            recording_started: self
                .recording
                .as_ref()
                .map(|recording| recording.started_ms),
            last_capture: self.last_capture.clone(),
        }
    }

    /// Tells the extension the state is new.
    async fn publish(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.state_changed(emitter).await
    }
}

#[interface(name = "io.galyarderlabs.notchfolk.Camera1")]
impl CameraService {
    /// Takes a photo with the camera and returns the path it was saved to.
    async fn capture_photo(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<String> {
        let device = self.probe_device().await?;
        let path = Self::fresh_path("photo", "jpg").map_err(|err| {
            fdo::Error::Failed(format!("could not make a file in Pictures: {err}"))
        })?;
        if let Err(err) = Self::grab_frame(&device, &path).await {
            let _ = fs::remove_file(&path);
            self.error = Some(plain(&err));
            self.publish(&emitter).await?;
            return Err(err);
        }
        let capture = Capture {
            path: path.to_string_lossy().into_owned(),
            kind: "photo",
            time: now_ms(),
        };
        self.last_capture = Some(capture);
        self.error = None;
        self.publish(&emitter).await?;
        Ok(self.last_capture.as_ref().expect("just set").path.clone())
    }

    /// Starts recording a video with the camera and returns the path it is
    /// being written to; stop it with `StopRecording`.
    async fn start_recording(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<String> {
        if self.recording.is_some() {
            return Err(fdo::Error::Failed("already recording".into()));
        }
        let device = self.probe_device().await?;
        let path = Self::fresh_path("video", "mp4").map_err(|err| {
            fdo::Error::Failed(format!("could not make a file in Pictures: {err}"))
        })?;
        let x264 = self.has_x264().await;
        let mut command = Command::new("ffmpeg");
        command
            .args(["-hide_banner", "-loglevel", "error"])
            .args(["-f", "v4l2", "-i"])
            .arg(&device);
        if x264 {
            command.args(["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
        } else {
            command.args(["-c:v", "mpeg4"]);
        }
        command
            .arg("-y")
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                fdo::Error::Failed("ffmpeg is missing (sudo pacman -S ffmpeg)".into())
            } else {
                fdo::Error::Failed(format!("could not run ffmpeg: {err}"))
            }
        })?;
        // A fresh recording has to prove it is really running: a bad device or
        // a missing encoder kills ffmpeg at once, and a handle on a dead child
        // would look like a recording.
        sleep(START_SETTLE).await;
        if let Ok(Some(status)) = child.try_wait() {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr).await;
            }
            let _ = fs::remove_file(&path);
            let reason = if status.success() {
                "ffmpeg stopped at once".to_string()
            } else {
                last_line(stderr.as_bytes())
            };
            self.error = Some(reason.clone());
            self.publish(&emitter).await?;
            return Err(fdo::Error::Failed(reason));
        }
        // The recording is really running: its stderr must be drained for the
        // whole of it. The pipe is only read above, on an early exit — left
        // unread, ffmpeg blocks once its errors fill the pipe buffer, and the
        // recording stalls. A drain task owns the handle from here; it ends
        // on its own when ffmpeg exits and the pipe closes.
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            });
        }
        let started_ms = now_ms();
        self.recording = Some(Recording {
            child,
            path: path.clone(),
            started_ms,
        });
        self.error = None;
        self.publish(&emitter).await?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Stops the recording and returns the path of the finished file.
    async fn stop_recording(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<String> {
        let mut recording = self
            .recording
            .take()
            .ok_or_else(|| fdo::Error::Failed("not recording".into()))?;
        // `q` on stdin lets ffmpeg finish the file cleanly; a kill would leave
        // a video without its trailer.
        if let Some(mut stdin) = recording.child.stdin.take() {
            let _ = stdin.write_all(b"q").await;
            let _ = stdin.flush().await;
        }
        match timeout(STOP_TIMEOUT, recording.child.wait()).await {
            Ok(Ok(status)) if status.success() => (),
            _ => {
                let _ = recording.child.kill().await;
                let _ = recording.child.wait().await;
                self.error = Some("the recording did not finish cleanly".into());
                self.publish(&emitter).await?;
                return Err(fdo::Error::Failed(
                    "the recording did not finish cleanly".into(),
                ));
            }
        }
        let capture = Capture {
            path: recording.path.to_string_lossy().into_owned(),
            kind: "video",
            time: now_ms(),
        };
        self.last_capture = Some(capture);
        self.error = None;
        self.publish(&emitter).await?;
        Ok(self.last_capture.as_ref().expect("just set").path.clone())
    }

    /// The camera state as JSON, for the page.
    #[zbus(property)]
    fn state(&self) -> String {
        serde_json::to_string(&self.snapshot()).unwrap_or_default()
    }
}

/// Probes once at start-up, so the page knows before the first tap whether
/// there is a camera to use.
pub async fn run(iface: InterfaceRef<CameraService>) {
    {
        let mut service = iface.get_mut().await;
        let _ = service.probe_device().await;
    }
    if let Err(err) = iface.get().await.publish(iface.signal_emitter()).await {
        log::warn!("could not publish the camera state: {err}");
    }
}

/// The last non-empty line of ffmpeg's stderr, in plain words for the page;
/// ffmpeg's own words when it has any, a flat sentence when it has none.
fn last_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(|line| {
            // ffmpeg tags its lines `[v4l2 @ 0x…] …`: the tag is noise on the page.
            match line.split_once(']') {
                Some((tag, rest)) if tag.starts_with('[') => rest.trim().to_string(),
                _ => line.to_string(),
            }
        })
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| "ffmpeg could not use the camera".into())
}

/// The plain words of a refusal, without the D-Bus error framing.
fn plain(err: &fdo::Error) -> String {
    match err {
        fdo::Error::Failed(message) => message.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_path_names_captures_by_time() {
        let path = CameraService::fresh_path("photo", "jpg").unwrap();
        let name = path.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("notchfolk-"));
        assert!(name.ends_with("-photo.jpg"));
        assert_eq!(name.len(), "notchfolk-YYYYMMDD-HHMMSS-photo.jpg".len());
    }

    #[test]
    fn fresh_path_does_not_collide() {
        let first = CameraService::fresh_path("video", "mp4").unwrap();
        fs::write(&first, []).unwrap();
        let second = CameraService::fresh_path("video", "mp4").unwrap();
        assert_ne!(first, second);
        assert!(second.to_string_lossy().ends_with("-2.mp4"));
        let _ = fs::remove_file(&first);
    }

    #[test]
    fn state_serialises_with_the_keys_the_page_reads() {
        let service = CameraService::default();
        // `state()` already returns the JSON string; serialising it again
        // would quote it a second time.
        let json = service.state();
        for key in [
            "available",
            "device",
            "error",
            "recording",
            "recording_path",
            "recording_started",
            "last_capture",
        ] {
            assert!(
                json.contains(&format!("\"{key}\":"),),
                "{key} missing in {json}"
            );
        }
    }

    #[test]
    fn last_line_takes_ffmpegs_last_word() {
        assert_eq!(
            last_line(b"[v4l2 @ 0x1] ioctl(VIDIOC_G_FMT): Invalid argument\n"),
            "ioctl(VIDIOC_G_FMT): Invalid argument"
        );
        assert_eq!(last_line(b""), "ffmpeg could not use the camera");
    }
}
