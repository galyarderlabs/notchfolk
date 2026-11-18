#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Copyright (C) 2026 Galyarder Labs
# Run as root in a throwaway container: installs an Notchfolk package (tarball, .deb, .rpm or Arch) and a headless
# GNOME Shell as "tester", failing on JS errors, extension/daemon startup, or the packaged terminal lifecycle.
set -euo pipefail

UUID="io.galyarderlabs.notchfolk"
DAEMON="io.galyarderlabs.notchfolk.Daemon"
# Seconds to wait for notchfolkd, then to keep the shell running and watch its log.
WAIT=60
SETTLE=10

# A step heading, in bold.
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
# Stops the test with a reason.
fail() { printf 'Smoke test failed: %s\n' "$*" >&2; exit 1; }

# GNOME Shell and what get.sh needs, on Ubuntu/Debian, Fedora or Arch.
install_shell() {
    if command -v apt-get >/dev/null; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq --no-install-recommends gnome-shell mutter xwayland dbus dbus-user-session \
            libglib2.0-bin gnome-shell-common gir1.2-gtk-4.0 libgtk-4-1 libvte-2.91-gtk4-0 tmux \
            adwaita-icon-theme fonts-cantarell librsvg2-common fontconfig curl ca-certificates procps util-linux >/dev/null
    elif command -v dnf >/dev/null; then
        dnf -y -q install --setopt=install_weak_deps=False gnome-shell xorg-x11-server-Xwayland dbus-daemon \
            dbus-tools glib2 librsvg2 adwaita-icon-theme mesa-dri-drivers fontconfig curl tar findutils \
            gtk4 vte291-gtk4 tmux procps-ng util-linux shadow-utils
    elif command -v pacman >/dev/null; then
        pacman -Syu --noconfirm --needed gnome-shell xorg-xwayland dbus glib2 librsvg adwaita-icon-theme \
            vte4 tmux fontconfig curl procps-ng util-linux >/dev/null
    else
        fail "no apt-get, dnf or pacman to install GNOME Shell with."
    fi
}

# As root: the system around the shell, then the session as "tester".
main() {
    local package="${1:-}"
    [ -f "$package" ] || fail "usage: $0 <notchfolk-….tar.gz | notchfolk_….deb | notchfolk-….rpm | notchfolk-bin-….pkg.tar.zst>"
    [ "$(id -u)" -eq 0 ] || fail "run this as root, in a throwaway container."
    package="$(readlink -f "$package")"

    if ! command -v gnome-shell >/dev/null || ! command -v dbus-run-session >/dev/null; then
        say "Installing GNOME Shell"
        install_shell
    fi
    gnome-shell --version

    case "$package" in
        *.deb)
            say "Installing $(basename "$package")"
            apt-get install -y -qq "$package" >/dev/null ;;
        *.rpm)
            say "Installing $(basename "$package")"
            dnf -y -q install "$package" ;;
        *.pkg.tar.zst)
            say "Installing $(basename "$package")"
            pacman -U --noconfirm "$package" >/dev/null ;;
        *.tar.gz) ;;
        *) fail "unknown package type: $package" ;;
    esac

    id tester >/dev/null 2>&1 || useradd -m tester
    local uid
    uid="$(id -u tester)"
    # Xwayland's socket folder must belong to root; the user's runtime folder to the user.
    install -d -m 1777 /tmp/.X11-unix
    install -d -m 700 -o tester -g tester "/run/user/$uid"
    # No systemd or logind here: GNOME Shell would look for them if /run/systemd were there.
    rm -rf /run/systemd
    mkdir -p /run/dbus
    [ -S /run/dbus/system_bus_socket ] || dbus-daemon --system --fork

    local script
    script="$(readlink -f "$0")"
    # A copy the user can read, wherever the package is.
    install -D -m 644 "$package" "/tmp/notchfolk-smoke/$(basename "$package")"
    runuser -u tester -- env -i HOME="/home/tester" USER=tester PATH="/home/tester/.local/bin:$PATH" \
        XDG_RUNTIME_DIR="/run/user/$uid" GSETTINGS_BACKEND=keyfile LANG=C.UTF-8 \
        dbus-run-session -- bash "$script" --session "/tmp/notchfolk-smoke/$(basename "$package")" "$(dirname "$script")/../.."
}

