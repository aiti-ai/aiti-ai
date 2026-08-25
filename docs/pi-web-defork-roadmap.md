# pi-web 去 fork 化路线图（defork roadmap）

> 目标：pi-web 逐步回归上游原版 + 一层薄「扩展宿主」diff；产品功能全部迁到外围扩展
> （`aiti-ai/pi-web-ext/*`）。本文档是执行底账：按簇记录现状、评估与迁移顺序。
>
> 度量口径：`git diff origin/main..HEAD --numstat`（当前实际分歧），历史提交数仅作辅助——
> 提交计数会把已迁出功能的历史也算进来（service-tunnels 教训，见 §2.1）。
> 基线：2026-08-24，领先上游 380 commits（落后 0），diff 130 文件 +21621/-8199。

## 0. 目标态定义

```
pi-web = 上游原版
       + 扩展宿主层（lib/ext/*、ExtSlots、hooks —— 收敛在少数新增文件，
         对上游文件的原地修改压到每处几行 hook 调用）
pi-web-ext/* = 全部产品功能（可独立部署、独立开关）
```

原则：
1. **先立契约后搬家** —— 外迁前先在 core 定义最小 hook/slot 面，契约优先落在新文件；
2. **整簇搬不留半截** —— 半搬状态（core 一半扩展一半）比不搬更痛；
3. **能送上游的送上游** —— 通用 fix / 性能优化 PR 上游 = 永久消掉冲突面；
4. **diff 预算** —— 热点五个文件的 fork 行数只减不增；新功能一律扩展优先。

## 1. 总账：分歧在哪

### 1.1 无合并冲突的存量（新增文件，上游 merge 自动保留）

