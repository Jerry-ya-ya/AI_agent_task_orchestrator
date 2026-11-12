use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    io::{self, BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConnection {
    pub base_url: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StartupMessage {
    Ready(BackendConnection),
    Failed { error: String },
}

pub struct Backend(Child);

impl Backend {
    pub fn start(app: &AppHandle) -> Result<(Self, BackendConnection), Box<dyn Error>> {
        let executable = std::env::current_exe()?.with_file_name(if cfg!(windows) {
            "orchestrator-backend.exe"
        } else {
            "orchestrator-backend"
        });
        let worklog = if cfg!(dev) {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../worklog.md")
        } else {
            app.path().resource_dir()?.join("worklog.md")
        };
        let config_dir = app.path().config_dir()?;
        let legacy_directory = ["ai-agent-task-orchestrator", crate::TITLE]
            .map(|name| config_dir.join(name).join("data"))
            .into_iter()
            .find(|directory| directory.is_dir())
            .unwrap_or_else(|| config_dir.join("ai-agent-task-orchestrator/data"));
        let mut command = Command::new(executable);
        command
            .arg(app.path().app_data_dir()?.join("data"))
            .arg(legacy_directory)
            .arg(worklog)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut backend = Self(command.spawn()?);
        let stdout = backend.0.stdout.take().expect("stdout is piped");
        let (ready, startup) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            let mut line = String::new();
            let result = stdout.read_line(&mut line).and_then(|_| {
                serde_json::from_str::<StartupMessage>(&line).map_err(io::Error::other)
            });
            if ready.send(result).is_ok() {
                // Drain any later diagnostics so the child cannot block on stdout.
                let _ = io::copy(&mut stdout, &mut io::sink());
            }
        });
        match startup.recv_timeout(Duration::from_secs(20))?? {
            StartupMessage::Ready(connection) => Ok((backend, connection)),
            StartupMessage::Failed { error } => Err(io::Error::other(error).into()),
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        // Closing stdin lets Node cancel active work and close SQLite first.
        drop(self.0.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(10);
        while matches!(self.0.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
