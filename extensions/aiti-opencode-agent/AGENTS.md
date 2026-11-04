# aiti-opencode-agent

OpenCode CLI 会话后端扩展（pi-web 多 agent 前端）。让 OpenCode 的历史会话在 pi-web 里打开、续聊。

## 结构

- `index.ts` —— 全部实现（handle + provider 注册 + 冷恢复），无构建、无 client。
- `tools/deploy.mjs` —— 拷贝 index.ts/package.json 到 `~/.pi/web{,-dev}/extensions/` + 双实例热重载。

## 协议与进程模型

- `opencode run -s <sid> --format json <prompt>`：每轮一个单发进程，`-s` 续接（aiti-zcode-agent oneshot 同款）。
- stdout NDJSON part 事件：`step_start` / `text`（**part 完成后一次性快照**，非逐 token；per-part 前缀差分出 delta）/ `tool` / `step_finish`（tokens）。`sessionID` 随行——新会话首轮从事件捕获 sid → `session_backend_ready` 换绑复合 id。

## 冷恢复（与 aiti-zcode-agent 同语义）

- cwd 以会话真实 directory 为准：session-manager `services.sessions.parseSession` → `meta.cwd`（URL `?session=` 恢复路径 options.cwd 常空，不能落 process.cwd()——claude 扩展曾因此历史回放空白，本扩展出生即带正确语义）。
- 历史经 parseSession 种子回填（IndexedMessage → pi 形状 toolCall/toolResult）。

## 红线

- 会话**读取**唯一权威实现 = session-manager `lib/agents/opencode.ts`（本扩展只驱动，勿在他处重写读取）。
- v1 能力面刻意收窄（`OC_CAPABILITIES`）：核心四件套 + getMessages；setModel/listModels/steer/followUp/图片附件均为后续项，UI 据此隐藏入口。
- 禁轮询；流式解析只挂在子进程 stdout 上。
