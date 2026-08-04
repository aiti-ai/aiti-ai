# 隧道 + 授权（Authelia 等）自动配置 — 调研与方案

> 目标：让 pi-web 的隧道功能（`PI_WEB_TUNNELS` 启动的 ngrok / cloudflared / localtunnel /
> ssh -R 等）在暴露到公网时**自动**接上 Authelia / Authentik / Keycloak / oauth2-proxy /
> Cloudflare Access 等授权层，而不是停留在"弹窗里贴一段提示"。
>
> 调研时间：2026-04（基于各工具官方文档与源码，含 ngrok Traffic Policy / OIDC action、
> Authelia OpenID Connect 配置与 access-control 源码、Cloudflare TryCloudflare、
> oauth2-proxy 配置）。

---

## 1. 结论速览（TL;DR）

| 隧道工具 | 原生边缘认证 | 接 Authelia 的路径 | 回调 URL 是否依赖隧道域名 | 自动化难度 |
|---|---|---|---|---|
| **ngrok** | ✅ OAuth / OIDC / BasicAuth（边缘侧） | **edge-oidc**：Traffic Policy 的 `openid-connect` action 指向 Authelia | ❌ **固定** `https://idp.ngrok.com/oauth2/callback` | ★ 最容易 |
| **cloudflared** quick tunnel（trycloudflare） | ❌ 无（随机域名、无 Access 策略、且**不支持 SSE**） | 只能本地 sidecar | — | ★★★ |
| **cloudflared** named tunnel | ✅ Cloudflare Access（需自有域名 + zone） | Access 应用 + Authelia 作为 **Generic OIDC** | 固定 `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` | ★★ |
| **localtunnel / serveo / loca.lt / ssh -R** | ❌ 无 | 只能本地 sidecar | — | ★★★ |

**四条可行路径**：

- **路径 A — 边缘 OIDC（最自动，仅 ngrok）**：认证在 ngrok 边缘完成，本地零额外进程；
  回调 URL 固定为 `idp.ngrok.com/oauth2/callback`，**与随机隧道域名无关**，因此可以
  静态注册在 Authelia，隧道每次重启域名变化也不影响。
- **路径 B3 — per-tunnel nginx + Authelia base-path（pi-web 最优默认，见 3.5 / 3.6）**：
  Authelia 以 base-path 部署（`server.address: 'tcp://:9091/authelia'`）；
  **每条隧道配一个本地 nginx 实例（随机端口）**，应用独占**根路径**、
  `location /authelia/` 反代门户——无路径前缀问题、无 OIDC client 注册
  （forward_auth）、无"自有域名"要求。域名认领两档：固定 dev domain 预登记一条
  YAML；**随机域名用"动态登记"**（先启隧道拿主机名 → 写多配置文件 → 重启
  Authelia，见 3.6）。
- **路径 B1 — oauth2-proxy sidecar（通用兜底）**：pi-web 在隧道进程前插入
  一个 oauth2-proxy 进程，隧道 upstream 指向 `127.0.0.1:4180`。适用于任意隧道工具。
  前提：**隧道域名固定**（每次重启不变即可，ngrok 免费版账号级固定 dev domain 就满足；
  是 ngrok 的域还是你自己的域无所谓，见 2.2）。
- **路径 B2 — Caddy/nginx + Authelia forward_auth（更简单但限会话域名子域）**：无需注册
  OIDC client、无需 client secret，但**应用主机必须落在 Authelia 会话 cookie 的作用域内**
  （即 session 域名或其子域，官方文档原文）——因为 forward_auth 依赖浏览器把 Authelia
  的登录 cookie 带给应用。随机/第三方隧道域名（`*.ngrok-free.app` / `*.trycloudflare.com`
  等）在 Public Suffix List 上且不在你的会话域名之下，**不行**（机制详见 2.2 / 3.2）。
- **路径 C — Cloudflare Access（进阶）**：named tunnel + Access 应用（Authelia 官方
  支持作为 Generic OIDC provider）。Access 应用可用 Cloudflare API 自动化，但整体
  最重，作为可选。

---

## 2. 调研事实（官方文档核对）

### 2.1 ngrok — 支持 OIDC，且回调 URL 固定（关键发现）

ngrok 的 **OpenID Connect action**（Traffic Policy 的 `openid-connect`，官方文档
`/docs/traffic-policy/actions/oidc`）就是为"任意 OIDC 提供方"设计的：

```yaml
# policy.yml —— 在 ngrok 边缘执行认证
on_http_request:
  - actions:
      - type: openid-connect
        config:
          issuer_url: https://auth.example.com      # Authelia 的 issuer
          client_id: pi-web-ngrok
          client_secret: '<从 Authelia 生成的 secret>'
          scopes:
            - openid
            - profile
            - email
```

- 应用方式：`ngrok http 30141 --traffic-policy-file policy.yml`，或写进 ngrok.yml 的
  `endpoints[].traffic_policy` 后 `ngrok start <name>`（Agent Endpoint 支持 Traffic
  Policy，不需要 dashboard）。
- **回调 URL 固定为 `https://idp.ngrok.com/oauth2/callback`**（官方原话：
  "When you create your own OIDC app, you must specify a 'Callback URL' … that Callback
  URL is always: `https://idp.ngrok.com/oauth2/callback`"）。也就是说 ngrok 自己代理了
  OIDC 授权码流程，隧道域名随便变都不影响 Authelia 侧的注册。
- 认证后行为：设置 `session`/`nonce` cookie，回跳原始 URI；`/ngrok/login`、
  `/ngrok/logout` 特殊路径可显式登录/登出；支持按 `allow_emails` /
  `allow_email_domains` 白名单，支持 `userinfo_refresh_interval` 持续鉴权。
- 若不想自建 OIDC 应用，ngrok 还有 OAuth action（Google/GitHub/GitLab/LinkedIn/
  Microsoft/Twitch/Amazon/Facebook，部分提供托管应用免配 client id），以及
  BasicAuth 模块（`--basic-auth user:pass`）。但接 Authelia 必须走 OIDC action。
- 免费版含**账号级固定 dev domain**（"Your development domain is specific to your
  account"），sidecar 路径 B1 也可用：`ngrok http 30141 --domain <你的dev域>` 钉住
  域名。

### 2.2 Authelia — 静态客户端注册，无 DCR，回调精确匹配；access_control 限 session 域名

- Authelia 的 OIDC 客户端是**静态配置**在 `configuration.yml` 的
  `identity_providers.oidc.clients`，**没有 RFC 7591 动态客户端注册（DCR）**——这是
  "全自动"的最大障碍，因此"自动配"落在 pi-web 侧（注入凭据/生成配置），
  Authelia 侧仍是一次性预注册。
- 客户端关键字段（官方 clients 配置页核对）：
  - `client_id`（≤100 字符，RFC3986 unreserved）
  - `client_secret`（管理员生成）
  - `redirect_uris`（**必填**）：**精确匹配、大小写敏感、不支持通配符**——所有未列出
    的回调都会被拒。**该限制只针对 OIDC 回调，与 access_control 的域名限制是两回事。**
  - `scopes` 默认 `openid,groups,profile,email`；`grant_types` 默认
    `authorization_code`；`response_types` 默认 `code`；
    `token_endpoint_auth_method` 默认 `client_secret_basic`。
  - `authorization_policy: one_factor | two_factor`、`require_pkce` 等按需。
