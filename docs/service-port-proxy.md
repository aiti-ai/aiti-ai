# 服务端口代理（Service Port Proxy）— 方案文档

> 目标：让 pi-web 的用户（浏览器）能直接访问 pi 会话里启动的测试服务端口，
> 完整支持网页（HTML/CSS/JS、SPA、表单、fetch、WebSocket），无需手动配置
> 端口白名单。

实现基于 **service-tunnels 库**（npm 依赖）的进程内集成：发现、虚拟主机路由、
暴露/隧道、认证（provider/站点/用户/TOTP）全部由库负责，pi-web 只做薄适配
（`lib/service-tunnels-integration.ts` 单例 + `app/api/service-tunnels` 路由 +
弹窗 UI）。

## 方案决策

### D1. 用 hostname 虚拟主机挂载，不用 path-prefix

| | path-prefix（`/api/svc/5173/...`） | hostname 虚拟主机（`5173.pi.localhost/`） |
|---|---|---|
| 绝对路径资源（`/assets/x.js`） | ❌ 前缀丢失 → 404 | ✅ 路径原样保留 |
| SPA 路由 / fetch / 表单 action | ❌ 需要内容重写 | ✅ 天然工作 |
| 同源（无 CORS） | ✅ | ✅ |
| 浏览器解析 | — | `*.localhost` 原生 → 127.0.0.1（RFC 6761，无需改 hosts） |

**决策：`proxy.ts` 按 `Host: <port>[-<label>].<domain>` 匹配（库的
`parseHost`），`resolve()` 给出放行/认证/转发决策，Next 通过 rewrite 转发。**

### D2. 端口白名单 = 显式 enrollment（default zero-forward）

不做手工白名单、不做进程树宽泛发现。可被代理的端口集合 = **库的持久化
enrollment**（`~/.pi/service-tunnels-cache/state.json` 的 bindings）：

1. **发现**（`discovery.getPorts()`）只负责给 UI 列候选端口：跨平台进程树遍历
   （Linux `/proc`、macOS `ps`、Windows `Get-CimInstance`）+ 监听端口枚举
   （`/proc/net/tcp{,6}`、`lsof`、`netstat`）+ 守护进程 env 标记兜底
   （`PI_WEB_CHILD_MARKER` 风格，仅 Linux 可读 `/proc/<pid>/environ`）。
2. **enrollment**：用户在弹窗里「暴露」（expose）一个端口后才进 allow-list；
   未 enrolled 的端口一律不代理（`proxy` 的默认决策是 deny）。

**决策：代理 = enrolled 且 running 的 expose（`proxy`/`both` 模式产生本地
虚拟主机）。发现结果只是候选，不是授权。**

### D3. 跨平台后端

进程树 / cmdline / 端口枚举的平台差异全部在 service-tunnels 库内实现
（Linux /proc、macOS ps+lsof、Windows CIM+netstat，通配地址展开为
127.0.0.1/::1 + 网卡 IP）。pi-web 侧只提供本进程 cmdline 特征
（`PI_WEB_OWN`）把 pi-web 自身排除在「服务」之外。

### D4. 安全模型

- 代理目标**只允许 127.0.0.1**（库内写死，不做 host 转发）
- 端口必须命中 **enrollment**：远程攻击者无法把 pi-web 当跳板访问同机的
  Redis/MySQL 等（未 enrolled 即 deny）
- 虚拟主机的路由 / allow-list / 403 **只有一份实现**——库的
  `proxy.parseHost` + `proxy.resolve`，在 proxy.ts（middleware，与 app
  server 同进程共享 globalThis）里进程内调用；无独立代理端口
- 站点认证：`pi-web`（自己的管理 UI）与 `services`（子进程 dev 服务）是
  **两个隔离的认证域**（不同域名、不同用户库、不同 provider），
  `ensureSites()` 幂等预设；暴露时可选 portal / basic / authelia 认证，
  `resolve()` 内完成 forward-auth 探测与登录跳转
- 服务虚拟主机是独立 origin 命名空间：该 host 下所有路径（含 `/api/*`）
  归测试服务，与 pi-web 自身路由互不干扰

### D5. 服务虚拟主机后缀的匹配集合

库接受的部署域（`getBaseDomains()`，按优先级）：

1. `PI_WEB_BASE_DOMAIN`（显式，逗号分隔，`host:port` 形式允许——匹配用
   host，生成的 URL 保留端口）
2. `PI_WEB_ALLOWED_HOSTS`（旧 fallback）
3. `PI_WEB_HOSTNAME`（旧 fallback；IP 字面量被丢弃，永不产生通配后缀）

