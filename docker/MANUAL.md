# aiti Docker 使用手册

> 适用镜像：`aiti/aiti:core`（基础版，2.13GB）/ `aiti/aiti:full`（全功能版，7.76GB）。
> 方案与测试：`docs/aiti-docker-image-plan.md` / `docs/aiti-docker-test-report.md`。

## 1. 一分钟上手

```bash
# 基础版：浏览器打开 http://localhost:30144 即完整工作台
docker run -d --name aiti --init \
  -p 30144:30142 \
  -v aiti_data:/opt/aiti/data \
  -v aiti_agent:/opt/aiti/agent \
  -v ~/my-project:/workspace \
  aiti/aiti:core
```

- 首次打开：左侧「选择项目 → 使用默认目录」（=/workspace）→「新建」→ 底部「设置」配模型 key → 对话。
- 数据落两卷：`aiti_data`（扩展运行时数据）/ `aiti_agent`（pi 会话/模型配置）——**升级镜像不丢数据**。
- ⚠ 只挂 `/opt/aiti` 的子路径，**不要挂整个 `/opt/aiti`**：命名卷只 populate 一次，整根挂载会让镜像升级永不生效（详见测试报告 O22）。

## 2. 镜像选择

| | core | full |
|---|---|---|
| 体积 | 2.13GB | 7.76GB |
| pi-web + 42 扩展 + pi 引擎 + justget + 桥 | ✅ | ✅ |
| GUI（Xvfb/VNC/noVNC/Chrome+CDP） | — | ✅ |
| 语音识别 ASR（funasr 四模型，:8767） | — | ✅ |
| 语音合成 edge-tts / Web 终端 ttyd(:7681) | — | ✅ |
| 隧道 cloudflared/ngrok/frpc | — | ✅ |
| 内存下限 | 1GB | **8GB**（full+语音，2-6g 会 OOM） |

full 的额外 phase 用 `AITI_PHASES` 控制（见 §4）。

## 3. 端口一览

| 端口 | 服务 | 默认 |
|---|---|---|
| 30142 | pi-web 主界面 | 必映射 |
| 8777 | aiti-bridge（页面注入/MCP/agent REST） | 需要外部 agent / 注入时映射 |
| 8767 | ASR 语音识别 WS/HTTP（full） | full 默认起，按需映射 |
| 6080 | noVNC 网页看桌面（full） | 回环，按需映射 |
| 5900 | VNC（full） | 回环 |
| 9222 | Chrome CDP（full） | 回环 |
| 7681 | ttyd 网页终端（full） | 回环 |

`AITI_PIWEB_PORT` / `AITI_BRIDGE_PORT` 可改容器内侧端口（一般不动）。

## 4. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AITI_PHASES` | `piweb,bridge` | 逗号分隔：`piweb,bridge,gui,asr,term`。gui/asr/term 仅 full 有实现（core 里写明会跳过） |
| `PUID`/`PGID` | 1000 | 运行用户 uid/gid（对齐宿主用户，挂载目录权限一致）。⚠ 不能用 `UID`（bash 只读内建） |
| `TZ` | UTC | 如 `Asia/Shanghai` |
| `AITI_PIWEB_PORT` / `AITI_BRIDGE_PORT` | 30142 / 8777 | 容器内侧端口；HEALTHCHECK 自动跟随 |
| `AITI_MODE` | auto | `core`/`full`/`auto`（按镜像层标记）；full 镜像设 core 可降档只跑基础 |
| `AITI_DEV` | 0 | `1`=挂源码走 `next dev` 热重载（开发模式） |
| `AITI_SKIP_CHOWN` | 0 | `1`=`--user` 直起时跳过 root 初始化 |
| `AITI_GUI_NOFILE` | 65536 | GUI 会话 fd 上限（勿调大——NOFILE 过大 x11vnc 会死锁，测试报告 O20） |
| `AITI_GUI_SIZE` | 1920x1080x24 | 虚拟屏分辨率 |

### 域名/反代相关（pi-web 同款语义）

| 变量 | 说明 |
|---|---|
| `PI_WEB_ALLOWED_HOSTS` | 信任的主机名（逗号分隔）——反代域名**必须**加进来，否则 403。未列主机仍被拒（Host 门禁保留） |
| `PI_WEB_BASE_DOMAIN` | service-tunnels 暴露 URL 生成域（`host:port` 形式） |
| `AITI_BASE_URL` | aiti-devtools 注入页/MCP 对外地址（配你的反代 URL） |
| `API_ALLOW_ORIGINS` | 桥跨域放行（`*` 或精确 origin，反代域名不同源时需要） |
| `PI_WEB_EXTRA_EXTENSIONS_DIRS` | 追加扩展目录（容器内路径，逗号分隔；配合 `-v` 挂载用户扩展） |

反代示例配置（域名 → `127.0.0.1:30144`，桥 → `18777`）：

```bash
docker run -d --name aiti --init \
  -p 127.0.0.1:30144:30142 -p 127.0.0.1:18777:8777 \
  -e PI_WEB_ALLOWED_HOSTS="pi.alot.pw,aiti.pi.alot.pw" \
  -e PI_WEB_BASE_DOMAIN="pi.alot.pw:57442" \
  -e AITI_BASE_URL="https://aiti.pi.alot.pw:57442" \
  -e API_ALLOW_ORIGINS="*" \
  -v aiti_data:/opt/aiti/data -v aiti_agent:/opt/aiti/agent \
  aiti/aiti:core
```

