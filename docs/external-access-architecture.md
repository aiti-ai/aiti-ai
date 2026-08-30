# pi-web 外网访问架构汇总（脱敏版）

> 本文档用于向他人介绍本方案的部署思路。所有域名、端口均为**示例占位符**
> （真实值见文末对照表，请勿直接照抄）。

**一句话概括**：家庭宽带 + 动态公网 IP，路由器 DDNS 把域名钉在变化的 IP 上，
通过端口映射把**一个**对外 HTTPS 端口送进内网；nginx 用虚拟主机 + Authelia
`forward_auth` 做统一入口与统一认证，同一端口背后承载 pi-web（生产 + dev）、
其它 Web 子应用，以及 pi 会话中临时启动的测试服务。

---

## 1. 架构总览

```
公网浏览器
    │  https://pi.example.com:18443/          （DDNS 解析到家庭动态 IP）
    ▼
路由器（家庭宽带）
    ├─ DDNS：域名 A 记录跟随动态公网 IP 更新（路由器内置客户端）
    └─ 端口映射：公网 18443 ──▶ 内网 18443（家宽无静态 IP / 无公网 80、443）
    ▼
nginx（本机，:18443 ssl http2，单证书多虚拟主机）
    ├─ pi.example.com / *.pi.example.com
    │      └─ forward_auth ──▶ Authelia（127.0.0.1:19091，auth_request 子请求）
    │             ├─ /            ──▶ pi-web 生产实例（127.0.0.1:18080，根路径）
    │             ├─ /dev/        ──▶ pi-web dev 实例（127.0.0.1:18081，basePath=/dev，HMR）
    │             ├─ /justdb/     ──▶ 其它子应用（127.0.0.1:18082，--base-path）
    │             └─ <端口>.pi.example.com  ──▶ pi-web proxy.ts 重写到 127.0.0.1:<端口>
    │                                         （pi 会话内测试服务，如 5173、8000）
    └─ auth.example.com ──▶ Authelia 门户（127.0.0.1:19091，登录/2FA 页面）

Authelia：仅监听 127.0.0.1:19091，永不直接暴露；Redis 存会话、SQLite 存数据
证书：Let's Encrypt 通配符证书（*.example.com + example.com），DNS-01 挑战续期
```

## 2. 各层技术要点

### 2.1 入口层：路由器（DDNS + 端口映射）

- 家庭宽带通常是**动态公网 IP**，也没有公网 80/443 端口，因此：
  - 用路由器内置 **DDNS 客户端**把域名（`pi.example.com` 等）的 A 记录指向当前
    动态 IP，IP 变化后自动更新；
  - 端口映射只开一个**高位端口** `18443` → 内网 `18443`，不依赖 80/443。
- 域名解析用**泛域名 A 记录**（`*.pi.example.com` → 家宽 IP），为 pi-web 的
  "服务端口代理"（见 2.5）提供无限子域名。

### 2.2 TLS 层：Let's Encrypt 通配符证书 + DNS-01 挑战

- 一张**通配符证书**覆盖 `pi.example.com`、`auth.example.com`、
  `*.pi.example.com`，nginx 所有虚拟主机共用（`fullchain.pem` / `privkey.pem`）。
- 续期用 **DNS-01 挑战**（通过 DNS 服务商 API 自动添加 TXT 记录）：家宽没开公网
  80 端口，HTTP-01 挑战不可行；DNS-01 只验证域名控制权，与 IP、端口无关，
  动态 IP 变化**不影响证书**。
- 外部 HTTP 请求（直连 18443 但非 HTTPS）用 `error_page 497` 302 回 HTTPS。

### 2.3 反向代理层：nginx（单端口多服务的核心）

一个 server 块监听 `18443 ssl http2`，**不靠端口区分服务，靠 `server_name`
（SNI + Host 头）路由**：

| 虚拟主机 | 路由目标 |
|---|---|
| `pi.example.com` | pi-web 生产实例（根路径 `/`） |
| `*.pi.example.com` | pi-web 服务端口代理（测试服务） |
| `auth.example.com` | Authelia 登录门户 |