本地回环后缀 `.pi.localhost`（内置）与 `PI_WEB_SVC_HOST_SUFFIX`（显式自定义）
同样生效。`lib/service-proxy-shared.ts#getServiceHostSuffixes()` 汇总全部
可接受后缀（middleware 与 server 共用，避免两处不一致）。

### D6. ServicesDialog（弹窗，顶部工具条进入，10s 自动刷新）

**Ports 页签**：每个发现端口一行，点击展开：

- **直连（绕过 pi-web）**：`http://<监听IP>:<port>/`，每个监听地址一行
  （127.0.0.1 / ::1 / LAN IP / 具体绑定 IP，IPv6 加方括号）——不带 basePath
- **通过 pi-web 虚拟主机**：`<scheme>//<port>.<domain><pagePort><basePath>`
  （scheme/端口取自当前页面 URL；当前域名优先、`.pi.localhost` 标注本机）
- **暴露表单（schema 驱动）**：选择模式 `tunnel`（公网 URL）/ `proxy`
  （本地虚拟主机，不建隧道）/ `both`（两者，同一站点）、隧道类型
  （cloudflared / ngrok / frpc / localtunnel，schema 来自库的
  `tunnelSchemas`）、认证 provider（portal / basic / authelia，schema 来自
  `authProviderSchemas`）、站点（`services` / `pi-web` / `default`）、
  策略（one_factor / two_factor）、协议（http / https / tcp——**tcp 暴露
  不带认证**）；部分 provider 需要额外参数（如 ngrok authtoken）
- **已开启的暴露**：状态、本地/公网 URL（打开 + 复制）、nginx 访问/错误日志
  （`?logs=<exposeName>`）、停止
- **允许工具下载**开关（`set-allow-tool-download`）

**Users 页签**：provider 用户管理（`userManagers` 驱动）——增删用户、改密、
站点切换（`pi-web` / `services` 分开的用户库）、TOTP 2FA 登记/激活/停用。

所有「打开」动作都在新浏览器 tab（`window.open(..., "noopener,noreferrer")`）。

### D7. basePath 处理

带 `PI_WEB_BASE_PATH` 部署（如 `https://example.com:8080/dev/`）时：

1. **走代理的 URL 带 basePath**：`http://5173.example.com:8080/dev`——反向
   代理按路径路由才能把请求送到 pi-web
2. **直连 URL 不带 basePath**：绕过 pi-web，无此需求
3. **库的 `deployBasePath`**：合并到认证登录路径下（portal 登录在
   `/dev/portal/login`）；转发前按 basePath 剥离路径前缀
4. URL 不带尾斜杠（避免 Next 的 basePath 308 重定向）

### D8. 隧道与暴露：只暴露服务端口，绝不 tunnel pi-web 本体

隧道/暴露全部走库的 `auth.expose`（弹窗「暴露」表单或
`POST /api/service-tunnels/expose`）——**无启动时环境变量配置**，一律就地开启。

- 暴露 = 把**单个服务端口**（或它的虚拟主机）通过隧道/本地虚拟主机公开，
  URL 由库解析（已知隧道域名优先，无关链接被真 URL 覆盖）、缓存持久化，
  可随时停止；pi-web 退出时库的清理钩子（角色标记 + guardian）随进程回收
- 工具路径由库解析（PATH + 库缓存/下载），无需 pi-web 侧配置
- **不要把隧道指向 pi-web 本体端口**：隧道域名不在允许列表会被
  DNS-rebinding 防护 403；加白名单则等于无防护暴露 pi-web——危险

### D9. 认证 provider（弹窗「立即公开」）

- `portal` —— 内置认证门户：自带用户管理与 TOTP 2FA（「用户」页签管理）
- `basic` —— HTTP Basic：用户名 + 密码
- `authelia` —— 接入自托管 Authelia（forward_auth；Windows 不可用）

provider 知识（顺序、默认值、用户管理器、schema）**全部来自库**
（`providerOrder` / `defaultProvider` / `userManagers` / `tunnelSchemas` /
`authProviderSchemas`），pi-web 不硬编码任何 provider 名。

## 架构

