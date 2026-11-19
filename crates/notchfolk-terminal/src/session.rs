// SPDX-License-Identifier: GPL-3.0-or-later

//! Each tab owns a separate, user-only tmux server, never the user's normal server.
//! Call blocking operations on a worker thread. Keep the session alive until VTE
//! spawn finishes, and drop it on spawn failure, child exit, or tab/window close.

use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

#[path = "warp.rs"]
mod warp;

#[path = "terminals.rs"]
mod terminals;
pub use terminals::{TerminalTarget, available_terminals, preferred_terminal};

use warp::WarpTabConfig;

// Each private server has one session; use its literal name for every command.
const SESSION: &str = "shell";
const HANDOFF_OPTION: &str = "@notchfolk-handoff";
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(15);
const MANUAL_HANDOFF_TIMEOUT: Duration = Duration::from_secs(120);
const CLIENT_CHECK_INTERVAL: Duration = Duration::from_millis(100);
const ENV_PROGRAM: &str = "/usr/bin/env";
const TERMINALS: &[(&str, &str)] = &[
    ("gnome-terminal", "GNOME Terminal"),
    ("kgx", "GNOME Console"),
    ("ghostty", "Ghostty"),
    ("wezterm", "WezTerm"),
    ("kitty", "kitty"),
    ("alacritty", "Alacritty"),
    ("warp-terminal", "Warp"),
];

/// Owns one private tmux session until a confirmed live handoff.
#[derive(Debug)]
pub struct Session {
    tmux: PathBuf,
    socket_name: OsString,
    transferred: AtomicBool,
    handoff_lock: Mutex<()>,
}

