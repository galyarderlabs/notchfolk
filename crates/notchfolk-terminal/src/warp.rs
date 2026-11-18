// SPDX-License-Identifier: GPL-3.0-or-later

//! Disposable Linux Tab Configs, created only for an explicit Warp handoff.
//! Schema: https://docs.warp.dev/terminal/windows/tab-configs/

use std::env;
use std::ffi::OsStr;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use super::{ENV_PROGRAM, HANDOFF_OPTION, SESSION};

pub(super) struct WarpTabConfig {
    path: PathBuf,
    uri: String,
}

impl WarpTabConfig {
    pub(super) fn new(socket_name: &OsStr, token: &str) -> io::Result<Self> {
        let directory = config_directory(
            env::var_os("XDG_DATA_HOME").as_deref(),
            env::var_os("HOME").as_deref(),
        )?;
        let socket_name = socket_name.to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid private tmux socket name",
            )
        })?;
        Self::create(&directory, socket_name, token)
    }

    fn create(directory: &Path, socket_name: &str, token: &str) -> io::Result<Self> {
        identifier_hex(socket_name)?;
        let token_hex = identifier_hex(token)?;
        let stem = format!("notchfolk_{token_hex}");
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
        let path = directory.join(format!("{stem}.toml"));
        // Never overwrite an existing config or follow a colliding file symlink.
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        let config = Self {
            path,
            uri: format!("warp://tab_config/{stem}?new_window=true"),
        };
        // Creation was already at most 0600; ensure restrictive umasks cannot
        // prevent Warp from reading our new file. Existing files are untouched.
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        let mut writer = BufWriter::new(file);
        write_config(&mut writer, socket_name, token)?;
        writer.flush()?;
        Ok(config)
    }

    pub(super) fn uri(&self) -> &str {
        &self.uri
    }
}

impl Drop for WarpTabConfig {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            eprintln!("notchfolk-terminal: removing disposable Warp tab config: {error}");
        }
    }
}

fn config_directory(data_home: Option<&OsStr>, home: Option<&OsStr>) -> io::Result<PathBuf> {
    // XDG requires absolute paths. An unset, empty, or relative XDG_DATA_HOME
    // uses the documented HOME fallback, never the shell's working directory.
    let data = if let Some(path) = data_home.map(Path::new).filter(|path| path.is_absolute()) {
        path.to_owned()
    } else {
        home.map(Path::new)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "Warp needs an absolute HOME or XDG_DATA_HOME",
                )
            })?
            .join(".local/share")
    };
    Ok(data.join("warp-terminal/tab_configs"))
}

fn identifier_hex(identifier: &str) -> io::Result<&str> {
    identifier
        .strip_prefix("notchfolk-")
        .filter(|hex| {
            hex.len() == 32
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid private tmux identifier",
            )
        })
}

fn write_config(writer: &mut impl Write, socket_name: &str, token: &str) -> io::Result<()> {
    // Only the two validated, locally generated identifiers vary. The command
    // stays readable in Warp and resolves tmux through Warp's shell PATH, so
    // user-local installations work without inserting an executable path.
    // The existing tmux pane already owns the actual shell and cwd.
    writeln!(
        writer,
        "name = \"Termi-notch handoff\"\n\
         \n\
         [[panes]]\n\
         id = \"terminal\"\n\
         type = \"terminal\"\n\
         shell = \"/bin/sh\"\n\
         directory = \"/\"\n\
         is_focused = true\n\
         commands = ['''\n\
         exec {ENV_PROGRAM} -u TMUX -u TMUX_PANE -u TMUX_TMPDIR tmux -N -u -f /dev/null \
         -L {socket_name} if-shell -F -t {SESSION} '#{{==:#{{{HANDOFF_OPTION}}},{token}}}' \
         'attach-session -E -t {SESSION}' 'display-message -p expired'\n\
         ''']"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOCKET: &str = "notchfolk-0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "notchfolk-fedcba9876543210fedcba9876543210";
    const CONFIG_FILE: &str = "notchfolk_fedcba9876543210fedcba9876543210.toml";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = env::temp_dir().join(super::super::random_name().unwrap());
            DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn generated_toml_names_the_authorized_socket_request_and_attach_command() {
        let directory = TestDirectory::new();
        let config = WarpTabConfig::create(&directory.0, SOCKET, TOKEN).unwrap();
        let path = directory.0.join(CONFIG_FILE);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            config.uri(),
            "warp://tab_config/notchfolk_fedcba9876543210fedcba9876543210?new_window=true"
        );
        let toml = fs::read_to_string(&path).unwrap();
        assert_eq!(
            toml,
            "name = \"Termi-notch handoff\"\n\
             \n\
             [[panes]]\n\
             id = \"terminal\"\n\
             type = \"terminal\"\n\
             shell = \"/bin/sh\"\n\
             directory = \"/\"\n\
             is_focused = true\n\
             commands = ['''\n\
             exec /usr/bin/env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR tmux -N -u -f /dev/null \
             -L notchfolk-0123456789abcdef0123456789abcdef if-shell -F -t shell \
             '#{==:#{@notchfolk-handoff},notchfolk-fedcba9876543210fedcba9876543210}' \
             'attach-session -E -t shell' 'display-message -p expired'\n\
             ''']\n"
        );
        assert_eq!(toml.matches("'''").count(), 2);
        assert!(!toml.contains("{{"));
        drop(config);
        assert!(!path.exists());
    }

    #[test]
    fn config_guard_cleans_up_errors_without_overwriting_existing_files() {
        let directory = TestDirectory::new();
        let existing = directory.0.join(CONFIG_FILE);
        fs::write(&existing, "existing user config").unwrap();
        let error = WarpTabConfig::create(&directory.0, SOCKET, TOKEN)
            .err()
            .unwrap();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(&existing).unwrap(),
            "existing user config"
        );

        let failed_token = "notchfolk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let failed_launch = directory
            .0
            .join("notchfolk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.toml");
        let result: io::Result<()> = (|| {
            let _config = WarpTabConfig::create(&directory.0, SOCKET, failed_token)?;
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "attachment was not confirmed",
            ))
        })();
        assert!(result.is_err());
        assert!(!failed_launch.exists());
        for invalid in [
            "notchfolk-",
            "notchfolk-0123",
            "notchfolk-0123456789ABCDEF0123456789ABCDEF",
            "notchfolk-0123456789abcdef0123456789abcdeg",
            "notchfolk_0123456789abcdef0123456789abcdef",
        ] {
            assert!(WarpTabConfig::create(&directory.0, invalid, TOKEN).is_err());
            assert!(WarpTabConfig::create(&directory.0, SOCKET, invalid).is_err());
        }
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn warp_data_directory_follows_xdg_without_using_current_directory() {
        assert_eq!(
            config_directory(Some(OsStr::new("/data")), Some(OsStr::new("/home/test"))).unwrap(),
            PathBuf::from("/data/warp-terminal/tab_configs")
        );
        for data in [None, Some(OsStr::new("")), Some(OsStr::new("relative"))] {
            assert_eq!(
                config_directory(data, Some(OsStr::new("/home/test"))).unwrap(),
                PathBuf::from("/home/test/.local/share/warp-terminal/tab_configs")
            );
        }
        assert!(config_directory(None, Some(OsStr::new("relative"))).is_err());
        assert!(config_directory(None, None).is_err());
    }
}
