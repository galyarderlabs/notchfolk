// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// A local GTK terminal, never a daemon command endpoint. Only a click or keybinding launches it.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {uiScale} from './compat.js';
import {TerminalBody, TerminalReturn} from './terminalLifecycle.js';
import {ownsTerminalWindow, terminalActorViewport, terminalCanOpen,
    terminalOwnsPointer, terminalViewport, terminalViewportSettled, TERMINAL_APP_ID} from './terminalRules.js';

const PROGRAM = 'notchfolk-terminal';
const OPEN_TIMEOUT_MS = 10000;

/** User installs need not be in GNOME Shell's login PATH; system packages use the normal executable search. */
function findBinary() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', PROGRAM]);
    if (GLib.file_test(local, GLib.FileTest.IS_REGULAR) && GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE))
        return local;
    return GLib.find_program_in_path(PROGRAM);
}

/** Follow symlinks so a packaged binary and /proc/PID/exe identify the same installed executable. */
function executableIdentity(path) {
    const info = Gio.File.new_for_path(path).query_info('unix::device,unix::inode', Gio.FileQueryInfoFlags.NONE, null);
    if (!info.has_attribute('unix::device') || !info.has_attribute('unix::inode'))
        throw new Error('The terminal executable has no filesystem identity');
    return `${info.get_attribute_as_string('unix::device')}:${info.get_attribute_as_string('unix::inode')}`;
}