impl Session {
    /// Starts the user's native login shell in an isolated tmux server.
    ///
    /// tmux validates `$SHELL`, then the passwd login shell, then `/bin/sh`.
    /// No shell command is constructed and no user/system tmux config is loaded.
    pub fn new(cwd: Option<&Path>) -> io::Result<Self> {
        let cwd = initial_directory(cwd)?;
        let tmux = find_program("tmux").ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "Install tmux to use the terminal")
        })?;
        if !is_executable(Path::new(ENV_PROGRAM)) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "/usr/bin/env is required to isolate terminal sessions",
            ));
        }
        let session = Self {
            tmux,
            socket_name: random_name()?.into(),
            transferred: AtomicBool::new(false),
            handoff_lock: Mutex::new(()),
        };
        // current_dir, rather than tmux's -c, prevents tmux format expansion of
        // directory names containing #{...} or #(...). No shell-command means
        // tmux execs the selected login shell, not `sh -c "$SHELL"`.
        let mut command = session.command(false);
        configure_new_session(&mut command, &cwd);
        checked_output(&mut command, "starting the terminal shell")?;
        Ok(session)
    }

    /// Returns an argv suitable for VTE spawn, including its executable.
    ///
    /// The env wrapper also isolates attachment in existing desktop terminal
    /// processes, whose inherited TMUX and TMUX_TMPDIR may differ from ours.
    pub fn attach_argv(&self) -> Vec<OsString> {
        self.client_argv(["attach-session", "-E", "-t", SESSION].map(OsString::from))
    }

    /// Reads the live pane's working directory without shell integration scripts.
    pub fn cwd(&self) -> io::Result<PathBuf> {
        let output = self.run(
            &[
                "display-message",
                "-p",
                "-t",
                "shell:0.0",
                "#{pane_current_path}",
            ],
            "reading the shell's working directory",
        )?;
        parse_directory(output.stdout)
    }

    /// Transfers only after a new tmux client confirms attachment. Wave uses an
    /// explicit user-mediated copy/paste step, never a guessed command-line API.
    /// Cancellation and timeout revoke its one-use token before returning.
    pub fn handoff(
        &self,
        target: &TerminalTarget,
        cancelled: &AtomicBool,
        manual: impl FnOnce(String) -> io::Result<()>,
    ) -> io::Result<()> {
        let _lock = self.handoff_lock.try_lock().map_err(|_| {
            io::Error::new(
                io::ErrorKind::WouldBlock,
                "A handoff is already in progress",
            )
        })?;
        if self.transferred.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "This shell has already been transferred",
            ));
        }
        let previous = self.clients()?;
        if previous.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "Wait for the terminal tab to finish connecting",
            ));
        }

        let token = random_name()?;
        self.run(
            &["set-option", "-t", SESSION, HANDOFF_OPTION, &token],
            "authorizing the terminal handoff",
        )?;
        // The disposable Warp config stays alive through confirmation and
        // request revocation. Every return path then removes it via its guard.
        let mut warp_config = None;
        let result = (|| {
            if target.is_manual() {
                manual(manual_attach_command(&self.handoff_argv(&token))?)?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "Handoff cancelled",
                    ));
                }
                target.open_wave()?;
                return self.wait_for_client(&previous, None, cancelled, MANUAL_HANDOFF_TIMEOUT);
            }
            let command = if target.is_warp() {
                let opener = find_program("xdg-open").ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "xdg-open is required to open Warp")
                })?;
                let config = WarpTabConfig::new(&self.socket_name, &token)?;
                let mut command = Command::new(opener);
                command.arg(config.uri()).current_dir("/");
                sanitize_environment(&mut command);
                warp_config = Some(config);
                command
            } else {
                let argv = self.handoff_argv(&token);
                target.command(&self.cwd()?, &argv)?
            };
            let launcher = launch_desktop(command)?;
            self.wait_for_client(&previous, Some(&launcher), cancelled, HANDOFF_TIMEOUT)
        })();

        // Revoke the one-use request before deciding failure. An application
        // that starts after the timeout must not silently acquire the shell.
        let revoked = self.run(
            &["set-option", "-u", "-t", SESSION, HANDOFF_OPTION],
            "closing the terminal handoff request",
        );
        let attached = result.is_ok()
            || (revoked.is_ok()
                && self
                    .clients()
                    .is_ok_and(|clients| has_new_client(&previous, &clients)));
        drop(warp_config);
        if attached {
            self.transferred.store(true, Ordering::Release);
            if let Err(error) = revoked {
                eprintln!("notchfolk-terminal: {error}");
            }
            // Do not use attach -d: only the UI, after this result, removes VTE.
            // destroy-unattached remains armed, including after helper shutdown.
            return Ok(());
        }
        if let Err(error) = revoked {
            eprintln!("notchfolk-terminal: {error}");
        }
        result
    }

    fn command(&self, no_start: bool) -> Command {
        let mut command = Command::new(&self.tmux);
        if no_start {
            command.arg("-N");
        }
        command.args(["-u", "-f", "/dev/null", "-L"]);
        command.arg(&self.socket_name);
        sanitize_environment(&mut command);
        command
    }

    fn client_argv(&self, args: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
        [
            ENV_PROGRAM.into(),
            "-u".into(),
            "TMUX".into(),
            "-u".into(),
            "TMUX_PANE".into(),
            "-u".into(),
            "TMUX_TMPDIR".into(),
            self.tmux.as_os_str().to_owned(),
            "-N".into(),
            "-u".into(),
            "-f".into(),
            "/dev/null".into(),
            "-L".into(),
            self.socket_name.clone(),
        ]
        .into_iter()
        .chain(args)
        .collect()
    }

    fn handoff_argv(&self, token: &str) -> Vec<OsString> {
        // -F evaluates a tmux boolean, not a shell command. The token contains
        // only our fixed prefix and OS-random hex; no path enters this syntax.
        self.client_argv([
            "if-shell".into(),
            "-F".into(),
            "-t".into(),
            SESSION.into(),
            format!("#{{==:#{{{HANDOFF_OPTION}}},{token}}}").into(),
            "attach-session -E -t shell".into(),
            "display-message -p 'Notchfolk handoff request expired'".into(),
        ])
    }

    fn run(&self, args: &[&str], action: &str) -> io::Result<Output> {
        checked_output(self.command(true).args(args), action)
    }

    fn clients(&self) -> io::Result<Vec<u32>> {
        let output = self.run(
            &["list-clients", "-t", SESSION, "-F", "#{client_pid}"],
            "checking the terminal connection",
        )?;
        parse_clients(&output.stdout)
    }

    fn wait_for_client(
        &self,
        previous: &[u32],
        launcher: Option<&mpsc::Receiver<io::Result<ExitStatus>>>,
        cancelled: &AtomicBool,
        timeout: Duration,
    ) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if has_new_client(previous, &self.clients()?) {
                return Ok(());
            }
            if cancelled.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Handoff cancelled",
                ));
            }
            if let Some(launcher) = launcher {
                match launcher.try_recv() {
                    Ok(Ok(status)) if !status.success() => {
                        return Err(io::Error::other(format!(
                            "The external terminal exited with {status}; the shell remains here"
                        )));
                    }
                    Ok(Err(error)) => return Err(error),
                    // Successful launchers may exit immediately after D-Bus
                    // activation. Their exit alone is not proof of attachment.
                    Ok(Ok(_))
                    | Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => {}
                }
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "The external terminal did not connect; the shell remains here",
                ));
            }
            thread::sleep(CLIENT_CHECK_INTERVAL);
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.transferred.load(Ordering::Acquire) {
            return;
        }
        // The label is private to this tab. -N cannot accidentally create a new
        // server while cleaning up a failed spawn or an already-exited shell.
        match self.command(true).arg("kill-server").output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                let error = String::from_utf8_lossy(&output.stderr);
                // A normal shell exit / last-client detach already kills it.
                if !error.contains("no server running") && !error.contains("error connecting") {
                    eprintln!("notchfolk-terminal: cleaning up tmux: {}", error.trim());
                }
            }
            Err(error) => eprintln!("notchfolk-terminal: cleaning up tmux: {error}"),
        }
    }
}

