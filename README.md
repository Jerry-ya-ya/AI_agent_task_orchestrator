# AI Agent Task Orchestrator

**English** | [繁體中文](README.zh-TW.md)

A local-first desktop MVP that groups coding tasks into Features, runs each Feature on one shared Git branch, executes Codex CLI and project verification, then requires review and push confirmation before publishing each task checkpoint.

## Stack

- Native Rust desktop UI with egui and eframe
- Angular 22 browser UI and optional Tauri 2 desktop build
- Node.js/TypeScript + Express backend
- SQLite via Node's built-in `node:sqlite`
- One sequential background Worker
- Codex CLI behind a replaceable `AgentExecutor` interface

The desktop API listens on a dynamically selected `127.0.0.1` port and requires a per-launch token. The Rust client draws the desktop interface and uses the OS folder picker. Only connected web projects are rendered by a browser engine. Codex CLI manages its own login.

See [docs/architecture.md](docs/architecture.md) for the architecture, schema, state machine, process boundaries, and MVP decisions.

## Prerequisites

- Node.js 26 or newer for desktop development and packaging
- Rust (stable). On Windows, install Microsoft C++ Build Tools with the **Desktop development with C++** workload and use the MSVC Rust toolchain. WebView2 is used to preview local web projects.
- pnpm 11 or newer
- Git
- Codex CLI installed and authenticated with its own login state

Check Codex authentication before expecting the Worker to claim tasks:

```powershell
codex login status
```

If Codex is unavailable or logged out, the Worker stays idle and leaves `TODO` tasks untouched. The UI health banner explains the condition.

## Install and run

```powershell
pnpm install
pnpm dev
```

`pnpm dev` builds the backend sidecar and opens the native Rust desktop window. Restart it after changing Rust or backend code. Use `pnpm desktop:tauri` to run the previous Angular/Tauri client.

To use the browser with the same database, leave the native desktop app running and start Angular in a second terminal:

```powershell
pnpm dev:web
```

For a production build and local desktop launch:

```powershell
pnpm package
pnpm start
```

Create a portable archive for the current platform with:

```powershell
pnpm dist
```

`pnpm package` writes the native app, bundled Node.js backend, and worklog to `dist/native`. `pnpm dist` also archives those three files. Use `pnpm dist:tauri` for the Angular/Tauri installer and see the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

After editing the Agentboard icon artwork, run `pnpm icons:generate` on Windows to refresh the PNG, ICO and ICNS assets.

The Rust and Tauri clients use the same desktop database and frontend connection records, with one backend allowed per data directory. Native theme, icon, and worker preferences use a separate settings file and start with defaults. Set `ORCHESTRATOR_DESKTOP_DATA_DIR` to use an isolated directory for native development. `pnpm dev` and `pnpm start` use the original browser database at `.data/orchestrator.sqlite` by default. The browser connects to the running native backend and uses that same database and worker. Set `ORCHESTRATOR_DATABASE_PATH` for the native launcher to select another database, or set matching `ORCHESTRATOR_DESKTOP_DATA_DIR` values in both terminals to isolate an entire desktop session. The previous desktop database stays in the app data directory. `pnpm dev:web:isolated` uses `.data/isolated.sqlite` by default.

Local frontend previews can open inside the native window or in a detached preview on Windows and macOS. On Linux the native client opens the connected page in the system browser.

For a production-UI browser smoke test, set `ORCHESTRATOR_UI_PATH=dist/frontend/browser` when launching `src/backend/standalone.ts`; the backend then serves Angular from the same loopback origin.

## Use the MVP

1. Create a Project and enter the absolute path of an existing local Git repository. In the desktop app, use **Browse…** to select the repository folder from the native file picker.
2. Optionally add project context for Codex.
3. The new Project immediately scans its local branch and commit history. Open Features to inspect `main`, existing local branches, and their history even before creating a task.
4. Create a Feature from the page button or the **+ New feature** node at the bottom of the branch graph, then create one or more Tasks assigned to it.
5. Leave the desktop app running. The Worker claims one `TODO` task at a time. Tasks within a Feature run in creation order; a Feature waiting for review or push does not block work from another Feature.
   Use the header pause/play control to stop or resume new task claims. Pausing lets the current task finish and prevents the next `TODO` task from starting.
6. Open task cards to inspect branch, workspace, result, stdout, stderr, and the read-only file summary and code patch captured for every run attempt.
7. Select an `IN_REVIEW` task to check out its exact commit on a disposable Review branch. Exit Review to restore `main` and return it to `IN_REVIEW`, or pass Review to restore `main` and move it to `PENDING_PUSH`.
8. Confirm push to cherry-pick only the approved task commit from its shared Feature branch onto `main`, push `main` to `origin`, and move the task checkpoint to `DONE`. Retrying creates a new linked Task ID in `TODO` while preserving the superseded task as history.

For a Feature titled `Login API`, the generated branch is:

```text
feature/login-api
```

The sequential Worker requires a clean repository, creates or reuses the Feature branch, runs Codex and project verification in the configured repository, commits task changes using Codex's canonical `write-worklog` summary, and restores the original branch. It never merges or pushes automatically. The Features page visualizes every local branch and each configured Feature's task history; a configured branch that has not been created yet is monochrome, and the checkpoint before the next unhandled task is highlighted.

## Test detection

The backend generates verification commands from repository files; the frontend cannot submit command text. The MVP prefers tests, falls back to a recognized build command, and otherwise sends the task to review with an `UNVERIFIED` warning. Only an executed verification command returning non-zero fails the task. It recognizes common JavaScript package managers and project scripts plus Python/pytest, Cargo, Go, .NET, Maven, and Gradle layouts. Angular tests are forced into non-watch mode and other runners receive CI-safe arguments/environment where applicable.

If neither a recognized test nor build command is available, the task enters `IN_REVIEW` with a visible `UNVERIFIED` warning.

## Commands

```powershell
pnpm test          # backend/unit/integration tests with fake agents
pnpm build         # Angular production build + backend TypeScript build
pnpm desktop:dev   # complete desktop development flow
pnpm dev:web       # API and Angular in a normal browser
```

Automated tests do not invoke real Codex or consume an authenticated session.

## MVP safety and limits

- Only one Worker and one task run at a time.
- Project repositories are trusted local code: their test suite executes locally.
- Codex runs with workspace-write sandboxing and approval policy `never`; it receives the prompt over stdin.
- Logs are capped by the process runner before they are persisted.
- Deleting an inactive task removes its database record and run history but deliberately leaves shared Feature history in Git intact.
- Approval changes state only. A separate explicit confirmation cherry-picks the selected task commit from `feature/<slug>` onto `main` and pushes `main` to `origin` using the user's existing Git credentials.
- Active human Review uses a disposable `agent/<task-id>-review` branch and blocks new Worker claims only for that project until Review is exited or passed.
- Retry never rewinds an existing task to `TODO`; it creates a new task on the same Feature branch with `source_task_id` lineage so its later commit remains attributable in branch history and conflict prompts.
- Cherry-pick conflicts are aborted on `main`. After the user selects a model strength, Codex resolves the conflict on a disposable branch based on `main`; the resolved single commit returns to Review before it can be published. Shared Feature branches remain local for later tasks, while existing legacy per-task branches retain their prior merge and cleanup flow.
- No accounts, cloud sync, LAN binding, multi-user features, parallel workers, DAGs, notifications, remote access, PR automation, or GitHub API integration are included.
