#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Copyright (C) 2026 Galyarder Labs
# Removes everything install.sh and notchfolk-setup-voice put in place. Your shelf, clipboard history,
# tasks, timer settings and app usage in ~/.local/share/notchfolk are kept; delete that folder to remove them.
set -uo pipefail

UUID="io.galyarderlabs.notchfolk"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
# A system-wide package (.deb, .rpm, AUR) stays in use: it keeps the extension on and the voice set-up.
SYSTEM=0
[ -d "/usr/share/gnome-shell/extensions/$UUID" ] && SYSTEM=1

if [ "$SYSTEM" = 0 ]; then
    gnome-extensions disable "$UUID" 2>/dev/null
    # Drop it from the enabled list, in case GNOME Shell never loaded it, and from the disabled
    # one, where disabling put it: left there, it would keep a later install off.
    for key in enabled-extensions disabled-extensions; do
        current=$(gsettings get org.gnome.shell "$key")
        updated=$(printf '%s' "$current" | sed -e "s/, '$UUID'//" -e "s/'$UUID', //" -e "s/\['$UUID'\]/@as []/")
        [ "$updated" != "$current" ] && gsettings set org.gnome.shell "$key" "$updated"
    done
fi
systemctl --user disable --now notchfolkd.service 2>/dev/null
# Without a user service manager (install.sh allows that) the disable still succeeds, but D-Bus started
# notchfolkd, which would run on from its deleted file.
pkill -u "$(id -u)" -x notchfolkd 2>/dev/null
pkill -x notchfolk-shelf 2>/dev/null

rm -rf "$DATA/gnome-shell/extensions/$UUID" "$DATA/doc/notchfolk" "$DATA/fonts/notchfolk"
fc-cache "$DATA/fonts" >/dev/null 2>&1
if [ "$SYSTEM" = 0 ]; then
    # The voice assistant's speech models (and an older setup's Python venv, up to 3 GB with CUDA), Notchfolk's
    # caches and its AIs' own homes.
    rm -rf "$DATA/notchfolk/models" "$DATA/notchfolk/voice-venv" "$DATA/notchfolk/notchfolk-whisper.py" "$DATA/notchfolk/assistant" "$DATA/notchfolk/codex" \
           "$DATA/notchfolk/agy" "$DATA/notchfolk/grok" "$DATA/notchfolk/opencode" "$DATA/notchfolk/claude-sign-in.json" \
           "$DATA/notchfolk/updates.json" "$DATA/notchfolk/install.lock" \
           "${XDG_CACHE_HOME:-$HOME/.cache}/notchfolk" "${XDG_RUNTIME_DIR:-/nonexistent}/notchfolk-covers"
    # The battery charge limit, set with notchfolk-charge-limit, would outlive Notchfolk: lifted (asks for the password).
    if [ -e /etc/systemd/system/notchfolk-charge-limit.service ]; then
        echo "Lifting the battery charge limit Notchfolk set (sudo asks for your password)."
        sudo systemctl disable --now notchfolk-charge-limit.service 2>/dev/null
        sudo rm -f /etc/systemd/system/notchfolk-charge-limit.service
        sudo systemctl daemon-reload 2>/dev/null
        for file in /sys/class/power_supply/BAT*/charge_control_end_threshold; do
            [ -e "$file" ] && echo 100 | sudo tee "$file" >/dev/null
        done
    fi
fi
# The AI alerts' hooks in Claude Code's and Codex's own settings would run an notchfolkd that is gone.
[ -x "$HOME/.local/bin/notchfolkd" ] && "$HOME/.local/bin/notchfolkd" --unhook-all 2>/dev/null
# Removing the terminal executable does not terminate open shells or handed-off jobs.
# Extension disable preserves the helper and reveals it if hidden.
rm -f "$HOME/.local/bin/notchfolkd" "$HOME/.local/bin/notchfolk-shelf" "$HOME/.local/bin/notchfolk-terminal" \
      "$HOME/.local/bin/notchfolk-whisper" "$HOME/.local/bin/notchfolk-charge-limit" \
      "$HOME/.local/bin/notchfolk-setup-voice" "$HOME/.local/bin/notchfolk-uninstall" \
      "$DATA/dbus-1/services/io.galyarderlabs.notchfolk.Daemon.service" \
      "$DATA/dbus-1/services/io.galyarderlabs.notchfolk.ShelfWindow.service" \
      "$DATA/dbus-1/services/io.github.notchfolk.Daemon.service" \
      "$DATA/dbus-1/services/io.github.notchfolk.ShelfWindow.service" \
      "$CONFIG/systemd/user/notchfolkd.service"
systemctl --user daemon-reload 2>/dev/null
if [ "$SYSTEM" = 1 ]; then
    echo "Notchfolk in your home folder has been removed; the system-wide package now runs instead (remove it with apt, dnf or pacman)."
    exit 0
fi
echo "Notchfolk has been removed."
HUB="${HF_HUB_CACHE:-${HF_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/huggingface}/hub}"
if ls -d "$HUB"/models--Systran--faster-whisper-* >/dev/null 2>&1; then
    echo "An older speech model stays in $HUB (models--Systran--faster-whisper-*); delete it to free its space."
fi
