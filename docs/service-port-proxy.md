# 服务端口代理（Service Port Proxy）— 方案文档

> 目标：让 pi-web 的用户（浏览器）能直接访问 pi 会话里启动的测试服务端口，
> 完整支持网页（HTML/CSS/JS、SPA、表单、fetch），无需手动配置端口白名单。

## 方案决策

### D1. 用 hostname 虚拟主机挂载，不用 path-prefix

| | path-prefix（`/api/svc/5173/...`） | hostname 虚拟主机（`5173.pi.localhost/`） |
|---|---|---|
| 绝对路径资源（`/assets/x.js`） | ❌ 前缀丢失 → 404 | ✅ 路径原样保留 |
| SPA 路由 / fetch / 表单 action | ❌ 需要内容重写 | ✅ 天然工作 |
| 同源（无 CORS） | ✅ | ✅ |
| 浏览器解析 | — | `*.localhost` 原生 → 127.0.0.1（RFC 6761，无需改 hosts） |

**决策：`proxy.ts` 按 `Host: <port><suffix>` 匹配，`NextResponse.rewrite()` 到
`http://127.0.0.1:<port>`；路径除 basePath 前缀外保持不变（见 D7）。**

### D2. 端口白名单 = 自动发现 + 缓存（不做手动配置）

不做手工白名单。允许代理的端口集合 = **发现缓存**：

1. **进程树**：pi-web 的 AgentSession 在 next-server 进程内，测试服务是其后代
   （pi-web → pi 会话 → bash → python → …）。BFS 遍历 pi-web 根进程的所有后代。
2. **环境变量标记**（跨 re-parent 兜底）：`nohup` / `setsid` / double-fork 的守护进程
   会被 re-parent 到 init，脱离进程树。`instrumentation.ts` 在服务启动时写入
   `PI_WEB_CHILD_MARKER`，子进程 spawn 时继承 env —— **即使树断了标记还在**，
   发现时读取 `/proc/<pid>/environ` 匹配标记（仅 Linux）。

**决策：候选进程 = 树后代 ∪ 标记携带者 − pi-web 自身（祖先链 + cmdline 特征）。**

### D3. 跨平台后端（全部用系统自带工具，无 npm 依赖）

| 平台 | 进程树 / cmdline | 监听端口 |
|---|---|---|
| Linux | `/proc/<pid>/task/*/children`、`/proc/<pid>/cmdline`、`/proc/<pid>/environ` | `/proc/<pid>/fd` socket inode → `/proc/net/tcp{,6}`（仅 LISTEN 0A） |
| macOS | `ps -axo pid=,ppid=,command=` | `lsof -nP -iTCP -sTCP:LISTEN` |
| Windows | PowerShell `Get-CimInstance Win32_Process` | `netstat -ano`（过滤 LISTENING） |

每个端口收集**所有**监听地址（IPv4+IPv6、SO_REUSEPORT 多 fd），通配绑定
（`0.0.0.0` / `::`）展开为 127.0.0.1/::1 + 本机网卡 IP，供弹窗直接展示可点链接。

### D4. 安全模型

- 代理目标**只允许 127.0.0.1**（代码写死，不做 host 转发）
- 端口必须命中发现缓存：远程攻击者无法把 pi-web 当跳板访问同机的 Redis/MySQL 等
  （它们不是我们的子进程，也没有标记）
- 服务虚拟主机的主机白名单 = **后缀正则本身**（只匹配 loopback + `PI_WEB_SVC_HOST_SUFFIX`
  + `PI_WEB_ALLOWED_HOSTS`/`PI_WEB_HOSTNAME` 中的域名），服务分支**不额外**调用
  `isApiRequestHostAllowed`（否则 `5173.example.com` 会被拦，因为完整 hostname 不等于
  已配置主机名）；DNS rebinding 防护由正则约束 + 端口发现缓存共同保证
- 服务虚拟主机是独立 origin 命名空间：该 host 下所有路径（含 `/api/*`）都归测试
  服务，与 pi-web 自身的路由互不干扰

