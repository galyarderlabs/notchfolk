// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Vitals page: the machine's own pulse, drawn like the island's own pages - a
// heading, the sparkline (the last minute of CPU activity, drawn as the weather's own
// curve: smooth cubic, warm gradient area, alive with every sample), the two that
// change what you do next (CPU and temperature) as the numbers above it, the storage
// that fills slowly as flat rows, the network and the battery as the footer.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import * as Format from '../format.js';
import {icon, label} from '../widgets.js';
import {Page} from './page.js';

/** How many samples the sparkline walks (2 s each: the last minute). */
const SPARK_POINTS = 30;

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
    return '\u2014';
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
        this._history = [];

        this._column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
            style_class: 'notchfolk-vitals-column'});
        this.add_child(this._column);

        // \u2500\u2500 The heading, as every page's own \u2500\u2500
        const heading = new St.BoxLayout({style_class: 'notchfolk-vitals-heading'});
        heading.add_child(new St.Icon({gicon: icon('notchfolk-heartbeat'), icon_size: 15,
            style_class: 'notchfolk-vitals-heading-icon'}));
        heading.add_child(label('Vitals', 'notchfolk-vitals-title', {x_expand: true}));
        heading.add_child(label(Format.longDate(), 'notchfolk-vitals-date'));
        this._column.add_child(heading);

        // \u2500\u2500 The pulse: the two that change what you do next, above the sparkline \u2500\u2500
        const pulse = new St.BoxLayout({style_class: 'notchfolk-vitals-pulse', x_expand: true});
        const cpu = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure'});
        this._cpuValue = label('\u2014', 'notchfolk-vitals-figure-value');
        cpu.add_child(this._cpuValue);
        cpu.add_child(label('CPU load', 'notchfolk-vitals-figure-name'));
        pulse.add_child(cpu);
        pulse.add_child(new St.Widget({style_class: 'notchfolk-vitals-rule'}));
        const heat = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-vitals-figure'});
        this._tempValue = label('\u2014', 'notchfolk-vitals-figure-value notchfolk-vitals-temp');
        heat.add_child(this._tempValue);
        this._tempBand = label('', 'notchfolk-vitals-figure-band');
        heat.add_child(this._tempBand);
        pulse.add_child(heat);
        this._column.add_child(pulse);

        // \u2500\u2500 The sparkline: the last minute of CPU activity, drawn as the weather's
        // own curve - smooth cubic, warm gradient area, alive with every sample \u2500\u2500
        this._spark = new St.DrawingArea({style_class: 'notchfolk-vitals-spark', x_expand: true});
        this._spark.connect('repaint', area => this._paintSpark(area));
        this._column.add_child(this._spark);

        // \u2500\u2500 Storage: the two that fill slowly, one line each \u2500\u2500
        this._memBar = this._storageRow('Memory');
        this._column.add_child(this._memBar.box);
        this._diskBar = this._storageRow('Disk');
        this._column.add_child(this._diskBar.box);

        // \u2500\u2500 The footer: the network's rates, the battery when there is one \u2500\u2500
        const footer = new St.BoxLayout({style_class: 'notchfolk-vitals-footer', x_expand: true});
        this._netDown = label('', 'notchfolk-vitals-net');
        this._netUp = label('', 'notchfolk-vitals-net');
        footer.add_child(this._netDown);
        footer.add_child(this._netUp);
        this._battery = label('', 'notchfolk-vitals-battery');
        footer.add_child(this._battery);
        this._column.add_child(footer);

        this._unit = settings.get_string('vitals-temperature-unit');
        this._unitChanged = settings.connect('changed::vitals-temperature-unit', () => {
            this._unit = settings.get_string('vitals-temperature-unit');
            this._refresh();
        });
        this.connect('destroy', () => settings.disconnect(this._unitChanged));
        this.watch(['vitals', 'system'], () => this._refresh());
        this._refresh();
    }

    /** One storage row: the name left, the bar across, the value right - one line. */
    _storageRow(name) {
        const box = new St.BoxLayout({style_class: 'notchfolk-vitals-storage', x_expand: true});
        box.add_child(label(name, 'notchfolk-vitals-storage-name'));
        const fill = new St.Widget({style_class: 'notchfolk-vitals-bar-fill'});
        const track = new St.Widget({style_class: 'notchfolk-vitals-bar-track', x_expand: true});
        track.add_child(fill);
        box.add_child(track);
        const value = label('', 'notchfolk-vitals-storage-value');
        box.add_child(value);
        return {value, fill, track, box};
    }

    /** The sparkline: the history as a smooth curve with a warm gradient area under it,
     * drawn with the weather's own curve technique - cubic interpolation, area fill. */
    _paintSpark(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0 || this._history.length < 2) {
            cr.$dispose();
            return;
        }
        const points = this._history.slice(-SPARK_POINTS);
        const x = i => width * i / (points.length - 1);
        const top = px(3);
        const bottom = height - px(2);
        const y = value => bottom - (bottom - top) * (value / 100);

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);

        // The smooth curve through the history, as the weather's own.
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

        // The area under the curve: the island's own warm gold, fading to nothing.
        const areaGradient = new Cairo.LinearGradient(0, top, 0, bottom);
        areaGradient.addColorStopRGBA(1, 1, 0.81, 0.36, 0.18);
        areaGradient.addColorStopRGBA(0, 1, 0.81, 0.36, 0);
        drawCurve();
        cr.lineTo(x(points.length - 1), bottom);
        cr.lineTo(x(0), bottom);
        cr.closePath();
        cr.setSource(areaGradient);
        cr.fill();

        // The line itself: the warm gradient, left to right.
        const lineGradient = new Cairo.LinearGradient(0, 0, width, 0);
        lineGradient.addColorStopRGBA(0, 1, 0.81, 0.36, 0.4);
        lineGradient.addColorStopRGBA(1, 1, 0.62, 0.04, 0.95);
        cr.setSource(lineGradient);
        cr.setLineWidth(px(2));
        drawCurve();
        cr.stroke();

        // The dot at the curve's end: where the machine is now.
        cr.setSourceRGBA(1, 0.81, 0.36, 1);
        cr.arc(x(points.length - 1), y(points[points.length - 1]), px(2.5), 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }

    _refresh() {
        const vitals = this.daemon.state?.vitals;
        if (!vitals)
            return;

        this._cpuValue.text = `${Math.round(vitals.cpu_percent)}%`;

        const celsius = vitals.temperature_c;
        const unit = this._unit === 'F' ? 'F' : 'C';
        const shown = unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
        this._tempValue.text = celsius > 0 ? `${Math.round(shown)}\u00b0` : '\u2014';
        this._tempValue.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;
        this._tempBand.text = tempBand(celsius);
        this._tempBand.style = celsius > 0 ? `color: ${tempColor(celsius)};` : null;

        // The sparkline's history: the last minute of CPU activity.
        this._history.push(vitals.cpu_percent);
        if (this._history.length > SPARK_POINTS)
            this._history.shift();
        this._spark.queue_repaint();

        this._setRow(this._memBar, vitals.memory_used_bytes, vitals.memory_total_bytes);
        this._setRow(this._diskBar, vitals.disk_used_bytes, vitals.disk_total_bytes);

        this._netDown.text = `\u2193 ${rate(vitals.network_down_bytes_per_s)}`;
        this._netUp.text = `\u2191 ${rate(vitals.network_up_bytes_per_s)}`;

        const battery = this.daemon.state?.system?.battery;
        this._battery.text = battery ? `${battery.percent}%${battery.charging ? ' \u26a1' : ''}` : '';
        this._battery.visible = Boolean(battery);
    }

    /** One storage row: its share, the bytes, and the fill's width. A bar that is
     * filling up says so - amber past three quarters, red past nine tenths. */
    _setRow(row, used, total) {
        const percent = share(used, total);
        row.value.text = total > 0 ? `${percent}%  \u00b7  ${size(used)} / ${size(total)}` : '\u2014';
        row.fill.width = Math.round(percent);
        row.fill.style = percent >= 90 ? 'background-color: #ff6961;'
            : percent >= 75 ? 'background-color: #ffb748;' : null;
    }
});
