// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Vitals page: the machine's own pulse, in the island. The daemon samples the vitals
// every 2 s (CPU, memory, swap, temperature, network, disk - the plan: docs/vitals-spec.md)
// and publishes them as the weather is; the page shows them: the CPU ring and the
// temperature at the top (the two that matter at a glance), the memory and disk bars,
// the network's rates, the battery from the state it already publishes.

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

/** A rate in bytes/s, as a human's own words (KB/s, MB/s). */
function rate(bytesPerSecond) {
    if (bytesPerSecond < 1024)
        return `${Math.round(bytesPerSecond)} B/s`;
    if (bytesPerSecond < 1024 * 1024)
        return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

/** A size in bytes, as a human's own words (GB, TB). */
function size(bytes) {
    if (bytes < 1024 ** 3)
        return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    if (bytes < 1024 ** 4)
        return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
}

export const VitalsPage = GObject.registerClass({
}, class VitalsPage extends Page.Page {
    _init(daemon, settings, size) {
        super._init({name: 'vitals', icon: 'notchfolk-vitals-symbolic', label: 'Vitals',
            daemon, settings, size});
        this._vitals = null;

        // Top: the CPU ring (the aggregate, the % in the centre) and the temperature.
        const top = new St.BoxLayout({style_class: 'notchfolk-vitals-top'});
        this._cpuRing = new Ring({size: 64, lineWidth: 5});
        this._cpuPercent = label('', 'notchfolk-vitals-cpu-percent');
        this._cpuRing.add_child(this._cpuPercent);
        top.add_child(this._cpuRing);
        this._tempLabel = label('', 'notchfolk-vitals-temp');
        top.add_child(this._tempLabel);
        this._box.add_child(top);

        // Middle: the memory bar (with swap under it when there is one), the disk bar.
        this._memBar = this._bar('Memory');
        this._swapBar = this._bar('Swap');
        this._diskBar = this._bar('Disk');

        // Bottom: the network's rates, the battery (from the state it already publishes).
        const bottom = new St.BoxLayout({style_class: 'notchfolk-vitals-bottom'});
        this._netDown = label('', 'notchfolk-vitals-net');
        this._netUp = label('', 'notchfolk-vitals-net');
        bottom.add_child(this._netDown);
        bottom.add_child(this._netUp);
        this._battery = label('', 'notchfolk-vitals-battery');
        bottom.add_child(this._battery);
        this._box.add_child(bottom);

        // The daemon's proxy: the vitals arrive as a parsed property in the state,
        // and the page re-reads it every time the daemon publishes a new sample.
        this._vitalsChanged = daemon.connect('changed', (_daemon, key) => {
            if (key === 'vitals')
                this._refresh();
        });
        this._refresh();
    }

    /** A labelled bar: the label left, the value right, the bar under. */
    _bar(name) {
        const box = new St.BoxLayout({style_class: 'notchfolk-vitals-bar-box', ...VERTICAL});
        const header = new St.BoxLayout({style_class: 'notchfolk-vitals-bar-header'});
        header.add_child(label(name, 'notchfolk-vitals-bar-name'));
        const value = label('', 'notchfolk-vitals-bar-value');
        header.add_child(value);
        box.add_child(header);
        const fill = new St.Widget({style_class: 'notchfolk-vitals-bar-fill'});
        const track = new St.Widget({style_class: 'notchfolk-vitals-bar-track'});
        track.add_child(fill);
        box.add_child(track);
        this._box.add_child(box);
        return {value, fill, track, box};
    }

    _refresh() {
        const vitals = this._daemon.state?.vitals;
        if (!vitals)
            return;
        this._vitals = vitals;

        // The CPU ring and its %.
        this._cpuRing.progress = vitals.cpu_percent / 100;
        this._cpuPercent.text = `${Math.round(vitals.cpu_percent)}%`;

        // The temperature, colour-coded.
        this._tempLabel.text = `${Math.round(vitals.temperature_c)}°C`;
        this._tempLabel.style = `color: ${tempColor(vitals.temperature_c)};`;

        // The memory bar (and swap under it when there is one).
        this._setBar(this._memBar, vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._setBar(this._swapBar, vitals.swap_used_bytes, vitals.swap_total_bytes);
        this._swapBar.box.visible = vitals.swap_total_bytes > 0;

        // The disk bar.
        this._setBar(this._diskBar, vitals.disk_used_bytes, vitals.disk_total_bytes);

        // The network's rates.
        this._netDown.text = `↓ ${rate(vitals.network_down_bytes_per_s)}`;
        this._netUp.text = `↑ ${rate(vitals.network_up_bytes_per_s)}`;

        // The battery, from the state it already publishes.
        const battery = this._daemon.state?.system?.battery;
        this._battery.text = battery ? `${battery.percent}% ${battery.charging ? '⚡' : ''}` : '';
        this._battery.visible = Boolean(battery);
    }

    /** One bar: the value (used / total), the fill's width. */
    _setBar(bar, used, total) {
        if (total === 0) {
            bar.value.text = '—';
            bar.fill.width = 0;
            return;
        }
        bar.value.text = `${size(used)} / ${size(total)}`;
        bar.fill.width = Math.round(used / total * 100);
    }
});
