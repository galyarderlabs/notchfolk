// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// The Weather page: the sky as a page of its own, like Focus and Calendar - the location,
// the temperature large, the condition's icon and words, and the next hours in a row. The
// closed island no longer shows the weather; this page is where it lives now.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {label} from '../widgets.js';
import {WeatherWatcher} from '../weather.js';
import {Page} from './page.js';

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
        this._icon = new St.Icon({icon_name: 'weather-clear-symbolic', style_class: 'notchfolk-weather-icon'});
        this._temperature = label('', 'notchfolk-weather-temperature');
        this._summary = label('', 'notchfolk-weather-summary');
        const now = new St.BoxLayout({style_class: 'notchfolk-weather-now'});
        now.add_child(this._icon);
        now.add_child(this._temperature);
        this._hours = new St.BoxLayout({style_class: 'notchfolk-weather-hours'});
        column.add_child(this._location);
        column.add_child(now);
        column.add_child(this._summary);
        column.add_child(this._hours);
        this.add_child(column);

        this._weather = new WeatherWatcher(settings);
        this._weatherChanged = this._weather.connect('changed', () => this._update());
        this._update();
    }

    /** The page on screen is when the sky is worth fetching; off it, the watcher rests. */
    onActivate() {
        this._weather.active = true;
    }

    onDeactivate() {
        this._weather.active = false;
    }

    /** The location, the current conditions large, and the next hours in a row. */
    _update() {
        const {temperature, iconName, summary, locationName, forecast} = this._weather.state;
        this._location.text = locationName;
        this._icon.icon_name = iconName || 'weather-clear-symbolic';
        this._temperature.text = temperature;
        this._summary.text = summary;
        this._hours.destroy_all_children();
        for (const slice of forecast) {
            const hour = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-weather-hour'});
            hour.add_child(label(slice.hour, 'notchfolk-weather-hour-time'));
            hour.add_child(new St.Icon({icon_name: slice.iconName || 'weather-clear-symbolic',
                style_class: 'notchfolk-weather-hour-icon'}));
            hour.add_child(label(slice.temperature, 'notchfolk-weather-hour-temp'));
            this._hours.add_child(hour);
        }
        this._hours.visible = forecast.length > 0;
    }

    destroy() {
        this._weather.disconnect(this._weatherChanged);
        this._weather.destroy();
        super.destroy();
    }
});
