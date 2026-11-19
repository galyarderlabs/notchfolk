#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Copyright (C) 2026 Galyarder Labs
# Packs dist/notchfolk-<version>-<arch>-linux.tar.gz (+ .sha256) with ready-built programs; arg: version (default Cargo.toml).
# Needs libgtk-4-dev and libvte-2.91-gtk4-dev for the GTK helpers,
# and cmake g++ libclang-dev libvulkan-dev glslc for notchfolk-whisper.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)}"
NAME="notchfolk-$VERSION-$(uname -m)-linux"
OUT="dist/$NAME"

cargo build --release --locked -p notchfolk-daemon -p notchfolk-shelf -p notchfolk-terminal -p notchfolk-whisper

rm -rf "$OUT" "dist/$NAME.tar.gz" "dist/$NAME.tar.gz.sha256"
mkdir -p "$OUT/bin"
install -m755 target/release/notchfolkd target/release/notchfolk-shelf target/release/notchfolk-terminal target/release/notchfolk-whisper "$OUT/bin/"
strip "$OUT/bin/notchfolkd" "$OUT/bin/notchfolk-shelf" "$OUT/bin/notchfolk-terminal" "$OUT/bin/notchfolk-whisper"
cp -r gnome-extension data mcp install.sh uninstall.sh README.md LICENSE CHANGELOG.md "$OUT/"
mkdir -p "$OUT/docs"
install -m644 docs/mcp.md "$OUT/docs/mcp.md"
# What install.sh installs as commands: the voice set-up and the battery charge limit.
mkdir -p "$OUT/scripts"
install -m755 scripts/setup-voice.sh scripts/setup-mcp.sh scripts/notchfolk-mcp scripts/notchfolk-mcp-keygen scripts/notchfolk-mcp-tunnel scripts/notchfolk-charge-limit scripts/notchfolk-migrate-from-isle.sh "$OUT/scripts/"
# Compiled on install, for the GLib there.
rm -f "$OUT/gnome-extension/schemas/gschemas.compiled"

tar -C dist -czf "dist/$NAME.tar.gz" "$NAME"
(cd dist && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
rm -rf "$OUT"
echo "dist/$NAME.tar.gz"
