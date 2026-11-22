# @aiti-ai/aiti-bridge

> aiti-devtools 独立桥服务 + aiti stdio MCP shim：单端口（默认 `127.0.0.1:8777`）承载页面连接 / SSE / 工具执行 / MCP JSON-RPC，附零依赖 stdio⇄HTTP MCP 转发器（一个环境变量 `AITI_BRIDGE_URL` 接入）。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 组成

| 文件 | 说明 |
|---|---|
| `bin/aiti-bridge.mjs` | 独立桥服务（页面连接/SSE/工具执行/MCP JSON-RPC + 静态资产），默认 `127.0.0.1:8777` |
| `bin/aiti-mcp-shim.cjs` | **stdio ⇄ HTTP MCP 转发器**（零依赖）：读 env `AITI_BRIDGE_URL` 智能协商端点并转发 JSON-RPC；未设 env 降级为 `aiti_shim_status` 自检 |
| `bin/aiti-mcp-register.mjs` | 把 `aiti` shim 条目注册进各 agent 的 MCP 配置（幂等 + env `AITI_SHIM_VERSION` 版本守卫，零顶层私有键） |
| `tests/` | 7 个测试文件（协商/转发/会话/e2e/CLI/载荷/健壮性，57 用例） |

## 使用

### 1) 一次性注册（幂等；条目固定名 `aiti`，URL 不落配置）

```bash
node bin/aiti-mcp-register.mjs                  # auto：只写已存在的配置文件
node bin/aiti-mcp-register.mjs --targets zcode,pi
node bin/aiti-mcp-register.mjs --unregister --targets pi
# 其他旗标：--config-paths p1,p2  --name n  --dry-run  --force  --shim-path p  --version N
```

落盘条目（opencode 形状不同，见文档表格）：

```json
"aiti": { "type": "stdio", "command": "node", "args": ["<绝对路径>/aiti-mcp-shim.cjs"], "env": { "AITI_SHIM_VERSION": "1" } }
```

### 2) 启动 agent 时带环境变量

```bash
AITI_BRIDGE_URL=http://127.0.0.1:8777      zcode    # 独立桥（裸 origin）
AITI_BRIDGE_URL=http://127.0.0.1:8777/aiti claude   # 多写 /aiti 也行
AITI_BRIDGE_URL=http://127.0.0.1:3001/dev pi      # pi-web dev（basePath）
AITI_BRIDGE_URL=http://127.0.0.1:3002      …      # pi-web prod
```

写法自由：裸 origin / 带 basePath / 完整端点 / 少写一个 `/mcp` 全部兼容（逐候选 POST initialize 探测命中即用）。

### 3) 未设环境变量

不挂死——shim 降级为仅 `aiti_shim_status` 自检工具（能看 env 原值、协商端点、探测记录、示例命令），其他调用返回明确错误。

## 环境变量

| 变量 | 消费方 | 说明 |
|---|---|---|
| `AITI_BRIDGE_URL` | shim / pi 插件 / opencode 插件 / openclaw 插件 | 桥地址；设一个变量全家生效 |
| `AITI_SHIM_PATH` | autoRegisterAitiShim | shim 文件位置覆盖 |
| `AITI_BRIDGE_PORT` / `AITI_BRIDGE_HOST` / `AITI_BRIDGE_DATA_DIR` | aiti-bridge 服务 | 服务自身配置 |

## 注册目标

| 目标 | 配置文件 | 容器 | 条目形状 |
|---|---|---|---|
| pi | `~/.pi/agent/mcp.json`（跟随 `PI_CODING_AGENT_DIR`） | `mcpServers` | `{type:"stdio",command,args,env:{AITI_SHIM_VERSION}}` |
| zcode | `~/.zcode/cli/config.json` | 嵌套 `mcp.servers` | 同默认形状 |
| opencode | `~/.config/opencode/opencode.json` | 嵌套 `mcp` | shim：`{type:"local",command:["node",shim],enabled,environment:{AITI_SHIM_VERSION}}`；http：`{type:"remote",url,enabled}`（schema 严格拒未知键） |
| claude | `~/.claude.json` + 项目 `.mcp.json` | `mcpServers` | 默认形状 |
| cursor / windsurf | 各自配置 | `mcpServers` | 默认形状 |
| vscode | 项目 `.vscode/mcp.json` | `servers` | 默认形状 |
| zed | `~/.config/zed/settings.json` + 项目 `.zed/` | `mcp` | 默认形状（JSONC 兼容；⚠ 回写会剥注释） |

版本守卫走条目 env map（零顶层私有键）：条目 `env.AITI_SHIM_VERSION` >= shim 文件头 `SHIM_VERSION` 且 shim 路径未变 → 配置零改写；升级 shim 改其 `SHIM_VERSION` 后重跑注册即可。旧顶层版本键条目注册时自动迁移剥除。

## 测试

```bash
node --test tests/shim.test.mjs           # 端点协商
node --test tests/shim-forward.test.mjs   # 转发专项（mock 桥）
node --test tests/shim-session.test.mjs   # 会话生命周期
node --test tests/shim-payload.test.mjs   # 载荷并发
node --test tests/robustness.test.mjs     # 健壮性
node --test tests/register-cli.test.mjs   # 注册 CLI
node --test tests/shim-e2e.test.mjs       # e2e（需真实桥 8777 / pi-web 3001·3002）
```

## 安装

```bash
npm install -D @aiti-ai/aiti-bridge
node bin/aiti-bridge.mjs        # 127.0.0.1:8777
```

## 文档

- 中文文档: <https://aiti.pw/products/aiti-bridge.html>
- Documentation (English): <https://aiti.pw/en/products/aiti-bridge.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
