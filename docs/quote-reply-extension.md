# 引用回复能力扩展方案

## 1. 背景与目标

当前"引用回复"（点击段落 → 解析问题选项 + 提取行内文件路径 → 插入 `> 引用` + 预填答案到输入框）**仅对 assistant 消息的文本块**生效。本方案将其扩展到其余消息类型，并同步纳入性能护栏，避免把现有隐患放大成请求风暴。

能力定义（与现状一致）：
- **问题解析**：`parseParagraph()` 切分段落 → `detectOptions()` 生成"是/否"、"A 还是 B"、可做选项等按钮，否则兜底"引用回复"按钮
- **文件能力**：`extractFilePaths()` 提取行内路径 → `/api/files` 校验存在后渲染"打开文件 / 定位目录"按钮
- **插入**：`onPick` → `ChatInput.prependText()`

## 2. 现状机制回顾

```
ChatWindow.handleQuoteReply → MessageView(onQuoteReply)
  └─ 仅 AssistantMessageView → TextBlock → SafeMarkdownBody(onQuoteReply)
       └─ MarkdownBody 将 p/li/tr 包成 QuoteableParagraph（点击惰性解析）
            └─ QuoteReplyPopover：问题按钮 + 文件按钮（useEffect 中逐路径 fetch 校验）
```

### 支持矩阵（现状 → 目标）

| 消息/块 | 现状 | 目标 | 改动量 | 性能风险 |
|---|---|---|---|---|
| assistant 文本段落 | ✅ | — | — | — |
| 用户消息文本 | ❌（markdown 链接打开文件已通） | ✅ | 低（传 prop） | ≈ 0 |
| Custom 扩展消息文本 | ❌（cwd/onOpenFile 已传） | ✅ | 低（传 prop） | ≈ 0 |
| Compaction 摘要 | ❌（连 cwd/onOpenFile 都没传） | ✅ | 低 | ≈ 0 |
| Compaction 文件列表（read/modified） | ❌ 纯 `<li>` | ✅ 点击打开/定位 | 低 | ≈ 0 |
| 工具调用参数 | ❌ | ✅ 路径参数"打开文件"按钮 | 低-中 | ≈ 0 |
| 工具结果 | ❌ `<pre>` 文本 | ✅ 引用 + 文件按钮 | 中 | ⚠️ 高 |
| Bash 执行输出 | ❌ 复用 ToolCallBlock | ✅ 同工具结果 | 中 | ⚠️ 高 |
| Thinking 块 | ❌ | ❌ 保持不可点 | — | — |
| 工具结果独立渲染（role=toolResult） | null（内联展示） | 不单独处理 | — | — |

## 3. 性能影响分析（方案输入）

### 3.1 现状开销剖析

- **挂载期惰性**：`parseParagraph` / `extractFilePaths` 仅在点击后执行；每段落仅约 7 个 hooks；tooltip 跟随鼠标为命令式 style 写入（不触发重渲染）。✅ 开销小
- **`QuoteOpenContext` 单例扩散**：popover 打开/关闭时该消息体的**所有段落重渲染**（O(段落数)，正常无感，超长消息可拆 context 或 memo 值）
- **文件校验无上限（既有隐患）**：`QuoteReplyPopover` 的 useEffect 对每个唯一提取路径发一个 `/api/files` 请求，**无 cap**。服务器侧 `fs.statSync` + mime 识别为亚毫秒级，但请求数 = 路径数，是唯一的实质放大点

### 3.2 扩展增量

- 用户 / Custom / Compaction / 工具参数：增量 ≈ 0（文本短、不流式、路径少）
- 工具结果 / Bash 输出：**唯一实质风险源**
  1. 绕过 `MAX_MARKDOWN_CHARS = 100KB` 保护（走 `<pre>` 不走 markdown 管线）
  2. 几 MB 输出上正则全量扫描 + `matchAll` 构建全部匹配数组 → 内存尖峰、上千条路径
  3. 上千路径 → 上千并发 `/api/files` 请求 → 请求风暴
  4. 上千文件按钮的 DOM 膨胀

### 3.3 数字估算

| 项 | 估算 |
|---|---|
| 单段解析（普通文本，点击时） | < 1ms |
| 单次 `/api/files` meta（服务器） | 亚毫秒 + 本地往返 ~1-5ms |
| popover 打开总增量（正常场景） | < 10ms |
| popover 打开（病态：大输出 + 千条路径） | 数百 ms + 请求风暴 |

## 4. 性能护栏（方案必含项，非可选建议）

护栏统一实现在 `lib/quote-reply.ts` 与 `QuoteReplyPopover`，所有消息类型共用：

1. **解析前截断**：新增 `QUOTE_PARSE_MAX_CHARS = 50_000`，`parseParagraph` / `extractFilePaths` 入口先截断（引用/按钮也基于截断文本）
2. **路径校验上限**：`QUOTE_PATH_CHECK_MAX = 20`，超出部分不发起 `/api/files` 校验、不渲染按钮
3. **校验结果缓存**：按 `(sessionId, messageEntryId)` 缓存已确认存在的路径（模块级 LRU，参考 `thinkingContentCache` 的 `MAX_THINKING_CACHE_ENTRIES = 100` 模式），重复打开不再重新 fetch
4. **解耦策略（仅工具结果/Bash）**：小输出（≤ 50KB）→ 完整引用 + 文件按钮；大输出 → 仅文件按钮 + "引用首 N 行"
5. **保留惰性**：所有解析仍在点击/展开时才发生；工具结果仅在**展开**状态下才附加引用按钮（结果本来就展开才显示，交互面可控）

