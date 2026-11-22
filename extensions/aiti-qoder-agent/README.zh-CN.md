# @aiti-ai/aiti-qoder-agent

> Qoder CLI 专属会话后端（qodercli/qoderclicn）：credits/配额（getUsage）、WASM 签名模型目录（listModels）、任务计划镜像、运行排队管理、plan/权限模式支持。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 功能定位

Qoder CLI 专属会话后端（多 agent 前端 / All Sessions 接入）。qodercli/qoderclicn 是 claude-code 协议族成员，驱动层与 aiti-claude-code-agent 同构；本扩展**独占** qoder 两个成员（CC 族清单已摘除），在其之上增加：

| 能力 | 说明 |
|---|---|
| `getUsage` | 账号 credits/配额——`{openapi}/api/v2/quota/usage`（Bearer dt-token） |
| `listModels` | 模型目录——infer 网关 `/api/v2/model/list?Encode=1`（WASM 签名请求） |
| `taskList` | TodoWrite 工作计划只读镜像（共享层 `@aiti-ai/ext-shared/task-list` 从工具事件派生；冷会话读磁盘快照） |
| `queueManage` | 运行中排队（`@aiti-ai/ext-shared/backend-queue` 文件 sidecar + settle 后自动续轮） |
| `respondInteraction` | `control_request/can_use_tool` 交互链（共享层账本）：按工具名派生 kind → 授权卡 / AskUser 卡 / 方案审批卡，应答回 `control_response`；未决项落 sidecar 并经 `subscribe` 时定向补发（重建/刷新不丢卡） |
| plan 模式 | `setPermissionMode("plan")` 走 `control_request/set_permission_mode`；进/出 plan 由 CLI `system/plan_mode_changed` 帧回报，`getPermissionMode()` 据此返回 `"plan"`。bypass 只放行工具授权，plan/AskUser/ExitPlanMode 仍会问 |
| `getAllTools` / `getCommands` / `getPermissionMode` | 能力面快照——CC 族 `system/init` 帧免费携带 |
| 扩展 API | `GET /api/extensions/aiti-qoder-agent/{usage,models}`（无需开会话） |

## 双区域

| variant | CLI | infer 网关 | openapi |
|---|---|---|---|
| `qoder`（intl） | `qodercli` | api2-v2.qoder.sh | openapi.qoder.sh |
| `qoder-cn` | `qoderclicn` | gateway.qoder.com.cn | openapi.qoder.com.cn |

按 PATH 上存在的二进制自动注册；区域凭据自动探测（cn 优先）。

CLI 二进制解析：env 覆盖（`QODER_CLI_PATH`/`QODER_CLI_CN_PATH`）> PATH > 安装位兜底 `~/.qoder{,-cn}/bin/<cli>/<cli>.exe`。

## 认证

- 凭据在 `~/.qoder{,-cn}/.auth/user`（WASM 加密）；`assets/qoder_auth.wasm` + `qoder_glue.js`（从 qoderclicn 二进制提取）运行时解密出 dt-token 与签名材料。
- 会话推理走 CLI 子进程（stream-json），认证由 CLI 自理；credits/目录走直连 REST。

## 已知边界

- qodercli **不支持 `--verbose`**（claude CLI 专属，传了 exit 1）
- headless 会话的活跃工具表（init 帧 33 项）**不含 `AskUserQuestion`**——模型侧调不到它；`EnterPlanMode`/`ExitPlanMode` 在内且必发 `can_use_tool`
- result 帧自带本轮 `total_credits`，已并入 agent_settled 事件的 usage

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-qoder-agent/` 后 reload。需本机装有 `qodercli` / `qoderclicn` CLI 并已登录。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-qoder-agent.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-qoder-agent.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
