// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Vitals page: the machine's own pulse, in the island. The daemon samples the vitals
// every 2 s (CPU, memory, swap, temperature, network, disk - docs/vitals-spec.md) and
// publishes them as the weather is.
//
// The page reads in one glance, left to right: the two numbers that can change what you do
// next (the CPU's load and the temperature) as large figures, then the storage that fills up
// slowly, then what the machine is moving over the network. Nothing is a card inside a card;
// the island's own background is the surface, and a hairline says where one band ends.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import * as Page from './page.js';
import {Ring, label} from '../widgets.js';

/** The temperature's colour: green, amber, red - the one vital that can hurt. */
function tempColor(celsius) {
    if (celsius >= 75)
        return '#ff6961';
    if (celsius >= 60)
        return '#ffb748';
    return '#7dd87d';
}

/** What the temperature's colour means, in words, so the colour is never the only signal. */
function tempBand(celsius) {
    if (celsius <= 0)
        return 'No sensor';
    if (celsius >= 75)
        return 'Running hot';
    if (celsius >= 60)
        return 'Warm';
    return 'Cool';
}

/** A rate in bytes/s, as a human's own words (KB/s, MB/s). */
function rate(bytesPerSecond) {
    if (bytesPerSecond < 1024)
        return `${Math.round(bytesPerSecond)} B/s`;
    if (bytesPerSecond < 1024 * 1024)
        return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

/** A size in bytes, as a human's own words (MB, GB, TB). */
function size(bytes) {
    if (bytes < 1024 ** 3)
        return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    if (bytes < 1024 ** 4)
        return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
}

/** A share of a whole, as a whole percent (0 when the whole is nothing). */
function share(used, total) {
    return total > 0 ? Math.round(used / total * 100) : 0;
}

export const VitalsPage = GObject.registerClass({
}, class VitalsPage extends Page.Page {
    _init(daemon, settings, {height}) {
        super._init(daemon, {
            style_class: 'notchfolk-page notchfolk-vitals',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'vitals';
        this._settings = settings;
        this._vitals = null;
        this._cores = [];
        this._coreSignature = '';

        const column = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-column',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(column);

        // ── The glance: CPU load and temperature, the two that change what you do next ──
        const glance = new St.BoxLayout({style_class: 'notchfolk-vitals-glance', x_expand: true});
        column.add_child(glance);

        const load = new St.BoxLayout({style_class: 'notchfolk-vitals-figure', x_expand: true});
        this._cpuRing = new Ring({size: 52, lineWidth: 4.5});
        this._cpuPercent = label('—', 'notchfolk-vitals-figure-value');
        this._cpuRing.add_child(this._cpuPercent);
        load.add_child(this._cpuRing);
        const loadText = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure-text',
            y_align: Clutter.ActorAlign.CENTER});
        loadText.add_child(label('CPU load', 'notchfolk-vitals-figure-title'));
        this._coresBox = new St.BoxLayout({style_class: 'notchfolk-vitals-cores',
            y_align: Clutter.ActorAlign.CENTER});
        loadText.add_child(this._coresBox);
        load.add_child(loadText);
        glance.add_child(load);

        glance.add_child(new St.Widget({style_class: 'notchfolk-vitals-rule'}));

        const heat = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure-text',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        heat.add_child(label('Temperature', 'notchfolk-vitals-figure-title'));
        this._tempLabel = label('—', 'notchfolk-vitals-temp');
        heat.add_child(this._tempLabel);
        this._tempNote = label('', 'notchfolk-vitals-figure-note');
        heat.add_child(this._tempNote);
        glance.add_child(heat);

        // ── Storage: the three that fill up slowly, one row each ──
        column.add_child(new St.Widget({style_class: 'notchfolk-vitals-hairline'}));
        this._memBar = this._row('Memory', column);
        this._swapBar = this._row('Swap', column);
        this._diskBar = this._row('Disk', column);

        // ── The network, and the battery when the machine has one ──
        column.add_child(new St.Widget({style_class: 'notchfolk-vitals-hairline'}));
        const moving = new St.BoxLayout({style_class: 'notchfolk-vitals-moving', x_expand: true});
        moving.add_child(label('Network', 'notchfolk-vitals-row-name'));
        this._netDown = label('', 'notchfolk-vitals-net');
        this._netUp = label('', 'notchfolk-vitals-net');
        moving.add_child(this._netDown);
        moving.add_child(this._netUp);
        this._battery = label('', 'notchfolk-vitals-battery');
        moving.add_child(this._battery);
        column.add_child(moving);

        this._unit = settings.get_string('vitals-temperature-unit');
        this._unitChanged = settings.connect('changed::vitals-temperature-unit', () => {
            this._unit = settings.get_string('vitals-temperature-unit');
            this._refresh();
        });
        this.connect('destroy', () => settings.disconnect(this._unitChanged));
        this.watch(['vitals', 'system'], () => this._refresh());
        this._refresh();
    }

    /** One storage row: the name, the bar, and the share with the bytes - on one line. */
    _row(name, parent) {
        const box = new St.BoxLayout({style_class: 'notchfolk-vitals-row', x_expand: true});
        box.add_child(label(name, 'notchfolk-vitals-row-name'));
        const fill = new St.Widget({style_class: 'notchfolk-vitals-bar-fill'});
        const track = new St.Widget({style_class: 'notchfolk-vitals-bar-track', x_expand: true});
        track.add_child(fill);
        box.add_child(track);
        const value = label('', 'notchfolk-vitals-row-value', {x_align: Clutter.ActorAlign.END});
        box.add_child(value);
        parent.add_child(box);
        return {value, fill, track, box};
    }

    /** One bar per core, made again only when the machine's core count changes. */
    _syncCores(cores) {
        const signature = cores.length.toString();
        if (signature !== this._coreSignature) {
            this._coreSignature = signature;
            this._coresBox.destroy_all_children();
            this._cores = cores.map(() => {
                const fill = new St.Widget({style_class: 'notchfolk-vitals-core-fill'});
                const track = new St.Widget({style_class: 'notchfolk-vitals-core-track'});
                track.add_child(fill);
                this._coresBox.add_child(track);
                return {fill, track};
            });
        }
        cores.forEach((usage, index) => {
            const core = this._cores[index];
            if (!core)
                return;
            const percent = Math.max(0, Math.min(100, Math.round(usage)));
            core.fill.height = Math.max(1, Math.round(percent / 100 * 20));
            // A core near its ceiling is the one to look at.
            core.fill.style = percent >= 85 ? 'background-color: #ff6961;' : null;
            core.track.tooltip_text = `Core ${index}: ${percent}%`;
        });
    }

    _refresh() {
        const vitals = this.daemon.state?.vitals;
        if (!vitals)
            return;
        this._vitals = vitals;

        this._cpuRing.progress = vitals.cpu_percent / 100;
        this._cpuPercent.text = `${Math.round(vitals.cpu_percent)}%`;

        const celsius = vitals.temperature_c;
        const unit = this._unit === 'F' ? 'F' : 'C';
        const shown = unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
        this._tempLabel.text = celsius > 0 ? `${Math.round(shown)}°${unit}` : '—';
        this._tempLabel.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;
        this._tempNote.text = tempBand(celsius);

        this._syncCores(vitals.cpu_cores ?? []);

        this._setRow(this._memBar, vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._setRow(this._swapBar, vitals.swap_used_bytes, vitals.swap_total_bytes);
        this._swapBar.box.visible = vitals.swap_total_bytes > 0;
        this._setRow(this._diskBar, vitals.disk_used_bytes, vitals.disk_total_bytes);

        this._netDown.text = `↓ ${rate(vitals.network_down_bytes_per_s)}`;
        this._netUp.text = `↑ ${rate(vitals.network_up_bytes_per_s)}`;

        const battery = this.daemon.state?.system?.battery;
        this._battery.text = battery ? `${battery.percent}%${battery.charging ? ' ⚡' : ''}` : '';
        this._battery.visible = Boolean(battery);
    }

    /** One storage row: its share, the bytes, and the fill's width. */
    _setRow(row, used, total) {
        const percent = share(used, total);
        row.value.text = total > 0 ? `${percent}%  ·  ${size(used)} / ${size(total)}` : '—';
        row.fill.width = Math.round(percent);
    }
});
