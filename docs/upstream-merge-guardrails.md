# 上游合并守则（fork ↔ upstream）

> **每次合并上游前必读。** 本文沉淀 fork 历次上游合并实际踩过的回归模式、守卫它们的钉测试、以及合并后的固定检查流程。2026-11 的 v0.13→v0.15 合并一次暴露了四类中的三类，逐条对号入座。

## 〇、四类已发生的回归模式（全部实测踩过）

### A. auto-merge 双堆叠——同一按钮/面板被两套实现各渲染一次

上游与 fork 各有一份同类实现，git auto-merge 两边都不认为冲突，结果**同时渲染**。已发生过三次：

| 按钮 | fork 单一 owner（保留方） | 上游堆叠来源 | 防回归钉 |
|---|---|---|---|
| 会话统计 | inline IIFE（`{showChat && (sessionStats || contextUsage) && ...}`） | `renderSessionStatsButton` 调用 | `AppShell.topbar-dedup.test.mjs` |
| 信任告警 | inline 版 | `renderProjectTrustWarning` 调用 | 同上 |
| Debug 入口 | 顶栏右簇 `renderDebugButton(isMobile)`（f19b7398 re-home） | 上游 toolbar 内调用（5125/5129） | 同上（调用点计数 ==1） |
| 文件面板开关 | 右上角 `renderMainFileToggle(isMobile)`（51273ef1 统一） | 上游行内调用（5130，曾与 fork ⋯ 重叠） | 同上 |
| chat 工具动作组 | fork 自绘行（renderTopbarItem）+ More 面板内一处 | 上游 medium 行内组 | `AppShell.mobile-toolbar.test.mjs` doesNotMatch + dedup 计数 |

**教训**：上游给某按钮加了新渲染点 ≠ fork 需要它。合并 diff 里凡是「调用 renderXxx 的行」新增，先查 fork 是否已有该按钮的 owner（搜组件名）。

### B. 结构性改动只并一半——配套 hunk 被分别裁决

上游一个 commit 常把「互为前提的几处改动」写在不同 hunk（甚至不同文件）；合并冲突按 hunk 逐个裁决时，**取了新的一半、旧的一半，结构就断**。已发生：

- **composer 收缩链**（#1429）：fieldset flex column 保留 + 内层 `width:"100%"`/队列容器 `minHeight:72`/ChatWindow `min-h-0 flex-col` 丢失 → flex column 下 `margin:0 auto` 禁用 stretch，输入条塌到 20px。**守卫：`ChatInput.composer-shrink-chain.test.mjs`（四点互为前提，缺一即红；demo 镜像是完整上游版，可作对照）。**

**教训**：冲突 hunk 属于同一上游 commit 时，**整组一起裁决**（全取或全弃），不许逐 hunk 混搭；不确定时先看该 commit 的完整 diff（`git show <commit>`）再动手。

### C. 钉测试迁就错误结果

合并适配时为了绿灯**放宽钉测试的正则去匹配错误的融合结果**，而不是纠正代码——测试从此失去守卫作用。已发生：`ChatWindow.extension-request.test.mjs` 把 composer 容器正则放宽到 `(?: shrink-0)?` 来适配丢失上游形态的错误结果。

**纪律**：
1. 钉测试红了先问「代码错了还是测试过时」——默认代码错了（测试钉的是 fork 设计意图）。
2. 确需放宽（fork 有意换实现）：新正则必须**同时钉住 fork 替代形态**，且放宽理由写进注释（见 mobile-toolbar.test 的「合并修正」注释样式）。
3. 合并后若某钉测试被 skip 条件放行，检查 skip 条件是否因合并引入的代码而失效（mobile-toolbar 的 `upstreamStructSkip` 就是因上游结构被带入而从 skip 变成照跑）。

### D. 上游重写覆盖 fork 行为语义（fork 的设计决策被静默丢弃）

上游重写 fork 依赖的代码路径时，fork 语义若无测试钉住，合并时会被无感覆盖。已发生：