| 块 | 行数 | 说明 |
|---|---|---|
| `lib/ext/*` 宿主层 | ~2900 | registry/types/ExtSlots/ext-client-loader/ext-ui-store/topbar-order 及测试 |
| `components/QueueRecoveryDialog.tsx` | 556 | 队列/草稿恢复对话框 |
| `components/ExportDialog.tsx` | 350 | 导出对话框 |
| `lib/draft-store.ts` | 295 | 草稿持久化纯模块 |
| docs/* | ~1500 | 设计文档 |

### 1.2 冲突热点（对上游文件的原地修改）——主战场

| 文件 | 上游行数 | 当前 | diff | 主要内容 |
|---|---|---|---|---|
| components/ChatInput.tsx | 2638 | 4561 | **+2086** | 队列增强 UI、@补全增强、草稿接线、移动端 |
| components/AppShell.tsx | 2275 | 2995 | **+1488/-768** | 新建会话流、顶栏排序、文件夹标签、扩展接线 |
| lib/rpc-manager.ts | 1702 | 2588 | **+908** | 队列持久化、流式节流、pi-plugins 扫描、agent hooks |
| hooks/useAgentSession.ts | 1949 | 2735 | **+866** | 会话提升/rekey、恢复解析、聊天钩子 |
| components/ChatWindow.tsx | 1339 | 1865 | **+817** | 恢复对话框合成、通知架、step-follow |
| 其余（SessionSidebar/MarkdownBody/ModelsConfig 等） | — | — | 各 <210 | 见各簇 |

**关键事实：上游在同批机制上同样活跃演进**——上游 ChatInput 已自带 atQuery（@补全）、
slash 菜单、queuedMessages/steer/followUp、draftKey 基础。fork 的 +2086 大多是对这些
共享机制的**原地增强**而非独立新增块（34/45 个 hunk 落在组件主函数体内）。
⇒ 外迁的正确姿势不是「把代码搬走」，而是「把差异改写为机制之上的策略插件」：
core 保有机制（队列容器、草稿槽位、恢复对话框插槽），fork 差异作为可卸载的装配层。

## 2. 已完成的去 fork 化（模式验证）

| 簇 | 迁出方式 | 备注 |
|---|---|---|
| service-tunnels（~5165 行） | 766739f 全量外迁 | core 只剩 proxy.ts 安全门禁+vhost 委托、request-security 只读 globalThis 配置（安全门禁不随扩展加载漂移，刻意设计）；**教训：审计要用当前 diff 口径，commit 计数会误导** |
| aiti-msg-nav 消息滚动导航条 | 组件抽离为扩展 | 4678bc9 |
| aiti-folder 文件夹标签页 | 数据模型+查看器接口化，openFolderTab 经 HostApi | FolderViewer 仍在 core（右面板通用能力），接口面已扩展化 |
| aiti-editor 文件编辑接管 | fileViewer 接管 slot | 未命中走原查看器零回归 |
| aiti-msg-smart / ai-helper / git-review 等 | 纯外围 | 不占 core diff |

## 3. 功能簇台账（剩余分歧逐簇评估）

处置代号：**PR**=送上游 · **EXT**=外迁扩展 · **CORE**=留核心 · **DROP**=放弃回退

### A. 队列系统增强 —— EXT（二期，最大单簇）
- 范围：queue banner/QueuedMessageRow、steer/follow-up 按钮（icon-only popover）、
  「继续」投递全队、回车插队、trash/recall/requeueAt、rpc-manager 队列持久化
- 体量：ChatInput ~400 行 + rpc-manager 一部分 + QueueRecoveryDialog（新文件已隔离）
- 评估：上游有基础队列且活跃演进；UI 层（横幅/按钮/对话框）可经 slot 外迁，
  持久化在 rpc-manager 属内核机制。**先立「队列策略契约」（入队/出队/持久化事件 + banner slot）**
- 前置：P1 契约中的值观测 + 发送前钩子

### B. 草稿持久化 + 恢复 —— ✅ 已完成外迁（P2，2026-08-24）
- 范围：原 draft-store.ts（295 行）、ChatInput 草稿接线、ChatWindow 扫描/静默恢复/
  恢复对话框合成、useAgentSession.restoreSubmission/rekeyDraft、AppShell.clearAllDrafts
- 现状：core 零 draft-store 依赖（`lib/draft-store.ts` 已删）。草稿存储全部归
  `aiti-draft-keeper` 扩展（自有存储层副本 + DraftApi 注册表 `lib/composer/draft-api.ts`）。
  core 调用方经 `getDraftApi()` 访问（null 安全）。恢复对话框的恢复项由 keeper 经
  `registerRecoveryItemsProvider` 并入；「Re-queue / Re-queue & continue」严格对齐。
- 体量：core 净减 -616 行（ChatWindow -193 / ChatInput -65 / draft-store 删 -397 / 测试 -55）
- parity：与旧 core 逐项对齐（图片还原 / 元素错误待选展开 / 多残留排队 / boxEmpty 守卫 /
  own 首条不清 / 60s 活跃外部槽位抑制 / 复制标签页 tabId 自愈 / feature 开关响应）
- 遗留权衡：删了 2 个 rekey 库单测（逻辑现仅在 keeper 副本，E2E 覆盖 happy path）；
  extman 关 keeper → 草稿功能随停（keeper 是唯一所有者，无 core 兑底）

### C. 流式渲染性能 —— PR 上游（择机）/ 否则 CORE 长期保留
- 范围：轻量文本渲染、delta rAF 微批次、历史分页 30 条、key 稳定化、rpc flush 节流、
  step-follow 滚动跟随（scroll-follow-strategy.md）
- 评估：替换式性能优化，必须活在内核路径上，无法扩展化。上游同样受益，
  是最有 PR 价值的簇；上游不收则作为长期维护的 perf 补丁层
- 分布：MarkdownBody/MessageView/ChatWindow/rpc-manager/useAgentSession

### D. 输入交互习惯 —— PR 上游（低垂果实）
- 范围：裸 Enter 直发 + enterKeyHint、发送/steer 后焦点归还、小屏按钮显隐策略
- 评估：小而散的行为修正，普适性好，PR 成本低收益直接

### E. 移动端适配群 —— 部分 EXT / 部分 PR
- 范围：电池式 context 指示、统计信息小屏布局、drawer 行为、useIsMobile/useIsCoarsePointer
- 评估：use* hooks 是通用基建可 PR；视图层改造分散在现有组件内，
  优先级放低（上游 mobile 也在动，硬搬易撞车）

### F. 模型选择器增强 —— EXT（三期）
- 范围：provider 分组折叠、streaming 中可点切换、ModelScopeWarningBanner、
  models-wizard/model-check 支撑（getModel 透传等）
- 评估：选择器 UI 可 slot 化接管（仿 fileViewer 接管模式）

### G. 新建会话流 / 会话生命周期 —— CORE（保留）
- 范围：newSessionDraftId/promotion rekey、workspace restore、运行中 fork/navigate
- 评估：这是 agent 会话语义的一部分，与 pi SDK 强耦合，非 UI 增强，外迁无意义

### H. pi-plugins 内置扫描 —— CORE（保留，可提议上游）
- 范围：rpc-manager 内置 `<agentDir|cwd>/pi-plugins/*/index.*` 加载
- 评估：机制性功能，无 UI；若上游认可可 PR

### I. 扩展宿主层 —— CORE（战略保留，即目标态里那层薄 diff）
- 范围：lib/ext/*、ExtSlots、features 治理、toolbarExtItems/topbar-order、chatOverlay
- 规约：**新增 hook 一律落新文件**；对上游文件的接入点控制在 import + 单行调用

## 4. 迁移顺序

| 阶段 | 内容 | 退出标准 |
|---|---|---|
| P1 契约 | composer 契约第一组：值观测 / 程序写值(tracker 同步) / key 变更事件 / 恢复对话框插槽；hook 落新文件，上游文件每处 ≤5 行 | 契约有测试；ChatInput 接入点 ≤4 处 |
| P2 草稿簇外迁（B） | draft-store + 扫描/静默恢复/对话框合成移入扩展；sidebar 草稿行改经扩展 widget | ChatInput/ChatWindow 草稿相关原地行归零，功能回归不变 |
| P3 队列 UI 外迁（A） | banner/按钮/对话框经 slot；持久化留 rpc-manager 或下沉独立模块 | ChatInput 队列 UI 行归零 |
| P4 模型选择器（F）+ 移动端残余（E） | 接管 slot 化 | — |
| 持续轨道 | D/C 类 PR 上游；每次上游发版即合并（趁 behind=0 成本最低） | 热五文件 diff 行数单调下降 |

## 5. 变更记录

- 2026-08-24 初版：基线 380 commits / +21621-8199；确定 P1-P4 顺序，B（草稿簇）为外迁试点
- 2026-08-24 P1+契约 v0.2 落地于 worktree `pi-web-worktrees/defork-composer`
  （分支 defork/composer-contract）：四钩子 + 受控写值全链路 + 恢复项提供者；
  实地分析发现 B 簇与队列/会话生命周期的三处额外交缠（见 §3.B ⚠），P2 切换前逐项解决
- 2026-08-24 **P2 草稿簇外迁完成**（分支累计 15 提交）：删 lib/draft-store.ts，
  core 零 draft-store 依赖；草稿存储/扫描/静默恢复/对话框合成/restoreSubmission/
  rekeyDraft/clearAllDrafts 全部归 aiti-draft-keeper（经 DraftApi 注册表）；
  与旧 core 全 parity（图片/元素错误待选/排队/boxEmpty/own 首条/60s 抑制/
  复制标签页自愈/feature 开关）；core 净减 -616 行。E2E 实测通过。
  下一站：合回 main → P3 队列 UI（A 簇）
