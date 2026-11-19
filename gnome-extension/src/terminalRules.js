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

/** Passive re-entry may reveal only a live window we already managed on this workspace. */
export function terminalCanRestore({active, available, managed, verified, live, sameWorkspace, locked, overview}) {
    return active === true && available === true && managed === true && verified === true &&
        live === true && sameWorkspace === true && locked === false && overview === false;
}

/** Mutter picks the native surface, not necessarily its toplevel: a GTK popover can extend past the card. */
export function terminalOwnsPointer(window, picked) {
    if (!window)
        return false;
    for (let actor = picked; actor; actor = actor.get_parent()) {
        const target = actor.meta_window;
        if (target)
            return target === window || window.is_ancestor_of_transient(target);
    }
    return false;
}

/** A newly mapped page can still have its empty state's natural size. Never fit a client to that size. */
export function terminalViewportSettled({rect, position, size, morphing, opacity}) {
    // Transformed allocations can round differently; a subpixel gap is fine, a whole stage pixel isn't.
    return Boolean(!morphing && opacity === 255 && rect && size && position &&
        [rect.x, rect.y, rect.width, rect.height, position[0], position[1], size.width, size.height].every(Number.isFinite) &&
        size.width > 0 && size.height > 0 &&
        Math.abs(rect.width - size.width) < 1 && Math.abs(rect.height - size.height) < 1 &&
        Math.abs(position[0] - rect.x) < 1 && Math.abs(position[1] - rect.y) < 1);
}

/** Fit the native card to its real page allocation, rounding inward in stage coordinates. */
export function terminalViewport(rect, workArea, scale = 1) {
    if (!Number.isFinite(scale) || scale <= 0 || ![rect, workArea].every(box => box &&
        ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) &&
        box.width > 0 && box.height > 0))
        return null;
    const x = Math.ceil(Math.max(rect.x, workArea.x));
    const y = Math.ceil(Math.max(rect.y, workArea.y));
    const right = Math.floor(Math.min(rect.x + rect.width, workArea.x + workArea.width));
    const bottom = Math.floor(Math.min(rect.y + rect.height, workArea.y + workArea.height));
    const width = Math.round(Math.floor((right - x) / scale) * scale);
    const height = Math.round(Math.floor((bottom - y) / scale) * scale);
    return width > 0 && height > 0 ? {x, y, width, height} : null;
}

/** A rectangle fits a rounded body only if all four corners fit; the notch has no top corner radius. */
export function terminalFitsShape(rect, {x, y, width, height, radius = 0, crown = 0}) {
    if (![rect, {x, y, width, height}].every(box => box &&
        ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) &&
        box.width > 0 && box.height > 0) || ![radius, crown].every(Number.isFinite))
        return false;
    const right = x + width, bottom = y + height;
    if (rect.x < x || rect.y < y || rect.x + rect.width > right || rect.y + rect.height > bottom)
        return false;
    const inside = (cx, cy) => {
        const r = Math.max(0, Math.min(cy < y + height / 2 ? crown : radius, width / 2, height / 2));
        const nearestX = Math.max(x + r, Math.min(cx, right - r));
        const nearestY = Math.max(y + r, Math.min(cy, bottom - r));
        return (cx - nearestX) ** 2 + (cy - nearestY) ** 2 <= r ** 2;
    };
    return inside(rect.x, rect.y) && inside(rect.x + rect.width, rect.y) &&
        inside(rect.x, rect.y + rect.height) && inside(rect.x + rect.width, rect.y + rect.height);
}

/** Convert an acknowledged Meta frame into actor-local clipping bounds, excluding client shadows.
 * GTK minimum sizes must actually fit: never crop an oversized client and hide its footer. */
export function terminalActorViewport({frame, buffer, target, actor, width, height}) {
    if (![frame, buffer, target, actor].every(box => box &&
        ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) &&
        box.width > 0 && box.height > 0) || !Number.isFinite(width) || !Number.isFinite(height) ||
        width <= 0 || height <= 0 ||
        !['x', 'y', 'width', 'height'].every(key => frame[key] === target[key]) ||
        !['x', 'y', 'width', 'height'].every(key => Math.abs(actor[key] - buffer[key]) < 1) ||
        !terminalFitsShape(frame, buffer) || !terminalFitsShape(frame, actor))
        return null;
    const sx = width / actor.width, sy = height / actor.height;
    return {x: (frame.x - actor.x) * sx, y: (frame.y - actor.y) * sy,
        width: frame.width * sx, height: frame.height * sy};
}

/** Crop the island material into a window child's coordinate space without fitting/stretching it to the
 * viewport. `clip` is the acknowledged actor-local client frame; the parent may scale its children again. */
export function terminalMaterialGeometry(rect, [x, y, width, height], scale, [left, top], [w, h]) {
    const frame = {x: x / scale, y: y / scale, width: width / scale, height: height / scale};
    const sx = frame.width / rect.width, sy = frame.height / rect.height;
    return {frame, source: {x: (left - rect.x) * sx, y: (top - rect.y) * sy, width: w * sx, height: h * sy}};
}
