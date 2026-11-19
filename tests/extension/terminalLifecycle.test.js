// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TerminalBody, TerminalReturn, TerminalStack} from '../../gnome-extension/src/terminalLifecycle.js';

const origin = {}, otherWorkspace = {};
const returning = {active: true, available: true, managed: true, owner: ':1.42',
    identity: {busName: ':1.42', pid: 4200}, workspace: origin, locked: false, overview: false, mapped: false};

for (const early of [false, true]) {
    test(`leave before first map, re-enter ${early ? 'before' : 'after'} the verified window maps`, () => {
        const state = new TerminalReturn();
        state.open(origin);
        state.leave(true, null, null, 1);
        if (early)
            assert.equal(state.canRestore(returning), false); // no proven existing GTK window yet
        assert.equal(state.mapped(returning.owner), true); // owe this map one hide
        assert.equal(state.mapped(returning.owner), false);
        assert.equal(state.canRestore({...returning, active: early, mapped: true}), false);
        assert.equal(state.canRestore({...returning, workspace: otherWorkspace}), false);
        assert.equal(state.canRestore(returning), true);
        assert.equal(state.canRestore({...returning, owner: ':1.43', identity: {busName: ':1.43', pid: 4300}}), false);
    });
}

test('a lock before a late map still owes a hide but never grants a return; lost owners owe neither', () => {
    const state = new TerminalReturn();
    state.open(origin);
    state.leave(true, null, null, 1);
    state.revoke();
    assert.equal(state.mapped(returning.owner), true);
    assert.equal(state.canRestore(returning), false);
    state.open(origin);
    state.leave(true, null, null, 2);
    state.open(null); // owner vanished / verification or launch failed
    assert.equal(state.mapped(returning.owner), false);
    assert.equal(state.canRestore(returning), false);
});

function stackWindow(above = false) {
    return {
        above, raises: 0, releases: 0, actor: {mapped: true, get_paint_opacity: () => 255},
        is_above() { return this.above; },
        make_above() { assert.equal(this.above, false); this.above = true; this.raises++; },
        unmake_above() { assert.equal(this.above, true); this.above = false; this.releases++; },
        get_compositor_private() { return this.actor; },
        get_pid: () => 4200,
        is_ancestor_of_transient: other => other.parent === true,
    };
}

function observed() {
    const signals = new Map();
    return {signals,
        connectObject(...args) {
            for (let i = 0; i < args.length - 1; i += 2) {
                assert.ok(!signals.has(args[i]));
                signals.set(args[i], args[i + 1]);
            }
        },
        disconnectObject() { assert.ok(signals.size); signals.clear(); }};
}

function competitor(x, y, width, height, metaWindow = {}) {
    Object.assign(metaWindow, observed());
    const actor = {...observed(), x, y, width, height, meta_window: metaWindow, mapped: true,
        get_paint_box() {
            return [true, {x1: this.x, y1: this.y, x2: this.x + this.width, y2: this.y + this.height}];
        }};
    metaWindow.get_compositor_private = () => actor;
    metaWindow.get_frame_rect = () => actor;
    return actor;
}

test('raise once without focus; return just our above flag on release or live primary replacement', () => {
    const stack = new TerminalStack(() => {});
    const first = stackWindow(), alreadyAbove = stackWindow(true);
    stack.hold(first);
    stack.hold(first); // our own restack, another app focusing, or a pinned workspace transition
    assert.equal(first.raises, 1);
    stack.hold(alreadyAbove);
    assert.equal(first.above, false);
    assert.equal(first.releases, 1);
    stack.release();
    assert.equal(alreadyAbove.above, true);
    assert.equal(alreadyAbove.releases, 0);
    stack.hold(first); // re-entry is a new lease
    stack.release();
    stack.release();
    assert.equal(first.above, false);
    assert.equal(first.releases, 2);
    stack.hold(first);
    stack.release({unmanaged: true}); // never operate on a retiring window
    assert.equal(first.releases, 2);
});

const card = {x: 100, y: 100, width: 400, height: 240};

test('a higher window moving into a single edge seals the whole card; moving away restores it without a restack', () => {
    const window = stackWindow();
    const below = competitor(100, 100, 400, 240), above = competitor(500, 148, 20, 2);
    const siblings = [below, window.actor, above];
    let open;
    const check = () => (open = stack.uncovered(window.actor, card, siblings, []));
    const stack = new TerminalStack(check);
    stack.hold(window);
    assert.equal(check(), true);
    assert.equal(below.signals.size, 0);
    above.x--;
    above.signals.get('notify')();
    assert.equal(open, false);
    above.mapped = false;
    above.signals.get('notify')();
    assert.equal(open, true);
    above.mapped = true;
    above.signals.get('notify')();
    assert.equal(open, false);
    above.x++;
    above.signals.get('notify')();
    assert.equal(open, true);
    above.meta_window.get_frame_rect = () => ({...card, width: 1});
    above.meta_window.signals.get('position-changed')();
    assert.equal(open, false); // compositor input already moved; the painting animation hasn't
    above.meta_window.get_frame_rect = () => above;
    siblings.reverse();
    assert.equal(check(), false);
    assert.equal(above.signals.size, 0);
    stack.release();
    assert.equal(below.signals.size, 0);
});

