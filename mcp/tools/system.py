# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Galyarder Labs

"""The System domain: the world maintains and repairs the ground it stands on.

The tools run on the machine Notchfolk runs on, through local subprocesses,
the filesystem, journald and systemd. The toolchain never hardcodes a package
manager: it reads /etc/os-release (ID, ID_LIKE) and picks the matching one —
Arch → pacman, Debian/Ubuntu → apt, Fedora/RHEL → dnf, openSUSE → zypper —
with the AUR helper (yay or paru, whichever is installed) on the Arch family
only, and flatpak, uv, npm and bun beside it. An unknown distro is reported
as unsupported, never guessed; a toolchain whose binary is absent is reported
as unavailable, never as an error.
"""

import os
import shutil
import subprocess

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

# What system_update may update, and how each is run. The distro package
# manager is filled in by detection; the AUR helper only on the Arch family.
TOOLCHAINS = ("flatpak", "uv", "npm", "bun")
# The big distros only (see the plan): an unknown distro is unsupported.
DISTRO_PACKAGES = {"arch": "pacman", "debian": "apt", "ubuntu": "apt", "fedora": "dnf",
                   "rhel": "dnf", "opensuse": "zypper"}


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


def run(command, timeout=60):
    """Runs `command` and returns its output; a failure is a normal, isolated error."""
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"{command[0]} failed ({result.returncode})")
    return result.stdout


