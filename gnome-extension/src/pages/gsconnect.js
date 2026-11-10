// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

// Devices: the GSConnect devices paired with this computer — their battery,
// a ring to find them, and the clipboard sent over. No device connected, no
// tab; see docs/gsconnect-plan.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {Ring, icon, label} from '../widgets.js';
import {Page} from './page.js';

/** The battery ring's size (CSS px). */
const RING_SIZE = 38;

// The Phone page: one row per connected device.
export const PhonePage = GObject.registerClass(
class PhonePage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, botGlow, {height}) {
        super._init(daemon, {
            style_class: 'notchfolk-page notchfolk-phone-page',
            layout_manager: new Clutter.BinLayout(),
            height,
            reactive: true,
        });
        this.name = 'devices';
        this._botGlow = botGlow;

        this._box = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-phone-page-list',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._box);

        this.watch(['system'], () => this._sync());
        this._sync();
    }

    /** A tab only while a device is connected; GSConnect gone, none. */
    get available() {
        return !this.hidden && this._devices().length > 0;
    }

    /** Keep the device page's glow in sync with the assistant design selected in Settings. */
    get tint() {
        return this._botGlow();
    }

    /** Use the assistant's moving three-colour aura, rather than a battery-colour wash. */
    get tintStyle() {
        return 'aura';
    }

    /** Whether anything shows. */
    get relevant() {
        return this.available;
    }

    /** Rebuilt on the next showing, so the tab comes and goes with the devices. */
    markCold() {
        super.markCold();
        this.emit('availability-changed');
    }

    _devices() {
        return this.daemon.state.system?.devices ?? [];
    }

    /** Rebuilds the cards if what is on changed, else just their battery status. */
    _sync() {
        const devices = this._devices();
        const key = devices.map(device => device.id).join(',');
        if (key !== this._key) {
            this._key = key;
            this._box.destroy_all_children();
            for (const device of devices)
                this._box.add_child(this._row(device));
            this.emit('availability-changed');
        }
        for (const row of this._box.get_children()) {
            const device = devices.find(device => device.id === row.deviceId);
            if (!device)
                continue;
            row.battery.progress = (device.battery ?? 0) / 100;
            const known = device.battery !== null && device.battery !== undefined;
            row.figure.text = known ? `${device.battery}%` : '';
            row.battery.visible = known;
            row.batteryGroup.visible = known;
            row.charge.text = device.charging ? 'Charging' : 'Not charging';
            row.charge.visible = known;
        }
    }

    /** One device card: connection details, battery state, and clearly labelled actions. */
    _row(device) {
        const row = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-phone-page-card', x_expand: true});
        row.deviceId = device.id;

        const header = new St.BoxLayout({style_class: 'notchfolk-phone-page-header', x_expand: true});
        const glyphName = device.kind?.toLowerCase().includes('tablet') ? 'notchfolk-tablet-symbolic' : 'notchfolk-phone-symbolic';
        const glyph = new St.Bin({style_class: 'notchfolk-phone-page-icon-well',
            child: new St.Icon({gicon: icon(glyphName), icon_size: 20}),
            y_align: Clutter.ActorAlign.CENTER});
        const identity = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-phone-page-identity', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        const name = label(device.name, 'notchfolk-phone-page-name');
        const connection = label('Connected via GSConnect', 'notchfolk-phone-page-connection');
        identity.add_child(name);
        identity.add_child(connection);
        header.add_child(glyph);
        header.add_child(identity);

        const figure = label('', 'notchfolk-phone-page-figure');
        const battery = new Ring({size: RING_SIZE, lineWidth: 3, child: figure});
        battery.y_align = Clutter.ActorAlign.CENTER;
        row.battery = battery;
        row.figure = figure;
        row.charge = label('', 'notchfolk-phone-page-charge');
        const batteryInfo = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-phone-page-battery-info',
            y_align: Clutter.ActorAlign.CENTER});
        batteryInfo.add_child(label('Battery', 'notchfolk-phone-page-battery-caption'));
        batteryInfo.add_child(row.charge);
        const batteryGroup = new St.BoxLayout({style_class: 'notchfolk-phone-page-battery',
            y_align: Clutter.ActorAlign.CENTER});
        row.batteryGroup = batteryGroup;
        batteryGroup.add_child(batteryInfo);
        batteryGroup.add_child(battery);
        header.add_child(batteryGroup);
        row.add_child(header);

        row.add_child(new St.Widget({style_class: 'notchfolk-phone-page-divider', x_expand: true}));

        const actions = new St.BoxLayout({style_class: 'notchfolk-phone-page-actions', x_expand: true});
        actions.add_child(this._action('notchfolk-phone', 'Ring phone', `Ring ${device.name}`,
            () => this.daemon.call('devices', 'Ring', device.id)));
        actions.add_child(this._action('notchfolk-clipboard', 'Send clipboard',
            `Send the clipboard to ${device.name}`,
            () => this.daemon.call('devices', 'SendClipboard', device.id)));
        row.add_child(actions);
        return row;
    }

    _action(iconName, text, accessibleName, onClick) {
        const content = new St.BoxLayout({style_class: 'notchfolk-phone-page-action-content'});
        content.add_child(new St.Icon({gicon: icon(iconName), icon_size: 15}));
        content.add_child(label(text, 'notchfolk-phone-page-action-label'));
        const button = new St.Button({style_class: 'notchfolk-button notchfolk-phone-page-action', child: content,
            can_focus: true, accessible_name: accessibleName, y_align: Clutter.ActorAlign.CENTER});
        button.connect('clicked', onClick);
        return button;
    }

    onActivate() {
        this._sync();
    }
});