关键配置点：

- **统一认证**：每个 location 前挂 `auth_request /internal/authelia/authz`（内部
  子请求转发到 Authelia 的 `/api/authz/auth-request`），401 时 `error_page 401`
  `302` 跳转门户 `auth.example.com:18443/?rd=<原地址>`，登录后带 `rd` 跳回。
- **SSE / WebSocket 透传**：pi-web 的流式输出走 SSE，必须
  `proxy_buffering off` + `proxy_request_buffering off`，并设置
  `Upgrade` / `Connection "upgrade"` 头，否则长连接被代理缓冲打断。
- **反向代理头**：`Host`、`X-Forwarded-Host`、`X-Forwarded-Proto`、
  `X-Forwarded-For`、`X-Real-IP` 都要带上，保证应用侧拿到真实协议与客户端 IP。
- **子路径部署**：dev 实例以 `PI_WEB_BASE_PATH=/dev` 挂在 `/dev/` 下，nginx 用
  正则 `location ~ ^/dev(?:/|$)`（匹配带/不带尾斜杠，避免 Next 的尾斜杠重定向
  落进 `location /`），生产实例保持根路径、免前缀。
- **根路径友好跳转**：basePath 模式下直连实例根路径（如 `http://<ip>:30142/`、
  隧道/ngrok 入口）由 next.config `redirects()` 307 跳到 `/dev/`（查询串透传；
  `basePath:false` 才能匹配真正的 `/`；根部署返回空数组零行为变化）。隧道 vhost
  场景由 service-tunnels 中间件先行 302（`redirectToBase`），两层互补不冲突。
- **上传限制**：`client_max_body_size` 调大（如 4G），会话里传文件不受限。

### 2.4 认证层：Authelia（自托管 SSO + 2FA）

- 采用 **forward_auth / auth_request** 模式：nginx 对每个请求发起一个内部子请求
  问 Authelia"这个用户登录了吗"，未登录返回 401 由 nginx 302 到门户。应用自身
  完全无感知，不需要改代码。
- 访问策略：`default_policy: deny`，业务域名规则 `two_factor`（必须 2FA）；
  未授权域名一律拒绝——暴露面只有白名单内域名。
- 存储：Redis（127.0.0.1:6379）存会话、SQLite 存数据、文件后端（argon2id）存
  用户密码、文件 notifier 收验证邮件/链接。
- **Authelia 只监听 127.0.0.1:19091**，公网不可直连；门户页通过 nginx 虚拟主机
  `auth.example.com` 提供，等于在认证入口前面再加了一层"只有这一个域名能到
  登录页"的隔离。
- 会话 cookie 作用域设在父域 `example.com` 上，使 `pi.` / `*.pi.` 各
  虚拟主机共享同一登录态（一次登录，处处通过）。

### 2.5 pi-web 特色：服务端口代理（测试服务直通公网）

pi 会话里启动的临时服务（`python -m http.server`、Vite、FastAPI 等）通过
`http://<端口>.pi.example.com:18443/` 直接访问，无需隧道：

- **DNS 通配符**：`*.pi.example.com` 已解析到家庭 IP，任意端口数字天然成为子域名。
- **nginx**：`*.pi.example.com` 命中 server_name，路径落到 pi-web 的反代入口
  （`location /` 或 `/dev/`）。
- **pi-web `proxy.ts`（中间件即网关）**：在 Next middleware 内**进程内调用**
  service-tunnels 库的 `st.proxy.resolve()` 决策 API——虚拟主机解析
  （`<端口>[-标签].<域名>`）、enrollment 校验、站点认证（portal/basic/
  authelia）、登录跳转全部由库完成；通过后 `NextResponse.rewrite()` 转发
  到目标端口（HTTP 与 WebSocket 都走 Next 内部 http-proxy，含 upgrade）。
  无需单独监听 proxy 端口，对外始终单端口；库的 HTTP 传输与中间件共用
  同一套决策逻辑（单一实现）。
