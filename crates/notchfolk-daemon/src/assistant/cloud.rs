// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

//! Speech over an OpenAI-compatible router: what was said to `/v1/audio/transcriptions`, the reply
//! spoken through `/v1/audio/speech` and `pw-play`. The API key never enters GSettings or a plain
//! file: it lives in the keyring, as the router's own credentials do.

use std::io::Read;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, bail};
use log::warn;
use tokio::io::AsyncWriteExt;
use ureq::unversioned::multipart::{Form, Part};

use super::mic::RATE;

/// The keyring entry's name, under the service the router's credentials use.
const KEYRING_ACCOUNT: &str = "voice-router-key";
/// How long any one request to the router may take.
const TIMEOUT: Duration = Duration::from_secs(30);

/// The keyring entry the API key is kept in.
fn entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new("io.galyarderlabs.notchfolk", KEYRING_ACCOUNT)
}

/// The saved API key, if there is one.
pub fn key() -> Option<String> {
    match entry().and_then(|entry| match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err),
    }) {
        Ok(key) => key.filter(|key| !key.is_empty()),
        Err(err) => {
            warn!("could not read the voice router's API key: {err}");
            None
        }
    }
}

/// Saves the API key; an empty one removes it.
pub fn save_key(key: &str) -> anyhow::Result<()> {
    let entry = entry().context("could not reach the keyring")?;
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(err) => return Err(err).context("could not remove the API key"),
        }
    } else {
        entry
            .set_password(key)
            .context("could not save the API key")?;
    }
    Ok(())
}

/// The words in `audio` (16 kHz mono), as the router's speech-to-text model heard them.
pub async fn transcribe(
    base: &str,
    path: &str,
    model: &str,
    key: &str,
    audio: &[i16],
    language: &str,
) -> anyhow::Result<String> {
    let url = url(base, path);
    let wav = wav(audio);
    // NOTCHFOLK_SPEECH_DUMP names a folder to also write each recording to, as the WAV sent to the
    // router, kept until the next one: for listening to what the assistant actually heard.
    if let Some(dump) = std::env::var_os("NOTCHFOLK_SPEECH_DUMP") {
        let dump = std::path::Path::new(&dump).join("notchfolk-heard.wav");
        if let Err(err) = std::fs::write(&dump, &wav) {
            warn!("could not write the recording to {}: {err}", dump.display());
        }
    }
    let key = key.to_owned();
    let model = model.to_owned();
    let language = language.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut form = Form::new().text("model", &model);
        // Settings' language is a list for local whisper ("id,en" tells the two apart); a router
        // takes one code, so only a list of one is sent, and a longer one is left to the router to
        // detect — better than a code it refuses.
        let language = language.split(',').next().unwrap_or_default().trim();
        if !language.is_empty() {
            form = form.text("language", language);
        }
        let form = form.part(
            "file",
            Part::bytes(&wav)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .context("could not name the recording")?,
        );
        let started = std::time::Instant::now();
        let response = ureq::post(&url)
            .config()
            .timeout_global(Some(TIMEOUT))
            .build()
            .header("Authorization", &format!("Bearer {key}"))
            .send(form)
            .with_context(|| {
                format!(
                    "could not reach the speech router at {url} in {:.1} s",
                    started.elapsed().as_secs_f32()
                )
            })?;
        let text = response
            .into_body()
            .read_to_string()
            .context("could not read the speech router's answer")?;
        let reply: serde_json::Value = serde_json::from_str(&text)?;
        let Some(said) = reply["text"].as_str() else {
            bail!("the speech router answered without text: {text}");
        };
        Ok(said.to_owned())
    })
    .await?
}

