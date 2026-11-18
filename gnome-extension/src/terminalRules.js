// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// No GNOME imports: the ownership and stage-coordinate geometry rules are testable without Shell.
export const TERMINAL_APP_ID = 'io.galyarderlabs.notchfolk.Terminal';

/** A title or WM_CLASS is not identity. Only the verified bus owner's own GTK window is ours. */
export function ownsTerminalWindow({appId, busName, pid}, owner) {
    return Boolean(owner && Number.isInteger(owner.pid) && owner.pid > 0 && owner.busName &&
        appId === TERMINAL_APP_ID && busName === owner.busName && pid === owner.pid);
}

/** Warming or hovering a page never launches or focuses a shell. Only an explicit selection does. */
export function terminalCanOpen({active, available, explicit}) {
    return active === true && available === true && explicit === true;
}

/** A newly mapped page can still have its empty state's natural size. Never fit a client to that size. */
export function terminalViewportSettled({rect, position, size, morphing, opacity}) {
    return Boolean(!morphing && opacity === 255 && rect && size && position &&
        [rect.x, rect.y, rect.width, rect.height, position[0], position[1], size.width, size.height].every(Number.isFinite) &&
        size.width > 0 && size.height > 0 &&
        Math.abs(rect.width - size.width) < 1 && Math.abs(rect.height - size.height) < 1 &&
        Math.abs(position[0] - rect.x) < 1 && Math.abs(position[1] - rect.y) < 1);
}

/** Fit the native card to its real page allocation, rounding inward in stage coordinates. */
export function terminalViewport(rect, workArea) {
    if (![rect, workArea].every(box => box &&
        ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) &&
        box.width > 0 && box.height > 0))
        return null;
    const x = Math.ceil(Math.max(rect.x, workArea.x));
    const y = Math.ceil(Math.max(rect.y, workArea.y));
    const right = Math.floor(Math.min(rect.x + rect.width, workArea.x + workArea.width));
    const bottom = Math.floor(Math.min(rect.y + rect.height, workArea.y + workArea.height));
    return right > x && bottom > y ? {x, y, width: right - x, height: bottom - y} : null;
}