- **access_control 域名限制 = 会话 cookie 作用域限制**（官方源码
  `docs/content/configuration/security/access-control.md` 原文）：
  > "Domains in this section must be the domain configured in the session
  > configuration or subdomains of that domain. This is because a website can only
  > write cookies for a domain it is part of."

  机制：Authelia 在门户登录后把 `authelia_session` cookie 种在 **session 域名**上
  （`session.cookies[].domain`，如 `example.com`），浏览器只会把这个 cookie 发给该域
  名下的所有主机。forward_auth 流程中 Caddy 把应用请求连同 cookie 转发给 Authelia
  校验，**应用主机不在 cookie 作用域内时，浏览器根本不会携带 Authelia 的会话
  cookie → 永远判未认证 → 门户重定向死循环**。所以
  `access_control.rules[].domain`（含 `*.` 通配）只能写 session 域名或其子域。
  **为什么不能"配 `*.ngrok-free.app` 覆盖全部"**（三层拒绝，源码核实）：
  1. `session.cookies[].domain` 校验器明确拒绝 `*.` 开头（`validator/session.go`：
     `errFmtSessionDomainMustBeRoot`）——它语义上就是 cookie 的 Domain 属性
     （RFC 6265 不允许通配符）；
  2. 不带 `*` 的 `ngrok-free.app` 也被拒（`isCookieDomainAPublicSuffix`：PSL 域，
     浏览器拒绝种 cookie）；
  3. 授权判定**前置步骤** `GetCookieDomainFromTargetURI()` 已按目标主机对
     `session.cookies[].domain` 做后缀匹配，**无匹配直接 400**——随机主机根本走不到
     access_control 规则判定（规则层的 `*.` 通配虽合法，但够不着）。
  **但"动态登记"可以绕过枚举限制**（见 3.6）：Authelia 支持多配置文件合并
  （`--config a.yml --config b.yml`，官方文档 "Multiple Configuration Files"），
  先启动隧道拿到主机名，再写入动态文件并**重启 Authelia** 即可认领该主机——
  随机域名 `a1b2c3.ngrok-free.app` 本身不是 PSL（`ngrok-free.app` 才是），
  作为 cookie domain 合法。只有 PSL 层（裸 `ngrok-free.app`）永远不可配置。
  补充：session 域名不能是 Public Suffix List（PSL）域（官方
  `session/introduction.md`：浏览器拒绝为 `duckdns.org`、`ngrok-free.app` 等 PSL 域
  种 cookie）——隧道工具的三方域名全部在 PSL 上，连配置都配不了。
  **oauth2-proxy 路径（B1）不受此限制**：会话 cookie 由 oauth2-proxy 种在**应用自己的
  主机**（隧道域名）上，Authelia 只做登录门户 + token 端点，`redirect_uris` 只是
  "授权码送回哪"的 OIDC 白名单，与 cookie 作用域无关（详见 3.1）。
- Authelia 的 OIDC **issuer/发现端点必须公网可达**（ngrok 边缘和 Cloudflare 边缘要
  做 discovery + 后端 token/userinfo 调用，oauth2-proxy 同理要访问 token 端点），
  即 Authelia 自己也要有一个公网域名 + HTTPS。

### 2.3 oauth2-proxy（路径 B1 的实现体）

- OIDC provider 配置（官方 providers 文档）：`--provider=oidc
  --oidc-issuer-url=<issuer> --client-id=... --client-secret=... --cookie-secret=...`
  加 `--email-domain=*`（或 `--allowed-email=` 白名单）；另有
  `--provider=keycloak-oidc` 专门适配 Keycloak。
- 回调路径固定为 `/oauth2/callback`，完整回调 URL = `https://<隧道域名>/oauth2/callback`。
- 流式支持：`--proxy-websockets` 开 WebSocket 代理；`--flush-interval` 控制流式响应
  （SSE）刷盘频率。
- 本地结构：`oauth2-proxy --http-address=127.0.0.1:4180
  --upstream=http://127.0.0.1:<测试端口>`，隧道 upstream 指向
  `http://127.0.0.1:4180`。认证失败返回 302 到 OIDC 授权端。
- 可选项：`--set-xauthrequest` 把 `X-Auth-Request-User/Email/Groups` 头透传给上游。

### 2.4 Caddy + Authelia forward_auth（路径 B2）

- Authelia 官方 Caddy 集成（`integration/proxies/caddy.md`）：
  ```caddyfile
  example.com {
      forward_auth authelia:9091 {
          uri /api/authz/forward-auth
          copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
      }
      reverse_proxy nextcloud:80
  }
  ```
  未认证时 Authelia 返回 401 + 302 到门户（带 `rd` 回跳参数），登录后回跳原 URL。
  会话 cookie 落在 Authelia 域名上，**无需为每个应用注册 OIDC client**。
- 代价就是 2.2 的 access_control 域名限制：应用必须是 session 域名的子域。

### 2.5 cloudflared

- **Quick tunnel**（`cloudflared tunnel --url http://localhost:30141`）：随机
  trycloudflare.com 子域名，**无任何认证**，且官方明确 quick tunnel **不支持 SSE**
  （pi-web 的会话流是 SSE，这点要警示）、并发上限 200 in-flight；存在
  `~/.cloudflared/config.yaml` 时 quick tunnel 直接不可用。**不建议生产暴露。**
- **Named tunnel**：路由到自有域名，可在 Cloudflare 侧配 **Access 应用**；Authelia
  官方有 Cloudflare Zero Trust 集成指南：Access 选 Generic OIDC，Authelia 侧注册
  client，`redirect_uris` 固定为
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`，
  token_endpoint_auth_method 用 `client_secret_basic`，claims 需要随 access token
  返回（Authelia 有 escape hatch）。Access 应用本身可通过 Cloudflare API
  （`/accounts/{account_id}/access/apps`）自动化。

### 2.6 Authentik / Keycloak（比 Authelia 更"自动"的选项）

- 两者都是标准 OIDC 提供方，**issuer 换成它们即可复用路径 A / B1**。
- 与 Authelia 不同，**Authentik 和 Keycloak 都有管理 API，Keycloak 还支持 DCR**，
  客户端可以程序化创建/轮换 —— 如果"自动注册"是硬需求，它们比 Authelia 更顺。
- Keycloak 注意：oauth2-proxy 有专门的 `keycloak-oidc` provider；ngrok OIDC action
  走标准 discovery，无需特判。

---

## 3. 路径 B 方案详解（sidecar / 单主机网关）

> 这是本次调研的重点。sidecar 方案对隧道工具**零要求**（ngrok / cloudflared /
> localtunnel / serveo / ssh -R 通吃），是"简单的 sidecar"问题的最优解。

### 3.0 通用结构

```
浏览器
  │  https://<隧道域名>
  ▼
隧道边缘（ngrok / Cloudflare / serveo …）   ← TLS 在此终结，隧道工具自己的事
  │  http://127.0.0.1:4180
  ▼
本地 sidecar（127.0.0.1 上，只允许回环访问）  ← 认证/授权在这里
  │  http://127.0.0.1:<测试端口>
  ▼
测试服务（pi 会话启动的进程）
```

- sidecar 必须绑 `127.0.0.1`（或 `::1`），**绝不绑 `0.0.0.0`**——否则局域网里的人
  可以绕过认证直连服务。
- 隧道命令的 upstream 从 `http://127.0.0.1:<端口>` 改写为
  `http://127.0.0.1:<sidecar端口>`。
- 两个候选实现：**oauth2-proxy（B1）**、**Caddy/nginx + Authelia forward_auth（B2）**，
  以及**单主机 base-path 网关（B3）**——后者是 pi-web 场景的最优默认，见 3.5。

