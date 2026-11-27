# aiti-proc-tree — 子进程管理

树形列出 pi-web 生态派生的子进程（终端 / 隧道 / 子代理 / 外部 Agent / 宿主后代），
显示 CPU、内存、运行时长与命令行，可结束单个进程或整棵子树。

面板**只在打开时采样**（dock 展开或浮窗可见）；折叠 dock 或隐藏页面即停止客户端
轮询，服务端零定时器。

## 显示范围

| 来源 | 发现方式 |
|---|---|
| 宿主树 | `process.pid` + `bin/pi-web.js` / `next dev` 祖先链 + `/proc` ppid 图 |
| aiti-cmd 终端 | `aiti-cmd.procs` 服务（in-process + detached）+ `~/.pi/agent/aiti-cmd-host/registry/*.json` |
| service-tunnels | `service-tunnels.procs` 服务 + `registered-pids-<ppid>.json` + `SERVICE_TUNNELS_*` 标记 |
| 子代理 | `aiti-subagents.procs`（attached）+ `/tmp/pi-subagents-*/async-subagent-runs/*/status.json`（detached） |
| 外部 Agent | `~/.pi/agent/agent-starter/registry/*.json`、`bridge-registry.json`、`aiti-acp-agent.procs` |

**不采集无关进程**：全量只读 `stat` 建 ppid 图，只对可见集合读 `status/cmdline/cwd`
（env 标记只读种子进程）。`showUnknown` 开关仅列出 stat 级只读信息。

## 操作

- 五列：名称 / PID / CPU / 内存 / 时长；点击行打开详情抽屉（完整命令行、cwd、
  白名单环境变量、父/子进程）。
- `✕` 结束进程；`⋯` 详情；终端行双击打开对应的 aiti-cmd 终端；隧道行打开服务面板。
- kill 护栏：同 uid、保护名单（init / 扩展宿主 / pi-web CLI / 其它实例）、仅已识别
  归属、二次确认、`kill-audit.jsonl` 审计。

## 开发

```bash
cd extensions/aiti-proc-tree
npm install
node tools/build-client.mjs
node --test test/core.test.mjs
node tools/deploy.mjs
```

零运行时依赖；纯逻辑在 `core.cjs`（客户端也打包同一份格式化函数）。
