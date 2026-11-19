// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

import {terminalCanRestore} from './terminalRules.js';

/** Leaving before the first map remembers where Open came from, not an as-yet unverified owner. */
export class TerminalReturn {
    constructor() {
        this.open(null);
    }

    open(workspace) {
        this.workspace = workspace;
        this.owner = null;
        this.pendingMap = null;
    }

    leave(remember, windowWorkspace, windowOwner, request) {
        this.workspace = remember ? windowWorkspace ?? this.workspace : null;
        this.owner = remember ? windowOwner : null;
        this.pendingMap = windowOwner ? null : request;
    }

    /** A lock can arrive while a hide is still owed; revoke the return, not the hide. */
    revoke() {
        this.workspace = null;
        this.owner = null;
    }

    /** Called only for the authenticated primary. A D-Bus owner alone is not evidence of a window. */
    mapped(owner) {
        if (this.pendingMap === null)
            return false;
        this.pendingMap = null;
        if (this.workspace)
            this.owner = owner;
        return true;
    }

    canRestore({active, available, managed, owner, identity, workspace, locked, overview, mapped}) {
        // A rapid return waits until the old surface actually went away, not merely the D-Bus reply.
        return !mapped && terminalCanRestore({active, available, managed, locked, overview,
            verified: Boolean(identity && owner === identity.busName),
            live: Boolean(this.owner && this.owner === identity?.busName),
            sameWorkspace: this.workspace === workspace});
    }
}

function misses(rect, x1, y1, x2, y2) {
    return [x1, y1, x2, y2].every(Number.isFinite) && x1 < x2 && y1 < y2 &&
        (x1 >= rect.x + rect.width || x2 <= rect.x || y1 >= rect.y + rect.height || y2 <= rect.y);
}

/** Mutter owns the stack. Borrow the above flag, never focus or continuously raise; an equal or
 * higher layer can still win. Watch only the actors above the primary while the card needs them. */
export class TerminalStack {
    constructor(changed) {
        this._changed = changed;
        this._higher = new Map();
        this._window = null;
        this._addedAbove = false;
    }

    hold(window) {
        if (this._window !== window) {
            this.release();
            this._window = window;
            this._addedAbove = !window.is_above();
        }
        if (!window.is_above())
            window.make_above();
    }

    _watch(actor) {
        const watch = {window: actor.meta_window};
        this._higher.set(actor, watch);
        // The input frame and the painted actor have independent lifetimes and notifications.
        // In particular a closing effect may outlive an unmanaged Meta.Window.
        watch.window?.connectObject('position-changed', this._changed, 'size-changed', this._changed,
            'unmanaged', () => {
                watch.window.disconnectObject(watch);
                watch.window = null;
            }, watch);
        actor.connectObject('notify', this._changed, 'destroy', () => {
            watch.window?.disconnectObject(watch);
            this._higher.delete(actor);
        }, this);
    }

    _unwatch(actor, watch) {
        actor.disconnectObject(this);
        watch.window?.disconnectObject(watch);
        this._higher.delete(actor);
    }

    /** Inspect the actual compositor siblings, lowest first. A higher client moving into just one
     * edge matters, even if it never takes focus. Include transformed shadows and map effects. */
    uncovered(primary, rect, siblings, popups) {
        const window = this._window;
        const at = siblings.indexOf(primary);
        if (!window || at < 0 || window.get_compositor_private() !== primary || !primary.mapped ||
            primary.get_paint_opacity() !== 255 || !window.is_above())
            return false;
        const higher = new Set([...siblings.slice(at + 1), ...popups]);
        for (const [actor, watch] of this._higher) {
            if (!higher.has(actor))
                this._unwatch(actor, watch);
        }
        let safe = true;
        for (const actor of higher) {
            if (!this._higher.has(actor))
                this._watch(actor);
            if (!safe || !actor.mapped)
                continue;
            const other = this._higher.get(actor).window;
            if (other && other.get_compositor_private() === actor) {
                if (window.is_ancestor_of_transient(other) && other.get_pid() === window.get_pid())
                    continue;
                // An input frame needn't paint all of its pixels (and can move ahead of an effect).
                const frame = other.get_frame_rect();
                if (!misses(rect, frame.x, frame.y, frame.x + frame.width, frame.y + frame.height)) {
                    safe = false;
                    continue;
                }
            }
            // A rotated actor's transformed origin is NOT necessarily the corner of its bounding box.
            // Clutter's paint box conservatively bounds its whole projection, including children.
            const [known, box] = actor.get_paint_box();
            safe = Boolean(known && box && misses(rect, box.x1, box.y1, box.x2, box.y2));
        }
        return safe;
    }

    release({unmanaged = false} = {}) {
        for (const [actor, watch] of this._higher)
            this._unwatch(actor, watch);
        const window = this._window;
        this._window = null;
        if (!unmanaged && window && this._addedAbove && window.is_above())
            window.unmake_above();
    }
}

/** A clip and its signal connections belong to one specific compositor actor, not the GTK app.
 * Mutter can retire that actor before Meta.Window::unmanaged or leave it around for a closing effect. */
export class TerminalBody {
    constructor(window, actor, onDestroy, onGeometry, onMapped) {
        this._window = window;
        this._actor = actor;
        this._clip = undefined; // untouched; null means the actor originally had no clip
        // A GNOME map effect finishes by resetting the scale/translation, not reallocating
        // the actor. Recheck its transformed bounds once Mutter has finished that effect.
        const geometryChanged = () => {
            if (this.actor)
                onGeometry();
        };
        actor.connectObject('destroy', () => {
            // Clutter/Shell retire the actor's connections. Never even ask a disposed wrapper if it is alive.
            this._clear();
            onDestroy(this);
        }, 'notify::allocation', geometryChanged, 'notify::opacity', geometryChanged,
        'notify::scale-x', geometryChanged, 'notify::scale-y', geometryChanged,
        'notify::translation-x', geometryChanged, 'notify::translation-y', geometryChanged,
        'effects-completed', geometryChanged, 'notify::mapped', () => {
            if (this.actor)
                onMapped();
        }, this);
    }

    get actor() {
        const actor = this._actor;
        // Mutter clears compositor_private when queueing destruction, before a closing effect finishes.
        return actor && this._window.get_compositor_private() === actor && !actor.is_destroyed() ? actor : null;
    }

    _clear() {
        this._actor = null;
        this._window = null;
        this._clip = undefined;
    }

    hide() {
        // Shell animates the native opacity during map/unmap. An empty clip remains empty even if
        // that animation sets opacity to 255; don't save or overwrite Shell's transient opacity.
        this._clipTo(0, 0, 0, 0);
    }

    reveal(clip) {
        return this._clipTo(clip.x, clip.y, clip.width, clip.height);
    }

    _clipTo(x, y, width, height) {
        const actor = this.actor;
        if (!actor)
            return false;
        if (this._clip === undefined)
            this._clip = actor['has-clip'] ? actor.get_clip() : null;
        actor.set_clip(x, y, width, height);
        return true;
    }

    release({forget = false, detach = false} = {}) {
        const actor = this.actor;
        if (!forget && actor?.mapped)
            return;
        const clip = this._clip;
        if (forget) {
            this._clear();
            actor?.disconnectObject(this);
        } else {
            this._clip = undefined;
        }
        if (!actor || clip === undefined)
            return;
        if (actor.mapped && !detach) {
            // The outgoing surface may still be animating. Don't expose its stale frame or shadow.
            actor.set_clip(0, 0, 0, 0);
            return;
        }
        if (clip === null)
            actor.remove_clip();
        else
            actor.set_clip(...clip);
    }
}
