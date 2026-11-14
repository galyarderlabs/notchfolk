// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Vitals page: the machine's own pulse, in the island. The daemon samples the vitals
// every 2 s (CPU, memory, swap, temperature, network, disk - docs/vitals-spec.md) and
// publishes them as the weather is.
//
// One page, no tabs: everything the daemon samples is on it at once, in the order a person
// looks at a machine. The two numbers that change what you do next (the load and the
// temperature) are the big ones; the trend of each is drawn under it; the storage that fills
// slowly is a row each; the network, the battery and the uptime close the page. Nothing is
// hidden behind a mode switch - a system monitor that hides half its numbers is a worse one.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import {Page} from './page.js';
import {label} from '../widgets.js';

/** How many samples a sparkline keeps: a minute at the daemon's 2 s. */
const SPARK_POINTS = 30;

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

/** An uptime in seconds, as "3d 4h 12m" (the days only when there are any). */
function uptimeText(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `Up ${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m`;
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
        this._cpuHistory = [];
        this._downHistory = [];
        this._upHistory = [];
        this._cores = [];
        this._coreSignature = '';

        const column = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-column',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(column);

        // ── The two that matter at a glance, each with its own trend ──
        const glance = new St.BoxLayout({style_class: 'notchfolk-vitals-glance', x_expand: true});
        column.add_child(glance);

        const load = this._figure(glance, 'CPU load');
        this._cpuValue = load.value;
        this._spark = this._sparkline(load.box, this._cpuHistory);
        glance.add_child(new St.Widget({style_class: 'notchfolk-vitals-divider'}));

        const heat = this._figure(glance, 'Temperature');
        this._tempValue = heat.value;
        this._tempNote = heat.note;

        // ── The cores, a bar each: one busy core is visible ──
        const coresRow = new St.BoxLayout({style_class: 'notchfolk-vitals-cores-row', x_expand: true});
        coresRow.add_child(label('Cores', 'notchfolk-vitals-row-name'));
        this._coresBox = new St.BoxLayout({style_class: 'notchfolk-vitals-cores'});
        coresRow.add_child(this._coresBox);
        this._freqNote = label('', 'notchfolk-vitals-cores-note');
        coresRow.add_child(this._freqNote);
        column.add_child(coresRow);

        // ── The storage that fills slowly, a row each ──
        column.add_child(new St.Widget({style_class: 'notchfolk-vitals-hairline'}));
        this._memBar = this._storageRow('Memory', column);
        this._swapBar = this._storageRow('Swap', column);
        this._diskBar = this._storageRow('Disk', column);

        // ── What the machine is moving, and how long it has been up ──
        column.add_child(new St.Widget({style_class: 'notchfolk-vitals-hairline'}));
        const moving = new St.BoxLayout({style_class: 'notchfolk-vitals-moving', x_expand: true});
        moving.add_child(label('Network', 'notchfolk-vitals-row-name'));
        this._netDown = label('', 'notchfolk-vitals-net');
        this._netUp = label('', 'notchfolk-vitals-net');
        moving.add_child(this._netDown);
        moving.add_child(this._netUp);
        this._battery = label('', 'notchfolk-vitals-battery');
        moving.add_child(this._battery);
        this._uptime = label('', 'notchfolk-vitals-uptime');
        moving.add_child(this._uptime);
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

    /** A big figure with its title, and a line under it for a word about it. */
    _figure(parent, title) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure', x_expand: true});
        const value = label('—', 'notchfolk-vitals-figure-value');
        box.add_child(value);
        box.add_child(label(title, 'notchfolk-vitals-figure-name'));
        const note = label('', 'notchfolk-vitals-figure-note');
        box.add_child(note);
        parent.add_child(box);
        return {box, value, note};
    }

    /** A sparkline of `history`, drawn again as the samples come. */
    _sparkline(parent, history) {
        const area = new St.DrawingArea({style_class: 'notchfolk-vitals-spark', x_expand: true});
        area.connect('repaint', target => this._paintSpark(target, history));
        parent.add_child(area);
        return area;
    }

    /** One storage row: the name, the bar, and the share with the bytes. */
    _storageRow(name, parent) {
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
            core.fill.height = Math.max(1, Math.round(percent / 100 * 18));
            // A core near its ceiling is the one to look at.
            core.fill.style = percent >= 85 ? 'background-color: #ff6961;' : null;
            core.track.tooltip_text = `Core ${index}: ${percent}%`;
        });
    }

    /** The last minute of `history` as a line, filled under it. */
    _paintSpark(area, history) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0 || history.length < 2) {
            cr.$dispose();
            return;
        }
        const points = history.slice(-SPARK_POINTS);
        const x = index => width * index / (points.length - 1);
        const top = px(2);
        const bottom = height - px(2);
        const max = Math.max(...points, 1);
        const y = value => bottom - (bottom - top) * (value / max);

        cr.setLineCap(1);
        cr.setLineJoin(1);
        cr.moveTo(x(0), y(points[0]));
        for (let index = 1; index < points.length; index++)
            cr.lineTo(x(index), y(points[index]));
        cr.lineTo(width, bottom);
        cr.lineTo(0, bottom);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, top, 0, bottom);
        fill.addColorStopRGBA(0, 1, 0.81, 0.36, 0.22);
        fill.addColorStopRGBA(1, 1, 0.81, 0.36, 0);
        cr.setSource(fill);
        cr.fill();

        cr.moveTo(x(0), y(points[0]));
        for (let index = 1; index < points.length; index++)
            cr.lineTo(x(index), y(points[index]));
        cr.setSourceRGBA(1, 0.81, 0.36, 0.9);
        cr.setLineWidth(1.5);
        cr.stroke();
        cr.$dispose();
    }

    _refresh() {
        const vitals = this.daemon.state?.vitals;
        if (!vitals)
            return;

        this._cpuValue.text = `${Math.round(vitals.cpu_percent)}%`;
        this._cpuHistory.push(vitals.cpu_percent);
        if (this._cpuHistory.length > SPARK_POINTS)
            this._cpuHistory.shift();
        this._spark.queue_repaint();

        const celsius = vitals.temperature_c;
        const unit = this._unit === 'F' ? 'F' : 'C';
        const shown = unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
        this._tempValue.text = celsius > 0 ? `${Math.round(shown)}°` : '—';
        this._tempValue.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;
        this._tempNote.text = tempBand(celsius);
        this._tempNote.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;

        this._syncCores(vitals.cpu_cores ?? []);
        this._freqNote.text = vitals.cpu_frequency_mhz > 0
            ? `${(vitals.cpu_frequency_mhz / 1000).toFixed(2)} GHz` : '';

        this._setRow(this._memBar, vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._setRow(this._swapBar, vitals.swap_used_bytes, vitals.swap_total_bytes);
        this._swapBar.box.visible = vitals.swap_total_bytes > 0;
        this._setRow(this._diskBar, vitals.disk_used_bytes, vitals.disk_total_bytes);

        const down = vitals.network_down_bytes_per_s;
        const up = vitals.network_up_bytes_per_s;
        this._downHistory.push(down);
        this._upHistory.push(up);
        if (this._downHistory.length > SPARK_POINTS)
            this._downHistory.shift();
        if (this._upHistory.length > SPARK_POINTS)
            this._upHistory.shift();
        this._netDown.text = `↓ ${rate(down)}`;
        this._netUp.text = `↑ ${rate(up)}`;

        const battery = this.daemon.state?.system?.battery;
        this._battery.text = battery ? `${battery.percent}%${battery.charging ? ' ⚡' : ''}` : '';
        this._battery.visible = Boolean(battery);

        this._uptime.text = uptimeText(vitals.uptime_seconds ?? 0);
    }

    /** One storage row: its share, the bytes, and the fill's width. */
    _setRow(row, used, total) {
        const percent = share(used, total);
        row.value.text = total > 0 ? `${percent}%  ·  ${size(used)} / ${size(total)}` : '—';
        row.fill.width = Math.round(percent);
    }
});
