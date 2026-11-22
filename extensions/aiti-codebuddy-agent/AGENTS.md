# aiti-codebuddy-agent 扩展（部署目录直改指南）

## 进程模型（2026-09-12 起）
- **stream（默认）**：长连接单进程多轮（`codebuddy-handles.ts` 的 `CodebuddyStreamHandle`，参照 aiti-claude-code-agent）——stdin 写用户消息/`control_request`（interrupt/set_model/set_permission_mode），stdout 收帧；cwd 进程内固定，免每轮 MCP/LSP 冷启动。
- **exec（兼容档）**：每轮单发 + `--resume`（`CodebuddyExecHandle`，原实现）；feature `codebuddy.connectionMode=exec` 切换，已有会话经 `/session/recycle` 或重新打开生效。
- **ACP 并行入口**：aiti-acp-agent 的 `codebuddy` 后端（`cbc --acp`，session/load 回放历史）；两条实现可切换互为兑底。

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
- 源码仓：`extensions/aiti-codebuddy-agent/`（git 管理，deploy 同步回本目录）
- 改完在源码仓跑 `node tools/deploy.mjs`（或仓库根 `node scripts/deploy-all.mjs --only aiti-codebuddy-agent`）

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

## 浏览器 OAuth 登录（2026-09-13 起）
- **登录前凭据隔离**：`POST /login/tui/start` 会先 `isolateCliLogin()`——把 CLI auth `*.info`（全数据根）与托管凭据文件
  **备份并移走**到 `<stateDir>/login-backup-<ts>/`（0700），再 spawn cbc login；避免 cbc 拿旧 token 注销/覆盖旧账号。
  旧账号可用 agent-manager「账号档」切回（`_auto-before-login` 自动保险 + 手动档）。
- **面板直达**：agent-manager 发起 OAuth 后自动打开 aiti-cmd 终端面板（客户端服务 `aiti-cmd.open-session`，
  懒加载经 `ensureMaterialized` 兜底）；状态行也有「打开终端」按钮。
- **账号额度（credits）**：`GET /login/quota[?force=1]`（服务端 60s 缓存，失败 10s 退避）→
  官方 usercenter billing `POST https://<auth.domain>/billing/meter/get-user-resource-summary`
  （Bearer accessToken + X-Domain + X-User-Id + X-Client-Platform:usercenter）→
  归一化 `{ total/remaining/used/unit/packages }`；agent-manager 账号行显示「额度 x / y credits」
  （点击强制刷新；tooltip 分包明细）。token 仅服务端内部读取，绝不下发客户端。
  仅 CLI OAuth（腾讯官方通道）适用；API Key/第三方网关档返回 `available:false`。

## 账号档 / 额度对接
- 本扩展已 provide `<extId>.agent` 描述符（账号档槽位）与 `accountQuota` 额度出口 `GET /login/quota`。
  接入契约 / 现状待办 / 平台坑（.mjs reload 缓存）→ `docs/pi-web-ext-agent-account-contract.md`。