### 3.1 B1：oauth2-proxy sidecar（通用，推荐默认）

**为什么推荐**：对隧道域名无"自有域名"要求，只要**固定**即可（ngrok 免费 dev
domain、named tunnel 固定主机名、你自己的子域都行）；访问控制（邮箱/组白名单）
在本地完成，不依赖 Authelia 的 access_control 域名限制。

**前置条件（一次性，Authelia 侧）**：

```yaml
# Authelia configuration.yml
identity_providers:
  oidc:
    clients:
      - client_id: pi-web-sidecar
        client_name: pi-web tunnel sidecar
        client_secret: '<openssl rand -hex 32>'
        authorization_policy: two_factor    # 或 one_factor
        require_pkce: true
        redirect_uris:
          - 'https://<固定隧道域名>/oauth2/callback'   # ← 精确匹配，大小写敏感
        scopes: ['openid', 'groups', 'profile', 'email']
```

**pi-web 启动时自动 spawn 的命令**：

```bash
oauth2-proxy \
  --http-address=127.0.0.1:4180 \
  --upstream=http://127.0.0.1:<测试端口> \
  --provider=oidc \
  --oidc-issuer-url=https://auth.example.com \
  --client-id=pi-web-sidecar \
  --client-secret=<同上> \
  --cookie-secret=<32字节随机，openssl rand -hex 16> \
  --cookie-secure=true \
  --email-domain=example.com \
  --allowed-email=dev@example.com        # 可选白名单；或 --allowed-group=admins
  --scope=openid email profile groups \
  --proxy-websockets \
  --flush-interval=1s                    # SSE 流式透传
```

**流程**：浏览器 → sidecar → 未认证 → 302 到 Authelia 门户 → 登录（可 2FA）→
回调 `https://<域名>/oauth2/callback` → sidecar 用授权码换 token、校验 ID token →
在**隧道域名**下种会话 cookie（cookie 是 oauth2-proxy 自己的，与 Authelia 无关）→
后续请求本地校验（邮箱/组白名单）→ 透传到测试服务。

**限制**：
1. `redirect_uris` 是 OIDC 回调白名单（授权码只能送回注册过的地址，精确匹配）→
   隧道域名**必须固定**（每次重启不变即可，随机域名无法预注册）。
   ngrok 免费 dev domain 天然固定；`ngrok http 30141 --domain <dev域>` 显式钉住。
   注意：这里不要求域名属于你——`alice.ngrok-free.app` 也能注册，因为 cookie 由
   oauth2-proxy 种在应用自己的主机上，浏览器一定会把它带回（见 2.2 机制对比）。
2. 需要本地安装 oauth2-proxy 二进制（或用 docker）；启动前检测，缺失则报错并提示。
3. cookie-secret 需随机生成并跨重启保持（否则重启后全部掉登录）——由 pi-web 生成并
   持久化到配置。

### 3.2 B2：Caddy + Authelia forward_auth sidecar（更简单，但限会话域名子域）

**为什么简单**：**完全不需要 OIDC client 注册**——没有 client_id/secret、没有
redirect_uris、没有回调 URL 同步问题。Authelia 只提供门户登录 + `/api/authz/forward-auth`
判定接口。

**硬约束**（2.2 已核实）：forward_auth 依赖浏览器把 Authelia 的登录 cookie 带给应用，
而 cookie 作用域 = **session 域名**（`session.cookies[].domain`）。应用主机不在
cookie 作用域内 → 浏览器不带 cookie → 永远判未认证 → 门户重定向死循环。
所以 `access_control` 的 `domain` 规则只能匹配 **Authelia session 域名或其子域**。
B2 只适用于：
- DNS 暴露路径（`app.pi.example.com`，session 域 `pi.example.com`）——此时根本不需要
  隧道，但把 Caddy 当统一入口同样成立；
- ngrok **自定义域名**（付费/保留域名 `app.example.com` 走 ngrok 转发）——前提是
  `app.example.com` 在你的 session 域名之下；
- **不适用**：随机或第三方隧道域名（`*.ngrok-free.app` / `*.trycloudflare.com`）——
  它们不在你的 session 域名之下，且都在 Public Suffix List 上（浏览器拒绝为 PSL 域
  种 cookie，Authelia 官方 `session/introduction.md` 明确不能配置）。

**Authelia 侧（一次性）**：

```yaml
# configuration.yml
session:
  domain: example.com                    # ← 应用必须是它的子域
access_control:
  default_policy: deny
  rules:
    - domain: 'app.example.com'          # 或 '*.example.com'
      policy: two_factor
      subject:
        - 'group:admins'                 # 可选
```

**pi-web 生成的 Caddyfile**（写入临时文件，`caddy run` 启动）：

```caddyfile
{
  auto_https off                 # 隧道已终结 TLS，本地只跑明文回环
}

:4180 {
  reverse_proxy 127.0.0.1:<测试端口> {
    forward_auth 127.0.0.1:9091 {
      uri /api/authz/forward-auth
      copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
    }
  }
}
```

（若 Authelia 不在本机，`forward_auth https://auth.example.com` + `trusted_proxies`
即可；Authelia 端有 `authelia_session_inactivity` 等会话策略。）

**流程**：浏览器 → Caddy → forward_auth 打到 Authelia → 无会话 → 401 + 302 到门户
（`rd` 回跳参数）→ 门户登录（2FA）→ **cookie 种在 session 域（如 `example.com`）上**
→ 回跳原 URL（必须也是该域的子域，浏览器才带得上 cookie）→ Caddy 再 forward_auth →
Authelia 按 access_control 规则判定 → 200 + `Remote-User` 等头 → 透传。

**限制**：
1. 应用主机必须落在 Authelia session 域名之下（硬约束：cookie 作用域，官方文档原文；
   含 PSL 限制，隧道三方域名均不可用）。
2. 需要本地安装 Caddy（单二进制，比 oauth2-proxy 生态更轻）或 nginx。
3. Authelia 的判定基于会话 cookie + access_control，**没有**应用级邮箱白名单
   （白名单用 `subject` 写进规则即可）。

### 3.3 B2 的 nginx 变体：auth_request（可选）

等价于 B2 的 nginx 实现（Authelia 官方 nginx 集成）：

```nginx
location / {
    auth_request /authz/forward-auth;
    auth_request_set $remote_user $upstream_http_remote_user;
    proxy_pass http://127.0.0.1:<测试端口>;
}
location = /authz/forward-auth {
    internal;
    proxy_pass https://auth.example.com/api/authz/forward-auth;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URL $scheme://$host$request_uri;
}
```

与 B2 同样的域名限制（应用须在会话域名子域内）；适合已经用 nginx 的环境。

### 3.4 B1 vs B2 对比

| 维度 | B1 oauth2-proxy | B2 Caddy/nginx forward_auth |
|---|---|---|
| Authelia 侧配置 | OIDC client（client_id/secret/redirect_uris） | 仅 access_control 规则 |
| 会话 cookie 谁种 | **oauth2-proxy**（种在应用自己的主机上） | **Authelia**（种在 session 域上） |
| 域名要求的机制 | `redirect_uris` 回调白名单（授权码送回哪） | 会话 cookie 作用域（浏览器是否带 cookie） |
| 域名要求 | **固定**即可，任意域（含 ngrok dev domain） | 必须是 session 域名的子域（即你的域） |
| 随机隧道域名 | ❌（回调无法预注册） | ❌（cookie 送不到，且 PSL 禁止） |
| 访问控制位置 | sidecar 本地（邮箱/组白名单） | Authelia access_control |
| 额外二进制 | oauth2-proxy | Caddy / nginx |
| SSE / WebSocket | ✅（flush-interval / proxy-websockets） | ✅（普通反代） |
| 最适场景 | 任何固定域名的隧道 | 自有域名统一入口（DNS 暴露） |

