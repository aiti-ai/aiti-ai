# 设计文档：聊天渲染性能优化（流式 / 会话加载 / 历史分页）

> 状态：已实施（commits `de8c80f`、`b42d2b5`、`a6fbd38`）
> 仓库：`pi-web`（pi 的 Web UI，Next.js 16 + React 19）
> 目标：优化「输入 → 会话刷新（流式输出）」与「历史会话加载」过程中的前端主线程尖峰 / CPU 占用，不牺牲流式视觉平滑度。

---

## 1. 背景与测量基线

chrome-devtools Performance trace（390–500px 窄屏，CPU 1x）归一化指标：

| 阶段 | 优化前 | 优化后 | 主要手段 |
|---|---|---|---|
| 空闲期 React scheduler | 40ms/s（含 15s 周期 280–300ms 尖峰 ×9） | **1–2ms/s**（尖峰消失） | ai-usage 轮询下沉 |
| 流式活跃段 scheduler | 682ms/s（峰值 3s 窗口 3.0s） | **292–417ms/s** | 轻量渲染 + 节流 |
| 全流程均值（发送+流式+空闲） | 119.6ms/s | **61.8ms/s（-48%）** | 上两者 + delta 节流 |
| INP | 546/623ms | **3ms** | 消息 memo 化 |
| 历史会话加载最大长任务 | 1467–1712ms（50 条全量挂载） | 同量级（30 条，-40% DOM） | 分页量下调 |

---

## 2. 设计变更清单

### 2.1 流式期间轻量渲染（最大单项收益）

**变更**：流式消息不再用完整 `MessageView → MarkdownBody`（react-markdown v9 `Markdown` 无内部缓存，几千行增量文本每次解析 100ms+），改为 `StreamingText`：单一 `<div>` 节点 + `white-space: pre-wrap` 纯文本，随增量只 diff 文本节点（~1ms/次）。消息结束（`streamingMessage` 置空）后，该消息以完整 `MessageView` 渲染富文本。

**设计要点**：
- 流式期间用户看到纯文本（无加粗/代码高亮），结束后一次性变富文本——聊天类产品通行做法，流式期零解析成本；
- 纯文本路径按 `\n` 天然换行，代码缩进经 pre-wrap 保留，视觉可读；
- `StreamingMessageView` 保留 200ms 渲染节流（`lib/streaming-message.ts` 每 delta `{...message, content}` 新对象会破 memo，节流窗口内复用旧引用）。

**位置**：`components/ChatWindow.tsx`（`StreamingMessageView` / `StreamingText`）。

### 2.2 数据层 delta flush 节流（60fps → 20fps）

**变更**：`useAgentSession` 的 `enqueueDelta` 由「每帧 rAF flush」改为「间隔 ≥50ms 才 flush」：
- rAF 每帧触发，但 `now - lastFlushTs < 50ms` 时推迟到下一帧再试（保序）；
- 队列积压 ≥100 条（`DELTA_BATCH_MAX × 2`）强制 flush，避免后台长流式滞留；
- 边界事件（snapshot/start/end）仍同步 flush 保序。

**设计权衡**：文本流 20fps 已足够平滑（人眼对文字增量感知上限远低于此），React 渲染次数降 2/3。实测在繁忙帧率下收益有限（rAF 本就稀疏），但对后台标签长流式与快速输出场景有稳定收益。

**位置**：`hooks/useAgentSession.ts`。

### 2.3 ai-usage 轮询下沉（消灭 15s 全树重渲染）

**变更**：`AppShell` 的 ai-usage 15s `setInterval` 轮询（`setAiUsage` 新对象 → 全树重渲染）移除，下沉到独立组件 `AiUsageRows`：
- 组件自持 state + 15s 轮询；
- 仅在「会话统计面板」打开（`activeTopPanel === "session"`）时挂载，关闭即卸载、轮询停止。

**效果**：空闲期 scheduler 40→1.4ms/s，15s 周期 280–300ms 尖峰彻底消失（对照组：临时禁用 aiti-inject 后尖峰仍在，确认根因为自家轮询而非注入 iframe）。

**位置**：`components/AiUsageRows.tsx`（新增）、`components/AppShell.tsx`。

### 2.4 历史消息分页量 50 → 30 条

**变更**：`VISIBLE_PAGE_SIZE` 50 → 30（`lib/chat-lazy-load.ts`）。滚动到顶部经 IntersectionObserver 分批 +30 加载更早历史，滚动位置用「距顶距离」保持稳定。