- **安全模型（D4：显式 enrollment）**：
  - 未显式 enrollment（expose）的虚拟主机一律 **403**（"port X not
    enrolled"）——不存在"自动发现即放行"；测试服务必须先经 Services
    对话框 / `POST /api/service-tunnels` 显式暴露才会可访问；
  - 只转发到 **127.0.0.1**：目标由库的 `proxyTarget()` 构造（路径拼在显式
    authority 之后，`//evil.com`、反斜杠等无法覆盖 host/port——无 SSRF）；
  - 认证虚拟主机（`<端口>-<标签>.pi.example.com`）经对应站点认证后端把关，
    未知标签 / 未注册站点一律 403；
  - DNS rebinding 防护：虚拟主机后缀正则（loopback + 已配置部署域名），
    服务子域名不在已配置主机名列表也不误拦。
- 已知限制：开放虚拟主机（`<端口>.pi.example.com`，无认证）的暴露面等于
  "知道端口号即可访问"——建议测试服务用带认证的 `<端口>-<标签>` 形式，
  或配合 `allowlocal` 门控（仅回环/信任域名可直连）。页面里硬编码
  `http://localhost:<端口>` 绝对地址的，远程浏览器无法访问。

### 2.6 部署形态：systemd 双实例

| 实例 | 端口（内部） | 入口 URL | 说明 |
|---|---|---|---|
| pi-web 生产 | `127.0.0.1:18080` | `https://pi.example.com:18443/` | 源码构建产物，根路径部署 |
| pi-web dev | `0.0.0.0:18081` | `https://pi.example.com:18443/dev/` | `next dev`，`PI_WEB_BASE_PATH=/dev`，带 HMR |

- 生产实例启动参数：`--hostname 127.0.0.1`（只监听回环，公网只能经 nginx 到达）；
  `PI_WEB_ALLOWED_HOSTS` 配好允许的域名（request-security 要求）。
- 两个实例共用同一份 `~/workspace/pi-web` 代码与同一 `.pi` 数据，方便在
  dev 上验证新功能、生产上稳定使用；`systemd` 管理、失败自动重启。
- 同一 nginx 下还承载了其它子应用（如 `/justdb/`、npm 私有镜像等），进一步体现
  "单端口多服务、统一认证"的扩展性。

## 3. 一次完整请求的数据流

```
1. 浏览器输入 https://pi.example.com:18443/，DDNS 解析到当前家庭 IP，端口映射到内网
2. nginx 按 SNI/Host 命中 pi.example.com 虚拟主机
3. nginx 发起内部子请求 → Authelia /api/authz/auth-request（带原始 URL）
4. 未登录 → 401 → nginx 302 到 auth.example.com:18443/?rd=原地址
5. 用户在门户登录（密码 + TOTP 2FA），Authelia 种下父域会话 cookie
6. 302 带 rd 跳回原地址 → nginx 再次 auth_request → 通过
7. nginx 反代到 127.0.0.1:18080（pi-web 生产实例）
8. pi 会话开始流式回复 → SSE 长连接经 nginx 直通浏览器
```

## 4. 注意事项 / 踩过的坑

- **不要用隧道（cloudflared / ngrok）指向 pi-web 本体**：隧道域名不在
  `PI_WEB_ALLOWED_HOSTS` 时会被 DNS rebinding 防护 403；加白名单则等于无防护
  暴露整个 pi-web——危险。隧道只用于暴露"单个测试服务端口"。
- nginx 新版 `listen ... http2` 写法已弃用（warn），应改用 `http2` 指令。
- HTTP→HTTPS 的 497 跳转 + `rd` 参数回跳链路要一起配好，否则登录后回不去。
- `client_max_body_size` 记得调大，否则会话内上传大文件会被 413 挡掉。
- 家宽 IP 变化后：DDNS 更新有延迟，期间域名短暂指向旧 IP；证书不受影响
  （DNS-01 与 IP 无关）。
