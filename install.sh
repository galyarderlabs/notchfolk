#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Copyright (C) 2026 Galyarder Labs
# Builds Notchfolk (or takes a release package's ready-built programs from bin/) and installs it for the user,
# no root: programs in ~/.local/bin, the extension, D-Bus and systemd user files, and the Inter font.
set -euo pipefail

cd "$(dirname "$0")"
UUID="io.galyarderlabs.notchfolk"
# The extension's id before 0.1.0; an install under it is replaced.
OLD_UUID="isle@isle.github.io"
ISLE_UUID="isle@zickrian.github.io"
BINDIR="$HOME/.local/bin"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A bold heading for each stage.
step() { printf '\033[1m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -ne 0 ] || { echo "Run this as yourself, without sudo: Notchfolk installs to your own home folder." >&2; exit 1; }
# One install at a time (an update clicked in Settings and one run in a terminal): the second stops.
mkdir -p "$DATA/notchfolk"
if command -v flock >/dev/null; then
    exec 9>"$DATA/notchfolk/install.lock"
    flock -n 9 || { echo "Notchfolk: another install of Notchfolk is running; try again once it is done." >&2; exit 1; }
fi
# Put in place whole or not at all: copied beside it, then renamed over it (a full disk leaves the old one).
put() {
    install -Dm755 "$1" "$2.new"
    mv -f "$2.new" "$2"
}
VERSION="$(grep -oE '"version-name": *"[^"]*"' gnome-extension/metadata.json | cut -d'"' -f4)"
# An update keeps the user's choices; only a first install sets Notchfolk's look.
# Settings still saved (Notchfolk uninstalled, now back) count as an update too.
if [ -d "$DATA/gnome-shell/extensions/$UUID" ] || [ -x "$BINDIR/notchfolkd" ] ||
    [ -n "$(dconf list /org/gnome/shell/extensions/notchfolk/ 2>/dev/null)" ]; then
    FIRST=0
else
    FIRST=1
fi

# Installs a service file from data/, pointing it at the installed binaries.
install_service() {
    sed "s|@BINDIR@|$BINDIR|" "data/$1" > "$WORK/$1"
    install -Dm644 "$WORK/$1" "$2/$1"
}

SHELF=0
TERMINAL=0
WHISPER=0
# -f, not -x: unpacked where files cannot run (a /tmp mounted noexec), they still install.
if [ -f bin/notchfolkd ]; then
    # A release package: the programs come built.
    BUILT=bin
    [ -f bin/notchfolk-shelf ] && SHELF=1
    [ -f bin/notchfolk-terminal ] && TERMINAL=1
    [ -f bin/notchfolk-whisper ] && WHISPER=1
else
    BUILT=target/release
    step "Building notchfolkd"
    cargo build --release -p notchfolk-daemon
    if pkg-config --exists gtk4; then
        step "Building notchfolk-shelf"
        # It needs a newer Rust than notchfolkd (1.92); without it the rest still installs.
        if cargo build --release -p notchfolk-shelf; then
            SHELF=1
        else
            echo "notchfolk-shelf did not build (it needs Rust 1.92 or newer: 'rustup update'); skipping drag and drop on the shelf."
        fi
    else
        echo "GTK 4 development files not found: skipping notchfolk-shelf (drag and drop on the shelf)."
        echo "Install them with 'sudo apt install libgtk-4-dev' and run this script again."
    fi
    if pkg-config --exists 'gtk4 >= 4.12' 'vte-2.91-gtk4 >= 0.65'; then
        step "Building notchfolk-terminal"
        if cargo build --release -p notchfolk-terminal; then
            TERMINAL=1
        else
            echo "notchfolk-terminal did not build (it needs Rust 1.92 or newer: 'rustup update'); skipping the notch terminal."
        fi
    else
        echo "GTK 4 or VTE 4 development files not found or too old: skipping notchfolk-terminal."
        echo "Install them with 'sudo apt install libgtk-4-dev libvte-2.91-gtk4-dev' and run this script again."
        echo "On Fedora: 'sudo dnf install gtk4-devel vte291-gtk4-devel'; on Arch: 'sudo pacman -S gtk4 vte4'."
    fi
    # The voice assistant's speech recognition: whisper.cpp, built with cmake; Vulkan for the GPU.
    if command -v cmake >/dev/null && command -v c++ >/dev/null; then
        step "Building notchfolk-whisper"
        if command -v glslc >/dev/null && pkg-config --exists vulkan; then
            FEATURES=()
        else
            echo "Vulkan headers or glslc not found: speech recognition will use the processor only."
            echo "For the GPU: 'sudo apt install libvulkan-dev glslc', then run this script again."
            FEATURES=(--no-default-features)
        fi
        if cargo build --release -p notchfolk-whisper "${FEATURES[@]}"; then
            WHISPER=1
        else
            echo "notchfolk-whisper did not build (it needs libclang too: 'sudo apt install libclang-dev'); the voice assistant needs it."
        fi
    else
        echo "cmake or a C++ compiler not found: skipping notchfolk-whisper (the voice assistant's speech recognition)."
        echo "Install them with 'sudo apt install cmake g++ libclang-dev' and run this script again."
    fi
fi

step "Installing binaries to $BINDIR"
put "$BUILT/notchfolkd" "$BINDIR/notchfolkd"
if [ "$SHELF" = 1 ]; then
    put "$BUILT/notchfolk-shelf" "$BINDIR/notchfolk-shelf"
    # A running helper is the old version; it starts again, updated, when needed.
    pkill -x notchfolk-shelf 2>/dev/null || true
fi
if [ "$TERMINAL" = 1 ]; then
    put "$BUILT/notchfolk-terminal" "$BINDIR/notchfolk-terminal"
    # Do not stop an open terminal: its private tmux server may still have live jobs.
    # --version needs no display or shell and detects missing runtime libraries.
    if ! "$BINDIR/notchfolk-terminal" --version >/dev/null || ! command -v tmux >/dev/null; then
        echo "The notch terminal needs GTK 4, VTE 4 and tmux; the rest of Notchfolk is still installed."
        echo "Ubuntu/Debian: 'sudo apt install libgtk-4-1 libvte-2.91-gtk4-0 tmux'."
        echo "Fedora: 'sudo dnf install gtk4 vte291-gtk4 tmux'; Arch: 'sudo pacman -S gtk4 vte4 tmux'."
    fi
fi

# Match the GTK application ID so GNOME can name and identify its windows.
# Keep an earlier helper when this build skipped it, just like the shelf helper.
TERMINAL_ID="io.galyarderlabs.notchfolk.Terminal"
TERMINAL_DESKTOP="$DATA/applications/$TERMINAL_ID.desktop"
TERMINAL_ICON="$DATA/icons/hicolor/scalable/apps/$TERMINAL_ID.svg"
if [ -x "$BINDIR/notchfolk-terminal" ]; then
    # Resolve HOME at launch. A fixed command needs no installer-time escaping
    # and works even if the path contains spaces or desktop-entry field codes.
    sed 's|^Exec=.*|Exec=/bin/sh -c "exec ~/.local/bin/notchfolk-terminal"|' \
        "data/$TERMINAL_ID.desktop" > "$WORK/$TERMINAL_ID.desktop"
    install -Dm644 "$WORK/$TERMINAL_ID.desktop" "$TERMINAL_DESKTOP"
    install -Dm644 gnome-extension/icons/notchfolk-terminal-symbolic.svg "$TERMINAL_ICON"
else
    # A partial install must not leave a launcher for a helper that is absent.
    rm -f "$TERMINAL_DESKTOP" "$TERMINAL_ICON"
fi
gtk-update-icon-cache -q -t -f "$DATA/icons/hicolor" >/dev/null 2>&1 || true
if [ "$WHISPER" = 1 ]; then
    put "$BUILT/notchfolk-whisper" "$BINDIR/notchfolk-whisper"
fi

step "Installing services"
# The D-Bus names before 0.1.0.
rm -f "$DATA/dbus-1/services/io.github.notchfolk.Daemon.service" \
      "$DATA/dbus-1/services/io.github.notchfolk.ShelfWindow.service"
install_service io.galyarderlabs.notchfolk.Daemon.service "$DATA/dbus-1/services"
# Also for a helper from an earlier install, when it was not rebuilt now.
if [ "$SHELF" = 1 ] || [ -x "$BINDIR/notchfolk-shelf" ]; then
    install_service io.galyarderlabs.notchfolk.ShelfWindow.service "$DATA/dbus-1/services"
fi
install_service notchfolkd.service "$CONFIG/systemd/user"
install -Dm644 README.md "$DATA/doc/notchfolk/README.md"
install -Dm644 docs/mcp.md "$DATA/doc/notchfolk/mcp.md"
# The voice assistant: `notchfolk-setup-voice` downloads the speech model once.
install -Dm755 scripts/setup-voice.sh "$BINDIR/notchfolk-setup-voice"
install -Dm755 scripts/setup-mcp.sh "$BINDIR/notchfolk-setup-mcp"
install -Dm755 scripts/notchfolk-mcp "$BINDIR/notchfolk-mcp"
install -Dm755 scripts/notchfolk-mcp-keygen "$BINDIR/notchfolk-mcp-keygen"
install -Dm755 scripts/notchfolk-mcp-tunnel "$BINDIR/notchfolk-mcp-tunnel"
install_service notchfolk-mcp.service "$CONFIG/systemd/user"
# Replaced, not merged into: an Isle-era copy left here (a hand move can put one back)
# would keep running as the MCP server under the old bus name.
rm -rf "$DATA/notchfolk/mcp"
mkdir -p "$DATA/notchfolk/mcp"
cp -r mcp/. "$DATA/notchfolk/mcp/"
# Sets a lasting battery charge limit; the assistant types it into a terminal when asked.
install -Dm755 scripts/notchfolk-charge-limit "$BINDIR/notchfolk-charge-limit"
# One-time migration from Isle; the migration doc tells the user to run it by name.
install -Dm755 scripts/notchfolk-migrate-from-isle.sh "$BINDIR/notchfolk-migrate-from-isle"

step "Installing the Inter font"
# The island is set in Inter.
install -Dm644 data/fonts/InterVariable.ttf "$DATA/fonts/notchfolk/InterVariable.ttf"
install -Dm644 data/fonts/Inter-LICENSE.txt "$DATA/fonts/notchfolk/Inter-LICENSE.txt"
fc-cache "$DATA/fonts/notchfolk" >/dev/null 2>&1 || true

step "Installing the GNOME Shell extension"
# Replace an install under an old id, so two islands never run at once.
# Settings carry over from Isle: the one-time migration script copies them across schemas.
for gone in "$OLD_UUID" "$ISLE_UUID"; do
    if [ -d "$DATA/gnome-shell/extensions/$gone" ]; then
        gnome-extensions disable "$gone" 2>/dev/null || true
        rm -rf "$DATA/gnome-shell/extensions/$gone"
        current=$(gsettings get org.gnome.shell enabled-extensions)
        updated=$(printf '%s' "$current" | sed -e "s/, '$gone'//" -e "s/'$gone', //" -e "s/\['$gone'\]/@as []/")
        [ "$updated" != "$current" ] && gsettings set org.gnome.shell enabled-extensions "$updated"
        echo "Replaced the install under the old id $gone."
    fi
done
DEST="$DATA/gnome-shell/extensions/$UUID"
# Made aside (not among the extensions, where GNOME would read it), then swapped in: a copy that fails
# (a full disk) leaves the old one whole.
rm -rf "$DATA/notchfolk"/extension-new*
STAGE="$(mktemp -d "$DATA/notchfolk/extension-new.XXXXXX")"
chmod 755 "$STAGE"
mkdir -p "$(dirname "$DEST")"
cp -r gnome-extension/. "$STAGE/"
glib-compile-schemas "$STAGE/schemas"
rm -rf "$DEST"
mv "$STAGE" "$DEST"

step "Starting notchfolkd"
# Let the session bus see the new activation files.
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 || true
# Without a user service manager (over SSH, say) notchfolkd still starts on its
# own when the extension first calls it.
if systemctl --user daemon-reload 2>/dev/null; then
    systemctl --user enable notchfolkd.service >/dev/null 2>&1 ||
        echo "notchfolkd could not be set to start with your session ('systemctl --user enable notchfolkd' says why); it still starts once the island calls it."
    # A failure here is reported, not fatal: the extension still goes in, and notchfolkd starts once called.
    systemctl --user restart notchfolkd.service ||
        echo "notchfolkd did not start; see 'journalctl --user -u notchfolkd' (the island still works without it, minus its services)."
else
    # An notchfolkd started by D-Bus would go on running the old version from its replaced file: stopped, it
    # starts anew as the island calls it again (within seconds; see the extension's service check).
    pkill -u "$(id -u)" -x notchfolkd 2>/dev/null || true
fi

# The voice assistant set up with an older Notchfolk used Python (up to 3 GB): moved to notchfolk-whisper,
# with the model chosen then, and the old setup deleted. Offline, it stays for notchfolk-setup-voice.
if [ "$WHISPER" = 1 ] && { [ -d "$DATA/notchfolk/voice-venv" ] || [ -f "$DATA/notchfolk/notchfolk-whisper.py" ]; }; then
    step "Moving the voice assistant to the new speech recognition"
    "$BINDIR/notchfolk-setup-voice" --remove-old </dev/null ||
        echo "That did not finish; run notchfolk-setup-voice later (the voice assistant needs it)."
fi

# A running GNOME Shell on Wayland does not know a new extension until the
# next login, so add it to the enabled list directly when enabling fails.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    # On the disabled list (turned off before an uninstall), it would stay off whatever the enabled one says.
    current=$(gsettings get org.gnome.shell disabled-extensions)
    updated=$(printf '%s' "$current" | sed -e "s/, '$UUID'//" -e "s/'$UUID', //" -e "s/\['$UUID'\]/@as []/")
    [ "$updated" = "$current" ] || gsettings set org.gnome.shell disabled-extensions "$updated"
    current=$(gsettings get org.gnome.shell enabled-extensions)
    case "$current" in
        *"'$UUID'"*) ;;
        "@as []") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
        *) gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']" ;;
    esac
