# aiti Docker 镜像（base `core` / all-in-one `full`）

> 方案：`docs/aiti-docker-image-plan.md`（**终版 core 2.97GB / full 8.6GB，全功能冒烟绿，2026-09-10**；审核+全功能测试报告 `docs/aiti-docker-test-report.md`——19 项优化/缺口清单 O1-O19 与逐项测试结果）。
> full 终版增量：funasr 默认引擎四模型预下载（2.7GB，MODELSCOPE_CACHE 固化）+ Google Chrome 直装（CDP 经 `--no-first-run --user-data-dir` 双修复后才真正可用）+ ttyd pin 1.7.7 + locale 生成。

## 一句话

```bash
docker run -p 30142:30142 -v aiti-data:/opt/aiti -v ~/workspace:/workspace aiti/aiti:core
# 浏览器开 http://localhost:30142 —— fork pi-web + 全部扩展 + node/git + justget 工具市场
# GUI/语音/隧道 → aiti/aiti:full
```

启动默认工作目录 `/workspace`，以普通用户 `aiti` 运行（可 sudo），数据独立于 `~/.pi`（`PI_WEB_EXTENSIONS_DIR` / `PI_WEB_DATA_DIR` / `PI_CODING_AGENT_DIR` 全 env 指向 `/opt/aiti`）。

## 构建

```bash
./docker/build.sh --target core --tag aiti/aiti:core   # 先 core，冒烟通过再 full
./docker/build.sh --target full --tag aiti/aiti:full
```

- 构建上下文由 build.sh 组装（staging：pi-web 源码 + aiti-ai 扩展 + justget），git/构建产物不进。
- 预检：`ubuntu:26.04` 已于 2026-09-08 在 48 主机经 registry-mirror 实证可拉取（R1 解除）。
- 已知首跑校准点：Chromium deb（R4，Dockerfile.full ① 内含 a→b→c 降级链）、funasr 流式模型名（40-asr-setup.sh TODO）、ngrok/frpc 下载层、扩展 deploy 白名单核对。

## 首跑记录（2026-09-09，core）

- **构建通过，镜像 2.91GB**（初版 20.4GB → staging 排除 `.next-*`/`.venv`/ai-configs 版本仓 + 每次清空重建后收敛； further slimming：pi-web dev deps 因 turbopack 外部化暂不可裁）。
- 容器冒烟通过：`/` 200、45 扩展部署产物中 41 个进镜像、扩展全部加载（model-wizard/doc-center 启动日志）、justget/aiti-bridge/gosu 就位。
- 首跑校准实录（均已修入脚本）：① COPY 路径对齐 staging 根 ② ubuntu 24.04+ 自带 uid1000 用户改名复用 ③ pi-web lock 漂移（@xterm/xterm）→ ci 失败回落 install ④ deploy-extensions 向上探测根+按需装扩展依赖+根部 esbuild ⑤ staging 清空重建（rsync exclude 保护残留是 20GB 根因）⑥ entrypoint `UID` 是 bash 只读内建 → 改 PUID/PGID ⑦ chown 收窄到可变目录（全量 chown 卡启动数分钟）⑧ 撤 `npm prune --omit=dev`（turbopack 外部化 jiti 需 dev deps）。
- 已知缺口：service-tunnels 未进镜像（并行会话 ui-shared.ts 共享层重构 WIP 中，落地后自动恢复）。

## 首跑记录（2026-09-09，full）

- **构建通过，镜像 5.36GB**（方案预期 4-5GB ✓）。容器冒烟：`/` 200；chromium-browser（ubuntu 源 deb，R4 解除）/cloudflared/edge-tts/ttyd 全就位；ASR venv（uv 托管 CPython 3.12）+ whisper small 预下载 + faster_whisper/funasr import OK；GUI phase（Xvfb/openbox/x11vnc 进程 + noVNC :6080 200）✓。
- full 首跑追加校准（均已修入）：⑨ core apt 补 `python3-dev` ⑩ ASR 改 uv 托管 Python 3.12（26.04 系统 3.14 无 cp314 轮子）⑪ `HF_HUB_DISABLE_XET=1`（Xet 后端绕过镜像源 401）⑫ 模型预下载改用 venv python ⑬ ttyd release 资产是裸二进制（非 tarball）。
- ASR phase 完成对接（2026-09-09 续）：镜像内带 aiti-ai-input server 应用代码 + uv 托管 py3.12 venv；单服务 voice-asr-stream.py :8767 Uvicorn running、/health 200、torch+funasr import OK。torch 改 CPU 官方源轮（pypi linux 轮捆绑 CUDA ~5GB → 镜像 10.9GB 回落 6.12GB）。追记校准：⑭ 补 `from __future__ import annotations`（threading.Lock | None 在 py3.12 类定义期求值炸，host 3.14 掩盖）⑮ torch 显式入清单（torchaudio 未连带拉取）。
- 终版（2026-09-09 三轮收敛）：core 2.97GB / full 6.14GB；fresh-deploy 校验器再抓两缺口并修——attach-agent deploy 清单漏拷 bridge-registry.ts、`@aiti-ai` scope 容器内私仓解析（bridge 依赖安装 404）；bridge phase 实测（/aiti/aiti-launcher.js 200）。
- ~~待办：ngrok/frpc 下载层~~（已做，commit 5b57c504）；~~Windows start.ps1~~（已做，`docker/start.ps1`，见下）。