- dev 实例与生产实例共用数据，dev 上的误操作（如删会话）会作用到生产数据。
- **Web App Manifest 被 forward_auth 劫持报 CORS 错**：浏览器拉取
  `manifest.webmanifest` 时是 CORS 模式请求，一旦 authz 未通过（会话未带上/刚过期），
  nginx 302 到门户 `auth.example.com/?rd=...`，跨源重定向响应没有
  `Access-Control-Allow-Origin`，控制台即报 "blocked by CORS policy" +
  `net::ERR_FAILED 200 (OK)`。功能无影响（只是拿不到 PWA manifest），但会刷错误；
  修复见 5.2 的 manifest 直通 location（或 5.4 的 bypass 规则，二选一）。
- **dev 实例 HMR WebSocket 偶发 failed**：握手在未认证窗口或 dev 服务重启瞬间发起
  会失败，Next 会自动重连，属噪音；若闲置 60s 后被断，是 nginx 默认
  `proxy_read_timeout` 所致，`/dev` location 里调大即可（见 5.2）。

## 5. 参考配置（脱敏版）

> 以下配置与真实部署结构一致，仅替换了域名、端口与密钥。`<随机密钥>` 处需
> 用 `openssl rand -hex 32` 重新生成后再上线。

### 5.1 systemd 服务环境变量

```ini
# pi-web.service（生产实例，根路径，只监听回环）
[Service]
User=wind
WorkingDirectory=/path/to/pi-web
Environment=PI_WEB_NO_OPEN=1
Environment=PI_WEB_ALLOWED_HOSTS=pi.example.com
ExecStart=/usr/bin/node /path/to/pi-web/bin/pi-web.js --port 18080 --hostname 127.0.0.1
Restart=on-failure

# pi-web-dev.service（dev 实例，子路径 /dev，带 HMR）
[Service]
Environment=PI_WEB_DEV_DIST=1
Environment=PI_WEB_BASE_PATH=/dev
Environment=PI_WEB_ALLOWED_HOSTS=pi.example.com
ExecStart=/usr/bin/node /path/to/pi-web/node_modules/next/dist/bin/next dev -H 0.0.0.0 -p 18081
Restart=on-failure
```

### 5.2 nginx：pi-web 对外入口（/etc/nginx/conf.d/pi-web.conf）