## 5. 实施方案

### 阶段一：低成本三处（增量 ≈ 0，先落地）

**改动点 1 — 用户消息引用**（`components/MessageView.tsx` `UserMessageView`）
- `SafeMarkdownBody` 传入 `onQuoteReply`（`MessageView` 分发处已持有）
- 说明：用户消息"从这里编辑"已有，引用与其并存；用户粘贴的路径/问题同样受益

**改动点 2 — Custom 消息引用**（`components/MessageView.tsx` `CustomMessageView`）
- `MarkdownBody` 补传 `onQuoteReply`（`cwd`/`onOpenFile` 已传，仅缺此 prop）

**改动点 3 — Compaction 消息**（`components/MessageView.tsx` `CompactionMessageView` + `CompactionFileMetadata`/`CompactionFileList`）
- `MessageView` 分发处向 `CompactionMessageView` 补传 `cwd`/`onOpenFile`/`onRevealDir`（当前只传 message）
- 摘要 `MarkdownBody` 补传 `onQuoteReply`
- `CompactionFileList` 的 `<li>` 改为可点击：文件 → `onOpenFile`；目录 → `onRevealDir`（hover 高亮 + cursor）
- 文件列表路径为相对 cwd 的字符串，渲染前需 `joinFilePath(cwd, path)` 后再走同一存在性校验（或直接复用 `extractFilePaths` 的结果）

### 阶段二：工具调用参数（增量 ≈ 0）

**改动点 4 — 工具参数"打开文件"**（`components/MessageView.tsx` `ToolCallBlock`）
- 在 header 预览区对 `path` / `file_path` / `directory` / `output_path` 等字段追加"打开文件 / 定位目录"按钮
- 不整段可点；参数 JSON `<pre>` 保持原样（避免与展开逻辑纠缠）
- 路径同样经 `/api/files` 校验（走护栏 2/3）

### 阶段三：工具结果 / Bash 输出（高风险，护栏必配）

**改动点 5 — 工具结果引用**（`ToolCallBlock` 的 `PairedResult` / `PairedDiffResult` 区域）
- 在结果 `<pre>` 上方追加动作条（引用 / 打开文件按钮），**仅在展开状态且结果非空时显示**
- 引用文本走护栏 1 的截断；小输出整段，大输出"引用首 N 行"
- diff 结果（`PairedDiffResult`）不附加引用（diff 无引用语义），仅保留文件按钮

**改动点 6 — Bash 输出引用**（`BashExecutionView`，复用 `ToolCallBlock`）
- 改动点 5 自动覆盖；`command` 字段顺带获得"打开文件"（如 `node script.ts` 中的路径可不做，保持只对 path 类字段生效）

### 不做的

- **Thinking 块**：推理内容，引用价值低且可能含噪声路径，保持不可点
- **独立 toolResult 渲染**：已内联在工具调用下，无需单独处理
- **用户/Custom 消息图片**：无引用语义

## 6. 实施顺序与验证

1. 护栏先行（`lib/quote-reply.ts` 截断 + 上限 + 缓存；`QuoteReplyPopover` 接入）→ 回归 assistant 现状不退化
2. 阶段一三处 → 验证用户消息、扩展消息、compaction 摘要可引用/打开文件，compaction 文件列表可点击
3. 阶段二工具参数按钮
4. 阶段三结果引用（重点验证大输出：1MB+ 结果打开 popover 无卡顿、请求数 ≤ 20、无全量正则扫描）

验证清单：
- [ ] 大输出（>100KB，如 HAR/日志）展开结果 → 打开引用动作条：无主线程卡顿（DevTools Performance 无长任务）
- [ ] 大输出路径提取数 ≤ 20，Network 面板请求数 ≤ 20
- [ ] 重复打开同一 popover 不重复发起校验请求（缓存命中）
- [ ] assistant 原有引用行为无回归（问题按钮、兜底引用、文件按钮、流式锁定）
- [ ] `npm run lint` / `tsc --noEmit` 通过

## 7. 风险与回退

- **正则回溯**：`extractFilePaths` 分支多，若截断后仍发现慢路径，可先 `text.slice(0, 50_000)` 再 `matchAll`（护栏 1 已覆盖）
- **缓存陈旧**：路径被删除后缓存仍显示按钮 → 点击打开时后端 404 兜底为 toast/忽略（现有打开逻辑已能容忍失败）
- **`QuoteOpenContext` 扩散**：若超长消息重渲染可感知，将 context 值 memo 化或拆 `openId`/`setOpenId` 两个 context
- **回退**：各阶段独立提交；阶段三可单独通过开关（如仅当结果 ≤ 50KB 时渲染动作条）降级
