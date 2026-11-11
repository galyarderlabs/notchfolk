// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Weather page: the sky and the earth as a page of its own, drawn like the Prayer
// page - a reading large, a curve through the next hours, the days beneath, and the
// quakes BMKG reports. The closed island no longer shows the weather; this page is
// where it lives now.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import {label} from '../widgets.js';
import {QuakeWatcher} from '../quake.js';
import {WeatherWatcher} from '../weather.js';
import {Page} from './page.js';

/** The sky disc's size, in CSS pixels (see `px`). */
const DISC_SIZE = 64;
/** How many of the forecast's hours the curve walks. */
const CURVE_HOURS = 8;

export const WeatherPage = GObject.registerClass(
class WeatherPage extends Page {
    _init(daemon, settings, {height}) {
        super._init(daemon, {
            style_class: 'notchfolk-page notchfolk-weather',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'weather';

        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
            style_class: 'notchfolk-weather-column'});
        this._location = label('', 'notchfolk-weather-location');

        // The hero: a drawn sky disc with the condition's icon on it, the temperature
        // large beside it, and the summary under both.
        const hero = new St.BoxLayout({style_class: 'notchfolk-weather-hero'});
        this._disc = new St.DrawingArea({width: DISC_SIZE, height: DISC_SIZE,
            y_align: Clutter.ActorAlign.CENTER});
        this._disc.connect('repaint', area => this._paintDisc(area));
        // The icon rides on the disc, centred over it - a BinLayout overlay, not a spacing trick.
        const discBox = new St.Widget({layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_name: 'weather-clear-symbolic', style_class: 'notchfolk-weather-icon',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        discBox.add_child(this._disc);
        discBox.add_child(this._icon);
        const heroText = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-weather-hero-text'});
        this._temperature = label('', 'notchfolk-weather-temperature');
        this._summary = label('', 'notchfolk-weather-summary');
        heroText.add_child(this._temperature);
        heroText.add_child(this._summary);
        hero.add_child(discBox);
        hero.add_child(heroText);

        // What it feels like, the humidity and the wind: a row of three small facts.
        this._stats = new St.BoxLayout({style_class: 'notchfolk-weather-stats'});
        this._stats.add_child(this._stat('Feels like', 'feelsLike'));
        this._stats.add_child(this._stat('Humidity', 'humidity'));
        this._stats.add_child(this._stat('Wind', 'wind'));

        // The curve through the next hours, as the Prayer page's arc: drawn above, its
        // hour marks labelled below.
        this._curve = new St.DrawingArea({style_class: 'notchfolk-weather-curve'});
        this._curve.connect('repaint', area => this._paintCurve(area));
        this._curveLabels = new St.BoxLayout({style_class: 'notchfolk-weather-curve-labels'});

        // The days: today, tomorrow, the day after - each its coldest and warmest.
        this._days = new St.BoxLayout({style_class: 'notchfolk-weather-days'});

        // The earth: BMKG's latest earthquakes, a row of their own.
        this._quakesTitle = label('Gempa bumi \u00b7 BMKG', 'notchfolk-weather-quakes-title');
        this._quakes = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-weather-quakes'});

        // The sources, as the Prayer page names Kemenag.
        this._sources = label('met.no \u00b7 METAR \u00b7 BMKG', 'notchfolk-weather-sources');

        this._empty = label('Choose a location in Settings \u2192 Weather', 'notchfolk-weather-empty');
        this._fetching = label('Fetching the sky\u2026', 'notchfolk-weather-empty');

        column.add_child(this._location);
        column.add_child(hero);
        column.add_child(this._stats);
        column.add_child(this._curve);
        column.add_child(this._curveLabels);
        column.add_child(this._days);
        column.add_child(this._quakesTitle);
        column.add_child(this._quakes);
        column.add_child(this._sources);
        column.add_child(this._empty);
        column.add_child(this._fetching);
        this.add_child(column);

        this._weather = new WeatherWatcher(settings);
        this._weatherChanged = this._weather.connect('changed', () => this._update());
        this._quakeWatcher = new QuakeWatcher();
        this._quakesChanged = this._quakeWatcher.connect('changed', () => this._updateQuakes());
        this._update();
        this._updateQuakes();
    }

    _stat(title, kind) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-weather-stat'});
        box.add_child(label(title, 'notchfolk-weather-stat-title'));
        const value = label('', 'notchfolk-weather-stat-value');
        box.add_child(value);
        box._kind = kind;
        return box;
    }

    /** The sky disc: a soft blue with a lighter top, as glass over the sky. */
    _paintDisc(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0) {
            cr.$dispose();
            return;
        }
        const radius = Math.min(width, height) / 2;
        cr.save();
        cr.translate(width / 2, height / 2);
        cr.scale(radius, radius);
        const gradient = new Cairo.LinearGradient(0, -1, 0, 1);
        gradient.addColorStopRGBA(0, 0.55, 0.74, 0.92, 1);
        gradient.addColorStopRGBA(1, 0.24, 0.42, 0.66, 1);
        cr.setSource(gradient);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.35);
        cr.setLineWidth(0.06);
        cr.arc(0, 0, 0.97, 0, 2 * Math.PI);
        cr.stroke();
        cr.restore();
        gradient.destroy();
        cr.$dispose();
    }

    /** The curve through the next hours' temperatures - the Prayer page's arc, for the
     * sky: a soft track, the temperatures' line over it in the house gradient, a dot
     * on each hour, warmest to coolest. */
    _paintCurve(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0) {
            cr.$dispose();
            return;
        }
        const hours = (this._weather.state.forecast ?? []).slice(0, CURVE_HOURS)
            .map(slice => ({...slice, value: Number.parseFloat(slice.temperature)}))
            .filter(slice => !Number.isNaN(slice.value));
        if (hours.length < 2) {
            cr.$dispose();
            return;
        }
        const left = px(14);
        const right = width - px(14);
        const top = px(10);
        const bottom = height - px(12);
        const low = Math.min(...hours.map(slice => slice.value));
        const high = Math.max(...hours.map(slice => slice.value));
        const span = Math.max(high - low, 1);
        const x = i => left + (right - left) * (hours.length === 1 ? 0.5 : i / (hours.length - 1));
        const y = value => bottom - (bottom - top) * ((value - low) / span);

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        // The soft track the line rides on.
        cr.setSourceRGBA(1, 1, 1, 0.07);
        cr.setLineWidth(px(7));
        cr.moveTo(x(0), (top + bottom) / 2);
        cr.lineTo(x(hours.length - 1), (top + bottom) / 2);
        cr.stroke();
        // The temperatures' line, in the house gradient.
        const line = new Cairo.LinearGradient(left, 0, right, 0);
        line.addColorStopRGBA(0, 0.16, 0.62, 1, 0.94);
        line.addColorStopRGBA(0.56, 0.23, 0.43, 1, 0.96);
        line.addColorStopRGBA(1, 0.62, 0.28, 0.94, 0.9);
        cr.setSource(line);
        cr.setLineWidth(px(2.5));
        cr.moveTo(x(0), y(hours[0].value));
        for (let i = 1; i < hours.length; i++)
            cr.lineTo(x(i), y(hours[i].value));
        cr.stroke();
        // A dot on each hour, and the warmest one lit.
        for (let i = 0; i < hours.length; i++) {
            const warmest = hours[i].value === high;
            cr.setSourceRGBA(1, 0.72, 0.24, warmest ? 1 : 0.75);
            cr.arc(x(i), y(hours[i].value), warmest ? px(3.5) : px(2.5), 0, 2 * Math.PI);
            cr.fill();
        }
        line.destroy();
        cr.$dispose();
    }

    /** The page on screen is when the sky is worth fetching; off it, the watchers rest. */
    onActivate() {
        this._weather.active = true;
        this._quakeWatcher.active = true;
    }

    onDeactivate() {
        this._weather.active = false;
        this._quakeWatcher.active = false;
    }

    /** The whole sky from the last reading: the hero, the three facts, the curve and its
     * hours, the days. */
    _update() {
        const state = this._weather.state;
        this._location.text = state.locationName;
        this._icon.icon_name = state.iconName || 'weather-clear-symbolic';
        this._temperature.text = state.temperature;
        this._summary.text = state.summary;
        for (const stat of this._stats.get_children())
            stat.get_children()[1].text = state[stat._kind] || '\u2014';

        // The curve's hours, labelled below it: the hour, then its temperature.
        this._curveLabels.destroy_all_children();
        const hours = (state.forecast ?? []).slice(0, CURVE_HOURS)
            .filter(slice => slice.hour);
        for (const slice of hours) {
            const mark = new St.BoxLayout({...VERTICAL, x_expand: true,
                style_class: 'notchfolk-weather-curve-mark'});
            mark.add_child(label(slice.hour, 'notchfolk-weather-hour-time'));
            mark.add_child(label(slice.temperature, 'notchfolk-weather-hour-temp'));
            this._curveLabels.add_child(mark);
        }
        this._curveLabels.visible = hours.length > 1;
        this._curve.visible = hours.length > 1;
        if (this._curve.visible)
            this._curve.queue_repaint();

        // The days: each its name, its icon, its warmest and coldest.
        this._days.destroy_all_children();
        for (const day of state.daily ?? []) {
            const card = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-weather-day'});
            card.add_child(label(day.name, 'notchfolk-weather-day-name'));
            card.add_child(new St.Icon({icon_name: day.iconName || 'weather-clear-symbolic',
                style_class: 'notchfolk-weather-hour-icon'}));
            card.add_child(label(`${Math.round(day.high)}\u00b0`, 'notchfolk-weather-day-high'));
            card.add_child(label(`${Math.round(day.low)}\u00b0`, 'notchfolk-weather-day-low'));
            this._days.add_child(card);
        }
        this._days.visible = (state.daily ?? []).length > 0;

        this._stats.visible = Boolean(state.feelsLike || state.humidity || state.wind);
        // No location picked: say so; a location whose reading has not arrived says it is fetching.
        this._empty.visible = !state.locationName;
        this._fetching.visible = Boolean(state.locationName) && !state.temperature;
        this._disc.queue_repaint();
    }

    /** BMKG's latest earthquakes: a badge for the magnitude, where it sat, how deep, when. */
    _updateQuakes() {
        this._quakes.destroy_all_children();
        for (const quake of this._quakeWatcher.quakes) {
            const row = new St.BoxLayout({style_class: 'notchfolk-weather-quake'});
            const badge = label(`M${quake.magnitude.toFixed(1)}`,
                `notchfolk-weather-quake-badge ${quake.magnitude >= 6 ? 'severe' : quake.magnitude >= 5 ? 'strong' : ''}`);
            row.add_child(badge);
            const text = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-weather-quake-text'});
            text.add_child(label(quake.where, 'notchfolk-weather-quake-where'));
            text.add_child(label([quake.depth, quake.when].filter(Boolean).join(' \u00b7 '),
                'notchfolk-weather-quake-when'));
            row.add_child(text);
            this._quakes.add_child(row);
        }
        const has = this._quakeWatcher.quakes.length > 0;
        this._quakesTitle.visible = has;
        this._quakes.visible = has;
    }

    destroy() {
        this._weather.disconnect(this._weatherChanged);
        this._weather.destroy();
        this._quakeWatcher.disconnect(this._quakesChanged);
        this._quakeWatcher.destroy();
        super.destroy();
    }
});