# As "tester", on a fresh session bus: install for the user if a tarball, then run the shell.
session() {
    local package="$1" repo="$2"
    cd "$HOME"
    if [[ "$package" == *.tar.gz ]]; then
        say "Installing $(basename "$package") with get.sh"
        NOTCHFOLK_PACKAGE="$package" NOTCHFOLK_FORCE=1 bash "$repo/get.sh"
    else
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    fi

    # Check the packaged helper without a display; missing linked VTE libraries fail here.
    say "Checking the notch terminal runtime"
    notchfolk-terminal --version || fail "notchfolk-terminal --version failed."
    notchfolk-terminal --help >/dev/null || fail "notchfolk-terminal --help failed."
    tmux -V || fail "tmux is missing or unusable."

    say "Starting GNOME Shell"
    local log="$HOME/gnome-shell.log"
    export WAYLAND_DISPLAY=wayland-notchfolk-smoke GDK_BACKEND=wayland
    gnome-shell --headless --wayland --wayland-display "$WAYLAND_DISPLAY" \
        --virtual-monitor 1280x720 >"$log" 2>&1 &
    local shell=$! waited=0
    until bus_has "$DAEMON"; do
        kill -0 "$shell" 2>/dev/null || { cat "$log"; fail "GNOME Shell exited."; }
        if [ "$waited" -ge "$WAIT" ]; then
            cat "$log"
            fail "notchfolkd never appeared on the session bus ($DAEMON) in $WAIT s."
        fi
        sleep 1
        waited=$((waited + 1))
    done
    say "notchfolkd is on the session bus after ${waited} s"
    sleep "$SETTLE"
    smoke_terminal

    local info state
    info="$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" 2>&1 || true)"
    state="$(printf '%s' "$info" | grep -oE "'state': <[0-9.]+>" | grep -oE '[0-9]+' | head -n1 || true)"
    local notchfolkd whisper
    notchfolkd="$(command -v notchfolkd || echo "$HOME/.local/bin/notchfolkd")"
    whisper="$(command -v notchfolk-whisper || echo "$HOME/.local/bin/notchfolk-whisper")"
    "$notchfolkd" --version
    "$notchfolkd" --doctor || fail "notchfolkd --doctor failed."
    # Speech recognition starts with no GPU and no Vulkan loader, on the processor.
    say "notchfolk-whisper --probe"
    local probe
    probe="$("$whisper" --probe 2>&1 || true)"
    printf '%s\n' "$probe"
    [[ "$probe" == *'"device"'* ]] || fail "notchfolk-whisper --probe did not answer."
    kill "$shell" 2>/dev/null || true
    wait "$shell" 2>/dev/null || true

    echo "--- GNOME Shell's log about Notchfolk and errors:"
    grep -iE 'notchfolk|JS ERROR|JS WARNING' "$log" || echo "(nothing)"
    echo "---"
    if grep -q 'JS ERROR' "$log"; then
        fail "GNOME Shell logged a JS ERROR (above)."
    fi
    # ExtensionState: 1 enabled (ACTIVE), 3 error, 4 out of date, 7 activating (GNOME 49 and newer).
    case "$state" in
        1 | 7) say "The extension is loaded (state $state)" ;;
        *) printf '%s\n' "$info"; fail "the extension did not load (state ${state:-unknown})." ;;
    esac
    say "Smoke test passed"
}

# Whether a name is owned on the session bus.
bus_has() {
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner "$1" 2>/dev/null | grep -q true
}

# The disposable container's private tester must have no pre-existing terminal
# sockets. This gives the new helper's socket a known owner without inspecting argv.
smoke_terminal() (
    say "Opening and closing the packaged Termi-notch"
    # The helper must ignore the caller's tmux directory so an external terminal can attach to the same socket.
    export TMUX_TMPDIR="$XDG_RUNTIME_DIR"
    for socket in /tmp/tmux-"$UID"/notchfolk-*; do
        [ ! -S "$socket" ] || fail "tester already owns a Notchfolk tmux socket: $socket"
    done
    [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] || fail "GNOME Shell's Wayland socket is missing."
    terminal="" terminal_socket="" terminal_log="$HOME/notchfolk-terminal.log"
    trap 'if [ "$?" -ne 0 ]; then
        if [ -n "$terminal" ]; then
            timeout --kill-after=2s 10s notchfolk-terminal --quit >>"$terminal_log" 2>&1 || true
            wait "$terminal" 2>/dev/null || true
        fi
        if [ -n "$terminal_socket" ]; then
            timeout --kill-after=2s 5s tmux -N -S "$terminal_socket" kill-server >/dev/null 2>&1 || true
        fi
        cat "$terminal_log"
    fi' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    timeout --kill-after=2s "$((2 * WAIT + 15))s" notchfolk-terminal >"$terminal_log" 2>&1 &
    terminal=$!
    deadline=$((SECONDS + WAIT))
    while :; do
        kill -0 "$terminal" 2>/dev/null || fail "notchfolk-terminal exited before attaching a shell."
        for socket in /tmp/tmux-"$UID"/notchfolk-*; do
            [ ! -S "$socket" ] || { terminal_socket="$socket"; break; }
        done
        if [ -n "$terminal_socket" ] &&
            state="$(timeout --kill-after=2s 5s tmux -N -S "$terminal_socket" \
                display-message -p -t shell:0.0 '#{session_attached}:#{pane_dead}' 2>/dev/null)" &&
            [ "$state" = 1:0 ]; then
            break
        fi
        [ "$SECONDS" -lt "$deadline" ] || fail "Termi-notch did not attach a live shell in $WAIT s."
        sleep 1
    done
    timeout --kill-after=2s 10s notchfolk-terminal --quit >>"$terminal_log" 2>&1 ||
        fail "notchfolk-terminal --quit failed or timed out."
    wait "$terminal" || fail "notchfolk-terminal exited unsuccessfully or timed out."
    terminal=""
    status=0
    timeout --kill-after=2s 5s tmux -N -S "$terminal_socket" has-session -t shell >/dev/null 2>&1 || status=$?
    [ "$status" -eq 1 ] || fail "Termi-notch --quit left its shell running or unresponsive (status $status)."
    terminal_socket=""
    say "Termi-notch opened a live shell and --quit closed it"
)

if [ "${1:-}" = --session ]; then
    session "$2" "$3"
else
    main "$@"
fi
