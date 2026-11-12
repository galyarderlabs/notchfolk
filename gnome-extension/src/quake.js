// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// Nearby earthquakes for the city selected in Weather. BMKG supplies Indonesia; USGS
// supplies other locations, and fills gaps when BMKG has no recent nearby event.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

import * as WorldClocks from './worldClocks.js';

const BMKG_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json';
const USGS_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const REFRESH_MS = 15 * 60 * 1000;
const RADIUS_KM = 300;
const USGS_MIN_MAGNITUDE = 2.5;
const USGS_LOOKBACK_DAYS = 7;

function coordinates(location) {
    if (!location?.has_coords())
        return null;
    const [latitude, longitude] = location.get_coords();
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] : null;
}

function distanceKm(a, b) {
    const radians = degrees => degrees * Math.PI / 180;
    const dLat = radians(b[0] - a[0]);
    const dLon = radians(b[1] - a[1]);
    const arc = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[0])) * Math.cos(radians(b[0]))
        * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function fromBmkg(feed, center) {
    return (feed?.Infogempa?.gempa ?? []).map(quake => {
        const [latitude, longitude] = (quake.Coordinates ?? '').split(',').map(Number);
        return {
            magnitude: Number.parseFloat(quake.Magnitude) || 0,
            depth: quake.Kedalaman ?? '',
            where: quake.Wilayah ?? '',
            when: [quake.Tanggal, quake.Jam].filter(Boolean).join(' · '),
            distance: Number.isFinite(latitude) && Number.isFinite(longitude)
                ? distanceKm(center, [latitude, longitude]) : Infinity,
        };
    }).filter(quake => quake.magnitude > 0 && quake.distance <= RADIUS_KM)
        .sort((a, b) => a.distance - b.distance);
}

function fromUsgs(feed) {
    return (feed?.features ?? []).map(feature => {
        const properties = feature.properties ?? {};
        const depthKm = feature.geometry?.coordinates?.[2];
        const time = Number(properties.time);
        const when = Number.isFinite(time)
            ? GLib.DateTime.new_from_unix_utc(Math.floor(time / 1000))?.format('%d %b · %H:%M UTC') ?? ''
            : '';
        return {
            magnitude: Number(properties.mag) || 0,
            depth: Number.isFinite(depthKm) ? `${Math.round(depthKm)} km` : '',
            where: properties.place ?? '',
            when,
        };
    }).filter(quake => quake.magnitude > 0);
}

function usgsUrl([latitude, longitude]) {
    const start = GLib.DateTime.new_now_utc().add_days(-USGS_LOOKBACK_DAYS).format('%Y-%m-%d');
    const query = `format=geojson&starttime=${start}&latitude=${latitude}&longitude=${longitude}`
        + `&maxradiuskm=${RADIUS_KM}&minmagnitude=${USGS_MIN_MAGNITUDE}&orderby=time&limit=12`;
    return `${USGS_URL}?${query}`;
}

/** Signals `changed` when nearby earthquake data arrives. */
export const QuakeWatcher = GObject.registerClass({
    Signals: {'changed': {}},
}, class QuakeWatcher extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._clocks = WorldClocks.shellSettings();
        this._active = false;
        this._refreshTimer = 0;
        this._requestToken = 0;
        this._session = new Soup.Session();
        this.location = null;
        this.sourceName = 'USGS';
        this.quakes = [];
        this._settingsId = settings.connect('changed::weather-location', () => this._configure());
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
            this._request();
        else {
            this._requestToken++;
            this._cancel();
        }
    }

    _configure() {
        this._cancel();
        this._requestToken++;
        this.location = WorldClocks.weatherLocation(this._settings, this._clocks);
        this.sourceName = this.location?.get_country() === 'ID' ? 'BMKG' : 'USGS';
        this.quakes = [];
        this.emit('changed');
        if (this._active)
            this._request();
    }

    _request() {
        if (!this._active)
            return;
        const center = coordinates(this.location);
        if (!center) {
            this.quakes = [];
            this.emit('changed');
            return;
        }
        const token = ++this._requestToken;
        this._fetch(this.sourceName === 'BMKG' ? BMKG_URL : usgsUrl(center), token, center,
            this.sourceName);
    }

    _fetch(url, token, center, source) {
        const message = Soup.Message.new('GET', url);
        this._session.send_and_read_async(message, 0, null, (session, result) => {
            let quakes = [];
            try {
                const bytes = session.send_and_read_finish(result);
                const feed = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                quakes = source === 'BMKG' ? fromBmkg(feed, center) : fromUsgs(feed);
            } catch {
                // A failed regional feed falls back to the global catalog below.
            }
            if (token !== this._requestToken || !this._active)
                return;

            if (source === 'BMKG' && !quakes.length) {
                this._fetch(usgsUrl(center), token, center, 'USGS');
                return;
            }
            this.sourceName = source;
            this.quakes = quakes.slice(0, 3);
            this.emit('changed');
            this._cancel();
            this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
                this._refreshTimer = 0;
                this._request();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _cancel() {
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
    }

    destroy() {
        this.active = false;
        this._settings.disconnect(this._settingsId);
        if (this._clocksId)
            this._clocks.disconnect(this._clocksId);
    }
});
