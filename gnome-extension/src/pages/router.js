// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

// Router: compact usage totals, a live token-flow sparkline, and the latest requests.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import {icon, label} from '../widgets.js';
import {Page} from './page.js';

/** The periods the header offers, in order; Settings' own words. */
const PERIODS = ['today', '24h', '7d'];
/** How each period reads on the header's toggle. */
const PERIOD_LABELS = {today: 'Today', '24h': '24h', '7d': '7d'};
/** The gateway keeps at most ten recent requests; the compact list scrolls through them. */
const RECENT_REQUESTS = 10;
/** A small graph repaint only while this page is visible. */
const ACTIVITY_TICK_MS = 40;

/** Compact token counts: 1.2M, 845K, 900. */
function tokens(count) {
    if (count >= 1_000_000)
        return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (count >= 1000)
        return `${Math.round(count / 1000)}K`;
    return `${count ?? 0}`;
}

/** A relative time: "2m ago", "3h ago". */
function ago(atMs) {
    const seconds = Math.max(0, (Date.now() - atMs) / 1000);
    if (seconds < 60)
        return 'now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/** Hide provider routing IDs when they are appended to an otherwise useful model name. */
function displayModel(model) {
    return model
        .replace(/\s*\(openai-compatible[^)]*\)$/i, '')
        .replace(/-openai-compatible-chat-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, '');
}

export const RouterPage = GObject.registerClass(
class RouterPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, settings, {height}) {
        super._init(daemon, {
            style_class: 'notchfolk-page notchfolk-router',
            layout_manager: new Clutter.BinLayout(),
            height,
            reactive: true,
        });
        this.name = 'router';
        this._settings = settings;
        this._activityPhase = 0;
        this._activitySamples = [];

