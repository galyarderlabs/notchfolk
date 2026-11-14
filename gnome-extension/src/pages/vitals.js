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

        const row = new St.BoxLayout({style_class: 'notchfolk-vitals-layout', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this.add_child(row);

        // Left: the CPU ring with its percentage in the middle, the word under it, and the
        // temperature as the one number that can hurt - all in one column, centred on the ring.
        const left = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-left',
            y_align: Clutter.ActorAlign.CENTER});
        this._cpuRing = new Ring({size: 84, lineWidth: 6});
        this._cpuPercent = label('—', 'notchfolk-vitals-cpu-percent');
        this._cpuPercent.x_align = Clutter.ActorAlign.CENTER;
        this._cpuRing.add_child(this._cpuPercent);
        left.add_child(this._cpuRing);
        left.add_child(label('CPU LOAD', 'notchfolk-vitals-caption'));
        const tempRow = new St.BoxLayout({style_class: 'notchfolk-vitals-temp-row',
            x_align: Clutter.ActorAlign.CENTER});
        this._tempLabel = label('—', 'notchfolk-vitals-temp');
        tempRow.add_child(this._tempLabel);
        left.add_child(tempRow);
        row.add_child(left);
        row.add_child(new St.Widget({style_class: 'notchfolk-vitals-divider'}));

        // Right: the cores, then memory, swap, disk, the network and the battery.
        const right = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-right', x_expand: true});
        row.add_child(right);

        // The cores, each a bar of its own: a caption says what the bars are, so a lone tall
        // one reads as a busy core and not as decoration.
        const coresRow = new St.BoxLayout({style_class: 'notchfolk-vitals-cores-row'});
        coresRow.add_child(label('CORES', 'notchfolk-vitals-bar-name'));
        this._coresBox = new St.BoxLayout({style_class: 'notchfolk-vitals-cores'});
        coresRow.add_child(this._coresBox);
        right.add_child(coresRow);

        this._memBar = this._bar('Memory');
        this._swapBar = this._bar('Swap');
        this._diskBar = this._bar('Disk');
        for (const bar of [this._memBar, this._swapBar, this._diskBar])
            right.add_child(bar.box);

        const bottom = new St.BoxLayout({style_class: 'notchfolk-vitals-bottom', x_expand: true});
        this._netDown = label('', 'notchfolk-vitals-net');
        this._netUp = label('', 'notchfolk-vitals-net');
        this._battery = label('', 'notchfolk-vitals-battery');
        bottom.add_child(this._netDown);
        bottom.add_child(this._netUp);
        bottom.add_child(this._battery);
        right.add_child(bottom);

        this._unit = settings.get_string('vitals-temperature-unit');
        this._unitChanged = settings.connect('changed::vitals-temperature-unit', () => {
            this._unit = settings.get_string('vitals-temperature-unit');
            this._refresh();
        });
        this.connect('destroy', () => settings.disconnect(this._unitChanged));
        this.watch(['vitals', 'system'], () => this._refresh());
        this._refresh();
    }

    /** A labelled bar: the name and value on one line, the bar under. */
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
            core.fill.height = Math.max(1, Math.round(percent / 100 * 22));
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

    /** One bar: the value (used / total) and its share, the fill's width. */
    _setBar(bar, used, total) {
        const percent = share(used, total);
        bar.value.text = total > 0 ? `${percent}% · ${size(used)} / ${size(total)}` : '—';
        bar.fill.width = Math.round(percent);
    }
});