**pi-web 默认建议**：`auth.type = "sidecar"` 时优先尝试 **oauth2-proxy**（通吃）；
若检测到应用主机落在 Authelia session 域名（从 issuer host 推导，如
`auth.example.com` → session 域 `example.com`）的子域内，且有 caddy 二进制，可自动降级 B2。
新增的 **B3 单主机网关**（3.5）是 pi-web 场景的最优默认（无 OIDC client、无自有域名
要求、一个网关保护全部端口）。

### 3.5 B3：单主机 base-path 网关（nginx + Authelia 子路径）——pi-web 最优默认

**用户提出并核实的架构**：Authelia 支持 base-path 部署（`server.address` 带路径），
把 Authelia 与所有应用挂在**同一个主机名**下，用路径区分，ngrok 等隧道直接指向
这个网关。这样：

```
浏览器 → https://<固定隧道域名>/          ← 每隧道一个公网 URL
              │
        nginx 实例（127.0.0.1:<随机端口>）   ← 每隧道一个，互不干扰
              ├─ location /             → 测试服务（根路径，auth_request 保护）
              └─ location /authelia/    → Authelia（server.address 含 /authelia）
```

**为什么它同时解决了 B1/B2 的两个域名难题**：
- 会话 cookie 种在**主机名**上（如 `alice.ngrok-free.app`），浏览器对同一主机的
  **所有路径**都会带回 cookie → B2 的"应用必须是 session 域名子域"约束消失
  （应用和门户同主机，天然在 cookie 作用域内）；
- 认证走 forward_auth / auth-request，**无 OIDC client 注册** → B1 的
  `redirect_uris` 精确匹配难题不存在；
- Authelia 门户不再需要独立公网域名——就在隧道 URL 的 `/authelia/` 下，少一个暴露面；
- 一条隧道保护**所有**发现端口（pi-web 的 `GET /api/services` 正好是多端口场景）；
- 对隧道工具零要求（ngrok / cloudflared / lt / ssh -R 都只是透传）。

**Authelia 侧配置（一次性）**：

```yaml
# configuration.yml
server:
  # base-path 部署：请求在 / 和 /authelia/ 下都被处理（官方文档原文），
  # forward-auth/auth-request 端点随之变为 /authelia/api/authz/…
  address: 'tcp://:9091/authelia'

session:
  cookies:
    - domain: 'alice.ngrok-free.app'        # ← 必须是固定主机名（见下方残留约束）
      authelia_url: 'https://alice.ngrok-free.app/authelia'  # 门户地址（带 base path）
      name: 'authelia_session'
      same_site: 'lax'
      expiration: '1h'
      inactivity: '5m'
      remember_me: '1d'

access_control:
  default_policy: deny
  rules:
    - domain: 'alice.ngrok-free.app'        # 单主机：域名就是主机名本身
      path: '/app1'
      policy: two_factor
    - domain: 'alice.ngrok-free.app'
      path: '/app2'
      policy: one_factor
```

**nginx 配置（per-tunnel，一份模板参数化，pi-web 可自动生成）**：

```nginx
upstream authelia { server 127.0.0.1:9091; }
upstream app1    { server 127.0.0.1:5173; }
upstream app2    { server 127.0.0.1:8080; }

server {
  listen 127.0.0.1:4180;

  # Authelia 门户（base path 由 Authelia 自己处理，原样转发）
  location /authelia/ {
    proxy_pass http://authelia;               # 路径 /authelia/… 保持不变
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Uri $request_uri;
  }

  # auth-request 支持端点（nginx 官方集成，base path 前缀）
  location = /internal/authelia/authz {
    internal;
    proxy_pass http://authelia/authelia/api/authz/auth-request;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
    proxy_set_header X-Original-Method $request_method;
  }

  # 受保护的应用：路径前缀 → 端口
  location /app1/ {
    auth_request /internal/authelia/authz;
    auth_request_set $user $upstream_http_remote_user;
    auth_request_set $groups $upstream_http_remote_groups;
    auth_request_set $name $upstream_http_remote_name;
    auth_request_set $email $upstream_http_remote_email;
    auth_request_set $redirection_url $upstream_http_location;
    error_page 401 =302 $redirection_url;    # 现代法：用 Location 头重定向到门户
    proxy_pass http://app1/;                  # 剥掉 /app1 前缀
    proxy_set_header Remote-User $user;
    proxy_set_header Remote-Groups $groups;
    proxy_set_header Remote-Email $email;
    proxy_set_header Remote-Name $name;
  }
  location /app2/ { …同样… }
}
```

**流程**：浏览器 → `/app1/` → nginx auth_request → Authelia
`/authelia/api/authz/auth-request` → 无会话 → 401 + `Location: …/authelia/?rd=…`
→ nginx 302 到门户 → 登录（2FA）→ cookie 种在主机名上 → 回跳 `rd` →
再 auth_request → 会话有效 + 规则匹配 → 200 + `Remote-*` 头 → 透传到 app1。

**残留硬约束（源码核实，这是唯一剩下的域名问题）**：Authelia 按**目标 URL 主机**
选择会话提供方——`GetCookieDomainFromTargetURI()` 遍历
`session.cookies[].domain` 做后缀匹配（`HasDomainSuffix`：主机 == 域名 或
`*.域名`），无匹配直接 400（"no configured session cookie domain matches the url"）。
**不支持"用当前 Host 自动推导"**（domain 必填非空 `errFmtSessionDomainOptionRequired`；
cookie 的 Domain 属性固定取配置值 `c.Domain = config.Domain`，无 host-only 模式）——
这是安全设计：若任意主机自动成为会话域，登录用户即可拿自己 cookie 让 Authelia 给
任意主机（含攻击者）签发 `Remote-User` 头（open-redirect 滥用）。

**好消息：per-tunnel base-path 方案下"一个主机 = 一条配置"，已经是最小**：
每个隧道的应用、门户、cookie 全在同一个隧道域名下，只需一条条目：

```yaml
session:
  cookies:
    - domain: 'alice.ngrok-free.app'                    # 每条隧道就这一条
      authelia_url: 'https://alice.ngrok-free.app/authelia'
```

所以"配置放到最宽"有上限：
- **多个固定主机名 → 全部列入 `session.cookies` 列表**（官方多 cookie domain 支持，
  每个条目带各自的 `authelia_url`；校验器用 `HasDomainSuffix` 禁止两条目嵌套/共享
  root domain）。每条隧道一个固定域名就加一条，重启域名不变登录态稳定——这就是
  "支持一个应用多域名"的正确形态：**枚举固定域名，非通配、非任意**；
- **自有域名 + DNS 通配 → 最宽形态**：session domain 配父域（如 `pi.example.com`），
  所有 `*.pi.example.com` 子域都后缀匹配，**一条配置覆盖全部隧道，且全站共享
  SSO 登录**（cookie 作用域覆盖所有子域）。ngrok 自定义域名（付费 reserved domain
  绑自有子域）、cloudflared named tunnel、或 DNS 直接反代都归入此类；
