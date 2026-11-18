// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The island's interaction sounds (docs/island-sounds-plan.md): soft, short, and
// never in the way. This module is the only place that plays anything - each
// moment calls `islandSound(name)` and the gate decides whether it is heard.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Two sounds never overlap: one within this many ms of the last is dropped. */
const STACK_MS = 80;

let lastAt = 0;
let fileFor = () => null;
let enabled = () => false;
let dnd = () => false;

/** The controller wires the gates once: where the files are, the setting, the DND. */
export function initSounds({dir, isEnabled, isDnd} = {}) {
    if (dir)
        fileFor = name => dir.get_child(`${name}.wav`);
    if (isEnabled)
        enabled = isEnabled;
    if (isDnd)
        dnd = isDnd;
}

/** Plays the island sound `name` (a file at sounds/<name>.wav), if its moment allows:
 * the master switch on, the session unlocked, not in Do Not Disturb, and nothing of
 * ours within the last 80 ms. A missing file is silence, never an error. */
export function islandSound(name) {
    if (!enabled() || Main.sessionMode.isLocked || dnd())
        return;
    const now = Date.now();
    if (now - lastAt < STACK_MS)
        return;
    lastAt = now;
    const file = fileFor(name);
    if (!file || !file.query_exists(null))
        return;
    // Playback is best-effort; a player failure must never interrupt the island action.
    try {
        global.display.get_sound_player().play_from_file(file, 'Notchfolk', null);
    } catch {
        // Silence is safer than failing the interaction that requested it.
    }
}