- **微信式移动发送**（ada119b4：所有设备裸 Enter 即发送 + `enterKeyHint="send"`）：上游 #1001 重写 sendShortcut 且带运算符优先级 bug（`isMobile || mode ? enterKey && (ctrl||meta) : enterKey` → 手机 Enter 变换行），合并忠实带入。**守卫：`ChatInput.mobile-send.test.mjs`（钉正确形态 + doesNotMatch 上游错误形态 + enterKeyHint 一致性）。**

**教训**：fork 与上游行为不同的每一处（发微信式发送、自绘顶栏、小屏输入 v4 等）都必须有源码级钉测试；「行为和上游一样」的地方才不需要钉。

## 一、单一 owner 清单（合并后这些按钮/结构必须只有一处渲染）

| 结构 | 唯一渲染点 | 
|---|---|
| Debug 面板入口 | `AppShell` 顶栏右簇 `{renderDebugButton(isMobile)}` |
| 文件面板开关 | `AppShell` 右上角 `{renderMainFileToggle(isMobile)}`（负 margin 贴右端） |
| 会话统计/信任告警 | inline IIFE |
| chat 工具动作组 | fork 自绘行 + 窄屏 More 浮层内各一份（这是设计内的两态渲染，其余位置不许出现） |
| 队列横幅 | composer 内（aiti-queue-keeper 插槽接管 + FallbackQueueRow 兜底） |
| 小屏 composer 结构 | v4 方案（`docs/pi-web-mobile-input-composer-v4-plan.md`），底排按钮组 + ＋ 面板 |
| 移动端 Enter 行为 | 裸 Enter 发送（微信式），桌面按 enterSendMode 偏好 |

**有意改写清单**（上游结构在 fork 有功能等价替代，行级核对时不算误并，勿当回归"修复"回去）：

- 上游 `chat-composer-run-label` 文本按钮 + container query 图标化 → fork `StreamingActionButton`（图标 + hover 弹标，无 inline label，更彻底）
- 上游 composer 内 side chat 按钮 → fork `StreamingActionButton` 版（sendToSideChat）
- 上游 `QueuedMessageRow` → fork `FallbackQueueRow`（带图片态）
- 上游窄屏「Agents 常驻 More 旁」→ fork 保留 `getFoldedMoreAgentsBadge` 折叠方案（有意不跟 57078bb5）
- 上游 mobile toolbar 行内平铺（medium 档）→ fork 自绘行测量溢出（所有宽度档统一机制）
- 上游 `modelList` 窄类型 → fork 超集（+ avail/providerRL/status）；`handleAbort` → fork `handleAbortRequest` 增强

## 二、合并 SOP（固定流程）

> **入口已挂在 `AGENTS.md`**（Quick Start 后「Merging upstream」节）：agent 会话执行合并时必经该文件，由它指到本文。本文内容变更时同步 AGENTS.md 的概要。

1. **合并前**：读上游新 commits 里动过 `components/ChatInput.tsx`、`ChatWindow.tsx`、`AppShell.tsx`、`app/globals.css` 的每一个 commit 的完整 diff（`git show`），对照 §一 清单标出 fork 有 owner 的点。
2. **冲突裁决**：同一上游 commit 的冲突 hunk 整组一起裁决（模式 B）；fork 有 owner 的按钮调用行一律取 fork 侧（模式 A）。
3. **合并后必跑**（`--base` = 上次合并的上游 tip：合并前 `git fetch` 后、`merge` 前记下的 `OLD_TIP=$(git rev-parse origin/main)`；不带参数时默认 merge-base(HEAD, origin/main)，合并完成后该区间为空，所以必须显式传）：
   ```bash
   node --experimental-strip-types --test components/AppShell.*.test.mjs components/ChatInput.*.test.mjs \
        components/ChatWindow.*.test.mjs components/MobilePwaLayout.test.mjs components/SessionSidebar.test.mjs
   # 全量（含 hooks/lib/app，合并涉及面广时）：
   npm test
   # 行级核对（输出是候选清单，逐条定性：fork 有意 / 合并丢失）
   node scripts/check-upstream-merge.mjs --base "$OLD_TIP" --upstream origin/main
   ```
   ⚠️ **env 陷阱**：agent 会话的 shell 常继承 dev 实例的 `PI_WEB_*` 环境变量，会让一批 server route 测试（foreign-origin/信任校验类，期望 403 实得 200）假失败——已实锤 2026-11。全量跑出 403 类失败时先用 `env -i PATH="$PATH" HOME="$HOME" node --test <失败文件>` 复验再定性，勿直接当回归修。
