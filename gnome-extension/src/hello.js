// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

// The greeting: Apple's "hello" on first load, like unboxing an iPhone or a Mac.
// The word is a drawing, not a font: no Shell extension can load a bundled font
// on every GNOME it runs on (St has no @font-face, fontconfig has no GJS binding,
// and Pango's add_font_file needs Pango 1.55, GNOME 47+, while Notchfolk runs on
// 46 too), so the word is Dancing Script Bold (OFL, see NOTICE-dancing-script.txt)
// drawn as paths into icons/notchfolk-hello.svg.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {onUiScale, px} from './compat.js';

/** The wordmark's width in CSS pixels; its height follows the drawing (1732:824). */
const WORD_WIDTH = 320;
/** Room round the wordmark, as much on every side. */
const PADDING = 20;
/** How the wordmark fades and grows in (ms). */
const INTRO_MS = 450;

/** "hello", centred, fading and growing in as it shows. */
export const HelloView = GObject.registerClass({
}, class HelloView extends St.Widget {
    /** `uri` is the file:// URI of the wordmark drawing. */
    _init(uri) {
        super._init({style_class: 'notchfolk-hello', layout_manager: new Clutter.BinLayout()});
        this._word = new St.Widget({
            style_class: 'notchfolk-hello-word',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const safe = uri.replace(/"/g, '%22');
        this._word.style = `background-image: url("${safe}"); background-size: contain; ` +
            'background-position: center; background-repeat: no-repeat;';
        this._word.set_pivot_point(0.5, 0.5);
        this.add_child(this._word);
        this._syncSize();
        onUiScale(this._word, () => this._syncSize());
        // As it shows, the word fades and grows in; hidden again, it is ready to do so anew.
        this.connect('notify::mapped', () => {
            if (!this.mapped)
                return;
            this._word.remove_all_transitions();
            if (!St.Settings.get().enable_animations) {
                this._word.opacity = 255;
                this._word.scale_x = this._word.scale_y = 1;
                return;
            }
            this._word.opacity = 0;
            this._word.scale_x = this._word.scale_y = 0.94;
            this._word.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: INTRO_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    /** The wordmark's size, in stage pixels. */
    _syncSize() {
        this._word.set_size(px(WORD_WIDTH), px(Math.round(WORD_WIDTH * 824 / 1732)));
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
