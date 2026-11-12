// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Weather page: the sky and the earth as a page of its own, drawn like the Prayer
// page - a reading large, a curve through the next hours, the days beneath, and the
// nearby earthquakes. The closed island no longer shows the weather; this page is
// where it lives now.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, onUiScale, px, uiScale} from '../compat.js';
import {label} from '../widgets.js';
import {QuakeWatcher} from '../quake.js';
import {LARGE_PAGE_HEIGHT, PAGE_HEIGHT} from '../expanded.js';
import {WeatherWatcher} from '../weather.js';
import {Page} from './page.js';

/** The sky disc's size, in CSS pixels (see `px`). */
const DISC_SIZE = 52;
/** Keep the current conditions and five-day forecast roomy without crowding hourly data. */
const OVERVIEW_WIDTH = 300;
/** How many of the forecast's hours the curve walks. */
const CURVE_HOURS = 8;

const WEATHER_TONES = {
    clear: {icon: '#f0c66f', line: [0.94, 0.74, 0.36], disc: [[0.78, 0.58, 0.25], [0.32, 0.22, 0.1]]},
    clouds: {icon: '#c5c8ce', line: [0.74, 0.75, 0.78], disc: [[0.48, 0.49, 0.53], [0.2, 0.21, 0.25]]},
    rain: {icon: '#83c5f2', line: [0.42, 0.7, 0.94], disc: [[0.32, 0.59, 0.79], [0.12, 0.29, 0.46]]},
    snow: {icon: '#a9dfed', line: [0.62, 0.84, 0.92], disc: [[0.52, 0.73, 0.82], [0.24, 0.4, 0.52]]},
    storm: {icon: '#b8a9f2', line: [0.66, 0.58, 0.91], disc: [[0.5, 0.42, 0.74], [0.22, 0.18, 0.42]]},
    fog: {icon: '#bac4cd', line: [0.66, 0.72, 0.78], disc: [[0.52, 0.57, 0.62], [0.24, 0.28, 0.32]]},
    night: {icon: '#b0a1f4', line: [0.62, 0.55, 0.91], disc: [[0.45, 0.39, 0.72], [0.17, 0.15, 0.38]]},
    neutral: {icon: '#c5cbd5', line: [0.76, 0.79, 0.84], disc: [[0.47, 0.5, 0.56], [0.2, 0.22, 0.27]]},
};

/** GWeather icon names describe the condition and day/night; keep all presentation colors here. */
function weatherTone(iconName) {
    const name = String(iconName ?? '').toLowerCase();
    if (/storm|thunder/.test(name))
        return WEATHER_TONES.storm;
    if (/snow|sleet|hail/.test(name))
        return WEATHER_TONES.snow;
    if (/rain|showers|shower/.test(name))
        return WEATHER_TONES.rain;
    if (/fog|mist|haze/.test(name))
        return WEATHER_TONES.fog;
    if (/night|moon/.test(name))
        return WEATHER_TONES.night;
    if (/clear|sun/.test(name))
        return WEATHER_TONES.clear;
    if (/cloud|overcast/.test(name))
        return WEATHER_TONES.clouds;
    return WEATHER_TONES.neutral;
}

/** A row whose children all take the same width: a Clutter grid of homogeneous columns, one
 * child per column, since St.BoxLayout sizes each child to its own content. `add_child` puts
 * the next child in the next column, so callers treat it as a box.
 *
 * The grid shares a leftover pixel between columns rather than leaving one column wider, so the
 * row is given a width its columns divide exactly: `columns` cells of `width` plus their gaps.
 * `spacing` is the grid's own, as an St.Widget has none. */
function uniformRow(styleClass, {columns, width = 0, spacing = 0, expandChildren = true}) {
    const grid = new Clutter.GridLayout({orientation: Clutter.Orientation.HORIZONTAL,
        column_homogeneous: true, column_spacing: px(spacing)});
    const row = new St.Widget({layout_manager: grid, style_class: styleClass,
        ...(width ? {width: px(columns * width + (columns - 1) * spacing),
            x_align: Clutter.ActorAlign.START} : {x_expand: true})});
    row.add_child = child => {
        if (expandChildren)
            child.x_expand = true;
        grid.attach(child, row.get_n_children(), 0, 1, 1);
        return child;
    };
    return row;
}

