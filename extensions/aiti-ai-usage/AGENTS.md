# aiti-ai-usage 扩展（部署目录直改指南）

## 结构
- 运行时文件平铺在本目录根（index.ts / core.cjs …，宿主 loader 按相对路径加载——**禁手改运行时平铺文件**，改 src/ 再 build）
- `src/` 源码（client/src + 服务端 ts/cjs）· `dist/` 构建产物（禁手改）· `tools/` 构建/部署脚本
- npm 包形态的扩展：本目录 package.json 含 version 与 aitiConfigs 声明

## 小改现场流程（改文案/样式/小逻辑）
1. 改 `src/` 下对应源码
2. `node tools/build.mjs`（client 有构建产物的扩展；纯服务端改动跳过）
3. `curl -X POST http://127.0.0.1:3001/api/extensions/reload`（dev；prod 3002；外部经 nginx 带 basePath：/dev、/mac、/mdev、/win、/wdev → `/xxx/api/extensions/reload`）
4. 浏览器刷新页面验证

## 大改回源码仓
- 源码仓：`extensions/aiti-ai-usage/`（git 管理，deploy 同步回本目录）
- 改完在源码仓跑 `node tools/deploy.mjs`（或仓库根 `node scripts/deploy-all.mjs --only aiti-ai-usage`）

## 摄入载体：worker 真后台（2026-09-12 二次改造，优先）
- `server/ingest-worker.ts`：全量 / 手动 Rescan 在 **worker_threads 独立线程** + 独立 SQLite 连接（WAL + busy_timeout 5s，与主线程 live ingest 并发写安全）执行——**主线程零参与**。
- 主线程仅保留实时小写入：live ingest（message_end）、proxy tail（fs.watch）、3s 防抖 flushDaily。
- worker 不可用（旧 Node/环境限制）→ 自动回退主线程异步分批（`lastSyncBackend=inline`）保底；spawn 传 `execArgv:["--experimental-strip-types"]`（22.6–22.17 需要，≥22.18 默认开启且兼容接受）。
- 生命周期：一次性 worker（spawn → sync → done → terminate）；`stop()`/热重载时 terminate 在飞 worker。
- **严禁**把摄入改回主线程同步全量扫描：会冻结事件循环数分钟 → pi-web-guard 探活失败 SIGKILL 重启 → 水位写不进 → 每次重启从头再索引（2026-09-12 实测事故，1GB JSONL/1589 文件）。

## 主线程回退链的异步分批约定（worker 不可用时）
- 全量摄入链（`syncLiveSessions` / `syncArchives` / `importProxyHistory` / `flushDaily` / `parseSessionJsonl`）**必须异步分批**：
  每文件 / 每 2000 行 / 每 20 天 / 每 200 会话让出事件循环（`yieldToLoop()` = setImmediate），写批次包 `withTx` 事务（BEGIN IMMEDIATE）。
- 启动 `syncAll` 后台化（init 不 await）+ 并发去重（手动 Rescan 与启动共享同一在飞任务）；`POST sync` 立即返回。

## 用户输入统计（user_msgs，2026-09-12）
- 表 `user_msgs`：会话 JSONL 里 role=user 的消息明细，PK=(msg_id, ts)——fork 复制消息保留同 id+同 ts，天然全局去重。
- kind：human（人写）/ agent（subagent 或扩展模板首条注入）/ external（导入会话）；引用扫描在 `lib/user-quotes.ts`（纯函数，格式调研见 `docs/aiti-ai-usage-user-input-stats-plan.md`）。
- **无实时摄入**：pi 的 user message 事件不带消息 id，实时写会与文件扫描行重复；本表只由文件扫描链（启动 / 手动 Rescan / 归档）维护。
- **schema 版本 bootstrap**：`db.ts` 的 `USER_MSGS_SCHEMA` 不一致（新库/老库升级/识别逻辑变更后 bump）→ 写 `meta.user_msgs_rebuild=1`，sync 链（worker 与 inline 回退）读它 `force` 忽略文件水位全量重扫一轮，完成后删标记。**改了 kind/引用口径必须 bump 版本号**，否则存量数据不会重算。
- 查询：`GET userstat`（server/api.ts）+ 报表「输入」标签页；总览 KPI 卡带一行输入/引用数。

## 数据目录（数据分层：config / state / cache）
- `ctx.configDir` 根级 = 配置与关键小状态（aiti-configs 备份范围；小、珍贵、人可读）
- `ctx.stateDir`（= `<configDir>/state/`）= 不可再生的持久数据（本扩展**无**——usage.sqlite 是可重建索引，已判回 cache/；见 commit dee1a6e7）
- `ctx.cacheDir`（= `<configDir>/cache/`）= 可重建数据（db/venv/日志/大文件）：**本扩展 `usage.sqlite` 在此**（可从 pi 会话/.pwarc 全量重灌，可再生；rm -rf 后启动自动全量重建）
- `ctx.dataDir` 已移除（访问即抛）——新代码禁用
- 本扩展白名单（永不为 cache 的配置文件）见 package.json `aitiConfigs.configFiles`

## 红线
- 禁轮询（setInterval 拉取）；需要等待用事件/回调/SSE（桥的 SSE、aiti-event-bus topics）
- 禁重启生产服务（pi-web 3002 等 restart 须用户明确同意）
- 禁手改 dist/ 与运行时平铺文件；跨扩展通信走 ctx.services（禁 globalThis.__ext 直穿）
- 服务端：SQLite 一律 WAL + 分批小事务（批间 setImmediate 让步）；禁 execFileSync 调 >1s 外部程序；>8MB 文件禁同步读