- **每次重启都变的随机域名** → **动态登记可解**（见 3.6）：先启动隧道拿到主机名，
  把 `session.cookies` + `access_control` 写入动态配置并**重启 Authelia** 认领。
  残留限制只有 PSL 层（裸 `ngrok-free.app` 永远不可配）；`a1b2c3.ngrok-free.app`
  这种具体主机名合法。若不想让 Authelia 跟着隧道重启，仍可用路径 A（ngrok
  edge-oidc，会话由 ngrok 边缘托管、回调固定 idp.ngrok.com，与域名无关）。

所以实际建议分档：
| 场景 | Authelia 配置 | 说明 |
|---|---|---|
| 隧道都是自有域名子域（`*.pi.example.com`） | session domain = `pi.example.com` 一条 | 最宽，全站共享 SSO |
| 多个 ngrok dev domain 等固定主机 | `session.cookies` 列表逐条加 | 每主机独立登录，改配置一次 |
| 每次重启的随机域名 | 动态登记：先启隧道→写动态配置→重启 Authelia（见 3.6） | 认领后即可用；不想重启就用路径 A |

**部署形态（最终推荐）：nginx / Authelia / Redis 共享（各一个）+ 隧道多进程**：

```
共享基础设施（各 1 个实例）：
  1 × nginx   (127.0.0.1:4180)   ← 多域名 Host 路由，应用全在根路径
      server_name alice.ngrok-free.app → location / → app1 (5173)
                                        → location /authelia/ → Authelia
      server_name bob.ngrok-free.app  → location / → app2 (8080)
  1 × Authelia (127.0.0.1:9091, server.address 含 /authelia base path)
  1 × Redis     (127.0.0.1:<随机端口>, AOF 落盘，会话持久)

每域名（隧道多进程，用户按需启停）：
  cloudflared / ngrok / serveo 进程 ×1 → upstream 指向 nginx 端口 4180
```

- **nginx 共享 + 热重载**：新域名 = 追加一个 server 块 + `nginx -s reload`
  （毫秒级、不丢连接）；配置由 pi-web 生成，`nginx -t` 预校验失败即回滚，不会
  搞挂整个实例；省下每端口 20MB；
- **Authelia 共享 + 动态登记**：新域名加入 `session.cookies` + 重启（Redis 里会话
  不丢，用户无感），见 3.6；
- **Redis 共享**：AOF 落盘，永远一个；
- **隧道多进程**：每个域名一个隧道进程，用户按需启停，互不干扰——这是"按需启停"
  的粒度所在（nginx/Authelia/Redis 常驻，隧道进程随域名启停）；
- 应用全在**根路径** → 写死 `/assets/x.js`、SPA 路由、表单 action 全部正常；
  `location /authelia/` 是唯一保留路径（可改 `/__auth/` 避开冲突）；
- 隧道侧多域名通道（upstream 都指向同一 nginx 端口）——**注意区分"一个进程几个
  公网域名"与"一个公网域名几个本地端口"**：

  | 工具 | 一个进程 | 返回 URL | 同域名拆多服务 |
  |---|---|---|---|
  | cloudflared 多 ingress（named tunnel） | 多 hostname | **多域名**（每个 ingress hostname 一个公网 URL，域名不同） | ✅ `hostname`+`path` 规则把**同一域名**按路径拆给多个本地端口（返回相同域名不同路径，代价=路径前缀问题） |
  | ngrok 多 endpoint（`ngrok start`） | 多 endpoint | **多域名**（每 endpoint 一个 URL） | ❌ 每 endpoint 一个 upstream |
  | 多个 ngrok / cloudflared quick 进程 | 每进程 1 | 每进程一个域名 | ❌ |
  | serveo / localtunnel | 每进程 1 | **一个域名**（每进程一个 URL） | ❌ |

  关键：**一个公网域名只有一个 Host** → Host 路由时"一域名一服务"；"一域名多服务"
  只能按路径拆（cloudflared ingress path / nginx location），代价是绝对路径资源
  404。

**nginx 配置（per-tunnel / 单实例多域名，一份模板参数化，pi-web 自动生成）**：


---

### 3.6 B3+：动态登记——先启隧道、再写配置、重启 Authelia，随机域名也可用

**用户提出的流程**：nginx、隧道先启动拿到实际主机名 → 把该主机名写入 Authelia
配置 → 重启 Authelia → 完工。这一下子解决了"随机域名无法预登记"的问题。

**可行性核实（官方文档/源码）**：

| 问题 | 结论 | 依据 |
|---|---|---|
| 支持多配置文件合并？ | ✅ `authelia --config configuration.yml --config config-tunnels.yml`（或逗号分隔、或目录），按顺序合并，重复键后者优先 | 官方 `configuration/methods/files.md` "Multiple Configuration Files" |
| 支持配置热重载？ | ❌ **不支持**。SIGHUP 只重开日志文件（`service/signal.go`：`log-reload` → `logging.Reopen`），**配置只在启动时加载** | 源码核实 |
| 重启会丢会话吗？ | ✅ 不会。会话存储在 Redis / SQLite 等 storage 后端，重启进程不丢 | 架构 |
| 动态文件怎么写？ | session.cookies 与 access_control **整个 section 放动态文件**（官方警告：跨文件不 merge，后加载整体覆盖） | files.md 注意节 |
| 随机域名 `a1b2c3.ngrok-free.app` 可作 cookie domain？ | ✅ 不是 PSL（`ngrok-free.app` 才是）；门户同主机，浏览器接受 | — |

**流程（pi-web 自动化）**：

```
1. 分配随机本地端口，spawn per-tunnel nginx（location / → 应用，/authelia/ → Authelia）
2. spawn 隧道（ngrok/cloudflared/...）→ 解析出公网主机名（随机也行）
3. 重写动态配置 config-tunnels.yml（原子写 tmp+rename）：
     session:
       cookies:
         - domain: '<拿到的主机名>'
           authelia_url: 'https://<拿到的主机名>/authelia'
     access_control:
       default_policy: deny
       rules:
         - domain: '<拿到的主机名>'
           policy: two_factor
4. authelia config validate --config configuration.yml --config config-tunnels.yml   # 预校验
5. 重启 Authelia（systemctl restart authelia / docker restart authelia / kill+spawn）
6. 完工；隧道停止时从动态文件移除该条目并再次重启
```

**动态文件示例**（`config-tunnels.yml`，由 pi-web 管理，主配置不写这两个 section）：

```yaml
# config-tunnels.yml —— pi-web 原子重写，完整覆盖 session.cookies 与 access_control
session:
  cookies:
    - domain: 'a1b2c3.ngrok-free.app'                    # 隧道随机域名，认领
      authelia_url: 'https://a1b2c3.ngrok-free.app/authelia'
    - domain: 'alice.ngrok-free.app'                      # 固定的 dev domain
      authelia_url: 'https://alice.ngrok-free.app/authelia'
access_control:
  default_policy: deny
  rules:
    # 规则只写一次：一条正则覆盖所有隧道域名（two_factor 不随新域名重复配置）
    - domain_regex: '^[a-z0-9-]+\.(ngrok-free\.app|trycloudflare\.com|serveo\.net)$'
      policy: two_factor
```

