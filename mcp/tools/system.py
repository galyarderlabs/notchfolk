# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The System domain: the world maintains and repairs the ground it stands on.

The tool logic follows the reference server's, as read in Phase 0
(docs/mcp-world-apis.md §1): one executor shape for every command, the same
return shapes ({ok, ...} with truncated output), the same guards (write roots,
blocked commands, kill rules, delete refusals) with home-relative roots, and
system_update's check-then-confirm rule. The audit log is the one recorded
open decision; it is not mirrored yet.

The toolchain never hardcodes a package manager: it reads /etc/os-release
(ID, ID_LIKE) and picks the matching one — Arch → pacman, Debian/Ubuntu →
apt, Fedora/RHEL → dnf, openSUSE → zypper — with the AUR helper (yay or
paru, whichever is installed) on the Arch family only, and flatpak, uv, npm
and bun beside it. An unknown distro is reported as unsupported, never
guessed; a toolchain whose binary is absent is reported as unavailable,
never as an error.
"""

import os
import re
import shutil
import subprocess
import time

READ_SCOPES = {
    "system_stats": "system:read",
    "system_logs": "system:read",
    "system_list_files": "system:read",
    "system_read_file": "system:read",
    "system_search_files": "system:read",
    "system_toolchain_status": "system:read",
    "system_list_processes": "system:read",
}

WRITE_SCOPES = {
    "system_exec": "system:write",
    "system_write_file": "system:write",
    "system_patch_file": "system:write",
    "system_file_ops": "system:write",
    "system_service": "system:write",
    "system_kill_process": "system:write",
    "system_update": "system:write",
}

HOME = os.path.expanduser("~")
# The reference's guards, with home-relative roots: writes only in the user's
# own home and /tmp; reads there, plus the system's logs and unit files.
WRITE_ROOTS = (HOME, "/tmp")
READ_ROOTS = (*WRITE_ROOTS, "/var/log", "/etc/systemd")
STDOUT_LIMIT = 20000
STDERR_LIMIT = 8000
# The reference's blocked fragments and patterns: the commands that take the
# machine down, and the pipes that run strangers' code.
BLOCKED_FRAGMENTS = ("rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf $HOME", ":(){:|:&};:",
                     "mkfs", "dd if=", ">/dev/sda", ">/dev/nvme", ">/dev/vda",
                     "chmod -R 777 /", "chmod 777 /", "chown -R /")
BLOCKED_PATTERNS = (re.compile(r"rm\s+.*\s/\s*$"), re.compile(r"\b(shutdown|reboot|halt|poweroff|init 0)\b"),
                    re.compile(r">\s*/dev/(sda|nvme|vda|hda)"),
                    re.compile(r"(curl|wget)[^|]*\|\s*(ba)?sh"))
KILL_SIGNALS = ("TERM", "KILL", "HUP", "INT", "QUIT", "USR1", "USR2")
# A killall never touches the machine's own world: notchfolkd itself, and
# whatever the machine adds to NOTCHFOLK_MCP_PROTECTED_SERVICES (comma-separated).
PROTECTED_NAMES = {"notchfolkd", *{name.strip() for name in
                     os.getenv("NOTCHFOLK_MCP_PROTECTED_SERVICES", "").split(",") if name.strip()}}
TOOLCHAINS = ("flatpak", "uv", "npm", "bun")
# The big distros only (the spec's rule): an unknown distro is unsupported.
DISTRO_PACKAGES = {"arch": "pacman", "debian": "apt", "ubuntu": "apt", "fedora": "dnf",
                   "rhel": "dnf", "opensuse": "zypher".replace("zypher", "zypper")}


def guard_command(command: str):
    """Refuses the blocked fragments and patterns (the reference's list)."""
    for fragment in BLOCKED_FRAGMENTS:
        if fragment in command:
            raise RuntimeError(f"refused: the command contains {fragment!r}")
    for pattern in BLOCKED_PATTERNS:
        if pattern.search(command):
            raise RuntimeError("refused: the command matches a blocked pattern")


def resolve(path: str, roots) -> str:
    """The real path of `path`, which must live under one of `roots`."""
    real = os.path.realpath(os.path.expanduser(path))
    for root in roots:
        try:
            real.removeprefix(os.path.realpath(root))
        except AttributeError:
            pass
        if os.path.commonpath([os.path.realpath(root), real]) == os.path.realpath(root):
            return real
    raise RuntimeError(f"{path} is outside the allowed roots")


def distro():
    """The distro's package manager, or None when unsupported: read, never guessed."""
    fields = {}
    try:
        with open("/etc/os-release", encoding="utf-8") as release:
            for line in release:
                if "=" in line:
                    key, value = line.rstrip("\n").split("=", 1)
                    fields[key] = value.strip('"').lower()
    except OSError:
        return None
    for field in (fields.get("ID"), *(fields.get("ID_LIKE") or "").split()):
        if field in DISTRO_PACKAGES:
            return DISTRO_PACKAGES[field]
    return None


def aur_helper():
    """The installed AUR helper on the Arch family, else None."""
    if distro() == "pacman":
        return next((helper for helper in ("yay", "paru") if shutil.which(helper)), None)
    return None


def run(command, timeout=120):
    """The reference's executor: one shape for every command, output truncated."""
    if isinstance(command, str):
        guard_command(command)
    result = subprocess.run(command, shell=isinstance(command, str), capture_output=True,
                             text=True, timeout=timeout, env={**os.environ, "HOME": HOME})
    return {"ok": result.returncode == 0, "exit_code": result.returncode,
            "stdout": result.stdout[:STDOUT_LIMIT], "stderr": result.stderr[:STDERR_LIMIT],
            "command": command if isinstance(command, str) else " ".join(command)}


def register(mcp, authorize, write):
    """Registers the System domain's tools; the domain is always present — it is local."""

    @mcp.tool
    async def system_stats() -> dict:
        """The machine at a glance: uptime, memory, disk, listening ports, busiest processes."""
        await authorize("system_stats")
        return {"ok": True,
                "uptime": run("uptime")["stdout"].strip(),
                "memory": run("free -h")["stdout"],
                "disk": run(f"df -h / {HOME}")["stdout"],
                "ports": run("ss -ltnp | head -n 30")["stdout"],
                "processes": run("ps aux --sort=-%cpu | head -n 15")["stdout"]}

    @mcp.tool
    async def system_logs(service: str, lines: int = 100) -> dict:
        """A user service's journal, newest last, from journald."""
        await authorize("system_logs")
        if not shutil.which("journalctl"):
            raise RuntimeError("journald is not available on this machine")
        result = run(["journalctl", "--user", "-u", service, "-n", str(max(1, min(int(lines), 500))),
                      "--no-pager"], timeout=60)
        return {**result, "stdout": "\n".join(result["stdout"].splitlines()[-max(1, min(int(lines), 500)):])}

    @mcp.tool
    async def system_list_files(path: str = "~", limit: int = 80) -> dict:
        """A directory's entries: name, whether a directory, size, changed when."""
        await authorize("system_list_files")
        real = resolve(path, READ_ROOTS)
        entries = []
        with os.scandir(real) as directory:
            for entry in directory:
                info = entry.stat(follow_symlinks=False)
                entries.append({"name": entry.name, "is_dir": entry.is_dir(follow_symlinks=False),
                                "size": info.st_size, "mtime": info.st_mtime})
                if len(entries) >= max(1, min(int(limit), 500)):
                    break
        entries.sort(key=lambda entry: (not entry["is_dir"], entry["name"].lower()))
        return {"ok": True, "path": path, "count": len(entries), "entries": entries}

    @mcp.tool
    async def system_read_file(path: str, max_bytes: int = 80000) -> dict:
        """A file's contents as text; a directory or a binary file is refused."""
        await authorize("system_read_file")
        real = resolve(path, READ_ROOTS)
        if os.path.isdir(real):
            raise RuntimeError(f"{path} is a directory")
        size = max(1, min(int(max_bytes), 200000))
        with open(real, "rb") as file:
            head = file.read(size + 1)
        if b"\0" in head[:4096]:
            raise RuntimeError(f"{path} is a binary file")
        return {"ok": True, "path": path, "size": len(head), "truncated": len(head) > size,
                "content": head[:size].decode("utf-8", errors="replace")}

    @mcp.tool
    async def system_search_files(pattern: str, path: str = "~", glob: str = "*",
                                   limit: int = 50) -> dict:
        """Lines matching `pattern` under `path` (grep -R -n), only in files named `glob`."""
        await authorize("system_search_files")
        if not shutil.which("grep"):
            raise RuntimeError("grep is not available on this machine")
        real = resolve(path, READ_ROOTS)
        result = run(["grep", "-R", "-n", f"--include={glob}", "-E", pattern, real], timeout=120)
        matches = result["stdout"].splitlines()[:max(1, min(int(limit), 200))]
        return {"ok": True, "matches": matches, "count": len(matches)}

    @mcp.tool
    async def system_toolchain_status() -> dict:
        """The installed package managers and toolchains, each probed; an absent
        binary is reported unavailable, not as an error."""
        await authorize("system_toolchain_status")
        package_manager = distro()
        binaries = list(TOOLCHAINS)
        if package_manager:
            binaries.append(package_manager)
        helper = aur_helper()
        if helper:
            binaries.append(helper)
        checks = {}
        for binary in binaries:
            if not shutil.which(binary):
                checks[binary] = {"ok": True, "output": "unavailable"}
                continue
            probed = run([binary, "--version"], timeout=30)
            checks[binary] = {"ok": probed["ok"], "exit_code": probed["exit_code"],
                              "output": probed["stdout"].splitlines()[0] if probed["stdout"] else probed["stderr"][:400]}
        checks["distro_package_manager"] = {"ok": True, "output": package_manager or "unsupported distro"}
        return {"ok": True, "checks": checks}

    @mcp.tool
    async def system_list_processes(action: str = "list") -> dict:
        """The running processes, busiest by CPU and by memory."""
        await authorize("system_list_processes")
        if action != "list":
            raise RuntimeError(f"unknown action {action}: list")
        return {"ok": True,
                "by_cpu": run("ps aux --sort=-%cpu | head -n 30")["stdout"],
                "by_memory": run("ps aux --sort=-%mem | head -n 20")["stdout"]}

    @mcp.tool
    async def system_exec(command: str, timeout: int = 30, workdir: str = "~") -> dict:
        """Runs a shell command and reports its output; the blocked fragments and
        patterns are refused (the reference's guard list)."""
        await write("system_exec")
        if not os.path.isdir(os.path.expanduser(workdir)):
            raise RuntimeError(f"{workdir} is not a directory")
        try:
            result = subprocess.run(command, shell=True, capture_output=True, text=True,
                                     timeout=max(1, min(int(timeout), 120)),
                                     cwd=os.path.expanduser(workdir),
                                     env={**os.environ, "HOME": HOME})
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"timeout after {timeout}s", "command": command}
        return {"ok": result.returncode == 0, "exit_code": result.returncode,
                "stdout": result.stdout[:STDOUT_LIMIT], "stderr": result.stderr[:STDERR_LIMIT],
                "command": command}

    @mcp.tool
    async def system_write_file(path: str, content: str, mode: str = "644") -> dict:
        """Writes `content` to `path` under the write roots (the user's home and
        /tmp), making its folders as needed."""
        await write("system_write_file")
        real = resolve(path, WRITE_ROOTS)
        os.makedirs(os.path.dirname(real) or ".", exist_ok=True)
        with open(real, "w", encoding="utf-8") as file:
            file.write(content)
        os.chmod(real, int(mode, 8))
        return {"ok": True, "path": path, "bytes": len(content.encode("utf-8"))}

    @mcp.tool
    async def system_patch_file(path: str, old_string: str, new_string: str,
                                 replace_all: bool = False) -> dict:
        """Applies an edit to an existing file under the write roots: `old_string`
        must be present and unique, unless replace_all."""
        await write("system_patch_file")
        real = resolve(path, WRITE_ROOTS)
        with open(real, encoding="utf-8") as file:
            text = file.read()
        count = text.count(old_string)
        if count == 0:
            return {"ok": False, "error": f"old_string not found in {path}"}
        if count > 1 and not replace_all:
            return {"ok": False, "error": f"old_string found {count} times in {path}; replace_all=true to replace every one"}
        patched = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)
        with open(real, "w", encoding="utf-8") as file:
            file.write(patched)
        return {"ok": True, "path": path, "bytes": len(patched.encode("utf-8")),
                "replaced": count if replace_all else 1}

    @mcp.tool
    async def system_file_ops(action: str, source: str, destination: str = "",
                              mode: str = "") -> dict:
        """Moves, copies, deletes, makes a directory, or changes permissions, under
        the write roots; delete refuses /, /home, the user's home and /tmp."""
        await write("system_file_ops")
        if action not in {"move", "copy", "delete", "mkdir", "chmod"}:
            raise RuntimeError(f"unknown action {action}: move, copy, delete, mkdir or chmod")
        real_source = resolve(source, WRITE_ROOTS)
        if action == "delete" and real_source in {"/", "/home", "/tmp", HOME}:
            raise RuntimeError("refused: that directory is the machine's, not a file's")
        if action == "move":
            real_destination = resolve(destination, WRITE_ROOTS)
            os.makedirs(os.path.dirname(real_destination) or ".", exist_ok=True)
            shutil.move(real_source, real_destination)
            return {"ok": True, "action": action, "source": source, "destination": destination}
        if action == "copy":
            real_destination = resolve(destination, WRITE_ROOTS)
            os.makedirs(os.path.dirname(real_destination) or ".", exist_ok=True)
            if os.path.isdir(real_source):
                shutil.copytree(real_source, real_destination, dirs_exist_ok=True)
            else:
                shutil.copy2(real_source, real_destination)
            return {"ok": True, "action": action, "source": source, "destination": destination}
        if action == "delete":
            if os.path.isdir(real_source):
                shutil.rmtree(real_source)
            else:
                os.remove(real_source)
            return {"ok": True, "action": action, "source": source}
        if action == "mkdir":
            os.makedirs(real_source, exist_ok=True)
            return {"ok": True, "action": action, "source": source}
        if action == "chmod":
            if not mode:
                raise RuntimeError("chmod needs mode, as an octal string like 600")
            os.chmod(real_source, int(mode, 8))
            return {"ok": True, "action": action, "source": source, "mode": mode}

    @mcp.tool
    async def system_service(action: str, service: str = "") -> dict:
        """Asks or tells systemd about a user service: status, start, stop,
        restart, reload, enable, disable, is-active, is-enabled, daemon-reload."""
        await write("system_service")
        mutating = {"start", "stop", "restart", "reload", "enable", "disable"}
        if action not in {*mutating, "status", "is-active", "is-enabled", "daemon-reload"}:
            raise RuntimeError(f"unknown action {action}")
        if action == "status":
            result = run(["systemctl", "--user", "status", service, "--no-pager", "-l"], timeout=60)
            return {**result, "stdout": result["stdout"][:8000]}
        if action == "daemon-reload":
            return run(["systemctl", "--user", "daemon-reload"], timeout=60)
        if not service:
            raise RuntimeError(f"{action} needs a service")
        return run(["systemctl", "--user", action, service], timeout=120)

    @mcp.tool
    async def system_kill_process(action: str, target: str = "", signal: str = "TERM") -> dict:
        """Terminates a process: kill takes a numeric PID, killall a name — never
        a protected service's. Signals: TERM, KILL, HUP, INT, QUIT, USR1, USR2."""
        await write("system_kill_process")
        if signal.upper() not in KILL_SIGNALS:
            raise RuntimeError(f"unknown signal {signal}: {'/'.join(KILL_SIGNALS)}")
        if action == "kill":
            if not target.isdigit():
                raise RuntimeError("kill needs a numeric PID")
            return run(["kill", "-s", signal.upper(), target], timeout=30)
        if action == "killall":
            if not target or target.lower() in PROTECTED_NAMES:
                raise RuntimeError("killall needs a name, and not a protected service's")
            return run(["pkill", f"-{signal.upper()}", "-f", target], timeout=30)
        raise RuntimeError(f"unknown action {action}: kill or killall")

    @mcp.tool
    async def system_update(domain: str, action: str = "check", confirm: bool = False) -> dict:
        """Updates the system or a toolchain. `action=check` (the default) reports
        what would change; `action=update` refuses without `confirm=true` and
        runs with it. `domain`: system, flatpak, uv, npm, bun, or local —
        'system' is the detected distro package manager (with the AUR helper on
        the Arch family), 'local' the machine's own update/upgrade scripts."""
        await write("system_update")
        if action not in {"check", "update"}:
            raise RuntimeError(f"unknown action {action}: check or update")
        # The confirmation gate comes first, as the reference has it: an update is
        # refused without confirm even when its toolchain is unavailable.
        if action == "update" and not confirm:
            return {"ok": False, "error": "confirm=true required for action=update. Run action=check first."}
        package_manager = distro()
        helper = aur_helper()
        if domain == "system":
            if not package_manager:
                raise RuntimeError("this distro is unsupported: /etc/os-release names no known package manager")
            manager = helper or package_manager
            check = [manager, "-Qu" if manager == "pacman" else
                     "list --upgradable" if manager == "apt" else
                     "check-update" if manager == "dnf" else "list-updates"]
            command = [manager, "-Syu" if manager == "pacman" else
                       "upgrade" if manager == "apt" else
                       "upgrade" if manager == "dnf" else "update"]
        elif domain in TOOLCHAINS:
            if not shutil.which(domain):
                return {"ok": True, "unavailable": domain}
            check = [domain, "outdated" if domain == "npm" else "--version"]
            command = [domain, "update", *(["-g"] if domain == "npm" else [])]
        elif domain == "local":
            found = [script for script in ("~/.local/bin/update", "~/.local/bin/upgrade")
                     if os.path.isfile(os.path.expanduser(script))]
            if not found:
                return {"ok": True, "unavailable": "local"}
            script = found[0]
            check = [os.path.expanduser(script), "--check"]
            command = [os.path.expanduser(script)]
        else:
            raise RuntimeError(f"unknown domain {domain}: system, flatpak, uv, npm, bun or local")
        if action == "check":
            result = run(check, timeout=120)
            return {"ok": result["ok"], "domain": domain, "check": result["stdout"] or result["stderr"]}
        return {**run(command, timeout=1800), "domain": domain}