fn configure_new_session(command: &mut Command, cwd: &Path) {
    command.current_dir(cwd).args([
        "set-option",
        "-g",
        "history-limit",
        "10000",
        ";",
        "new-session",
        "-d",
        "-s",
        "shell",
        "-n",
        "terminal",
        ";",
        "set-option",
        "-t",
        SESSION,
        "status",
        "off",
        ";",
        "set-option",
        "-t",
        SESSION,
        "mouse",
        "on",
        ";",
        "set-option",
        "-t",
        SESSION,
        "prefix",
        "None",
        ";",
        "set-hook",
        "-t",
        SESSION,
        "client-attached",
        "set-option -t shell destroy-unattached on",
    ]);
}

fn initial_directory(cwd: Option<&Path>) -> io::Result<PathBuf> {
    let path = match cwd {
        Some(path) => path.to_owned(),
        None => env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .map_or_else(env::current_dir, Ok)?,
    };
    let path = fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "The terminal working directory is not a directory",
        ));
    }
    Ok(path)
}

fn parse_directory(mut output: Vec<u8>) -> io::Result<PathBuf> {
    // Remove exactly the record terminator, not whitespace in a real filename.
    if output.last() == Some(&b'\n') {
        output.pop();
    }
    if output.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid shell cwd",
        ));
    }
    let path = PathBuf::from(OsString::from_vec(output));
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "The shell's working directory is unavailable",
        ));
    }
    Ok(path)
}

fn parse_clients(output: &[u8]) -> io::Result<Vec<u32>> {
    let text = std::str::from_utf8(output)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    text.lines()
        .map(|line| {
            line.parse::<u32>()
                .ok()
                .filter(|pid| *pid != 0)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "Invalid tmux client PID")
                })
        })
        .collect()
}

fn has_new_client(previous: &[u32], current: &[u32]) -> bool {
    current.iter().any(|pid| !previous.contains(pid))
}

fn sanitize_environment(command: &mut Command) {
    command
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .env_remove("TMUX_TMPDIR");
}

