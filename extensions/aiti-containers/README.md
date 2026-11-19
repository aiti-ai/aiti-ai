# aiti-containers · 容器管理（pi-web 扩展）

把 VS Code Container Tools 的核心体验搬进 pi-web AI 窗：一个面板管容器 / 镜像 / 卷 / 网络 / compose 项目，同一套能力以 agent 工具暴露给 AI。

对标 `microsoft/vscode-containers`（调研与设计见 `pi-work/docs/aiti-containers-方案.md`）。

## 功能

- **运行时自动探测**：docker / podman / nerdctl（含 compose 子命令），feature `cli` 可覆盖；探测失败给出可操作提示（无权限 / daemon 未启动 / 未安装）。
- **容器**：列表（运行态/端口/compose 归属）、start / stop / restart / remove、日志查看。
- **compose 项目**：按 `com.docker.compose.project` 分组，整组 up / restart / down / logs。
- **镜像**：列表（dangling 标记）、pull / remove / prune。
- **卷 / 网络**：列表、create / remove / prune。
- **系统**：`system df` 占用概览 + `system prune`（危险确认）。
- **容器内执行**：从工具或面板触发（危险确认）。
- **AI 工具**：`aiti_containers_state` / `aiti_containers_logs` / `aiti_containers_action` / `aiti_containers_exec`，配套 `containers-ops` 排障手册。

## 危险操作确认协议

- UI：第一次点击进入「再点确认」（5 秒内有效）。
- API：未带 `confirm:true` → HTTP 428 + `{ needConfirm: true, danger }`。
- AI：工具返回同上，要求先把动作原文展示给用户、获得明确同意后再 `confirm:true` 重调。

## API

`/api/extensions/aiti-containers/`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `state[?kind=&refresh=1]` | 聚合态（容器/镜像/卷/网络/占用/compose 项目） |
| GET | `runtime[?refresh=1]` | 运行时探测结果 |
| GET | `logs?kind=&id=|project=&dir=&tail=` | 日志 |
| GET | `inspect?kind=&id=` | `docker inspect` 原始 JSON（截断） |
| POST | `action` | `{ kind, action, id?, ... , confirm? }` |

## features

| id | 默认 | 说明 |
|---|---|---|
| `cli` | `auto` | auto / docker / podman / nerdctl / 可执行路径 |
| `showStopped` | on | 是否显示已停止容器 |
| `logTail` | `200` | 默认日志行数（上限 2000） |
| `confirmDanger` | on | 危险操作二次确认总开关（不推荐关） |

## 开发与部署

```bash
node tools/build.mjs     # esbuild → dist/aiti-containers-client.mjs
node tools/deploy.mjs    # 构建 + 拷贝到 ~/.pi/web-dev/extensions/ + reload dev
```

- 只部署 dev（30142）；prod 部署需明确同意。
- 服务端只用 node 内置模块；客户端零运行时依赖（宿主 `h()` 手写）。

## 与原版的取舍

保留：资源浏览、动作、日志、compose 分组、运行时抽象、危险确认、AI 工具。

不做：Dockerfile / compose 语言服务、脚手架、容器内调试、注册表 / ACR、Azure、`containers:` 文件系统 provider。理由见方案文档 §2.2。
