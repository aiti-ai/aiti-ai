# pi-plan-sandbox — Plan-Sandbox 模式

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

**English**: pi CLI extension: plan-sandbox mode — all tools allowed but execution happens in a disposable snapshot; declare_deliverables hard-protocol acceptance, everything else destroyed. Linux (overlayfs) / macOS (clonefile+seatbelt) / Windows (robocopy).

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>


全工具放行 + 执行发生在可丢弃快照 + declare_deliverables 硬协议采认 + 其余销毁。
平台：Linux(overlayfs, 已验证) / macOS(clonefile+seatbelt) / Windows(robocopy)。

## 出口协议（模型侧，共三个）

| 工具 | 语义 | 行为 |
|---|---|---|
| `declare_deliverables` | 成功收尾 | files=要采认的文件（无文件任务传 `[]`）；落契约等待采认/apply |
| `plan_abort(reason)` | 失败中止 | 销毁沙箱（未采认内容全部丢弃），回到正常模式，如实报告原因 |
| （用户）`/plan discard` | 用户放弃 | 同 abort，用户主动触发 |

**不要用 bash/echo 尝试退出模式**——出口只有 declare（成功）与 plan_abort（失败）两个。

## 斜杠命令

```
/plan <提示词>        直接进入规划：自动开沙箱，提示词转发模型（流式中 steer）
/plan start [提示词]  开启沙箱（可带提示词）
/plan status          当前状态（含磁盘认领的活跃沙箱）
/plan execute         采认全部增量并退出（未声明时交互确认）
/plan accept          采认已声明交付物
/plan discard|off     丢弃沙箱
/plan exit|pause      挂起保留（跨会话 /plan review 收尾）
/plan review          点选采认（声明 vs 其他逐个确认）
/plan cleanup         清理 >24h 残留沙箱
```

## 循环护栏

bash/sandbox_bash 连续 ≥3 次无操作命令（`true` / `:` / 纯 `echo`，不含 shell
操作符）时，工具结果注入出口提示（declare files=[] / plan_abort）；正常命令
重置计数；仅 plan 激活态注入。起因：session eccffb90（2026-08-30）弱模型在
plan 态退化成 echo 占位循环 4 小时无错误信号。

## pi-web 会话注意

- pi-web 下本扩展命令面每次 factory 都注册（globalThis 守卫只护工具注册，
  防 dec439e 的 Tool conflicts）；工具被 web 注入版（aiti-plan-review
  agentTools，customTools 后置覆盖）接管，二者共用同一套 ops
- 命令/钩子一律以运行时 ctx.cwd（会话目录）为准，不用 process.cwd()
- 磁盘认领：沙箱由谁启动不重要（web 工具 / UI /start / CLI 均落 meta.json），
  按 projectDir 匹配认领，消除双脑状态

## 部署

```bash
mkdir -p ~/.pi/agent/extensions && ln -sfn $PWD ~/.pi/agent/extensions/plan-sandbox
```

测试：`node test/e2e-*.ts`（README 列表见上，Linux 需 overlay 权限）。

## 相关 · Related

- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>
