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
        }, 'notify::allocation', geometryChanged, 'effects-completed', geometryChanged, 'notify::mapped', () => {
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
