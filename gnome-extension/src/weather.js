// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

// Current conditions for the compact island. GWeather fetches asynchronously; this watcher
// only updates while the closed island is mapped, then stops its timer and request when hidden.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather?version=4.0';

import * as WorldClocks from './worldClocks.js';

const REFRESH_MS = 30 * 60 * 1000;
const APP_ID = 'io.galyarderlabs.notchfolk';
const CONTACT = 'https://github.com/galyarderlabs/notchfolk/issues';

function sunTime(info, getter) {
    const [valid, stamp] = info[getter]?.() ?? [false, 0];
    if (!valid)
        return '';

    const timezone = info.get_location()?.get_timezone?.();
    if (!timezone)
        return '';

    return GLib.DateTime.new_from_unix_utc(Number(stamp))
        ?.to_timezone(timezone)?.format('%H:%M') ?? '';
}

function daylightRange(info) {
    const sunrise = sunTime(info, 'get_value_sunrise');
    const sunset = sunTime(info, 'get_value_sunset');
    return sunrise && sunset ? `${sunrise}\u2013${sunset}` : '';
}

/** Signals `changed` when the current conditions or selected location change. */
export const WeatherWatcher = GObject.registerClass({
    Signals: {'changed': {}},
}, class WeatherWatcher extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._clocks = WorldClocks.shellSettings();
        this._active = false;
        this._info = null;
        this._updated = 0;
        this._refreshTimer = 0;
        this.state = {temperature: '', iconName: '', summary: '', locationName: '', forecast: [],
                    daily: [], feelsLike: '', humidity: '', wind: '', daylight: ''};
        this._settingsIds = [
            settings.connect('changed::weather-enabled', () => this._configure()),
            settings.connect('changed::weather-location', () => this._configure()),
            // A unit change needs no new fetch: the last reading is re-read in the new unit.
            settings.connect('changed::weather-temperature-unit', () => {
                if (this._info?.is_valid())
                    this._refreshState(this._info);
            }),
        ];
        this._clocksId = this._clocks?.connect('changed::locations', () => {
            if (!WorldClocks.hasWeatherLocation(settings))
                this._configure();
        }) ?? 0;
        this._configure();
    }

    get active() {
        return this._active;
    }

    set active(active) {
        active = Boolean(active);
        if (active === this._active)
            return;
        this._active = active;
        if (active)
            this._requestUpdate();
        else {
            this._cancelRefresh();
            this._info?.abort();
        }
    }

    /** The GWeather unit for the chosen setting; DEFAULT follows the locale, as today. An
     * unknown stored value falls back to it too, so the page never shows a wrong unit. */
    _tempUnit() {
        switch (this._settings.get_string('weather-temperature-unit')) {
            case 'celsius':
                return GWeather.TemperatureUnit.CENTIGRADE;
            case 'fahrenheit':
                return GWeather.TemperatureUnit.FAHRENHEIT;
            default:
                return GWeather.TemperatureUnit.DEFAULT;
        }
    }

    /** A temperature as the page shows it: GWeather's own string while Automatic, else the
     * value GWeather answers in the chosen unit, written as GWeather writes it - one decimal,
     * a non-break space, the degree sign and the letter. */
    _tempString(info, stringGetter, valueGetter) {
        const unit = this._tempUnit();
        if (unit === GWeather.TemperatureUnit.DEFAULT)
            return info[stringGetter]?.() ?? '';
        const [valid, value] = info[valueGetter]?.(unit) ?? [false, 0];
        if (!valid)
            return '';
        const letter = unit === GWeather.TemperatureUnit.FAHRENHEIT ? 'F' : 'C';
        return `${value.toFixed(1)}\u00a0\u00b0${letter}`;
    }

    /** A temperature as a number, for the curve and the days' minima and maxima: GWeather's
     * own string parsed while Automatic, else the value GWeather answers in the chosen unit. */
    _tempValue(info) {
        const unit = this._tempUnit();
        if (unit === GWeather.TemperatureUnit.DEFAULT)
            return Number.parseFloat(info.get_temp?.() ?? '');
        const [valid, value] = info.get_value_temp?.(unit) ?? [false, 0];
        return valid ? value : Number.NaN;
    }

    /** The next hours as the page shows them, from GWeather's own forecast list; a GWeather
     * without one answers an empty list, and the page shows only the current conditions. */
    _forecast(info) {
        try {
            return (info.get_forecast_list() ?? []).slice(1, 8).map(slice => {
                const temperature = this._tempString(slice, 'get_temp', 'get_value_temp');
                const iconName = slice.get_icon_name?.() ?? '';
                // The slice's own 'update' time is the time it is for (the reference's
                // words); get_value_update answers [valid, unix seconds]. GWeather
                // carries no get_timestamp - an hour read from nothing hid the curve.
                const [valid, stamp] = slice.get_value_update?.() ?? [false, 0];
                const timestamp = valid ? Number(stamp) : 0;
                const hour = timestamp
                    ? GLib.DateTime.new_from_unix_local(timestamp).format('%H') : '';
                return {temperature, iconName, hour, timestamp};
            }).filter(slice => slice.temperature);
        } catch {
            return [];
        }
    }

    /** The forecast's days: each date's coldest and warmest slice, with the warmest hour's
     * icon - five of them, today first. A GWeather whose forecast carries no timestamps
     * answers an empty list, and the page shows only the hours. */
    _daily(info) {
        try {
            const byDate = new Map();
            for (const slice of (info.get_forecast_list() ?? [])) {
                const [valid, stamp] = slice.get_value_update?.() ?? [false, 0];
                const timestamp = valid ? Number(stamp) : 0;
                const temperature = this._tempValue(slice);
                if (!timestamp || Number.isNaN(temperature))
                    continue;
                const when = GLib.DateTime.new_from_unix_local(timestamp);
                const date = when.format('%Y-%m-%d');
                if (!byDate.has(date))
                    byDate.set(date, {date, name: when.format('%a'), low: temperature,
                        high: temperature, iconName: slice.get_icon_name?.() ?? '',
                        at: timestamp});
                const day = byDate.get(date);
                if (temperature < day.low)
                    day.low = temperature;
                if (temperature >= day.high) {
                    day.high = temperature;
                    day.iconName = slice.get_icon_name?.() ?? day.iconName;
                }
            }
            return [...byDate.values()].slice(0, 5);
        } catch {
            return [];
        }
    }

    /** Drops old city data and creates an async GWeather request for the current setting. */
    _configure() {
        this._cancelRefresh();
        if (this._info) {
            this._info.abort();
            if (this._updated)
                this._info.disconnect(this._updated);
        }
        this._info = null;
        this._updated = 0;
        this.state = {temperature: '', iconName: '', summary: '', locationName: '', forecast: [],
                    daily: [], feelsLike: '', humidity: '', wind: '', daylight: ''};

        const location = this._settings.get_boolean('weather-enabled')
            ? WorldClocks.weatherLocation(this._settings, this._clocks) : null;
        if (!location) {
            this.emit('changed');
            return;
        }

        this.state.locationName = [location.get_city_name() || location.get_name(), location.get_country_name()]
            .filter(Boolean).join(', ');
        const info = GWeather.Info.new(location);
        info.set_application_id(APP_ID);
        info.set_contact_info(CONTACT);
        // METAR reads the airports; met.no covers the world and carries the forecast the
        // page's hours need. Whichever name this GWeather knows, it joins the mask.
        const providers = [GWeather.Provider.METAR, GWeather.Provider.MET_NO, GWeather.Provider.MET,
            GWeather.Provider.YR_NO].filter(provider => provider !== undefined)
            .reduce((mask, provider) => mask | provider, 0);
        info.set_enabled_providers(providers);
        this._info = info;
        this._updated = info.connect('updated', () => this._onUpdated(info));
        this.emit('changed');
        if (this._active)
            this._requestUpdate();
    }

    /** Starts one request and leaves one low-frequency refresh scheduled while visible. */
    _requestUpdate() {
        if (!this._active || !this._info)
            return;
        this._info.update();
        this._cancelRefresh();
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
            this._refreshTimer = 0;
            this._requestUpdate();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRefresh() {
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
    }

    /** Keeps the last successful reading if a later network request fails. */
    _onUpdated(info) {
        if (info !== this._info || !info.is_valid())
            return;
        this._refreshState(info);
    }

    /** The whole reading from one GWeather answer, in the chosen unit: the watcher re-reads
     * the same answer when the unit changes, so no fetch waits on the choice. */
    _refreshState(info) {
        const temperature = this._tempString(info, 'get_temp', 'get_value_temp');
        if (!temperature)
            return;
        this.state = {
            forecast: this._forecast(info),
            daily: this._daily(info),
            feelsLike: this._tempString(info, 'get_apparent', 'get_value_apparent'),
            humidity: info.get_humidity?.() ?? '',
            wind: info.get_wind?.() ?? '',
            daylight: daylightRange(info),
            temperature,
            iconName: info.get_symbolic_icon_name() || 'weather-clear-symbolic',
            summary: info.get_weather_summary() || '',
            locationName: this.state.locationName,
        };
        this.emit('changed');
    }

    destroy() {
        this._active = false;
        this._cancelRefresh();
        if (this._info) {
            this._info.abort();
            if (this._updated)
                this._info.disconnect(this._updated);
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        if (this._clocksId)
            this._clocks.disconnect(this._clocksId);
    }
});
