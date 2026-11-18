// SPDX-License-Identifier: GPL-3.0-or-later

//! One discovery source for the picker and display-free preferences CLI.
//! XDG command metadata: https://github.com/Vladimir-csp/xdg-terminal-exec#desktop-entry-for-a-terminal
//! Only literal executable Exec entries are accepted for generic adapters; no
//! shell, command-string flags, field expansion, or user-supplied command runs.

use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use gio::prelude::*;
use gtk4::gio;

use super::{TERMINALS, find_in_path, is_executable, sanitize_environment, terminal_command};

#[derive(Debug)]
enum Adapter {
    Builtin(&'static str),
    Xdg {
        exec_arg: String,
        directory_arg: Option<String>,
    },
    Wave {
        desktop_id: Option<String>,
    },
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
            Adapter::Xdg {
                exec_arg,
                directory_arg,
            } => {
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
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Not a Wave target",
            ));
        };
        if let Some(id) = desktop_id {
            let app = gio_unix::DesktopAppInfo::new(id).ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "Wave is no longer installed")
            })?;
            app.launch(&[], None::<&gio::AppLaunchContext>)
                .map_err(io::Error::other)
        } else {
            // PATH-only installations have no desktop entry. Do not invent -e
            // or a wsh credential: just start the GUI with no command arguments.
            super::launch_desktop(Command::new(&self.executable)).map(|_| ())
        }
    }
}

/// Takes the saved target out of discovery so the handoff can own it.
/// Settings contain only this opaque ID, never a command, Exec line or path.
/// Empty and disappeared IDs intentionally choose the picker, not another app.
pub fn preferred_terminal(targets: &mut Vec<TerminalTarget>, id: &str) -> Option<TerminalTarget> {
    if id.is_empty() {
        return None;
    }
    let index = targets.iter().position(|target| target.id == id)?;
    Some(targets.swap_remove(index))
}

pub fn available_terminals() -> Vec<TerminalTarget> {
    let path = env::var_os("PATH").unwrap_or_default();
    discover(&path, gio::AppInfo::all())
}

fn discover(path: &OsStr, apps: Vec<gio::AppInfo>) -> Vec<TerminalTarget> {
    let mut targets: Vec<_> = TERMINALS
        .iter()
        .filter_map(|&(id, label)| {
            let executable = find_in_path(id, path)?;
            if id == "warp-terminal" && find_in_path("xdg-open", path).is_none() {
                return None;
            }
            Some(TerminalTarget {
                id: id.into(),
                label: label.into(),
                executable,
                adapter: Adapter::Builtin(id),
            })
        })
        .collect();
    let mut wave = None;
    // Gio resolves XDG precedence and Hidden entries without a second file walk.
    // Only plain target data crosses into the handoff worker.
    for app in apps {
        let Some(id) = app.id() else {
            continue;
        };
        let Ok(app) = app.downcast::<gio_unix::DesktopAppInfo>() else {
            continue;
        };
        // A D-Bus-activatable desktop entry need not have Exec at all.
        let Some(exec) = app.string("Exec") else {
            continue;
        };
        if wave.is_none()
            && exec.contains("waveterm")
            && app.should_show()
            && let Ok(argv) = gtk4::glib::shell_parse_argv(exec.as_str())
            && let Some(program) = argv.first().and_then(|arg| arg.to_str())
            && Path::new(program).file_name() == Some(OsStr::new("waveterm"))
            && let Some(executable) = resolve_executable(program, path)
        {
            wave = Some(TerminalTarget {
                id: "waveterm".into(),
                label: "Wave (paste to attach)".into(),
                executable,
                adapter: Adapter::Wave {
                    desktop_id: Some(id.to_string()),
                },
            });
        }
        if let Some(target) = desktop_target(&id, &app, path) {
            // Keep tested built-in adapters when metadata names the same executable.
            if !targets
                .iter()
                .any(|existing| same_executable(&existing.executable, &target.executable))
            {
                targets.push(target);
            }
        }
    }
    if let Some(wave) = wave {
        targets.push(wave);
    } else if let Some(executable) = find_in_path("waveterm", path) {
        targets.push(TerminalTarget {
            id: "waveterm".into(),
            label: "Wave (paste to attach)".into(),
            executable,
            adapter: Adapter::Wave { desktop_id: None },
        });
    }
    targets.sort_by(|left, right| left.label.cmp(&right.label));
    targets
}