export const WeatherPage = GObject.registerClass(
class WeatherPage extends Page {
    _init(daemon, settings, {height}) {
        super._init(daemon, {
            style_class: 'notchfolk-page notchfolk-weather',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'weather';
        /** The height for the page's bare state (PAGE_HEIGHT, or LARGE_PAGE_HEIGHT on
         * Large); the sections it gains keep their extra height on top of it. */
        this._baseHeight = height;

        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
            style_class: 'notchfolk-weather-column'});
        const row = new St.BoxLayout({x_expand: true, style_class: 'notchfolk-weather-row'});
        const overview = new St.BoxLayout({...VERTICAL, x_align: Clutter.ActorAlign.START,
            style_class: 'notchfolk-weather-overview'});
        const forecast = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'notchfolk-weather-forecast'});
        const detailsGrid = new Clutter.GridLayout({orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: false, column_spacing: px(12)});
        const details = new St.Widget({layout_manager: detailsGrid, x_expand: true,
            style_class: 'notchfolk-weather-details'});
        const daysBlock = new St.BoxLayout({...VERTICAL, x_align: Clutter.ActorAlign.START,
            style_class: 'notchfolk-weather-days-block'});
        daysBlock.x_expand = false;
        // Keep the lower forecast column exactly under the current-conditions column.
        onUiScale(this, scale => {
            overview.width = OVERVIEW_WIDTH * scale;
            daysBlock.width = OVERVIEW_WIDTH * scale;
        });
        const quakesBlock = new St.BoxLayout({...VERTICAL, x_expand: true,
            style_class: 'notchfolk-weather-quakes-block'});
        this._quakesBlock = quakesBlock;
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

        // Compact current conditions without card surfaces or an empty apparent-temperature tile.
        this._stats = uniformRow('notchfolk-weather-stats', {columns: 3, spacing: 8});
        this._stats.add_child(this._stat('Wind', 'wind', 'weather-windy-symbolic'));
        this._stats.add_child(this._stat('Daylight', 'daylight', 'weather-clear-symbolic'));
        this._stats.add_child(this._stat('Humidity', 'humidity', 'weather-showers-symbolic'));

        // The curve through the next hours, as the Prayer page's arc: drawn above, its
        // hour marks labelled below.
        this._hoursTitle = label('Hourly forecast',
            'notchfolk-weather-section-title notchfolk-weather-hours-title');
        this._curve = new St.DrawingArea({x_expand: true, style_class: 'notchfolk-weather-curve'});
        this._curve.connect('repaint', area => this._paintCurve(area));
        // Expand across the same width as the chart so each label column can sit under its dot.
        this._curveLabels = uniformRow('notchfolk-weather-curve-labels', {columns: CURVE_HOURS});

        // The days: five of them, today first - each its coldest and warmest.
        this._daysTitle = label('5-day forecast', 'notchfolk-weather-section-title');
        this._days = uniformRow('notchfolk-weather-days', {columns: 5, spacing: 8,
            expandChildren: false});

        // Nearby earthquakes for the configured Weather city, a row of their own.
        this._quakeHeading = new St.BoxLayout({style_class: 'notchfolk-weather-quake-heading'});
        this._quakeIcon = new St.Icon({icon_name: 'dialog-warning-symbolic',
            style_class: 'notchfolk-weather-quake-icon', y_align: Clutter.ActorAlign.CENTER});
        this._quakesTitle = label('Recent earthquakes', 'notchfolk-weather-quakes-title');
        this._quakeGrid = new Clutter.GridLayout({orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true, column_spacing: px(8), row_spacing: px(8)});
        this._quakes = new St.Widget({layout_manager: this._quakeGrid, x_expand: true,
            style_class: 'notchfolk-weather-quakes'});
        this._quakeContent = new St.BoxLayout({...VERTICAL, x_expand: true,
            style_class: 'notchfolk-weather-quakes-content'});

        this._empty = label('Choose a location in Settings \u2192 Weather', 'notchfolk-weather-empty');
        this._fetching = label('Fetching the sky\u2026', 'notchfolk-weather-empty');

        overview.add_child(this._location);
        overview.add_child(hero);
        overview.add_child(this._stats);
        overview.add_child(this._empty);
        overview.add_child(this._fetching);
        forecast.add_child(this._hoursTitle);
        forecast.add_child(this._curve);
        forecast.add_child(this._curveLabels);
        row.add_child(overview);
        row.add_child(forecast);
        this._quakeHeading.add_child(this._quakeIcon);
        this._quakeHeading.add_child(this._quakesTitle);
        this._quakeContent.add_child(this._quakeHeading);
        this._quakeContent.add_child(this._quakes);
        quakesBlock.add_child(this._quakeContent);
        column.add_child(row);
        daysBlock.add_child(this._daysTitle);
        daysBlock.add_child(this._days);
        detailsGrid.attach(daysBlock, 0, 0, 1, 1);
        detailsGrid.attach(quakesBlock, 1, 0, 1, 1);
        column.add_child(details);
        this._scroll = new St.ScrollView({
            style_class: 'notchfolk-weather-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(column);
        this.add_child(this._scroll);

        this._weather = new WeatherWatcher(settings);
        this._weatherChanged = this._weather.connect('changed', () => this._update());
        this._quakeWatcher = new QuakeWatcher(settings);
        this._quakesChanged = this._quakeWatcher.connect('changed', () => this._updateQuakes());
        this._stage = global.stage;
        this._update();
        this._updateQuakes();
        this._syncHeight();
    }

    /** Abbreviates the direction so the speed and its unit fit in the compact metric row. */
    _shortWind(text) {
        const source = String(text ?? '').trim();
        const normalized = source.toLowerCase().replace(/[\u2010-\u2015-]/g, ' ')
            .replace(/\s+/g, ' ');
        const directions = [
            ['north north east', 'NNE'], ['north northeast', 'NNE'], ['northeast', 'NE'], ['north east', 'NE'],
            ['east north east', 'ENE'], ['east northeast', 'ENE'], ['east southeast', 'ESE'], ['east south east', 'ESE'],
            ['south south east', 'SSE'], ['south southeast', 'SSE'], ['southeast', 'SE'], ['south east', 'SE'],
            ['south south west', 'SSW'], ['south southwest', 'SSW'], ['southwest', 'SW'], ['south west', 'SW'],
            ['west south west', 'WSW'], ['west southwest', 'WSW'], ['west north west', 'WNW'], ['west northwest', 'WNW'],
            ['north north west', 'NNW'], ['north northwest', 'NNW'], ['northwest', 'NW'], ['north west', 'NW'],
            ['north', 'N'], ['east', 'E'], ['south', 'S'], ['west', 'W'], ['variable', 'VRB'],
        ];
        const direction = directions.find(([name]) => new RegExp(`\\b${name}\\b`).test(normalized))?.[1]
            ?? source.match(/^\s*(NNE|NE|ENE|ESE|SE|SSE|SSW|SW|WSW|WNW|NW|NNW|N|E|S|W|VRB)\s*(?:[\u2010-\u2015-]\s*)?/i)?.[1].toUpperCase();
        const speed = source.match(/\d+(?:[.,]\d+)?\s*(?:km\s*\/\s*h|kmh|m\s*\/\s*s|mph|knots?|bft)\b/i)?.[0];
        return [direction, speed].filter(Boolean).join(' ') || source;
    }

    _stat(title, kind, iconName) {
        const box = new St.BoxLayout({...VERTICAL, x_expand: true,
            style_class: 'notchfolk-weather-stat'});
        const heading = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER,
            style_class: 'notchfolk-weather-stat-heading'});
        heading.add_child(new St.Icon({icon_name: iconName, style_class: 'notchfolk-weather-stat-icon'}));
        heading.add_child(label(title, 'notchfolk-weather-stat-title'));
        const valueStyle = kind === 'daylight'
            ? 'notchfolk-weather-stat-value notchfolk-weather-stat-daylight-value'
            : 'notchfolk-weather-stat-value';
        const value = label('', valueStyle, {x_align: Clutter.ActorAlign.CENTER});
        value.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(heading);
        box.add_child(value);
        box._kind = kind;
        return box;
    }

    /** The sky disc takes a restrained tint from the current condition's icon. */
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
        const tone = weatherTone(this._weather?.state?.iconName);
        const gradient = new Cairo.LinearGradient(0, -1, 0, 1);
        gradient.addColorStopRGBA(0, ...tone.disc[0], 1);
        gradient.addColorStopRGBA(1, ...tone.disc[1], 1);
        cr.setSource(gradient);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(...tone.line, 0.55);
        cr.setLineWidth(0.06);
        cr.arc(0, 0, 0.97, 0, 2 * Math.PI);
        cr.stroke();
        cr.restore();
        cr.$dispose();
    }

    /** Adds the current reading to the hourly forecast without changing its source data. */
    _hourlyData() {
        const state = this._weather.state;
        const current = Number.parseFloat(state.temperature);
        const now = Number.isFinite(current) ? [{hour: 'Now', temperature: state.temperature,
            iconName: state.iconName, value: current}] : [];
        const forecast = (state.forecast ?? []).slice(0, CURVE_HOURS - 1).map(slice => ({
            ...slice,
            value: Number.parseFloat(slice.temperature),
        }));
        return [...now, ...forecast].filter(slice => slice.hour && Number.isFinite(slice.value));
    }

    /** The next hours' temperatures, colored by the condition reported for each hour. */
    _paintCurve(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0) {
            cr.$dispose();
            return;
        }
        const hours = this._hourlyData();
        if (hours.length < 2) {
            cr.$dispose();
            return;
        }
        // Match each point to the center of its equal-width label cell below.
        const x = i => width * (i + 0.5) / hours.length;
        const top = px(14);
        const bottom = height - px(14);
        const low = Math.min(...hours.map(slice => slice.value));
        const high = Math.max(...hours.map(slice => slice.value));
        const span = Math.max(high - low, 1);
        const y = value => bottom - (bottom - top) * ((value - low) / span);

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        // Quiet guides give the temperatures a scale without competing with the curve.
        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.setLineWidth(px(1));
        for (let i = 0; i < 4; i++) {
            const guideY = top + (bottom - top) * i / 3;
            cr.moveTo(x(0), guideY);
            cr.lineTo(x(hours.length - 1), guideY);
        }
        cr.stroke();

        // Smooth cubic segments make the filled temperature profile easy to scan.
        const drawCurve = () => {
            cr.moveTo(x(0), y(hours[0].value));
            for (let i = 0; i < hours.length - 1; i++) {
                const previous = hours[Math.max(0, i - 1)].value;
                const current = hours[i].value;
                const next = hours[i + 1].value;
                const following = hours[Math.min(hours.length - 1, i + 2)].value;
                const controlY1 = y(current + (next - previous) / 6);
                const controlY2 = y(next - (following - current) / 6);
                const third = (x(i + 1) - x(i)) / 3;
                cr.curveTo(x(i) + third, controlY1, x(i + 1) - third, controlY2,
                    x(i + 1), y(next));
            }
        };
        const areaGradient = new Cairo.LinearGradient(0, top, 0, bottom);
        const currentTone = weatherTone(hours[0].iconName);
        areaGradient.addColorStopRGBA(0, ...currentTone.line, 0.15);
        areaGradient.addColorStopRGBA(1, ...currentTone.line, 0);
        drawCurve();
        cr.lineTo(x(hours.length - 1), bottom);
        cr.lineTo(x(0), bottom);
        cr.closePath();
        cr.setSource(areaGradient);
        cr.fill();

        // The condition-colored temperature line sits above the fading area fill.
        const lineGradient = new Cairo.LinearGradient(x(0), 0, x(hours.length - 1), 0);
        for (const [index, hour] of hours.entries()) {
            const stop = index / (hours.length - 1);
            lineGradient.addColorStopRGBA(stop, ...weatherTone(hour.iconName).line, 0.98);
        }
        cr.setSource(lineGradient);
        cr.setLineWidth(px(3));
        drawCurve();
        cr.stroke();
        // Each marker uses that hour's condition color.
        for (let i = 0; i < hours.length; i++) {
            cr.setSourceRGBA(...weatherTone(hours[i].iconName).line, 1);
            cr.arc(x(i), y(hours[i].value), px(3), 0, 2 * Math.PI);
            cr.fill();
        }
        cr.$dispose();
    }

    /** The size setting just set the base height for every page; the page keeps its
     * sections' extra height on top of it (see `_syncHeight`). */
    onPageHeight(height) {
        if (height !== PAGE_HEIGHT && height !== LARGE_PAGE_HEIGHT)
            return;
        this._baseHeight = height;
        this._syncHeight();
    }

    /** Keeps a stable viewport; the scroll view appears only when the content exceeds it. */
    _syncHeight() {
        const screenLimit = Math.floor(this._stage.height / uiScale() * 0.62);
        const wanted = Math.min(this._baseHeight + 125, Math.max(this._baseHeight, screenLimit));
        if (wanted === this.pageHeight)
            return;
        this.pageHeight = wanted;
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

    /** The whole sky from the last reading: the hero, the compact facts, the curve and its
     * hours, the days. */
    _update() {
        const state = this._weather.state;
        this._location.text = state.locationName;
        this._icon.icon_name = state.iconName || 'weather-clear-symbolic';
        this._icon.set_style(`color: ${weatherTone(state.iconName).icon};`);
        this._temperature.text = state.temperature;
        this._summary.text = state.summary;
        for (const stat of this._stats.get_children()) {
            const isDaylight = stat._kind === 'daylight';
            stat.visible = !isDaylight || Boolean(state.daylight);
            const value = isDaylight ? state.daylight : state[stat._kind] || '\u2014';
            stat.get_children()[1].text = stat._kind === 'wind' ? this._shortWind(value) : value;
        }

        // Hourly items share the chart's timeline: time, condition, then temperature. "Now"
        // repeats neither the hero temperature nor its summary.
        this._curveLabels.destroy_all_children();
        const hours = this._hourlyData();
        for (const [index, slice] of hours.entries()) {
            const now = index === 0;
            const mark = new St.BoxLayout({...VERTICAL, x_expand: true,
                style_class: `notchfolk-weather-curve-mark${now ? ' next' : ''}`});
            mark.add_child(label(now ? 'Now' : slice.hour, 'notchfolk-weather-hour-time',
                {x_align: Clutter.ActorAlign.CENTER}));
            mark.add_child(new St.Icon({icon_name: slice.iconName || 'weather-clear-symbolic',
                style_class: 'notchfolk-weather-hour-icon', x_align: Clutter.ActorAlign.CENTER}));
            mark.add_child(label(slice.temperature, 'notchfolk-weather-hour-temp',
                {x_align: Clutter.ActorAlign.CENTER}));
            this._curveLabels.add_child(mark);
        }
        this._curveLabels.visible = hours.length > 1;
        this._curve.visible = hours.length > 1;
        if (this._curve.visible)
            this._curve.queue_repaint();

        // The days: each its name, its icon, its warmest and coldest.
        this._days.destroy_all_children();
        for (const [index, day] of (state.daily ?? []).entries()) {
            const card = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-weather-day',
                x_align: index === 0 ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER});
            card.add_child(label(day.name, 'notchfolk-weather-day-name', {x_align: Clutter.ActorAlign.CENTER}));
            card.add_child(new St.Icon({icon_name: day.iconName || 'weather-clear-symbolic',
                style_class: 'notchfolk-weather-hour-icon', x_align: Clutter.ActorAlign.CENTER}));
            card.add_child(label(`${Math.round(day.high)}\u00b0`, 'notchfolk-weather-day-high',
                {x_align: Clutter.ActorAlign.CENTER}));
            card.add_child(label(`${Math.round(day.low)}\u00b0`, 'notchfolk-weather-day-low',
                {x_align: Clutter.ActorAlign.CENTER}));
            this._days.add_child(card);
        }
        this._days.visible = (state.daily ?? []).length > 0;

        this._stats.visible = Boolean(state.humidity || state.wind || state.daylight);
        this._hoursTitle.visible = hours.length > 1;
        this._daysTitle.visible = this._days.visible;
        // No location picked: say so; a location whose reading has not arrived says it is fetching.
        this._empty.visible = !state.locationName;
        this._fetching.visible = Boolean(state.locationName) && !state.temperature;
        this._disc.queue_repaint();
    }

    /** Nearby earthquakes: a severity badge, place name, and compact metadata. */
    _updateQuakes() {
        this._quakes.destroy_all_children();
        for (const [index, quake] of this._quakeWatcher.quakes.entries()) {
            const severity = quake.magnitude >= 5.5 ? 'major' : quake.magnitude >= 4.5 ? 'moderate' : 'minor';
            const row = new St.BoxLayout({x_expand: true,
                style_class: `notchfolk-weather-quake ${severity}`});
            const badge = label(`M${quake.magnitude.toFixed(1)}`,
                `notchfolk-weather-quake-badge ${severity}`);
            row.add_child(badge);
            const text = new St.BoxLayout({...VERTICAL, x_expand: true,
                style_class: 'notchfolk-weather-quake-text'});
            const where = label(quake.where, 'notchfolk-weather-quake-where');
            where.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const distance = Number.isFinite(quake.distance) ? `${Math.round(quake.distance)} km` : '';
            const metadata = label([distance, quake.depth, quake.when].filter(Boolean).join(' \u00b7 '),
                'notchfolk-weather-quake-meta');
            metadata.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(where);
            text.add_child(metadata);
            row.add_child(text);
            this._quakeGrid.attach(row, index % 2, Math.floor(index / 2), 1, 1);
        }
        const has = this._quakeWatcher.quakes.length > 0;
        this._quakeHeading.visible = has;
        this._quakesTitle.visible = has;
        this._quakes.visible = has;
        this._quakesBlock.visible = has;
    }

    destroy() {
        this._weather.disconnect(this._weatherChanged);
        this._weather.destroy();
        this._quakeWatcher.disconnect(this._quakesChanged);
        this._quakeWatcher.destroy();
        super.destroy();
    }
});