## 审核校准记录（2026-09-09 二次审核）

上一轮审核发现并已修（重建后生效）：

1. **ASR 层对齐现行服务端**：撤 `faster-whisper`（服务端已不用，requirements.txt 无此包）+ 撤 whisper small 预下载（非默认引擎）；补 `pypinyin`（热词拼音模糊匹配，缺了会炸）；模型预下载改为与 `voice-asr-stream.py` 内置默认同源四件（paraformer-zh-streaming / seaco paraformer / SenseVoiceSmall / fsmn-vad，funasr AutoModel hub=ms 同参调用）；模型缓存收敛 `MODELSCOPE_CACHE=/opt/aiti-asr/models`（镜像固化 + 不受 `~/.aiti/.cache` 可选卷遮蔽 + 运行时增量下载落同目录）。
2. **entrypoint 信号转发**：`docker --init`（tini 为 PID1）时 entrypoint 非进程组长，`kill -- -$$` 组号不成立 → 改为记录各 phase 子 pid 逐个 `kill -TERM`（docker stop 才能优雅停）。
3. **`.dockerignore` 撤 `*.png`**：误伤 pi-web PWA 图标（icon-192/512/apple-touch-icon 镜像内 404）。
4. **ttyd 资产名/版本**：release 资产是内核风格命名（`ttyd.x86_64`/`aarch64`，非 dpkg 的 amd64）且「latest」曾 302 失败——pin 1.7.7 + 4 源竞速 + 构建期 `ttyd --version` 硬校验（静默缺席会让 [term] phase 起不来）。
5. **Chrome/CDP 双坑（详见测试报告 O11/O18/O19）**：ubuntu 26.04 的 `chromium-browser` 是 snap 过渡包（apt 装=假成功）→ 改 Google 官方直装 deb；headful 首启卡 EULA（`--no-first-run`）+ Chrome 136+ 默认 profile 忽略 CDP 端口（必须 `--user-data-dir`）。
6. **杂项**：10-apt-mirror 兜底代号从 os-release 取（原硬编码 noble=24.04）；compose.yaml 去 bash shebang；core 补 `locales` + `locale-gen zh_CN.UTF-8`（GUI 组件 "Couldn't set locale" 噪音）；bridge 层 npm 依赖在镜像内放宽为 `*`（本地 WIP 版本领先私仓发布时 ETARGET 断构建——bridge 实际走相对路径 import core 源码）；`--user` 直起分支（gosu 非 root 必炸）。
7. **VNC 大 NOFILE 死锁（O20，strace 实证）**：容器默认 `RLIMIT_NOFILE=2^30`——x11vnc 每接受一个客户端按 NOFILE 逐 fd fcntl 扫描（十几亿次，十几分钟/客户端）→ RFB banner 永不到。50-gui-start.sh 顶部 `ulimit -n 65536`（`AITI_GUI_NOFILE` 可调）；修复后直连与 noVNC 链路秒级握手。

## S5 · Windows 原生部署器（`docker/start.ps1`）

与 entrypoint.sh / Linux systemd 同一份 `AITI_PHASES` 语义（§9.3 验收口径）：前台启动（Ctrl+C 全停）、`-Install`/`-Remove` NSSM 服务化（AitiWeb/AitiBridge）、`-Status` 端口速查。路径全部 env 可覆盖（AITI_APP_DIR / AITI_EXTENSIONS_DIR / …，S2 规范）。gui=CDP 拉 Edge（原生桌面即显示）、asr=复用 aiti-ai-input 自管 `start-stream.ps1`、term=提示走原生终端/justget。