fn checked_output(command: &mut Command, action: &str) -> io::Result<Output> {
    let output = command.stdin(Stdio::null()).output()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(io::Error::other(format!(
            "Error {action}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn random_name() -> io::Result<String> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut name = String::with_capacity(10 + bytes.len() * 2);
    name.push_str("notchfolk-");
    for byte in bytes {
        name.push(HEX[(byte >> 4) as usize] as char);
        name.push(HEX[(byte & 15) as usize] as char);
    }
    Ok(name)
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

fn find_program(program: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    find_in_path(program, &path)
}

fn find_in_path(program: &str, path: &OsStr) -> Option<PathBuf> {
    // An empty/relative PATH entry must not execute a project-local impostor
    // just because the user opened a terminal in an untrusted directory.
    env::split_paths(path)
        .filter(|directory| directory.is_absolute())
        .map(|mut directory| {
            directory.push(program);
            directory
        })
        .find(|candidate| is_executable(candidate))
}

fn terminal_command(
    target: &str,
    executable: &Path,
    cwd: &Path,
    argv: &[OsString],
) -> io::Result<Command> {
    let mut command = Command::new(executable);
    match target {
        "gnome-terminal" => {
            command
                .args(["--window", "--working-directory"])
                .arg(cwd)
                .arg("--");
        }
        "kgx" => {
            command.arg("--working-directory").arg(cwd).arg("--");
        }
        "ghostty" => {
            let mut directory = OsString::from("--working-directory=");
            directory.push(cwd);
            command.arg(directory).arg("-e");
        }
        "wezterm" => {
            command
                .args([
                    "start",
                    "--always-new-process",
                    "--no-auto-connect",
                    "--domain",
                    "local",
                    "--cwd",
                ])
                .arg(cwd)
                .arg("--");
        }
        "kitty" => {
            command.arg("--directory").arg(cwd).arg("--");
        }
        "alacritty" => {
            command.arg("--working-directory").arg(cwd).arg("-e");
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "No live handoff for this terminal",
            ));
        }
    }
    command.args(argv).current_dir(cwd);
    sanitize_environment(&mut command);
    Ok(command)
}

/// The user explicitly pastes this into a local Wave shell. Quote every argv
/// element rather than joining a command string supplied by settings or a file.
fn manual_attach_command(argv: &[OsString]) -> io::Result<String> {
    let mut command = String::new();
    for arg in argv {
        let arg = arg
            .to_str()
            .filter(|value| !value.contains('\0'))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Wave clipboard handoff requires UTF-8 paths",
                )
            })?;
        if !command.is_empty() {
            command.push(' ');
        }
        command.push('\'');
        command.push_str(&arg.replace('\'', "'\\''"));
        command.push('\'');
    }
    Ok(command)
}