def register(mcp, authorize, write):
    """Registers the System domain's tools; the domain is always present — it is local."""

    @mcp.tool
    async def system_stats() -> dict:
        """CPU, memory, disk and load, as the machine reports them."""
        await authorize("system_stats")
        load1, load5, load15 = (float(value) for value in
                                open("/proc/loadavg", encoding="utf-8").read().split()[:3])
        memory = {}
        for line in open("/proc/meminfo", encoding="utf-8"):
            key, value, *_ = line.split()
            memory[key.rstrip(":")] = int(value)
        total, available = memory.get("MemTotal", 0), memory.get("MemAvailable", 0)
        usage = shutil.disk_usage(os.path.expanduser("~"))
        return {"load": [load1, load5, load15],
                "memory": {"total_mb": total // 1024, "available_mb": available // 1024,
                           "used_percent": round(100 * (total - available) / total, 1) if total else 0},
                "disk": {"total_gb": round(usage.total / 10**9, 1), "free_gb": round(usage.free / 10**9, 1),
                         "used_percent": round(100 * usage.used / usage.total, 1) if usage.total else 0}}

    @mcp.tool
    async def system_logs(lines: int = 50, unit: str | None = None) -> str:
        """System and service logs, newest last, from journald."""
        await authorize("system_logs")
        if not shutil.which("journalctl"):
            raise RuntimeError("journald is not available on this machine")
        command = ["journalctl", "--no-pager", "-n", str(max(1, min(int(lines), 500)))]
        if unit:
            command += ["-u", unit]
        return run(command)

    @mcp.tool
    async def system_list_files(path: str = "~") -> list[dict]:
        """The files in a directory: names, sizes, and which are directories."""
        await authorize("system_list_files")
        target = os.path.expanduser(path)
        entries = []
        with os.scandir(target) as directory:
            for entry in directory:
                info = entry.stat(follow_symlinks=False)
                entries.append({"name": entry.name, "size": info.st_size,
                                "directory": entry.is_dir(follow_symlinks=False)})
        return sorted(entries, key=lambda entry: (not entry["directory"], entry["name"].lower()))

    @mcp.tool
    async def system_read_file(path: str, max_bytes: int = 262144) -> str:
        """A file's contents, as text; a binary file is refused rather than mangled."""
        await authorize("system_read_file")
        target = os.path.expanduser(path)
        with open(target, "rb") as file:
            head = file.read(max_bytes + 1)
        if b"\0" in head[:4096]:
            raise RuntimeError(f"{path} is a binary file")
        text = head[:max_bytes].decode("utf-8", errors="replace")
        return text + ("\n… (truncated)" if len(head) > max_bytes else "")

    @mcp.tool
    async def system_search_files(query: str, root: str = "~", content: bool = False,
                                   limit: int = 50) -> list[str]:
        """Files whose name contains `query` under `root` — or, with `content`, files
        whose contents do (grep -rl)."""
        await authorize("system_search_files")
        target = os.path.expanduser(root)
        if content:
            if not shutil.which("grep"):
                raise RuntimeError("grep is not available on this machine")
            output = run(["grep", "-rl", "--binary-files=without-match", "-m", "1",
                          query, target], timeout=120)
            return [line for line in output.splitlines() if line][:limit]
        matches = []
        for current, directories, files in os.walk(target):
            directories[:] = [d for d in directories if not d.startswith(".")]
            for name in files:
                if query.lower() in name.lower():
                    matches.append(os.path.join(current, name))
                    if len(matches) >= limit:
                        return matches
        return matches

    @mcp.tool
    async def system_toolchain_status() -> dict:
        """The installed package managers and toolchains, with versions; an absent
        binary is reported unavailable, not as an error."""
        await authorize("system_toolchain_status")
        status = {}
        package_manager = distro()
        status["distro_package_manager"] = package_manager or "unsupported distro"
        helper = aur_helper()
        if helper:
            status["aur_helper"] = helper
        binaries = list(TOOLCHAINS)
        if package_manager:
            binaries.append(package_manager)
        for binary in binaries:
            version = shutil.which(binary)
            status[binary] = run([binary, "--version"], timeout=30).splitlines()[0] \
                if version else "unavailable"
        return status

    @mcp.tool
    async def system_list_processes(limit: int = 20) -> list[dict]:
        """The running processes, busiest first: pid, command, CPU and memory."""
        await authorize("system_list_processes")
        output = run(["ps", "-eo", "pid,comm,%cpu,%mem", "--sort=-%cpu",
                      "--no-headers"], timeout=30)
        processes = []
        for line in output.splitlines()[:max(1, min(int(limit), 200))]:
            pid, command, cpu, memory = line.split(None, 3)
            processes.append({"pid": int(pid), "command": command,
                              "cpu_percent": float(cpu), "memory_percent": float(memory)})
        return processes

    @mcp.tool
    async def system_exec(command: str, timeout: int = 60, cwd: str | None = None) -> dict:
        """Runs a shell command and returns its output; a failure is reported, not raised."""
        await write("system_exec")
        result = subprocess.run(command, shell=True, capture_output=True, text=True,
                                 timeout=max(1, min(int(timeout), 600)),
                                 cwd=os.path.expanduser(cwd) if cwd else None)
        return {"returncode": result.returncode, "stdout": result.stdout,
                "stderr": result.stderr}

    @mcp.tool
    async def system_write_file(path: str, content: str) -> str:
        """Writes `content` to `path`, creating the file (and its folders) as needed."""
        await write("system_write_file")
        target = os.path.expanduser(path)
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "w", encoding="utf-8") as file:
            file.write(content)
        return f"wrote {len(content)} bytes to {path}"

    @mcp.tool
    async def system_patch_file(path: str, find: str, replace: str, all: bool = True) -> str:
        """Applies an edit to an existing file: every `find` replaced by `replace`
        (or only the first, with all=False)."""
        await write("system_patch_file")
        target = os.path.expanduser(path)
        with open(target, encoding="utf-8") as file:
            text = file.read()
        patched = text.replace(find, replace) if all else text.replace(find, replace, 1)
        if patched == text:
            return f"nothing to patch: {find!r} not found in {path}"
        with open(target, "w", encoding="utf-8") as file:
            file.write(patched)
        return f"patched {path}"

    @mcp.tool
    async def system_file_ops(op: str, source: str, target: str | None = None,
                              mode: str | None = None) -> str:
        """Moves, copies, deletes, makes a directory, or changes permissions.
        op: move | copy | delete | mkdir | chmod."""
        await write("system_file_ops")
        source_path = os.path.expanduser(source)
        target_path = os.path.expanduser(target) if target else None
        if op == "move":
            shutil.move(source_path, target_path)
            return f"moved {source} to {target}"
        if op == "copy":
            shutil.copy2(source_path, target_path)
            return f"copied {source} to {target}"
        if op == "delete":
            if os.path.isdir(source_path):
                shutil.rmtree(source_path)
            else:
                os.remove(source_path)
            return f"deleted {source}"
        if op == "mkdir":
            os.makedirs(source_path, exist_ok=True)
            return f"made {source}"
        if op == "chmod":
            os.chmod(source_path, int(mode, 8))
            return f"chmod {mode} {source}"
        raise RuntimeError(f"unknown op {op}: move, copy, delete, mkdir or chmod")

    @mcp.tool
    async def system_service(action: str, unit: str) -> str:
        """Starts, stops or restarts a systemd service (user units with --user)."""
        await write("system_service")
        if action not in {"start", "stop", "restart"}:
            raise RuntimeError(f"unknown action {action}: start, stop or restart")
        run(["systemctl", action, unit], timeout=120)
        return f"{action}ed {unit}"

    @mcp.tool
    async def system_kill_process(pid: int, signal: str = "TERM") -> str:
        """Terminates a running process; SIGKILL only when asked for by name."""
        await write("system_kill_process")
        import signal as signals
        number = getattr(signals, f"SIG{signal.upper()}", None)
        if number is None:
            raise RuntimeError(f"unknown signal {signal}")
        os.kill(int(pid), number)
        return f"sent SIG{signal.upper()} to {pid}"

    @mcp.tool
    async def system_update(what: list[str], confirm: bool = False) -> dict:
        """Updates the system or a toolchain. Without `confirm`, returns the plan
        and runs nothing; with `confirm`, runs it. `what` may name: system, flatpak,
        uv, npm, bun, local — 'system' is the detected distro package manager
        (with the AUR helper on the Arch family), 'local' the machine's own
        update/upgrade scripts if it has any."""
        await write("system_update")
        commands = []
        unavailable = []
        package_manager = distro()
        helper = aur_helper()
        for item in what:
            if item == "system":
                if not package_manager:
                    raise RuntimeError("this distro is unsupported: /etc/os-release names no known package manager")
                commands.append([helper or package_manager, "-Syu" if (helper or package_manager) == "pacman"
                                 else "upgrade" if package_manager == "apt" else "update"])
            elif item in TOOLCHAINS:
                # An absent toolchain is reported unavailable, not an error (the spec's rule).
                if shutil.which(item):
                    commands.append([item, "update", *(["-g"] if item == "npm" else [])])
                else:
                    unavailable.append(item)
            elif item == "local":
                found = [script for script in ("~/.local/bin/update", "~/.local/bin/upgrade")
                         if os.path.isfile(os.path.expanduser(script))]
                commands += [[os.path.expanduser(script)] for script in found]
                if not found:
                    unavailable.append(item)
            else:
                raise RuntimeError(f"unknown target {item}: system, flatpak, uv, npm, bun or local")
        commands = [[part for part in command if part] for command in commands]
        if not commands and unavailable:
            return {"plan": [], "unavailable": unavailable,
                    "confirm": "nothing to run: every named toolchain is unavailable on this machine"}
        if not commands:
            raise RuntimeError("nothing to update: name at least one target")
        if not confirm:
            return {"plan": [" ".join(command) for command in commands],
                    **({"unavailable": unavailable} if unavailable else {}),
                    "confirm": "call again with confirm=true to run this plan"}
        results = []
        for command in commands:
            result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
            results.append({"command": " ".join(command), "returncode": result.returncode,
                            "stdout": result.stdout[-8192:], "stderr": result.stderr[-8192:]})
        return {"results": results, **({"unavailable": unavailable} if unavailable else {})}