### D5. 服务虚拟主机后缀的匹配集合

`proxy.ts` 接受的后缀（`lib/service-ports.ts#getServiceHostSuffixes()`，按优先级）：

1. `.pi.localhost`（内置，loopback）
2. `PI_WEB_SVC_HOST_SUFFIX`（显式自定义）
3. `PI_WEB_HOSTNAME` / `PI_WEB_ALLOWED_HOSTS` 中的每个域名

所以部署在 `example.com` 的实例（request-security 已要求把该域名配进
`PI_WEB_ALLOWED_HOSTS`）**自动**支持 `5173.example.com`，无需额外配置。

### D6. 弹窗内每端口的访问方式（点击展开）

对每个发现端口展示：

- **直连（绕过 pi-web）**：`http://<监听IP>:<port>/`，每个监听地址一行
  （127.0.0.1 / ::1 / LAN IP / 具体绑定 IP，IPv6 加方括号）——**不带 basePath**
- **通过 pi-web 虚拟主机**：每个后缀一行，`<scheme>//<port><suffix><pagePort><basePath>`
  - **scheme 与端口取自当前页面 URL**（`location.protocol` / `location.port`）
  - 当前页面域名优先排在首位（标注"当前域名"），`.pi.localhost` 标注"本机"
  - 每行可点击打开 + 一键复制
- **开启此端口隧道**（`PortTunnelSection`）：就地列出该端口的隧道命令模板
  （cloudflared / localtunnel / ngrok / serveo，端口号已代入，可复制），点击"开启"
  即在当前位置启动隧道、**就地显示解析出的公网 URL**（可点击）与"停止"按钮；
  隧道名 `port-<端口>-<工具>`，URL 缓存在 globalThis，对话框刷新不丢失
- **顶部全局栏**：有已开启隧道（`port-*`）时，列表上方显示"已开启的端口隧道"——
  **一行一个隧道**（端口号 + 工具 + 状态），running 且有 URL 的带**打开**（新 tab
  开公网 URL），每行带**详情**按钮——点击自动展开该端口卡片并平滑滚动到它
  （`scrollIntoView`，卡片 id `port-card-<端口>`）；同端口多工具并列多行

所有"打开"动作（直连、虚拟主机、隧道 URL）均在**新浏览器 tab** 打开
（`window.open(url, "_blank", "noopener,noreferrer")`）。

弹窗底部说明区（端口页签底部）不再是常驻折叠文档："已配置隧道"独立折叠
（带运行计数与启停按钮，无配置时隐藏），另有两个**纯文字入口**点击打开弹窗——
**如何让其他设备访问**（本机 RFC 6761 零配置 / 局域网 dnsmasq
`address=/pi.lan/<服务器IP>` + 两个环境变量 / 公网 DNS 通配 A 记录 + 域名加入
`PI_WEB_ALLOWED_HOSTS`，附当前部署的地址形态示例）与**认证说明**（已内置
portal/basic/authelia + 可自行扩展的 Authelia/Authentik/oauth2-proxy/Keycloak/
Cloudflare Access，见下文「暴露前的授权管理」）。

### D7. basePath 处理

带 `PI_WEB_BASE_PATH` 部署（如 `https://example.com:8080/dev/`）时：

1. **走代理的 URL 带 basePath**：`http://5173.example.com:8080/dev`——反向代理
   按路径路由（nginx `location /dev/`）才能把请求送到 pi-web
2. **直连 URL 不带 basePath**：`http://127.0.0.1:5173/` 绕过 pi-web，无此需求
3. **proxy 转发前剥离**（`stripBasePath`，纯函数）：`/dev/foo → /foo`、`/dev → /`；
   不匹配 basePath 前缀的路径原样透传（页面引用的 `/assets/x.js` 照常）
4. **URL 不带尾斜杠**：`.../dev` 而非 `.../dev/`，避免 Next 的 basePath 308 重定向

> 前端页面资产因此无需重写：页面在 `/dev`（剥成 `/`），其引用的绝对路径
> `/assets/x.js`（无 basePath 前缀）原样透传到服务。