```
Browser                                  Next.js Server
  │  GET /api/services?refresh=1          app/api/services/route.ts
  │  ──────────────────────────────────▶ lib/service-ports.ts (候选端口列表)
  │
  │  GET /api/service-tunnels             app/api/service-tunnels/route.ts
  │  ──────────────────────────────────▶ 状态：发现/内部端口/隧道/暴露/provider/站点
  │  POST /api/service-tunnels/expose     exposeService()（enroll → 本地虚拟主机/隧道）
  │  POST /api/service-tunnels/tunnel     tunnel start/stop/stop-all
  │  POST /api/service-tunnels/user-*     provider 用户管理 + TOTP
  │
  │  GET http://5173.pi.localhost:30141/  proxy.ts（middleware，同进程）
  │  ──────────────────────────────────▶ st.proxy.parseHost(host) → resolve()
  │                                     · deny / deny-auth(401) / pipe(rewrite
  │                                       127.0.0.1:<port>，含 WS upgrade) /
  │                                       redirect(登录) / forward
  │
  │  ServicesDialog（顶部工具条；Ports / Users 双页签，10s 自动刷新）
  │  · 端口行展开：直连 + 虚拟主机地址 + 暴露表单（schema 驱动）+ 已开暴露
  │  · 用户页签：增删用户/改密/TOTP（按站点隔离）
  │
  │  启动时（instrumentation.ts）
  │  · getServiceTunnels() → globalThis.__piServiceTunnels（库单例）
```

**关键：middleware（proxy.ts）与 app server 同进程、共享 globalThis** ——
路由决策在 middleware 里进程内调用库实例，无文件/IPC 通道、无 TTL 缓存。

## 文件清单

| 文件 | 职责 |
|---|---|
| `proxy.ts` | 安全门 + 服务虚拟主机入口：`st.proxy.parseHost/resolve` → deny/401/rewrite/redirect；Next 内部 http-proxy 处理 HTTP + WebSocket |
| `lib/service-tunnels-integration.ts` | 库单例（globalThis）：configDir/cacheDir/marker/deployBasePath/baseDomain 装配；`exposeService`/`exposeSelf`/`ensureSites` |
| `lib/service-ports.ts` | 发现适配（候选列表）+ 后缀/baseDomain helpers（复用 middleware-safe 版本） |
| `lib/service-proxy-shared.ts` | middleware-safe helpers（无库依赖）：`getBaseDomains`/`getServiceHostSuffixes`/`isServicePortAllowed`（从 globalThis 读 enrollment） |
| `lib/tunnels.ts` | 隧道信息适配（thin adapter，管理逻辑在库内） |
| `app/api/service-tunnels/route.ts` | GET 状态（+logs/detect 子查询）；POST expose/tunnel/user/TOTP/allow-download |
| `app/api/services/route.ts` | GET 端口候选列表 + 后缀 + 平台 |
| `components/ServicesDialog.tsx` | 弹窗 UI（Ports/Users 页签、schema 驱动表单、URL 打开/复制、日志、TOTP） |
| `instrumentation.ts` | 启动时初始化库单例 + `maybeExposeSelf`（PI_WEB_EXPOSE） |
| `lib/service-proxy-shared.ts` | middleware-safe：后缀/部署域、self 门控（allowlocal）、隧道域名→虚拟主机映射 |
| `lib/service-proxy-shared.test.mjs` | secret/allowlocal/端口/映射/解析单元测试 |
| `lib/service-ports.test.mjs` | 发现/解码/多地址/子进程/守护进程标记测试 |
| `lib/request-security.test.mjs` | API origin / host 校验测试 |
| `lib/web-auth.test.mjs` | 可选密码门测试 |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_WEB_SVC_HOST_SUFFIX` | `.pi.localhost` | 显式自定义服务后缀，如 `.pi.lan` |
| `PI_WEB_BASE_DOMAIN` | — | 部署域（逗号分隔，`host:port` 允许）；`<port>.<domain>` 服务虚拟主机 + expose 的 portless baseUrl；首个为主域 |
| `PI_WEB_ALLOWED_HOSTS` / `PI_WEB_HOSTNAME` | — | 旧 fallback；域名自动成为服务后缀 |
| `PI_WEB_BASE_PATH` | — | 子路径部署（如 `/dev`）；作为 `deployBasePath` 传给库（认证登录路径合并 + 转发前剥离） |
| `PI_WEB_PASSWORD` | — | pi-web 自身的可选 Basic 密码门（沿用） |
| `PI_WEB_EXPOSE` | — | **启动时暴露 pi-web 自身**（纯 `k=v,k2=v2` 逗号格式，无 JSON），见下节 |

> 服务端口隧道无启动时环境变量配置——一律从弹窗「暴露」就地开启；`PI_WEB_EXPOSE`
> 只负责 pi-web **自身**的暴露。

## 暴露 pi-web 自身（PI_WEB_EXPOSE）

把 pi-web 自己的管理 UI 暴露给外部用户，**所有授权访问都走 proxy 认证**（没有
放行后门）。环境变量用纯 `a=b,c=d` 格式（不要求 JSON）：

```bash
# 本地虚拟主机 + portal 认证（最简）
PI_WEB_EXPOSE="mode=proxy" npm run dev