```nginx
# ============================================================
# pi-web / 子应用对外入口（脱敏示例版）
#
# 结构要点:
#   - 单 server 块监听 HTTPS 端口，靠 server_name 分流
#   - 每个业务 location 挂 Authelia forward_auth（auth_request 子请求）
#   - SSE/WebSocket 透传: proxy_buffering off + Upgrade/Connection 头
#   - *.pi.example.com 通配子域给 pi-web 服务端口代理（测试服务）
# ============================================================
server {

    listen 18443 ssl http2;
    server_name pi.example.com;
    server_name pi.example.com:18443;
    server_name *.pi.example.com;

    # 直接 HTTP 访问时跳回 HTTPS
    error_page 497 https://$host:$server_port$request_uri;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;
    ssl_ciphers EECDH+CHACHA20:EECDH+CHACHA20-draft:EECDH+AES128:RSA+AES128:EECDH+AES256:RSA+AES256:EECDH+3DES:RSA+3DES:!MD5;

    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    ssl_prefer_server_ciphers  on;

    client_max_body_size 4096m;  # 上传文件大小限制

    # Authelia authz 内部子请求
    location /internal/authelia/authz {
            internal;
            proxy_pass http://127.0.0.1:19091/api/authz/auth-request;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            proxy_set_header X-Original-Method $request_method;
            proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
            proxy_set_header X-Forwarded-For $remote_addr;
    }

    # 未登录时跳转到 Authelia 登录页，登录后跳回原地址
    location @error401 {
            return 302 https://auth.example.com:$server_port/?rd=$scheme://$http_host$request_uri;
    }

    # 其它子应用（子路径部署，--base-path /justdb，反代 18082）
    location /justdb/ {
        auth_request /internal/authelia/authz;
        error_page 401 = @error401;

        # no-cache: index.html always revalidates; hashed assets get 304 -> cache stays
        add_header Cache-Control "no-cache";

        proxy_pass http://localhost:18082;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host:$server_port;
        proxy_set_header X-Forwarded-Host $host:$server_port;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Scheme $scheme;
    }

    # Web app manifest: 浏览器以 CORS 模式拉取，forward_auth 302 到门户会触发
    # CORS 阻断 → 精确匹配直通，不挂 auth_request。exact match 优先级高于
    # 下方正则 location，放此处即可生效。
    location = /dev/manifest.webmanifest {
            proxy_pass http://localhost:18081;
            proxy_http_version 1.1;
            proxy_set_header Host $host:$server_port;
            proxy_set_header X-Forwarded-Host $host:$server_port;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Real-IP $remote_addr;
    }

    # pi-web dev instance (basePath=/dev, reverse proxy to 18081).
    # Regex matches both /dev and /dev/... so Next's `/dev/` -> `/dev`
    # trailing-slash redirect cannot fall through to `location /`.
    location ~ ^/dev(?:/|$) {
            # Authelia auth (same as root location)
            auth_request /internal/authelia/authz;
            error_page 401 = @error401;

            proxy_pass http://localhost:18081;
            proxy_http_version 1.1;
            proxy_buffering off;
            proxy_request_buffering off;
            # HMR WebSocket 闲置 60s 会被默认 proxy_read_timeout 掐断（控制台报
            # webpack-hmr failed，Next 自动重连）；调大超时避免反复断开。
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host:$server_port;
            proxy_set_header X-Forwarded-Host $host:$server_port;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Scheme $scheme;
    }

    # 生产实例的 manifest 同样直通（根路径部署时为 /manifest.webmanifest）
    location = /manifest.webmanifest {
            proxy_pass http://localhost:18080;
            proxy_http_version 1.1;
            proxy_set_header Host $host:$server_port;
            proxy_set_header X-Forwarded-Host $host:$server_port;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Real-IP $remote_addr;
    }

    # pi-web 生产实例（根路径，反代 18080）
    # *.pi.example.com 的服务端口代理请求也落到这里，由 pi-web 的
    # proxy.ts 进程内调用库决策 API（st.proxy.resolve()）处理并重写转发
    # （enrollment/认证/403 全在库）。
    location / {
            # Authelia 认证（如用 Basic Auth 兜底，密码文件可放
            # /etc/nginx/.htpasswd-<应用名>）
            auth_request /internal/authelia/authz;
            error_page 401 = @error401;

            proxy_pass http://localhost:18080;
            proxy_http_version 1.1;
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host:$server_port;
            proxy_set_header X-Forwarded-Host $host:$server_port;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Scheme $scheme;
    }
}
```

### 5.3 nginx：Authelia 门户虚拟主机（/etc/nginx/conf.d/authelia.conf）

```nginx
# ============================================================
# Authelia 登录门户虚拟主机（脱敏示例版）
#
# 说明: Authelia 本身只监听 127.0.0.1:19091，公网不可直连；
#       门户页通过本虚拟主机 auth.example.com 对外提供。
# ============================================================
server {

    listen 18443 ssl http2;
    server_name auth.example.com;
    server_name auth.example.com:18443;

    # 直接 HTTP 访问时跳回 HTTPS
    error_page 497 https://$host:$server_port$request_uri;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;
    ssl_ciphers EECDH+CHACHA20:EECDH+CHACHA20-draft:EECDH+AES128:RSA+AES128:EECDH+AES256:RSA+AES256:EECDH+3DES:RSA+3DES:!MD5;

    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    ssl_prefer_server_ciphers  on;

    client_max_body_size 1m;

    location / {
            proxy_pass http://127.0.0.1:19091;
            proxy_http_version 1.1;
            proxy_buffering off;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Host $host:$server_port;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 5.4 Authelia 配置（/etc/authelia/configuration.yml）

```yaml
# ============================================================
# Authelia 配置（脱敏示例版）
#
# 敏感项（<随机密钥>）真实值已脱敏，上线前务必重新生成:
#   openssl rand -hex 32
# 结构要点:
#   - 只监听 127.0.0.1:19091，不对外
#   - AuthRequest 实现 = nginx forward_auth 子请求认证
#   - 会话 cookie 作用域设在父域，各虚拟主机共享登录态
#   - access_control: 默认全拒，业务域名强制 two_factor
# ============================================================
---
theme: auto

