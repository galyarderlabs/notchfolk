// SPDX-License-Identifier: GPL-3.0-or-later

//! One discovery source for the picker and display-free preferences CLI.
//! XDG command metadata: https://github.com/Vladimir-csp/xdg-terminal-exec#desktop-entry-for-a-terminal
//! Only literal executable Exec entries are accepted for generic adapters; no
//! shell, command-string flags, field expansion, or user-supplied command runs.

use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use gtk4::{gio, glib};
use gio::prelude::*;

use super::{TERMINALS, find_in_path, is_executable, sanitize_environment, terminal_command};

#[derive(Debug)]
enum Adapter {
    Builtin(&'static str),
    Xdg { exec_arg: String, directory_arg: Option<String> },
    Wave { desktop_id: Option<String> },
}

#[derive(Debug)]
pub struct TerminalTarget {
    pub id: String,
    pub label: String,
    executable: PathBuf,
    adapter: Adapter,
}

impl TerminalTarget {
    pub fn is_manual(&self) -> bool {
        matches!(self.adapter, Adapter::Wave { .. })
    }

    pub(super) fn is_warp(&self) -> bool {
        matches!(self.adapter, Adapter::Builtin("warp-terminal"))
    }

    pub(super) fn command(&self, cwd: &Path, argv: &[OsString]) -> io::Result<Command> {
        match &self.adapter {
            Adapter::Builtin(target) => terminal_command(target, &self.executable, cwd, argv),
            Adapter::Xdg { exec_arg, directory_arg } => {
                let mut command = Command::new(&self.executable);
                if let Some(arg) = directory_arg {
                    if arg.ends_with('=') {
                        let mut value = OsString::from(arg);
                        value.push(cwd);
                        command.arg(value);
                    } else {
                        command.arg(arg).arg(cwd);
                    }
                }
                if !exec_arg.is_empty() {
                    command.arg(exec_arg);
                }
                command.args(argv).current_dir(cwd);
                sanitize_environment(&mut command);
                Ok(command)
            }
            Adapter::Wave { .. } => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Wave requires the explicit copy-and-paste handoff",
            )),
        }
    }

    /// Wave's documented wsh run CLI requires a Wave-issued access token, and
    /// is not an external application API. Open the installed desktop entry;
    /// the user pastes our one-use attach command into a LOCAL Wave terminal.
    /// https://github.com/wavetermdev/waveterm/blob/main/docs/docs/faq.mdx
    /// https://github.com/wavetermdev/waveterm/blob/main/cmd/wsh/cmd/wshcmd-run.go
    pub(super) fn open_wave(&self) -> io::Result<()> {
        let Adapter::Wave { desktop_id } = &self.adapter else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Not a Wave target"));
        };
        if let Some(id) = desktop_id {
            let app = gio::AppInfo::all().into_iter().find(|app| app.id().as_deref() == Some(id.as_str()))
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Wave is no longer installed"))?;
            app.launch(&[], None::<&gio::AppLaunchContext>).map_err(io::Error::other)
        } else {
            // PATH-only installations have no desktop entry. Do not invent -e
            // or a wsh credential: just start the GUI with no command arguments.
            super::launch_desktop(Command::new(&self.executable)).map(|_| ())
        }
    }
}

/// Settings contain only this opaque ID, never a command, Exec line or path.
/// Empty and disappeared IDs intentionally choose the picker, not another app.
pub fn preferred_terminal<'a>(targets: &'a [TerminalTarget], id: &str) -> Option<&'a TerminalTarget> {
    if id.is_empty() { None } else { targets.iter().find(|target| target.id == id) }
}

pub fn available_terminals() -> Vec<TerminalTarget> {
    let path = env::var_os("PATH").unwrap_or_default();
    let mut directories = vec![glib::user_data_dir()];
    directories.extend(glib::system_data_dirs());
    let mut targets = discover(&path, &directories);
    // AppInfo owns desktop-entry parsing/launching, including packaged Wave's
    // Electron flags. No Exec text is copied into GSettings or shell-parsed.
    let wave_app = gio::AppInfo::all().into_iter().find(|app| {
        app.should_show() && app.executable().file_name() == Some(OsStr::new("waveterm"))
            && resolve_executable(&app.executable().to_string_lossy(), &path).is_some()
            && app.id().is_some()
    });
    if let Some(app) = wave_app {
        targets.push(TerminalTarget {
            id: "waveterm".into(), label: "Wave (paste to attach)".into(),
            executable: app.executable(),
            adapter: Adapter::Wave { desktop_id: app.id().map(|id| id.to_string()) },
        });
    } else if let Some(executable) = find_in_path("waveterm", &path) {
        targets.push(TerminalTarget {
            id: "waveterm".into(), label: "Wave (paste to attach)".into(), executable,
            adapter: Adapter::Wave { desktop_id: None },
        });
    }
    targets.sort_by(|left, right| left.label.cmp(&right.label));
    targets
}

