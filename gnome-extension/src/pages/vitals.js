// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Vitals page: the machine's own pulse, drawn like the Prayer page - a heading, a
// row that fills the height (the hero card with the CPU ring and the temperature on the
// left, the storage and the network on the right), and the cores as the arc beneath
// the heroes. The daemon samples every 2 s (the plan: docs/vitals-spec.md).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import * as Format from '../format.js';
import {icon, label, Ring} from '../widgets.js';
import {Page} from './page.js';

/** The temperature's colour: green, amber, red - the one vital that can hurt. */
function tempColor(celsius) {
    if (celsius >= 75)
        return '#ff6961';
    if (celsius >= 60)
        return '#ffb748';
    return '#7dd87d';
}

/** The temperature's band, the word for how it feels. */
function tempBand(celsius) {
    if (celsius >= 75)
        return 'Hot';
    if (celsius >= 60)
        return 'Warm';
    if (celsius > 0)
        return 'Cool';
    return '—';
}

/** A rate in bytes/s, as a human's own words. */
function rate(bytesPerSecond) {
    if (bytesPerSecond < 1024)
        return `${Math.round(bytesPerSecond)} B/s`;
    if (bytesPerSecond < 1024 * 1024)
        return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

/** A size in bytes, as a human's own words. */
function size(bytes) {
    if (bytes < 1024 ** 3)
        return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    if (bytes < 1024 ** 4)
        return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
}

/** A share as a whole number, 0-100. */
function share(used, total) {
    if (total <= 0)
        return 0;
    return Math.max(0, Math.min(100, Math.round(used / total * 100)));
}

export const VitalsPage = GObject.registerClass({
}, class VitalsPage extends Page {
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

        this._column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
            style_class: 'notchfolk-vitals-column'});
        this.add_child(this._column);

        // ── The heading, as every page's own: the icon, the title, the date ──
        const heading = new St.BoxLayout({style_class: 'notchfolk-vitals-heading'});
        heading.add_child(new St.Icon({gicon: icon('notchfolk-heartbeat'), icon_size: 15,
            style_class: 'notchfolk-vitals-heading-icon'}));
        heading.add_child(label('Vitals', 'notchfolk-vitals-title', {x_expand: true}));
        heading.add_child(label(Format.longDate(), 'notchfolk-vitals-date'));
        this._column.add_child(heading);

        // ── The row: the hero card on the left, the storage on the right ──
        const row = new St.BoxLayout({style_class: 'notchfolk-vitals-row', x_expand: true, y_expand: true});

        // The hero card: the CPU ring and the temperature, the two that change what
        // you do next, in the glass card the prayer page's own hero uses.
        const hero = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-hero',
            y_align: Clutter.ActorAlign.CENTER});
        const heroTop = new St.BoxLayout({style_class: 'notchfolk-vitals-hero-top'});
        heroTop.add_child(label('THE PULSE', 'notchfolk-vitals-eyebrow'));
        hero.add_child(heroTop);

        // The pulse: the ring and the temperature side by side (the card is wide
        // enough), the cores strip under them - as compact as the prayer's own hero.
        const pulse = new St.BoxLayout({style_class: 'notchfolk-vitals-hero-pulse'});
        const cpuBox = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-hero-cpu',
            y_align: Clutter.ActorAlign.CENTER});
        this._cpuRing = new Ring({size: 44, lineWidth: 4});
        this._cpuPercent = label('—', 'notchfolk-vitals-hero-cpu-value');
        this._cpuRing.add_child(this._cpuPercent);
        cpuBox.add_child(this._cpuRing);
        cpuBox.add_child(label('CPU', 'notchfolk-vitals-hero-label'));
        pulse.add_child(cpuBox);

        pulse.add_child(new St.Widget({style_class: 'notchfolk-vitals-hero-sep'}));

        const heatBox = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-hero-heat',
            y_align: Clutter.ActorAlign.CENTER});
        this._tempLabel = label('—', 'notchfolk-vitals-hero-temp');
        heatBox.add_child(this._tempLabel);
        this._tempNote = label('', 'notchfolk-vitals-hero-band');
        heatBox.add_child(this._tempNote);
        heatBox.add_child(label('Temperature', 'notchfolk-vitals-hero-label'));
        pulse.add_child(heatBox);
        hero.add_child(pulse);

        // The cores: a strip under the pulse, one thin bar per core.
        this._coresBox = new St.BoxLayout({style_class: 'notchfolk-vitals-cores'});
        hero.add_child(this._coresBox);
        row.add_child(hero);

        // The right side: the storage that fills slowly, the network and the battery.
        const data = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
            style_class: 'notchfolk-vitals-data', y_align: Clutter.ActorAlign.CENTER});
        this._memBar = this._storageRow('Memory', data);
        this._swapBar = this._storageRow('Swap', data);
        this._diskBar = this._storageRow('Disk', data);
        data.add_child(new St.Widget({style_class: 'notchfolk-vitals-hairline'}));
        const net = new St.BoxLayout({style_class: 'notchfolk-vitals-net-row'});
        this._netDown = label('', 'notchfolk-vitals-net');
        this._netUp = label('', 'notchfolk-vitals-net');
        net.add_child(this._netDown);
        net.add_child(this._netUp);
        this._battery = label('', 'notchfolk-vitals-battery');
        net.add_child(this._battery);
        data.add_child(net);
        row.add_child(data);
        this._column.add_child(row);

        this._unit = settings.get_string('vitals-temperature-unit');
        this._unitChanged = settings.connect('changed::vitals-temperature-unit', () => {
            this._unit = settings.get_string('vitals-temperature-unit');
            this._refresh();
        });
        this.connect('destroy', () => settings.disconnect(this._unitChanged));
        this.watch(['vitals', 'system'], () => this._refresh());
        this._refresh();
    }

    /** One storage row: the name above, the bar and the value under it. */
    _storageRow(name, parent) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-storage'});
        box.add_child(label(name, 'notchfolk-vitals-storage-name'));
        const fill = new St.Widget({style_class: 'notchfolk-vitals-bar-fill'});
        const track = new St.Widget({style_class: 'notchfolk-vitals-bar-track', x_expand: true});
        track.add_child(fill);
        box.add_child(track);
        const value = label('', 'notchfolk-vitals-storage-value');
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
            core.fill.height = Math.max(1, Math.round(percent / 100 * 14));
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
        this._tempLabel.text = celsius > 0 ? `${Math.round(shown)}°` : '—';
        this._tempLabel.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;
        this._tempNote.text = tempBand(celsius);
        this._tempNote.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;

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

    /** One storage row: its share, the bytes, and the fill's width. A bar that is
     * filling up says so - amber past three quarters, red past nine tenths. */
    _setRow(row, used, total) {
        const percent = share(used, total);
        row.value.text = total > 0 ? `${percent}%  ·  ${size(used)} / ${size(total)}` : '—';
        row.fill.width = Math.round(percent);
        row.fill.style = percent >= 90 ? 'background-color: #ff6961;'
            : percent >= 75 ? 'background-color: #ffb748;' : null;
    }
});