server:
  address: 'tcp://127.0.0.1:19091'
  endpoints:
    authz:
      auth-request:
        implementation: 'AuthRequest'

log:
  level: info

totp:
  issuer: example.com

identity_validation:
  reset_password:
    jwt_secret: '<随机密钥>'    # 真实值已脱敏

session:
  secret: '<随机密钥>'          # 真实值已脱敏
  cookies:
    - domain: 'example.com'    # 父域，使 pi./*.pi. 共享登录态
      authelia_url: 'https://auth.example.com:18443'
      default_redirection_url: 'https://pi.example.com:18443'
  redis:
    host: 127.0.0.1
    port: 6379
    database_index: 5

storage:
  encryption_key: '<随机密钥>'  # 真实值已脱敏
  local:
    path: /var/lib/authelia/db.sqlite3

notifier:
  filesystem:
    filename: /var/lib/authelia/notification.txt

authentication_backend:
  file:
    path: /etc/authelia/users_database.yml
    password:
      algorithm: argon2id

access_control:
  default_policy: deny
  rules:
    # Web app manifest：浏览器 CORS 模式拉取，绕过认证，避免 302 到门户触发
    # CORS 阻断（与 5.2 的 nginx 直通二选一即可）
    - domain: 'pi.example.com'
      path: '/manifest.webmanifest'
      policy: bypass
    - domain: 'pi.example.com'
      path: '/dev/manifest.webmanifest'
      policy: bypass
    - domain:
        - 'pi.example.com'
        - '*.pi.example.com'
      policy: two_factor
```

### 5.5 证书续期（Let's Encrypt DNS-01）

```ini
# /etc/letsencrypt/renewal/example.com.conf（节选）
# 家宽无公网 80 端口，HTTP-01 不可行；DNS-01 只验证域名控制权，
# 与 IP/端口无关，动态 IP 变化不影响证书。
authenticator = dns-<dns服务商>
dns_<dns服务商>_credentials = /etc/letsencrypt/<dns服务商>.ini
server = https://acme-v02.api.letsencrypt.org/directory
```

### 5.6 路由与 DNS

- 路由器启用 DDNS 客户端，把 `example.com` 及其子域名的 A 记录跟随动态公网 IP 更新；
- DNS 配 `*.pi.example.com` 的**泛域名 A 记录**（服务端口代理需要无限子域名）；
- 端口映射：公网 `18443` → 内网同端口。

### 5.7 敏感数据说明

- Authelia 的 `jwt_secret`、`session.secret`、`storage.encryption_key` 真实值已脱敏，
  上线前务必重新生成（`openssl rand -hex 32`）；
- `/etc/authelia/users_database.yml`（用户密码库，argon2id）与
  `/var/lib/authelia/db.sqlite3`（数据）为敏感件，不在示例范围内。

---

## 6. 示例值对照表（本文档占位符 → 读者替换）

| 占位符 | 说明 |
|---|---|
| `example.com` | 自有域名（本方案为 `.pw` 后缀域名） |
| `pi.example.com` | pi-web 对外域名 |
| `auth.example.com` | Authelia 门户域名 |
| `*.pi.example.com` | 服务端口代理通配子域名 |
| `18443` | 对外 HTTPS 端口（家宽端口映射到内网同端口） |
| `18080` / `18081` / `18082` | pi-web 生产 / dev / 其它子应用的内部回环端口 |
| `19091` | Authelia 监听端口（仅 127.0.0.1） |
| `<端口>` | pi 会话内测试服务端口（如 5173、8000） |
