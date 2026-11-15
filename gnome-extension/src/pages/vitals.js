// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Vitals page: the machine's own pulse, every vital on it at once. The page grows
// for its content as the Weather page does (the base height every page gets is too
// small for fourteen numbers); the daemon samples every 2 s and the page fills:
// the two that change what you do next (the load and the temperature) big with the
// sparkline between them, the cores and the machine's own numbers, the storage that
// fills slowly, the network, battery and uptime.

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

/** The temperature's band, in words, so the colour is never the only signal. */
function tempBand(celsius) {
    if (celsius <= 0)
        return 'No sensor';
    if (celsius >= 75)
        return 'Hot';
    if (celsius >= 60)
        return 'Warm';
    return 'Cool';
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

/** A share of a whole, as a whole percent. */
function share(used, total) {
    return total > 0 ? Math.round(used / total * 100) : 0;
}

/** An uptime in seconds, as "2d 5h 34m". */
function uptimeText(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m`;
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
        // The growth fires at build time too, not only when Large toggles.
        this.onPageHeight(height);
        // A little taller than the base: the footer was cut off at the base height.
        this.pageHeight = height + 40;
        this._settings = settings;
        this._cpuHistory = [];
        this._cores = [];
        this._coreSignature = '';

        const column = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-column',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(column);

        // ── The pulse: the load big left, the sparkline across, the temperature big right ──
        const pulse = new St.BoxLayout({style_class: 'notchfolk-vitals-pulse', x_expand: true});
        const loadFig = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure'});
        this._cpuValue = label('\u2014', 'notchfolk-vitals-figure-value');
        loadFig.add_child(this._cpuValue);
        loadFig.add_child(label('CPU load', 'notchfolk-vitals-figure-name'));
        pulse.add_child(loadFig);

        this._spark = new St.DrawingArea({style_class: 'notchfolk-vitals-spark', x_expand: true});
        this._spark.connect('repaint', area => this._paintSpark(area));
        pulse.add_child(this._spark);

        const heatFig = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure'});
        this._tempValue = label('\u2014', 'notchfolk-vitals-figure-value notchfolk-vitals-temp');
        heatFig.add_child(this._tempValue);
        this._tempNote = label('', 'notchfolk-vitals-figure-note');
        heatFig.add_child(this._tempNote);
        heatFig.add_child(label('Temperature', 'notchfolk-vitals-figure-name'));
        pulse.add_child(heatFig);
        column.add_child(pulse);

        // ── The cores and the machine's own numbers, one row each ──
        const coresRow = new St.BoxLayout({style_class: 'notchfolk-vitals-info-row', x_expand: true});
        coresRow.add_child(label('Cores', 'notchfolk-vitals-info-name'));
        this._coresBox = new St.BoxLayout({style_class: 'notchfolk-vitals-cores'});
        coresRow.add_child(this._coresBox);
        this._freqNote = label('', 'notchfolk-vitals-info-value');
        coresRow.add_child(this._freqNote);
        column.add_child(coresRow);

        const loadRow = new St.BoxLayout({style_class: 'notchfolk-vitals-info-row', x_expand: true});
        loadRow.add_child(label('Load', 'notchfolk-vitals-info-name'));
        this._loadNote = label('', 'notchfolk-vitals-info-value');
        loadRow.add_child(this._loadNote);
        this._procNote = label('', 'notchfolk-vitals-info-proc');
        loadRow.add_child(this._procNote);
        column.add_child(loadRow);

        // ── The storage that fills slowly, a row each ──
        column.add_child(new St.Widget({style_class: 'notchfolk-vitals-hairline'}));
        this._memBar = this._storageRow('Memory', column);
        this._swapBar = this._storageRow('Swap', column);
        this._diskBar = this._storageRow('Disk', column);

        // ── The footer: the network, the battery, the uptime ──
        column.add_child(new St.Widget({style_class: 'notchfolk-vitals-hairline'}));
        const footer = new St.BoxLayout({style_class: 'notchfolk-vitals-footer', x_expand: true});
        this._netDown = label('', 'notchfolk-vitals-footer-value');
        footer.add_child(this._netDown);
        this._netUp = label('', 'notchfolk-vitals-footer-value');
        footer.add_child(this._netUp);
        this._battery = label('', 'notchfolk-vitals-footer-value');
        footer.add_child(this._battery);
        this._uptime = label('', 'notchfolk-vitals-footer-value');
        footer.add_child(this._uptime);
        column.add_child(footer);

        this._unit = settings.get_string('vitals-temperature-unit');
        this._unitChanged = settings.connect('changed::vitals-temperature-unit', () => {
            this._unit = settings.get_string('vitals-temperature-unit');
            this._refresh();
        });
        this.connect('destroy', () => settings.disconnect(this._unitChanged));
        this.watch(['vitals', 'system'], () => this._refresh());
        this._refresh();
    }
    /** The page grows a little above the base (the footer was cut off at it);
     * only the base heights (150, 210) trigger the growth, so it never loops. */
    onPageHeight(height) {
        if (height !== PAGE_HEIGHT && height !== LARGE_PAGE_HEIGHT)
            return;
        this.pageHeight = height + 40;
    }

    _storageRow(name, parent) {
        const box = new St.BoxLayout({style_class: 'notchfolk-vitals-storage', x_expand: true});
        box.add_child(label(name, 'notchfolk-vitals-storage-name'));
        const fill = new St.Widget({style_class: 'notchfolk-vitals-bar-fill'});
        const track = new St.Widget({style_class: 'notchfolk-vitals-bar-track', x_expand: true});
        track.add_child(fill);
        box.add_child(track);
        const value = label('', 'notchfolk-vitals-storage-value', {x_align: Clutter.ActorAlign.END});
        box.add_child(value);
        parent.add_child(box);
        return {value, fill, track, box};
    }

    /** The sparkline: the last minute of CPU, a smooth line with a warm gradient under. */
    _paintSpark(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0 || this._cpuHistory.length < 2) {
            cr.$dispose();
            return;
        }
        const points = this._cpuHistory.slice(-SPARK_POINTS);
        const x = i => width * i / (points.length - 1);
        const top = px(2);
        const bottom = height - px(2);
        // The scale is the CPU's own 0-100: an idle CPU reads as the quiet it is.
        const y = value => bottom - (bottom - top) * (value / 100);
        cr.setLineCap(1);
        cr.setLineJoin(1);
        const draw = () => {
            cr.moveTo(x(0), y(points[0]));
            for (let i = 1; i < points.length; i++)
                cr.lineTo(x(i), y(points[i]));
        };
        draw();
        cr.lineTo(x(points.length - 1), bottom);
        cr.lineTo(x(0), bottom);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, top, 0, bottom);
        fill.addColorStopRGBA(0, 1, 0.81, 0.36, 0.22);
        fill.addColorStopRGBA(1, 1, 0.81, 0.36, 0);
        cr.setSource(fill);
        cr.fill();
        draw();
        cr.setSourceRGBA(1, 0.81, 0.36, 0.9);
        cr.setLineWidth(1.5);
        cr.stroke();
        cr.$dispose();
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
            core.fill.style = percent >= 85 ? 'background-color: #ff6961;' : null;
            core.track.tooltip_text = `Core ${index}: ${percent}%`;
        });
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
        this._tempValue.text = celsius > 0 ? `${Math.round(shown)}\u00b0${unit}` : '\u2014';
        this._tempValue.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;
        this._tempNote.text = tempBand(celsius);
        this._tempNote.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;

        this._syncCores(vitals.cpu_cores ?? []);
        this._freqNote.text = vitals.cpu_frequency_mhz > 0
            ? `${(vitals.cpu_frequency_mhz / 1000).toFixed(2)} GHz` : '\u2014';
        this._loadNote.text = `${(vitals.load_1 ?? 0).toFixed(2)} \u00b7 ${(vitals.load_5 ?? 0).toFixed(2)} \u00b7 ${(vitals.load_15 ?? 0).toFixed(2)}`;
                this._procNote.text = ` \u00b7 ${vitals.process_count ?? 0} proc`;

        this._setRow(this._memBar, vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._setRow(this._swapBar, vitals.swap_used_bytes, vitals.swap_total_bytes);
        this._swapBar.box.visible = vitals.swap_total_bytes > 0;
        this._setRow(this._diskBar, vitals.disk_used_bytes, vitals.disk_total_bytes);

        this._netDown.text = `\u2193 ${rate(vitals.network_down_bytes_per_s)}`;
        this._netUp.text = `\u2191 ${rate(vitals.network_up_bytes_per_s)}`;
        const battery = this.daemon.state?.system?.battery;
        this._battery.text = battery ? `\u26a1 ${battery.percent}%` : '';
        this._battery.visible = Boolean(battery);
        this._uptime.text = `Up ${uptimeText(vitals.uptime_seconds ?? 0)}`;
    }

    _setRow(row, used, total) {
        const percent = share(used, total);
        row.value.text = total > 0 ? `${percent}%  \u00b7  ${size(used)} / ${size(total)}` : '\u2014';
        row.fill.width = Math.round(percent);
        row.fill.style = percent >= 90 ? 'background-color: #ff6961;'
            : percent >= 75 ? 'background-color: #ffb748;' : null;
    }
});
