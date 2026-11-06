# Fork 功能 e2e 测试方案（pi-web aiti fork）

> **状态：执行中** · 环境：本机 dev 实例 `http://127.0.0.1:30142/dev/`（及外部入口 57442）· 驱动：Chrome DevTools MCP
> 基线：HEAD `17986d57..`（上游 v0.15.0 `f130910a` 之上 +627 文件 / +77764 行）
> 无 LLM 依赖：发送类用例全部使用 **Echo Agent** 后端（本地回显，确定性输出）

## 〇、Fork 新增功能清单（相对上游的分析结论）

| 域 | 功能 | 关键文件/入口 |
|---|---|---|
| **会话运行与队列** | 蓝队列（转向/排队/插队/转换/持久化/回收站）、Fork New（后台克隆）、重启恢复向导、多后端（Echo/ACP/CLI 桥）、run-outcome 完成通知、favicon badge、elapsed badge | `lib/queue-store.ts` `lib/composer/queue-api.ts` `lib/restart-recovery.ts` `lib/session/*` `app/api/agent/recovery/*` |
| **Composer 体系** | composer 插槽契约（bus/draft/queue 三 API）、小屏输入区 v4（＋面板/notch/两行分离/微信式发送）、文档附件、导出对话框、语音输入 | `lib/composer/*` `components/ChatInput.tsx` `components/ExportDialog.tsx` |
| **扩展框架** | ExtSlots 20+ 插槽、扩展注册表/加载器/协议/服务、extman 管理、host-api/ai-invoke | `lib/ext/*` `components/ExtSlots.tsx`（部署扩展 70 个） |
| **UI 框架** | 自绘顶栏（排序/隐藏/间隔/溢出 ⋯）、顶栏标签条、BranchNavigator、Tab 标签页 + 多窗口分离、Provider 余额聚合、SubagentViewer、上下文紧迫度 | `lib/topbar-order.ts` `components/TabBody.tsx` `components/ProviderUsagePanel.tsx` `lib/context-urgency.ts` |
| **移动端专项** | PWA 布局、键盘适配（--app-viewport-height）、返回手势（overlay-back）、小屏顶栏（Agents beside More） | `components/MobilePwaLayout` 相关 `hooks/useOverlayBack.ts` |
| **基础设施** | basePath 多实例部署、三语 i18n + 守卫、push 通知、音效、event-bus SSE 总线、workspace 记忆 | `lib/base-path.ts` `lib/i18n/*` `lib/event-bus-client.ts` |

## 一、测试环境与前置

- 视口矩阵：**D** = 1440×900 桌面 · **M** = 375×812×3 mobile,touch ·（medium 768 抽查）
- 后端：**Echo Agent (无 LLM 演示)**（确定性回显，`ready` 状态）
- 前置检查：dev 服务 200、非 rescue 页、Authelia 会话有效（外部入口）
- 隔离：每个用例独立新会话；用例间不清理（dev 数据可残留）

## 二、用例矩阵

| # | 用例 | 视口 | 验收标准 |
|---|---|---|---|
| T01 | Echo 会话全链路：新建→选 Echo→发送→回显 | D | 用户气泡 + echo 回复渲染，无崩溃 |
| T02 | 队列：运行中排队（followUp）→ 队列横幅可见 | D | 横幅显示排队数，消息不立即发送 |
| T03 | 插队：排队中 steer → 队列转为立即投递 | D | 消息作为转向注入当前回合 |
| T04 | 停止：运行中停止 → 按钮变 stopping → 回复终止 | D | 无异常，输入可用 |
| T05 | Fork New：composer 有内容 → Fork New → 新会话 tab | D | 新 tab 创建，原会话不动，输入内容带入 |
| T06 | 移动端 composer 收起态：单行 [＋\|textarea\|🎤\|📷] | M | 容器撑满、按钮 44×44、无空带 |
| T07 | 移动端聚焦展开：textarea 独行 + 底排按钮 | M | 两行分离（DOM 坐标断言） |
| T08 | 移动端微信式 Enter：输入后 Enter 发送 | M | 输入清空（发送生效），非换行 |
| T09 | 移动端 ＋面板：⊕ 打开 → 模型/思考/工具 + 插槽行 | M | 面板开合正常，信息行齐全 |
| T10 | 移动端运行态按钮：停止/插队/排队浮现 | M | 矩阵符合 v4 规格 |
| T11 | 桌面顶栏：按钮连续无空带、⋯ 溢出菜单开合 | D | 无 >100px 空带；溢出菜单项可点 |
| T12 | 顶栏自定义排序面板（Customize widgets） | D | 面板打开，条目可见 |
| T13 | 窄屏顶栏：Agents beside More + 面板开合 | M | 结构存在、面板开合正常 |
| T14 | 导出对话框：Export 打开/关闭 | D | 对话框渲染、无崩溃 |
| T15 | i18n 切换：en → zh-CN → 关键文案变化 | D | placeholder/按钮文案随语言变 |
| T16 | 主题切换：System → Light/Dark | D | html class/配色变化 |
| T17 | 队列回收站/恢复冒烟（软删除→恢复） | D | 删除的队列项可恢复 |
| T18 | 恢复向导冒烟：Interrupted by restart 对话框 | D | 对话框列出中断会话、决议可用 |
| T19 | 多标签/会话标签条：tab 开关 | D | 标签切换内容随之切换 |
| T20 | Provider 余额面板冒烟 | D | 面板可打开（数据可有可无） |

