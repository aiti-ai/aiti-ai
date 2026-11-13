# AITI Web — 官方 Docker 镜像（core / full）

[English](https://github.com/aiti-ai/aiti-ai/blob/main/docker/README.md) | 中文 | [日本語](https://github.com/aiti-ai/aiti-ai/blob/main/docker/README.ja.md) | [Русский](https://github.com/aiti-ai/aiti-ai/blob/main/docker/README.ru.md)

**AITI Web**（`@aiti-ai/pi-web`）是 [pi coding agent](https://github.com/earendil-works/pi) 的浏览器工作台。它由上游 [pi-web](https://github.com/agegr/pi-web) 分叉而来，长成了自己的发行版 **aiti**，为真实日常使用而造：63+ 个内置扩展（会话与队列、git 工具链、页面注入调试、多 agent 后端、隧道、语音），零逐个安装；引擎保持 pi（共享 JSONL 会话、同一份本地配置）。

本镜像是运行整套工作台最快的方式：一个容器装下 pi-web + 全部内置扩展 + pi 引擎 + Node/git + aiti-bridge；`full` 版在此基础上再加网页桌面（noVNC、Chrome/CDP）、语音与隧道。分叉背后的故事：[aiti.pw/guide/origin.html](https://aiti.pw/guide/origin.html)。

文档：[aiti.pw](https://aiti.pw/)（EN / 中文）· 源码：[aiti-ai/aiti-ai](https://github.com/aiti-ai/aiti-ai) · 偏好 npm？`npm i -g @aiti-ai/pi-web` · 许可证：[MIT](https://github.com/aiti-ai/aiti-ai/blob/main/LICENSE)

---

# 使用手册

> 镜像：`aitiai/pi-web:core`（基础版，2.13GB）/ `aitiai/pi-web:full`（全功能版，7.76GB）。

## 1. 快速开始

```bash
# 基础镜像：浏览器打开 http://localhost:30144 即完整工作台
docker run -d --name aiti --init \
  -p 30144:30142 \
  -v aiti_data:/opt/aiti/data \
  -v aiti_agent:/opt/aiti/agent \
  -v ~/my-project:/workspace \
  aitiai/pi-web:core
```

- 首次启动：侧边栏「选择项目 → 使用默认目录」（即 /workspace）→「新建会话」→ 底部「设置」配置模型密钥 → 开始对话。
- 数据存放在两个卷里：`aiti_data`（扩展运行时数据）和 `aiti_agent`（pi 会话 / 模型配置）——**升级镜像不丢数据**。
- ⚠ 只挂载 `/opt/aiti` 的子路径，**永远不要挂载整个 `/opt/aiti`**：命名卷只会在首次填充，挂载根路径会让镜像升级从此失效（见测试报告 O22）。

## 2. 选择镜像

| | core | full |
|---|---|---|
| 体积 | 2.13GB | 7.76GB |
| pi-web + 内置扩展 + pi 引擎 + justget + bridge | ✅ | ✅ |
| GUI（Xvfb/VNC/noVNC/Chrome+CDP） | — | ✅ |
| ASR 语音识别（funasr 四模型，:8767） | — | ✅ |
| TTS edge-tts / 网页终端 ttyd（:7681） | — | ✅ |
| 隧道 cloudflared/ngrok/frpc | — | ✅ |
| 内存下限 | 1GB | **8GB**（full + 语音；2–6GB 会 OOM） |

full 的额外阶段由 `AITI_PHASES` 控制（见 §4）。

## 3. 端口

| 端口 | 服务 | 默认 |
|---|---|---|
| 30142 | pi-web 主界面 | 必须映射 |
| 8777 | aiti-bridge（页面注入 / MCP / agent REST） | 使用外部 agent / 注入时映射 |
| 8767 | ASR WS/HTTP（full） | full 默认开启；按需映射 |
| 6080 | noVNC 网页桌面（full） | 仅回环，按需映射 |
| 5900 | VNC（full） | 仅回环 |
| 9222 | Chrome CDP（full） | 仅回环 |
| 7681 | ttyd 网页终端（full） | 仅回环 |

`AITI_PIWEB_PORT` / `AITI_BRIDGE_PORT` 修改容器侧端口（少用）。

## 4. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AITI_PHASES` | `piweb,bridge` | 逗号分隔：`piweb,bridge,gui,asr,term`。gui/asr/term 仅在 full 实现（core 记日志跳过） |
| `PUID`/`PGID` | 1000 | 运行 uid/gid（与宿主用户对齐，挂载目录即插即用）。⚠ 不要用 `UID`（bash 只读内建） |
| `TZ` | UTC | 如 `Asia/Shanghai` |
| `AITI_PIWEB_PORT` / `AITI_BRIDGE_PORT` | 30142 / 8777 | 容器侧端口；HEALTHCHECK 自动跟随 |
| `AITI_MODE` | auto | `core`/`full`/`auto`（按镜像层标记）；在 full 镜像上设 core 会降级为基础阶段 |
| `AITI_DEV` | 0 | `1` = 挂载源码并跑 `next dev` 热重载（开发模式） |
| `AITI_SKIP_CHOWN` | 0 | `1` = 用 `--user` 直接启动时跳过 root 初始化 |
| `AITI_GUI_NOFILE` | 65536 | GUI 会话 fd 上限（勿调大——NOFILE 过大会死锁 x11vnc，测试报告 O20） |
| `AITI_GUI_SIZE` | 1920x1080x24 | 虚拟显示分辨率 |

### 域名 / 反向代理（与 pi-web 同语义）

| 变量 | 说明 |
|---|---|
| `PI_WEB_ALLOWED_HOSTS` | 可信主机名（逗号分隔）——反向代理域名**必须**列入否则请求 403。未列入的主机保持拒绝（Host 门禁仍在） |
| `PI_WEB_BASE_DOMAIN` | service-tunnels 暴露 URL 的构建域（`host:port`） |
| `AITI_BASE_URL` | aiti-devtools 注入页 / MCP 的公网基础 URL（设为你的代理 URL） |
| `API_ALLOW_ORIGINS` | 桥 CORS（`*` 或显式来源；代理域与源站域不同时需要） |
| `PI_WEB_EXTRA_EXTENSIONS_DIRS` | 额外扩展目录（容器内路径，逗号分隔；配合 `-v` 挂载用户扩展） |

反向代理示例（域名 → `127.0.0.1:30144`，桥 → `18777`）：

```bash
docker run -d --name aiti --init \
  -p 127.0.0.1:30144:30142 -p 127.0.0.1:18777:8777 \
  -e PI_WEB_ALLOWED_HOSTS="pi.example.com,aiti.pi.example.com" \
  -e PI_WEB_BASE_DOMAIN="pi.example.com:8443" \
  -e AITI_BASE_URL="https://aiti.pi.example.com:8443" \
  -e API_ALLOW_ORIGINS="*" \
  -v aiti_data:/opt/aiti/data -v aiti_agent:/opt/aiti/agent \
  aitiai/pi-web:core
```

实测行为（测试报告 T-E/T-H）：列入的 Host 返回 200，未列入 403；在 `*.pi.example.com` 通配符 + 通配符证书下加子域无需额外操作。

## 5. 卷与持久化

| 挂载 | 内容 | 建议 |
|---|---|---|
| `/opt/aiti/data` | 扩展运行时数据（配置仓 / 索引 / 缓存） | 命名卷 |
| `/opt/aiti/agent` | pi 会话 JSONL / models.json / mcp-cache | 命名卷（**命脉——务必持久化**） |
| `/workspace` | 工作区（启动默认 cwd；pi 会话按项目分组） | 绑定挂载宿主项目目录 |
| `/home/aiti/.pi` | **可选**：继承宿主 pi 配置 | 首次运行采纳 auth.json/models.json；settings.json 与内置默认 jq 合并（用户键优先，packages 取并集） |
| `/opt/aiti/extensions` | 扩展代码 | **不要挂载**——归镜像层所有；升级随镜像刷新 |

## 6. full 版功能速览

| 功能 | 入口 |
|---|---|
| 网页桌面 | noVNC `:6080/vnc.html`（RFB 经 websockify→x11vnc→Xvfb :99） |
| CDP 调试 | Chrome `:9222`（headful，`--user-data-dir=/opt/aiti/data/chrome-profile`） |
| 语音输入 | ASR `ws://<host>:8767/ws/stream`（实时）/ `/voice/quick`（快捷）/ `/voice/transcribe`（精转）/ `/ws/vad`（分段）——aiti-ai-input 扩展经 `AITI_ASR_STREAM_BASE` 自动接线 |
| 语音朗读 | 已装 edge-tts；在 aiti-ai-speek 扩展启用 `tts.edge` feature |
| 网页终端 | ttyd `:7681` |
| 隧道 | 容器内可用 `cloudflared` / `ngrok` / `frpc`（ngrok 需自带 authtoken） |
| 下载工具 | `justget <url> -o <file> -m <mirror-url>` 多源竞速 |

## 7. 运维

```bash
docker logs -f aiti                 # 日志（扩展就绪 / 桥 / 横幅都在这）
docker exec -it aiti bash           # 进容器（用户 aiti，免密 sudo）
docker stats aiti                   # 资源
docker inspect aiti --format '{{.State.Health.Status}}'   # healthy = 正常
docker stop aiti && docker rm aiti  # 停止并移除（卷保留）
docker volume rm aiti_data aiti_agent   # 连数据一起删（谨慎）
```

- **优雅停止**：`docker stop` 约 1s 内退出（entrypoint 把信号转发给各服务）。
- **升级**：`docker pull` 新镜像，然后删除并重建容器（同名卷携带数据）；扩展随镜像刷新。
- **重建 + 冒烟**：`./docker/scripts/rebuild-and-smoke.sh core full`（CI 就绪；exit code = 失败数）。

## 8. 构建与发布（维护者）

```bash
# 非 CN 网络 / GitHub CI：直接用官方源
./docker/build.sh --target core --tag aitiai/pi-web:core
./docker/build.sh --target full --tag aitiai/pi-web:full     # 需先有 core

# CN 本地构建：--cn 注入镜像源（apt=tuna / npm=npmmirror / hf=hf-mirror / pypi=tuna）
./docker/build.sh --target core --tag aitiai/pi-web:core --cn
# 等价 env：AITI_CN=1（systemd unit 模板已预置）

./docker/scripts/smoke.sh full [--keep]                  # 22 项冒烟套件（exit = 失败数）
node docker/scripts/e2e-ui.mjs                           # UI 旅程 E2E（需 playwright-core + chromium）
node docker/scripts/gen-deps.mjs                         # S3 依赖矩阵（读扩展 `aiti` 元数据块）
```

> `--cn` 只影响公共源镜像；**`@aiti-ai/*` 私仓是另一条临时通道**：`--private-registry <私仓地址>`（或 env `AITI_PRIVATE_REGISTRY`）——仅本地测试用。`@aiti-ai/*` 上了公共 npm 后省略即可，走官方源。
> 运行时同理：`docker run -e AITI_NPM_REGISTRY=<私仓地址>` 让 pi 首启能拉私包（写进容器内 `~/.npmrc`）。
> 已知限制（见测试报告遗留问题节）：arm64 无官方 Chrome（缺 CDP；其余下载层就绪）；ngrok/frpc 下载偶需重试（构建带 gh-mirror 竞速兜底）；UI E2E 依赖宿主 chromium。

## 9. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| 容器重启循环 | `docker logs` 看首个报错；通常是端口冲突 / 卷权限（对齐 PUID） |
| 反向代理 403 | 域名不在 `PI_WEB_ALLOWED_HOSTS` |
| `/api/models` 403 | 正常——只放行既有会话 cwd；健康检查走 `/api/home` |
| x11vnc 连上但无画面 / 极慢 | NOFILE 死锁（O20）——确认没调大 `AITI_GUI_NOFILE` 并用镜像自带 50-gui-start |
| CDP 9222 不可达 | 确认 flag 里有 `--user-data-dir`（Chrome 136+ 默认 profile 忽略 CDP）+ 首启 EULA 已跳过 |
| ASR 首响慢 | 模型懒加载（full 已预下载模型，零重复下载；切模型增量下载） |
| OOM | full + 语音需 ≥8GB 内存（实测 2–6GB 会 OOM，测试报告 T-H5） |
