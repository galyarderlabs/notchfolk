// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The extension's Camera1 XML must declare every method the daemon serves:
// a method the daemon has but the XML lacks has no `*Remote` on the proxy,
// so the call throws inside `attempt`, which swallows it into a null result
// and the page goes black with no reason (the live preview shipped that way).

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** `snake_case` to `PascalCase`, the way zbus names the D-Bus method. */
function pascal(name) {
    return name.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('');
}

/** The daemon's Camera1 methods, from the interface impl in camera.rs. */
function daemonMethods() {
    const source = readFileSync(resolve(root, 'crates/notchfolk-daemon/src/camera.rs'), 'utf8');
    const start = source.indexOf('#[interface(name = "io.galyarderlabs.notchfolk.Camera1")]');
    assert.notEqual(start, -1, 'camera.rs has no Camera1 interface impl');
    const end = source.indexOf('pub async fn run(', start);
    const block = end === -1 ? source.slice(start) : source.slice(start, end);
    return [...block.matchAll(/async fn (\w+)\(/g)].map(m => pascal(m[1])).sort();
}

/** The methods the extension's Camera1 XML declares, from daemon.js. */
function xmlMethods() {
    const source = readFileSync(resolve(root, 'gnome-extension/src/daemon.js'), 'utf8');
    const start = source.indexOf("node('Camera1', `");
    assert.notEqual(start, -1, 'daemon.js has no Camera1 XML');
    const end = source.indexOf('`)', start);
    const block = source.slice(start, end);
    assert.ok(block.includes('<property name="State" type="s" access="read"/>'),
        'Camera1 XML must declare the State property');
    return [...block.matchAll(/<method name="(\w+)"/g)].map(m => m[1]).sort();
}

test('Camera1 XML declares every daemon method', () => {
    assert.deepEqual(xmlMethods(), daemonMethods());
});
