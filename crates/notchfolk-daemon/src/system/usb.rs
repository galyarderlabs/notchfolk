// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

//! The USB devices on the bus, for the Devices page: which ones are plugged in, what each is
//! (a drive, a keyboard, a headset…), and their names as udev's hardware database spells them.
//! Hubs are not devices to show — neither a root hub nor a plain one — and USB carries no battery
//! to read, so the page shows a card's kind where Bluetooth's shows its battery.

use std::collections::BTreeSet;

use zbus::object_server::InterfaceRef;

use super::{SystemService, UsbDevice, publish};

/// What a device can be, in the order the page names them: first match wins, so a headset with
/// controls is audio, and a phone that also mounts as a drive is a phone.
const KIND_ORDER: &[&str] = &["drive", "keyboard", "mouse", "audio", "camera", "phone"];

/// Every USB device on the bus, hubs and root hubs apart.
fn list() -> Vec<UsbDevice> {
    let Ok(mut enumerator) = udev::Enumerator::new() else {
        return Vec::new();
    };
    if enumerator.match_subsystem("usb").is_err() {
        return Vec::new();
    }
    let mut devices = Vec::new();
    let Ok(connected) = enumerator.scan_devices() else {
        return Vec::new();
    };
    for device in connected {
        // The bus's own devices, not the interfaces under them.
        if device.devtype().and_then(|devtype| devtype.to_str()) != Some("usb_device") {
            continue;
        }
        // A hub joins others to the bus; a root hub is the bus itself. Neither is a device to show.
        if device
            .attribute_value("bDeviceClass")
            .and_then(|class| class.to_str())
            .is_some_and(|class| class.trim() == "09")
        {
            continue;
        }
        if let Some(device) = read(&device) {
            devices.push(device);
        }
    }
    devices.sort_by(|a, b| a.path.cmp(&b.path));
    devices
}

/// The device as the page shows it: its name (the hardware database's, else the one it reports),
/// its vendor, and its kind by its interfaces' classes.
fn read(device: &udev::Device) -> Option<UsbDevice> {
    let property = |name: &str| {
        device
            .property_value(name)
            .and_then(|value| value.to_str())
            .map(str::to_owned)
    };
    let attribute = |name: &str| {
        device
            .attribute_value(name)
            .and_then(|value| value.to_str())
            .map(str::to_owned)
    };
    let name = property("ID_MODEL_FROM_DATABASE")
        .or_else(|| attribute("product"))
        .or_else(|| property("ID_MODEL"))
        .unwrap_or_else(|| "USB device".to_owned());
    Some(UsbDevice {
        path: device.syspath().to_string_lossy().into_owned(),
        name,
        vendor: property("ID_VENDOR_FROM_DATABASE").or_else(|| attribute("manufacturer")),
        kind: kind(device),
    })
}

/// What the device is, by its interfaces' classes: a drive, a keyboard, a mouse, a headset, a
/// camera or a phone; whatever it is not, it is a USB device.
fn kind(device: &udev::Device) -> String {
    let mut classes = BTreeSet::new();
    let mut hid = BTreeSet::new();
    let Ok(mut interfaces) = udev::Enumerator::new() else {
        return "usb".to_owned();
    };
    if interfaces.match_subsystem("usb").is_err() || interfaces.match_parent(device).is_err() {
        return "usb".to_owned();
    }
    if let Ok(found) = interfaces.scan_devices() {
        for interface in found {
            if interface.devtype().and_then(|devtype| devtype.to_str()) != Some("usb_interface") {
                continue;
            }
            let Some(class) = interface
                .attribute_value("bInterfaceClass")
                .and_then(|class| class.to_str())
                .map(str::trim)
            else {
                continue;
            };
            classes.insert(class.to_owned());
            // A HID interface's protocol says which it is: 1 a keyboard, 2 a mouse.
            if class == "03"
                && let Some(protocol) = interface
                    .attribute_value("bInterfaceProtocol")
                    .and_then(|protocol| protocol.to_str())
                    .map(str::trim)
            {
                match protocol {
                    "1" => hid.insert("keyboard".to_owned()),
                    "2" => hid.insert("mouse".to_owned()),
                    _ => false,
                };
            }
            // A phone's vendor-specific interface: Android Debug Bridge or MTP.
            if class == "ff"
                && interface
                    .driver()
                    .and_then(|driver| driver.to_str())
                    .is_some_and(|driver| driver == "adb" || driver == "mtp")
            {
                hid.insert("phone".to_owned());
            }
        }
    }
    for kind in KIND_ORDER {
        let is = match *kind {
            "drive" => classes.contains("08"),
            "keyboard" => hid.contains("keyboard"),
            "mouse" => hid.contains("mouse"),
            "audio" => classes.contains("01"),
            "camera" => classes.contains("0e") || classes.contains("06"),
            _ => hid.contains("phone"),
        };
        if is {
            return (*kind).to_owned();
        }
    }
    "usb".to_owned()
}

/// Follows the bus: the list is read once at the start and again whenever a device is added or
/// removed, and published each time it changed. udev's monitor blocks, so it runs on a thread of
/// its own and hands the list to the async side.
pub async fn watch(iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    // Room for a plug's burst of events; the thread blocks on a full channel rather than miss one.
    let (sender, mut receiver) = tokio::sync::mpsc::channel(16);
    std::thread::spawn(move || {
        // The receiver gone (the watcher restarted, or Notchfolk is stopping): stop reading the bus.
        let send = |devices| sender.blocking_send(devices).is_ok();
        if !send(list()) {
            return;
        }
        let monitor = udev::MonitorBuilder::new()
            .and_then(|builder| builder.match_subsystem_devtype("usb", "usb_device"))
            .and_then(|builder| builder.listen());
        let socket = match monitor {
            Ok(socket) => socket,
            Err(error) => {
                log::warn!("the USB monitor could not be opened: {error}");
                return;
            }
        };
        // Several events come with one plug; the list is read once per event, and publishing an
        // unchanged list changes nothing (see `publish`).
        for event in socket.iter() {
            let changed = event
                .action()
                .and_then(|action| action.to_str())
                .is_some_and(|action| action == "add" || action == "remove");
            if changed && !send(list()) {
                return;
            }
        }
    });
    // As GSConnect's watcher: no SystemEvent, for USB drives no alert; the state change itself
    // is what refreshes the page (see `publish`).
    while let Some(devices) = receiver.recv().await {
        publish(&iface, |state| state.usb = devices.clone(), None).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page's kinds are what the extension names its icons by: they must not change silently.
    #[test]
    fn kinds_are_the_pages_vocabulary() {
        assert_eq!(
            KIND_ORDER,
            ["drive", "keyboard", "mouse", "audio", "camera", "phone"]
        );
    }
}