**代价与注意**：
1. **Authelia 每次隧道启停都要重启**（~秒级停机；已登录会话在 storage 后端不丢，但正在进行的登录流程会断）。隧道频繁重启时抖动明显——固定 dev domain 场景（域名不变）可以只在首次登记，之后重启 Authelia 不再是必需（配置已含该域）。
2. **pi-web 需要 Authelia 的重启权限**：配置 `autheliaReloadCmd`（如 `systemctl restart authelia` / `docker restart authelia`）；无权限则退化为"生成配置片段 + 提示人工粘贴并重启"。
3. **section 级覆盖**：主配置里**不要**再写 `session.cookies` 或 `access_control`（否则冲突），这两个 section 全权交给动态文件。
4. 用 `authelia config validate` 预校验，写坏配置不会把 Authelia 搞挂（重启前校验失败就回滚）。
5. 随机域名模式下 Authelia 门户地址（authelia_url）跟着隧道变——OIDC client 注册的 redirect_uris 不受影响（forward_auth 无 OIDC client），但若有 OIDC 应用注册了旧域名回调需同步清理。

**与路径 A 的取舍**：动态登记让随机域名也能用 Authelia（本地 forward_auth）；路径 A（ngrok edge-oidc）则完全不需要碰 Authelia 配置/重启（回调固定 idp.ngrok.com），适合不想管理 Authelia 重启的场景。

### 3.7 最小配置：two_factor 只写一次，新域名只做"认领"

**问题**：新隧道域名上线时，是否每次都要为它重写一条 `two_factor` 规则？

**答案：不用。** 授权判定是两层（源码核实）：

1. **session.cookies 层（认领）**：`GetCookieDomainFromTargetURI()` 按目标主机匹配
   cookie 域——这是"该域名归 Authelia 管"的登记，**必须**逐域（枚举/父域/动态登记）。
2. **规则层（授权）**：`AccessControlRule.MatchesDomains()` 对目标主机做**纯模式匹配**
   ——支持 `*.` 通配（`AccessControlDomainMatcher.Wildcard` →
   `StringHasSuffixFold`）和 `domain_regex`（`RegexpStringSubjectMatcher` 正则匹配
   完整主机名）。**没有"规则域必须在 session 域内"的运行时校验**，规则只是选择器。

所以规则可以写**一次、永久复用**：

| 规则写法 | 覆盖范围 | two_factor 配置次数 |
|---|---|---|
| `domain: '*.pi.example.com'` | 自有域全部子域 | 一次 |
| `domain_regex: '^[a-z0-9-]+\.ngrok-free\.app$'` | 一类隧道（ngrok 全部随机/固定域） | 一次 |
| `domain_regex: '^[a-z0-9-]+\.(ngrok-free\.app|trycloudflare\.com)$'` | 多类隧道合并 | 一次 |
| `domain: 'alice.ngrok-free.app'`（逐条） | 单个固定域 | 每域一次 |

**安全论证**：规则写宽不会放行未认领的域——未认领主机在第 1 层
（session.cookies 匹配）就 400，根本到不了规则层。规则通配只对"已认领"的域生效。

**"同一个应用"**：多个域名对应同一受保护资源时，规则用
`domain_regex` + `path` + `subject` 组合定义一次即可，所有隧道域名共享同一策略与
白名单（如 `subject: group:admins`）。

**因此新隧道上线的完整工作** = 启 nginx + 启隧道 + session.cookies 认领一条
（固定域=父域一条永不再动；随机域=3.6 动态登记自动追加）+ 重启 Authelia。
**规则文件永不修改。**

---

### 3.8 绿色启动：Authelia 单二进制 + 预配置模板 + 随机端口（零外部依赖）

**结论：可以，Authelia 官方就支持便携式运行**——GitHub releases 的
`authelia-vX.Y.Z-linux-amd64.tar.gz`（约 19MB）解压即得 **`authelia` 单二进制 +
`config.template.yml` 官方模板** + systemd 单元，无需安装。

**绿色启动的全部依赖项（逐项核实官方选项）**：

| 组件 | 绿色方案 | 官方依据 |
|---|---|---|
| 存储 | `storage: local: {path: db.sqlite3}` —— SQLite 内嵌，**首次启动自动建表迁移** | storage/introduction.md |
| 会话 | **Memory（默认，stateful，零配置）**——不需要 Redis | session/introduction.md "Providers" |
| 通知器 | `notifier: filesystem: {filename: ...}` —— 写文件，不需要 SMTP | notifications/introduction.md |
| 用户库 | `authentication_backend: file: {path: users.yml}` —— 本地文件 + `authelia crypto hash` 生成密码 hash | — |
| NTP | `ntp: disable_startup_check: true` —— 离线/内网也能启动 | miscellaneous/ntp.md |
| TLS | 本地监听裸 HTTP，由 nginx/隧道终结 | — |
| 域名 | `server.address: 'tcp://127.0.0.1:<随机端口>/authelia'` —— **端口与 base path 一个配置项** | server.md |

**平台注意**：官方 release 只有 linux（amd64/arm/arm64，glibc/musl）+ freebsd，
**没有 macOS/Windows 二进制**。macOS 用 `brew install authelia`（官方文档推荐）或
`go build`；pi-web 下载逻辑按平台分支处理。

**启动流程（pi-web 自动化）**：

```
1. 检测 PATH 里的 authelia；没有则下载 release tar.gz 解压到数据目录（绿色，不动系统）
2. 生成预配置（模板注入）：
     server.address: 'tcp://127.0.0.1:<探测的空闲端口>/authelia'   # 随机端口 + base path
     storage:      local sqlite
     session:      Memory（默认，无需 Redis）
     notifier:     filesystem
     ntp:          disable_startup_check
     authentication_backend: file（初始用户 admin + 随机密码 hash，门户登录后改密）
     session.cookies / access_control：留空，由 3.6 动态文件负责
3. authelia config validate --config <dir>/configuration.yml --config <dir>/config-tunnels.yml
4. spawn：authelia --config <dir>/configuration.yml --config <dir>/config-tunnels.yml
5. 随机端口报给 nginx：location /authelia/ → proxy_pass http://127.0.0.1:<该端口>
```

**会话持久化（重要）**：Authelia 的 session provider **只有 Memory / Redis / Redis
Sentinel 三种**（源码 `NewSessionProvider` 的 switch 核实），**没有文件/SQLite
session**。动态登记（3.6）要重启 Authelia，Memory 会话会丢（全部用户重新登录）。
两个方案：

**方案① 绿色 Redis + AOF —— "存文件"的真实形态**
```bash
redis-server --bind 127.0.0.1 --port <随机端口> --appendonly yes --dir <数据目录>
```
```yaml
session:
  secret: '<openssl rand -hex 32>'        # 加密 Redis 中的会话数据
  redis:
    host: '127.0.0.1'
    port: <随机端口>
```
- AOF 把会话落盘 → **Authelia 重启（动态登记）会话不丢，用户无感**；
- Redis 获取（Linux/macOS 不用纠结绿色下载，包管理器即可）：
  1. **检测** `redis-server` 在 PATH → 直接绿色运行；
  2. 不在 → **pi-web 命令自动安装**（spawn，`sudo -n true` 探测免密 sudo）：
     - Debian/Ubuntu：`DEBIAN_FRONTEND=noninteractive sudo apt-get install -y redis-server`
     - RHEL/Fedora：`sudo dnf install -y redis`
     - macOS：`brew install redis`（无需 sudo）
  3. 无 sudo 权限 → 弹窗给出用户手动执行的安装命令，装完点重试；
- 安装后**仍以绿色方式运行**（`redis-server --port <随机> --appendonly yes
  --dir <数据目录>`），不启用/不依赖系统 systemd 服务（apt 装的 redis 会自带
  `redis-server.service`，避开它别用 6379 默认端口即可）；

