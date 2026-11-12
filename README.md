# AI Agent Task Orchestrator

**English** | [繁體中文](README.zh-TW.md)

A local-first desktop MVP that groups coding tasks into Features, runs each Feature on one shared Git branch, executes Codex CLI and project verification, then requires review and push confirmation before publishing each task checkpoint.

## Stack

- Angular 22 standalone UI
- Tauri 2 desktop shell
- Node.js/TypeScript + Express backend
- SQLite via Node's built-in `node:sqlite`
- One sequential background Worker
- Codex CLI behind a replaceable `AgentExecutor` interface

The desktop API listens on a dynamically selected `127.0.0.1` port and requires a per-launch token. The webview uses a limited native bridge for window controls and the folder picker. Codex CLI manages its own login.

See [docs/architecture.md](docs/architecture.md) for the architecture, schema, state machine, process boundaries, and MVP decisions.

## Prerequisites

- Node.js 26 or newer for desktop development and packaging
- Rust (stable) and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows, install Microsoft C++ Build Tools with the **Desktop development with C++** workload and use the MSVC Rust toolchain.
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

`pnpm dev` builds the backend sidecar, starts Angular on `127.0.0.1:4300`, and opens the Tauri window. Angular changes reload in place. Restart `pnpm dev` after changing the backend.

For a browser-only development session:

```powershell
pnpm dev:web
```

For a production build and local desktop launch:

```powershell
pnpm package
pnpm start
```

Create a platform installer with:

```powershell
pnpm dist
```

The default installer formats are NSIS on Windows, DMG on macOS, and AppImage on Linux. Build on the target platform with a matching Node.js architecture. The installer includes the Node.js backend runtime and worklog.

After editing the Agentboard icon artwork, run `pnpm icons:generate` on Windows to refresh the PNG, ICO and ICNS assets.

Application data is stored in the Tauri app data directory under `data/orchestrator.sqlite`. On first launch, the app imports the previous Electron database and saved frontend connections if they exist. Browser-only development uses `.data/orchestrator.sqlite` unless `ORCHESTRATOR_DATABASE_PATH` is set. Preferences stored in the Electron webview, such as theme, icon selection, and worker dispatch, start with their defaults in the new webview.

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
