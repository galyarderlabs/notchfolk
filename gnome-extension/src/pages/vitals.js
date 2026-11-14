// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Vitals page: the machine's own pulse, in the island. The daemon samples the vitals
// every 2 s (CPU, memory, swap, temperature, network, disk - docs/vitals-spec.md) and
// publishes them as the weather is. The page shows them the way the island's other pages
// do: the two that matter at a glance in a hero on the left, the rest as rows on the right,
// and the CPU's own cores as a bar each, so a single busy core is visible.

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

        const layout = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-layout',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(layout);

        // The two that matter at a glance, side by side: the CPU (its ring, its cores) and the
        // temperature, each in a card of its own as the island's other pages group their facts.
        const hero = new St.BoxLayout({style_class: 'notchfolk-vitals-hero', x_expand: true});
        layout.add_child(hero);

        const cpuCard = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-card', x_expand: true});
        cpuCard.add_child(label('CPU', 'notchfolk-vitals-card-title'));
        const cpuRow = new St.BoxLayout({style_class: 'notchfolk-vitals-hero', x_expand: true});
        this._cpuRing = new Ring({size: 56, lineWidth: 5});
        this._cpuPercent = label('—', 'notchfolk-vitals-cpu-percent');
        this._cpuRing.add_child(this._cpuPercent);
        cpuRow.add_child(this._cpuRing);
        this._coresBox = new St.BoxLayout({style_class: 'notchfolk-vitals-cores',
            y_align: Clutter.ActorAlign.CENTER});
        cpuRow.add_child(this._coresBox);
        cpuCard.add_child(cpuRow);
        hero.add_child(cpuCard);

        const tempCard = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-card', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        tempCard.add_child(label('Temperature', 'notchfolk-vitals-card-title'));
        this._tempLabel = label('—', 'notchfolk-vitals-temp');
        tempCard.add_child(this._tempLabel);
        this._tempNote = label('', 'notchfolk-vitals-card-note');
        tempCard.add_child(this._tempNote);
        hero.add_child(tempCard);

        // The three gauges, a row of their own.
        const gauges = new St.BoxLayout({style_class: 'notchfolk-vitals-gauges', x_expand: true});
        this._memBar = this._bar('Memory', gauges);
        this._swapBar = this._bar('Swap', gauges);
        this._diskBar = this._bar('Disk', gauges);
        layout.add_child(gauges);

        // The network and the battery, one quiet line under them.
        const bottom = new St.BoxLayout({style_class: 'notchfolk-vitals-bottom', x_expand: true});
        this._netDown = label('', 'notchfolk-vitals-net');
        this._netUp = label('', 'notchfolk-vitals-net');
        this._battery = label('', 'notchfolk-vitals-battery');
        bottom.add_child(this._netDown);
        bottom.add_child(this._netUp);
        bottom.add_child(this._battery);
        layout.add_child(bottom);

        this._unit = settings.get_string('vitals-temperature-unit');
        this._unitChanged = settings.connect('changed::vitals-temperature-unit', () => {
            this._unit = settings.get_string('vitals-temperature-unit');
            this._refresh();
        });
        this.connect('destroy', () => settings.disconnect(this._unitChanged));
        this.watch(['vitals', 'system'], () => this._refresh());
        this._refresh();
    }

    /** A gauge: the name, its share, then the bytes under it, and the bar; added to `parent`. */
    _bar(name, parent) {
        const box = new St.BoxLayout({style_class: 'notchfolk-vitals-gauge', ...VERTICAL, x_expand: true});
        box.add_child(label(name, 'notchfolk-vitals-bar-name'));
        const value = label('', 'notchfolk-vitals-bar-value');
        box.add_child(value);
        const detail = label('', 'notchfolk-vitals-bar-detail');
        box.add_child(detail);
        const fill = new St.Widget({style_class: 'notchfolk-vitals-bar-fill'});
        const track = new St.Widget({style_class: 'notchfolk-vitals-bar-track'});
        track.add_child(fill);
        box.add_child(track);
        parent.add_child(box);
        return {value, detail, fill, track, box};
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
            core.fill.height = Math.max(1, Math.round(percent / 100 * 30));
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

        const cpu = Math.round(vitals.cpu_percent);
        this._cpuRing.progress = vitals.cpu_percent / 100;
        this._cpuPercent.text = `${cpu}%`;

        const celsius = vitals.temperature_c;
        const unit = this._unit === 'F' ? 'F' : 'C';
        const shown = unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
        this._tempLabel.text = celsius > 0 ? `${Math.round(shown)}°${unit}` : '—';
        this._tempLabel.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;
        this._tempNote.text = celsius > 0
            ? (celsius >= 75 ? 'Running hot' : celsius >= 60 ? 'Warm' : 'Cool')
            : 'No sensor';

        this._syncCores(vitals.cpu_cores ?? []);

        this._setBar(this._memBar, vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._setBar(this._swapBar, vitals.swap_used_bytes, vitals.swap_total_bytes);
        this._swapBar.box.visible = vitals.swap_total_bytes > 0;
        this._setBar(this._diskBar, vitals.disk_used_bytes, vitals.disk_total_bytes);

        this._netDown.text = `↓ ${rate(vitals.network_down_bytes_per_s)}`;
        this._netUp.text = `↑ ${rate(vitals.network_up_bytes_per_s)}`;

        const battery = this.daemon.state?.system?.battery;
        this._battery.text = battery ? `${battery.percent}%${battery.charging ? ' ⚡' : ''}` : '';
        this._battery.visible = Boolean(battery);
    }

    /** One gauge: its share, the bytes under it, and the fill's width. */
    _setBar(bar, used, total) {
        const percent = share(used, total);
        bar.value.text = total > 0 ? `${percent}%` : '—';
        bar.detail.text = total > 0 ? `${size(used)} of ${size(total)}` : '';
        bar.fill.width = Math.round(percent);
    }
});
