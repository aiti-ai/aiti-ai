# @aiti-ai/aiti-bridge

aiti-devtools 独立桥服务 + aiti stdio MCP shim（统一 `AITI_BRIDGE_URL` 环境变量接入）。

> 方案详解：`docs/aiti-mcp-shim-stdio-env-url-plan.md` ｜ 测试报告：`docs/aiti-mcp-shim-test-report.md` ｜ 执行全程：`docs/aiti-mcp-shim-execution-record.md`

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

落盘条目（opencode 形状不同，见下表）：

```json
"aiti": { "type": "stdio", "command": "node", "args": ["<绝对路径>/aiti-mcp-shim.cjs"], "env": { "AITI_SHIM_VERSION": "1" } }
```

### 2) 启动 agent 时带环境变量

```bash
AITI_BRIDGE_URL=http://127.0.0.1:8777      zcode    # 独立桥（裸 origin）
AITI_BRIDGE_URL=http://127.0.0.1:8777/aiti claude   # 多写 /aiti 也行
AITI_BRIDGE_URL=http://127.0.0.1:3001/dev pi      # pi-web dev（basePath）
AITI_BRIDGE_URL=http://127.0.0.1:3001      …      # 裸 origin 自动探测 /dev /win /mac /wdev /mdev 变体
AITI_BRIDGE_URL=http://127.0.0.1:3002      …      # pi-web prod
```

写法完全自由：裸 origin / 带 basePath / 完整端点 / 少写一个 `/mcp` 全部兼容（逐候选 POST initialize 探测命中即用）。

### 3) 未设环境变量

不挂死——shim 降级为仅 `aiti_shim_status` 自检工具（能看 env 原值、协商端点、探测记录、示例命令），其他调用返回明确错误。

## 环境变量

| 变量 | 消费方 | 说明 |
|---|---|---|
| `AITI_BRIDGE_URL` | shim / pi 插件 / opencode 插件 / openclaw 插件 | 桥地址；设一个变量全家生效 |
| `AITI_SHIM_PATH` | autoRegisterAitiShim | shim 文件位置覆盖（默认按候选链解析仓库路径） |
| `AITI_BRIDGE_PORT` / `AITI_BRIDGE_HOST` / `AITI_BRIDGE_DATA_DIR` | aiti-bridge 服务 | 服务自身配置 |

## 注册目标与条目形状

| 目标 | 配置文件 | 容器 | 条目形状 |
|---|---|---|---|
| pi | `~/.pi/agent/mcp.json`（`getAgentDir()`，跟随 `PI_CODING_AGENT_DIR`） | `mcpServers` | `{type:"stdio",command,args,env:{AITI_SHIM_VERSION}}` |
| **zcode** | `~/.zcode/cli/config.json` | 嵌套 `mcp.servers` | 同上 |
| **opencode** | `~/.config/opencode/opencode.json` | 嵌套 `mcp` | shim：**`{type:"local",command:["node",shim],enabled,environment:{AITI_SHIM_VERSION}}`**；http：**`{type:"remote",url,enabled}`**（schema 严格拒未知键与 http 类型；env map 字段名 = `environment`） |
| claude | `~/.claude.json` + 项目 `.mcp.json` | `mcpServers` | 默认形状 |
| cursor / windsurf | 各自配置 | `mcpServers` | 默认形状 |
| vscode | 项目 `.vscode/mcp.json` | `servers` | 默认形状 |
| zed | `~/.config/zed/settings.json` + 项目 `.zed/` | `mcp` | 默认形状（JSONC 兼容；⚠ 回写会剥注释） |

版本守卫走条目 env map（零顶层私有键——zcode/opencode 严格 schema 实证拒收未知顶层键，2026-09-16 从 `_aitiShimVersion` 迁移）：条目 `env.AITI_SHIM_VERSION >= shim 文件头 SHIM_VERSION` 且 shim 路径未变 → 配置零改写；升级 shim 改其 `SHIM_VERSION` 后重跑注册即可。旧顶层版本键条目注册时自动迁移剥除。

## 新增一个宿主目标的步骤（SOP）

1. 在 core `MCP_TARGETS` 加条目：`path()` + `key`/`keyPath`（容器位置）+ 必要时 `shimEntry()`（条目形状）+ 异构 env map 字段名时 `envKey`；
2. 先用真实宿主验证 schema：手写一个条目 → 跑宿主的配置校验（如 opencode 改完跑 `opencode models`）→ 确认形状被接受；
3. 在 `core/src/unify-agents.test.mjs`（或新文件）加形状用例 + 幂等用例；
4. 宿主有插件/扩展的：在启动钩子调 `autoRegisterAitiShim({ targets: ["<name>"], configPaths? })`（打包的 core 为旧版时用内联实现）；
5. 更新接入指南 §4.1 表格 + 本 README 表格。

## 测试

```bash
node --test tests/shim.test.mjs           # 端点协商 10
node --test tests/shim-forward.test.mjs   # 转发专项 10（mock 桥）
node --test tests/shim-session.test.mjs   # 会话生命周期 2
node --test tests/shim-payload.test.mjs   # 载荷并发 4
node --test tests/robustness.test.mjs     # 健壮性 4
node --test tests/register-cli.test.mjs   # 注册 CLI 11
node --test tests/shim-e2e.test.mjs       # e2e 12（需真实桥 8777 / pi-web 3001·3002）
```