**设计依据（调研）**：主流聊天 UI 不是「一次 N 条」，而是**虚拟化 + overscan**——DOM 常驻量 = 视口可见 ×2–3（react-window / TanStack Virtual / Claude 均此；Steve Kinney：viewport 10 rows → render 15–20）。窄屏视口约 6–10 条消息，30 条 ≈ 3–4 屏含缓冲；50 条 = 视口 5–8 倍，多渲染 1 倍 DOM。ChatGPT 全量 DOM 是反例（官方社区公开抱怨长会话打字卡顿）。

**位置**：`lib/chat-lazy-load.ts`。

### 2.5 消息列表 key 稳定化（防分页重挂载）

**变更**：`messageListEl` 中消息 key 由 `idx`（消息索引）改为 `entryId`：
- 分页 prepend（visibleCount 窗口扩大）时，已渲染消息的绝对 idx 不变，但外层容器 key 此前用 idx——实测每次 `setVisibleCount` 触发全量重挂载（30 条窗口 MessageView 渲染 1228 次、memo 比较器仅 307 次）；
- `entryIds` 与 `messages` 同序对齐（`buildSessionContext` 同序 push，探针实测 702/702 全覆盖），key 稳定；
- 配合 `MessageView` 自定义 memo 比较器（忽略 `writtenFiles`），已渲染消息在分页时零重挂。

**验证与取舍**：曾试「setTimeout/startTransition 渐进分片渲染」——实测每次 `setVisibleCount` 都触发加载期全量重渲染，分片 3 批反而多次全量（总 2.4s > 一次性 1.5s），已回退为一次性渲染满页。**根治方案**（未做，见 §4）：消息列表虚拟化。

**位置**：`components/ChatWindow.tsx`。

### 2.6 渲染层节流与 memo（de8c80f 已含）

- `MarkdownBody` 200ms 解析节流（`renderText` + `lastParseTs`）+ `memo` 包裹 `ReactMarkdown`；
- `ChatWindow` 消息分组渲染提取为 `messageListEl useMemo`（流式期间 `messages` 引用稳定 → 零重算）；
- `MessageView` memo（含 `haveSameRelevantToolResults` 相关结果比较）。

### 2.7 ExtSlots 主题条目注册机制（a6fbd38）

扩展间间接耦合中转：`registerTopicItem<T>(topic, item)` 发布条目到抽象主题（如 aiti-msg-smart 的 `msg-popover-action`），`getTopicItems<T>(topic)` 消费方在交互时刻同步读取。core 只做 `Map<topic, Set<item>>` 中转、不解释内容；条目持久，无加载时序问题。**位置**：`components/ExtSlots.tsx`。

---

## 3. 数据对比汇总

| Trace | 场景 | React scheduler | 备注 |
|---|---|---|---|
| trace1 | 优化前 64s | 75ms/s | INP 546/623ms，13 次 50–330ms 尖峰 |
| trace3 | 用户优化后 + 注入 145s | 40ms/s | INP 3ms，15s 尖峰 283–304ms ×9 |
| trace5 | +AiUsageRows idle 68s | **1.4ms/s** | 15s 尖峰消失，长任务仅 1 次 |
| trace9 | +分组 useMemo 56s | 86ms/s | 流式 1200 字 |
| trace-final2 | 全量优化（无轻量渲染）78s | 119.6ms/s | 流式峰值 682ms/s |
| trace-final5 | +流式轻量渲染 117s | **62.5ms/s** | 峰值 292–417ms/s |
| trace-final6 | +delta 节流 97s | **61.8ms/s** | 空闲段 1–2ms/s |

---

## 4. 遗留与后续建议

1. **消息列表虚拟化**（根治历史加载 1.5s 长任务）：只渲染视口 ±2 屏（~12 条常驻），滚动替换；预计长任务 1.5s → ~300ms。动态高度消息需估高/锚点处理，改动较大。
2. **发送/结束一次性提交**（600ms 级）：`scrollToBottom` 同步强制回流（`useLayoutEffect [messages.length]`）可改异步/节流；一次性渲染本身不可消除。
3. **launcher AI 窗 iframe**：0×0 隐藏 iframe 仍全量运行 prod 应用（87 次 running 轮询/145s + 15s 重渲染），属 launcher 架构层面，不影响本仓库。
