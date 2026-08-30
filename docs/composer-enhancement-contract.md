# Composer 增强契约（草案 v0.1）

> 去 fork 化路线图 P1（见 aiti-ai 工作区 `docs/pi-web-defork-roadmap.md` §4）。目标：为 composer 定义
> 最小、稳定的扩展钩子面，让草稿持久化（P2）、队列 UI（P3）等差异从「原地修改
> ChatInput」变为「机制之上的策略插件」。
>
> 硬约束：
> - 钩子实现全部落**新文件**（`lib/composer/*`）；对 ChatInput/ChatWindow 的接入点
>   每处 ≤5 行；
> - 程序化写值必须经 tracker 同步路径（b30d131 教训：裸写 ta.value 会留下过期
>   _valueTracker，用户后续编辑被 React 去重吞掉）；
> - 契约消费者第一方就是 core 自己的草稿/队列逻辑——先自食，保证契约够用。

## 1. API 面

```ts
// lib/composer/types.ts（新文件）
export interface ComposerSnapshot {
  value: string;
  /** 已附加图片的持久化形态（base64 data，无 previewUrl）——对象引用共享，仅持久化时才序列化 */
  images: { data: string; mimeType: string }[];
  imageCount: number;
  /** true = 用户正在打字或框内有内容（含图片） */
  hasInput: boolean;
}

/** 扩展侧实现的增强器；core 在固定时机回调 */
export interface ComposerEnhancement {
  id: string;
  /** 值变化（用户输入 / 程序写入 / 清空）。高频——实现方自行节流 */
  onChange?(snapshot: ComposerSnapshot): void;
  /** draftKey 切换（会话切换 / 新建会话提升 rekey） */
  onKeyChange?(previousKey: string | undefined, nextKey: string | undefined): void;
  /** 发送前最后一步（清空之前）。可返回替换文本（链式） */
  onSubmit?(text: string, images: AttachedImage[]): { text: string } | void;
}

/** core 提供给增强器的受控写入口 */
export interface ComposerWriter {
  snapshot(): ComposerSnapshot;
  /** 程序化写值：走 writeTextareaValue（原生 setter + tracker 同步），光标置尾 */
  setValue(text: string, opts?: { selectRange?: [number, number] }): void;
}
```

注册走既有扩展宿主通道（HostApi），不新开机制：

```ts
// lib/ext/host-api.ts 追加
registerComposerEnhancement(enh: ComposerEnhancement): () => void; // 返回注销函数
```

## 2. core 内部装配（lib/composer/bus.ts，新文件）

- `ComposerBus` 单例：enhancement 注册表 + 快照缓存 + 事件分发；
- 分发同步、顺序 = 注册序；单个 enhancer 抛错隔离（try/catch + console.warn，
  不打断其他 enhancer 与主流程）;
- features 治理：extman 关掉的扩展其 enhancer 不注册（走既有 features 过滤）。

## 3. ChatInput 接入点（共 4 处，每处 ≤5 行）

| # | 位置 | 接入 |
|---|---|---|
| 1 | 值变化 effect（现有 `[value]` effect 内） | `composerBus.emitChange(snapshot)` |
| 2 | draftKey 切换 effect | `composerBus.emitKeyChange(prev, next)` |
| 3 | onSend 入口最前 | `text = composerBus.runSubmit(text, images)` |
| 4 | useImperativeHandle 的写值方法 | 写入统一走 bus 持有的 writer（writer 内部即现有 writeTextareaValue 路径，不改行为） |

## 4. ChatWindow / 恢复对话框接入（v0.2 已实现）

- `lib/composer/recovery.ts`：`registerRecoveryItemsProvider({id, getItems, subscribe})`
  —— 扩展把残留输入并入恢复对话框；ChatWindow 合成点 ≤5 行
  （useRecoveryProviderItems + 展开进 recoveryItems）；getItems 抛错隔离
- `ctx.writeComposerValue(text)` → HostApi → ChatInputHandle.setValueTracked：
  扩展程序化写值的受控路径（tracker 同步）
- `ctx.restoreComposerDraft({value, images})` → ChatInputHandle.restoreDraft：
  完整还原草稿进框（文本 + 图片，raw 不跑钩子）