// Signals: opening (release the modal grab), closed (native window closed), held-changed (recheck native input).
export class TerminalHelper extends Signals.EventEmitter {
    constructor(island, page, monitor) {
        super();
        this._island = island;
        this._page = page;
        this._monitor = monitor;
        this._owner = null;
        this._identity = null;
        this._window = null;
        this._pinned = false;
        this._pinnedWindow = null;
        this._body = null;
        this._launchPid = null;
        this._placementError = null;
        this._return = new TerminalReturn();
        this._restoreAvailable = false;
        this._wanted = false;
        this._managed = false;
        this._shown = false;
        this._revealed = false;
        this._focusRequested = false;
        this._opening = 0;
        this._placing = 0;
        this._request = 0;
        this._fitSent = null;
        this._actions = null;
        this._actionSignals = [];
        this._expandedMode = null;
        this._fitAvailable = false;
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();
        this._signals = [
            [page, page.connect('destroy', () => this.destroy({dying: page}))],
            [island, island.connect('destroy', () => this.destroy({dying: island}))],
            [page, page.connect('active-changed', () => page.active ? this.restore() : this.hide())],
            [page, page.connect('open-requested', () => this.open())],
            [page, page.connect('helper-area-changed', () => this._geometryChanged())],
            [island, island.connect('geometry-changed', () => {
                if (island.morphing)
                    this._hideBody();
                this.sync();
            })],
            [island, island.connect('notify::mapped', () => this.sync())],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._geometryChanged())],
            [global.display, global.display.connect('workareas-changed', () => this._geometryChanged())],
            [global.display, global.display.connect('notify::focus-window', () => this.emit('held-changed'))],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._visibilityChanged())],
            [global.window_manager, global.window_manager.connect('map', (_wm, actor) => this._watchWindow(actor))],
            [Main.overview, Main.overview.connect('showing', () => this._visibilityChanged())],
            [Main.overview, Main.overview.connect('hidden', () => this._visibilityChanged())],
            [Main.sessionMode, Main.sessionMode.connect('updated', () => {
                if (Main.sessionMode.isLocked)
                    this.hide({remember: false});
                this._visibilityChanged();
            })],
        ];
        // NONE is deliberately not AUTO_START: constructing, warming or hovering a page creates no shell.
        this._watch = Gio.bus_watch_name(Gio.BusType.SESSION, TERMINAL_APP_ID, Gio.BusNameWatcherFlags.NONE,
            (connection, _name, owner) => this._verifyOwner(connection, owner), () => {
                // Initial "vanished" is not a lost owner; an explicitly launched process may be starting.
                if (!this._destroyed && this._owner)
                    this._ownerLost();
            });
    }

    get visible() {
        return this._wanted && this._shown;
    }

    get ownsKeyboard() {
        return this._wanted && this._page.active;
    }

    get holdsOpen() {
        if (!this.ownsKeyboard || this._destroyed)
            return false;
        const [x, y] = global.get_pointer();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (picked && this._island.contains(picked))
            return true;
        if (!this._actor || !this._revealed)
            return false;
        const window = this._window;
        const focus = global.display.focus_window;
        if (focus?.get_window_type() === Meta.WindowType.MODAL_DIALOG && window.is_ancestor_of_transient(focus))
            return true;
        return terminalOwnsPointer(window, picked);
    }

    /** The controller owns the pin for this opening, including tab changes before the helper maps. */
    set pinned(pinned) {
        if (this._pinned === pinned)
            return;
        this._pinned = pinned;
        if (this._actor)
            this._syncWorkspacePin(pinned && this._managed && this.ownsKeyboard && !Main.sessionMode.isLocked);
    }

    _syncWorkspacePin(wanted) {
        const window = this._window; // Only _watchWindow's verified primary; never the focused window.
        if (wanted && !this._pinnedWindow && window && !window.is_on_all_workspaces()) {
            this._pinnedWindow = window; // stick/unstick may emit workspace-changed synchronously.
            window.stick();
        } else if (!wanted && this._pinnedWindow) {
            const owned = this._pinnedWindow;
            this._pinnedWindow = null;
            owned.unstick();
        }
    }

    /** Called only by an explicit tab, shortcut or page button, never by Page.onActivate/warmUp. */
    open() {
        if (this._destroyed || Main.sessionMode.isLocked ||
            !terminalCanOpen({active: this._page.active, available: this._page.available, explicit: true}))
            return;
        this._binary = findBinary();
        if (!this._identity && !this._binary) {
            this._fail('Install notchfolk-terminal to open the terminal.');
            return;
        }
        if (this._owner && !this._identity) {
            this._fail('The terminal application name is not owned by the installed helper.');
            return;
        }
        const request = ++this._request;
        this._wanted = true;
        this._managed = true;
        this._return.open(global.workspace_manager.get_active_workspace());
        this._fitSent = null;
        this._focusRequested = true;
        this._hideBody();
        this._beginOpening();
        this.emit('opening');
        Main.overview.hide();
        try {
            if (this._actor) {
                const workspace = global.workspace_manager.get_active_workspace();
                if (!this._window.located_on_workspace(workspace))
                    this._window.change_workspace(workspace);
                if (this._window.minimized)
                    this._window.unminimize();
            }
            if (this._identity) {
                this._applicationCall('Activate', new GLib.Variant('(a{sv})', [{}]), request);
            } else if (!this._launchPid) {
                const process = Gio.Subprocess.new([this._binary], Gio.SubprocessFlags.NONE);
                const pid = this._launchPid = Number(process.get_identifier());
                process.wait_check_async(null, (child, result) => {
                    try {
                        child.wait_check_finish(result);
                    } catch (error) {
                        console.warn(`Notchfolk: terminal helper failed: ${error.message}`);
                        if (!this._destroyed && this._launchPid === pid) {
                            this._launchPid = null;
                            this._cancelManagement(error.message);
                        }
                    }
                });
            }
            this._visibilityChanged();
        } catch (error) {
            this._fail(error.message);
        }
    }

    /** Re-enter only the verified primary whose existing window this page hid. The restore action maps
     * that window without Activate/present or creating a first shell; warmUp never activates the page. */
    restore() {
        if (this._destroyed || this._wanted || !this._restoreAvailable || !this._return.canRestore({
            active: this._page.active, available: this._page.available, managed: this._managed,
            owner: this._owner, identity: this._identity, workspace: global.workspace_manager.get_active_workspace(),
            mapped: this._actor?.mapped,
            locked: Main.sessionMode.isLocked, overview: Main.overview.visible,
        }))
            return;
        ++this._request;
        this._wanted = true;
        this._focusRequested = false;
        this._hideBody();
        this._beginOpening();
        this.emit('opening');
        this._applicationCall('ActivateAction', new GLib.Variant('(sava{sv})', ['restore', [], {}]), this._request);
    }

    /** Clear drawing and input immediately; the existing primary then hides without ending any shell. */
    hide({remember = true} = {}) {
        if (!remember)
            this._return.revoke();
        if (!this._wanted && !this._opening && !this._revealed)
            return;
        const window = this._identity && this._actor ? this._window : null;
        const workspace = window?.is_on_all_workspaces()
            ? global.workspace_manager.get_active_workspace() : window?.get_workspace();
        this._return.leave(remember, workspace, window ? this._identity.busName : null, this._request);
        this._wanted = false;
        this._focusRequested = false;
        ++this._request;
        this._endOpening();
        this._hideBody();
        this._syncWorkspacePin(false);
        this._page.setStatus('idle');
        // Hiding GTK before Mutter sees its first window can prevent that map entirely.
        // Authenticate the map first; until then there's no existing window to remember.
        if (window || !remember)
            this._hideExisting();
    }

    _hideExisting() {
        if (this._identity)
            this._applicationCall('ActivateAction', new GLib.Variant('(sava{sv})', ['hide', [], {}]), this._request);
    }

    _applicationCall(method, parameters, request) {
        Gio.DBus.session.call(this._identity.busName, '/io/galyarderlabs/notchfolk/Terminal',
            'org.freedesktop.Application', method, parameters, null,
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable, (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (error) {
                    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    console.warn(`Notchfolk: terminal ${method} failed: ${error.message}`);
                    // Leave superseded this request while its first map was outstanding.
                    if (this._return.pendingMap === request)
                        this._return.open(null);
                    if (!this._destroyed && request === this._request) {
                        this._return.revoke();
                        if (this._wanted)
                            this._fail(error.message);
                        else
                            Main.notifyError('Notchfolk Terminal', `Could not hide the terminal: ${error.message}`);
                    }
                    return;
                }
                if (!this._destroyed && request === this._request) {
                    this._visibilityChanged();
                    this.restore();
                }
            });
    }

    _beginOpening() {
        this._endOpening();
        this._placementError = null;
        this._page.setStatus('opening');
        this._opening = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OPEN_TIMEOUT_MS, () => {
            this._opening = 0;
            this._fail(this._placementError ?? 'The terminal did not open. Check that the helper and tmux are installed.');
            return GLib.SOURCE_REMOVE;
        });
    }

    _endOpening() {
        if (this._opening)
            GLib.source_remove(this._opening);
        this._opening = 0;
    }

    _fail(message) {
        this.hide({remember: false});
        this._page.setStatus('error', message);
        this.emit('held-changed');
    }

    _cancelManagement(message) {
        const wanted = this._wanted;
        this._wanted = false;
        this._managed = false;
        this._focusRequested = false;
        this._launchPid = null;
        this._return.open(null);
        ++this._request;
        this._endOpening();
        this._forgetWindow();
        if (wanted) {
            this._page.setStatus('error', message);
            this.emit('held-changed');
        }
    }

    _ownerLost() {
        this._owner = null;
        this._identity = null;
        this._cancelManagement('The terminal stopped. Open it again to start a shell.');
        this._dropActions();
    }

    /** Authenticate the GTK bus owner against the local executable before touching any window. */
    _verifyOwner(connection, owner) {
        if (this._destroyed)
            return;
        if (this._owner && this._owner !== owner)
            this._ownerLost();
        this._owner = owner;
        connection.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [owner]), new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable, (bus, result) => {
                let pid;
                try {
                    [pid] = bus.call_finish(result).deep_unpack();
                    if (this._destroyed || this._owner !== owner)
                        return;
                    const binary = findBinary();
                    if (!Number.isInteger(pid) || pid <= 0 || !binary ||
                        executableIdentity(`/proc/${pid}/exe`) !== executableIdentity(binary))
                        throw new Error('The terminal application name is not owned by the installed helper.');
                } catch (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        console.warn(`Notchfolk: could not identify the terminal helper: ${error.message}`);
                        if (!this._destroyed && this._owner === owner)
                            this._cancelManagement(error.message);
                    }
                    return;
                }
                // A replacement primary cannot inherit a launch that had yet to acquire the name.
                if (this._launchPid && this._launchPid !== pid)
                    this._cancelManagement('The terminal owner changed. Open it again to use this helper.');
                this._launchPid = null;
                this._identity = {busName: owner, pid};
                this._bindActions();
                for (const actor of global.get_window_actors())
                    this._watchWindow(actor);
            });
    }

    /** Observe state on the authenticated unique owner; this standard action group cannot start an app. */
    _bindActions() {
        this._actions = Gio.DBusActionGroup.get(Gio.DBus.session, this._identity.busName,
            '/io/galyarderlabs/notchfolk/Terminal');
        this._actionSignals = [
            this._actions.connect('action-added', (_group, name) => {
                if (name === 'expanded' || name === 'fit-viewport' || name === 'restore')
                    this._syncActions();
            }),
            this._actions.connect('action-state-changed', (_group, name) => {
                if (name === 'expanded')
                    this._syncActions();
            }),
        ];
        // GDBusActionGroup is asynchronous: connect first, then request the initial inventory.
        this._actions.list_actions();
        this._syncActions();
    }

    _syncActions() {
        const actions = this._actions;
        if (!actions)
            return;
        this._fitAvailable = actions.has_action('fit-viewport') &&
            actions.get_action_parameter_type('fit-viewport')?.dup_string() === '(ii)';
        this._restoreAvailable = actions.has_action('restore') && !actions.get_action_parameter_type('restore');
        const state = actions.has_action('expanded') ? actions.get_action_state('expanded') : null;
        if (!state)
            return;
        if (state.get_type_string() !== 'b') {
            this._fail('The terminal helper returned an invalid expanded mode.');
            return;
        }
        const expanded = state.get_boolean();
        const changed = expanded !== this._expandedMode;
        if (changed) {
            this._expandedMode = expanded;
            this._fitSent = null;
            if (this._wanted) {
                this._hideBody();
                if (!this._opening)
                    this._beginOpening();
            }
            this._page.setExpanded(expanded);
        }
        this.restore();
        this.sync();
    }

    _dropActions() {
        for (const id of this._actionSignals)
            this._actions.disconnect(id);
        this._actionSignals = [];
        this._actions = null;
        this._expandedMode = null;
        this._fitAvailable = false;
        this._restoreAvailable = false;
        this._fitSent = null;
    }

    _watchWindow(actor) {
        if (this._destroyed || !this._identity || !actor || actor.is_destroyed())
            return;
        const window = actor.meta_window;
        if (!window || actor === this._actor || window.get_compositor_private() !== actor || window.get_transient_for() ||
            window.get_window_type() !== Meta.WindowType.NORMAL || !ownsTerminalWindow({
                appId: window.get_gtk_application_id(), busName: window.get_gtk_unique_bus_name(), pid: window.get_pid(),
            }, this._identity))
            return;
        this._forgetWindow();
        this._window = window;
        this._body = new TerminalBody(window, actor, body => {
            if (this._body !== body)
                return;
            this._body = null;
            this._shown = false;
            this._pinnedWindow = null;
            this._clearViewport();
            this.restore();
        }, () => this._geometryChanged(), () => {
            this._visibilityChanged();
            this.restore();
        });
        if (this._managed && (this._wanted || this._return.pendingMap !== null))
            this._hideBody();
        window.connectObject('unmanaged', () => {
            const closed = this._wanted && !this._opening;
            this._forgetWindow({unmanaged: true});
            if (closed) {
                this.hide({remember: false});
                this.emit('closed');
            } else {
                this.restore();
            }
        }, 'size-changed', () => {
            // A compositor allocation acknowledges a fit; it never determines the user's compact/expanded mode.
            if (this._revealed)
                this._fitSent = null;
            this._geometryChanged();
        }, 'position-changed', () => this._geometryChanged(),
        'notify::minimized', () => this._visibilityChanged(),
        'workspace-changed', () => this._visibilityChanged(), this);
        if (!this._wanted && this._return.mapped(this._identity.busName))
            this._hideExisting();
        this._visibilityChanged();
    }

    /** Only a pinned, attached helper follows workspaces. Passive changes never activate it. */
    _visibilityChanged() {
        if (this._destroyed)
            return;
        const actor = this._actor;
        const pinned = this._pinned && this._managed && this.ownsKeyboard && !Main.sessionMode.isLocked;
        if (actor)
            this._syncWorkspacePin(pinned);
        // Hide's D-Bus reply can precede the compositor unmap. Keep the old frame clipped/invisible
        // until it is really gone, otherwise its GTK shadow flashes outside the closing island.
        if (!this._wanted && !actor?.mapped)
            this._restoreBody();
        this._shown = Boolean(!Main.sessionMode.isLocked && !Main.overview.visible && actor?.mapped &&
            !this._window.minimized && this._window.showing_on_its_workspace() &&
            this._window.located_on_workspace(global.workspace_manager.get_active_workspace()));
        // Workspace/overview animations can briefly unmap the actor. While pinned that's not a close;
        // GTK withdrawing the window is handled by 'unmanaged', and an explicit minimize here.
        if (!this._shown && this._wanted && !this._opening && !Main.overview.visible &&
            (!pinned || this._window?.minimized)) {
            this.hide({remember: false});
            this.emit('closed');
            return;
        }
        if (this._wanted && !this._shown)
            this._hideBody();
        this.sync();
    }

    _geometryChanged() {
        if (this._wanted)
            this._hideBody();
        this.sync();
    }

    get _actor() {
        return this._body?.actor ?? null;
    }

    _clearViewport() {
        this._revealed = false;
        if (this._island)
            this._island.nativeViewport = null;
    }

    _hideBody() {
        if (this._managed)
            this._body?.hide();
        this._clearViewport();
    }

    _restoreBody() {
        this._clearViewport();
        this._body?.release();
    }

    /** Fit the normal page's card under its real header; GTK keeps its own keyboard, PTY and footer. */
    sync() {
        if (this._destroyed || !this._wanted || !this._page.active || this._placing)
            return;
        if (!this._shown || !this._island.mapped || Main.sessionMode.isLocked) {
            this._hideBody();
            return;
        }
        if (this._expandedMode === null || !this._fitAvailable)
            return;
        this._placing = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._placing = 0;
            const window = this._window;
            if (!this._wanted || !this._page.active || !window || !this._shown)
                return GLib.SOURCE_REMOVE;
            try {
                const rect = this._island.restingRect(this._page.helperArea);
                if (!terminalViewportSettled({rect, position: this._page.helperArea.get_transformed_position(),
                    size: this._page.helperSize, morphing: this._island.morphing, opacity: this._page.get_paint_opacity()})) {
                    this._hideBody();
                    return GLib.SOURCE_REMOVE;
                }
                const monitor = this._monitor();
                const area = monitor && global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor.index);
                const scale = uiScale();
                const target = terminalViewport(rect, area, scale);
                const actor = this._actor;
                if (!target || !actor || !this._island.covers(target, {rounded: true})) {
                    this._hideBody();
                    return GLib.SOURCE_REMOVE;
                }
                // GTK owns sizing on Wayland. Never send a compositor resize or a transient page allocation.
                const width = Math.round(target.width / scale);
                const height = Math.round(target.height / scale);
                if (!this._fitSent || this._fitSent.width !== width || this._fitSent.height !== height) {
                    this._hideBody();
                    if (!this._opening)
                        this._beginOpening();
                    this._fitSent = {width, height};
                    this._applicationCall('ActivateAction', new GLib.Variant('(sava{sv})',
                        ['fit-viewport', [new GLib.Variant('(ii)', [width, height])], {}]), this._request);
                }
                const frame = window.get_frame_rect();
                if (frame.x !== target.x || frame.y !== target.y) {
                    this._hideBody();
                    window.move_frame(false, target.x, target.y);
                } else if (frame.width === target.width && frame.height === target.height) {
                    this._placementError = null;
                    const [x, y] = actor.get_transformed_position();
                    const [actorWidth, actorHeight] = actor.get_transformed_size();
                    const clip = terminalActorViewport({frame, buffer: window.get_buffer_rect(), target,
                        actor: {x, y, width: actorWidth, height: actorHeight}, width: actor.width, height: actor.height});
                    if (!clip) {
                        this._hideBody();
                        return GLib.SOURCE_REMOVE;
                    }
                    // Meta's frame is the interactive client; its buffer/actor can include GTK shadows.
                    // GTK clips its own 12px corners; the actor clip removes all pixels outside the frame.
                    const justRevealed = !this._revealed;
                    if (!this._body?.reveal(clip))
                        return GLib.SOURCE_REMOVE;
                    this._island.nativeViewport = {...target, actor};
                    this._revealed = true;
                    this._endOpening();
                    this._page.setStatus('ready');
                    if (justRevealed)
                        this.emit('held-changed');
                    if (this._focusRequested) {
                        this._focusRequested = false;
                        Main.activateWindow(window);
                    }
                } else {
                    this._placementError = `The terminal's ${frame.width} × ${frame.height} window does not fit ` +
                        `the ${target.width} × ${target.height} page. Try a smaller terminal font or a larger display.`;
                    this._hideBody();
                }
            } catch (error) {
                console.warn(`Notchfolk: could not place the terminal page: ${error.message}`);
                this._fail(error.message);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _forgetWindow({unmanaged = false, detach = false} = {}) {
        const window = this._window, body = this._body;
        const unpin = !unmanaged && body?.actor;
        this._window = null;
        this._body = null;
        this._shown = false;
        this._fitSent = null;
        this._clearViewport();
        window?.disconnectObject(this);
        if (unpin)
            this._syncWorkspacePin(false);
        else
            this._pinnedWindow = null;
        body?.release({forget: true, detach});
    }

    destroy({dying = null} = {}) {
        if (this._destroyed)
            return;
        const reveal = !dying && !Main.sessionMode.isLocked && this._managed && this._identity;
        this._destroyed = true;
        if (dying)
            this._island = null;
        this.disconnectAll();
        if (this._placing)
            GLib.source_remove(this._placing);
        this._endOpening();
        this._cancellable.cancel();
        this._dropActions();
        Gio.bus_unwatch_name(this._watch);
        for (const [object, id] of this._signals) {
            if (object !== dying)
                object.disconnect(id);
        }
        this._signals = [];
        this._forgetWindow({detach: true});
        // Removing UI never ends a shell or job. Reveal only the authenticated existing primary, no autostart.
        if (reveal) {
            Gio.DBus.session.call(reveal.busName, '/io/galyarderlabs/notchfolk/Terminal',
                'org.freedesktop.Application', 'ActivateAction', new GLib.Variant('(sava{sv})', ['detach', [], {}]), null,
                Gio.DBusCallFlags.NO_AUTO_START, -1, null, (connection, result) => {
                    try {
                        connection.call_finish(result);
                    } catch (error) {
                        console.warn(`Notchfolk: could not reveal the detached terminal: ${error.message}`);
                    }
                });
        }
    }
}