/// Speaks `text` through the router's text-to-speech, played by `pw-play`; the child it returns is
/// the playing, killed when dropped.
pub async fn speak(
    base: &str,
    path: &str,
    model: &str,
    voice: &str,
    key: &str,
    text: &str,
) -> anyhow::Result<tokio::process::Child> {
    let url = url(base, path);
    // A router that names its voices in the model id (ElevenLabs' `el/<model>/<voice>`) takes no
    // separate voice: sending both leaves the model bare, which it answers with a gateway error.
    let model = if voice.is_empty() || model.ends_with(voice) {
        model.to_owned()
    } else {
        format!("{model}/{voice}")
    };
    let request = serde_json::json!({
        "model": model,
        "input": text,
        "response_format": "wav",
    });
    let key = key.to_owned();
    let spoken = tokio::task::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let response = ureq::post(&url)
            .config()
            .timeout_global(Some(TIMEOUT))
            .build()
            .header("Authorization", &format!("Bearer {key}"))
            .send_json(&request)
            .with_context(|| {
                format!(
                    "could not reach the speech router at {url} in {:.1} s",
                    started.elapsed().as_secs_f32()
                )
            })?;
        let mut bytes = Vec::new();
        response
            .into_body()
            .into_reader()
            .read_to_end(&mut bytes)
            .context("could not read the spoken reply")?;
        Ok::<Vec<u8>, anyhow::Error>(bytes)
    })
    .await??;
    if spoken.is_empty() {
        bail!("the speech router answered without audio");
    }
    // Routers answer mp3 whatever was asked for, and `pw-play` reads only files it can open by
    // name (libsndfile, not a pipe): ffmpeg decodes it into a WAV in the runtime dir, which plays.
    let path = std::env::temp_dir().join(format!("notchfolk-said-{}.wav", std::process::id()));
    let decoded = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i", "pipe:0"])
        .arg("-y")
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("could not decode the spoken reply")?;
    let mut decoder = decoded;
    let mut decoder_in = decoder.stdin.take().expect("piped stdin");
    // Decoding finishes before playing: libsndfile reads the header `ffmpeg` writes first, and a
    // half-written file is not one.
    if decoder_in.write_all(&spoken).await.is_ok() {
        decoder_in.flush().await.ok();
    }
    drop(decoder_in);
    let status = decoder.wait().await.context("could not decode the spoken reply")?;
    if !status.success() {
        bail!("the speech router's audio could not be decoded");
    }
    let mut child = tokio::process::Command::new("pw-play")
        .arg(&path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("could not play the spoken reply")?;
    let cleanup = path.clone();
    tokio::spawn(async move {
        let _ = tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        std::fs::remove_file(&cleanup).ok();
    });
    Ok(child)
}

/// `path` under the router's base URL, without a doubled slash — a leading slash in `path` is trimmed
/// all the same, so a router's own path fits as it is written.
fn url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// `audio` as a WAV file: 16 kHz mono 16-bit, as the transcription endpoint takes it.
fn wav(audio: &[i16]) -> Vec<u8> {
    let data_len = (audio.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    let put = |wav: &mut Vec<u8>, bytes: &[u8]| wav.extend_from_slice(bytes);
    put(&mut wav, b"RIFF");
    put(&mut wav, &(36 + data_len).to_le_bytes());
    put(&mut wav, b"WAVE");
    put(&mut wav, b"fmt ");
    put(&mut wav, &16u32.to_le_bytes());
    put(&mut wav, &1u16.to_le_bytes());
    put(&mut wav, &1u16.to_le_bytes());
    put(&mut wav, &RATE.to_le_bytes());
    put(&mut wav, &(RATE * 2).to_le_bytes());
    put(&mut wav, &2u16.to_le_bytes());
    put(&mut wav, &16u16.to_le_bytes());
    put(&mut wav, b"data");
    put(&mut wav, &data_len.to_le_bytes());
    for sample in audio {
        put(&mut wav, &sample.to_le_bytes());
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_the_url_without_a_doubled_slash() {
        assert_eq!(
            url("https://router.example/v1", "audio/speech"),
            "https://router.example/v1/audio/speech"
        );
        assert_eq!(
            url("https://router.example/v1/", "audio/speech"),
            "https://router.example/v1/audio/speech"
        );
        // A path written with its own leading slash fits all the same.
        assert_eq!(
            url("https://router.example/v1", "/voice/words"),
            "https://router.example/v1/voice/words"
        );
    }

    #[test]
    fn wraps_the_recording_in_a_wav_header() {
        let wav = wav(&[0, -1, 16384]);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(wav.len(), 50);
    }
}
