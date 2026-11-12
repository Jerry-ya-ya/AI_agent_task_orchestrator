use crate::{model::*, sidecar::BackendConnection};
use eframe::egui;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{sync::mpsc, thread, time::Duration};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Load {
    Board,
    Branches,
    Usage,
    Models,
    Worklog,
    Detail(Id),
}

pub enum Data {
    Board(Board),
    Branches(Vec<BranchMap>),
    Usage(Usage),
    Models(Vec<Model>),
    Worklog(String),
    Detail(Box<Detail>),
}

#[derive(Default)]
pub struct Board {
    pub projects: Vec<Project>,
    pub features: Vec<Feature>,
    pub tasks: Vec<Task>,
    pub connections: Vec<Connection>,
    pub worker: Worker,
}

pub struct Mutation {
    pub method: &'static str,
    pub path: String,
    pub body: Option<Value>,
    pub label: String,
}

impl Mutation {
    pub fn post(path: impl Into<String>, body: Value, label: impl Into<String>) -> Self {
        Self {
            method: "POST",
            path: path.into(),
            body: Some(body),
            label: label.into(),
        }
    }

    pub fn task(id: Id, action: &str, label: impl Into<String>) -> Self {
        Self::post(format!("/tasks/{id}/{action}"), json!({}), label)
    }

    pub fn delete(path: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            method: "DELETE",
            path: path.into(),
            body: None,
            label: label.into(),
        }
    }
}

pub enum Job {
    Read(Load, bool),
    Write(Mutation),
    Restore(Mutation),
}

pub enum Reply {
    Data(Load, Result<Data, String>),
    Mutation(Result<String, String>),
    Restore(Result<(), String>),
}

pub struct Api {
    pub jobs: mpsc::Sender<Job>,
    pub replies: mpsc::Receiver<Reply>,
}

impl Api {
    pub fn spawn(connection: BackendConnection, ctx: egui::Context) -> Self {
        let (jobs, work) = mpsc::channel();
        let (replies, results) = mpsc::channel();
        thread::spawn(move || {
            let client = Client {
                connection,
                agent: ureq::Agent::config_builder()
                    .proxy(None)
                    .max_redirects(0)
                    .timeout_global(Some(Duration::from_secs(45)))
                    .http_status_as_error(false)
                    .build()
                    .into(),
            };
            while let Ok(job) = work.recv() {
                let reply = match job {
                    Job::Read(load, force) => {
                        let (client, replies, ctx) = (client.clone(), replies.clone(), ctx.clone());
                        thread::spawn(move || {
                            let _ = replies.send(Reply::Data(load, client.load(load, force)));
                            ctx.request_repaint();
                        });
                        continue;
                    }
                    Job::Write(request) => Reply::Mutation(client.write(request)),
                    Job::Restore(request) => Reply::Restore(client.write(request).map(|_| ())),
                };
                if replies.send(reply).is_err() {
                    break;
                }
                ctx.request_repaint();
            }
        });
        Self {
            jobs,
            replies: results,
        }
    }
}

#[derive(Clone)]
struct Client {
    connection: BackendConnection,
    agent: ureq::Agent,
}

impl Client {
    fn load(&self, load: Load, force: bool) -> Result<Data, String> {
        #[derive(Deserialize)]
        struct Health {
            worker: Worker,
        }
        #[derive(Deserialize)]
        struct Worklog {
            content: String,
        }

        let refresh = if force { "?refresh=1" } else { "" };
        Ok(match load {
            Load::Board => Data::Board(Board {
                worker: self.get::<Health>("/health")?.worker,
                projects: self.get("/projects")?,
                features: self.get("/features")?,
                tasks: self.get("/tasks")?,
                connections: self.get("/frontend-connections")?,
            }),
            Load::Branches => Data::Branches(self.get("/branches")?),
            Load::Usage => Data::Usage(self.get(&format!("/agent/usage{refresh}"))?),
            Load::Models => Data::Models(self.get(&format!("/agent/models{refresh}"))?),
            Load::Worklog => Data::Worklog(self.get::<Worklog>("/worklog")?.content),
            Load::Detail(id) => Data::Detail(Box::new(self.get(&format!("/tasks/{id}"))?)),
        })
    }

    fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        self.request("GET", path, None)?
            .body_mut()
            .read_json()
            .map_err(|error| error.to_string())
    }

    fn write(&self, request: Mutation) -> Result<String, String> {
        self.request(request.method, &request.path, request.body.as_ref())?;
        Ok(request.label)
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<ureq::http::Response<ureq::Body>, String> {
        let url = format!("{}{}", self.connection.base_url, path);
        let auth = format!("Bearer {}", self.connection.token);
        let result = match (method, body) {
            ("GET", _) => self.agent.get(&url).header("Authorization", &auth).call(),
            ("POST", Some(body)) => self
                .agent
                .post(&url)
                .header("Authorization", &auth)
                .send_json(body),
            ("PUT", Some(body)) => self
                .agent
                .put(&url)
                .header("Authorization", &auth)
                .send_json(body),
            ("DELETE", Some(body)) => self
                .agent
                .delete(&url)
                .header("Authorization", &auth)
                .force_send_body()
                .send_json(body),
            ("DELETE", None) => self
                .agent
                .delete(&url)
                .header("Authorization", &auth)
                .call(),
            _ => return Err(format!("Unsupported API request: {method} {path}")),
        };
        let mut response = result.map_err(|error| format!("{method} {path}: {error}"))?;
        if response.status().is_success() {
            return Ok(response);
        }
        let error = response
            .body_mut()
            .read_json::<Value>()
            .unwrap_or(Value::Null);
        let message = error["error"]["message"]
            .as_str()
            .or_else(|| error["message"].as_str())
            .or_else(|| error["error"].as_str());
        Err(message
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{method} {path}: {}", response.status())))
    }
}
