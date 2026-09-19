# AI Agent Task Orchestrator

[English](README.md) | **繁體中文**

這是一個 local-first 的桌面 MVP：將程式開發任務分組到 Feature，在各自共用的 Git branch 上依序執行 Codex CLI 與專案驗證；完成後必須經人工 Review 與確認推送，才會發布每個任務的 checkpoint。

> 英文版是主要文件；本文件提供相同核心操作的繁體中文說明。

## 技術組成

- Angular 22 standalone UI
- Electron 44 桌面殼層
- Node.js／TypeScript／Express 後端
- 使用 Node 內建 `node:sqlite` 的 SQLite
- 單一、循序執行的背景 Worker
- 可替換的 `AgentExecutor` 介面，目前由 Codex CLI 實作

API 只會監聽動態選取的 `127.0.0.1` 連接埠。前端無法執行任意 shell 指令；Electron 不啟用 Node integration；應用程式不會保存 OpenAI 憑證。

更完整的架構、資料模型、狀態機與安全界線請見 [architecture.md](docs/architecture.md)。

## 需求

- Node.js 22.5 以上（建議 Node 24）
- pnpm 11 以上
- Git
- 已安裝並以自身登入狀態完成認證的 Codex CLI

在讓 Worker 領取任務前，先確認 Codex 的登入狀態：

```powershell
codex login status
```

若 Codex 無法使用或尚未登入，Worker 會維持閒置，`TODO` 任務不會被更動，畫面健康狀態會說明原因。

## 安裝與執行

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 會建置 Electron 主程序、在 `127.0.0.1:4300` 啟動 Angular、並由 Electron 內部啟動後端、SQLite 與 Worker，最後開啟桌面視窗。

若只需要一般瀏覽器的開發環境：

```powershell
pnpm dev:web
```

Production build 並在本機啟動桌面程式：

```powershell
pnpm build
pnpm start
```

建立未封裝發行版本或平台安裝檔：

```powershell
pnpm package
pnpm dist
```

原始 Agentboard 圖示位於 `src/frontend/public/favicon.svg`。設定頁可選擇由原始圖示延伸的變體，而不會更動原始版本。Windows 上若修改圖示素材，請執行 `pnpm icons:generate` 以更新包裝用的 PNG 與 ICO。

應用程式資料儲存在 Electron 每位使用者的 `userData/data/orchestrator.sqlite`。純瀏覽器開發模式預設使用 `.data/orchestrator.sqlite`，除非設定 `ORCHESTRATOR_DATABASE_PATH`。

## 使用方式

1. 建立 Project，指定既有本機 Git repository 的絕對路徑。桌面應用程式可按 **Browse…** 從原生檔案總管選擇資料夾。
2. 視需要填寫提供給 Codex 的 Project context。
3. Project 建立時會立即掃描本機 branch 與 commit 歷史。即使尚未建立任務，也能在 Features 頁面看到 `main`、既有本機 branch 與歷史；空白 repository 也會保留一條 `main`。
4. 從頁面右上方按鈕，或分支圖最下方的 **+ New feature** 節點建立 Feature；然後將一個或多個 Task 指派給該 Feature。
5. 讓桌面程式持續執行。Worker 一次只會領取一個 `TODO` 任務；同一 Feature 依建立順序執行。正在等待 Review 或推送的 Feature 不會阻塞其他 Feature。上方的播放／暫停控制可停止或恢復新的任務領取；暫停不會中止目前進行中的工作。
6. 開啟 Task 卡片可查看 branch、workspace、結果、stdout、stderr，以及每次執行儲存的唯讀檔案摘要與程式 diff。
7. 對 `IN_REVIEW` Task 啟動 Review，系統會在暫時的 Review branch 檢出該次 commit。退出 Review 會還原 `main` 並回到 `IN_REVIEW`；通過 Review 則還原 `main` 並進入 `PENDING_PUSH`。
8. 確認推送後，系統只會將已核准的 task commit 從共用 Feature branch cherry-pick 到 `main`、推送 `main` 到 `origin`，並把該 checkpoint 設為 `DONE`。Retry 會建立新的關聯 Task ID，保留被取代嘗試的歷史。

Feature 標題為 `Login API` 時，預設 branch 名稱為：

```text
feature/login-api
```

循序 Worker 需要乾淨的 repository。它會建立或重用選取 Feature 的 shared branch，在設定的 repository 中執行 Codex 與專案驗證，以 Codex `write-worklog` skill 的 canonical summary 建立 task commit，最後還原原先 branch。它不會自動 merge 或 push。

## 驗證指令偵測

後端會依 repository 檔案產生驗證指令，前端無法傳入任意 command。MVP 優先執行測試，找不到測試時使用已辨識的 build 指令；若兩者皆無，任務會以 `UNVERIFIED` 警告進入 `IN_REVIEW`。只有實際執行且回傳非零的驗證指令才會讓任務進入 `FAILED`。

目前支援常見 JavaScript package manager／project script，以及 Python/pytest、Cargo、Go、.NET、Maven 與 Gradle。Angular 測試會強制使用 non-watch mode，其他 runner 會在可用時加上適合 CI 的參數與環境。

## 常用指令

```powershell
pnpm test                   # 後端、單元與整合測試（使用 fake agents）
pnpm build                  # Angular production build + Electron／後端 TypeScript build
pnpm smoke:electron-runtime # 確認 Electron 包含所需的 node:sqlite runtime
pnpm desktop:dev            # 完整桌面開發流程
pnpm dev:web                # 一般瀏覽器中的 API 與 Angular
```

自動化測試不會呼叫真實 Codex，也不會使用已登入的工作階段。

## 安全性與 MVP 限制

- 一次只有一個 Worker 與一個 task run。
- Project repository 視為可信任的本機程式碼；其測試套件會在本機執行。
- Codex 使用 workspace-write sandbox 與 `never` approval policy，prompt 透過 stdin 傳入。
- Process runner 在保存前會限制 log 大小。
- 刪除未執行中的 Task 會移除資料庫與 run history，但會保留 Git 中的 shared Feature history。
- Approve 只改變狀態；之後仍需使用者明確確認，才會把 task commit cherry-pick 到 `main` 並以既有 Git 認證推送 `main` 到 `origin`。
- 人工 Review 使用暫時的 `agent/<task-id>-review` branch；在 Review 結束或通過前，只會阻擋該 Project 的新 Worker 領取。
- Retry 不會把舊 Task 倒回 `TODO`，而是以相同 Feature branch 建立含 `source_task_id` 的新 Task，讓後續 commit 在 branch history 中可追溯。
- Cherry-pick 衝突會在 `main` 上中止。使用者選擇模型強度後，Codex 會在基於 `main` 的暫時 branch 解決衝突，並將單一 resolved commit 送回 Review；shared Feature branch 仍留在本機，讓後續任務可繼續使用。
- 不包含帳號、cloud sync、LAN binding、多使用者、平行 worker、DAG、通知、遠端存取、PR automation 或 GitHub API 整合。
