use std::{
    sync::mpsc::{self, Receiver},
    thread,
    time::Duration,
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub struct MemoryUsage {
    pub crust: u64,
    pub webviewer: Option<u64>,
}

impl MemoryUsage {
    pub fn total(&self) -> u64 {
        self.crust + self.webviewer.unwrap_or_default()
    }
}

pub fn monitor(ctx: eframe::egui::Context) -> Receiver<Option<MemoryUsage>> {
    let (samples, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut system = System::new();
        let pid = Pid::from_u32(std::process::id());
        loop {
            let sample = sample(&mut system, pid);
            if samples.send(sample).is_err() {
                break;
            }
            ctx.request_repaint();
            thread::sleep(Duration::from_secs(3));
        }
    });
    receiver
}

fn sample(system: &mut System, pid: Pid) -> Option<MemoryUsage> {
    let refresh = ProcessRefreshKind::nothing().with_memory();
    let main = [pid];
    let processes = if cfg!(windows) {
        ProcessesToUpdate::All
    } else {
        ProcessesToUpdate::Some(&main)
    };
    system.refresh_processes_specifics(processes, true, refresh);
    let crust = system.process(pid)?.memory();
    let webviewer = if cfg!(windows) {
        let mut bytes = 0;
        for process in system.processes().values() {
            if process.name().eq_ignore_ascii_case("msedgewebview2.exe")
                && belongs_to(process.pid(), pid, |pid| system.process(pid)?.parent())
            {
                bytes += process.memory();
            }
        }
        Some(bytes)
    } else if cfg!(target_os = "macos") {
        // WKWebView helpers can run outside the app's process tree.
        None
    } else {
        // Linux opens previews in the user's external browser.
        Some(0)
    };
    Some(MemoryUsage { crust, webviewer })
}

fn belongs_to(mut pid: Pid, owner: Pid, parent: impl Fn(Pid) -> Option<Pid>) -> bool {
    for _ in 0..64 {
        let Some(next) = parent(pid) else {
            return false;
        };
        if next == owner {
            return true;
        }
        pid = next;
    }
    false
}

pub fn format_memory(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_helpers_under_the_main_window_or_a_detached_preview() {
        let owner = Pid::from_u32(10);
        let parent = |pid: Pid| match pid.as_u32() {
            11 | 12 => Some(owner),
            13 => Some(Pid::from_u32(12)),
            14 => Some(Pid::from_u32(13)),
            21 => Some(Pid::from_u32(20)),
            _ => None,
        };
        assert!(belongs_to(Pid::from_u32(11), owner, parent));
        assert!(belongs_to(Pid::from_u32(14), owner, parent));
        assert!(!belongs_to(Pid::from_u32(21), owner, parent));
    }
}
