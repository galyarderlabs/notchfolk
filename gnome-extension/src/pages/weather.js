// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Weather page: the sky as a page of its own, like Focus and Calendar. The location,
// the current conditions large - the condition's icon on a drawn sky disc, the temperature
// beside it, what it feels like, the humidity and the wind under - and the next hours as
// cards. The closed island no longer shows the weather; this page is where it lives now.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {label} from '../widgets.js';
import {WeatherWatcher} from '../weather.js';
import {Page} from './page.js';

/** The sky disc's size, in CSS pixels (see `px`). */
const DISC_SIZE = 64;

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
        const discBox = new St.BoxLayout({style_class: 'notchfolk-weather-disc',
            y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_name: 'weather-clear-symbolic', style_class: 'notchfolk-weather-icon'});
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

        // The next hours, a card each: the hour, the hour's icon, the hour's temperature.
        this._hours = new St.BoxLayout({style_class: 'notchfolk-weather-hours'});

        column.add_child(this._location);
        column.add_child(hero);
        column.add_child(this._stats);
        column.add_child(this._hours);
        this.add_child(column);

        this._weather = new WeatherWatcher(settings);
        this._weatherChanged = this._weather.connect('changed', () => this._update());
        this._update();
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
        const size = area.get_surface_size();
        const [width, height] = [size[0], size[1]];
        const radius = Math.min(width, height) / 2;
        cr.save();
        cr.translate(width / 2, height / 2);
        cr.scale(radius, radius);
        const gradient = new Cairo.LinearGradient(0, -1, 0, 1);
        gradient.addColorStopRgb(0, 0.55, 0.74, 0.92);
        gradient.addColorStopRgb(1, 0.24, 0.42, 0.66);
        cr.setSource(gradient);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRgb(1, 1, 1);
        cr.setLineWidth(0.06);
        cr.arc(0, 0, 0.97, 0, 2 * Math.PI);
        cr.stroke();
        cr.restore();
        gradient.destroy();
        cr.$dispose();
    }

    /** The page on screen is when the sky is worth fetching; off it, the watcher rests. */
    onActivate() {
        this._weather.active = true;
    }

    onDeactivate() {
        this._weather.active = false;
    }

    /** The whole sky from the last reading: the hero, the three facts, the hours. */
    _update() {
        const state = this._weather.state;
        this._location.text = state.locationName;
        this._icon.icon_name = state.iconName || 'weather-clear-symbolic';
        this._temperature.text = state.temperature;
        this._summary.text = state.summary;
        for (const stat of this._stats.get_children())
            stat.get_children()[1].text = state[stat._kind] || '—';
        this._hours.destroy_all_children();
        for (const slice of state.forecast) {
            const card = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-weather-hour'});
            card.add_child(label(slice.hour, 'notchfolk-weather-hour-time'));
            card.add_child(new St.Icon({icon_name: slice.iconName || 'weather-clear-symbolic',
                style_class: 'notchfolk-weather-hour-icon'}));
            card.add_child(label(slice.temperature, 'notchfolk-weather-hour-temp'));
            this._hours.add_child(card);
        }
        this._hours.visible = state.forecast.length > 0;
        this._stats.visible = Boolean(state.feelsLike || state.humidity || state.wind);
        this._disc.queue_repaint();
    }

    destroy() {
        this._weather.disconnect(this._weatherChanged);
        this._weather.destroy();
        super.destroy();
    }
});
