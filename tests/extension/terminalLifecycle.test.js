// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TerminalBody, TerminalReturn} from '../../gnome-extension/src/terminalLifecycle.js';

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