### D8. 隧道：只暴露服务端口 / 服务子域名，绝不 tunnel pi-web 本体

隧道只用于把**单个测试服务端口**（或它的虚拟主机子域名）暴露出去——pi-web
本体未经认证防护**绝不允许**走隧道。两种方式：

1. **端口卡片就地开启**（主路径）：弹窗展开端口 → "开启此端口隧道"，工具模板
   自动代入端口（cloudflared / localtunnel / ngrok / serveo），一键开启后**就地显示
   公网 URL**，URL 缓存在 globalThis 不丢失，随时可停止（`POST /api/tunnels` start/stop
   `{port, tool}` / `{name}`）
2. **启动时配置**：`PI_WEB_TUNNELS`（JSON）/ `PI_WEB_TUNNEL_CMD` 指向**服务端口**：

```bash
PI_WEB_TUNNEL_CMD="lt --port 8901"  npm run dev
PI_WEB_TUNNEL_CMD="/home/pi/pi-tunnels/cloudflared tunnel --url http://127.0.0.1:8901" npm run dev
PI_WEB_TUNNEL_CMD="ssh -R 80:127.0.0.1:8901 serveo.net" npm run dev
PI_WEB_TUNNELS='[{"name":"cfd","cmd":"cloudflared tunnel --url http://127.0.0.1:8901","auto":true}]'
```

- `auto: true` 启动时自动开启；其余列出但停止，弹窗里手动开
- 公网地址从进程输出解析（`extractTunnelUrl`）：**每段输出重算、已知隧道域名
  优先**（ngrok.io / trycloudflare.com / loca.lt / serveo.net / …），无关链接
  （如 cloudflared 打印的 cloudflare.com 官网）会被后面的真 URL 覆盖；输出与
  URL 缓存在 globalThis，**轮询刷新不丢失**
- 停止即 kill 进程；pi-web 退出（exit/SIGINT/SIGTERM）时全部清理
- 工具模板路径可探测（`~/pi-tunnels/<name>` / PATH）或 `PI_WEB_TUNNEL_TOOL_PATHS`
  JSON 覆盖；隧道进程以独立进程组运行（`detached`），停止/退出时整组清理，测试不会因残留 pipe 挂起
- **serveo**：必须带 `-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o
  ExitOnForwardFailure=yes`，否则首次 Host key 确认在非交互环境直接失败；公网
  URL 域名是 `serveousercontent.com`（已在已知域名列表）
- **ngrok**：有免费版（Free Hobbyist，1 在线隧道），但需先免费注册后在
  ngrok.com 控制台拿 token，执行 `ngrok config add-authtoken <token>`；UI 的
  "需 token" 标注悬停可见注册说明
- 服务后缀（`getServiceHostSuffixes`）自动过滤 IP 字面量（如 `PI_WEB_HOSTNAME=127.0.0.1`
  不会产生 `.127.0.0.1` 通配后缀）

**国内网络实测（2026-08）**：cloudflared 的 QUIC/HTTP2 edge 发现走 SRV 查询，
本地 DNS 会被 GFW 污染，需 `--edge <边缘IP>:7844 --edge-ip-version 4` 绕过（IP 从
`dig @1.1.1.1 a region1.v2.argotunnel.com +short` 取）。localtunnel 无此问题。
**不要把隧道指向 pi-web 端口（如 30142）**：隧道域名不在 `PI_WEB_ALLOWED_HOSTS`
时会被 DNS rebinding 防护 403，加白名单则等于无防护暴露 pi-web——危险。

## 架构