fn same_executable(left: &Path, right: &Path) -> bool {
    left == right
        || fs::canonicalize(left)
            .ok()
            .zip(fs::canonicalize(right).ok())
            .is_some_and(|(left, right)| left == right)
}

fn desktop_target(
    id: &str,
    app: &gio_unix::DesktopAppInfo,
    path: &OsStr,
) -> Option<TerminalTarget> {
    if app.string("Type")?.as_str() != "Application"
        || app.boolean("Hidden")
        || app.boolean("NoDisplay")
        || app.boolean("Terminal")
        || !app
            .string("Categories")?
            .split(';')
            .any(|value| value == "TerminalEmulator")
    {
        return None;
    }
    let exec = app.string("Exec")?;
    // Intentionally a safe subset, NOT shell parsing. Flatpak wrappers,
    // environment assignments, quoted command strings and fixed launcher
    // options need a dedicated, reviewed adapter rather than guessing.
    if exec.is_empty()
        || exec
            .chars()
            .any(|c| c.is_whitespace() || "\"'`$\\%;|&<>()".contains(c))
    {
        return None;
    }
    let executable = resolve_executable(&exec, path)?;
    if executable.file_name() == Some(OsStr::new("waveterm")) {
        return None;
    }
    if let Some(program) = app.string("TryExec") {
        resolve_executable(&program, path)?;
    }
    let exec_arg = app
        .string("X-TerminalArgExec")
        .or_else(|| app.string("TerminalArgExec"))?
        .to_string();
    if !valid_option(&exec_arg, true) {
        return None;
    }
    let directory_arg = app
        .string("X-TerminalArgDir")
        .or_else(|| app.string("TerminalArgDir"))
        .map(|value| value.to_string());
    if directory_arg
        .as_ref()
        .is_some_and(|arg| !valid_option(arg, false))
    {
        return None;
    }
    let label = app.locale_string("Name")?.to_string();
    if label.is_empty() {
        return None;
    }
    Some(TerminalTarget {
        id: format!("desktop:{id}"),
        label,
        executable,
        adapter: Adapter::Xdg {
            exec_arg,
            directory_arg,
        },
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
    (empty_allowed && value.is_empty())
        || (value.starts_with('-')
            && value.len() > 1
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_=:.".contains(&byte)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gtk4::glib;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = env::temp_dir().join(super::super::random_name().unwrap());
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("bin")).unwrap();
            fs::write(root.join("bin/example"), "").unwrap();
            fs::set_permissions(root.join("bin/example"), fs::Permissions::from_mode(0o700))
                .unwrap();
            Self(root)
        }
        fn entry(&self, text: &str) -> String {
            text.replace(
                "Exec=example\n",
                &format!("Exec={}\n", self.0.join("bin/example").display()),
            )
        }
        fn desktop(&self, directory: &str, name: &str, text: &str) -> PathBuf {
            let data = self.0.join(directory);
            fs::create_dir_all(data.join("applications")).unwrap();
            fs::write(data.join("applications").join(name), self.entry(text)).unwrap();
            data
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    const ENTRY: &str = "[Desktop Entry]\nType=Application\nName=Example Terminal\nExec=example\nCategories=Utility;TerminalEmulator;\nX-TerminalArgExec=--\nX-TerminalArgDir=--working-directory=\n";

    #[test]
    fn discovers_metadata_targets_and_preserves_literal_argv() {
        let fixture = Fixture::new();
        let data = fixture.desktop("data", "example.desktop", ENTRY);
        let app: gio::AppInfo =
            gio_unix::DesktopAppInfo::from_filename(data.join("applications/example.desktop"))
                .unwrap()
                .upcast();
        let path = fixture.0.join("bin");
        assert_eq!(
            resolve_executable("example", path.as_os_str()),
            Some(path.join("example"))
        );
        let data = fixture.desktop(
            "data",
            "org.example.BusOnly.desktop",
            "[Desktop Entry]\nType=Application\nName=Bus Only\nDBusActivatable=true\n",
        );
        let bus_only = gio_unix::DesktopAppInfo::from_filename(
            data.join("applications/org.example.BusOnly.desktop"),
        )
        .unwrap();
        let mut targets = discover(path.as_os_str(), vec![bus_only.upcast(), app.clone()]);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, "desktop:example.desktop");
        let cwd = Path::new("/tmp/space ' ; $(bad)\n");
        let argv = [
            OsString::from("/usr/bin/env"),
            OsString::from("a ; $HOME ' value"),
        ];
        let command = targets[0].command(cwd, &argv).unwrap();
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("--working-directory=/tmp/space ' ; $(bad)\n"),
                OsStr::new("--"),
                argv[0].as_os_str(),
                argv[1].as_os_str(),
            ]
        );
        assert_eq!(command.get_current_dir(), Some(cwd));
        assert!(preferred_terminal(&mut targets, "").is_none());
        assert!(preferred_terminal(&mut targets, "removed.desktop").is_none());
        assert!(preferred_terminal(&mut targets, "/bin/sh -c bad").is_none());
        assert!(preferred_terminal(&mut targets, "desktop:example.desktop").is_some());
        fs::remove_file(fixture.0.join("bin/example")).unwrap();
        assert!(discover(path.as_os_str(), vec![app]).is_empty());
    }

    #[test]
    fn hidden_user_entry_shadows_system_entry_and_unsafe_exec_is_rejected() {
        const CHILD: &str = "NOTCHFOLK_TEST_XDG_DISCOVERY";
        if env::var_os(CHILD).is_some() {
            assert!(available_terminals().is_empty());
            assert!(gio_unix::DesktopAppInfo::new("example.desktop").is_none());
            return;
        }
        let fixture = Fixture::new();
        let user = fixture.desktop("user", "example.desktop", &format!("{ENTRY}Hidden=true\n"));
        let system = fixture.desktop("system", "example.desktop", ENTRY);
        // Gio caches the desktop registry. Exercise XDG precedence in a fresh
        // process rather than changing this test runner's global environment.
        let output = Command::new(env::current_exe().unwrap())
            .args(["--exact", "session::terminals::tests::hidden_user_entry_shadows_system_entry_and_unsafe_exec_is_rejected"])
            .env(CHILD, "1")
            .env("PATH", fixture.0.join("bin"))
            .env("XDG_DATA_HOME", user)
            .env("XDG_DATA_DIRS", system)
            .output().unwrap();
        assert!(output.status.success(), "{output:?}");
        for text in [
            ENTRY.replace("Exec=example", "Exec=sh -c bad"),
            ENTRY.replace("Exec=example", "Exec=./example"),
            ENTRY.replace("X-TerminalArgExec=--", "X-TerminalArgExec=-e sh -c"),
            ENTRY.replace("X-TerminalArgExec=--\n", ""),
            ENTRY.replace("TerminalEmulator", "Utility"),
        ] {
            let file = glib::KeyFile::new();
            file.load_from_data(&fixture.entry(&text), glib::KeyFileFlags::NONE)
                .unwrap();
            assert!(
                gio_unix::DesktopAppInfo::from_keyfile(&file)
                    .and_then(|app| desktop_target(
                        "unsafe.desktop",
                        &app,
                        fixture.0.join("bin").as_os_str()
                    ))
                    .is_none()
            );
        }
    }

    #[test]
    fn explicitly_empty_exec_argument_is_supported_without_guessing() {
        let fixture = Fixture::new();
        let file = glib::KeyFile::new();
        file.load_from_data(
            &fixture.entry(&ENTRY.replace("X-TerminalArgExec=--", "X-TerminalArgExec=")),
            glib::KeyFileFlags::NONE,
        )
        .unwrap();
        let app = gio_unix::DesktopAppInfo::from_keyfile(&file).unwrap();
        let target =
            desktop_target("example.desktop", &app, fixture.0.join("bin").as_os_str()).unwrap();
        let command = target
            .command(Path::new("/tmp"), &["/usr/bin/env".into()])
            .unwrap();
        assert_eq!(command.get_args().count(), 2);
    }
}