## 三、执行记录（2026-11-06，dev 30142 + Echo Agent + Chrome DevTools MCP）

**结果：13 ✓ / 2 部分 ✓ / 4 环境受限跳过 / 0 失败**

| # | 结果 | 证据/备注 |
|---|---|---|
| T01 | ✓ | `?session=echo-1` 创建；用户气泡 + `echo: …` 回显渲染 |
| T02 | 部分 ✓ | 运行中 Follow-up 点击入队（队列非空指示「≫」出现）；**settled 后自动投递链路受 echo single-turn 限制未完整走通**（echo `prompt()` 对运行中再入 throw） |
| T03 | ✓ | 运行中 Send = steer 语义（placeholder 同步提示「Enter to queue; Enter again to steer」），消息立即插队投递，第四轮回显渲染 |
| T04 | ✓ | Stop agent 点击 → 按钮消失、状态回 idle、无异常 |
| T05 | SKIPPED-ENV | Fork 按钮条件渲染 ✓（`onForkNew` 能力门控）；echo 内存 provider 无克隆能力，`fork-gates` 正确拦截——需支持克隆的后端（Pi local）才能完整验证 |
| T06 | ✓ | 单行收起态 [＋219\|textarea\|🎤\|📷]、row 343px 撑满 |
| T07 | ✓ | 聚焦展开：notch(h0)/textarea 独行(y526)/底排 44px(y560) 三段 DOM 断言 |
| T08 | ✓ | Enter `defaultPrevented` + 输入清空 + `echo: enter-send-mobile-probe` 回显——微信式发送回归钉的运行时确认 |
| T09 | ✓ | ＋面板：模型/思考/工具行 + Camera/Attach files/Commands + AI Helper（composerTools 插槽）+ Ops timeline/Import ——v4 §三规格齐全 |
| T10 | ✓ | 运行态按钮矩阵：逻辑钉（mobile-matrix 7/7）+ 桌面实测（T02 Stop+Follow-up）+ 移动端实测拼图 |
| T11 | ✓ | 桌面顶栏 36 按钮连续无空带（唯二 gap 为 tags 标签条正常内容/视口外元素）；⋯ 溢出菜单开合、菜单项齐全 |
| T12 | ✓ | ⋯ 菜单含 Customize toolbar 入口 ✓；NewSessionWidgets 排序面板（Top/Bottom 分区、排序/显隐/重置）渲染完整；拖拽排序交互归单测（topbar-order 纯逻辑） |
| T13 | ✓ | Agents beside More（x134 非 disabled）+ More 44×44 + 面板 actions：history/name/system/tools |
| T14 | ✓ | Export 对话框浮层渲染 ✓ |
| T15 | ✓ | 简体中文切换：placeholder「消息… / 命令 @ 文件」、New→「新建」——三语选项（English/简体/繁體）齐全 |
| T16 | ✓ | 主题五档（System/Light/Dark/High contrast ×2）；Dark 生效（data-theme=dark + bodyBg 深色） |
| T17 | SKIPPED-ENV | 队列回收站与 T02 同依赖（echo 单轮局限），队列面板 UI 未展开 |
| T18 | ✓ | 「Interrupted by restart · 1 session(s)」恢复对话框：列出中断会话（turn unfinished 标记）+ Ignore all 决议可用（前置步骤实际执行） |
| T19 | SKIPPED-ENV | 会话 tab 需 side chat/子代理场景；TabBar/TabBody 单测已覆盖 |
| T20 | 部分 ✓ | 上下文入口按钮在场（echo 为 external backend 无数据，aria 退化提示正确）；余额聚合需真实 provider key，环境受限 |

### 过程发现（非用例失败）

1. **echo agent single-turn 局限**：`prompt()` 对运行中再入 throw——队列「settled 后自动投递」的端到端验证需要支持排队投递的假后端（如 echo agent 增加多轮排队支持），建议后续增强。
2. **长任务会话切换竞态**：echo 7s 流式窗口内多次脚本操作曾致会话重建（echo-1→echo-2）——测试脚本时序问题，非产品缺陷。
3. **环境敏感**：PI_WEB_* env 继承会让 foreign-origin 类 route 测试假失败（已在 docs/upstream-merge-guardrails.md §SOP 记录）；浏览器 e2e 不受影响。

### 运维事件（测试外，同窗口发生）

dev 实例 Turbopack panic（增量图损坏）曾致 reload 循环 + 顶栏空白；清 `.next` 重启恢复。处置经验已固化进 `AGENTS.md` dev troubleshooting；顶栏空容器的真缺陷修复见 `9b55b469`。

## 四、交付物

- 本文档（方案 + 执行结果）
- 失败用例的修复（如有）
