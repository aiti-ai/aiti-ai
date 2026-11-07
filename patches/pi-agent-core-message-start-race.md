# pi-agent-core message_start 序列化竞态热修（2026-09-07）

## 现象

thinking 流式输出期间开头内容重复（常表现为"重复第一个字母/词"），
`thinking_end`/`text_end` 全量覆盖后恢复正常；刷新后正常。

## 根因

`@earendil-works/pi-agent-core` 的 agent-loop：

```js
case "start":
  partialMessage = event.partial;               // = pi-ai 的 live output 对象
  await emit({ type: "message_start", message: { ...partialMessage } });  // 浅拷贝！
```

`EventStream.push` 不同步唤醒消费者（agent-loop 走 microtask），而 pi-ai 的
生产者 IIFE 在 `push(start)` 后**同步继续处理已到达的网络 chunk**（
`block.thinking += delta` 直接 mutate output）。当 start 与首 chunk 在同一
TCP 包内到达（流式网关快回时高频发生），agent-loop 处理 start 时
`output.content[0].thinking` 已含首 chunk 内容 → SSE 序列化的 message_start
自带这几个字符 → 前端 snapshot 应用后，同 chunk 的 delta 再被 forward 拼接
一遍 → 开头重复。

## 热修（已应用，npm install 后会丢失需重打）

1. `node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-JVUZSMYM.js`
   （pi-web 实际运行路径，bundle 未压缩）：
   `type:"message_start",message:{...partialMessage}` →
   `type:"message_start",message:{...partialMessage,content:partialMessage.content.map(b=>({...b}))}`（1 处）
2. `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`：
   `message: { ...partialMessage }` →
   `message: { ...partialMessage, content: partialMessage.content.map((b) => ({ ...b })) }`（2 处：start 分支 + 尾部非 addedPartial 分支）

## 上游化建议

向 https://github.com/earendil-works/pi （packages/agent）提 PR：agent-loop
emit `message_start` 时对 `content` 做浅元素拷贝（或 EventStream.push 时对
事件快照），消除「生产者 mutate 早于消费者序列化」的竞态。

## 相关修复

pi-web `lib/agent-event-stream.ts` dd319f8：SSE attach 时 buffer 内容事件
不再重放（snapshot 已含其效果），消除另一条重复拼接路径。
