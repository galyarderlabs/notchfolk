// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

// The greeting: Apple's "hello" on first load, like unboxing an iPhone or a Mac.
// The word is a drawing, not a font: no Shell extension can load a bundled font
// on every GNOME it runs on (St has no @font-face, fontconfig has no GJS binding,
// and Pango's add_font_file needs Pango 1.55, GNOME 47+, while Notchfolk runs on
// 46 too), so the word is Dancing Script Bold (OFL, see NOTICE-dancing-script.txt)
// drawn as paths into icons/notchfolk-hello.svg — one file per letter
// (notchfolk-hello-h.svg, -e.svg, -ll.svg, -o.svg), each with the same viewBox,
// so the four letters stacked on top of each other spell the word exactly.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {onUiScale, px} from './compat.js';

/** The wordmark's width in CSS pixels; its height follows the drawing (1732:824). */
const WORD_WIDTH = 200;
/** Room round the wordmark, as much on every side. */
const PADDING = 20;
/** How one letter fades and grows in (ms). */
const LETTER_MS = 350;
/** How long after the previous letter the next one starts (ms). */
const LETTER_STAGGER_MS = 130;
/** The letters of the word, left to right; "ll" is one cursive stroke. */
const LETTERS = ['h', 'e', 'll', 'o'];

/** "hello", centred, its letters fading and growing in one by one as it shows. */
export const HelloView = GObject.registerClass({
}, class HelloView extends St.Widget {
    /** `uri` is the file:// URI of the whole-word drawing; the letters live beside it. */
    _init(uri) {
        super._init({style_class: 'notchfolk-hello', layout_manager: new Clutter.BinLayout()});
        const dir = uri.slice(0, uri.lastIndexOf('/') + 1);
        this._letters = LETTERS.map(letter => {
            const word = new St.Widget({
                style_class: 'notchfolk-hello-word',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const safe = `${dir}notchfolk-hello-${letter}.svg`.replace(/"/g, '%22');
            word.style = `background-image: url("${safe}"); background-size: contain; ` +
                'background-position: center; background-repeat: no-repeat;';
            word.set_pivot_point(0.5, 0.5);
            this.add_child(word);
            return word;
        });
        this._syncSize();
        onUiScale(this, () => this._syncSize());
        // As it shows, the letters fade and grow in one by one, left to right;
        // hidden again, they are ready to do so anew.
        this.connect('notify::mapped', () => {
            if (!this.mapped)
                return;
            const animate = St.Settings.get().enable_animations;
            this._letters.forEach((word, i) => {
                word.remove_all_transitions();
                if (!animate) {
                    word.opacity = 255;
                    word.scale_x = word.scale_y = 1;
                    return;
                }
                word.opacity = 0;
                word.scale_x = word.scale_y = 0.94;
                word.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: LETTER_MS,
                    delay: i * LETTER_STAGGER_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            });
        });
    }

    /** The letters' size, in stage pixels. */
    _syncSize() {
        const width = px(WORD_WIDTH);
        const height = px(Math.round(WORD_WIDTH * 824 / 1732));
        for (const word of this._letters)
            word.set_size(width, height);
    }

    /** The width the island should have for the greeting. */
    get preferredWidth() {
        return px(WORD_WIDTH + 2 * PADDING);
    }

    /** The height below the top bar the greeting needs. */
    get preferredHeight() {
        return px(Math.round(WORD_WIDTH * 824 / 1732) + 2 * PADDING);
    }
});