        const layout = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-router-layout',
            x_expand: true, y_expand: true});

        const heading = new St.BoxLayout({style_class: 'notchfolk-router-heading'});
        heading.add_child(new St.Icon({gicon: icon('notchfolk-router'), icon_size: 16}));
        heading.add_child(label('Router', 'notchfolk-router-title'));
        const status = new St.BoxLayout({style_class: 'notchfolk-router-status-pill'});
        this._statusDot = new St.Widget({style_class: 'notchfolk-router-status-dot waiting'});
        this._statusLine = label('Connecting', 'notchfolk-router-status');
        status.add_child(this._statusDot);
        status.add_child(this._statusLine);
        heading.add_child(status);
        // The period toggle in the header, kept in step with Settings.
        this._periodToggle = new St.BoxLayout({style_class: 'notchfolk-router-periods'});
        this._periodToggle.x_expand = true;
        this._periodToggle.x_align = Clutter.ActorAlign.END;
        this._periodButtons = {};
        for (const period of PERIODS) {
            const button = new St.Button({style_class: 'notchfolk-router-period', can_focus: true,
                label: PERIOD_LABELS[period], accessible_name: `Router period ${PERIOD_LABELS[period]}`});
            button.connect('clicked', () => this._setPeriod(period));
            this._periodToggle.add_child(button);
            this._periodButtons[period] = button;
        }
        heading.add_child(this._periodToggle);
        layout.add_child(heading);

        // Three clear totals stay legible in the notch: requests, token flow, and estimated cost.
        const metrics = new St.BoxLayout({style_class: 'notchfolk-router-metrics', x_expand: true});
        this._metricValues = {};
        for (const [key, title] of Object.entries({
            requests: 'Requests',
            tokens: 'Tokens in / out',
            cost: 'Est. cost',
        })) {
            const card = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-router-metric', x_expand: true});
            card.add_child(label(title, 'notchfolk-router-metric-label'));
            const value = label('—', 'notchfolk-router-metric-value');
            card.add_child(value);
            this._metricValues[key] = value;
            metrics.add_child(card);
        }
        layout.add_child(metrics);

        // A live sparkline and the latest requests use the same short row instead of competing for height.
        const content = new St.BoxLayout({style_class: 'notchfolk-router-content', x_expand: true, y_expand: true});
        const activity = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-router-activity', y_expand: true});
        const activityHeading = new St.BoxLayout({style_class: 'notchfolk-router-section-heading'});
        activityHeading.add_child(label('Activity', 'notchfolk-router-section-title'));
        this._activityMeta = label('Waiting', 'notchfolk-router-activity-meta', {x_expand: true,
            x_align: Clutter.ActorAlign.END});
        activityHeading.add_child(this._activityMeta);
        activity.add_child(activityHeading);
        this._activityGraph = new St.DrawingArea({style_class: 'notchfolk-router-chart', x_expand: true, y_expand: true,
            accessible_name: 'Token activity for recent requests'});
        this._activityGraph.connect('repaint', area => this._paintActivity(area));
        activity.add_child(this._activityGraph);
        const topModel = new St.BoxLayout({style_class: 'notchfolk-router-top-model'});
        topModel.add_child(label('TOP', 'notchfolk-router-top-tag'));
        this._topModel = label('No model activity', 'notchfolk-router-top-name', {x_expand: true});
        this._topModel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topModel.add_child(this._topModel);
        activity.add_child(topModel);
        content.add_child(activity);

        this._recent = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-router-section notchfolk-router-recent',
            x_expand: true, y_expand: true});
        const recentHeading = new St.BoxLayout({style_class: 'notchfolk-router-section-heading'});
        recentHeading.add_child(label('Recent requests', 'notchfolk-router-section-title'));
        this._recentMeta = label('', 'notchfolk-router-activity-meta', {x_expand: true,
            x_align: Clutter.ActorAlign.END});
        recentHeading.add_child(this._recentMeta);
        this._recent.add_child(recentHeading);
        this._recentScroll = new St.ScrollView({
            style_class: 'notchfolk-router-recent-scroll',
            accessible_name: 'Recent Router requests',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            y_expand: true,
        });
        this._recentList = new St.BoxLayout({...VERTICAL, style_class: 'notchfolk-router-request-list', x_expand: true});
        this._recentScroll.set_child(this._recentList);
        this._recent.add_child(this._recentScroll);
        content.add_child(this._recent);
        layout.add_child(content);

        this.add_child(layout);
        this._syncPeriodButtons();
        this.watch(['router'], () => this._update());
        this._settingsChanged = [
            settings.connect('changed::router-period', () => this._syncPeriodButtons()),
            settings.connect('changed::router-enabled', () => this._syncAvailability()),
        ];
        this.connect('destroy', () => this._settingsChanged.forEach(id => settings.disconnect(id)));
        this._update();
    }

    /** As notchfolkd last read it. */
    get _router() {
        return this.daemon.state.router;
    }

    /** The page stays available while enabled, so it can explain an offline or unconfigured gateway. */
    get available() {
        return this._settings.get_boolean('router-enabled');
    }

    /** Has notchfolkd poll while the page is on screen. */
    onActivate() {
        this.daemon.attemptQuietly('router', 'SetWatching', true);
        this.daemon.attemptQuietly('router', 'Refresh');
        this._animateActivity();
    }

    onDeactivate() {
        // The chip keeps its own watch; the page's ends with it.
        this.cancel('router-activity');
        this.daemon.attemptQuietly('router', 'SetWatching', this._settings.get_boolean('router-notch'));
    }

    /** Lays the numbers out again from the daemon's last reading, at most once a second. */
    _update() {
        const router = this._router;
        const key = JSON.stringify(router);
        this._syncAvailability();
        if (key === this._key)
            return;
        this._key = key;
        const stats = router?.stats ?? {};
        const connected = router?.status === 'connected';
        this._metricValues.requests.text = connected ? Number(stats.requests ?? 0).toLocaleString() : '—';
        this._metricValues.tokens.text = connected
            ? `${tokens(stats.prompt_tokens)} / ${tokens(stats.completion_tokens)}` : '—';
        this._metricValues.cost.text = connected ? `$${Number(stats.cost ?? 0).toFixed(2)}` : '—';
        const statusText = {
            connected: router?.version ? `Connected · ${router?.version}` : 'Connected',
            outdated: 'Update your gateway first',
            unauthorized: 'Authentication failed · check Router settings',
            unreachable: 'Gateway offline · check its URL and make sure it is running',
            'invalid-response': 'Proxy connected, but its usage response is unsupported',
            'needs-local-setup': 'Local token not found · run the gateway on this computer',
            'needs-credentials': 'Add the password or proxy API key in Router settings',
            'needs-configuration': 'Add the Remote base URL in Router settings',
            'keyring-unavailable': 'GNOME Keyring is locked or unavailable',
            'https-required': 'Remote credentials require HTTPS (HTTP works on this computer only)',
        }[router?.status] ?? 'Waiting for the gateway · configure it in Router settings';
        const shortStatus = {
            connected: 'Connected',
            outdated: 'Update needed',
            unauthorized: 'Auth failed',
            unreachable: 'Offline',
            'invalid-response': 'Unsupported',
            'needs-local-setup': 'Setup needed',
            'needs-credentials': 'Credentials needed',
            'needs-configuration': 'URL needed',
            'keyring-unavailable': 'Keyring locked',
            'https-required': 'HTTPS required',
        }[router?.status] ?? 'Waiting';
        this._statusLine.text = shortStatus;
        this._statusLine.accessible_name = statusText;
        this._statusLine.tooltip_text = statusText;
        const statusClass = connected ? 'connected' : ['unauthorized', 'outdated'].includes(router?.status)
            ? 'error' : ['needs-local-setup', 'needs-credentials', 'needs-configuration', 'keyring-unavailable', 'https-required']
                .includes(router?.status) ? 'setup' : 'offline';
        this._statusLine.set_style_class_name(`notchfolk-router-status ${statusClass}`);
        this._statusDot.set_style_class_name(`notchfolk-router-status-dot ${statusClass}${stats.active ? ' busy' : ''}`);
        this._activitySamples = connected ? (stats.recent ?? []).slice(0, 10).reverse()
            .map(request => Math.max(0, Number(request.prompt_tokens ?? 0) + Number(request.completion_tokens ?? 0))) : [];
        this._activityMeta.text = stats.active ? `${stats.active} live` : this._activitySamples.length
            ? `${this._activitySamples.length} recent` : 'Waiting';
        this._recentMeta.text = connected ? `${Number(stats.requests ?? 0).toLocaleString()} total` : '';
        const leader = (stats.by_model ?? [])[0];
        this._topModel.text = connected && leader ? `${displayModel(leader.model)} · ${tokens(leader.tokens)}`
            : 'No model activity';
        this._buildRecent(stats.recent ?? []);
        this._activityGraph.queue_repaint();
    }

    _syncAvailability() {
        const available = this.available;
        if (available === this._wasAvailable)
            return;
        this._wasAvailable = available;
        this.emit('availability-changed');
    }

    /** The period Settings picked, on the header's toggle. */
    _syncPeriodButtons() {
        const picked = this._settings.get_string('router-period');
        for (const period of PERIODS) {
            if (period === picked)
                this._periodButtons[period].add_style_class_name('picked');
            else
                this._periodButtons[period].remove_style_class_name('picked');
        }
    }

    /** The header's period toggle changes both the page and the notch chip. */
    _setPeriod(period) {
        this._settings.set_string('router-period', period);
        this._syncPeriodButtons();
        this.daemon.attemptQuietly('router', 'Refresh');
    }

    /** The glow cursor moves over real request samples; an idle wave says the chart is waiting for data. */
    _animateActivity() {
        if (!this.active || !St.Settings.get().enable_animations)
            return;
        this._activityPhase = (this._activityPhase + 0.012) % 1;
        this._activityGraph.queue_repaint();
        this.later('router-activity', ACTIVITY_TICK_MS, () => this._animateActivity());
    }

    _paintActivity(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0) {
            cr.$dispose();
            return;
        }

        const left = px(4);
        const right = Math.max(left + 1, width - px(4));
        const top = px(5);
        const bottom = Math.max(top + 1, height - px(5));
        const span = right - left;
        const rise = bottom - top;

        cr.setLineWidth(px(1));
        cr.setSourceRGBA(1, 1, 1, 0.055);
        for (const fraction of [0.35, 0.72]) {
            const y = top + rise * fraction;
            cr.moveTo(left, y);
            cr.lineTo(right, y);
            cr.stroke();
        }

        let values = this._activitySamples;
        let points;
        if (values.length) {
            if (values.length === 1)
                values = [values[0], values[0]];
            const peak = Math.max(1, ...values);
            points = values.map((value, index) => ({
                x: left + span * index / (values.length - 1),
                y: bottom - Math.max(0.08, Math.log1p(value) / Math.log1p(peak)) * rise,
            }));
        } else {
            points = Array.from({length: 20}, (_, index) => {
                const t = index / 19;
                const pulse = Math.sin(t * Math.PI * 4 + this._activityPhase * Math.PI * 2);
                return {x: left + span * t, y: bottom - px(4) - pulse * px(1.4)};
            });
        }

        cr.moveTo(points[0].x, bottom);
        cr.lineTo(points[0].x, points[0].y);
        for (const point of points.slice(1))
            cr.lineTo(point.x, point.y);
        cr.lineTo(points[points.length - 1].x, bottom);
        cr.closePath();
        const areaFill = new Cairo.LinearGradient(0, top, 0, bottom);
        areaFill.addColorStopRGBA(0, 0.18, 0.92, 0.6, this._activitySamples.length ? 0.2 : 0.08);
        areaFill.addColorStopRGBA(1, 0.18, 0.92, 0.6, 0.005);
        cr.setSource(areaFill);
        cr.fill();

        const line = () => {
            cr.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1))
                cr.lineTo(point.x, point.y);
        };
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setSourceRGBA(0.16, 0.94, 0.62, 0.15);
        cr.setLineWidth(px(5));
        line();
        cr.stroke();
        cr.setSourceRGBA(0.34, 0.98, 0.68, 0.96);
        cr.setLineWidth(px(1.5));
        line();
        cr.stroke();

        const progress = this._activityPhase * (points.length - 1);
        const segment = Math.min(points.length - 2, Math.floor(progress));
        const mix = progress - segment;
        const cursor = {
            x: points[segment].x + (points[segment + 1].x - points[segment].x) * mix,
            y: points[segment].y + (points[segment + 1].y - points[segment].y) * mix,
        };
        const halo = new Cairo.RadialGradient(cursor.x, cursor.y, 0, cursor.x, cursor.y, px(8));
        halo.addColorStopRGBA(0, 0.36, 1, 0.74, 0.55);
        halo.addColorStopRGBA(1, 0.18, 0.92, 0.6, 0);
        cr.setSource(halo);
        cr.arc(cursor.x, cursor.y, px(8), 0, Math.PI * 2);
        cr.fill();
        cr.setSourceRGBA(0.78, 1, 0.88, 1);
        cr.arc(cursor.x, cursor.y, px(1.8), 0, Math.PI * 2);
        cr.fill();
        cr.$dispose();
    }

    /** Rebuilds the last requests: model, in→out tokens, ok/error, relative time. */
    _buildRecent(recent) {
        this._recentList.destroy_all_children();
        if (!recent.length) {
            this._recentList.add_child(label('No requests in this period', 'notchfolk-router-empty'));
            return;
        }
        for (const request of recent.slice(0, RECENT_REQUESTS)) {
            const row = new St.BoxLayout({style_class: `notchfolk-router-request${request.ok ? '' : ' error'}`,
                x_expand: true});
            const name = label(displayModel(request.model), 'notchfolk-router-request-model', {x_expand: true,
                accessible_name: request.model});
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            name.tooltip_text = request.model;
            row.add_child(name);
            const flow = label(`${tokens(request.prompt_tokens)} → ${tokens(request.completion_tokens)}`,
                'notchfolk-router-request-tokens', {accessible_name: `${tokens(request.prompt_tokens)} input tokens, ${tokens(request.completion_tokens)} output tokens`});
            row.add_child(flow);
            const result = new St.BoxLayout({style_class: 'notchfolk-router-request-result'});
            result.add_child(new St.Widget({style_class: `notchfolk-router-result-dot${request.ok ? '' : ' error'}`}));
            result.add_child(label(request.ok ? 'OK' : 'ERR', 'notchfolk-router-request-state'));
            row.add_child(result);
            row.add_child(label(request.at_ms ? ago(request.at_ms) : '—', 'notchfolk-router-request-time'));
            this._recentList.add_child(row);
        }
    }
});
