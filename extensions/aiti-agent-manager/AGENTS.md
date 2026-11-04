# aiti-agent-manager 扩展（部署目录直改指南）

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
- 源码仓：`extensions/aiti-agent-manager/`（git 管理，deploy 同步回本目录）
- 改完在源码仓跑 `node tools/deploy.mjs`（或仓库根 `node scripts/deploy-all.mjs --only aiti-agent-manager`）

## 数据目录（数据分层：config / cache）
- `ctx.configDir` 根级 = 配置与关键小状态（aiti-configs 备份范围；小、珍贵、人可读）
- `ctx.cacheDir`（= `<configDir>/cache/`）= 可删缓存：db/venv/日志/大文件；rm -rf 后扩展下次访问自动重建
- `ctx.dataDir` 已移除（访问即抛）——新代码禁用
- 本扩展白名单（永不为 cache 的配置文件）见 package.json `aitiConfigs.configFiles`

## 账号档（多账号备份/切换，2026-09-13）
- **单文件存储**：`<configDir>/agent-accounts.json`（0600）——所有 agent、所有账号档收在一个 JSON；
  aiti-configs 备份时按 encrypt pattern 加密（`agent-accounts.json`，见其 protected/patterns）。
- **共享引擎**：`agent-accounts.ts` 是本目录对 `_shared/agent-accounts.ts` 的逐字节副本
  （shared-copy-sync 测试钉一致性；改动先改 `_shared` 再 cp 副本）。
- **架构（二版）：manager 只做框架，各家自报家门**——每家 agent 扩展 startup 里
  `ctx.services.provide("<extId>.agent", descriptor)`（label/modes/fs 探测表/accountSlots/actions）；
  manager 遍历宿主 `registry.status()` + `services.get` 动态收集，**不写死任何一家**（未 provide 的扩展不出现）。
  descriptor 契约见 `agents-registry.ts`；6 家 agent 扩展各自提供。
- **凭据槽位**：由**各家扩展 descriptor.accountSlots(ctx) 自己声明**（路径知识留在各家，可闭包 configDir）；manager 只消费。
- **静态 ui 插入点**：`ui.toolbar`（`aiti-agent-manager-panel`，icons/bot.svg）+ `ui.dialogs`（与 client registerItems id 一一对应；extman 展示/懒加载对账用）。
- **current 判定**：内容签名（sha256）+ 账号身份（identity）双判定——token 自动刷新（内容轮换）时靠身份仍标「当前」（`saveAccount({identity})`）。
- **自动保险**：登录（/ctl start、codebuddy tui-start）、切换、登出前，当前登录若未被任何档覆盖（签名或身份命中）→
  自动存 `_auto-before-{login,switch,logout}`；永不因切换/重新登录丢账号。
- **面板样式**：自持样式层 `client/src/agent-manager-styles.mjs`（`am-*` 类；config-button 设计语言 + 主题 var 跟随；`ensureStyles()` 幂等注入）。
- **账号额度（可选能力，2026-09-13）**：扩展 descriptor 加 `accountQuota: true` 并提供
  `GET /login/quota[?force=1]`（60s 成功缓存 / 10s 失败退避；形状 `{available,display?,unit?,remaining?,total?,used?,usedPercent?,packages?,note?,expiresAt?,fetchedAt}`）；
  manager 聚合进 `/agents` 并在账号行渲染 chip（`display` 优先、tooltip 分包、点击走 `/quota/{agent}?force=1` 强制刷新）。
  **接入契约全文（新 agent 清单 + 六家现状/待办 + 平台坑）→ `docs/pi-web-ext-agent-account-contract.md`。**
- **API**：`GET /accounts`（总览）；`POST /accounts/{agent}/{save|switch|remove|logout} {alias?}`；
  `/agents` 聚合带每个 agent 的 `accounts: [...]`（含 current 标记）。
- **边界**：只做文件级快照/恢复，不解析 token；feature/env 注入的凭据不在文件层（登出后仍生效，属预期）。

## 红线
- 禁轮询（setInterval 拉取）；需要等待用事件/回调/SSE（桥的 SSE、aiti-event-bus topics）
- 禁重启生产服务（pi-web 3002 等 restart 须用户明确同意）
- 禁手改 dist/ 与运行时平铺文件；跨扩展通信走 ctx.services（禁 globalThis.__ext 直穿）
- 服务端：SQLite 一律 WAL + 分批小事务（批间 setImmediate 让步）；禁 execFileSync 调 >1s 外部程序；>8MB 文件禁同步读
