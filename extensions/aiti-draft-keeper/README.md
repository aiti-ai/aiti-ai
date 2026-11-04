# Draft Keeper（aiti-draft-keeper）

草稿持久化 + 恢复接管扩展——pi-web 去 fork 化 P2 的产物（`docs/pi-web-defork-roadmap.md` §3.B）。
core 的草稿逻辑（原 `lib/draft-store.ts` + ChatInput/ChatWindow 接线）已全部迁出，
**core 零 draft-store 依赖**；core 经 `lib/composer/draft-api.ts` 注册表访问本扩展
提供的存储 API，经 composer 增强契约广播 key/值变化。

## 架构（v2：状态机唯一所有者）

- `client/core.mjs` = **草稿状态机纯逻辑**（storage/timers/onRestore 注入可测，
  `core.test.mjs` 17 用例钉死语义）；`client/aiti-draft-keeper-client.mjs` =
  薄壳（window/localStorage 适配 + hydration 门控 + DraftApi 注册）。
- **core（pi-web）唯一写入口是意图**（`applyDraftIntent`，见 pi-web
  `docs/composer-enhancement-contract.md` v2 节）：
  - `sessionCreated {provisionalKey, sessionId}`：promote 时 provisional 草稿
    作废；promote 窗口（key prop 切换前）的新输入重定向落 sid 槽位；
  - `rejected {key, text, images}`：发送失败合并回草稿，当前框则写回。
- `slotKeyOf` 按**最后一个冒号**取 cwd 段——draftId 可能自身含冒号
  （?cwd= 引导的 `initial:<cwd>` 形式），不得按首个冒号切分。
- `pruneStale()`：启动一次性清理 >7 天未写入槽位（含旧 per-tab 残留、无 ts 旧格式）。
- 已修「恢复即删」：scan 恢复后同一轮 onChange 直接返回（恢复把 known 指向
  恢复值后，空快照继续走清空分支会在确认延时后删掉刚恢复的草稿）。

## 模型（共享槽位 + 无贡献不回写）

- **每会话一个共享槽位** `crashrestore-<key>`（无 tabId）——多标签同会话天然共享
  同一份草稿；新建视图 = `crashrestore-new:<cwd>`（cwd 族自然 key，draftId 抖动无感）。
- **known** = 本标签页最后显示/写入的值。
- **onChange（真实输入才写）**：
  - `snap === known` → **不写**（无贡献不回写★——防震荡的核心）；
  - `snap === ""` → 清槽位（**清空/发走再清**★；延迟 300ms 确认，防陈旧实例
    空快照误清；打开时空框不清）；
  - 其他 → 写新值（有贡献才写；last-write-wins）。
- **scan（只读，永不写 → 无震荡源）**：
  - 框空 + 有存储 → 静默恢复进框（**恢复不清暂存**；known = 恢复值）；
  - 框有内容 + 存储 ⊇ known（别的标签页扩展了草稿）→ 同步进框；
  - 分叉 → 不动（写方写新值）。
- **恢复等宿主水合完成**（`pi-web:hydrated` 信号 + stage 重放二道防线）——
  水合前落框会被 hydration 失配重渲染按服务端 HTML（空框）抹掉。

## 多标签语义

共享草稿 + last-write-wins + 被动同步：
- 两个标签同会话各自打字 → 各自刷新各自恢复（共享槽位，无 own/foreign 之分）；
- 一个标签扩展了草稿 → 另一标签被动同步进框；
- 同时打字 → last-write-wins（共享草稿语义的固有属性）；
- 「正在输入本页最大」：框有内容时绝不弹框/恢复，包含关系自动分流
  （框 ⊇ 草稿丢弃；草稿 ⊇ 框静默覆盖；互不包含等下次框空恢复）。

## 契约依赖（core 侧，worktree defork/composer-contract 分支）

- `ctx.registerComposerEnhancement`（值观测/key 切换/发送前钩子）
- `ctx.restoreComposerDraft` / `ctx.writeComposerValue`（受控写值，tracker 同步）
- `ctx.registerDraftApi`（core 经 `getDraftApi()` 访问存储：**applyIntent**/
  getDraft/clearAllDrafts/flushAll 为 v2 面；saveDraft/clearDraft/rekeyDraft/
  restoreSubmission 为 deprecated，仅供未升级旧 core 回退）
- `window.__piWebHydrated` + `pi-web:hydrated` 事件（水合信号）
- ChatInput 增强器集合变化补发（晚注册补偿）

## 已知边界

- extman 关掉 keeper（或重开后关闭）→ 草稿功能停（core 无兜底，keeper 是
  唯一所有者；运行时开关立即生效）。
- 双标签**同时**打字 = last-write-wins（共享草稿语义固有）。
- 旧 per-tab 槽位（crashrestore-<key>-<tabId>）首次读取时自动迁移到共享槽位；
  从未访问的会话的旧槽位残留（无害）。

## 部署

```bash
node tools/deploy.mjs    # 免构建；拷贝到 ~/.pi/web{,-dev}/extensions/
```
生效：POST /api/extensions/reload；刷新页面即新 client。
