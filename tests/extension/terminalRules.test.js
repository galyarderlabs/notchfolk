// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The terminal page contract: exact GTK ownership, explicit activation and a native card inside its allocation.
// Run with: node --experimental-default-type=module --test tests/extension/terminalRules.test.js
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ownsTerminalWindow, terminalCanOpen, terminalViewport, terminalViewportSettled, TERMINAL_APP_ID} from '../../gnome-extension/src/terminalRules.js';

const owner = {busName: ':1.42', pid: 4200};
const terminal = {appId: TERMINAL_APP_ID, busName: owner.busName, pid: owner.pid};
const workArea = {x: 0, y: 32, width: 1920, height: 1048};

test('terminal ownership needs the exact application id, verified process and unique bus owner', () => {
    assert.equal(ownsTerminalWindow(terminal, owner), true);
    assert.equal(ownsTerminalWindow(terminal, null), false);
    assert.equal(ownsTerminalWindow(terminal, {...owner, pid: 0}), false);
    assert.equal(ownsTerminalWindow({...terminal, appId: null, title: 'Notchfolk terminal'}, owner), false);
    assert.equal(ownsTerminalWindow({...terminal, appId: `${TERMINAL_APP_ID}.Other`}, owner), false);
    assert.equal(ownsTerminalWindow({...terminal, pid: 4201}, owner), false);
    assert.equal(ownsTerminalWindow({...terminal, busName: ':1.43'}, owner), false);
    assert.equal(ownsTerminalWindow({...terminal, busName: null}, owner), false);
});

test('only explicit selection of an active available page may open a shell', () => {
    const selected = {active: true, available: true, explicit: true};
    assert.equal(terminalCanOpen(selected), true);
    assert.equal(terminalCanOpen({...selected, explicit: false}), false);
    assert.equal(terminalCanOpen({...selected, active: false}), false);
    assert.equal(terminalCanOpen({...selected, available: false}), false);
    assert.equal(terminalCanOpen({}), false);
});

test('the helper is never resized to an empty-state or in-flight page allocation', () => {
    const ready = {rect: {x: 238, y: 49, width: 804, height: 240}, position: [238, 49],
        size: {width: 804, height: 240}, morphing: false, opacity: 255};
    assert.equal(terminalViewportSettled(ready), true);
    assert.equal(terminalViewportSettled({...ready, rect: {...ready.rect, width: 239, height: 123}}), false);
    assert.equal(terminalViewportSettled({...ready, morphing: true}), false);
    assert.equal(terminalViewportSettled({...ready, opacity: 254}), false);
    assert.equal(terminalViewportSettled({...ready, position: [238, 45]}), false);
    assert.equal(terminalViewportSettled({...ready, size: {width: 0, height: 240}}), false);
    assert.equal(terminalViewportSettled({...ready, rect: null}), false);
});

test('the native card follows the real page allocation, not a separate header or fixed width', () => {
    const compact = {x: 680, y: 82, width: 560, height: 240};
    const expanded = {x: 520, y: 82, width: 880, height: 480};
    assert.deepEqual(terminalViewport(compact, workArea), compact);
    assert.deepEqual(terminalViewport(expanded, workArea), expanded);
    // A pill's own top inset is part of the page allocation, not overridden by terminal layout.
    assert.deepEqual(terminalViewport({...compact, y: 100}, workArea), {...compact, y: 100});
});

test('negative monitor coordinates and reserved docks keep the card inside usable space', () => {
    const area = {x: -1500, y: 196, width: 1500, height: 1104};
    assert.deepEqual(terminalViewport({x: -1400, y: 220, width: 880, height: 480}, area),
        {x: -1400, y: 220, width: 880, height: 480});
    assert.deepEqual(terminalViewport({x: -1600, y: 180, width: 880, height: 480}, area),
        {x: -1500, y: 196, width: 780, height: 464});
});

test('fractional bounds round inward without moving beyond the page or work area', () => {
    assert.deepEqual(terminalViewport({x: 300.5, y: 80.25, width: 560.25, height: 240.5}, workArea),
        {x: 301, y: 81, width: 559, height: 239});
    assert.deepEqual(terminalViewport({x: 20, y: 80, width: 1000, height: 650},
        {x: 0, y: 32, width: 800, height: 568}), {x: 20, y: 80, width: 780, height: 520});
});

test('unallocated, invalid or wholly off-screen geometry never moves a native window', () => {
    const card = {x: 680, y: 82, width: 560, height: 240};
    assert.equal(terminalViewport(null, workArea), null);
    assert.equal(terminalViewport(card, null), null);
    assert.equal(terminalViewport({...card, width: 0}, workArea), null);
    assert.equal(terminalViewport({...card, height: NaN}, workArea), null);
    assert.equal(terminalViewport({...card, x: Infinity}, workArea), null);
    assert.equal(terminalViewport({...card, y: 1080}, workArea), null);
    assert.equal(terminalViewport(card, {...workArea, width: -1}), null);
});