**方案② 每隧道一个 Authelia 实例 —— 配置一次成型，永不重启**
- 顺序改为：隧道先启动拿到域名 → 生成该实例配置（`session.cookies.domain` =
  该域名，一次成型）→ spawn Authelia → **实例生命周期 = 隧道生命周期，不需要
  动态登记/重启**，Memory 会话也无妨（实例死 = 隧道死，会话本就该失效）；
- 与 3.5 的 per-tunnel nginx 天然契合：`location /authelia/` 指向各自实例的随机端口；
- **零额外依赖**（不需要 Redis）；
- 代价：多个实例各带一个 SQLite（用户认证共享 `users.yml` ✅，但 2FA/TOTP
  注册不跨实例 ✗，one_factor 场景无影响）；多实例资源开销（每个 ~数十 MB）。

**推荐**：测试/单隧道场景用方案②（最简单、零依赖、无重启）；多隧道频繁启停且
要求跨重启保留会话用方案①。两种都不需要第三方托管服务，全在数据目录内。
**Redis 永远只要一个**（中央会话存储）：无论单 Authelia 还是多 Authelia 实例
（方案②），都共享同一个 Redis——多实例共享需用**同一个 `session.secret`**（否则
解不开彼此的加密会话），并可用 `database_index` 区分或直接共享库。

**资源消耗（实测，Linux 主机）**：

| 组件 | RSS | 说明 |
|---|---|---|
| Authelia（1 实例） | ~74 MB | 空闲 CPU <1%；VSZ 2.9GB 是 Go 虚存，RSS 为准 |
| redis-server | ~16 MB | 空闲 |
| nginx（per-tunnel，1 worker） | ~20 MB | master ~10MB + worker ~10MB；系统服务的 16 worker ≈170MB 是它自己配置，per-tunnel 用 `worker_processes 1` |

**每端口成本**：
- **最终推荐（nginx/Authelia/Redis 共享 + 隧道多进程）**：固定 ~110MB（Authelia
  74 + Redis 16 + nginx 20）不随域名涨 + 每域名仅隧道进程 ~30-40MB
  → 20 端口 ≈ 810MB；
- 每隧道一 nginx（备选）：固定 ~90MB + 每端口 ~50-70MB（nginx 20 + 隧道 30-40）
  → 20 端口 ≈ 1.1-1.5GB；
- 每隧道一 Authelia（方案②）：每端口 ~125-135MB（nginx 20 + Authelia 74 + 隧道
  30-40）→ 20 端口 ≈ 2.5-2.7GB；
- 测试服务进程本身（Python/Node 等）不在内，通常几十~几百 MB，才是大头；
- CPU 空闲均 <1%（事件驱动），连接数受 ulimit fd 限制（默认 1024 够几百并发）。
- 首次启动自动完成存储迁移；数据目录（sqlite/users.yml/通知文件）全部落在 pi-web
  的数据目录内，删除即彻底卸载（真正的绿色/便携）。
- `authelia crypto hash generate argon2` 生成初始密码 hash；或读取用户提供的
  users.yml。
- 随机端口探测用 bind(0) 拿空闲端口（写配置前释放），与 3.5 的 per-tunnel nginx
  端口分配同套路。
- 校验用 `authelia config validate`，配置写坏不会影响已运行实例。

---

## 4. 推荐方案（pi-web 落地设计）

### 4.1 配置扩展：隧道配置项增加 `auth` 字段

沿用现有 `PI_WEB_TUNNELS` JSON 清单，给每条隧道加可选 `auth`：

```jsonc
PI_WEB_TUNNELS='[
  {
    "name": "ngrok",
    "cmd": "ngrok http 30141 --domain alice.ngrok-free.app",
    "auto": true,
    "auth": {
      "type": "edge-oidc",                 // 路径 A：ngrok 边缘 OIDC（最自动）
      "issuerUrl": "https://auth.example.com",   // Authelia / Authentik / Keycloak
      "clientId": "pi-web-ngrok",
      "clientSecret": "...",
      "scopes": ["openid", "profile", "email", "groups"],
      "allowEmails": ["dev@example.com"],      // 可选白名单
      "allowEmailDomains": ["example.com"]
    }
  },
  {
    "name": "cfd",
    "cmd": "cloudflared tunnel --url http://localhost:30141",
    "auth": {
      "type": "sidecar",                       // 路径 B1：本地 oauth2-proxy（默认）
      "issuerUrl": "https://auth.example.com",
      "clientId": "pi-web-cfd",
      "clientSecret": "...",
      "cookieSecret": "<openssl rand -hex 16>",// 可省，pi-web 自动生成并持久化
      "allowEmails": ["dev@example.com"],
      "expectedHost": "myapp.trycloudflare.com" // 固定主机名提示（回调注册用）
    }
  },
  {
    "name": "ngrok-app1",
    "cmd": "ngrok http 4181 --domain alice.ngrok-free.app",  // 指向随机本地 nginx 端口
    "auto": true,
    "auth": {
      "type": "nginx-fwd",                     // 路径 B3：per-tunnel nginx + Authelia base path
      "autheliaUrl": "https://alice.ngrok-free.app/authelia", // Authelia 门户（含 base path）
      "cookieDomain": "alice.ngrok-free.app",  // 固定域名预登记；随机域名留空走动态登记
      "authPath": "/authelia/",                // 保留路径（可改，默认 /authelia/）
      "autheliaCfg": "/etc/authelia/config-tunnels.yml", // 动态配置文件（见 3.6）
      "autheliaReloadCmd": "systemctl restart authelia"   // 重启命令；缺省=只出提示
    }
  },
  {
    "name": "ssh",
    "cmd": "ssh -R 80:localhost:30141 serveo.net",
    "auth": {
      "type": "sidecar-caddy",                 // 路径 B2：Caddy forward_auth（限会话域名子域）
      "issuerUrl": "https://auth.example.com",
      "appHost": "app.example.com"             // 必须是 session 域名的子域
    }
  }
]'
```

### 4.2 实现要点（对应现有代码）

| 文件 | 改动 |
|---|---|
| `lib/tunnels.ts` | 解析 `auth`；`startTunnel()` 先做认证装配再 spawn；`TunnelInfo` 增加 `auth` 状态（类型/issuer/校验结果/回调 URL/白名单）；`stopTunnel()` 连带杀掉 sidecar；cookie-secret 生成并持久化到 `globalThis`/配置文件 |
| `lib/tunnel-auth.ts`（新增） | `verifyIssuer(issuerUrl)`：GET `/.well-known/openid-configuration`，校验 authorization/token/userinfo 端点存在；`renderNgrokPolicy(auth)`：生成 `openid-connect` action YAML；`buildOAuth2ProxyArgs(auth, upstreamPort)`：拼 oauth2-proxy 参数（含 `--proxy-websockets --flush-interval`）；`buildCaddyfile(auth, upstreamPort)`：forward_auth Caddyfile；`detectBinary(name)`：`which` oauth2-proxy / caddy，缺失时明确报错 |
| `app/api/tunnels/route.ts` | 返回带 auth 状态的列表；start 失败把校验错误带回 UI |
| `lib/tunnel-auth.ts`（新增，扩展） | `buildNginxConf(auth, appPort)`：生成 per-tunnel nginx 配置模板（`location /` 受保护 + `location /authelia/` + auth_request 端点），分配随机监听端口 |
| `lib/authelia.ts`（新增） | **绿色拉起 Authelia**（见 3.8）：检测/下载单二进制、生成预配置（随机端口+base path+SQLite+filesystem notifier+file 用户库+NTP 禁用）、`config validate` 预校验、spawn/停止；管理动态文件 `config-tunnels.yml`（3.6）与 `autheliaReloadCmd` 重启 |
| `components/ServicesDialog.tsx` | 每条隧道显示 🔒/⚠ 徽标（已接认证 / 校验失败 / 缺二进制）、可复制的回调 URL（注册到 Authelia 用）、sidecar/nginx 拓扑说明、域名要求提示（B1/B3 固定域名即可 / B2 须在会话域名子域内）、B3 的保留路径说明（`/authelia/` 可改） |