# 仅配置 allowlocal/allowHost，不暴露自身（mode 省略 = none）
PI_WEB_EXPOSE="allowlocal=false,allowHost=pi.example.com" npm run dev

# 公网隧道 + 双因素
PI_WEB_EXPOSE="mode=both,tunnel=cloudflared,auth=portal,policy=two_factor" npm run dev

# ngrok 自定义域名 + 预置用户
PI_WEB_EXPOSE="mode=tunnel,tunnel=ngrok,tunnel.domain=alice.ngrok-free.app,ngrokAuthtoken=xxx,user.name=admin,user.password=pw" npm run dev

# 自防护反代直连例外（必须显式声明：裸部署域默认走 proxy 认证）
PI_WEB_EXPOSE="mode=proxy,allowlocal=false,allowHost=pi.example.com,allowHost=backup.example.com" npm run dev
```

**字段**（键名对齐 service-tunnels CLI）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `none` | `none`（默认，仅应用 allowlocal/allowHost 配置，**不暴露自身**）/ `proxy`（本地虚拟主机，不建隧道）/ `both` / `tunnel` |
| `auth` | `portal` | `portal` / `basic` / `authelia` / `auto` / `none` |
| `policy` | 跟随 site（two_factor） | `one_factor` / `two_factor` / `deny` |
| `tunnel` | `cloudflared` | 隧道类型（mode 含 tunnel 时） |
| `protocol` | auto-detect | `http` / `https` / `tcp` |
| `allowToolDownload` | 库默认 | `true` / `false` |
| `allowlocal` | `true` | 直连门控，见下 |
| `allowHost` | — | **例外域名**（可重复键，如 `allowHost=pi.example.com,allowHost=backup.example.com`，或单键空格分隔）；allowlocal=false 时仍允许直连的域名——你自己防护层（反代）转发的入口。**部署域不会自动例外**，需要显式列出 |
| `port` | `PORT ?? 30141` | 显式覆盖自身端口（应对 `--port` 自定义 + 未设 PORT） |
| `ngrokAuthtoken` | — | ngrok 专用 |
| `user.name` / `user.password` | — | 预置认证用户 |
| `tunnel.<字段>` | — | 隧道 schema 参数（`domain`/`server`/`token`/…） |
| `provider.<路径>` | — | provider 参数（点号嵌套） |

**固定值**：`site="pi-web"`（与 dev 服务隔离的认证域）、
`tunnelName=expose-self-<port>`；解析规则：逗号分隔、未知键警告忽略、
`mode` 省略默认 `none`（只应用配置不暴露），非法 mode 不启用（fail-closed）；启动失败只打日志不阻塞。

**安全模型**（self-expose 的三个入口，全部经 proxy 认证）：

```
外部用户 ──▶ 虚拟主机域名（<port>-pi-web.<domain>）──▶ proxy resolve（cookie 认证）──▶ 放行
外部用户 ──▶ 隧道公网域名（ngrok/trycloudflare/…）────▶ 映射为虚拟主机 ──▶ 同上一行
LAN 直连（192.168.x.x:<port>，仅监听外网时）───────────▶ allowlocal=false → 403
回环直连（127.0.0.1/localhost）───────────────────────▶ 本机可信，放行（可配 PI_WEB_PASSWORD）
```

- **隧道域名映射**：middleware 把 self 暴露的隧道公网域名请求的 Host 映射为
  该暴露的虚拟主机域名，走同一个 `resolve()`（portal/basic cookie 校验）——
  无 cookie → 302 登录页，伪造 Host 也无法绕过认证（无白名单后门）。
  tunnel 模式暴露时自动注册对应的 proxy binding（`<port>-pi-web.<suffix>`）。
- **allowlocal=false**：拦截非回环 Host 的直连（LAN/公网 403）；**例外只认显式
  `allowHost` 列表**（env + UI 运行时覆盖）——部署域**不会自动放行**：裸部署域
  请求要么走 proxy 认证（虚拟主机形式 `<port>-pi-web.<domain>`），要么显式
  列进 `allowHost`（声明由你自己的防护层负责）。这样「所有授权访问走 proxy」
  的默认语义不被隐式例外破坏。锁死后管理入口（UI 页签/API）仍可通过认证
  网关访问。
- **铁律**：暴露期间保持 pi-web 只监听回环（不要 `-H 0.0.0.0`）——一旦监听
  外网，局域网直连虽然被 allowlocal 拦，但隧道/虚拟主机入口依赖网关认证，
  监听外网会把攻击面扩大到本地端口本身。
- 附带机制：旋转 internal secret（**60 秒轮换 + 15s 宽限**）作为纵深——
  middleware 转发时附加 `x-pi-web-internal`。**注意**：Next 的外部 rewrite
  不传递 middleware 修改的自定义 header，当前门控实际由「回环 Host 判断」
  承担；若未来转发改为 http-proxy（可控 header）即可直接启用 secret 校验。
  轮换不是防爆破（128-bit 随机不可爆破），而是让泄漏自动过期：宽限期覆盖
  in-flight 转发（毫秒级），15s 绰绰有余。
- UI 里可实时管理（ServicesDialog「Pi-web」页签）：地址列表、暴露开关、
  allowlocal 切换、生成 `PI_WEB_EXPOSE` 片段供抄到启动脚本（界面改动一次性
  生效，重启恢复环境变量值）。
- **与 `PI_WEB_PASSWORD` 互斥**：self-expose 时不要同时设 `PI_WEB_PASSWORD`
  （网关转发的请求不带 Basic 头，会被密码门拦）；本机直连由 allowlocal
  语义（回环放行）承担，外部由网关认证承担。

## 泛域名解析配置（弹窗内同款说明）

| 场景 | 做法 |
|---|---|
| 本机 | `*.pi.localhost` 零配置，浏览器自动映射 127.0.0.1（RFC 6761） |
| 局域网 | dnsmasq 加 `address=/pi.lan/<服务器IP>`；设置 `PI_WEB_SVC_HOST_SUFFIX=.pi.lan`、`PI_WEB_ALLOWED_HOSTS=pi.lan` |
| 公网域名 | DNS 加通配 A 记录 `*.example.com → <服务器IP>`；域名加入 `PI_WEB_BASE_DOMAIN`（或旧 `PI_WEB_ALLOWED_HOSTS`） |
| 隧道 | 弹窗「暴露」就地开启（schema 驱动，自动代入端口）；**不要 tunnel pi-web 本体** |

## 暴露前的授权管理

任何暴露方式（DNS 或隧道）都应先配置 HTTPS 与认证。弹窗「暴露」表单中
直接选用 provider（portal / basic / authelia），或用 forward-auth 接入外部
身份平台：

| 工具 | 说明 |
|---|---|
| **Authelia** | 自托管 SSO + 2FA 门户，配合 Caddy/nginx `forward_auth`（推荐首选） |
| **Authentik** | 开源身份平台，OIDC/SAML/LDAP |
| **oauth2-proxy** | 轻量反向代理认证，对接 Google/GitHub/OIDC |
| **Keycloak** | 企业级 IAM（较重） |
| **Cloudflare Access** | 托管式零信任网关（免费额度） |

## 限制（已知）

1. **WebSocket**：通过 proxy 的服务虚拟主机 **支持** WS 升级（Next rewrite
   的内部 http-proxy 处理 HTTP + WS）。不经过 pi-web 的直连/独立监听不受影响。
2. **硬编码绝对 URL**（页面里写死 `http://localhost:5173/x`）绕过代理：
   同机浏览器仍能直连，远程部署会失败。
