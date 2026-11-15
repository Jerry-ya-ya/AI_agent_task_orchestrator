# AI Agent Task Orchestrator

[English](README.md) | **繁體中文**

這是一個 local-first 的桌面 MVP：將程式開發任務分組到 Feature，在各自共用的 Git branch 上依序執行 Codex CLI 與專案驗證；完成後必須經人工 Review 與確認推送，才會發布每個任務的 checkpoint。

> 英文版是主要文件；本文件提供相同核心操作的繁體中文說明。

## 技術組成

- Rust 原生桌面介面（egui 與 eframe）
- Angular 22 瀏覽器版及選用的 Tauri 2 桌面版
- Node.js／TypeScript／Express 後端
- 使用 Node 內建 `node:sqlite` 的 SQLite
- 單一、循序執行的背景 Worker
- 可替換的 `AgentExecutor` 介面，目前由 Codex CLI 實作

桌面 API 只監聽動態選取的 `127.0.0.1` 連接埠，並要求當次啟動的存取權杖。Rust 直接繪製桌面介面，並呼叫系統資料夾選擇器。只有已連線的網頁預覽使用瀏覽器引擎。Codex CLI 自行管理登入狀態。

更完整的架構、資料模型、狀態機與安全界線請見 [architecture.md](docs/architecture.md)。

## 需求

- 桌面開發與打包需要 Node.js 26 以上
- Rust stable。Windows 請安裝 Microsoft C++ Build Tools 的 **使用 C++ 的桌面開發** 工作負載，並使用 Rust MSVC 工具鏈。本機網頁預覽使用 WebView2。
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

`pnpm dev` 會建置獨立的後端執行檔並開啟原生 Rust 視窗。修改 Rust 或後端程式後請重新執行。原本的 Angular/Tauri 版可用 `pnpm desktop:tauri` 啟動。

若要讓瀏覽器與原生桌面版共用資料庫，請保持桌面版開啟，並在另一個終端機執行：

```powershell
pnpm dev:web
```

Production build 並在本機啟動桌面程式：

```powershell
pnpm package
pnpm start
```

建立目前平台的可攜式壓縮檔：

```powershell
pnpm dist
```

原始 Agentboard 圖示位於 `src/frontend/public/favicon.svg`。設定頁可選擇圖示變體。Windows 上若修改圖示素材，請執行 `pnpm icons:generate` 以更新 PNG、ICO 和 ICNS。

`pnpm package` 會把原生程式、Node.js 後端與更新日誌放到 `dist/native`。`pnpm dist` 也會將這三個檔案打包成壓縮檔。Angular/Tauri 版安裝程式仍可用 `pnpm dist:tauri` 產生。[Tauri 系統需求](https://v2.tauri.app/start/prerequisites/)

Rust 和 Tauri 共用桌面資料庫及已儲存的前端連線，同一個資料目錄一次只允許一個後端開啟。原生介面的主題、圖示及派工偏好以獨立檔案保存，首次開啟使用預設值。原生開發可用 `ORCHESTRATOR_DESKTOP_DATA_DIR` 指定隔離資料目錄。執行 `pnpm dev:web` 時請保持原生 Rust 桌面版開啟。`pnpm dev` 和 `pnpm start` 預設使用原本瀏覽器的 `.data/orchestrator.sqlite`，瀏覽器會連到同一個後端並共用工作程序。可在桌面啟動命令設定 `ORCHESTRATOR_DATABASE_PATH` 改用其他資料庫，或在兩個終端機設定相同的 `ORCHESTRATOR_DESKTOP_DATA_DIR` 來隔離桌面環境。原桌面資料庫仍位於應用程式資料目錄。`pnpm dev:web:isolated` 預設使用 `.data/isolated.sqlite`。

Windows 與 macOS 可在原生主視窗或獨立預覽視窗查看本機前端。Linux 的原生版使用系統瀏覽器開啟連線。

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
pnpm build                  # Angular production build + 後端 TypeScript build
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
