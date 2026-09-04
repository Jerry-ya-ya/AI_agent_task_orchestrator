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