fi

# GNOME runs no user extensions at all while this is on (Extensions → "Use Extensions" off).
if [ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" = "true" ]; then
    gsettings set org.gnome.shell disable-user-extensions false
    echo "Turned extensions on (they were all switched off in the Extensions app)."
fi

if [ "$FIRST" = 1 ]; then
step "Setting up the top bar"
# Notchfolk's look: a slim glass top bar with the island hanging from it like a notch.
# Only on a first install; an update keeps what the user chose since.
gsettings --schemadir "$DEST/schemas" set org.gnome.shell.extensions.notchfolk top-bar-style glass
gsettings --schemadir "$DEST/schemas" set org.gnome.shell.extensions.notchfolk compact-top-bar true
gsettings --schemadir "$DEST/schemas" set org.gnome.shell.extensions.notchfolk island-in-top-bar true
fi

# Other extensions are never changed; ones that fight with the island get a recommendation.
ENABLED="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || true)"
# Whether another extension is installed (for the user or system-wide) and turned on.
extension_on() {
    case "$ENABLED" in *"'$1'"*) ;; *) return 1 ;; esac
    [ -d "$DATA/gnome-shell/extensions/$1" ] || [ -d "/usr/share/gnome-shell/extensions/$1" ]
}
RECOMMEND=()
BLUR="blur-my-shell@aunetx"
if extension_on "$BLUR"; then
    # Its settings schema: in its own folder, else among the system's.
    schema=()
    blur_command="gsettings"
    for dir in "$DATA/gnome-shell/extensions/$BLUR/schemas" "/usr/share/gnome-shell/extensions/$BLUR/schemas"; do
        if [ -f "$dir/gschemas.compiled" ]; then
            schema=(--schemadir "$dir")
            blur_command="gsettings --schemadir $(printf '%q' "$dir")"
            break
        fi
    done
    # Blur my Shell's top bar blur also darkens it, and the glass bar has no colour of its own.
    if [ "$(gsettings "${schema[@]}" get org.gnome.shell.extensions.blur-my-shell.panel blur 2>/dev/null)" = true ]; then
        RECOMMEND+=("Blur my Shell darkens the top bar behind the island. To blur only the rest, turn off
    Blur my Shell → Panel → Blur, or run: $blur_command set org.gnome.shell.extensions.blur-my-shell.panel blur false")
    fi
fi
for uuid in dynamic-island@bjagetic hidetopbar@mathieu.bidon.ca; do
    if extension_on "$uuid"; then
        RECOMMEND+=("$uuid takes the same place in the top bar and covers the island. Turn it off in
    the Extensions app, or run: gnome-extensions disable $uuid")
    fi
done
if [ "${#RECOMMEND[@]}" -gt 0 ]; then
    step "Recommended (Notchfolk changed nothing here)"
    printf -- '- %s\n' "${RECOMMEND[@]}"
fi
if [ -d "/usr/share/gnome-shell/extensions/$UUID" ]; then
    echo "Notchfolk is also installed system-wide (a .deb, .rpm or AUR package): this install in your home folder takes precedence for you."
fi

if [ "$FIRST" = 1 ]; then
    step "Notchfolk $VERSION is installed"
else
    step "Notchfolk is updated to $VERSION"
fi
SHELL_VERSION="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
# Only an X11 session of GNOME 48 or older restarts the shell in place; Wayland needs a new login.
if [ "${XDG_SESSION_TYPE:-}" = "x11" ] && [ -n "$SHELL_VERSION" ] && [ "$SHELL_VERSION" -le 48 ]; then
    echo "Press Alt+F2, type 'r' and Enter to restart GNOME Shell."
else
    echo "Log out and back in once so GNOME Shell loads the new extension."
fi
# Some systems put ~/.local/bin on the PATH only once it exists, at the next login; others never.
case ":$PATH:" in
    *":$BINDIR:"*) ;;
    *) echo "Note: $BINDIR is not on your PATH, so run Notchfolk's commands with it: $BINDIR/notchfolkd --doctor, $BINDIR/notchfolk-setup-voice." ;;
esac
