# aiti-cmd 扩展（部署目录直改指南）

## 结构
- 运行时文件平铺在本目录根（index.ts / core.cjs …，宿主 loader 按相对路径加载——**禁手改运行时平铺文件**，改 src/ 再 build）
- `src/` 源码（client/src + 服务端 ts/cjs）· `dist/` 构建产物（禁手改）· `tools/` 构建/部署脚本
- npm 包形态的扩展：本目录 package.json 含 version 与 aitiConfigs 声明

## 客户端结构（三弹窗应用，2026-11-18 拆分）
- `client/src/index.js` = 胶水（register / 插槽 / 服务 / 全局桥 / 消息识别 provider）
- `client/src/kit.js`（ctx 运行时）· `state.js`（应用 store）· `window.js`（浮窗外壳 + 三应用切换器）
- `client/src/apps/{favorites,running,terminal}.js`：★命令收藏 / ▶运行中 / 🖥终端 三个独立 dialog
- `client/src/views/{terminal-view,pi-command-view,command-detail,workspace-terminal}.js`：xterm 视图、agent 命令输出、消息识别命令卡、工作区页签接管与归属状态机
- `client/src/entry.js`：`composerTools` 运行态势入口（与 ops timeline / import 同排）
- `client/src/sinks.js`：分享中心 `share-sink` 提供方（命令收藏为固定收藏目标）
- `detach/`（**服务端**）：detached PTY host —— 终端会话的跨 reload/重启存活层，见下
- 服务端 API 与 UI 拆分无关：`/run` `/shell` `/sessions*` `/pi-commands*` `/commands*` `/history*` 保持原样

## 终端会话的传输层（2026-11-19 起）

- 默认走 **detached pty-host**：每个会话一个独立进程（`systemd-run --user` 瞬态服务，跑在 `user.slice`），socket 协议 + 环形 journal 重放 + 磁盘 registry（`~/.pi/agent/aiti-cmd-host/`）。扩展 reload 或 `systemctl restart pi-web*` 后由 `runner.reattach()` 重新接管，PTY 不重启、历史输出由 host 重放。模式参考宿主 `lib/agent-starter`（外部 agent detach 同源思路）。
- 回落：沙箱会话（bwrap）、win32、系统无 systemd user manager、`AITI_CMD_DETACH=0` → 进程内 node-pty（原路径不变）。
- 相关文件：`detach/index.ts`（probe / spawn / attach / registry）、`detach/pty-host-source.ts`（内联 host 程序，物化到 `~/.pi/agent/aiti-cmd-host/pty-host.<hash>.mjs`）、`runner.ts` 的 `spawnSession → startDetached | spawnLocal`。
- 改 `pty-host-source.ts` 后**必须重新 deploy**（deploy 会把 `detach/` 整个目录拷过去），旧 hash 文件自动清理。

## 小改现场流程（改文案/样式/小逻辑）
1. 改 `src/` 下对应源码
2. `node tools/build-client.mjs`（client 有构建产物的扩展；纯服务端改动跳过）
3. `curl -X POST http://127.0.0.1:3001/api/extensions/reload`（dev；prod 3002；外部经 nginx 带 basePath：/dev、/mac、/mdev、/win、/wdev → `/xxx/api/extensions/reload`）
4. 浏览器刷新页面验证

## 大改回源码仓
- 源码仓：`extensions/aiti-cmd/`（git 管理，deploy 同步回本目录）
- 改完在源码仓跑 `node tools/deploy.mjs`（或仓库根 `node scripts/deploy-all.mjs --only aiti-cmd`）

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
