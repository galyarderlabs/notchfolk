// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The normal expanded page owns the shared header and margins; a real GTK/VTE window fills its card.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {onUiScale, px, VERTICAL} from '../compat.js';
import {icon, label, setEnabled, soundOnClick} from '../widgets.js';
import {Page} from './page.js';

const COMPACT_WIDTH = 460;
const COMPACT_HEIGHT = 240;
const EXPANDED_WIDTH = 880;
const EXPANDED_HEIGHT = 480;
const PAGE_TOP = 6;
const PAGE_SIDES = 40;

export const TerminalPage = GObject.registerClass({
    Signals: {
        'open-requested': {},
        'active-changed': {},
        'helper-area-changed': {},
        'height-changed': {},
    },
}, class TerminalPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {height: COMPACT_HEIGHT + PAGE_TOP, style_class: 'notchfolk-page',
            layout_manager: new Clutter.BinLayout()});
        this.name = 'terminal';
        this._baseHeight = height;
        this._bodyWidth = COMPACT_WIDTH;
        this._bodyHeight = COMPACT_HEIGHT;
        this._viewportWidth = 0;
        // Keep native input closed until the helper is ready. The island already paints its
        // complete themed surface behind this page when there is no native viewport.
        this._area = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
            reactive: true});
        this._area.connect('notify::allocation', () => this.emit('helper-area-changed'));
        onUiScale(this._area, scale => (this._area.height = (this._pageHeight - PAGE_TOP) * scale));
        this.add_child(this._area);

        const empty = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-empty',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        empty.add_child(new St.Icon({gicon: icon('notchfolk-terminal'), icon_size: 24,
            style_class: 'notchfolk-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._title = label('Terminal', 'notchfolk-empty-title', {x_align: Clutter.ActorAlign.CENTER});
        this._hint = label('Your shell, here or in an external terminal', 'notchfolk-empty-hint',
            {x_align: Clutter.ActorAlign.CENTER});
        const openContent = new St.BoxLayout({style_class: 'notchfolk-card-button-box'});
        openContent.add_child(new St.Icon({gicon: icon('notchfolk-terminal-symbolic'), icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER}));
        this._openLabel = label('Open terminal', '');
        openContent.add_child(this._openLabel);
        this._open = new St.Button({child: openContent, accessible_name: this._openLabel.text,
            style_class: 'notchfolk-pill notchfolk-pill-small', can_focus: true, x_align: Clutter.ActorAlign.CENTER});
        soundOnClick(this._open, () => this.emit('open-requested'));
        empty.add_child(this._title);
        empty.add_child(this._hint);
        empty.add_child(this._open);
        this._area.add_child(empty);
        this._empty = empty;
    }

    get helperArea() {
        return this._area;
    }

    get helperSize() {
        return {width: this._viewportWidth, height: px(this._pageHeight - PAGE_TOP)};
    }

    /** The controller supplies the final expanded-view width, never a spring's intermediate allocation. */
    setViewportWidth(width) {
        this._viewportWidth = Math.max(1, width - px(PAGE_SIDES));
        this._area.width = this._viewportWidth;
    }

    // The shared Size preference must not crush the native emulator down to a text-only page's height.
    get pageHeight() {
        return this._pageHeight;
    }

    set pageHeight(height) {
        this._baseHeight = height;
        this._syncHeight();
    }

    get preferredWidth() {
        return this._bodyWidth > COMPACT_WIDTH ? px(this._bodyWidth + PAGE_SIDES) : null;
    }

    /** Only the helper's explicit Boolean mode state determines page size; compositor resizes never do. */
    setExpanded(expanded) {
        const oldWidth = this.preferredWidth;
        this._bodyWidth = expanded ? EXPANDED_WIDTH : COMPACT_WIDTH;
        this._bodyHeight = expanded ? EXPANDED_HEIGHT : COMPACT_HEIGHT;
        this._syncHeight();
        if (this.preferredWidth !== oldWidth)
            this.emit('width-changed');
    }

    _syncHeight() {
        const height = Math.max(this._baseHeight ?? 0, this._bodyHeight ?? COMPACT_HEIGHT) + PAGE_TOP;
        if (height === this._pageHeight)
            return;
        this._pageHeight = height;
        this.height = px(height);
        this._area.height = px(height - PAGE_TOP);
        this.emit('height-changed');
    }

    setStatus(state, message = '') {
        const opening = state === 'opening';
        const covered = state === 'covered';
        this._empty.visible = state !== 'ready';
        this._title.text = covered ? 'Terminal is covered' : opening ? 'Opening terminal…' :
            state === 'error' ? 'Terminal unavailable' : 'Terminal';
        this._hint.text = covered ? 'Your shell will reappear when the window moves away.' :
            message || 'Your shell, here or in an external terminal';
        this._openLabel.text = state === 'error' ? 'Try again' : 'Open terminal';
        this._open.accessible_name = this._openLabel.text;
        this._open.visible = !covered;
        setEnabled(this._open, !covered && !opening && state !== 'ready');
    }

    onActivate() {
        this.emit('active-changed');
    }

    onDeactivate() {
        this.emit('active-changed');
    }
});
