// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

// The camera, from the notch: a photo, or a video, with the computer's camera.
// A live preview fills the page — ffmpeg in the daemon overwriting one JPEG
// ~8 times a second, the page decoding it as it changes — with the shutter
// and record buttons in a row under it, and the last capture as a thumbnail
// beside them; tap it and it opens in the default viewer. The daemon owns
// capture (Camera1 over ffmpeg); this page only asks and shows. Off until its
// switch in Settings is on; the tab shows whenever it is on, and the page says
// in the daemon's own words when there is no camera or no ffmpeg.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import {Thumbnails} from '../thumbnails.js';
import {coverKey, icon, iconButton, label} from '../widgets.js';
import {Page} from './page.js';

/** The last capture's thumbnail, in CSS pixels. */
const THUMB_SIZE = 40;
/** How often the recording time is re-read, in milliseconds. */
const TICK_MS = 1000;
/** How often the preview JPEG is re-read, in milliseconds. */
const PREVIEW_MS = 125;

export const CameraPage = GObject.registerClass(
class CameraPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'notchfolk-page notchfolk-camera-page',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'camera';
        /** The path the thumbnail on screen is of, if any; a capture still in flight. */
        this._lastPath = null;
        this._busy = false;
        /** The preview JPEG's key (path + mtime) the image on screen is of, if any. */
        this._previewKey = null;
        /** A StartPreview call is in flight; the daemon's answer is its own guard. */
        this._previewStarting = false;
        this._thumbnails = new Thumbnails();
        this.connect('destroy', () => {
            this._thumbnails.destroy();
            // The page is gone: the preview child in the daemon would keep
            // holding the camera for nobody. Best effort; attempt never throws.
            this.daemon.attempt('camera', 'StopPreview');
        });

        // The live preview: one JPEG the daemon overwrites ~8 times a second,
        // decoded as it changes into this image, centred in the bin.
        // St.ImageContent, not Clutter.Image: Clutter.Image was removed in
        // GNOME Shell 48 (Mutter 48.alpha), and St.ImageContent is its
        // replacement since Shell 45 — it covers every version we support.
        this._liveBin = new St.Bin({style_class: 'notchfolk-camera-preview',
            x_expand: true, y_expand: true});
        this._liveImage = new St.ImageContent();
        this._liveActor = new Clutter.Actor({content: this._liveImage,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._liveBin.child = this._liveActor;

        // The controls under the preview: the last capture, the shutter, the
        // record toggle, and what is happening beside them.
        const controls = new St.BoxLayout({style_class: 'notchfolk-camera-controls'});
        this._thumb = new St.Button({style_class: 'notchfolk-camera-thumb',
            can_focus: true, accessible_name: 'Open the last capture'});
        this._preview = new St.Bin({style_class: 'notchfolk-shelf-preview',
            width: px(THUMB_SIZE), height: px(THUMB_SIZE)});
        this._thumb.child = this._preview;
        this._thumb.connect('clicked', () => this._openLast());
        this._thumbLabel = label('', 'notchfolk-camera-name', {x_expand: true});
        // No capture yet: say so from the first frame. _updateCapture() returns
        // early when the path is unchanged, so this cannot wait for the state.
        this._thumbLabel.text = 'No photo or video yet';
        this._preview.child = new St.Icon({gicon: icon('notchfolk-camera-symbolic'),
            icon_size: 28});
        this._shutter = iconButton('notchfolk-camera-symbolic',
            'notchfolk-button-round notchfolk-camera-shutter',
            () => this._capturePhoto(), {size: 24, accessibleName: 'Take a photo'});
        this._record = iconButton('notchfolk-record-symbolic',
            'notchfolk-button-round notchfolk-camera-record',
            () => this._toggleRecording(), {size: 16, accessibleName: 'Record a video'});
        this._hint = label('', 'notchfolk-camera-hint', {x_expand: true});
        controls.add_child(this._thumb);
        controls.add_child(this._thumbLabel);
        controls.add_child(this._shutter);
        controls.add_child(this._record);
        controls.add_child(this._hint);

        this._body = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
            style_class: 'notchfolk-camera-body'});
        this._body.add_child(this._liveBin);
        this._body.add_child(controls);
        this._status = label('', 'notchfolk-camera-status',
            {x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._body);
        this.add_child(this._status);

        this.watch(['camera'], () => this._update());
        this._update();
    }

    /** Called as the page comes on screen: the recording time starts moving again. */
    onActivate() {
        this._update();
    }

    /** Called as the page goes off screen: the preview stops with it, so a
     * closed island costs nothing and the camera is free. */
    onDeactivate() {
        this.cancel('preview');
        this.daemon.attempt('camera', 'StopPreview');
    }

    /** Starts the live preview, if the page is on screen and the camera is
     * free; a running preview only needs its frames re-read. */
    async _startPreview() {
        if (!this.active || this._destroyed || this._previewStarting)
            return;
        const state = this.daemon.state.camera;
        if (!state?.available || state.recording)
            return;
        if (state.preview) {
            this._tickPreview();
            return;
        }
        this._previewStarting = true;
        const {error, unknownMethod} = await this.daemon.attempt('camera', 'StartPreview');
        this._previewStarting = false;
        if (this._destroyed || !this.active)
            return;
        if (error || unknownMethod) {
            this._hint.text = error ?? 'Restart notchfolkd to use the camera';
            return;
        }
        this._tickPreview();
    }

    /** One preview frame: the JPEG decoded at the bin's size, when it changed
     * since the last one, and again shortly while the page is open. A frame
     * torn mid-write fails its decode and is skipped; the last good one stays. */
    _tickPreview() {
        if (!this.active || this._destroyed)
            return;
        const path = this.daemon.state.camera?.preview_path ?? null;
        if (!path) {
            // The preview is not running (a photo or a recording stopped it);
            // the next state change starts it again.
            return;
        }
        const key = coverKey(path);
        if (key !== this._previewKey) {
            const width = Math.round(this._liveBin.width);
            const height = Math.round(this._liveBin.height);
            if (width >= 10 && height >= 10) {
                try {
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                        path, width, height, true);
                    this._liveImage.set_data(
                        global.stage.context.get_backend().get_cogl_context(),
                        pixbuf.get_pixels(),
                        pixbuf.get_has_alpha()
                            ? Cogl.PixelFormat.RGBA_8888
                            : Cogl.PixelFormat.RGB_888,
                        pixbuf.get_width(), pixbuf.get_height(),
                        pixbuf.get_rowstride());
                    this._previewKey = key;
                } catch {
                    // Torn mid-write: keep the last good frame.
                }
            }
        }
        this.later('preview', PREVIEW_MS, () => this._tickPreview());
    }

    /** A photo with the camera; the new thumbnail arrives with the state. */
    async _capturePhoto() {
        if (this._busy)
            return;
        this._busy = true;
        this._shutter.reactive = false;
        const {error, unknownMethod} = await this.daemon.attempt('camera', 'CapturePhoto');
        this._busy = false;
        this._shutter.reactive = true;
        if (error || unknownMethod)
            this._hint.text = error ?? 'Restart notchfolkd to use the camera';
    }

    /** Starts a recording, or stops the one running. */
    async _toggleRecording() {
        if (this._busy)
            return;
        const recording = Boolean(this.daemon.state.camera?.recording);
        const method = recording ? 'StopRecording' : 'StartRecording';
        this._busy = true;
        this._record.reactive = false;
        const {error, unknownMethod} = await this.daemon.attempt('camera', method);
        this._busy = false;
        this._record.reactive = true;
        if (error || unknownMethod)
            this._hint.text = error ?? 'Restart notchfolkd to use the camera';
    }

    /** Opens the last capture in the default viewer. */
    _openLast() {
        if (!this._lastPath)
            return;
        Gio.AppInfo.launch_default_for_uri_async(GLib.filename_to_uri(this._lastPath, null),
            global.create_app_launch_context(0, -1), null, null);
    }

    /** The page as the daemon's state says it is. */
    _update() {
        const state = this.daemon.state.camera;
        if (!state) {
            // The daemon has not reported yet.
            this._body.visible = false;
            this._status.visible = true;
            this._status.text = 'Starting the camera…';
            return;
        }
        if (!state.available) {
            this.cancel('tick');
            this.cancel('preview');
            this._body.visible = false;
            this._status.visible = true;
            this._status.text = state.error ?? 'No camera on this computer';
            return;
        }
        this._body.visible = true;
        this._status.visible = false;
        const recording = Boolean(state.recording);
        this._shutter.reactive = !this._busy && !recording;
        this._record.reactive = !this._busy;
        this._record.child.gicon = icon(recording
            ? 'notchfolk-stop-symbolic' : 'notchfolk-record-symbolic');
        if (recording) {
            this._updateElapsed();
            // The daemon stopped the preview for the recording; the tick
            // would read a file that no longer changes.
            this.cancel('preview');
        } else {
            this.cancel('tick');
            // A photo or a recording stopped the preview; the page starts it
            // again, and a running one only needs its frames re-read.
            this._startPreview();
        }
        if (!recording)
            this._hint.text = state.error ?? '';
        this._updateCapture(state.last_capture);
    }

    /** The recording time, re-read once a second while it records. */
    _updateElapsed() {
        const state = this.daemon.state.camera;
        if (!state?.recording)
            return;
        const seconds = Math.max(0, Math.floor((Date.now() - state.recording_started) / 1000));
        this._hint.text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        this.later('tick', TICK_MS, () => this._updateElapsed());
    }

    /** The last capture's thumbnail and name, when it is a new one. */
    _updateCapture(last) {
        const path = last?.path ?? null;
        if (path === this._lastPath)
            return;
        this._lastPath = path;
        this._preview.style = '';
        this._preview.remove_style_class_name('thumbnail');
        this._preview.child = null;
        if (!path) {
            this._thumbLabel.text = 'No photo or video yet';
            this._preview.child = new St.Icon({gicon: icon('notchfolk-camera-symbolic'),
                icon_size: 28});
            return;
        }
        this._thumbLabel.text = GLib.path_get_basename(path);
        const uri = GLib.filename_to_uri(path, null);
        this._thumbnails.get(uri).then(shown => {
            if (this._destroyed || this._lastPath !== path || !shown)
                return;
            if (shown.image) {
                this._preview.add_style_class_name('thumbnail');
                this._preview.style = `background-image: url("${GLib.filename_to_uri(shown.image, null).replace(/"/g, '%22')}");`;
                this._preview.child = null;
            } else if (shown.gicon) {
                this._preview.child = new St.Icon({gicon: shown.gicon, icon_size: 28});
            }
        });
    }
});