fn discover(path: &OsStr, directories: &[PathBuf]) -> Vec<TerminalTarget> {
    let mut targets: Vec<_> = TERMINALS.iter().filter_map(|&(id, label)| {
        let executable = find_in_path(id, path)?;
        if id == "warp-terminal" && find_in_path("xdg-open", path).is_none() { return None; }
        Some(TerminalTarget {
            id: id.into(), label: label.into(), executable, adapter: Adapter::Builtin(id),
        })
    }).collect();
    let mut seen = HashSet::new();
    for directory in directories.iter().filter(|directory| directory.is_absolute()) {
        let root = directory.join("applications");
        for (id, file) in desktop_files(&root) {
            // User Hidden=true entries must still shadow system entries.
            if !seen.insert(id.clone()) { continue; }
            let keyfile = glib::KeyFile::new();
            if keyfile.load_from_file(file, glib::KeyFileFlags::NONE).is_err() { continue; }
            if let Some(target) = desktop_target(&id, &keyfile, path) {
                // Keep tested built-in adapters when a desktop entry describes
                // the same executable. One app, one choice.
                if targets.iter().any(|existing| same_executable(&existing.executable, &target.executable)) {
                    continue;
                }
                targets.push(target);
            }
        }
    }
    targets
}

fn same_executable(left: &Path, right: &Path) -> bool {
    left == right || fs::canonicalize(left).ok().zip(fs::canonicalize(right).ok())
        .is_some_and(|(left, right)| left == right)
}