3. **`*.pi.localhost` 只在浏览器本机生效**：远程浏览器需要按上表配置泛域名
   解析（dnsmasq 通配 / 域名通配 A 记录），或 hosts 逐条。
4. **Windows 的守护进程 env 标记不可读**（CIM 读不到其他进程 env），依赖
   进程树；Windows 测试场景少见 daemonize，可接受。
5. **tcp 暴露不带认证**（库的 tcp 路径忽略 provider），仅限可信网络。

## 测试

```bash
node --test lib/service-ports.test.mjs lib/request-security.test.mjs lib/web-auth.test.mjs
# service-ports：IPv4/IPv6 解码、cmdline 特征、lsof/netstat 解析、子进程端口发现、
#               多监听地址/通配展开、stripBasePath、daemonized 后代（env 标记）发现
# request-security：API origin/host 校验（DNS-rebinding 门）
# web-auth：可选 Basic 密码门
```

端到端验证路径：浏览器开新会话 → 让 pi 起测试服务 → `GET /api/services` 列出
端口 → 弹窗展开显示直连 + 虚拟主机地址 → 暴露（proxy 模式）→ 通过
`<port>.pi.localhost` 访问服务（HTTP + WS）→ 带 provider 的暴露验证登录跳转 →
Users 页签验证用户管理 + TOTP。

## 未来工作

- [ ] 更多隧道 provider 的 schema 透传（跟随 service-tunnels 库演进）
- [ ] 暴露粒度细化：按路径 / 按 header 的访问控制策略
