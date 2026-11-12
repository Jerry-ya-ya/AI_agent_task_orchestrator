use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConnection {
    pub base_url: String,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StartupMessage {
    Ready(BackendConnection),
    Failed { error: String },
}

pub struct Backend {
    child: Child,
    _lock: File,
}

pub fn legacy_directory(config: &Path, title: &str) -> PathBuf {
    ["ai-agent-task-orchestrator", title]
        .map(|name| config.join(name).join("data"))
        .into_iter()
        .find(|directory| directory.is_dir())
        .unwrap_or_else(|| config.join("ai-agent-task-orchestrator/data"))
}

impl Backend {
    pub fn start(
        executable: &Path,
        data_directory: &Path,
        legacy_directory: &Path,
        worklog: &Path,
    ) -> Result<(Self, BackendConnection), Box<dyn Error>> {
        let lock_path = data_directory.with_extension("lock");
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lock.try_lock().map_err(|error| {
            io::Error::other(format!(
                "The desktop data is already in use or cannot be locked: {error}"
            ))
        })?;

        let mut command = Command::new(executable);
        command
            .arg(data_directory)
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
        let mut backend = Self {
            child: command.spawn()?,
            _lock: lock,
        };
        let stdout = backend.child.stdout.take().expect("stdout is piped");
        let (ready, startup) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            let mut line = String::new();
            let result = stdout.read_line(&mut line).and_then(|_| {
                serde_json::from_str::<StartupMessage>(&line).map_err(io::Error::other)
            });
            if ready.send(result).is_ok() {
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
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(10);
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
