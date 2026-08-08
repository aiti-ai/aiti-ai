# 聊天滚动跟随策略（步进式跟随）— 设计与实现

> 状态：已实现（2026）
> 范围：agent 运行期间消息列表的自动滚动行为。本文档描述目标、机制、守卫、
> 已知取舍与关键常量，供后续调整时对照。

---

## 1. 背景与动机

AI agent 运行时会持续流式输出，聊天界面需要"跟随"最新内容。naive 的两种做法各有问题：

- **每 chunk 滚到底**：视图一直贴底，用户往上翻历史立刻被拽回；streaming 期间布局
  变化还会产生大量"假滚动事件"，与用户手势无法区分。
- **只滚一次到末尾**：长回答看不到后续输出。

本项目最初采用"提示词锚顶 + 每 chunk 贴底"的组合（prompt-anchor），在长会话/小屏下
体验不佳。最终方案改为**步进式跟随（step-follow）**：视图锚定在"最后一条消息"附近，
输出填满视口后**离散地步进一档**，而不是连续贴底。配合多层守卫，兼顾"跟随"与
"不打扰用户阅读历史"。

## 2. 目标与设计原则

1. **跟随但不打扰**：默认跟随最新输出；用户明确离开（滚远 / 按住 / 正在滚动）时绝不
   把视图拽回去。
2. **离散优于连续**：输出用"步进"推进视图，而不是每 token 贴底——减少无意义的
   滚动抖动，让用户有稳定的阅读节奏。
3. **守卫分层、单一咽喉**：所有跟随路径收敛到 `smartFollowStep()` 一个入口，所有
   守卫（时间窗 / 按住 / 距离）在入口处短路。
4. **回到尾部即恢复**：用户主动回到末尾后，跟随自动重新接管，无需任何开关。

## 3. 涉及模块与数据流

```
useAgentSession (hooks/useAgentSession.ts)
  ├─ smartFollowStep()      ← 跟随唯一咽喉：3 个调用方全部经过它
  │    ├─ message_update 事件（streaming 更新）
  │    ├─ streamState 变化 effect（逐 chunk）
  │    └─ ResizeObserver（容器尺寸变化）
  │
  ├─ userScrollIntentUntilRef   ← 2s 时间窗（滚动交互后暂停）
  ├─ userPointerDownRef         ← 按住冻结（pointerdown→up 全程）
  └─ 距离守卫：lastMsgBottom ≥ 1.5×视口高 → 永不步进

ChatWindow (components/ChatWindow.tsx)
  ├─ promptAnchorSpacer（useLayoutEffect + ResizeObserver）
  │    └─ 滚动容器尾部垫高，使"滚到底时最后一条消息在视口上方 120px"
  ├─ bottomComposer spacer（= 输入框高度，滚动锚定补偿）
  └─ 哨兵 <div ref={messagesEndRef}/>

ScrollToolbar (components/ScrollToolbar.tsx)
  └─ 长按"最新"按钮 = 仅切换屏幕常亮（Wake Lock）；点击导航不再影响跟随
```

## 4. 核心机制

### 4.1 步进式跟随（step-follow，默认且唯一模式）

- 跟随目标是**最后一条消息的底部**，而非用户提问。
- 输出增长时视图保持不动（用户在低处看到新内容填满屏幕）；
- 当最后一条消息底部越过 **keep-out 阈值**（距视口底 16px）→ 步进一档：
  把滚动位置设为"消息底部在视口上方 120px 处"（`behavior: "instant"`）；
- 下方 3/4 视口继续被新输出填充，循环往复。

### 4.2 触发判定（keep-out）

```
lastMsgBottom = 哨兵视口位置 − (promptAnchorSpacer + bottomComposer)   // 消息真实底部
step 当且仅当：lastMsgBottom > clientHeight − 16
```

- `lastMsgBottom` 扣除了消息下方的两个垫片（spacer），测量的是最后一条消息的**真实底部**。
- keep-out 16px ≈ 1 行：输出填到距底约 1 行才步进。历史上是 40px，在小屏上（加上
  消息自身底边距）观感是"差 4~5 行就开始回滚"，故收紧为 16px。

### 4.3 步进目标（120px 锚顶）

```
target = max(0, 消息底部内容坐标 − 120)
```