```
Browser                                  Next.js Server
  │  GET /api/services?refresh=1            app/api/services/route.ts
  │  ──────────────────────────────────▶   lib/service-ports.ts (发现 + 缓存 5s)
  │                                        · 进程树 BFS + 环境标记
  │                                        · 每端口多监听地址（通配展开）
  │  GET http://5173.pi.localhost:30142/    proxy.ts
  │  ──────────────────────────────────▶   Host 匹配多后缀正则 → isServicePortAllowed(5173)
  │                                        → stripBasePath(路径, basePath)
  │                                        → rewrite http://127.0.0.1:5173/
  │                                        · 静态/动态/表单/fetch 全通
  │  ServicesDialog（顶部工具条按钮，大小屏可见；端口/用户双页签）
  │  · 每 10s 自动刷新 · 点击端口行展开：
  │    直连地址（不带 basePath）+ 虚拟主机地址（带 basePath，scheme/端口取自页面）
  │  · 每行在新独立浏览器窗口打开 + 复制
  │  · 底部：已配置隧道折叠（启停）+ 两个说明弹窗入口（DNS/泛域名 · 认证指南）
  │
  │  启动时（instrumentation.ts）
  │  · PI_WEB_CHILD_MARKER → lib/service-ports（守护进程兜底）
  │  · PI_WEB_TUNNEL_CMD → lib/tunnels（spawn 隧道，退出时 kill）
```

### 文件清单

| 文件 | 职责 |
|---|---|
| `proxy.ts` | 虚拟主机反代入口（根目录，Next 16 proxy 约定）：多后缀匹配 + basePath 剥离 + 原有安全门 |
| `lib/service-ports.ts` | 跨平台发现 + 缓存白名单 + 多地址收集 + `getServiceHostSuffixes()` + `stripBasePath()` |
| `app/api/services/route.ts` | GET 端口列表 + `serviceHostSuffix(es)` + `platform` |
| `components/ServicesDialog.tsx` | 弹窗 UI（端口/用户页签 + 可展开行 + 直连/虚拟主机链接 + 新窗口打开 + 复制 + 已配置隧道折叠 + 说明弹窗） |
| `components/AppShell.tsx` | 顶部工具条图标按钮（13px，与历史/分支同规格）+ 弹窗挂载 |
| `instrumentation.ts` | 启动时写 `PI_WEB_CHILD_MARKER` + 启动隧道（`PI_WEB_TUNNEL_CMD`） |
| `lib/tunnels.ts` | 多隧道管理：配置解析、spawn/stop、URL 解析、输出缓存（globalThis 防丢） |
| `app/api/tunnels/route.ts` | POST start/stop 隧道，返回最新列表 |
| `lib/i18n/messages/{en,zh-CN}.ts` | `common.services` + `services.*` |
| `lib/service-ports.test.mjs` | 9 个测试：解码、解析、子进程发现、多地址、stripBasePath、守护进程标记 |
| `lib/tunnels.test.mjs` | 4 个测试：配置解析（多隧道+兼容）、URL 解析、start/stop 幂等、URL 跨刷新保持 |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_WEB_SVC_HOST_SUFFIX` | `.pi.localhost` | 显式自定义服务后缀，如 `.pi.lan` |
| `PI_WEB_ALLOWED_HOSTS` / `PI_WEB_HOSTNAME` | — | 已有配置；其域名自动成为服务后缀（如 `example.com` → `*.example.com`） |
| `PI_WEB_BASE_PATH` | — | 已有配置；服务 URL 携带、proxy 转发前剥离（见 D7） |
| `PI_WEB_TUNNELS` | — | 隧道清单 JSON：`[{name, cmd, auto?}]`，弹窗内可开/停（见 D8） |
| `PI_WEB_TUNNEL_CMD` / `PI_WEB_TUNNEL_NAME` | — | 旧单条写法（等价于一条 `auto:true` 隧道） |
| `PI_WEB_CHILD_MARKER` | 自动 | 子进程标记（一般无需手动设） |

## 泛域名解析配置（弹窗内同款说明）

| 场景 | 做法 |
|---|---|
| 本机 | `*.pi.localhost` 零配置，浏览器自动映射 127.0.0.1（RFC 6761） |
| 局域网 | dnsmasq 加 `address=/pi.lan/<服务器IP>`；设置 `PI_WEB_SVC_HOST_SUFFIX=.pi.lan`、`PI_WEB_ALLOWED_HOSTS=pi.lan` |
| 公网域名 | DNS 加通配 A 记录 `*.pi.example.com → <服务器IP>`；域名加入 `PI_WEB_ALLOWED_HOSTS` |
| 隧道 | 端口卡片就地开启（工具模板自动代入端口），或启动时 `PI_WEB_TUNNELS`/`PI_WEB_TUNNEL_CMD` 指向服务端口；**不要 tunnel pi-web 本体** |

## 本机已装工具（~/pi-tunnels）

```bash
~/pi-tunnels/cloudflared   # v2026.7.3，GitHub release（国内走 ghfast.top 镜像）
~/pi-tunnels/ngrok         # v3.39.10，equinox.io 直连；需先 ngrok config add-authtoken
lt                         # v2.0.2，npm -g localtunnel（npmmirror 镜像）

