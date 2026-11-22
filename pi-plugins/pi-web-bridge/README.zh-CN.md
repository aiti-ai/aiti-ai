# @aiti-ai/pi-web-bridge

> 用 `/web` 把 [pi](https://pi.dev) TUI 会话桥接到浏览器——pi-web 侧实时打开同一会话，双向 IO（prompt / steer / follow-up / abort / 切模型）、排队消息回显、图片附件透传。

[English](./README.md) · 简体中文

一个小 [pi 包](https://pi.dev/packages)，与 [pi-web](https://github.com/aiti-ai/pi-web) 的 attach 后端（`aiti-attach-agent`）配对使用。

## 关于 aiti

本包来自 [aiti](https://aiti.pw/)（GitHub org [aiti-ai](https://github.com/aiti-ai)）——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台生态：**aiti-agent** Web 工作台（基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建）+ 开发工具调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>

## 功能

照常在终端跑 `pi`，然后：

- **`/web`**——交互向导：选 *attach*（rpc 桥；浏览器与 TUI 共同操作会话）或 *takeover*（pi-web 进程内跑 pi SDK，TUI 交接会话），可顺带拉起新 pi-web 并打开浏览器。
- **`/web --attach --no-spawn --no-open`**——直连模式：起桥并 attach 到已在运行的 pi-web。
- **`/web off`**——停桥。

桥接期间：

- 所有 agent 事件实时流入浏览器（消息、工具调用、回合、模型切换）。
- 浏览器输入转发进 TUI 会话：prompt、steer（打断）、follow-up（排队）、abort、模型/思考等级切换、compact、会话改名——以及已注册斜杠命令清单。
- 模型流式输出期间排队的消息回显给浏览器（桥内合成 `queue_update` 镜像——pi 不向扩展转发队列事件）。
- 浏览器发送的图片附件校验后透传进会话。
- 会话在 pi-web「All Sessions」面板带 `tui-bridge` 标签；会话所有权仍在 pi 进程（单写者规则——web 侧 attach 到 socket，绝不打开文件）。

### 全自动模式

在 shell profile 里 `export PI_WEB_BRIDGE_AUTO=1`，之后每个普通终端 `pi` 会话启动即自动上桥（无需 `/web`、无向导）：从任意运行中的 pi-web 实例打开该会话即可实时围观/交互。空闲会话 10 分钟后自行退出（`PI_WEB_IDLE_TIMEOUT_MS`，`0` 关闭）。

## 安装

```bash
pi install npm:@aiti-ai/pi-web-bridge
```

需要一个运行中的 [pi-web](https://github.com/aiti-ai/pi-web)（`aiti-attach-agent` 扩展随附）——即本桥配对的浏览器侧。运行方式见 pi-web README。

## 配置（环境变量）

| 变量 | 含义 |
|---|---|
| `PI_WEB_BRIDGE_AUTO=1` | 每个 TUI 会话启动自动上桥 |
| `PI_WEB_BRIDGE_BASE` | 运行中 pi-web 的 URL（用于 URL 推导与 aiti_* 工具路由） |
| `PI_WEB_BRIDGE_PORT` | 拉起 pi-web 的默认端口（默认 `3000`） |
| `PI_WEB_BRIDGE_ENTRY` | 拉起 pi-web 的命令（默认 `pi-web`） |
| `PI_WEB_BRIDGE_LANG` | UI 语言：`zh` 或 `en`（默认随 locale） |
| `PI_WEB_IDLE_TIMEOUT_MS` | 自动桥空闲退出超时（默认 `600000`，`0` 关闭） |

`/web` 还接受旗标：`--port`、`--base`、`--domain`、`--scheme`、`--webport`、`--takeover` / `--attach`、`--open` / `--no-open`、`--spawn` / `--no-spawn`。

## 工作原理

```
pi TUI ── /web ──▶ Unix-socket JSONL 桥 ◀── attach ── pi-web (aiti-attach-agent)
                    (事件出，命令入)                      │
                                                          └─ bridge-registry.json
                          ~/.pi/agent/bridge-registry.json 记录存活会话文件 → socket，
                          pi-web 据此 attach 而非打开文件（单写者规则）
```

扩展在 pi 进程内注册 socket 服务，转发 agent 事件、把浏览器命令翻译成 pi API，并维护注册表（`~/.pi/agent/bridge-registry.json`）供 pi-web 打开会话时查询。第二个入口（`dist/aiti-devtools-pi.js`）是 aiti-devtools 连接器 bundle：当 [aiti-devtools](https://github.com/aiti-ai/aiti-ai) MCP 桥在场时，其工具经同一 socket 路由到 pi-web 正在显示的页面。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-attach-agent.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-attach-agent.html>

## 许可证

MIT