实测行为（测试报告 T-E/T-H）：列内 Host 200、未列 403；`*.pi.alot.pw` 泛解析 + 泛证书下加子域零额外工作。

## 5. 卷与持久化

| 挂载点 | 内容 | 建议 |
|---|---|---|
| `/opt/aiti/data` | 扩展运行时数据（配置仓/索引/缓存） | 命名卷 |
| `/opt/aiti/agent` | pi 会话 JSONL / models.json / mcp-cache | 命名卷（**护城河，必持久**） |
| `/workspace` | 工作区（容器启动默认目录，pi 会话按项目分组） | 绑定挂载宿主项目目录 |
| `/home/aiti/.pi` | **可选**：继承宿主 pi 配置 | 首启采纳 auth.json/models.json；settings.json 与内置默认 jq 合并（用户键优先 + packages 并集） |
| `/opt/aiti/extensions` | 扩展代码 | **勿挂载**——归镜像层，升级即新 |

## 6. full 版功能速查

| 功能 | 入口 |
|---|---|
| 网页看桌面 | noVNC `:6080/vnc.html`（RFB 经 websockify→x11vnc→Xvfb :99） |
| CDP 调试 | Chrome `:9222`（headful，`--user-data-dir=/opt/aiti/data/chrome-profile`） |
| 语音输入 | ASR `ws://<host>:8767/ws/stream`（实时）/ `/voice/quick`（快识）/ `/voice/transcribe`（精修）/ `/ws/vad`（切句）——aiti-ai-input 扩展自动对接 `AITI_ASR_STREAM_BASE` |
| 语音跟读 | edge-tts 已装；aiti-ai-speak 扩展开启 `tts.edge` feature |
| 网页终端 | ttyd `:7681` |
| 隧道 | `cloudflared` / `ngrok` / `frpc` 容器内直用（ngrok 需自配 authtoken） |
| 下载工具 | `justget <url> -o <file> -m <镜像url>` 多源竞速 |

## 7. 运维

```bash
docker logs -f aiti                 # 日志（pi-web 扩展就绪/桥/banner 都在这）
docker exec -it aiti bash           # 进容器（aiti 用户，免密 sudo）
docker stats aiti                   # 资源
docker inspect aiti --format '{{.State.Health.Status}}'   # healthy=正常
docker stop aiti && docker rm aiti  # 停止销毁（卷保留）
docker volume rm aiti_data aiti_agent   # 连数据一起删（慎）
```

- **优雅停止**：`docker stop` 约 1s 内退出（信号经 entrypoint 转发各服务）。
- **升级镜像**：`docker pull` 新镜像后删容器重建（同名卷自动续数据）；扩展随镜像刷新。
- **重建+冒烟**：`./docker/scripts/rebuild-and-smoke.sh core full`（CI 可直接用，exit code=失败数）。

## 8. 构建与发布（维护者）

```bash
# 境外网络 / GitHub CI：官方源直用
./docker/build.sh --target core --tag aiti/aiti:core
./docker/build.sh --target full --tag aiti/aiti:full     # 依赖 core 先行

# 国内本地：--cn 注入镜像源（apt=tuna / npm=npmmirror / hf=hf-mirror / pypi=tuna）
./docker/build.sh --target core --tag aiti/aiti:core --cn
# 等价 env：AITI_CN=1（systemd 单元模板已预设）

./docker/scripts/smoke.sh full [--keep]                  # 22 项冒烟（exit=失败数）
node docker/scripts/e2e-ui.mjs                           # UI 旅程 E2E（需 playwright-core + chromium）
node docker/scripts/gen-deps.mjs                         # S3 依赖矩阵（读扩展 aiti 元数据块）
```

> `--cn` 只管公共源镜像；**`@aiti-ai/*` 私仓是独立的临时通道**：`--private-registry https://npm.alot.pw/`
> （或 env `AITI_PRIVATE_REGISTRY`）——仅测试期使用，正式发布（@aiti-ai/* 上公网 npm）后不传即走公网。
> 运行时同理：`docker run -e AITI_NPM_REGISTRY=https://npm.alot.pw/` 让 pi 首启拉私包（写入容器内 `~/.npmrc`）。
> 已知边界（详见测试报告遗留节）：arm64 无官方 Chrome（CDP 缺位，其余下载层就绪）；ngrok/frpc 下载偶发需重试（构建内已带 gh 镜像竞速兜底）；UI E2E 依赖宿主 chromium。

## 9. 故障速查

| 症状 | 原因/处置 |
|---|---|
| 容器反复重启 | `docker logs` 看首个 error；常见=端口占用/卷权限（PUID 对齐） |
| 反代 403 | 域名没进 `PI_WEB_ALLOWED_HOSTS` |
| `/api/models` 403 | 正常——它只放行已有会话 cwd；健康检查走 `/api/home` |
| x11vnc 连上无画面/极慢 | NOFILE 死锁（O20）——确认 `AITI_GUI_NOFILE` 未调大、用镜像自带 50-gui-start |
| CDP 9222 不通 | 确认 `--user-data-dir` 在旗标里（Chrome 136+ 默认 profile 忽略 CDP）+ EULA 首启已跳过 |
| ASR 首响应慢 | 模型懒加载（full 已预下载 2.7GB，零重下；换模型才会增量下载） |
| OOM | full+语音 ≥8g 内存（2-6g 实测 OOM，测试报告 T-H5） |