test('a real helper popup is allowed, not another application or an unrelated window of the same process', () => {
    const window = stackWindow();
    const stack = new TerminalStack(() => {});
    stack.hold(window);
    const other = {parent: true, get_pid: () => 4200};
    const popup = competitor(141, 131, 24, 20, other);
    const check = () => stack.uncovered(window.actor, card, [window.actor], [popup]);
    assert.equal(check(), true);
    other.get_pid = () => 4201;
    assert.equal(check(), false);
    other.get_pid = () => 4200;
    other.parent = false;
    assert.equal(check(), false);
    popup.x = NaN;
    assert.equal(check(), false); // unknown is not evidence of safety
    popup.signals.get('destroy')();
    popup.disconnectObject = () => assert.fail('touched retired popup');
    stack.release();
});

test('no hole for an absent, unmapped, fading or replaced primary, even on a bare desktop', () => {
    const window = stackWindow();
    const stack = new TerminalStack(() => {});
    stack.hold(window);
    const {actor} = window;
    assert.equal(stack.uncovered(actor, card, [], []), false);
    actor.mapped = false;
    assert.equal(stack.uncovered(actor, card, [actor], []), false);
    actor.mapped = true;
    actor.get_paint_opacity = () => 254;
    assert.equal(stack.uncovered(actor, card, [actor], []), false);
    window.actor = {};
    actor.get_paint_opacity = () => assert.fail('queried the replaced primary');
    assert.equal(stack.uncovered(actor, card, [actor], []), false);
    stack.release();
});

const clip = {x: 4, y: 8, width: 460, height: 240};

// Model only the actor API we own. Revoking its JS wrapper makes *any* later property or method access throw.
function surface(previousClip = null) {
    const signals = new Map();
    let connectedTo;
    const native = {mapped: true, opacity: 219, clip: previousClip,
        get 'has-clip'() { return this.clip !== null; },
        get_clip() { return this.clip; },
        set_clip(...rect) { this.clip = rect; },
        remove_clip() { this.clip = null; },
        is_destroyed() { return false; },
        connectObject(...args) {
            connectedTo = args.pop();
            for (let i = 0; i < args.length; i += 2)
                signals.set(args[i], args[i + 1]);
        },
        disconnectObject(owner) {
            assert.equal(owner, connectedTo);
            signals.clear();
        }};
    const {proxy: actor, revoke} = Proxy.revocable(native, {});
    const window = {current: actor, get_compositor_private() { return this.current; }};
    let notifications = 0;
    const body = new TerminalBody(window, actor, destroyed => {
        assert.equal(destroyed.actor, null); // forgotten before notifying the controller
        destroyed.release();
    }, () => ++notifications, () => ++notifications);
    return {body, actor, window, signals, revoke, notifications: () => notifications};
}

test('a settled map transform requests placement again without an allocation or another page event', () => {
    const {body, actor, signals, notifications} = surface();
    body.hide();
    signals.get('effects-completed')();
    assert.equal(notifications(), 1);
    assert.deepEqual(actor.clip, [0, 0, 0, 0]); // the notification alone must not reveal an unchecked frame
});

test('actor destroy before workspace-changed/unmanaged drops clip and signal ownership synchronously', () => {
    const {body, revoke, signals} = surface();
    body.hide();
    body.reveal(clip);
    const destroyed = signals.get('destroy');
    revoke();
    destroyed();
    assert.equal(body.actor, null);
    body.hide();
    assert.equal(body.reveal(clip), false);
    body.release();
    body.release({forget: true, detach: true});
});

test('a queued or replaced compositor actor is never queried, even before its destroy signal', () => {
    const {body, window, revoke, signals, notifications} = surface();
    body.hide();
    body.reveal(clip);
    window.current = null; // Mutter clears compositor_private when queueing destruction
    revoke();
    signals.get('notify::mapped')();
    assert.equal(body.actor, null);
    body.release();
    window.current = {}; // the new actor must not inherit the old clip or opacity
    body.release({forget: true});
    signals.get('notify::allocation')();
    signals.get('effects-completed')();
    assert.equal(notifications(), 0);
    assert.deepEqual(window.current, {});
});

test('hide reply before unmap and adoption never expose the outgoing frame', () => {
    const {actor, body, signals} = surface();
    body.reveal(clip);
    body.hide();
    actor.opacity = 255; // Shell's map animation can finish after Notchfolk conceals the surface
    body.release();
    assert.deepEqual(actor.clip, [0, 0, 0, 0]);
    body.release({forget: true});
    assert.deepEqual(actor.clip, [0, 0, 0, 0]);
    assert.equal(signals.size, 0);
});

for (const detach of [false, true]) {
    test(`${detach ? 'disable with live actor' : 'actual unmap'} restores the prior clip without changing opacity`, () => {
        for (const previous of [null, [1, 2, 700, 300]]) {
            const {actor, body, signals} = surface(previous);
            body.hide();
            body.reveal(clip);
            body.hide();
            actor.mapped = detach;
            body.release({forget: detach, detach});
            assert.deepEqual(actor.clip, previous);
            assert.equal(actor.opacity, 219);
            if (detach)
                assert.equal(signals.size, 0);
        }
    });
}
