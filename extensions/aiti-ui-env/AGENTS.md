# aiti-ui-env 扩展（部署目录直改指南）

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
- 源码仓：`extensions/aiti-ui-env/`（git 管理，deploy 同步回本目录）
- 改完在源码仓跑 `node tools/deploy.mjs`（或仓库根 `node scripts/deploy-all.mjs --only aiti-ui-env`）

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

## VNC 密码契约（Windows 自管 winvnc / UltraVNC，2026-09-18 定稿）

**原题**：扩展自己生成随机密码、由桥在 RFB 握手时代答 VNC auth —— 密码对不上，查看页永远弹
「服务器要求认证」，用户以为是 Windows 账户密码。现已改为：**用户设密码 + VNC server 自己认证，桥不代答**。

- **密码来源**：`ctx.configDir/vnc-passwd`（明文，环境变量 `UI_ENV_VNC_PASSWORD` 优先）；
  不再有 `vnc-rfb-passwd` 随机密码。设置入口：面板弹框（client `ensureVncPassword`）/ `POST /vnc-password` /
  安装时 `ui_env_deps install { password }`、`ui_env_headless start { password }` / `setup-windows.ps1 -VncPassword`。
- **UltraVNC ini 的 passwd 是它专有格式**（`lib/win.ts` `SET_VNC_INI_PS`）：
  `hex( DES-ECB(data=密码补零到 8 字节, key = E8 4A D6 60 C4 72 1A E0) ) + "00"`，共 9 字节 hex。
  ⚠ **不是**标准 VNC/vncpasswd 的固定钥匙 `17 52 6B 06 23 4E 58 07` —— 用错钥匙 UltraVNC 解出乱码，认证必败（本项目长期踩的坑）。
- **写入顺序**：先杀 winvnc 再写 ini（winvnc 退出时会回写内存里的旧配置覆盖新密码）；
  并整体重建 ini（删文件重写），避免 `passwd2` / 大小写变体等残留键干扰。
- **PS 脚本必须带 UTF-8 BOM**：Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解码，中文注释会被误解码，
  某些字节拼出行尾反引号把下一行代码吞掉（实证 `$uvkey` 变 null → 写 ini 静默失败）。
- **桥是纯透传**（`lib/vnc-bridge.mjs`）：不做任何 RFB 握手改写/代答，只做 cookie 会话 + ws↔tcp 转发；
  浏览器 noVNC 自己弹密码框（VNC auth 只问密码）。
- **查看页凭据表单**（`index.ts` VNC_VIEW_HTML）：`askCreds(types)` 按服务器 types 显隐用户名行；
  CSS 必须保留 `#cred label[hidden]{display:none}` —— 作者样式 `#cred label{display:flex}` 优先级高于 UA 的 `[hidden]`，
  否则 username 行永远显示（这就「把用户搞蒙」的原因）。
- 验证：`winVncPasswordSet` → `winVncEnsure` → 直接用标准 VNC auth 客户端拿明文密码连 5900 应得 `SecurityResult=0` + ServerInit。

## VNC 密码重设（2026-09-18）

统一入口 `env.resetVncPassword(pw, { id? })`（API `POST /vnc-password {password, id?}`、工具 `ui_env_vnc action=reset-password`、面板 🔑）：

| 目标 | 怎么改 | 生效 |
|---|---|---|
| Windows 自管便携 winvnc | 重写 `ultravnc.ini`（UltraVNC 专有钥匙）+ 自动重启 | 立即 |
| Windows 系统版 UltraVNC | `HKLM\SOFTWARE[\WOW6432Node]\UltraVNC\Server` `passwd`（REG_BINARY 8B，UV 钥匙）| 需重启该服务（需管理员） |
| Windows 系统版 TightVNC | `…\TightVNC\Server` `Password`（REG_BINARY 8B，**标准**钥匙）| 需重启该服务（需管理员） |
| Linux x11vnc | 其 `-rfbauth <file>` 指向的密码文件（标准 vncpasswd 格式）| 需重启该 x11vnc（本扩展不擅动系统进程） |
| Linux Xvnc/vncserver | `~/.vnc/passwd`（仅限当前用户的会话）| 需重启该会话 |
| macOS 屏幕共享 / 未知实现 | **不改**：返回明确原因（屏幕共享 = 系统账号密码）| — |

- `SysVncEntry` 带 `passwordResettable` / `passwordNote`：面板「系统 VNC」每条显示 🔑 重设密码（不可改的置灰并把原因放 title）。
- 密码文件写入**不自实现 DES**：优先 `x11vnc -storepasswd` → `vncpasswd -f`（stdin→二进制 stdout）→ `openssl enc -des-ecb -provider legacy`；Win 注册表在 PowerShell/.NET 里算。
- 注意还是那把钥匙的区别：**UltraVNC 自有 `E84AD660C4721AE0` vs 标准 vncpasswd `17526B06234E5807`**，哪个目标用哪把不能弄错。
