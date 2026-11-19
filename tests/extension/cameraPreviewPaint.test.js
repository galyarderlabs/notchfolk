// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// St.ImageContent reports only an explicit preferred size (default -1), and
// set_data never sets it — so a preview that decodes and sets its data
// without setting the preferred size paints nothing, with no error and no
// hint. The page must set it from every frame it shows, and BEFORE set_data:
// that call is what invalidates the size, so the actor re-reads it then;
// setting it after leaves the actor at 0x0, and a later frame the same size
// invalidates nothing.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('camera preview sets the image preferred size from each frame, before set_data', () => {
    const source = readFileSync(resolve(root, 'gnome-extension/src/pages/camera.js'), 'utf8');
    const widthAt = source.indexOf('set_preferred_width(pixbuf.get_width())');
    const heightAt = source.indexOf('set_preferred_height(pixbuf.get_height())');
    const dataAt = source.indexOf('set_data(');
    assert.ok(widthAt !== -1, 'camera.js must set the preferred width from the decoded frame');
    assert.ok(heightAt !== -1, 'camera.js must set the preferred height from the decoded frame');
    assert.ok(dataAt !== -1, 'camera.js must set the image data');
    assert.ok(widthAt < dataAt && heightAt < dataAt,
        'the preferred size must be set before set_data invalidates it');
});