# 端口卡片就地开启（推荐）：弹窗展开端口 → "开启此端口隧道" → 选择工具
# 启动时配置（指向服务端口，示例）：
PI_WEB_TUNNEL_CMD="lt --port 8901"  npm run dev
```

## 暴露前的授权管理（弹窗内同款说明）

任何暴露方式（DNS 或隧道）都应先配置 HTTPS 与认证。

**已内置支持**（端口卡片「立即公开」中直接选用 provider）：
- `portal` —— 内置认证门户：自带用户管理与 TOTP 2FA（弹窗「用户」页签管理）
- `basic` —— HTTP Basic 认证：用户名 + 密码
- `authelia` —— 接入自托管 Authelia（forward_auth；Windows 不可用）

**可自行扩展**（在 pi-web / 隧道前置的 nginx 或 Caddy 上配置）：

| 工具 | 说明 |
|---|---|
| **Authelia**（28k★） | 自托管 SSO + 2FA 门户，配合 Caddy/nginx `forward_auth`（推荐首选） |
| **Authentik**（22k★） | 开源身份平台，OIDC/SAML/LDAP |
| **oauth2-proxy**（15k★） | 轻量反向代理认证，对接 Google/GitHub/OIDC |
| **Keycloak**（36k★） | 企业级 IAM（较重） |
| **Cloudflare Access** | 托管式零信任网关（免费额度） |

## 限制（已知）

1. **WebSocket 不过代理**：Next 服务器对非 HMR 的 upgrade 是 no-op。Vite HMR 等纯
   WS 链路需直连（同机 `http://localhost:<port>`）或隧道。
2. **硬编码绝对 URL**（页面里写死 `http://localhost:5173/x`）绕过代理：同机浏览器
   仍能直连所以可用，远程部署会失败。
3. **`*.pi.localhost` 只在浏览器本机生效**：远程浏览器需要按上表配置泛域名解析
   （dnsmasq 通配 / 域名通配 A 记录），或 hosts 逐条。
4. Windows 上 re-parent 守护进程无 env 标记兜底（CIM 读不到其他进程 env），依赖
   进程树；Windows 测试场景少见 daemonize，可接受。

## 测试

```bash
node --test lib/service-ports.test.mjs lib/tunnels.test.mjs
# service-ports：IPv4/IPv6 解码、cmdline 特征、lsof/netstat 解析、子进程端口发现、
#               多监听地址/通配展开、stripBasePath、daemonized 后代（env 标记）发现
# tunnels：配置解析（PI_WEB_TUNNELS + 旧 CMD 兼容）、URL 解析、start/stop、幂等、URL 跨刷新保持
```

端到端验证路径（已实测）：浏览器开新会话 → 让 pi 起测试服务 → `GET /api/services`
发现端口 → 弹窗展开显示直连（不带 basePath）+ 多后缀虚拟主机地址（带 basePath，
端口取自页面 URL）→ 端口卡片就地开启隧道（模板自动代入端口）→ 就地显示公网
URL → 所有"打开"在新浏览器 tab 打开；proxy 剥离 basePath 后服务返回正确内容
（echo 服务验证 `/dev/foo → /foo`）。

## 未来工作

- [ ] WS 代理：自定义 server 或 sidecar（`ws` + http-proxy）
- [ ] macOS/Windows 的 env 标记读取（macOS `ps eww` 解析）