// Launch and reap in the same thread: if creating a thread fails, no app has
// been spawned; if callers disappear or time out, the child is still reaped.
// We never wait for the lifetime of a desktop application on the GTK thread.
fn launch_desktop(mut command: Command) -> io::Result<mpsc::Receiver<io::Result<ExitStatus>>> {
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (exited_tx, exited_rx) = mpsc::channel();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    thread::Builder::new()
        .name("terminal-launch".into())
        .spawn(move || {
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    if let Err(error) = started_tx.send(Err(error)) {
                        eprintln!("notchfolk-terminal: launch result lost: {error}");
                    }
                    return;
                }
            };
            // A dropped receiver does not cancel the app or skip child reaping.
            let _ = started_tx.send(Ok(()));
            let result = child.wait();
            if let Err(mpsc::SendError(result)) = exited_tx.send(result) {
                match result {
                    Err(error) => {
                        eprintln!("notchfolk-terminal: reaping terminal launcher: {error}")
                    }
                    Ok(status) if !status.success() => {
                        eprintln!("notchfolk-terminal: terminal launcher exited with {status}");
                    }
                    Ok(_) => {}
                }
            }
        })?;
    started_rx
        .recv()
        .map_err(|_| io::Error::other("The terminal launcher stopped before spawning"))??;
    Ok(exited_rx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn manual_wave_command_quotes_each_argument_without_interpolation() {
        let command =
            manual_attach_command(&["/usr/bin/env".into(), "a'b $HOME; $(bad)\n".into()]).unwrap();
        assert_eq!(command, "'/usr/bin/env' 'a'\\''b $HOME; $(bad)\n'");
        assert!(manual_attach_command(&[OsString::from_vec(vec![0xff])]).is_err());
        assert!(manual_attach_command(&["bad\0argument".into()]).is_err());
    }

    #[test]
    fn manual_cancellation_and_timeout_leave_session_owned() {
        let session = Session::new(None).unwrap();
        // Model the polling contract without any GUI or desktop process.
        let cancelled = AtomicBool::new(true);
        let error = session
            .wait_for_client(&[], None, &cancelled, MANUAL_HANDOFF_TIMEOUT)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        cancelled.store(false, Ordering::Release);
        let error = session
            .wait_for_client(&[], None, &cancelled, Duration::ZERO)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(session.cwd().is_ok());
        assert!(!session.transferred.load(Ordering::Acquire));
    }

    #[test]
    fn revoked_manual_ticket_cannot_authorize_a_late_attach() {
        let session = Session::new(None).unwrap();
        let token = random_name().unwrap();
        let condition = format!("#{{==:#{{{HANDOFF_OPTION}}},{token}}}");
        let probe = [
            "if-shell",
            "-F",
            "-t",
            SESSION,
            &condition,
            "display-message -p authorized",
            "display-message -p expired",
        ];
        session
            .run(
                &["set-option", "-t", SESSION, HANDOFF_OPTION, &token],
                "authorize",
            )
            .unwrap();
        assert_eq!(
            session.run(&probe, "check authorization").unwrap().stdout,
            b"authorized\n"
        );
        session
            .run(
                &["set-option", "-u", "-t", SESSION, HANDOFF_OPTION],
                "revoke",
            )
            .unwrap();
        assert_eq!(
            session.run(&probe, "check revoked ticket").unwrap().stdout,
            b"expired\n"
        );
        // A retry uses a fresh token; an old clipboard command remains invalid.
        session
            .run(
                &[
                    "set-option",
                    "-t",
                    SESSION,
                    HANDOFF_OPTION,
                    &random_name().unwrap(),
                ],
                "retry",
            )
            .unwrap();
        assert_eq!(
            session.run(&probe, "check old ticket").unwrap().stdout,
            b"expired\n"
        );
    }

    #[test]
    fn cwd_keeps_filename_bytes_and_only_removes_one_newline() {
        let bytes = b"/tmp/space \xff\n\n".to_vec();
        assert_eq!(
            parse_directory(bytes).unwrap().as_os_str().as_bytes(),
            b"/tmp/space \xff\n"
        );
        for bytes in [b"".as_slice(), b"\n", b"relative\n", b"/tmp/\0bad\n"] {
            assert!(parse_directory(bytes.to_vec()).is_err());
        }
    }

    #[test]
    fn shell_and_directory_are_not_interpolated_as_tmux_commands() {
        let cwd = Path::new("/tmp/#(touch bad); #{pane_id} 'directory'");
        let mut command = Command::new("tmux");
        configure_new_session(&mut command, cwd);
        assert_eq!(command.get_current_dir(), Some(cwd));
        let args: Vec<_> = command.get_args().collect();
        assert!(!args.contains(&cwd.as_os_str()));
        assert!(!args.contains(&OsStr::new("-c")));
        // This terminator immediately follows new-session options: no command
        // string overrides tmux's validated native login-shell selection.
        let start = args.iter().position(|arg| *arg == "new-session").unwrap();
        assert_eq!(
            &args[start..start + 8],
            [
                "new-session",
                "-d",
                "-s",
                "shell",
                "-n",
                "terminal",
                ";",
                "set-option"
            ]
            .map(OsStr::new)
        );
        assert_eq!(
            &args[..5],
            ["set-option", "-g", "history-limit", "10000", ";"].map(OsStr::new)
        );
    }

    #[test]
    fn all_live_launchers_preserve_argv_and_hostile_directory_names() {
        let cwd = Path::new("/tmp/a ' ; $(echo bad) #() &?\n");
        let argv = vec![
            OsString::from(ENV_PROGRAM),
            "argument with spaces; $HOME".into(),
        ];
        for target in [
            "gnome-terminal",
            "kgx",
            "ghostty",
            "wezterm",
            "kitty",
            "alacritty",
        ] {
            let executable = Path::new("/usr/bin").join(target);
            let command = terminal_command(target, &executable, cwd, &argv).unwrap();
            assert_eq!(command.get_program(), executable.as_os_str());
            assert_eq!(command.get_current_dir(), Some(cwd));
            let args: Vec<_> = command.get_args().collect();
            assert_eq!(
                &args[args.len() - argv.len()..],
                argv.iter().map(OsString::as_os_str).collect::<Vec<_>>()
            );
            for key in ["TMUX", "TMUX_PANE", "TMUX_TMPDIR"] {
                assert!(
                    command
                        .get_envs()
                        .any(|(name, value)| name == key && value.is_none())
                );
            }
        }
        assert!(
            terminal_command("warp-terminal", Path::new("/bin/warp-terminal"), cwd, &argv).is_err()
        );
    }

    #[test]
    fn an_existing_client_or_successful_launcher_is_not_a_transfer() {
        assert!(!has_new_client(&[10], &[10]));
        assert!(!has_new_client(&[10], &[]));
        assert!(has_new_client(&[10], &[10, 20]));
        assert!(has_new_client(&[10], &[20]));
        assert_eq!(parse_clients(b"10\n20\n").unwrap(), vec![10, 20]);
        for invalid in [b"0\n".as_slice(), b"oops\n", b"\xff\n"] {
            assert!(parse_clients(invalid).is_err());
        }
    }

    #[test]
    fn program_search_ignores_current_directory_and_relative_path_entries() {
        assert!(find_in_path("sh", OsStr::new(":.:bin")).is_none());
        assert_eq!(
            find_in_path("sh", OsStr::new("/bin")),
            Some(PathBuf::from("/bin/sh"))
        );
        assert!(!is_executable(Path::new("/bin")));
    }

    #[test]
    fn invalid_initial_directory_is_rejected_before_starting_tmux() {
        assert_eq!(
            initial_directory(Some(Path::new("/dev/null")))
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotADirectory
        );
        let missing = Path::new("/dev/null/not-a-directory");
        assert!(initial_directory(Some(missing)).is_err());
    }

    #[test]
    fn attachments_are_isolated_and_never_detach_the_original_client_early() {
        // No server is created in this argv-only test, so there is nothing to
        // clean up. Production sessions always retain their normal destructor.
        let session = std::mem::ManuallyDrop::new(Session {
            tmux: "/usr/bin/tmux".into(),
            socket_name: "notchfolk-test".into(),
            transferred: AtomicBool::new(false),
            handoff_lock: Mutex::new(()),
        });
        let argv = session.attach_argv();
        assert_eq!(argv[0], ENV_PROGRAM);
        assert!(argv.windows(2).any(|pair| pair == ["-L", "notchfolk-test"]));
        assert!(argv.iter().any(|arg| arg == "-N"));
        assert!(!argv.iter().any(|arg| arg == "-d"));
        for key in ["TMUX", "TMUX_PANE", "TMUX_TMPDIR"] {
            assert!(argv.windows(2).any(|pair| pair == ["-u", key]));
        }
        let handoff = session.handoff_argv("notchfolk-012345");
        assert!(
            handoff
                .iter()
                .any(|arg| { arg == "#{==:#{@notchfolk-handoff},notchfolk-012345}" })
        );
        assert_eq!(handoff[handoff.len() - 2], "attach-session -E -t shell");
    }

    #[test]
    fn private_session_starts_in_requested_directory_and_cleans_up() {
        let cwd = fs::canonicalize(env::temp_dir()).unwrap();
        let session = Session::new(Some(&cwd)).expect("tmux must start a private terminal session");
        assert_eq!(session.cwd().unwrap(), cwd);

        let mut probe = session.command(true);
        probe.arg("list-sessions");
        assert!(probe.output().unwrap().status.success());
        drop(session);
        assert!(!probe.output().unwrap().status.success());
    }

    #[test]
    fn desktop_launch_reports_spawn_and_child_failures_without_detaching() {
        assert!(launch_desktop(Command::new("/dev/null/not-an-executable")).is_err());
        let receiver = launch_desktop(Command::new("/bin/false")).unwrap();
        let status = receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(!status.success());
    }
}
