// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Galyarder Labs

//! The machine's vitals, sampled from `/proc`, `sysfs` and `statvfs` — the sources the
//! daemon already knows — and published to the island as the weather is. The plan:
//! `docs/vitals-spec.md`.

use std::time::Duration;
use tokio::time::MissedTickBehavior;
use zbus::interface;
use zbus::object_server::InterfaceRef;

/// Sampled this often (the setting's own value); the page ticks with it.
const SAMPLE: Duration = Duration::from_secs(2);

/// The CPU's two reads sit this far apart (ms): the delta between them is the usage.
const CPU_GAP: Duration = Duration::from_millis(250);

/// Everything the vitals page shows, published as one JSON over D-Bus.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Vitals {
    /// The aggregate CPU usage, 0-100.
    pub cpu_percent: f64,
    /// Each core's usage, 0-100, in `/proc/stat`'s own order.
    pub cpu_cores: Vec<f64>,
    /// Memory used and total (bytes).
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    /// Swap used and total (bytes); total 0 when the machine has none.
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
    /// The hottest thermal zone that reads (°C); 0 when none does (a desktop).
    pub temperature_c: f64,
    /// The network's rates since the last sample (bytes/s).
    pub network_down_bytes_per_s: f64,
    pub network_up_bytes_per_s: f64,
    /// The root filesystem's used and total (bytes).
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
    /// The machine's uptime (seconds), from /proc/uptime.
    pub uptime_seconds: u64,
    /// The load averages (1, 5, 15 minutes), from /proc/loadavg.
    pub load_1: f64,
    pub load_5: f64,
    pub load_15: f64,
    /// The running processes (count), from /proc's own numeric directories.
    pub process_count: u64,
    /// The CPU's current frequency (MHz), from /proc/cpuinfo; 0 when it does not say.
    pub cpu_frequency_mhz: f64,
}

impl Vitals {
    /// One sample: every source read once, the deltas from the ones before.
    fn sample(previous: Option<&Vitals>, net_totals: Option<(u64, u64)>) -> Vitals {
        let _ = previous;
        let (cpu_percent, cpu_cores) = cpu_usage();
        let (memory_used, memory_total) = memory();
        let (swap_used, swap_total) = swap();
        let temperature = temperature();
        let (down, up) = network(net_totals);
        let (disk_used, disk_total) = disk();
        let uptime = uptime_seconds();
        let (load_1, load_5, load_15) = load_average();
        let process_count = processes();
        let cpu_frequency = cpu_frequency();
        Vitals {
            uptime_seconds: uptime,
            load_1,
            load_5,
            load_15,
            process_count,
            cpu_frequency_mhz: cpu_frequency,
            cpu_percent,
            cpu_cores,
            memory_used_bytes: memory_used,
            memory_total_bytes: memory_total,
            swap_used_bytes: swap_used,
            swap_total_bytes: swap_total,
            temperature_c: temperature,
            network_down_bytes_per_s: down,
            network_up_bytes_per_s: up,
            disk_used_bytes: disk_used,
            disk_total_bytes: disk_total,
        }
    }
}

/// One CPU's usage between two reads of `/proc/stat`'s counters, as a percentage.
fn core_usage(before: &[u64], after: &[u64]) -> f64 {
    if before.len() != after.len() || before.len() < 5 {
        return 0.0;
    }
    let before_total: u64 = before[0..5].iter().sum();
    let after_total: u64 = after[0..5].iter().sum();
    let before_idle = before[3] + before.get(4).copied().unwrap_or(0);
    let after_idle = after[3] + after.get(4).copied().unwrap_or(0);
    let total = after_total.saturating_sub(before_total);
    let idle = after_idle.saturating_sub(before_idle);
    if total == 0 {
        return 0.0;
    }
    ((total - idle) as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
}

/// Every CPU line in `/proc/stat` (aggregate first, then the cores), as counter vectors.
fn cpu_counters() -> Vec<Vec<u64>> {
    std::fs::read_to_string("/proc/stat")
        .map(|text| {
            text.lines()
                .filter(|line| line.starts_with("cpu"))
                .map(|line| {
                    line.split_whitespace()
                        .skip(1)
                        .filter_map(|number| number.parse().ok())
                        .collect()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The CPU's usage: the aggregate and each core, from two reads a gap apart.
fn cpu_usage() -> (f64, Vec<f64>) {
    let before = cpu_counters();
    std::thread::sleep(CPU_GAP);
    let after = cpu_counters();
    let aggregate = before
        .first()
        .zip(after.first())
        .map(|(before, after)| core_usage(before, after))
        .unwrap_or(0.0);
    let cores = before
        .iter()
        .skip(1)
        .zip(after.iter().skip(1))
        .map(|(before, after)| core_usage(before, after))
        .collect();
    (aggregate, cores)
}

/// One number from `/proc/meminfo`, in bytes.
fn meminfo(name: &str) -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.starts_with(name))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|number| number.parse::<u64>().ok())
                .map(|kib| kib * 1024)
        })
        .unwrap_or(0)
}

/// Memory used and total (bytes): total minus what the kernel can reclaim at once.
fn memory() -> (u64, u64) {
    let total = meminfo("MemTotal:");
    let available = meminfo("MemAvailable:");
    (total.saturating_sub(available), total)
}

/// Swap used and total (bytes).
fn swap() -> (u64, u64) {
    let total = meminfo("SwapTotal:");
    let free = meminfo("SwapFree:");
    (total.saturating_sub(free), total)
}

/// The hottest thermal zone that reads (°C): `sysfs` reports milli-degrees.
fn temperature() -> f64 {
    let Ok(entries) = std::fs::read_dir("/sys/class/thermal") else {
        return 0.0;
    };
    let mut hottest: f64 = 0.0;
    let mut found = false;
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path().join("temp")) else {
            continue;
        };
        let Ok(milli) = text.trim().parse::<f64>() else {
            continue;
        };
        // 0 is the zone's own "no reading" (a disconnected sensor); negative is nonsense.
        if milli <= 0.0 {
            continue;
        }
        found = true;
        hottest = hottest.max(milli / 1000.0);
    }
    if found { hottest } else { 0.0 }
}

