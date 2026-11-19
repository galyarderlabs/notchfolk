// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// St.ImageContent reports only an explicit preferred size (default -1), and
// set_data never sets it — so a preview that decodes and sets its data
// without setting the preferred size paints nothing, with no error and no
// hint. The page must set it from every frame it shows.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('camera preview sets the image preferred size from each frame', () => {
    const source = readFileSync(resolve(root, 'gnome-extension/src/pages/camera.js'), 'utf8');
    assert.ok(source.includes('set_preferred_width(pixbuf.get_width())'),
        'camera.js must set the preferred width from the decoded frame');
    assert.ok(source.includes('set_preferred_height(pixbuf.get_height())'),
        'camera.js must set the preferred height from the decoded frame');
});