- 设计意图：步进后最后一条消息底部停在视口上方 120px，上方保留少量历史，下方
  3/4 视口预留给新输出。
- **已知行为（有意保留）**：浏览器滚动有硬上限 `maxScrollTop = scrollHeight − 视口高`。
  当文档尾部垫高 `spacerH < 视口高 − 120`（长会话 promptAnchorSpacer 通常为 0，
  只剩输入框高度——绝大多数情况）时，`target` 超出上限被钳制，实际落点为
  "文档末尾"，即消息底部停在"距视口底 = spacerH"处。因此：
  - 短会话（spacer 垫高足够）→ 真锚顶 120px；
  - 长会话 → 贴底（消息底部距底 = 输入框高度）；
  - 落点随输入框高度 / 键盘 / 视口变化，有高有低——**该行为经评审接受，不修**。
  - 副作用同理被接受：每轮可增长量 ≈ `spacerH − 16`，步进频率与输入框高度相关。

### 4.4 多层守卫（全部在 `smartFollowStep` 入口短路）

| 守卫 | 判定 | 作用 |
|---|---|---|
| ① 时间窗 | `now < userScrollIntentUntilRef`（滚动交互后 2s） | 手势落定缓冲：滚轮/touch/方向键/按压后 2s 内不步进，避免与在途手势打架 |
| ② 按住冻结 | `userPointerDownRef === true`（window pointerdown→up/cancel/blur） | 用户手指/指针按住期间完全冻结，视口绝不在手指下移动；松开立即恢复 |
| ③ 距离守卫 | `lastMsgBottom ≥ 1.5×视口高`（消息底部在视口下缘下方 ≥ 半屏） | 判定"用户已走开读历史"，**不受时间限制**地不步进；回到尾部自动恢复 |
| ④ 触发阈值 | `lastMsgBottom > clientHeight − 16` | 见 4.2 |

调用方与守卫的关系：

- `message_update` 路径：外层另有 `isNearBottomRef`（距底 150px）门禁，已覆盖 ③ 的多数情况；
- `streamState` 逐 chunk effect 与 `ResizeObserver`：**无外层门禁**，全靠 ①②③ 在入口拦截
  ——所以守卫必须放在 `smartFollowStep` 内部，而不是调用方。

### 4.5 spacer 机制（滚动锚定 + 步进几何）

滚动容器内部布局（自底向上）：

```
[消息列表 …]
[promptAnchorSpacer]     ← 仅在 agentRunning && promptAnchorActive 时 > 0
[bottomComposer spacer]  ← 恒等于输入框高度
<div ref={messagesEndRef}/>   ← 哨兵
```

- `promptAnchorSpacer`（`ChatWindow` useLayoutEffect + ResizeObserver 维护）：
  计算让"最大滚动位置"恰好等于"最后一条消息底部 − 120px"，使步进落点（理想态）可达。
  测量时排除自身高度（`anchorExclSpacer`），避免"垫高→哨兵下移→重算→振荡"的反馈环。
- `bottomComposer spacer`：输入框增高/变矮时内容高度同步补偿，保持尾部滚动位置稳定
  （scroll anchoring 的 JS 补偿；Safari 不支持 CSS `overflow-anchor`）。
- 步进与 spacer 的耦合：`smartFollowStep` 与 spacer effect 使用同一几何（120px），
  两者由同一批 streamState / ResizeObserver 事件驱动，顺序为 layout effect 先于
  passive effect，步进测量的是已更新布局。

## 5. 交互细节

- **长按"最新"按钮**：只切换**屏幕常亮**（Screen Wake Lock，`keepAwake && agentRunning`
  时生效；无 API 则 no-op）。步进式跟随本身始终开启，不存在"关闭跟随"的概念。
- **导航按钮（最早 / 上一问 / 下一问 / 最新）**：点击只导航，**不再清除任何跟随状态**。
- **运行结束回底**：仅在"完成滚动被允许 或 用户本就在尾部"且**未按住指针**时才平滑
  滚到底（`completionScrollAllowedRef || isNearBottomRef`，并新增 `!userPointerDownRef`）。
  用户走开时运行结束也不会被拽回。
- **拖拽工具栏**：pointer 按住期间跟随冻结，拖完松开恢复。

## 6. 与其他方案的对比（调研）

