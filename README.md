# AI Agent Task Orchestrator

A local-first desktop MVP that queues coding tasks, runs each one on an isolated Git branch, executes Codex CLI and a detected project test command, and leaves successful work in `IN_REVIEW` until a person approves it.

## Stack

- Angular 22 standalone UI
- Electron 44 desktop shell
- Node.js/TypeScript + Express backend
- SQLite via Node's built-in `node:sqlite`
- One sequential background Worker
- Codex CLI behind a replaceable `AgentExecutor` interface

The API listens only on a dynamically selected `127.0.0.1` port. The renderer cannot execute arbitrary shell commands, Electron has no Node integration, and the app never stores OpenAI credentials.

See [docs/architecture.md](docs/architecture.md) for the architecture, schema, state machine, process boundaries, and MVP decisions.

## Prerequisites

- Node.js 22.5 or newer (Node 24 recommended)
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

`pnpm dev` builds the Electron main process, starts Angular on `127.0.0.1:4300`, starts the backend/SQLite/Worker inside Electron, and opens the desktop window.

For a browser-only development session:

```powershell
pnpm dev:web
```

For a production build and local desktop launch:

```powershell
pnpm build
pnpm start
```

Create an unpacked distributable or platform installer with:

```powershell
pnpm package
pnpm dist
```

Application data is stored under Electron's per-user `userData/data/orchestrator.sqlite`. Browser-only development uses `.data/orchestrator.sqlite` unless `ORCHESTRATOR_DATABASE_PATH` is set.

For a production-UI browser smoke test, set `ORCHESTRATOR_UI_PATH=dist/frontend/browser` when launching `src/backend/standalone.ts`; the backend then serves Angular from the same loopback origin.

## Use the MVP

1. Create a Project and enter the absolute path of an existing local Git repository.
2. Optionally add project context for Codex.
3. Create one or more Tasks and set priority.
4. Leave the desktop app running. The Worker claims one `TODO` task at a time in `URGENT`, `HIGH`, `MEDIUM`, `LOW` order, then oldest first.
5. Open task cards to inspect branch, workspace, result, stdout, stderr, and all run attempts.
6. Approve an `IN_REVIEW` task to move it to `DONE`, or retry a `FAILED` task after reviewing its logs.

For task `101` titled `Login API`, the generated branch is:

```text
agent/101-login-api
```

The sequential Worker requires a clean repository, creates or reuses the task branch, runs Codex and project verification in the configured repository, checkpoints task changes on that branch, and restores the original branch. It never merges or pushes automatically.

## Test detection

The backend generates verification commands from repository files; the frontend cannot submit command text. The MVP prefers tests, falls back to a recognized build command, and otherwise sends the task to review with an `UNVERIFIED` warning. Only an executed verification command returning non-zero fails the task. It recognizes common JavaScript package managers and project scripts plus Python/pytest, Cargo, Go, .NET, Maven, and Gradle layouts. Angular tests are forced into non-watch mode and other runners receive CI-safe arguments/environment where applicable.

If there is no recognized test runner, the task becomes `FAILED` with a clear result instead of treating untested code as successful.

## Commands

```powershell
pnpm test          # backend/unit/integration tests with fake agents
pnpm build         # Angular production build + Electron/backend TypeScript build
pnpm smoke:electron-runtime # verify Electron includes the required node:sqlite runtime
pnpm desktop:dev   # complete desktop development flow
pnpm dev:web       # API and Angular in a normal browser
```

Automated tests do not invoke real Codex or consume an authenticated session.

## MVP safety and limits

- Only one Worker and one task run at a time.
- Project repositories are trusted local code: their test suite executes locally.
- Codex runs with workspace-write sandboxing and approval policy `never`; it receives the prompt over stdin.
- Logs are capped by the process runner before they are persisted.
- Deleting an inactive task removes its database record and run history but deliberately leaves its Git branch intact to avoid destroying work.
- Approval changes state only; it does not merge, push, or open a pull request.
- No accounts, cloud sync, LAN binding, multi-user features, parallel workers, DAGs, notifications, remote access, or GitHub automation are included.