装配逻辑（`startTunnel`）：

1. `detectBinary` + `verifyIssuer` → 任一失败拒绝启动并报错（可降级：无认证仍可手动开）。
2. **edge-oidc（ngrok）**：policy 写临时文件，实际命令追加
   `--traffic-policy-file <tmp>`（或 ngrok.yml `endpoints[].traffic_policy` 内联）。
   回调自动满足（固定 idp.ngrok.com）。
3. **sidecar（oauth2-proxy）**：先 spawn
   `oauth2-proxy --http-address=127.0.0.1:<4180+n> --upstream=http://127.0.0.1:<原端口>
   ...`，再把隧道命令的 upstream 改写为 sidecar 端口；停止时先杀隧道再杀 sidecar。
4. **sidecar-caddy**：生成 Caddyfile 临时文件，`caddy run --config <tmp>`，改写
   upstream；回调 URL 为 `https://<appHost>/`（门户回跳），无需注册。
5. **nginx-fwd（B3，默认）**：**每隧道一个 nginx 实例**——分配随机本地端口，
   生成模板化配置（`location /` 反代到测试端口且受 auth_request 保护、
   `location /authelia/` 反代到 Authelia base path、一个 internal auth_request
   端点），spawn `nginx -c <tmp>`；隧道 cmd 的 upstream 改写为 nginx 端口；
   停止时先杀隧道再杀 nginx。
6. **域名认领（B3 的两种模式）**：
   - 固定域名：校验 `cookieDomain` 与隧道实际主机名一致（不一致警告）；
   - 随机域名/自动模式（配了 `autheliaCfg`）：隧道 URL 解析出主机名后原子重写
     `config-tunnels.yml`（session.cookies + access_control 完整 section）→
     `authelia config validate` 预校验 → 执行 `autheliaReloadCmd` 重启 Authelia；
     隧道停止时从动态文件移除该条目并再重启。无 `autheliaReloadCmd` 时退化为
     弹窗展示待粘贴配置片段。
6. URL 解析照旧；`TunnelInfo.auth.status = "ok"`，弹窗展示"已由 Authelia 保护"。

### 4.3 弹窗"暴露前授权"章节升级

从纯文字提示改为**按检测到的隧道工具 + auth 配置**给出：
- 注册样板（Authelia client 或 access_control 规则）与**可复制的回调 URL**；
- 校验状态（issuer 可达性、二进制存在、域名固定性检查：从 URL 解析出的主机名是否
  与配置的 expectedHost 一致）；
- 风险提示：随机域名 + B1/B2 均不可用 → 提示改用 ngrok 固定 dev domain 或 edge-oidc。

### 4.4 安全注意事项

1. **Authelia 必须公网可达**（ngrok/Cloudflare 边缘与 oauth2-proxy 都要访问
   discovery/token/userinfo），这本身又是一个"暴露"，应放在独立子域名 + HTTPS。
2. `client_secret` / `cookie_secret` 走环境变量注入，**不进日志**（现有 `lastOutput`
   缓存只存隧道 stdout，需确认 sidecar CLI 不回显 secret——oauth2-proxy/Caddy
   默认不回显）。
3. sidecar 只绑 `127.0.0.1`，防止局域网绕过认证。
4. `cookie-secret` 跨重启持久化（写到配置或 keyring），否则重启全部掉登录。
5. B1 白名单（`--allowed-email` / `--allowed-group`）与 Authelia
   `authorization_policy` 双保险；B2 用 access_control 的 `subject` 规则。
6. cloudflared quick tunnel 无认证且不支持 SSE——接认证时强制走 sidecar，并提示
   SSE 限制。

---

## 5. 验收（端到端）

**B1（oauth2-proxy + ngrok 固定 dev domain）**：

1. 起 Authelia（公网 https），注册 client：`redirect_uris =
   ['https://alice.ngrok-free.app/oauth2/callback']`。
2. `PI_WEB_TUNNELS='[{"name":"ngrok","cmd":"ngrok http 30141 --domain alice.ngrok-free.app",
   "auto":true,"auth":{"type":"sidecar","issuerUrl":"https://auth.example.com",
   "clientId":"pi-web","clientSecret":"..."}}]' npm run dev`
3. 弹窗显示 🔒 + 回调 URL；公网打开 → 302 Authelia 登录（2FA）→ 回跳
   `/oauth2/callback` → 进入测试服务。
4. 未授权邮箱被拒；重启 pi-web 后 cookie-secret 不变 → 不重新登录。
5. 换 cloudflared / serveo 的 cmd，同一套 `auth` 直接可用（仅固定域名需与回调一致）。

**A（ngrok edge-oidc）**：同 3.1 但 `auth.type="edge-oidc"`，回调注册
`https://idp.ngrok.com/oauth2/callback`，**去掉 `--domain` 用随机域名重跑也应通过**。

**绿色启动**：无 authelia 二进制时 pi-web 自动下载解压；生成预配置（随机端口 +
`/authelia` base path + SQLite + filesystem + NTP 禁用）→ `config validate` → spawn；
门户登录、改密、auth_request 全链路可用；删除数据目录即彻底卸载。

**B3（per-tunnel nginx + Authelia base-path）**：Authelia `server.address:
'tcp://:9091/authelia'` + `session.cookies` 列表含 `alice.ngrok-free.app`；
`PI_WEB_TUNNELS` 配置 `auth.type="nginx-fwd"`，`cmd` 指向随机 nginx 端口；
公网打开 → 根路径 302 到 `/authelia/?rd=…` → 2FA → 回跳进入应用（绝对路径资源
正常）；第二条隧道换 cloudflared / serveo 只改 `cmd` 与 `cookieDomain` 同样通过；
把 `cmd` 换成随机域名隧道（无 `--domain`）应看到"cookieDomain 未列入
session.cookies"警告。

## 6. 参考

- ngrok Traffic Policy / OIDC action：https://ngrok.com/docs/traffic-policy/actions/oidc/
- ngrok OAuth action：https://ngrok.com/docs/traffic-policy/actions/oauth/
- ngrok Agent Endpoints with Traffic Policy（`--traffic-policy-file` / ngrok.yml）：
  https://ngrok.com/docs/traffic-policy/getting-started/agent-endpoints/
- Authelia OIDC clients 配置（redirect_uris 精确匹配等）：
  https://www.authelia.com/configuration/identity-providers/openid-connect/clients/
- Authelia access-control（**session 域名限制**，源码）：
  https://github.com/authelia/authelia/blob/master/docs/content/configuration/security/access-control.md
- Authelia + Caddy forward_auth：
  https://www.authelia.com/integration/proxies/caddy/
- Authelia + nginx forward_auth：
  https://www.authelia.com/integration/proxies/nginx/
- Authelia + Cloudflare Zero Trust（Generic OIDC）：
  https://www.authelia.com/integration/openid-connect/clients/cloudflare-zerotrust/
- Cloudflare Quick Tunnels（无认证、无 SSE、200 并发限制）：
  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- oauth2-proxy OIDC provider 与 SSE/WebSocket 选项：
  https://oauth2-proxy.github.io/oauth2-proxy/configuration/