/// The network's rates (bytes/s): `/proc/net/dev`'s counters, against the previous sample's.
fn network(previous_totals: Option<(u64, u64)>) -> (f64, f64) {
    let totals = net_counters();
    let Some((before_down, before_up)) = previous_totals else {
        return (0.0, 0.0);
    };
    let down = totals.0.saturating_sub(before_down) as f64 / SAMPLE.as_secs_f64();
    let up = totals.1.saturating_sub(before_up) as f64 / SAMPLE.as_secs_f64();
    (down, up)
}

/// Every interface's receive and transmit counters, summed (bytes).
fn net_counters() -> (u64, u64) {
    std::fs::read_to_string("/proc/net/dev")
        .map(|text| {
            let mut down: u64 = 0;
            let mut up: u64 = 0;
            for line in text.lines().skip(2) {
                let Some((_name, numbers)) = line.split_once(':') else {
                    continue;
                };
                let fields: Vec<u64> = numbers
                    .split_whitespace()
                    .filter_map(|number| number.parse().ok())
                    .collect();
                if fields.len() >= 9 {
                    down += fields[0];
                    up += fields[8];
                }
            }
            (down, up)
        })
        .unwrap_or((0, 0))
}

/// The root filesystem's used and total (bytes), through `libc`'s own `statvfs`.
fn disk() -> (u64, u64) {
    let Ok(text) = std::fs::read_to_string("/proc/mounts") else {
        return (0, 0);
    };
    // The root's own `df`: total - available, in 1K blocks (as `df` itself reads them).
    let Ok(output) = std::process::Command::new("df")
        .arg("-B1")
        .arg("/")
        .output()
    else {
        return (0, 0);
    };
    let _ = text;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() >= 4 {
            let total: u64 = fields[1].parse().unwrap_or(0);
            let used: u64 = fields[2].parse().unwrap_or(0);
            return (used, total);
        }
    }
    (0, 0)
}

/// The machine's uptime (seconds), from /proc/uptime.
fn uptime_seconds() -> u64 {
    std::fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|text| text.split_whitespace().next()?.parse().ok())
        .map(|seconds| seconds as u64)
        .unwrap_or(0)
}

/// The load averages (1, 5, 15 minutes), from /proc/loadavg.
fn load_average() -> (f64, f64, f64) {
    std::fs::read_to_string("/proc/loadavg")
        .map(|text| {
            let mut fields = text.split_whitespace();
            let one = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0.0);
            let five = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0.0);
            let fifteen = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0.0);
            (one, five, fifteen)
        })
        .unwrap_or((0.0, 0.0, 0.0))
}

/// The running processes (count): /proc's own numeric directories.
fn processes() -> u64 {
    std::fs::read_dir("/proc")
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .chars()
                        .all(|c| c.is_ascii_digit())
                })
                .count() as u64
        })
        .unwrap_or(0)
}

/// The CPU's current frequency (MHz), from /proc/cpuinfo; 0 when it does not say.
fn cpu_frequency() -> f64 {
    let Ok(text) = std::fs::read_to_string("/proc/cpuinfo") else {
        return 0.0;
    };
    let mut total = 0.0;
    let mut count = 0;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("cpu MHz") {
            if let Some((_, number)) = value.split_once(':') {
                if let Ok(mhz) = number.trim().parse::<f64>() {
                    total += mhz;
                    count += 1;
                }
            }
        }
    }
    if count > 0 { total / count as f64 } else { 0.0 }
}

/// The vitals' own D-Bus interface, the shape the system's own state uses.
#[derive(Debug, Default)]
pub struct VitalsService {
    pub vitals: Vitals,
}

#[interface(name = "io.galyarderlabs.notchfolk.Vitals1")]
impl VitalsService {
    /// JSON `Vitals`.
    #[zbus(property)]
    fn vitals(&self) -> String {
        serde_json::to_string(&self.vitals).unwrap_or_default()
    }
}

/// Samples the vitals forever: the daemon's own task, started at boot.
pub async fn run(iface: InterfaceRef<VitalsService>) {
    let mut previous: Option<Vitals> = None;
    let mut net_totals: Option<(u64, u64)> = None;
    let mut ticker = tokio::time::interval(SAMPLE);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let sample = Vitals::sample(previous.as_ref(), net_totals);
        net_totals = Some(net_counters());
        let changed = previous.as_ref() != Some(&sample);
        previous = Some(sample);
        if !changed {
            continue;
        }
        let mut service = iface.get_mut().await;
        service.vitals = previous.clone().unwrap();
        let emitter = iface.signal_emitter();
        if let Err(err) = service.vitals_changed(emitter).await {
            log::warn!("could not publish vitals: {err}");
        }
    }
}
