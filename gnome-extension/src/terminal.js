// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// A local GTK terminal, never a daemon command endpoint. Only a click or keybinding launches it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {uiScale} from './compat.js';
import {ownsTerminalWindow, terminalCanOpen, terminalViewport, terminalViewportSettled, TERMINAL_APP_ID} from './terminalRules.js';

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

// Signals: opening (release the modal grab), closed (native window closed), held-changed (focus changed).
export class TerminalHelper extends Signals.EventEmitter {
    constructor(island, page, monitor) {
        super();
        this._island = island;
        this._page = page;
        this._monitor = monitor;
        this._owner = null;
        this._identity = null;
        this._window = null;
        this._windowSignals = [];
        this._wanted = false;
        this._managed = false;
        this._pendingHide = false;
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
            [page, page.connect('active-changed', () => page.active ? this.sync() : this.hide())],
            [page, page.connect('open-requested', () => this.open())],
            [page, page.connect('helper-area-changed', () => this.sync())],
            [island, island.connect('geometry-changed', () => this.sync())],
            [island, island.connect('notify::mapped', () => this.sync())],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._geometryChanged())],
            [global.display, global.display.connect('workareas-changed', () => this._geometryChanged())],
            [global.display, global.display.connect('notify::focus-window', () => this.emit('held-changed'))],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._visibilityChanged())],
            [global.window_manager, global.window_manager.connect('map', (_wm, actor) => this._watchWindow(actor.meta_window))],
            [Main.overview, Main.overview.connect('showing', () => this._visibilityChanged())],
            [Main.overview, Main.overview.connect('hidden', () => this._visibilityChanged())],
            [Main.sessionMode, Main.sessionMode.connect('updated', () => {
                if (Main.sessionMode.isLocked)
                    this.hide();
                this._visibilityChanged();
            })],
        ];
        // NONE is deliberately not AUTO_START: constructing, warming or hovering a page creates no shell.
        this._watch = Gio.bus_watch_name(Gio.BusType.SESSION, TERMINAL_APP_ID, Gio.BusNameWatcherFlags.NONE,
            (connection, _name, owner) => this._verifyOwner(connection, owner), () => {
                this._owner = null;
                this._identity = null;
                this._dropActions();
                this._forgetWindow();
                if (this._wanted && !this._opening)
                    this._fail('The terminal stopped. Open it again to start a shell.');
            });
    }

    get visible() {
        return this._wanted && this._shown;
    }

    get ownsKeyboard() {
        return this._wanted && this._page.active;
    }

    get holdsOpen() {
        if (!this.ownsKeyboard)
            return false;
        const focus = global.display.focus_window;
        if (this._opening || this._window && (focus === this._window || focus?.get_transient_for() === this._window))
            return true;
        if (!this._revealed || !this._window)
            return false;
        const [x, y] = global.get_pointer();
        const frame = this._window.get_frame_rect();
        return x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height;
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
        this._pendingHide = false;
        this._fitSent = null;
        this._focusRequested = true;
        this._hideBody();
        this._beginOpening();
        this.emit('opening');
        Main.overview.hide();
        try {
            if (this._window) {
                const workspace = global.workspace_manager.get_active_workspace();
                if (!this._window.located_on_workspace(workspace))
                    this._window.change_workspace(workspace);
                if (this._window.minimized)
                    this._window.unminimize();
            }
            if (this._identity) {
                this._applicationCall('Activate', new GLib.Variant('(a{sv})', [{}]), request);
            } else {
                const process = Gio.Subprocess.new([this._binary], Gio.SubprocessFlags.NONE);
                process.wait_check_async(null, (child, result) => {
                    try {
                        child.wait_check_finish(result);
                    } catch (error) {
                        console.warn(`Notchfolk: terminal helper failed: ${error.message}`);
                        if (!this._destroyed && request === this._request)
                            this._fail(error.message);
                    }
                });
            }
            this._visibilityChanged();
        } catch (error) {
            this._fail(error.message);
        }
    }

    /** Clear drawing and input immediately; the existing primary then hides without ending any shell. */
    hide() {
        if (!this._wanted && !this._opening && !this._revealed)
            return;
        this._wanted = false;
        this._focusRequested = false;
        this._pendingHide = !this._window;
        ++this._request;
        this._endOpening();
        this._hideBody();
        this._page.setStatus('idle');
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
                    if (this._destroyed || request !== this._request)
                        return;
                    if (!this._wanted)
                        this._restoreBody();
                    else
                        this._visibilityChanged();
                } catch (error) {
                    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    console.warn(`Notchfolk: terminal ${method} failed: ${error.message}`);
                    if (!this._destroyed && request === this._request) {
                        this._restoreBody();
                        if (this._wanted)
                            this._fail(error.message);
                        else
                            Main.notifyError('Notchfolk Terminal', `Could not hide the terminal: ${error.message}`);
                    }
                }
            });
    }

    _beginOpening() {
        this._endOpening();
        this._page.setStatus('opening');
        this._opening = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OPEN_TIMEOUT_MS, () => {
            this._opening = 0;
            this._fail('The terminal did not open. Check that the helper and tmux are installed.');
            return GLib.SOURCE_REMOVE;
        });
    }

    _endOpening() {
        if (this._opening)
            GLib.source_remove(this._opening);
        this._opening = 0;
    }

    _fail(message) {
        this.hide();
        this._page.setStatus('error', message);
        this.emit('held-changed');
    }

    /** Authenticate the GTK bus owner against the local executable before touching any window. */
    _verifyOwner(connection, owner) {
        this._owner = owner;
        this._identity = null;
        this._forgetWindow();
        this._dropActions();
        connection.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [owner]), new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable, (bus, result) => {
                try {
                    const [pid] = bus.call_finish(result).deep_unpack();
                    if (this._destroyed || this._owner !== owner)
                        return;
                    const binary = findBinary();
                    if (!Number.isInteger(pid) || pid <= 0 || !binary ||
                        executableIdentity(`/proc/${pid}/exe`) !== executableIdentity(binary)) {
                        console.warn('Notchfolk: ignoring a terminal bus owner that is not the installed helper');
                        return;
                    }
                    this._binary = binary;
                    this._identity = {busName: owner, pid};
                    this._bindActions();
                    for (const actor of global.get_window_actors())
                        this._watchWindow(actor.meta_window);
                } catch (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Notchfolk: could not identify the terminal helper: ${error.message}`);
                }
            });
    }

    /** Observe state on the authenticated unique owner; this standard action group cannot start an app. */
    _bindActions() {
        this._actions = Gio.DBusActionGroup.get(Gio.DBus.session, this._identity.busName,
            '/io/galyarderlabs/notchfolk/Terminal');
        this._actionSignals = [
            this._actions.connect('action-added', (_group, name) => {
                if (name === 'expanded' || name === 'fit-viewport')
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
        this.sync();
    }

    _dropActions() {
        for (const id of this._actionSignals)
            this._actions.disconnect(id);
        this._actionSignals = [];
        this._actions = null;
        this._expandedMode = null;
        this._fitAvailable = false;
        this._fitSent = null;
    }

    _watchWindow(window) {
        if (this._destroyed || !window || window === this._window || window.get_transient_for() ||
            window.get_window_type() !== Meta.WindowType.NORMAL || !ownsTerminalWindow({
                appId: window.get_gtk_application_id(), busName: window.get_gtk_unique_bus_name(), pid: window.get_pid(),
            }, this._identity))
            return;
        this._forgetWindow();
        this._window = window;
        const actor = window.get_compositor_private();
        const watch = (object, name, callback) => this._windowSignals.push([object, object.connect(name, callback)]);
        watch(window, 'unmanaged', () => {
            const closed = this._wanted && this._revealed;
            this._forgetWindow();
            if (closed) {
                this.hide();
                this.emit('closed');
            }
        });
        watch(window, 'size-changed', () => {
            // A compositor allocation acknowledges a fit; it never determines the user's compact/expanded mode.
            if (this._revealed)
                this._fitSent = null;
            this._geometryChanged();
        });
        watch(window, 'position-changed', () => this.sync());
        watch(window, 'notify::minimized', () => this._visibilityChanged());
        watch(window, 'workspace-changed', () => this._visibilityChanged());
        if (actor)
            watch(actor, 'notify::mapped', () => this._visibilityChanged());
        if (this._pendingHide && !this._wanted) {
            this._pendingHide = false;
            this._hideBody();
            this._hideExisting();
        }
        this._visibilityChanged();
    }

    /** Passive workspace, overview and lock changes never activate or move a window into this workspace. */
    _visibilityChanged() {
        if (this._destroyed)
            return;
        const actor = this._window?.get_compositor_private();
        this._shown = Boolean(!Main.sessionMode.isLocked && !Main.overview.visible && actor?.mapped &&
            !this._window.minimized && this._window.showing_on_its_workspace() &&
            this._window.located_on_workspace(global.workspace_manager.get_active_workspace()));
        if (!this._shown && this._wanted && this._revealed && !Main.overview.visible) {
            this.hide();
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

    _hideBody() {
        const actor = this._window?.get_compositor_private();
        if (actor && this._managed)
            actor.opacity = 0;
        this._revealed = false;
        this._island.nativeViewport = null;
    }

    _restoreBody() {
        const actor = this._window?.get_compositor_private();
        if (actor && this._managed)
            actor.opacity = 255;
        this._revealed = false;
        this._island.nativeViewport = null;
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
                const target = terminalViewport(rect, area);
                const actor = window.get_compositor_private();
                if (!target || !actor || !this._island.covers(target)) {
                    this._hideBody();
                    return GLib.SOURCE_REMOVE;
                }
                // GTK owns sizing on Wayland. Never send a compositor resize or a transient page allocation.
                const scale = uiScale();
                const width = Math.max(1, Math.floor(target.width / scale));
                const height = Math.max(1, Math.floor(target.height / scale));
                target.width = Math.round(width * scale);
                target.height = Math.round(height * scale);
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
                    this._island.nativeViewport = target;
                    actor.opacity = 255;
                    this._revealed = true;
                    this._endOpening();
                    this._page.setStatus('ready');
                    if (this._focusRequested) {
                        this._focusRequested = false;
                        Main.activateWindow(window);
                    }
                } else {
                    this._hideBody();
                }
            } catch (error) {
                console.warn(`Notchfolk: could not place the terminal page: ${error.message}`);
                this._fail(error.message);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _forgetWindow() {
        this._restoreBody();
        for (const [object, id] of this._windowSignals)
            object.disconnect(id);
        this._windowSignals = [];
        this._window = null;
        this._shown = false;
        this._fitSent = null;
    }

    destroy() {
        const reveal = this._managed && this._identity;
        this._destroyed = true;
        this.disconnectAll();
        if (this._placing)
            GLib.source_remove(this._placing);
        this._endOpening();
        this._cancellable.cancel();
        this._dropActions();
        Gio.bus_unwatch_name(this._watch);
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._forgetWindow();
        // Removing UI never ends a shell or job. Reveal only the authenticated existing primary, no autostart.
        if (reveal) {
            Gio.DBus.session.call(reveal.busName, '/io/galyarderlabs/notchfolk/Terminal',
                'org.freedesktop.Application', 'Activate', new GLib.Variant('(a{sv})', [{}]), null,
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
