// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The terminal page contract: exact GTK ownership, explicit activation and a native card inside its allocation.
// Run with: node --experimental-default-type=module --test tests/extension/terminalRules.test.js
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ownsTerminalWindow, terminalActorViewport, terminalCanOpen, terminalCanRestore, terminalFitsShape,
    terminalMaterialGeometry, terminalOwnsPointer, terminalViewport, terminalViewportSettled,
    TERMINAL_APP_ID} from '../../gnome-extension/src/terminalRules.js';

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

test('the native card and its own popup hold the island; another window or the desktop does not', () => {
    const popup = {};
    const window = {is_ancestor_of_transient: candidate => candidate === popup};
    const surface = metaWindow => ({get_parent: () => ({meta_window: metaWindow})});
    assert.equal(terminalOwnsPointer(window, surface(window)), true);
    assert.equal(terminalOwnsPointer(window, surface(popup)), true);
    assert.equal(terminalOwnsPointer(window, surface({})), false);
    assert.equal(terminalOwnsPointer(window, {get_parent: () => null}), false);
    assert.equal(terminalOwnsPointer(null, surface(window)), false);
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
    assert.equal(terminalViewportSettled({...ready, rect: {...ready.rect, width: 803.5}, position: [238.5, 49]}), true);
    assert.equal(terminalViewportSettled({...ready, rect: {...ready.rect, width: 803}}), false);
    assert.equal(terminalViewportSettled({...ready, position: [239, 49]}), false);
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

test('passive re-entry needs a remembered live verified primary on the same workspace', () => {
    const returning = {active: true, available: true, managed: true, verified: true, live: true,
        sameWorkspace: true, locked: false, overview: false};
    assert.equal(terminalCanRestore(returning), true);
    for (const key of ['active', 'available', 'managed', 'verified', 'live', 'sameWorkspace'])
        assert.equal(terminalCanRestore({...returning, [key]: false}), false, key);
    for (const key of ['locked', 'overview'])
        assert.equal(terminalCanRestore({...returning, [key]: true}), false, key);
    assert.equal(terminalCanRestore({}), false);
});

test('pill top, bottom and rounded corners are contained, not just their bounding box', () => {
    const pill = {x: 660, y: 40, width: 600, height: 306, radius: 32, crown: 32};
    const card = {x: 680, y: 86, width: 560, height: 240};
    assert.equal(terminalFitsShape(card, pill), true);
    assert.equal(terminalFitsShape({...card, y: 39}, pill), false);
    assert.equal(terminalFitsShape({...card, height: 261}, pill), false);
    // These rectangles pass a bounding-box check but cross the rounded top/bottom silhouette.
    assert.equal(terminalFitsShape({x: 660, y: 40, width: 20, height: 20}, pill), false);
    assert.equal(terminalFitsShape({x: 1240, y: 326, width: 20, height: 20}, pill), false);
    const notch = {...pill, y: 0, height: 306, crown: 0};
    assert.equal(terminalFitsShape({x: 660, y: 0, width: 20, height: 20}, notch), true);
    assert.equal(terminalFitsShape({x: 1240, y: 286, width: 20, height: 20}, notch), false);
});

test('rounded containment follows negative monitors, scale and subpixel placement', () => {
    const shape = {x: -1260.5, y: 240, width: 1200, height: 612, radius: 64, crown: 64};
    assert.equal(terminalFitsShape({x: -1220, y: 332, width: 1120, height: 480}, shape), true);
    assert.equal(terminalFitsShape({x: -1261, y: 400, width: 1120, height: 400}, shape), false);
    assert.equal(terminalFitsShape({x: -1220, y: 332, width: 1120, height: 521}, shape), false);
});

test('GTK logical viewport dimensions round inward at 200 percent and fractional scale', () => {
    const card = {x: 300.5, y: 80.25, width: 560.25, height: 240.5};
    assert.deepEqual(terminalViewport(card, workArea, 2), {x: 301, y: 81, width: 558, height: 238});
    assert.deepEqual(terminalViewport(card, workArea, 1.5), {x: 301, y: 81, width: 558, height: 239});
    assert.equal(terminalViewport({...card, width: 1}, workArea, 2), null);
    assert.equal(terminalViewport(card, workArea, 0), null);
});

test('actual Meta frame excludes GTK shadow buffer at every edge', () => {
    const frame = {x: 680, y: 86, width: 560, height: 240};
    const buffer = {x: 668, y: 74, width: 584, height: 264};
    const geometry = {frame, target: frame, buffer, actor: buffer, width: 584, height: 264};
    assert.deepEqual(terminalActorViewport(geometry), {x: 12, y: 12, width: 560, height: 240});
    // GNOME versions can use scaled actor-local coordinates while Meta remains in stage coordinates.
    assert.deepEqual(terminalActorViewport({...geometry, width: 292, height: 132}),
        {x: 6, y: 6, width: 280, height: 120});
    assert.equal(terminalActorViewport({...geometry, frame: {...frame, height: 300}}), null);
    assert.equal(terminalActorViewport({...geometry, frame: {...frame, width: 640}}), null);
    assert.equal(terminalActorViewport({...geometry, frame: {...frame, y: 74}}), null);
    assert.equal(terminalActorViewport({...geometry, actor: {...buffer, width: 600}}), null);
    assert.equal(terminalActorViewport({...geometry, buffer: {...buffer, height: 200}}), null);
    assert.equal(terminalActorViewport({...geometry, width: 0}), null);
});

test('native glass continues at the same material pixel across a shadowed, scaled viewport', () => {
    // A secondary monitor above and left of the primary; the client starts 24 × 44 stage px into the island.
    const rect = {x: -1190, y: -556, width: 600, height: 240};
    const origin = [-1214, -600], size = [648, 320];
    for (const scale of [1, 1.5, 2]) {
        // 8 actor-local pixels of GTK shadow; 1/2 an actor-local pixel per stage pixel.
        const {frame, source} = terminalMaterialGeometry(rect, [8, 8, 300, 120], scale, origin, size);
        assert.equal(frame.x * scale, 8);
        assert.equal(frame.y * scale, 8);
        for (const [x, y] of [[0, 0], [1, 120], [599, 239]]) {
            const u = (x * frame.width / rect.width - source.x) / source.width;
            const v = (y * frame.height / rect.height - source.y) / source.height;
            assert.ok(Math.abs(u * size[0] - (24 + x)) < 1e-9);
            assert.ok(Math.abs(v * size[1] - (44 + y)) < 1e-9);
        }
    }
});
