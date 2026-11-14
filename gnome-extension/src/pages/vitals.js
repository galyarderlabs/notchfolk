// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Vitals page: the machine's own pulse, with a mode switch like the Apps page's
// own. Every mode fills the page: All (the pulse left, the detail right), CPU (the
// numbers big, the sparkline, each core a labeled bar), Memory (each storage a big
// bar with its bytes), Network (both rates big with their own sparklines).

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import * as Format from '../format.js';
import {icon, label} from '../widgets.js';
import {Page} from './page.js';

const SPARK_POINTS = 30;

const MODES = [
    {name: 'all', label: 'All'},
    {name: 'cpu', label: 'CPU'},
    {name: 'memory', label: 'Mem'},
    {name: 'network', label: 'Net'},
];

function tempColor(celsius) {
    if (celsius >= 75)
        return '#ff6961';
    if (celsius >= 60)
        return '#ffb748';
    return '#7dd87d';
}

function tempBand(celsius) {
    if (celsius >= 75)
        return 'Hot';
    if (celsius >= 60)
        return 'Warm';
    if (celsius > 0)
        return 'Cool';
    return '\u2014';
}

function rate(bytesPerSecond) {
    if (bytesPerSecond < 1024)
        return `${Math.round(bytesPerSecond)} B/s`;
    if (bytesPerSecond < 1024 * 1024)
        return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

function size(bytes) {
    if (bytes < 1024 ** 3)
        return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    if (bytes < 1024 ** 4)
        return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
}

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
        this._cpuHistory = [];
        this._downHistory = [];
        this._upHistory = [];
        this._mode = 'all';

        this._column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
            style_class: 'notchfolk-vitals-column'});
        this.add_child(this._column);

        // The heading: the icon, the title, the mode switch (its labels fit).
        const heading = new St.BoxLayout({style_class: 'notchfolk-vitals-heading'});
        heading.add_child(new St.Icon({gicon: icon('notchfolk-heartbeat'), icon_size: 15,
            style_class: 'notchfolk-vitals-heading-icon'}));
        heading.add_child(label('Vitals', 'notchfolk-vitals-title'));
        const toggle = new St.BoxLayout({style_class: 'notchfolk-segmented notchfolk-vitals-toggle'});
        this._modeButtons = new Map();
        for (const {name, label: text} of MODES) {
            const button = new St.Button({style_class: 'notchfolk-segment', label: text, can_focus: true});
            button.connect('clicked', () => this._showMode(name));
            this._modeButtons.set(name, button);
            toggle.add_child(button);
        }
        heading.add_child(toggle);
        this._column.add_child(heading);

        // ── All: full-width sections, stacked - the pulse, the sparkline,
        // the storage, the footer. No cramped columns; everything breathes. ──
        this._allView = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-all',
            x_expand: true, y_expand: true});

        // The pulse: CPU and temperature side by side, full width.
        const cpuHeat = new St.BoxLayout({style_class: 'notchfolk-vitals-all-pulse', x_expand: true});
        const cpuFig = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure', x_expand: true});
        this._cpuValue = label('\u2014', 'notchfolk-vitals-figure-value');
        cpuFig.add_child(this._cpuValue);
        cpuFig.add_child(label('CPU load', 'notchfolk-vitals-figure-name'));
        cpuHeat.add_child(cpuFig);
        cpuHeat.add_child(new St.Widget({style_class: 'notchfolk-vitals-divider'}));
        const heatFig = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure', x_expand: true});
        this._tempValue = label('\u2014', 'notchfolk-vitals-figure-value notchfolk-vitals-temp');
        heatFig.add_child(this._tempValue);
        this._tempBand = label('', 'notchfolk-vitals-figure-band');
        heatFig.add_child(this._tempBand);
        cpuHeat.add_child(heatFig);
        cpuHeat.add_child(new St.Widget({style_class: 'notchfolk-vitals-divider'}));
        const freqFig = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure', x_expand: true});
        this._allFreq = label('', 'notchfolk-vitals-figure-value notchfolk-vitals-freq');
        freqFig.add_child(this._allFreq);
        freqFig.add_child(label('CPU speed', 'notchfolk-vitals-figure-name'));
        cpuHeat.add_child(freqFig);
        this._allView.add_child(cpuHeat);

        // The sparkline: the last minute, full width.
        this._spark = new St.DrawingArea({style_class: 'notchfolk-vitals-spark', x_expand: true});
        this._spark.connect('repaint', area => this._paintSpark(area, this._cpuHistory));
        this._allView.add_child(this._spark);

        // The cores: a strip across the full width.
        this._coresBox = new St.BoxLayout({style_class: 'notchfolk-vitals-cores', x_expand: true});
        this._allView.add_child(this._coresBox);

        // The storage: Memory and Disk, full-width bars.
        this._memBar = this._storageRow('Memory', this._allView);
        this._swapBar = this._storageRow('Swap', this._allView);
        this._diskBar = this._storageRow('Disk', this._allView);

        // The footer: the network, the battery, the machine's story.
        this._allView.add_child(new St.Widget({style_class: 'notchfolk-vitals-hairline'}));
        const footer = new St.BoxLayout({style_class: 'notchfolk-vitals-all-footer', x_expand: true});
        this._netDown = label('', 'notchfolk-vitals-net-value');
        footer.add_child(this._netDown);
        this._netUp = label('', 'notchfolk-vitals-net-value');
        footer.add_child(this._netUp);
        this._battery = label('', 'notchfolk-vitals-battery-value');
        footer.add_child(this._battery);
        this._uptime = label('', 'notchfolk-vitals-story-value');
        footer.add_child(this._uptime);
        this._allView.add_child(footer);
        this._column.add_child(this._allView);

        // ── CPU: the numbers big, the sparkline, each core a labeled bar ──
        this._cpuView = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-focus', x_expand: true,
            y_expand: true, visible: false});
        const cpuTop = new St.BoxLayout({style_class: 'notchfolk-vitals-focus-top'});
        this._cpuBig = label('\u2014', 'notchfolk-vitals-big');
        cpuTop.add_child(this._cpuBig);
        cpuTop.add_child(label('CPU load', 'notchfolk-vitals-figure-name', {y_align: Clutter.ActorAlign.END}));
        this._cpuTempSmall = label('', 'notchfolk-vitals-focus-side');
        cpuTop.add_child(this._cpuTempSmall);
        this._cpuView.add_child(cpuTop);
        this._cpuSpark = new St.DrawingArea({style_class: 'notchfolk-vitals-spark-tall', x_expand: true});
        this._cpuSpark.connect('repaint', area => this._paintSpark(area, this._cpuHistory));
        this._cpuView.add_child(this._cpuSpark);
        this._coresBoxBig = new St.BoxLayout({style_class: 'notchfolk-vitals-cores-big'});
        this._cpuView.add_child(this._coresBoxBig);
        this._cpuFreqLabel = label('', 'notchfolk-vitals-story-value');
        this._cpuView.add_child(this._cpuFreqLabel);
        this._cpuLoadLabel = label('', 'notchfolk-vitals-story-value');
        this._cpuView.add_child(this._cpuLoadLabel);
        this._column.add_child(this._cpuView);

        // ── Memory: each storage a big bar with its bytes under it ──
        this._memView = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-focus', x_expand: true,
            y_expand: true, visible: false});
        this._memHead = new St.BoxLayout({style_class: 'notchfolk-vitals-focus-top'});
        this._memBig = label('\u2014', 'notchfolk-vitals-big');
        this._memHead.add_child(this._memBig);
        this._memDetail = label('', 'notchfolk-vitals-focus-side');
        this._memHead.add_child(this._memDetail);
        this._memView.add_child(this._memHead);
        this._memWide = this._bigBar('Memory', this._memView);
        this._swapWide = this._bigBar('Swap', this._memView);
        this._diskWide = this._bigBar('Disk', this._memView);
        this._column.add_child(this._memView);

        // ── Network: both rates big, each its own sparkline ──
        this._netView = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-focus', x_expand: true,
            y_expand: true, visible: false});
        const netTop = new St.BoxLayout({style_class: 'notchfolk-vitals-netview-top'});
        const downFig = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure'});
        this._netDownBig = label('\u2014', 'notchfolk-vitals-big notchfolk-vitals-net-big');
        downFig.add_child(this._netDownBig);
        downFig.add_child(label('Download', 'notchfolk-vitals-figure-name'));
        netTop.add_child(downFig);
        const upFig = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure'});
        this._netUpBig = label('\u2014', 'notchfolk-vitals-big notchfolk-vitals-net-big');
        upFig.add_child(this._netUpBig);
        upFig.add_child(label('Upload', 'notchfolk-vitals-figure-name'));
        netTop.add_child(upFig);
        this._netView.add_child(netTop);
        this._downSpark = new St.DrawingArea({style_class: 'notchfolk-vitals-spark-tall', x_expand: true});
        this._downSpark.connect('repaint', area => this._paintNetSpark(area, this._downHistory));
        this._netView.add_child(this._downSpark);
        this._column.add_child(this._netView);

        this._unit = settings.get_string('vitals-temperature-unit');
        this._unitChanged = settings.connect('changed::vitals-temperature-unit', () => {
            this._unit = settings.get_string('vitals-temperature-unit');
            this._refresh();
        });
        this.connect('destroy', () => settings.disconnect(this._unitChanged));
        this.watch(['vitals', 'system'], () => this._refresh());
        this._showMode('all');
        this._refresh();
    }

    _showMode(mode) {
        this._mode = mode;
        for (const [name, button] of this._modeButtons)
            button.set_checked(name === mode);
        this._allView.visible = mode === 'all';
        this._cpuView.visible = mode === 'cpu';
        this._memView.visible = mode === 'memory';
        this._netView.visible = mode === 'network';
        this._refresh();
    }

    _storageRow(name, parent) {
        const box = new St.BoxLayout({style_class: 'notchfolk-vitals-storage', x_expand: true});
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

    /** A big bar with its name above and its bytes under - the memory view's own row. */
    _bigBar(name, parent) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-bigbar', x_expand: true});
        const header = new St.BoxLayout({style_class: 'notchfolk-vitals-bigbar-header'});
        header.add_child(label(name, 'notchfolk-vitals-bigbar-name'));
        const value = label('', 'notchfolk-vitals-bigbar-value');
        header.add_child(value);
        box.add_child(header);
        const fill = new St.Widget({style_class: 'notchfolk-vitals-bar-fill'});
        const track = new St.Widget({style_class: 'notchfolk-vitals-bar-track-tall', x_expand: true});
        track.add_child(fill);
        box.add_child(track);
        parent.add_child(box);
        return {value, fill, track, box};
    }

    _paintSpark(area, history) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0 || history.length < 2) {
            cr.$dispose();
            return;
        }
        const points = history.slice(-SPARK_POINTS);
        const x = i => width * i / (points.length - 1);
        const top = px(2);
        const bottom = height - px(2);
        const max = Math.max(...points, 1);
        const y = value => bottom - (bottom - top) * (value / max);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        const drawCurve = () => {
            cr.moveTo(x(0), y(points[0]));
            for (let i = 0; i < points.length - 1; i++) {
                const previous = points[Math.max(0, i - 1)];
                const current = points[i];
                const next = points[i + 1];
                const following = points[Math.min(points.length - 1, i + 2)];
                const controlY1 = y(current + (next - previous) / 6);
                const controlY2 = y(next - (following - current) / 6);
                const third = (x(i + 1) - x(i)) / 3;
                cr.curveTo(x(i) + third, controlY1, x(i + 1) - third, controlY2,
                    x(i + 1), y(next));
            }
        };
        const areaGradient = new Cairo.LinearGradient(0, top, 0, bottom);
        areaGradient.addColorStopRGBA(1, 1, 0.81, 0.36, 0.18);
        areaGradient.addColorStopRGBA(0, 1, 0.81, 0.36, 0);
        drawCurve();
        cr.lineTo(x(points.length - 1), bottom);
        cr.lineTo(x(0), bottom);
        cr.closePath();
        cr.setSource(areaGradient);
        cr.fill();
        const lineGradient = new Cairo.LinearGradient(0, 0, width, 0);
        lineGradient.addColorStopRGBA(0, 1, 0.81, 0.36, 0.4);
        lineGradient.addColorStopRGBA(1, 1, 0.62, 0.04, 0.95);
        cr.setSource(lineGradient);
        cr.setLineWidth(px(2));
        drawCurve();
        cr.stroke();
        cr.setSourceRGBA(1, 0.81, 0.36, 1);
        cr.arc(x(points.length - 1), y(points[points.length - 1]), px(2.5), 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }

    _paintNetSpark(area, history) {
        this._paintSpark(area, history);
    }

    _refresh() {
        const vitals = this.daemon.state?.vitals;
        if (!vitals)
            return;

        const cpuPercent = Math.round(vitals.cpu_percent);
        const celsius = vitals.temperature_c;
        const unit = this._unit === 'F' ? 'F' : 'C';
        const shown = unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
        const tempText = celsius > 0 ? `${Math.round(shown)}\u00b0` : '\u2014';
        const tempColorValue = celsius > 0 ? tempColor(celsius) : null;

        this._cpuValue.text = `${cpuPercent}%`;
        this._cpuBig.text = `${cpuPercent}%`;
        this._tempValue.text = tempText;
        this._tempValue.style = tempColorValue ? `color: ${tempColorValue};` : null;
        this._tempBand.text = tempBand(celsius);
        this._tempBand.style = tempColorValue ? `color: ${tempColorValue};` : null;
        this._cpuTempSmall.text = `${tempText} ${tempBand(celsius)}`;
        this._cpuTempSmall.style = tempColorValue ? `color: ${tempColorValue};` : null;

        this._cpuHistory.push(vitals.cpu_percent);
        if (this._cpuHistory.length > SPARK_POINTS)
            this._cpuHistory.shift();
        this._spark.queue_repaint();
        this._cpuSpark.queue_repaint();

        const down = vitals.network_down_bytes_per_s;
        const up = vitals.network_up_bytes_per_s;
        this._downHistory.push(down);
        this._upHistory.push(up);
        if (this._downHistory.length > SPARK_POINTS)
            this._downHistory.shift();
        if (this._upHistory.length > SPARK_POINTS)
            this._upHistory.shift();
        this._downSpark.queue_repaint();

        this._netDown.text = `\u2193 ${rate(down)}`;
        this._netUp.text = `\u2191 ${rate(up)}`;
        this._netDownBig.text = rate(down);
        this._netUpBig.text = rate(up);

        const memPercent = share(vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._memBig.text = `${memPercent}%`;
        this._memDetail.text = `${size(vitals.memory_used_bytes)} of ${size(vitals.memory_total_bytes)}`;

        this._setRow(this._memBar, vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._setRow(this._swapBar, vitals.swap_used_bytes, vitals.swap_total_bytes);
        this._swapBar.box.visible = vitals.swap_total_bytes > 0;
        this._setRow(this._diskBar, vitals.disk_used_bytes, vitals.disk_total_bytes);
        this._setBigBar(this._memWide, vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._setBigBar(this._swapWide, vitals.swap_used_bytes, vitals.swap_total_bytes);
        this._swapWide.box.visible = vitals.swap_total_bytes > 0;
        this._setBigBar(this._diskWide, vitals.disk_used_bytes, vitals.disk_total_bytes);

        this._syncCores(vitals.cpu_cores ?? []);

        const battery = this.daemon.state?.system?.battery;
        this._battery.text = battery ? `\u26a1 ${battery.percent}%${battery.charging ? ' charging' : ''}` : '';
        this._battery.visible = Boolean(battery);

        // The machine's own story.
        const up = vitals.uptime_seconds ?? 0;
        const upDays = Math.floor(up / 86400);
        const upHours = Math.floor((up % 86400) / 3600);
        const upMins = Math.floor((up % 3600) / 60);
        this._uptime.text = `Up ${upDays > 0 ? `${upDays}d ` : ''}${upHours}h ${upMins}m`;
        this._allFreq.text = vitals.cpu_frequency_mhz > 0 ? `${(vitals.cpu_frequency_mhz / 1000).toFixed(1)}` : '—';
        this._cpuFreqLabel.text = vitals.cpu_frequency_mhz > 0 ? `${(vitals.cpu_frequency_mhz / 1000).toFixed(2)} GHz` : '';
        this._cpuFreqLabel.visible = vitals.cpu_frequency_mhz > 0;
        this._cpuLoadLabel.text = `Load  ${(vitals.load_1 ?? 0).toFixed(2)} · ${(vitals.load_5 ?? 0).toFixed(2)} · ${(vitals.load_15 ?? 0).toFixed(2)}`;
    }

    _syncCores(cores) {
        const signature = cores.length.toString();
        if (signature !== this._coreSignature) {
            this._coreSignature = signature;
            this._coresBox.destroy_all_children();
            this._coresBoxBig.destroy_all_children();
            this._cores = cores.map((_, index) => {
                const fill = new St.Widget({style_class: 'notchfolk-vitals-core-fill'});
                const track = new St.Widget({style_class: 'notchfolk-vitals-core-track'});
                track.add_child(fill);
                this._coresBox.add_child(track);
                const fillBig = new St.Widget({style_class: 'notchfolk-vitals-core-fill'});
                const trackBig = new St.Widget({style_class: 'notchfolk-vitals-core-track-big'});
                trackBig.add_child(fillBig);
                this._coresBoxBig.add_child(trackBig);
                return {fill, track, fillBig, trackBig, index};
            });
        }
        cores.forEach((usage, index) => {
            const core = this._cores[index];
            if (!core)
                return;
            const percent = Math.max(0, Math.min(100, Math.round(usage)));
            core.fill.height = Math.max(1, Math.round(percent / 100 * 16));
            core.fillBig.height = Math.max(1, Math.round(percent / 100 * 24));
            core.fillBig.style = percent >= 85 ? 'background-color: #ff6961;' : null;
            core.track.tooltip_text = `Core ${index}: ${percent}%`;
            core.trackBig.tooltip_text = `Core ${index}: ${percent}%`;
        });
    }

    _setRow(row, used, total) {
        const percent = share(used, total);
        row.value.text = total > 0 ? `${percent}%` : '\u2014';
        row.box.tooltip_text = total > 0 ? `${size(used)} of ${size(total)}` : null;
        row.fill.width = Math.round(percent);
        row.fill.style = percent >= 90 ? 'background-color: #ff6961;'
            : percent >= 75 ? 'background-color: #ffb748;' : null;
    }

    _setBigBar(bar, used, total) {
        const percent = share(used, total);
        bar.value.text = total > 0 ? `${percent}%  \u00b7  ${size(used)} of ${size(total)}` : '\u2014';
        bar.fill.width = Math.round(percent);
        bar.fill.style = percent >= 90 ? 'background-color: #ff6961;'
            : percent >= 75 ? 'background-color: #ffb748;' : null;
    }
});
