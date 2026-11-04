# dsh-web-ext

> DSH（DeepSeek Harness）扩展作用域目录（npm scope `@dsh-web-ext/*`）。承载 aiti-devtools → DSH 移植的
> 宿主 adapter 与方案。**方案**：见 [`PLAN.md`](./PLAN.md)。

## 结构

```
dsh-web-ext/
├── PLAN.md                    # aiti-devtools → DSH 移植方案（先读）
├── README.md                  # 本文件
└── aiti-devtools-dsh/         # ★@aiti-ai/aiti-devtools-dsh —— DSH 宿主 adapter 包（已落地）
    ├── src/index.ts           # host bundle：DSH Cordis 插件入口 apply（桥+工具+agent/pre-step）
    ├── src/client/index.ts    # client plugin：浏览器面（候选条/详情弹窗/发送清理）
    ├── tools/build.mjs        # esbuild → lib/index.js（host）+ lib/client.js（client）
    └── README.md              # 包内文档
```

## 这是什么

把 `aiti-devtools`（页面内 AI 调试助手）的主要功能移植到 DSH：

- **同样的集成 JS launcher**（`packages/aiti-devtools-inject` 产物，复用不改）
- **AI 窗 = DSH**：`aiUrl` 指向 `https://dsh.pi.example.com:8443`
- **agent 用同样的 `aiti_*` 命令**（16 个工具经 `@dsh-web-ext/aiti-devtools-dsh` 注册进 DSH agent 会话）
- **与 pi-web 集成同等体验**

## 复用关系

- 复用 `packages/aiti-devtools-agent`（AgentBridgeClient + AgentHost + mapBridgeTools）、`packages/aiti-bridge`、`packages/aiti-devtools-core/assets`、`packages/aiti-devtools-inject`。
- **DSH 侧代码集中在本目录的包内**（不在仓库 `packages/`）。

## 状态

- 方案 `PLAN.md`：**17 节完整文档**（机制 §15、与 pi-web 对应 §16、完成情况+待办 §17）。
- `@aiti-ai/aiti-devtools-dsh`（**0.6.6**，npm.example.com）：host bundle + client plugin 已发布并部署到 DSH web profile。
  - host：进程内桥挂 `/aiti`（launcher/cockpit/bridge/mcp 同端口）+ 16 个 aiti_* 工具 + `/aiti/picked` 候选上报端点 + `agent/pre-step` 占位符替换。
  - client：`conversation.input.overlay` slot 候选条（两区 chip：tag+描述+✕+清空）+ 详情弹窗 DetailDialog + 点选元素→composer 插占位符 + 发送后自动清理（useSession snapshot 数据流）。
- **端到端已验证**（Chrome DevTools 真实点击，0.6.6）：Inspector→点元素→HUD→候选条两区 chip→点描述区开详情→✕ 清除→发送按钮→候选条自动清空→会话消息 = 完整描述+`[发自: pageId]`。详见 PLAN.md §17.1/§17.3。

## 关键结论

> DSH `llm/stream` waterfall 的 `GenerateOptions.messages` 是 **deep-frozen**（官方不可变设计），插件无法在那里改写消息。
> **真正正规的消息预处理插入点是 `agent/pre-step`**（agent-loop waterfall，plan-mode 同款）：listener 返回
> `{...decision, messages: 替换后消息}` 即替换进入该步骤的消息；且替换后的消息就是写入 session 历史的
> （agent.ts:282-284），所以**历史与模型看到的都是展开文本**，与 pi-web 原版行为一致。
>
> 实现 = **占位符方案**：client 点击候选插入短占位符 `[元素N]` + POST `/aiti/picked` 上报候选数据；
> host 在 `agent/pre-step` 里把占位符替换成完整 describe + `[发自: pid · url（aiti-*：pageId 参数用它）]`。
> 零 DOM 事件 hook、零发送钩子，Enter/按钮/API 全通。
>
> **发送后清理走桥自己的消息流**（不走 DSH 前端框架 API）：host 替换成功 → `bridge.pushAiEvent('aiti_consumed', {tags})`
> （core 0.2.0 新增公开方法，aiConns SSE 直推）→ AI 窗 `onEvent('aiti_consumed')` → 清候选。权威信号 +
> 携带被消费占位符；上报竞态由 pre-step 内轮询等待兜底（≤800ms）。
>
> **前端坑**：① slot 的 `useSession` 是 `SnapshotSelectorHook`——**必须传 selector**（`useSession((s)=>s)`），
> 无参调用会 `TypeError: l is not a function` 导致 slot 崩溃（`data-slot-error` 遮罩）；
> ② `conversation.input.overlay` 的 overlayAnchor 是 **height:0 空锚点**——slot 条目必须自行
> `position:absolute; bottom:100%` 上浮，否则流式布局会被 textarea 热区覆盖（真实点击落到输入框）。