fn desktop_files(root: &Path) -> Vec<(String, PathBuf)> {
    fn visit(root: &Path, directory: &Path, files: &mut Vec<(String, PathBuf)>) {
        let Ok(entries) = fs::read_dir(directory) else { return; };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue; };
            let file = entry.path();
            if kind.is_dir() {
                visit(root, &file, files);
            } else if file.extension() == Some(OsStr::new("desktop")) {
                let Some(relative) = file.strip_prefix(root).ok().and_then(Path::to_str) else { continue; };
                files.push((relative.replace('/', "-"), file));
            }
        }
    }
    let mut files = Vec::new();
    visit(root, root, &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn desktop_target(id: &str, file: &glib::KeyFile, path: &OsStr) -> Option<TerminalTarget> {
    const GROUP: &str = "Desktop Entry";
    if file.string(GROUP, "Type").ok()?.as_str() != "Application"
        || file.boolean(GROUP, "Hidden").unwrap_or(false)
        || file.boolean(GROUP, "NoDisplay").unwrap_or(false)
        || file.boolean(GROUP, "Terminal").unwrap_or(false)
        || !file.string(GROUP, "Categories").ok()?.split(';').any(|value| value == "TerminalEmulator")
    { return None; }
    let exec = file.string(GROUP, "Exec").ok()?;
    // Intentionally a safe subset, NOT shell parsing. Flatpak wrappers,
    // environment assignments, quoted command strings and fixed launcher
    // options need a dedicated, reviewed adapter rather than guessing.
    if exec.is_empty() || exec.chars().any(|c| c.is_whitespace() || "\"'`$\\%;|&<>()".contains(c)) {
        return None;
    }
    let executable = resolve_executable(&exec, path)?;
    if executable.file_name() == Some(OsStr::new("waveterm")) { return None; }
    if let Ok(program) = file.string(GROUP, "TryExec") {
        resolve_executable(&program, path)?;
    }
    let exec_arg = file.string(GROUP, "X-TerminalArgExec")
        .or_else(|_| file.string(GROUP, "TerminalArgExec")).ok()?.to_string();
    if !valid_option(&exec_arg, true) { return None; }
    let directory_arg = file.string(GROUP, "X-TerminalArgDir")
        .or_else(|_| file.string(GROUP, "TerminalArgDir")).ok().map(|value| value.to_string());
    if directory_arg.as_ref().is_some_and(|arg| !valid_option(arg, false)) { return None; }
    let label = file.locale_string(GROUP, "Name", None).ok()?.to_string();
    if label.is_empty() { return None; }
    Some(TerminalTarget {
        id: format!("desktop:{id}"), label, executable,
        adapter: Adapter::Xdg { exec_arg, directory_arg },
    })
}

fn resolve_executable(program: &str, path: &OsStr) -> Option<PathBuf> {
    let candidate = Path::new(program);
    if candidate.is_absolute() {
        is_executable(candidate).then(|| candidate.to_owned())
    } else if !program.contains('/') {
        find_in_path(program, path)
    } else {
        None
    }
}

fn valid_option(value: &str, empty_allowed: bool) -> bool {
    (empty_allowed && value.is_empty()) || (value.starts_with('-') && value.len() > 1
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_=:.".contains(&byte)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = env::temp_dir().join(super::super::random_name().unwrap());
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("bin")).unwrap();
            fs::write(root.join("bin/example"), "").unwrap();
            fs::set_permissions(root.join("bin/example"), fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
        fn desktop(&self, directory: &str, name: &str, text: &str) -> PathBuf {
            let data = self.0.join(directory);
            fs::create_dir_all(data.join("applications")).unwrap();
            fs::write(data.join("applications").join(name), text).unwrap();
            data
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }
    const ENTRY: &str = "[Desktop Entry]\nType=Application\nName=Example Terminal\nExec=example\nCategories=Utility;TerminalEmulator;\nX-TerminalArgExec=--\nX-TerminalArgDir=--working-directory=\n";

    #[test]
    fn discovers_metadata_targets_and_preserves_literal_argv() {
        let fixture = Fixture::new();
        let data = fixture.desktop("data", "example.desktop", ENTRY);
        let targets = discover(fixture.0.join("bin").as_os_str(), &[data]);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, "desktop:example.desktop");
        let cwd = Path::new("/tmp/space ' ; $(bad)\n");
        let argv = [OsString::from("/usr/bin/env"), OsString::from("a ; $HOME ' value")];
        let command = targets[0].command(cwd, &argv).unwrap();
        assert_eq!(command.get_args().collect::<Vec<_>>(), [
            OsStr::new("--working-directory=/tmp/space ' ; $(bad)\n"),
            OsStr::new("--"), argv[0].as_os_str(), argv[1].as_os_str(),
        ]);
        assert_eq!(command.get_current_dir(), Some(cwd));
        assert!(preferred_terminal(&targets, "").is_none());
        assert!(preferred_terminal(&targets, "removed.desktop").is_none());
        assert!(preferred_terminal(&targets, "/bin/sh -c bad").is_none());
        assert!(preferred_terminal(&targets, "desktop:example.desktop").is_some());
        fs::remove_file(fixture.0.join("bin/example")).unwrap();
        assert!(discover(fixture.0.join("bin").as_os_str(), &[fixture.0.join("data")]).is_empty());
    }

    #[test]
    fn hidden_user_entry_shadows_system_entry_and_unsafe_exec_is_rejected() {
        let fixture = Fixture::new();
        let user = fixture.desktop("user", "example.desktop", &format!("{ENTRY}Hidden=true\n"));
        let system = fixture.desktop("system", "example.desktop", ENTRY);
        assert!(discover(fixture.0.join("bin").as_os_str(), &[user, system]).is_empty());
        for text in [
            ENTRY.replace("Exec=example", "Exec=sh -c bad"),
            ENTRY.replace("Exec=example", "Exec=./example"),
            ENTRY.replace("X-TerminalArgExec=--", "X-TerminalArgExec=-e sh -c"),
            ENTRY.replace("X-TerminalArgExec=--\n", ""),
            ENTRY.replace("TerminalEmulator", "Utility"),
        ] {
            let file = glib::KeyFile::new();
            file.load_from_data(&text, glib::KeyFileFlags::NONE).unwrap();
            assert!(desktop_target("unsafe.desktop", &file, fixture.0.join("bin").as_os_str()).is_none());
        }
    }

    #[test]
    fn explicitly_empty_exec_argument_is_supported_without_guessing() {
        let fixture = Fixture::new();
        let file = glib::KeyFile::new();
        file.load_from_data(&ENTRY.replace("X-TerminalArgExec=--", "X-TerminalArgExec="), glib::KeyFileFlags::NONE).unwrap();
        let target = desktop_target("example.desktop", &file, fixture.0.join("bin").as_os_str()).unwrap();
        let command = target.command(Path::new("/tmp"), &["/usr/bin/env".into()]).unwrap();
        assert_eq!(command.get_args().count(), 2);
    }
}
