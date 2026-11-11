// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

// Control Center: the macOS-style quick controls as an island page — a row of toggle tiles
// (Wi-Fi, Bluetooth, AirDrop, Dark Mode, Focus, Screen Recording) over the brightness and
// volume sliders and a compact media strip. The control approach follows MacOs-CC-Gnome
// (MIT, https://github.com/Keyunge/MacOs-CC-Gnome): NetworkManager and BlueZ on the system
// bus, the Shell's brightness manager (GNOME 49+) with the SettingsDaemon Power fallback,
// the Shell's Screencast service, and the desktop interface colour scheme — but the tiles,
// the layout and the wiring are Notchfolk's own, reusing its audio, notifications and media
// where they already exist.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {VERTICAL} from '../compat.js';
import * as Playback from '../playback.js';
import {Slider, fence, icon, iconButton, label, setEnabled} from '../widgets.js';
import {Page} from './page.js';

// Gio._promisify once, so the D-Bus calls below can await.
Gio._promisify(Gio.DBusProxy.prototype, 'init_async', 'init_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

/** NetworkManager and BlueZ are SYSTEM bus services; the screencast and the power plugin are session bus. */
const NM_NAME = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const NM_IFACE = 'org.freedesktop.NetworkManager';
const NM_CONNECTION_IFACE = 'org.freedesktop.NetworkManager.Connection.Active';
const BLUEZ_NAME = 'org.bluez';
const BLUEZ_PATH = '/';
const BLUEZ_ADAPTER_IFACE = 'org.bluez.Adapter1';
const POWER_NAME = 'org.gnome.SettingsDaemon.Power';
const POWER_PATH = '/org/gnome/SettingsDaemon/Power';
const POWER_SCREEN_IFACE = 'org.gnome.SettingsDaemon.Power.Screen';
const SCREENCAST_NAME = 'org.gnome.Shell.Screencast';
const SCREENCAST_PATH = '/org/gnome/Shell/Screencast';
const SCREENCAST_IFACE = 'org.gnome.Shell.Screencast';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const DBUS_PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

/** A D-Bus proxy, with its properties-changed handler kept on it so it can be detached on destroy. */
function createProxy({bus = Gio.DBus.session, busName, objectPath, interfaceName, onPropertiesChanged = null}) {
    const proxy = new Gio.DBusProxy({
        g_connection: bus,
        g_name: busName,
        g_object_path: objectPath,
        g_interface_name: interfaceName,
        g_flags: Gio.DBusProxyFlags.NONE,
    });
    if (onPropertiesChanged)
        proxy._ccPropertiesChangedId = proxy.connect('g-properties-changed', (_proxy, changed) => onPropertiesChanged(changed));
    return proxy;
}

/** Detaches a proxy's handler so nothing keeps the page reachable. */
function disposeProxy(proxy) {
    if (proxy?._ccPropertiesChangedId) {
        proxy.disconnect(proxy._ccPropertiesChangedId);
        proxy._ccPropertiesChangedId = 0;
    }
}

/** Initialises a proxy and checks that something is really on the other end: `init_async()` only fails when
 * the connection itself is broken, so the name owner — not the init result — decides whether a service counts. */
async function initProxy(proxy) {
    try {
        await proxy.init_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        return false;
    }
    return Boolean(proxy.g_name_owner);
}

/** Writes a property through org.freedesktop.DBus.Properties, on whichever bus the proxy was built for. */
async function setDBusProperty(proxy, interfaceName, propertyName, value) {
    if (!proxy)
        return false;
    const connection = proxy.get_connection() ?? Gio.DBus.session;
    try {
        await connection.call(
            proxy.get_name(), proxy.get_object_path(), DBUS_PROPERTIES_IFACE, 'Set',
            new GLib.Variant('(ssv)', [interfaceName, propertyName, value]),
            null, Gio.DBusCallFlags.NONE, -1, null);
        return true;
    } catch (e) {
        return false;
    }
}

/** The file-sharing apps MacOs-CC calls AirDrop, by desktop id or binary, in the order it prefers them. */
function findFileTransferApps() {
    const appSystem = Shell.AppSystem.get_default();
    const apps = [];
    for (const [kind, desktopId, binary] of [
        ['localsend', 'org.localsend.localsend_app', 'localsend'],
        ['blip', 'net.blip.Blip', 'blip'],
    ]) {
        const app = appSystem.lookup_app(desktopId);
        if (app) {
            apps.push({kind, name: app.get_name() || (kind === 'blip' ? 'Blip' : 'LocalSend'), app});
            continue;
        }
        if (GLib.find_program_in_path(binary))
            apps.push({kind, name: kind === 'blip' ? 'Blip' : 'LocalSend', command: binary});
    }
    return apps;
}

/** A toggle tile: an icon, a title and a status line, in a button that holds its own on/off state. */
const Tile = GObject.registerClass(
class Tile extends St.Button {
    _init({iconName, title, subtitle, toggle = true, onClick}) {
        super._init({
            style_class: 'notchfolk-control-tile',
            toggle_mode: toggle,
            can_focus: true,
            x_expand: true,
        });
        const column = new St.BoxLayout({...VERTICAL, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({gicon: icon(iconName), icon_size: 20, style_class: 'notchfolk-control-tile-icon'});
        this._title = label(title, 'notchfolk-control-tile-title');
        this._subtitle = label(subtitle, 'notchfolk-control-tile-subtitle');
        // A network name can be longer than the tile; it is cut off, not allowed to spill over.
        this._subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        column.add_child(this._icon);
        column.add_child(this._title);
        column.add_child(this._subtitle);
        this.set_child(column);
        this.connect('clicked', () => onClick(this.checked));
    }

    setIcon(iconName) {
        this._icon.gicon = icon(iconName);
    }

    setSubtitle(text) {
        this._subtitle.text = text;
    }
});

/** The Control Center page: quick toggles, sliders and media, in the island. */
export const ControlCenterPage = GObject.registerClass(
class ControlCenterPage extends Page {
    _init(daemon, audio, notifications, {height}) {
        super._init(daemon, {
            style_class: 'notchfolk-page notchfolk-control',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL, spacing: 8}),
            height,
        });
        this.name = 'control';
        this._audio = audio;
        this._notifications = notifications;
        this._proxies = [];
        this._bluezOwnerId = 0;
        this._brightnessSyncing = false;
        this._recording = false;

        // A row of six toggle tiles, each as wide as the next.
        this._tiles = new St.BoxLayout({style_class: 'notchfolk-control-tiles', x_expand: true});
        this._wifiTile = new Tile({iconName: 'notchfolk-wifi-symbolic', title: 'Wi-Fi', subtitle: 'Off',
            onClick: checked => this._onWifiClicked(checked)});
        this._bluetoothTile = new Tile({iconName: 'notchfolk-bluetooth-symbolic', title: 'Bluetooth', subtitle: 'Off',
            onClick: checked => this._onBluetoothClicked(checked)});
        this._airdropTile = new Tile({iconName: 'notchfolk-display-symbolic', title: 'AirDrop', subtitle: 'Off', toggle: false,
            onClick: () => this._onAirDropClicked()});
        this._darkTile = new Tile({iconName: 'notchfolk-moon', title: 'Dark Mode', subtitle: 'Off',
            onClick: checked => this._onDarkClicked(checked)});
        this._focusTile = new Tile({iconName: 'notchfolk-timer-symbolic', title: 'Focus', subtitle: 'Off',
            onClick: checked => this._onFocusClicked(checked)});
        this._recordTile = new Tile({iconName: 'notchfolk-record-symbolic', title: 'Record', subtitle: 'Off',
            onClick: checked => this._onRecordClicked(checked)});
        for (const tile of [this._wifiTile, this._bluetoothTile, this._airdropTile, this._darkTile, this._focusTile, this._recordTile])
            this._tiles.add_child(tile);

        // The sliders and the media strip underneath: brightness, volume, then what is playing.
        this._bottom = new St.BoxLayout({style_class: 'notchfolk-control-bottom', x_expand: true});
        this._brightnessRow = new St.BoxLayout({style_class: 'notchfolk-control-slider-row', x_expand: true});
        this._brightnessIcon = new St.Icon({gicon: icon('notchfolk-sun-symbolic'), icon_size: 16, y_align: Clutter.ActorAlign.CENTER});
        this._brightnessSlider = new Slider({scrollStep: 0.05});
        this._brightnessRow.add_child(this._brightnessIcon);
        this._brightnessRow.add_child(this._brightnessSlider);
        this._volumeRow = new St.BoxLayout({style_class: 'notchfolk-control-slider-row', x_expand: true});
        this._volumeButton = iconButton('audio-volume-high-symbolic', 'notchfolk-control-volume-button',
            () => this._audio.toggleMuted(), {size: 16, accessibleName: 'Mute or unmute'});
        this._volumeSlider = new Slider({scrollStep: 0.05});
        this._volumeRow.add_child(this._volumeButton);
        this._volumeRow.add_child(this._volumeSlider);
        this._media = new St.BoxLayout({style_class: 'notchfolk-control-media', x_expand: true});
        this._mediaCover = new St.Icon({gicon: icon('notchfolk-music'), icon_size: 28, style_class: 'notchfolk-control-media-cover'});
        const mediaText = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._mediaTitle = label('Not Playing', 'notchfolk-control-media-title');
        this._mediaArtist = label('No media player', 'notchfolk-control-media-artist');
        this._mediaTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._mediaArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        mediaText.add_child(this._mediaTitle);
        mediaText.add_child(this._mediaArtist);
        this._mediaPlay = iconButton('media-playback-start-symbolic', 'notchfolk-control-media-play',
            () => this.daemon.call('media', 'PlayPause'), {size: 18, accessibleName: 'Play or pause'});
        this._media.add_child(this._mediaCover);
        this._media.add_child(mediaText);
        this._media.add_child(this._mediaPlay);
        this._bottom.add_child(this._brightnessRow);
        this._bottom.add_child(this._volumeRow);
        this._bottom.add_child(this._media);

        this.add_child(this._tiles);
        this.add_child(this._bottom);
        fence(this);

        this._brightnessSlider.connect('value-changed', (_slider, value) => this._onBrightnessChanged(value));
        this._volumeSlider.connect('value-changed', (_slider, value) => {
            this._audio.volume = value;
        });
        this._audioIds = [audio.connect('changed', () => this._syncVolume())];
        this._notificationsId = notifications.connect('dnd-changed', () => this._syncFocus());
        this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
        this._interfaceId = this._interfaceSettings.connect('changed::color-scheme', () => this._syncDark());
        this.watch(['nowPlaying'], () => this._syncMedia());
        this.connect('destroy', () => this._onDestroy());

        this._initWifi();
        this._initBluetooth();
        this._initBrightness();
        this._initAirDrop();
        this._syncDark();
        this._syncFocus();
        this._syncVolume();
        this._syncMedia();
    }

    /** Refreshed as it comes on screen, so a toggle moved elsewhere is not stale. */
    onActivate() {
        this._syncWifi();
        this._syncBluetooth();
        this._syncDark();
        this._syncFocus();
        this._syncVolume();
        this._syncMedia();
        this._syncBrightness();
    }

    /* ---------------------------------------------------------------- Wi-Fi */

    async _initWifi() {
        this._wifiProxy = createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: NM_PATH,
            interfaceName: NM_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('WirelessEnabled', null))
                    this._syncWifi();
                if (changed.lookup_value('PrimaryConnection', null))
                    this._syncWifiConnection();
            },
        });
        this._proxies.push(this._wifiProxy);
        if (!await initProxy(this._wifiProxy) || this._destroyed) {
            this._wifiProxy = null;
            setEnabled(this._wifiTile, false);
            this._wifiTile.setSubtitle('Unavailable');
            return;
        }
        this._syncWifi();
        await this._syncWifiConnection();
    }

    _syncWifi() {
        const enabled = this._wifiProxy?.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        const connected = enabled && Boolean(this._wifiConnectionName);
        this._wifiTile.checked = enabled;
        this._wifiTile.setIcon(enabled ? 'notchfolk-wifi-symbolic' : 'notchfolk-wifi-off-symbolic');
        this._wifiTile.setSubtitle(connected ? this._wifiConnectionName : enabled ? 'On' : 'Off');
    }

    async _syncWifiConnection() {
        this._disposeWifiConnectionProxy();
        this._wifiConnectionName = '';
        const path = this._wifiProxy?.get_cached_property('PrimaryConnection')?.unpack();
        if (!path || path === '/') {
            this._syncWifi();
            return;
        }
        const proxy = createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: path,
            interfaceName: NM_CONNECTION_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Id', null) && this._wifiConnectionProxy === proxy)
                    this._setWifiConnectionName(proxy);
            },
        });
        this._proxies.push(proxy);
        this._wifiConnectionProxy = proxy;
        if (!await initProxy(proxy) || this._wifiConnectionProxy !== proxy || this._destroyed)
            return;
        this._setWifiConnectionName(proxy);
    }

    _disposeWifiConnectionProxy() {
        const proxy = this._wifiConnectionProxy;
        this._wifiConnectionProxy = null;
        if (!proxy)
            return;
        const index = this._proxies.indexOf(proxy);
        if (index !== -1)
            this._proxies.splice(index, 1);
        disposeProxy(proxy);
    }

    _setWifiConnectionName(proxy) {
        const type = proxy.get_cached_property('Type')?.unpack() ?? '';
        // Only show a network name when the primary connection really is Wi-Fi (on a wired machine it is Ethernet).
        this._wifiConnectionName = type === '802-11-wireless' ? proxy.get_cached_property('Id')?.unpack() ?? '' : '';
        this._syncWifi();
    }

    _onWifiClicked(checked) {
        setDBusProperty(this._wifiProxy, NM_IFACE, 'WirelessEnabled', new GLib.Variant('b', checked));
    }

    /* ------------------------------------------------------------ Bluetooth */

    async _initBluetooth() {
        // bluetoothd comes and goes; re-arm when it (re)appears.
        if (!this._bluezOwnerId) {
            this._bluezOwnerId = Gio.DBus.system.signal_subscribe(
                DBUS_NAME, DBUS_IFACE, 'NameOwnerChanged', DBUS_PATH, BLUEZ_NAME,
                Gio.DBusSignalFlags.NONE,
                (_connection, _sender, _path, _iface, _signal, params) => {
                    const [, , newOwner] = params.deepUnpack();
                    if (newOwner && !this._destroyed) {
                        this._adapterProxy = null;
                        this._initBluetooth();
                    }
                });
        }
        const adapterPath = await this._findAdapterPath();
        if (this._destroyed)
            return;
        if (!adapterPath) {
            this._adapterProxy = null;
            setEnabled(this._bluetoothTile, false);
            this._bluetoothTile.setSubtitle('Unavailable');
            return;
        }
        if (this._adapterProxy?.get_object_path() === adapterPath) {
            this._syncBluetooth();
            return;
        }
        this._adapterProxy = createProxy({
            bus: Gio.DBus.system,
            busName: BLUEZ_NAME,
            objectPath: adapterPath,
            interfaceName: BLUEZ_ADAPTER_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Powered', null))
                    this._syncBluetooth();
            },
        });
        this._proxies.push(this._adapterProxy);
        if (!await initProxy(this._adapterProxy) || this._destroyed) {
            this._adapterProxy = null;
            setEnabled(this._bluetoothTile, false);
            this._bluetoothTile.setSubtitle('Unavailable');
            return;
        }
        this._syncBluetooth();
    }

    /** The object path of the first BlueZ adapter, or null when there is none. */
    async _findAdapterPath() {
        try {
            const reply = await Gio.DBus.system.call(
                BLUEZ_NAME, BLUEZ_PATH, OBJECT_MANAGER_IFACE, 'GetManagedObjects',
                null, new GLib.VariantType('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE, -1, null);
            const [objects] = reply.deepUnpack();
            return Object.keys(objects).find(path => BLUEZ_ADAPTER_IFACE in objects[path]) ?? null;
        } catch (e) {
            return null;
        }
    }

    _syncBluetooth() {
        const powered = this._adapterProxy?.get_cached_property('Powered')?.unpack() ?? false;
        this._bluetoothTile.checked = powered;
        this._bluetoothTile.setIcon(powered ? 'notchfolk-bluetooth-symbolic' : 'notchfolk-bluetooth-off-symbolic');
        this._bluetoothTile.setSubtitle(powered ? 'On' : 'Off');
    }

    async _onBluetoothClicked(checked) {
        // BlueZ refuses to power the adapter off while it is discoverable, so the two writes are serialised.
        if (!checked)
            await setDBusProperty(this._adapterProxy, BLUEZ_ADAPTER_IFACE, 'Discoverable', new GLib.Variant('b', false));
        await setDBusProperty(this._adapterProxy, BLUEZ_ADAPTER_IFACE, 'Powered', new GLib.Variant('b', checked));
    }

    /* --------------------------------------------------------------- AirDrop */

    _initAirDrop() {
        const apps = findFileTransferApps();
        this._fileTransferApps = apps;
        if (!apps.length) {
            setEnabled(this._airdropTile, false);
            this._airdropTile.setSubtitle('Not installed');
            return;
        }
        // LocalSend first when both are there; a chooser is not built (one tap opens the first).
        this._airdropTile.setSubtitle(apps[0].name);
    }

    _onAirDropClicked() {
        const app = this._fileTransferApps?.[0];
        if (!app)
            return;
        try {
            if (app.app)
                app.app.activate();
            else if (app.command)
                Gio.AppInfo.create_from_commandline(app.command, null, Gio.AppInfoCreateFlags.NONE)
                    .launch([], global.create_app_launch_context(0, -1));
        } catch (e) {
            // The app is there but would not start: leave the tile as it is.
        }
    }

    /* ------------------------------------------------------------ Brightness */

    _initBrightness() {
        // GNOME 49+ manages brightness in the Shell itself.
        this._brightnessManager = Main.brightnessManager ?? null;
        if (this._brightnessManager) {
            this._brightnessManager.connectObject('changed', () => this._syncBrightness(), this);
            this._syncBrightness();
            return;
        }
        // Fallback for older shells: the power plugin owns the screen backlight.
        this._brightnessProxy = createProxy({
            busName: POWER_NAME,
            objectPath: POWER_PATH,
            interfaceName: POWER_SCREEN_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Brightness', null))
                    this._syncBrightnessSlider();
            },
        });
        this._proxies.push(this._brightnessProxy);
        initProxy(this._brightnessProxy).then(available => {
            if (this._destroyed)
                return;
            if (!available) {
                this._brightnessProxy = null;
                this._brightnessRow.hide();
                return;
            }
            this._syncBrightnessSlider();
        });
    }

    _syncBrightness() {
        const scale = this._brightnessManager?.globalScale ?? null;
        if (this._brightnessScale !== scale) {
            this._brightnessScale?.disconnectObject(this);
            this._brightnessScale = scale;
            scale?.connectObject('notify::value', () => this._syncBrightnessSlider(), this);
        }
        this._brightnessRow.visible = scale !== null;
        this._syncBrightnessSlider();
    }

    _syncBrightnessSlider() {
        let value = null;
        if (this._brightnessScale)
            value = this._brightnessScale.value;
        else if (this._brightnessProxy)
            value = (this._brightnessProxy.get_cached_property('Brightness')?.unpack() ?? 0) / 100;
        if (value === null) {
            this._brightnessRow.hide();
            return;
        }
        this._brightnessSyncing = true;
        this._brightnessSlider.value = Math.min(1, Math.max(0, value));
        this._brightnessSyncing = false;
    }

    _onBrightnessChanged(value) {
        if (this._brightnessSyncing)
            return;
        if (this._brightnessScale)
            this._brightnessScale.value = value;
        else if (this._brightnessProxy)
            setDBusProperty(this._brightnessProxy, POWER_SCREEN_IFACE, 'Brightness',
                new GLib.Variant('i', Math.round(value * 100)));
    }

    /* ---------------------------------------------------------------- Volume */

    _syncVolume() {
        this._volumeSlider.value = this._audio.volume;
        const button = this._volumeButton;
        if (button) {
            const iconName = this._audio.iconName;
            const child = button.get_child();
            if (child instanceof St.Icon)
                child.gicon = icon(iconName);
        }
        setEnabled(this._volumeRow, this._audio.hasOutput);
    }

    /* ------------------------------------------------------------- Dark Mode */

    _syncDark() {
        const dark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        this._darkTile.checked = dark;
        this._darkTile.setSubtitle(dark ? 'On' : 'Off');
    }

    _onDarkClicked(checked) {
        this._interfaceSettings.set_string('color-scheme', checked ? 'prefer-dark' : 'prefer-light');
    }

    /* ----------------------------------------------------------------- Focus */

    _syncFocus() {
        const on = this._notifications.dnd;
        this._focusTile.checked = on;
        this._focusTile.setSubtitle(on ? 'On' : 'Off');
    }

    _onFocusClicked(checked) {
        this._notifications.dnd = checked;
    }

    /* ------------------------------------------------------- Screen Recording */

    async _onRecordClicked(checked) {
        if (checked)
            await this._startRecording();
        else
            await this._stopRecording();
    }

    async _startRecording() {
        const directory = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.get_home_dir();
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
        const template = GLib.build_filenamev([directory, `Screencast from ${stamp}.webm`]);
        try {
            const reply = await Gio.DBus.session.call(
                SCREENCAST_NAME, SCREENCAST_PATH, SCREENCAST_IFACE, 'Screencast',
                new GLib.Variant('(sa{sv})', [template, {
                    framerate: GLib.Variant.new_int32(30),
                    'draw-cursor': GLib.Variant.new_boolean(true),
                }]),
                new GLib.VariantType('(bs)'),
                Gio.DBusCallFlags.NONE, -1, null);
            const [success] = reply.deepUnpack();
            this._recording = Boolean(success);
        } catch (e) {
            this._recording = false;
        }
        this._recordTile.checked = this._recording;
        this._recordTile.setSubtitle(this._recording ? 'Recording' : 'Off');
    }

    async _stopRecording() {
        try {
            await Gio.DBus.session.call(
                SCREENCAST_NAME, SCREENCAST_PATH, SCREENCAST_IFACE, 'StopScreencast',
                null, new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            // The recording may already have ended; the tile still goes off.
        }
        this._recording = false;
        this._recordTile.checked = false;
        this._recordTile.setSubtitle('Off');
    }

    /* ------------------------------------------------------------------ Media */

    _syncMedia() {
        const nowPlaying = this.daemon.state.nowPlaying;
        const hasTrack = Playback.showsClosed(nowPlaying);
        this._mediaTitle.text = hasTrack ? nowPlaying.title : 'Not Playing';
        this._mediaArtist.text = hasTrack
            ? [nowPlaying.artist, nowPlaying.album].filter(Boolean).join(' — ') || nowPlaying.identity
            : 'No media player';
        setEnabled(this._mediaPlay, hasTrack);
        const child = this._mediaPlay.get_child();
        if (child instanceof St.Icon)
            child.gicon = icon(Playback.isPlaying(nowPlaying) ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');
    }

    /* -------------------------------------------------------------- Teardown */

    _onDestroy() {
        for (const id of this._audioIds ?? [])
            this._audio.disconnect(id);
        if (this._notificationsId)
            this._notifications.disconnect(this._notificationsId);
        if (this._interfaceId)
            this._interfaceSettings.disconnect(this._interfaceId);
        if (this._bluezOwnerId) {
            Gio.DBus.system.signal_unsubscribe(this._bluezOwnerId);
            this._bluezOwnerId = 0;
        }
        for (const proxy of this._proxies)
            disposeProxy(proxy);
        this._proxies = [];
        this._brightnessScale?.disconnectObject(this);
        this._brightnessManager?.disconnectObject(this);
    }
});