- `ctx.sendChatMessage(text, mode, images?)`：第三参携带图片的 follow-up 排队；
  preSend 钩子（[元素N]/[回答N]/[错误N]）在 ChatInput 内部展开
- `ctx.queueFollowUp(text, images?)`：**仅入队不触发**（草稿恢复「Re-queue」语义）——
  空闲也只进 follow-up 队列，不直发；钩子同样展开，images 随队列项携带
- 恢复对话框的 continueRun：服务端项走 resolveRecovery(continueRun) 启动；
  纯草稿项走 ChatWindow.handleContinueQueue（continue_queue）启动队列处理

## 5. P2 草稿簇迁移预演（验证契约够用）

draft-store + ChatWindow 扫描/静默恢复移入扩展后，依赖核对：

| 草稿逻辑需要 | 契约提供 |
|---|---|
| 观测输入内容落槽位（300ms 防抖） | onChange |
| 输入框空判定（own slot 过滤 / 静默恢复前检查） | snapshot().hasInput |
| draftKey 变更时保存旧槽位+换 key 扫描 | onKeyChange |
| 恢复落地进输入框 | ctx.writeComposerValue（已实现，走 setValueTracked 受控路径） |
| 发送后清槽位 | onSubmit（之后 core 清空 → onChange("")） |
| 残留项进恢复对话框 | registerRecoveryItemsProvider（已实现） |

✅ 无缺口即可动工；发现缺口先改本契约再迁移。

## 6. 明确不做（v0.1 范围外）

- 光标/选区细粒度事件、IME composition 事件（尚无消费者）
- 队列容器契约（P3 再设计）
- 多 composer 实例并存（当前单实例假设，与现状一致）

---

## 附：草稿原语收敛（v2，2026-08-29）

方案 A「keeper 唯一所有者」落地后，本契约的草稿部分收敛为：

- **core 不再直接操作槽位**。`saveDraft`/`clearDraft`/`rekeyDraft`/
  `restoreSubmission` 全部退役（v1 方法在 keeper 中保留为 deprecated，
  仅部署顺序兼容用）。
- core 唯一写入口 `applyDraftIntent(intent)`（lib/composer/draft-api.ts）：
  - `sessionCreated {provisionalKey, sessionId}`：新建会话提升。provisional
    草稿作废；promote 窗口（React key prop 切换前）的新输入由 keeper 重定向
    落 sid 槽位（消除「已发送消息残留」竞态）。
  - `rejected {key, text, images}`：发送失败/被拒时合并回草稿（提交在前），
    目标为当前框则由 keeper 写回框内。
- 清空单路径化：发送/清空只走 keeper `onChange("")` 清空确认链（闭包捕获
  key，换 key 不误清）。
- 状态机实现在 `pi-web-ext/aiti-draft-keeper/client/core.mjs`（唯一所有者，
  storage/timers/onRestore 注入可测），测试 `core.test.mjs`（13 用例）。
- 启动时一次性 `pruneStale()`：>7 天未写入的槽位（含旧 per-tab 残留、无 ts
  旧格式）自动过期清理，非轮询。
- 已知修复：「恢复即删」——scan 恢复后同一轮 onChange 的空快照不得再走清空
  分支（恢复发生即 return，等写框回流的新快照）。
- 已知修复（2026-08-30）：「发送的草稿复活」——ChatInput 曾残留一个无 suppress
  的旧 emitComposerChange 广播（与带 suppress 的新广播双发），suppressDraft 被击穿：
  「从这里编辑」预填文本漏进槽位；发送瞬间 enhancersVersion 补偿 effect 因 deps 含
  suppressDraft 而重跑 onKeyChange(S,S) 重挂 scan → 刚清空的框被 scan「恢复」回刚
  发走的消息，且恢复污染 lastSnap 使 300ms 清空确认失效。修复：①删除重复广播
  （值广播只保留带 suppress 的一处）；②keeper scan 在清空确认窗口内否决恢复
  （clearTimers.has(key) → return false，确认走完后恢复能力不受影响）。
  回归：core.test.mjs「发送清空确认窗口内 scan 不复活刚发走的草稿」等 2 例。