## 首跑实录（2026-09-09，core）

`aiti/aiti:core` 已构建并冒烟通过：**2.91GB**（目标 1-1.5GB，含 pi-web 生产构建 870M 与
全扩展产物 172M；dev 依赖因 turbopack 运行时外部化暂留——见 Dockerfile.core TODO）。
41/45 扩展部署进镜像（service-tunnels 因并行会话 WIP 的共享包 src 未发布暂缺，lock 补发
后自动恢复）。

首跑校准记录（全部已回写脚本注释）：
1. COPY 路径对齐 staging 根；ubuntu 24.04+ 自带 uid 1000 用户 → 改名复用
2. staging 每次清空重建（rsync --exclude 会保护接收端已存在的排除文件——首跑 20.4GB 根因）
3. pi-web lock 漂移 → ci 回落 install；扩展 deps 容器内按需 ci（lock 私有包 resolved 直取）
4. `npm prune --omit=dev` 剪掉 turbopack 外部化运行时包（jiti-*）→ 启动即炸——撤 prune
5. entrypoint 只 chown 可变目录（全量 chown 数十万文件卡启动数分钟）
6. 容器内冒烟：`/` 200、41 扩展加载日志齐全；~~宿主侧 `/api/models` 403 为 request-security
   同源校验拒容器外探针，非故障~~（旧诊断不准——实为 `/api/models` allowed-roots 只放行既有
   会话 cwd，全新容器必 403，与来源无关；HEALTHCHECK 已改走 `/api/home`）

## 目录

| 文件 | 角色 |
|---|---|
| `Dockerfile.core` | base：apt 源/Node22/基础工具/gosu+sudo + pi-web 生产构建 + 扩展部署产物 + pi 引擎 + justget + aiti-bridge |
| `Dockerfile.full` | core + GUI（Xvfb/openbox/x11vnc/noVNC/dbus/at-spi/xdotool）+ Chromium + ASR 模型 + edge-tts + 隧道 + ttyd |
| `entrypoint.sh` | root 初始化（PUID/PGID 可覆盖 + chown）→ gosu 降权 → phases（`piweb,bridge` / full 追加 `gui,asr,term`） |
| `start.ps1` | S5 Windows 原生部署器（同一 AITI_PHASES 语义；前台 / NSSM 服务化 / -Status） |
| `compose.yaml` | 一键起（卷/端口/安全默认：GUI/CDP/RDP 不映射） |
| `build.sh` | staging 组装 + 预检 + docker build |
| `scripts/10-apt-mirror.sh` | deb822 apt 源切国内镜像 |
| `scripts/deploy-extensions.sh` | 构建容器内批量跑扩展 deploy.mjs → 拷进 /opt/aiti/extensions（S4 npm 链就绪后替换为 aiti-ext-install） |
| `scripts/30-install-pi.sh` | pi CLI 全局装 + /opt/aiti/agent/settings.json packages |
| `scripts/40-asr-setup.sh` | ASR venv + whisper small + funasr 模型预下载（HF 镜像源） |
| `scripts/50-gui-start.sh` | 容器内 GUI 自启（无 systemd 分支，R2） |
| `scripts/gen-deps.mjs` | S3：扫扩展 package.json `aiti` 元数据块 → 依赖矩阵自动生成 |
| `scripts/smoke.sh` | 自动化冒烟套件（测试报告的可重复执行版）：22 项检查一次跑完，exit code=失败数。用法 `./docker/scripts/smoke.sh core\|full [--keep]` |
| `scripts/e2e-ui.mjs` | UI 打字 E2E（Playwright Chromium）：选项目→新建→打字→Enter 全用户旅程。需宿主 `npm i playwright-core` + `npx playwright install chromium`，容器发布 30142 端口后运行 |

## 标准化总纲（S1-S5）落点

- **S2 路径清零**：附录 C A1-A12/B1/B2 已实施（env 优先、未设行为不变）——本仓库由各扩展修复；pi-web fork A1-A3 见 pi-web 仓库 commit `42d2fab`。
- **S3 元数据**：契约见方案 §7.1；`gen-deps.mjs` 是消费方之一，扩展补 `aiti` 块后台账即自动生成。
- **S4 安装链**：`deploy-extensions.sh` 保留现 deploy 通道并标注升级点。
- **S5 runner**：entrypoint（容器）/ systemd（Linux 裸机，aiti-ui-env 既有）/ `start.ps1`+NSSM（Windows，已落地）——三平台同一 `AITI_PHASES` 语义。