4. **真机/模拟冒烟**（钉测试测不出布局塌陷这类视觉回归）：Chrome DevTools 移动模拟 375×812（`375x812x3,mobile,touch`）过一遍：顶栏按钮无重叠无重复、输入条容器撑满、聚焦展开两行、软键盘 Enter 发送；桌面 1440 输入区居中 820px、顶栏无重复按钮。注意 `enterKeyHint="send"` 的软键盘键位在真机才真实——视口模拟下用 `e.key==="Enter"` 的语义验证。
5. **对照 demo 镜像**：`demo/components/ChatInput.tsx` 等是完整上游版——主组件与镜像在同一段结构上形态不一致时，默认是合并裁决失误（模式 B 的发现途径）。

## 三、行级核对工具与防回归钉索引

`scripts/check-upstream-merge.mjs`（`--base <sha> --upstream <sha|引用>`，`--file` 追加单文件）：列出上游自 merge-base 以来的净新增行中、工作区缺失的行。输出是**候选清单**——fork 有意改写（providerName 映射、StreamingActionButton、自绘顶栏、微信式发送…）也会出现，逐条定性即可；但**每一条都必须有明确归属**，不允许「没看」。

各回归模式对应的钉测试（红时按 §〇 对号入座）：

| 钉 | 抓什么 |
|---|---|
| `AppShell.topbar-dedup.test.mjs` | 模式 A：顶栏 helper 调用点计数（剥注释后统计，注释里的提及不误报）+ session stats/trust 钉 |
| `ChatInput.composer-shrink-chain.test.mjs` | 模式 B：收缩链五点存在性（缺一即红，错误消息写明缺哪点、塌成什么样） |
| `ChatInput.mobile-send.test.mjs` | 模式 D：微信式发送形态 + 上游 bug 形态 doesNotMatch + enterKeyHint 一致性 + acceptShortcut（IME/菜单接受键）形态 |
| `AppShell.mobile-toolbar.test.mjs`（upstreamStructSkip + [fork] 块） | 上游结构断言在 fork 语义下的映射；skip 条件因合并引入上游结构而失效时上游断言会照跑 |
| `ChatWindow.extension-request.test.mjs` | 模式 C 的合规样例：**唯一形态钉 + 旧形态 doesNotMatch**（曾放宽双形态接住错误融合，2026-11 收紧为单形态） |
| `lib/i18n-keys.guard.test.mjs` | i18n 合并事故（重复键/键丢失/fork 语义文案被上游覆盖）+ fork 缩短文案的单行长度帽（`FORK_MAX_KEY_LENGTH`，如英文 placeholder） |
| `MobilePwaLayout.test.mjs` | viewport/safe-area 契约（`--app-viewport-height`、顶栏高度令牌化、键盘开启行为） |
| `AppShell.mobile-toolbar.test.mjs` 的 `[fork]` 块 + `AppShell.mobile-*` 家族 | 上游移动端结构断言在 fork 语义下的映射钉（ Agents beside More、covered 五件套、⋯ 层不因动作关闭等） |

钉测试纪律细节（红时先问代码错还是测试过时、放宽只能加形态不能换形态、新融合区必留钉）见各钉文件头注释与 §〇-C。
