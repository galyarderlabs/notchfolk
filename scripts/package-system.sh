#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Copyright (C) 2026 Galyarder Labs
# Makes system-wide .deb and .rpm packages in dist/ from a release tarball (scripts/package.sh's output).
# Usage: scripts/package-system.sh <tarball> [deb] [rpm]; the .deb needs dpkg-dev, the .rpm rpmbuild and file.
set -euo pipefail

[ -f "${1:-}" ] || { echo "Usage: $0 <notchfolk-…-linux.tar.gz> [deb] [rpm]" >&2; exit 2; }
TARBALL="$(readlink -f "$1")"
shift
FORMATS=("$@")
[ "${#FORMATS[@]}" -gt 0 ] || FORMATS=(deb rpm)

cd "$(dirname "$0")/.."
umask 022
UUID="io.galyarderlabs.notchfolk"
MAINTAINER="Galyarder Labs <contact@galyarderlabs.com>"
SUMMARY="Notchfolk: Living desktop notch and AI companion for GNOME Shell with MCP"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

tar -C "$WORK" -xzf "$TARBALL"
SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'notchfolk-*' | head -n1)"
[ -x "$SRC/bin/notchfolkd" ] || { echo "$TARBALL is not a release package." >&2; exit 1; }
VERSION="$(grep -oE '"version-name": *"[^"]*"' "$SRC/gnome-extension/metadata.json" | cut -d'"' -f4)"
mkdir -p dist

# A service file from data/, pointing at /usr/bin and the system's copy of the README.
service() {
    sed -e 's|@BINDIR@|/usr/bin|' -e 's|file://%h/.local/share/doc/notchfolk|file:///usr/share/doc/notchfolk|' \
        "$SRC/data/$1" > "$WORK/$1"
    install -Dm644 "$WORK/$1" "$2/$1"
}

# Everything but the license, under $1, with Inter in $2 (each system has its own fonts folder).
stage() {
    local root="$1" fonts="$1$2"
    install -Dm755 -t "$root/usr/bin" "$SRC/bin/notchfolkd" "$SRC/bin/notchfolk-shelf" \
        "$SRC/bin/notchfolk-terminal" "$SRC/bin/notchfolk-whisper" "$SRC/scripts/notchfolk-charge-limit"
    install -Dm644 "$SRC/data/io.galyarderlabs.notchfolk.Terminal.desktop" \
        "$root/usr/share/applications/io.galyarderlabs.notchfolk.Terminal.desktop"
    install -Dm644 "$SRC/gnome-extension/icons/notchfolk-terminal-symbolic.svg" \
        "$root/usr/share/icons/hicolor/scalable/apps/io.galyarderlabs.notchfolk.Terminal.svg"
    install -Dm755 "$SRC/scripts/setup-voice.sh" "$root/usr/bin/notchfolk-setup-voice"
    install -Dm755 "$SRC/scripts/setup-mcp.sh" "$root/usr/bin/notchfolk-setup-mcp"
    install -Dm755 "$SRC/scripts/notchfolk-mcp" "$root/usr/bin/notchfolk-mcp"
    service notchfolk-mcp.service "$root/usr/lib/systemd/user"
    install -Dm644 "$SRC/mcp/server.py" "$root/usr/lib/notchfolk/mcp/server.py"
    install -Dm644 "$SRC/mcp/notchfolk_oauth.py" "$root/usr/lib/notchfolk/mcp/notchfolk_oauth.py"
    install -Dm644 "$SRC/mcp/requirements.txt" "$root/usr/share/notchfolk/mcp/requirements.txt"

    local ext="$root/usr/share/gnome-shell/extensions/$UUID"
    mkdir -p "$ext"
    cp -r "$SRC/gnome-extension/." "$ext/"
    # The settings schema goes where the system compiles it; the extension then finds it there.
    install -Dm644 -t "$root/usr/share/glib-2.0/schemas" "$ext"/schemas/*.gschema.xml
    rm -rf "$ext/schemas"
    chmod -R u=rwX,go=rX "$ext"

    service io.galyarderlabs.notchfolk.Daemon.service "$root/usr/share/dbus-1/services"
    service io.galyarderlabs.notchfolk.ShelfWindow.service "$root/usr/share/dbus-1/services"
    service notchfolkd.service "$root/usr/lib/systemd/user"
    install -Dm644 -t "$fonts" "$SRC/data/fonts/InterVariable.ttf" "$SRC/data/fonts/Inter-LICENSE.txt"
    install -Dm644 -t "$root/usr/share/doc/notchfolk" "$SRC/README.md" "$SRC/CHANGELOG.md"
    install -Dm644 "$SRC/docs/mcp.md" "$root/usr/share/doc/notchfolk/mcp.md"
}

# The .deb, its dependencies read from the libraries the programs link.
build_deb() {
    local root="$WORK/deb" depends
    stage "$root" /usr/share/fonts/truetype/notchfolk
    install -Dm644 "$SRC/LICENSE" "$root/usr/share/doc/notchfolk/LICENSE"
    cat > "$root/usr/share/doc/notchfolk/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Notchfolk
Source: https://github.com/galyarderlabs/notchfolk

Files: *
Copyright: Notchfolk contributors
License: GPL-3.0-or-later
 On Debian systems, the full text is in /usr/share/common-licenses/GPL-3.

Files: usr/share/fonts/truetype/notchfolk/*
Copyright: The Inter Project Authors
License: OFL-1.1
 The full text is in /usr/share/fonts/truetype/notchfolk/Inter-LICENSE.txt.
EOF
    # The libraries the programs link, as package names and versions (libc6, libgtk-4-1, …).
    mkdir -p "$WORK/shlibs/debian"
    printf 'Source: notchfolk\n\nPackage: notchfolk\nArchitecture: amd64\n' > "$WORK/shlibs/debian/control"
    depends="$(cd "$WORK/shlibs" && dpkg-shlibdeps -O --warnings=0 "$root/usr/bin/notchfolkd" \
        "$root/usr/bin/notchfolk-shelf" "$root/usr/bin/notchfolk-terminal" "$root/usr/bin/notchfolk-whisper" |
        sed -n 's/^shlibs:Depends=//p')"

    mkdir -p "$root/DEBIAN"
    cat > "$root/DEBIAN/control" <<EOF
Package: notchfolk
Version: $VERSION
Architecture: amd64
Maintainer: $MAINTAINER
Installed-Size: $(du -sk --exclude=DEBIAN "$root" | cut -f1)
Depends: $depends, gnome-shell (>= 46), dbus-user-session | default-dbus-session-bus, tmux
Recommends: libvulkan1
Section: gnome
Priority: optional
Homepage: https://github.com/galyarderlabs/notchfolk
Description: $SUMMARY
 Notchfolk turns the middle of the GNOME Shell top bar into a notch-style island: music
 with synced lyrics, calls, a focus timer, reminders, a calendar, a file shelf,
 app usage, charging and system alerts, and an optional voice assistant.
 .
 Each user logs out and back in, then turns the extension on once: gnome-extensions enable $UUID
EOF
    dpkg-deb --root-owner-group -Zxz --build "$root" "dist/notchfolk_${VERSION}_amd64.deb" >/dev/null
    echo "dist/notchfolk_${VERSION}_amd64.deb"
}

# The .rpm, from a spec wrapped around the staged files.
build_rpm() {
    local stage="$WORK/rpm-root" top="$WORK/rpmbuild"
    stage "$stage" /usr/share/fonts/notchfolk
    install -Dm644 "$SRC/LICENSE" "$stage/usr/share/licenses/notchfolk/LICENSE"
    mkdir -p "$top/SPECS"
    cat > "$top/SPECS/notchfolk.spec" <<EOF
Name: notchfolk
Version: ${VERSION//-/\~}
Release: 1
Summary: $SUMMARY
License: GPL-3.0-or-later AND OFL-1.1
URL: https://github.com/galyarderlabs/notchfolk
Packager: $MAINTAINER
Requires: gnome-shell >= 46
Requires: tmux
# Speech recognition on the graphics card; without it, on the processor.
Recommends: vulkan-loader
# Built by package.sh already, and stripped there.
%global debug_package %{nil}
%global __strip /bin/true

%description
Notchfolk turns the middle of the GNOME Shell top bar into a notch-style island: music
with synced lyrics, calls, a focus timer, reminders, a calendar, a file shelf,
app usage, charging and system alerts, and an optional voice assistant.

Each user logs out and back in, then turns the extension on once: gnome-extensions enable $UUID

%install
cp -a "$stage/." "%{buildroot}/"

%files
%license /usr/share/licenses/notchfolk/LICENSE
%doc /usr/share/doc/notchfolk
/usr/bin/notchfolkd
/usr/bin/notchfolk-shelf
/usr/bin/notchfolk-terminal
/usr/share/applications/io.galyarderlabs.notchfolk.Terminal.desktop
/usr/share/icons/hicolor/scalable/apps/io.galyarderlabs.notchfolk.Terminal.svg
/usr/bin/notchfolk-whisper
/usr/bin/notchfolk-setup-voice
/usr/bin/notchfolk-setup-mcp
/usr/bin/notchfolk-mcp
/usr/lib/notchfolk/mcp/server.py
/usr/lib/notchfolk/mcp/notchfolk_oauth.py
/usr/share/notchfolk/mcp/requirements.txt
/usr/lib/systemd/user/notchfolk-mcp.service
/usr/bin/notchfolk-charge-limit
/usr/share/gnome-shell/extensions/$UUID
/usr/share/glib-2.0/schemas/org.gnome.shell.extensions.notchfolk.gschema.xml
/usr/share/dbus-1/services/io.galyarderlabs.notchfolk.Daemon.service
/usr/share/dbus-1/services/io.galyarderlabs.notchfolk.ShelfWindow.service
/usr/lib/systemd/user/notchfolkd.service
/usr/share/fonts/notchfolk
EOF
    rpmbuild --quiet -bb --target x86_64 --define "_topdir $top" --define '_build_id_links none' \
        "$top/SPECS/notchfolk.spec"
    local built
    built="$(find "$top/RPMS" -name '*.rpm' | head -n1)"
    cp "$built" dist/
    echo "dist/$(basename "$built")"
}

for format in "${FORMATS[@]}"; do
    case "$format" in
        deb) build_deb ;;
        rpm) build_rpm ;;
        *) echo "Unknown format: $format (deb or rpm)" >&2; exit 2 ;;
    esac
done