| 维度 | 业界主流 | 本项目 |
|---|---|---|
| 跟随目标 | 底部锚定（`isAtBottom` 布尔，如 shadcn `MessageScroller`、`use-stick-to-bottom`、Open WebUI、react-scroll-to-bottom） | **步进式**：锚"最后一条消息"顶 + keep-out 分档步进 |
| 防误判 | 单独监听 `wheel` 区分人机滚动（Medium《The scroll problem nobody talks about…》）| 同样的思路：`markUserScrollIntent`（wheel/touch/keydown）→ 2s 时间窗 |
| 顶部锚定 | ChatGPT 式"提问钉顶 + 动态底部 padding"（Medium 文详述）| 同族：`promptAnchorSpacer`（历史沿革，现服务步进几何） |
| 防拽回 | 单一 `isAtBottom` 阈值（~几十 px）| **四层组合**：距离守卫（时间无关）+ 2s 时间窗 + 按住冻结 + 16px 触发阈值 |
| 按住/触摸中 | 多数库未专门处理，靠 `isAtBottom` 自然停 | **pointer 按住全程冻结，松开即恢复** |
| 滚动动画 | `use-stick-to-bottom` 用速度弹簧；Open WebUI 用 rAF 批处理 | `behavior: "instant"` 瞬时步进（无过渡动画，评审接受） |

独特点小结：

1. **步进式跟随本身**：未发现别家采用"锚最后一条消息 + 分档步进"；Open WebUI 用户
   仍在抱怨"长回复强制贴底跟随"（issue #19365）。
2. **多层守卫组合**：距离（半屏）/时间（2s）/按住（全程）三层独立机制，比单一
   `isAtBottom` 更细粒度地权衡"跟随"与"不打扰"。

## 7. 已知行为与取舍（接受项）

1. **步进落点有高有低**：长会话钳制到"文档末尾"（消息距底 = 输入框高），短会话
   真锚顶 120px；落点随输入框/键盘/视口变化。评审结论：可接受，不修。
2. **每轮步进频率与输入框高度相关**：小输入框 → 每轮增长量小 → 步进较频繁。
3. **步进为瞬时跳变**：无平滑过渡（弹簧/smooth 方案已调研，若日后需要，弹簧比
   时长缓动更适合 streaming——可中途改目标、可取消；但需处理与 spacer 的耦合）。
4. **2s 时间窗内的点击**：任何 pointerdown 都会重置 2s 窗口，快速连点期间跟随暂停。

## 8. 关键常量表（`hooks/useAgentSession.ts` 与 `components/ChatWindow.tsx`）

| 常量 | 值 | 位置 | 说明 |
|---|---|---|---|
| `USER_SCROLL_INTENT_MS` | 2_000 | useAgentSession | 滚动交互后的跟随暂停时间窗 |
| 距离守卫阈值 | `clientHeight * 1.5` | useAgentSession | 消息底部在视口下缘下方 ≥ 半屏 → 走开 |
| keep-out | `clientHeight - 16` | useAgentSession | 输出填到距底 16px 才步进 |
| 步进目标偏移 | `- 120` | useAgentSession + ChatWindow | 消息底部理想落点（视口上方 120px） |
| `SCROLL_BOTTOM_THRESHOLD` | 150 | useAgentSession | `message_update` 外层"近底部"门禁 |
| `PROGRAMMATIC_SCROLL_IGNORE_MS` | 700 / 步进时 1200 | useAgentSession | 程序滚动后的误判豁免窗口 |

## 9. 代码位置映射

| 逻辑 | 位置 |
|---|---|
| 跟随咽喉 + 全部守卫 | `useAgentSession.ts` → `smartFollowStep()` |
| 时间窗标记 | `markUserScrollIntent()` + window/container 监听 |
| 按住冻结 | `userPointerDownRef` + window pointerdown/up/cancel/blur 监听 |
| spacer（promptAnchorSpacer）| `ChatWindow.tsx` useLayoutEffect（`updatePromptAnchorSpacer`） |
| bottomComposer spacer | `ChatWindow.tsx` useLayoutEffect（`updateBottomComposerHeight`） |
| 屏幕常亮开关 | `ScrollToolbar.tsx`（`keepAwake` + `useWakeLock`） |
| 文案 | `lib/i18n/messages/{en,zh-CN}.ts`（`chat.scrollToLatestFollowHint` / `chat.screenKeepAwakeOn`） |
