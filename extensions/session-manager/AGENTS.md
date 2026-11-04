# session-manager 扩展（部署目录直改指南）

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
- 源码仓：`extensions/session-manager/`（git 管理，deploy 同步回本目录）
- 改完在源码仓跑 `node tools/deploy.mjs`（或仓库根 `node scripts/deploy-all.mjs --only session-manager`）

## 数据目录（数据分层：config / cache）
- `ctx.configDir` 根级 = 配置与关键小状态（aiti-configs 备份范围；小、珍贵、人可读）
- `ctx.cacheDir`（= `<configDir>/cache/`）= 可删缓存：db/venv/日志/大文件；rm -rf 后扩展下次访问自动重建
- `ctx.dataDir` 已移除（访问即抛）——新代码禁用
- 本扩展白名单（永不为 cache 的配置文件）见 package.json `aitiConfigs.configFiles`

## 红线
- 禁轮询（setInterval 拉取）；需要等待用事件/回调/SSE（桥的 SSE、aiti-event-bus topics）
- 禁重启生产服务（pi-web 3002 等 restart 须用户明确同意）
- 禁手改 dist/ 与运行时平铺文件；跨扩展通信走 ctx.services（禁 globalThis.__ext 直穿）
- 服务端：SQLite 一律 WAL + 分批小事务（批间 setImmediate 让步）；禁 execFileSync 调 >1s 外部程序；>8MB 文件禁同步读
- **索引写只在 worker（2026-09-12）**：sync/syncExt/vacuum 重活一律经 `lib/session-index-async.ts` 门面派发 `dist/index-worker.mjs`（vite 双入口产出；缺失自动回落主线程=降级而非报错）；主线程连接只做读 + 小写（upsertExtParsed/refreshExtTimestamps/markArchived 级别）。适配器**禁同步整库复制大文件**（zcode 61GB/轮拷贝风暴事故根因）——db 型源 readOnly 直读（busy_timeout 2000）或 mtime 门控副本；db 型源必须提供 per-session rev（如 `session.time_updated`）做水位，禁锚定「每轮都会变的物理文件」。方案与事故取证 `docs/session-manager-index-worker-plan.md`
