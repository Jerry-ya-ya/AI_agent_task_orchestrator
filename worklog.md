# AI agent task orchestrator

## 2026/08/29

- Connect project to remote Git repository.

## 2026/08/30

- Build local-first AI agent task orchestrator MVP

## 2026/08/31

- feat: add Codex usage and pausable TODO tasks

- feat: add completed and failed task history

- chore: move development UI to port 4300

## 2026/09/01

- feat: adopt balanced task verification policy

- feat: add review-gated task publishing with canonical agent commit summaries.

## 2026/09/02

- Remove the Electron application menu and add a draggable custom title bar with a secure close control.

- feat: hide claimed tasks and require approval before removing published task branches.

## 2026/09/03

- Make the taskboard close button close both Electron and browser windows.

- Add selectable Codex reasoning strength for task creation and retries.

- Add icon-based review actions with revision prompts, task lineage, and rejected branch cleanup.

- Cover review retry lineage, revision guidance, and rejected branch cleanup with API tests.

- fix: resolve merge regressions in task creation, migrations, and retry dialogs.

## 2026/09/04

- feat: make retry and reject available from every task detail with safe active-run cancellation and branch cleanup.

- feat: add retry prompts that continue work on the existing task branch.

- refactor: modularize the Angular dashboard with typed components and reliable task approval actions.

- feat: add a secure Electron window minimize control to the custom title bar.

- Fix Electron development startup and restore functional sandboxed window controls with a CommonJS preload bridge.

- Add a collapsible icon sidebar and move task history into a dedicated Angular page.

## 2026/09/05

- Keep the desktop header and navigation fixed while taskboard content scrolls.

- Keep all Taskboard statuses in one horizontal row and move compact Codex usage indicators into the fixed header.

- feat: group tasks by shared Feature branches and add a graphical branch history page.

- fix: generate unique Feature branch names and report duplicate conflicts clearly.

- feat: add a header play-pause control for gating Worker task claims.

## 2026/09/06

- feat: rebase Feature branches onto main before fast-forwarding and pushing main.

- feat: show precise Codex reset timing and render synchronized, color-coded Feature branch history with continuous fork connections.

## 2026/09/07

- feat: refine Feature maps with persistent branch ordering, clean main connectors, and project-scoped Feature creation controls.

- fix: preserve Worker dispatch state across restarts and return interrupted tasks to paused Todo.

## 2026/09/08

- fix: keep retries and interrupted Feature tasks dispatchable across restarts while preserving the user's inspected branch.

- feat: replace Feature branch maps with lazy-loaded interactive Cytoscape graphs.

- fix: preserve Cytoscape branch graph view state across refreshes and add a reset-view control.

## 2026/09/09

- feat: add Feature branch endpoint controls for creating preselected tasks.
