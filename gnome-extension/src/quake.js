// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

// Recent earthquakes from BMKG's public feed (data.bmkg.go.id), for the Weather page's
// earth section: the quakes Indonesia's own meteorology agency reports, M5.0 and up,
// with their magnitude, depth, where they sat and when. The watcher only fetches while
// the Weather page is on screen, then rests; a feed that fails answers an empty list,
// the page showing only the sky.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

const FEED_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json';
const REFRESH_MS = 15 * 60 * 1000;

/** Signals `changed` when the feed answers or fails. */
export const QuakeWatcher = GObject.registerClass({
    Signals: {'changed': {}},
}, class QuakeWatcher extends GObject.Object {
    _init() {
        super._init();
        this._active = false;
        this._refreshTimer = 0;
        this._session = new Soup.Session();
        this.quakes = [];
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
        else
            this._cancel();
    }

    _request() {
        const message = Soup.Message.new('GET', FEED_URL);
        this._session.send_and_read_async(message, 0, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const feed = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                this.quakes = (feed?.Infogempa?.gempa ?? []).slice(0, 3).map(quake => ({
                    magnitude: Number.parseFloat(quake.Magnitude) || 0,
                    depth: quake.Kedalaman ?? '',
                    where: quake.Wilayah ?? '',
                    when: [quake.Tanggal, quake.Jam].filter(Boolean).join(' · '),
                    tsunami: quake.Potensi?.includes('berpotensi') ?? false,
                }));
            } catch {
                this.quakes = [];
            }
            this.emit('changed');
            if (this._active) {
                this._cancel();
                this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
                    this._refreshTimer = 0;
                    this._request();
                    return GLib.SOURCE_REMOVE;
                });
            }
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
    }
});
