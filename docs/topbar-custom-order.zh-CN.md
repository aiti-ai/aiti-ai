# 需求文档：顶栏工具按钮自定义排序 + 隐藏 + 间隔分组 + 溢出"⋯"更多下拉

> 状态：✅ 已实施并验证（dev 实例 /dev/，真实浏览器 DevTools 验证通过；实施细节见 §6.5）
> 仓库：`/home/pi/workspace/pi-web`（pi 的 Web UI，Next.js + React，dev 端口 30142，systemd service：`pi-web-dev`，改动后 `sudo systemctl restart pi-web-dev` + 浏览器强制刷新生效）
> 涉及文件：`components/AppShell.tsx`（顶栏全部逻辑）、`lib/i18n/messages/{en,zh-CN}.ts`（新增文案）、新增 `lib/topbar-order.ts`（纯逻辑，便于单测）
> **设计原则：机制与屏幕大小无关，不区分大/小屏**——排序、隐藏、间隔、溢出→"⋯"在所有尺寸下完全一致。屏幕窄或扩展按钮多（桌面窄窗同样会发生）只是触发同一机制的客观条件。

---

## 0. 完整性审查结论（对照代码逐条核实）

| # | 发现的问题 | 修正 |
|---|---|---|
| 1 | resolve 把隐藏按钮从顺序中剔除 → 排序面板看不到隐藏项，**恢复入口丢失** | resolve 改为返回 `order`（含隐藏按钮、保持原位，供面板）+ `visible`（剔除隐藏，供渲染）双列表（§4.1） |
| 2 | 扩展 id 类型写成 `ext:${string}`，与真实 id（`aiti-devtools:aiti-inspect`）不符 | 类型改为内建联合 + `string`，注释说明（§4.1） |
| 3 | 面板类按钮（语言/系统/分支）被收进"⋯"后：`languageBtnRef` 指向 `display:none` 副本（矩形为 0）；且"⋯"内点击必须先关"⋯"，但 `moreOpen` 与 `activeTopPanel` 是独立 state，无互斥 | ① 互斥规则：开"⋯"关面板、开面板关"⋯"；②"⋯"内按钮点击先 `setMoreOpen(false)` 再执行动作；③ 溢出状态下语言面板锚点改锚"⋯"按钮（§4.4） |
| 4 | 全局 Esc 只停 agent（`useKeyboardShortcuts`），无关闭下拉逻辑；两者可能同时触发 | 下拉打开时 Esc 关闭下拉（capture 阶段 stopPropagation，不干扰停 agent），其余场景保持现状（§4.4） |
| 5 | render 期读 localStorage 会造成 hydration mismatch（SSR 无 window） | order/hidden 初值为默认，`useEffect` 挂载后读取（与 `useResizablePanel` 恢复宽度同模式）（§4.1） |
| 6 | 间隔归一化只做一遍会漏 `[间隔, A(隐藏), 间隔]`：A 隐藏后 visible 变 `[间隔,间隔,...]` 需再合并 | **双遍归一化**：先对含隐藏的 order 归一化（隐藏按钮在场可锚定间隔，面板保位），剔除隐藏后对 visible **再归一化**（连续合并/行首行尾删除）（§4.1） |
| 7 | 同一扩展在 toolbar/sessionTopbar 两槽注册同 id → id 冲突 | AppShell 拍平时去重（保留首次出现）（§4.2） |
| 8 | 分支/系统/会话面板锚定 `topBarRef`（全宽下拉）不受溢出影响；BranchNavigator 行内副本 `display:none` 时其 fixed 下拉随祖先隐藏（display:none 移除整棵子树），不会出现双下拉 | 无需改动，§4.4/§5 记录即可 |
| 9 | 测量 effect 需防死循环（setState 无变化时不再触发） | `setOverflowIds` 仅在集合变化时调用（§4.3） |

---

## 1. 需求

1. **用户可自行调整 pi-web 顶栏工具按钮的位置/顺序**（跨刷新持久化）。
2. **用户可以隐藏不用的按钮**（从顶栏与"⋯"中彻底移除，可随时恢复，跨刷新持久化）。
3. **用户可以在任意两个按钮之间插入"间隔"**（间隔条/分隔线），实现视觉分组（跨刷新持久化）。
4. **按用户顺序展示可见按钮**；**空间不够时**（不论什么屏幕宽度——窄窗桌面、移动端、扩展按钮多的大屏都会发生），放不下的按钮收进**竖排三点"⋯"更多下拉**。
5. 顺带统一现状：移动端已有的专用"⋯"菜单（导出 prompts / 生成标题 / 系统提示词）并入新的通用溢出机制；删除小屏专属的拖拽横向滚动。

## 2. 现状分析（`components/AppShell.tsx` 顶栏）

顶栏当前按钮（DOM 顺序，~L1020–1620）：

| # | 按钮 | 说明 | 可排序？ | 可隐藏？ |
|---|---|---|---|---|
| 1 | 侧栏开关 | 布局关键，永远最左 | 否（固定） | 否 |
| 2 | 主题切换 | | 是 | 是 |
| 3 | 语言 | 下拉面板（`languageBtnRef` 锚点） | 是 | 是 |
| 4 | 服务（globe） | | 是 | 是 |
| 5 | `<ExtSlot name="toolbar"/>` | 扩展注册的按钮（aiti-devtools：🧰 AITI、🔍 等，id=`extId:itemId`） | 是 | 是 |
| 6 | 项目信任告警（橙色盾） | 上下文告警，出现时机不可控 | 否（固定） | 否 |
| 7 | 完整历史 | showChat 时 | 是 | 是 |
| 8 | 导出 prompts | showChat + **桌面**（`!isMobile`） | 是 | 是 |
| 9 | 生成标题 | showChat + **桌面** | 是 | 是 |
| 10 | BranchNavigator（内联） | showChat，`containerRef={topBarRef}` 锚定 | 是 | 是 |
| 11 | 系统提示词 | showChat + **桌面** | 是 | 是 |
| 12 | "⋯" 更多菜单（移动专用） | 导出/标题/系统三行 | — | — |
| 13 | `<ExtSlot name="sessionTopbar"/>` | 扩展会话级按钮 | 是 | 是 |
| 14 | 会话统计（右对齐，`marginLeft:auto`） | 信息展示，右端锚点 | 否（固定） | 否 |

外加右上角 fixed 的**文件面板开关**（`position:fixed`，顶栏已 `paddingRight:44` 防遮挡）。

**当前小屏方案**：`overflowX:auto` + 拖拽横向滚动（commit `fb72605`）——按钮可以全部拖出来看到，但：不可排序、不可隐藏、无间隔、拖拽与点击易误触、且完全依赖"滚动"而非"收纳"。本次方案将**替换**拖拽滚动，改为统一的"溢出→⋯ 下拉"。

## 3. 方案总览（统一机制，无屏幕分支）

```
顶栏（flex，overflowX:hidden）
├─ [固定] 侧栏开关
├─ [固定] 信任告警（如有）
├─ itemsRow  ← flex:1 minWidth:0 overflowX:hidden position:relative
│    └─ 按 visible 顺序渲染（flexShrink:0；放不下的 display:none）
│        └─ 条目类型：按钮 / 间隔条（竖线分隔符）
├─ [固定] "⋯" 更多按钮（恒常渲染，右端、会话统计左侧）
└─ [固定] 会话统计（最后，靠 marginLeft:auto 顶右）
```

- **条目模型**：顶栏条目分两类——**按钮**（`{ id, label, render }`）与**间隔**（布局 token `"sep"`，渲染为竖线分隔符，可重复出现）。默认序 = 当前 DOM 序（无间隔）；用户自定义序存 `localStorage["pi-topbar-order"]`（`string[]`，可含任意个 `"sep"`），隐藏集存 `localStorage["pi-topbar-hidden"]`（`string[]`，只含按钮 id）。
- **溢出测量**：`useLayoutEffect` 对 itemsRow 内可见条目逐条量 `offsetLeft + offsetWidth` vs `clientWidth`，超出的记入 `overflowIds`，行内 `display:none`。**间隔条不进入"⋯"**（无点击语义，溢出时直接不渲染）。测量与屏幕宽度无关——任何宽度下放不下的都进"⋯"。
- **单一入口**："⋯"按钮在所有尺寸下恒常渲染（"更多 + 自定义"的统一入口）；下拉内容 = 溢出**按钮**（若有）+ 底部"自定义顺序"行（恒有）。
- **删除**：拖拽滚动 effect、移动 `moreOpen` 专用菜单、export/title/system 的 `!isMobile` 守卫（改由测量决定）。

## 4. 详细设计

### 4.1 条目模型、默认顺序与持久化

新增 `lib/topbar-order.ts`（纯逻辑，SSR 安全，可单测）：

```ts
export const TOPBAR_ORDER_KEY = "pi-topbar-order";
export const TOPBAR_HIDDEN_KEY = "pi-topbar-hidden";
export const SEPARATOR = "sep";              // 间隔 token，可重复出现

/** 内建按钮 id */
export type BuiltinTopbarId =
  | "theme" | "language" | "services"
  | "history" | "export" | "title" | "branch" | "system";
/** 任意 id：内建或扩展注册 id（形如 "aiti-devtools:aiti-inspect"） */
export type TopbarItemId = BuiltinTopbarId | (string & {});

export const DEFAULT_TOPBAR_ORDER: TopbarItemId[] = [
  "theme", "language", "services",
  // ↑ 此处由 AppShell 插入 ExtSlot toolbar 的条目（按注册序）
  "history", "export", "title", "branch", "system",
  // ↑ 此处由 AppShell 插入 ExtSlot sessionTopbar 的条目
];

/** 读用户顺序（容错：非数组/坏 JSON → null）；可含任意个 SEPARATOR */
export function readTopbarOrder(): Array<TopbarItemId | typeof SEPARATOR> | null;
export function writeTopbarOrder(order: Array<TopbarItemId | typeof SEPARATOR>): void;
/** 读隐藏集（容错同上 → null 视为空集） */
export function readTopbarHidden(): TopbarItemId[] | null;
export function writeTopbarHidden(hidden: TopbarItemId[]): void;

/**
 * 合并 + 双遍间隔归一化。
 * 第 1 步 merge：用户序在前的 id 按用户序排，之后按默认序追加；
 *   SEPARATOR 原样保留（可重复）；用户序/隐藏集中已不存在的按钮 id
 *   （扩展被卸载等）滤除。
 * 第 2 步 归一化（派生，不落盘）：对含隐藏按钮的 order 做三道清理——
 *   行首间隔删除 / 行尾间隔删除 / 连续间隔合并（隐藏按钮在场可锚定间隔，
 *   因此 [间隔, A(隐藏), 间隔] 在 order 里保持两个间隔，面板如实展示）。
 * 第 3 步 派生 visible：order 剔除隐藏按钮，并对结果**再归一化**一遍
 *   （剔除隐藏可能制造新的行首/行尾/连续间隔，如 [间隔,A(隐藏),间隔]→
 *   [间隔,间隔]→合并为 [间隔]）。
 * 归一化只作用于返回值，不改写 localStorage：按钮回归时存储里的
 * SEPARATOR 与按钮 id 各就各位，resolve 自动还原原始布局。
 */
export function resolveTopbarLayout(
  custom: Array<TopbarItemId | typeof SEPARATOR> | null,
  hidden: TopbarItemId[] | null,
  availableIds: TopbarItemId[],
): {
  /** 面板用完整顺序：含间隔与隐藏按钮（隐藏按钮保持原位，灰显展示） */
  order: Array<TopbarItemId | typeof SEPARATOR>;
  /** 渲染用顺序：order 剔除隐藏按钮后再归一化（供 itemsRow 与"⋯"） */
  visible: Array<TopbarItemId | typeof SEPARATOR>;
  /** 当前隐藏集（已滤除失效 id） */
  hidden: TopbarItemId[];
  isDefault: boolean;
};
```

要点：
- **顺序/隐藏/间隔三者正交**：隐藏不消费顺序槽位——按钮保留在存储 order 中，仅不渲染；恢复显示后回到原位（面板可见原位）。间隔不参与隐藏（只能移除，见 §4.5）；间隔不占用按钮 id。
- **hydration 安全**：`readTopbarOrder/readTopbarHidden` 只在**浏览器挂载后的 useEffect** 中调用（初值为默认序/空隐藏集），与 `useResizablePanel` 恢复宽度同模式，避免 SSR hydration mismatch。
- **持久化只存 id / token，不存 render**——扩展热重载/版本升级后 id 不变即可继续复用。
- 与现有持久化模式一致（`pi-sidebar-width` / `pi-right-panel-width` / `pi-sound-enabled` 均 localStorage）。

### 4.2 AppShell 内条目构建

顶栏 render 时把按钮改造成条目数组：

```tsx
type TopbarEntry =
  | { kind: "button"; id: TopbarItemId; label: string;
      render: (ctx: { visible: boolean }) => ReactNode }
  | { kind: "separator" };                    // 渲染为竖线间隔

// 固定条目（不进 itemsRow）：
// 侧栏开关、信任告警、会话统计、"⋯"按钮 —— pinned，不参与排序/隐藏/溢出
```

- **按钮条目来源**：
  - 内建：theme / language / services / history / export / title / **branch** / system（**移除 `!isMobile` 守卫**，可见性完全交给测量与隐藏集）；
  - 扩展：`toolbar` 与 `sessionTopbar` 两个槽的条目拍平，id 沿用 ext-ui-store 已生成的 `extId:itemId`，**去重（保留首次出现）**；label 用 `meta.label ?? meta.title ?? id`（**自研扩展已全部补 `meta.label`，面板显示友好名称；面板行内复用真实渲染做图标预览**）。
- **渲染集合**：`visible`（供 itemsRow 与"⋯"）；**面板集合**：`order`（含隐藏按钮，灰显）。
- **间隔条目**：每个 `SEPARATOR` → `<div data-topbar-sep style={{ width:1, height:"55%", alignSelf:"center", background:"var(--border)", margin:"0 6px", flexShrink:0 }}/>`（竖线分隔，比纯留白更有"分组"语义）。

### 4.3 溢出测量（替换拖拽滚动，与宽度无关）

- itemsRow 结构：`flex:1; minWidth:0; overflowX:hidden; position:relative`（`position:relative` 使 `offsetLeft` 以行为基准）。
- 每个条目 `flexShrink:0`，行内先全部渲染（隐藏按钮不渲染；间隔条参与测量）。
- `useLayoutEffect`（**layout 阶段执行，浏览器绘制前完成，首帧无"全部按钮闪现再收起"**）：
  ```ts
  // 依赖：visible 列表 join、showChat、扩展版本号（useExtSlotItems 变化）、isMobile
  const cutoff = row.clientWidth - 4;      // 4px 容差
  const next = new Set<string>();
  for (const el of row.children) {
    if (el.offsetLeft + el.offsetWidth > cutoff) {
      if (el.dataset.topbarId) next.add(el.dataset.topbarId);   // 按钮
      // 间隔条（data-topbar-sep）不记入，直接由渲染方根据其位置处理（见下）
    }
  }
  if (changed(next, overflowIds)) setOverflowIds(next);          // 防死循环：集合变化才 setState
  ```
- **间隔条的溢出处理**：测量循环把"超出 cutoff 的间隔条"标记为隐藏（单独 state `overflowedSepIndexes` 或并入渲染判断：visible 列表中截止到最后一个可见按钮的元素）。简化实现：渲染时把 visible 列表**截断**——`const cutoffIndex = 最后一个 offsetLeft+width ≤ clientWidth 的条目的下标`，visible 截断为 `[0..cutoffIndex]`，截断部分即溢出集（按钮进"⋯"，间隔条丢弃）。该实现更稳（避免逐元素 display 抖动），**推荐**。
- 触发重测：行 ResizeObserver（窗口缩放、会话统计宽度变化会连带影响可用宽）+ visible/顺序/隐藏变化。**窗口缩放是最主要的触发源，任何宽度下同一套逻辑生效。**
- **固定右簇不参与测量**："⋯"/统计在 itemsRow 外，`flex:1` 已自动扣除它们的宽度。
- 删除：`overflowX:auto` → `hidden`；删除 `topbar-scroll/topbar-dragging` 拖拽 effect 与相关 CSS（`.topbar-scroll*`）、`el.addEventListener("scroll", update)`（顶栏不再滚动）；保留 `paddingRight:44` 防遮挡。

### 4.4 "⋯" 更多下拉（唯一入口，恒常渲染）+ 面板类按钮的锚点规则

- 按钮：现有竖排三点 svg，位于会话统计左侧（右端锚点旁）。**任何屏幕尺寸下都渲染**——它是"更多 + 自定义"的统一入口：有溢出时收纳溢出按钮，无溢出时仍能进入自定义/隐藏/间隔面板。不会出现"某个宽度下入口消失"的盲区。
- **互斥规则**：`moreOpen` 与 `activeTopPanel` 交叉关闭——打开"⋯"时 `setActiveTopPanel(null)`；打开任一顶栏面板时 `setMoreOpen(false)`。
- 下拉内容：
  1. 溢出**按钮**（`visible` 截断段，按最终顺序渲染，`mobileMoreItemStyle` 样式复用；**间隔条不出现**）；
  2. 溢出条目与自定义行之间加分隔线；
  3. 底部固定"**自定义顺序**"行 → 打开排序/隐藏/间隔面板（`setMoreOpen(false)` 后开面板）。
- **"⋯"内按钮的点击**：统一包装 `onClick={() => { setMoreOpen(false); 原动作(); }}`——先关"⋯"再执行（含面板类按钮、对话框、主题切换等）。
- **面板类按钮锚点规则**（防 0 尺寸矩形）：
  - 系统/分支/会话统计面板：锚定 `topBarRef`（全宽下拉），与按钮位置无关——**溢出不受影响**；
  - 语言面板（桌面特殊定位锚 `languageBtnRef`）：若语言按钮在溢出集（行内 `display:none`），`getBoundingClientRect` 为 0 → **改锚"⋯"按钮的 rect**（`moreBtnRef`），左对齐/贴近"⋯"；行内正常时维持现逻辑。
  - BranchNavigator 行内副本 `display:none` 时其 fixed 下拉随祖先隐藏（`display:none` 移除整棵子树），仅"⋯"内副本展示，**不会出现双下拉**。
- 关闭：backdrop 点击 / **Esc（新增，见下）** / 触发某项后。已有 `moreOpen` state 改造复用。
- **Esc 集成**：新增 AppShell 内 window keydown 监听（capture 阶段）：当 `moreOpen || activeTopPanel` 打开时，Esc → 关闭下拉并 `stopPropagation()`（**不触发全局 Esc 停 agent**；`useKeyboardShortcuts` 的 Esc 逻辑保持现状——仅停 agent、放行 TEXTAREA/INPUT）。两个监听互不干扰。
- 无障碍：`aria-expanded` + `aria-haspopup`。

### 4.5 排序 + 隐藏 + 间隔面板（与屏幕大小无关）

- 入口：唯一——"⋯"下拉底部的"自定义顺序"行。
- 内容：**`order`（含隐藏按钮，隐藏行灰显 + 斜线眼睛）**按最终顺序列出，间隔条以"分隔行"呈现。每行：
  - **按钮行**：↑/↓ 按钮（触摸与鼠标通用，避免拖拽手势冲突）+ 标签（内建 `translate()`，扩展 `meta.label/title`）+ **眼睛切换**（显示/隐藏；**隐藏行保持在原位**，恢复即回到所见位置）；
  - **间隔行**：竖线图标 + "间隔"（`topbar.divider`）+ ↑/↓ 移动 + **✕ 移除**（间隔只可移除，不参与隐藏）；
  - 面板底部：**"＋ 添加间隔"** → 在列表末尾追加一个 `SEPARATOR`（随后用 ↑/↓ 移到目标位置）；**"恢复默认"** → 顺序回默认（无间隔）+ 清空隐藏集（`isDefault && hidden.length === 0` 时禁用）。
- 交互：任何操作即时生效并**写回 localStorage**（写回内容 = 面板当前 `order`——即含隐藏按钮、归一化后的完整列表；SSR 安全，写回函数在 lib 层）；关闭面板即完成。Esc/backdrop 关闭。
- 间隔的边界语义：间隔是布局 token——不占按钮 id、不进"⋯"、不参与隐藏；多个间隔允许（用户自己的分组选择）。
- 可选增强（本期不做）：拖拽排序、行内"在此按钮后插入间隔"、pin 到"更多"（条目级 `pinned` 标记机制已支持）。

### 4.6 现状清理（无屏幕分支）

- 删除 `isMobile &&` 专用"⋯"菜单块（`mobileMoreItemStyle` 常量保留复用，`moreOpen` 逻辑并入通用"⋯"）。
- export/title/system 按钮移除 `!isMobile` 守卫 → 作为普通条目，由测量 + 隐藏集决定。
- 删除顶栏拖拽横向滚动 effect、`.topbar-scroll` CSS、顶栏 scroll 监听。
- BranchNavigator 的 `compact` 视觉属性保留（只是文案/图标疏密），不影响溢出/隐藏逻辑。

### 4.7 i18n 新增 key（`en.ts` / `zh-CN.ts`）

| key | zh-CN | en | 用途 |
|---|---|---|---|
| `topbar.customize` | 自定义顺序 | Customize toolbar | "⋯"底部入口 + 面板标题 |
| `topbar.theme` | 主题 | Theme | 面板内主题行标签（复用 `theme.light/dark` 只描述切换） |
| `topbar.reset` | 恢复默认 | Reset order | |
| `topbar.moveUp` | 上移 | Move up | |
| `topbar.moveDown` | 下移 | Move down | |
| `topbar.show` | 显示 | Show | 眼睛按钮 |
| `topbar.hide` | 隐藏 | Hide | 眼睛按钮 |
| `topbar.hidden` | 已隐藏 | Hidden | 隐藏行灰显提示 |
| `topbar.divider` | 间隔 | Divider | 间隔行标签 |
| `topbar.addDivider` | 添加间隔 | Add divider | |
| `topbar.removeDivider` | 移除间隔 | Remove divider | |
| （复用现有 key） | | | 语言=`common.language`、服务=`common.services`、历史=`history.label`、导出=`history.exportPrompts`、标题=`title.generate`、分支=`i18n.branches`、系统=`system.label`、更多=`common.more` |

## 5. 边界情况

| 场景 | 处理 |
|---|---|
| 扩展异步注册（mount 后） | 条目列表变化 → 触发重测 + resolve 合并，新条目默认序追加尾部（且默认可见） |
| 用户序/隐藏集引用已卸载扩展的 id | `resolveTopbarLayout` 滤除，不残留脏数据；SEPARATOR 始终有效 |
| localStorage 损坏 | 读失败回退默认序 + 空隐藏集；hydration 在 useEffect 完成，无 SSR mismatch |
| 桌面窄窗 / 扩展按钮多（大屏溢出） | 与移动端同一套测量与"⋯"下拉，无特判 |
| 用户隐藏全部按钮 | 顶栏只剩固定项（侧栏开关 + "⋯" + 统计），入口仍在，可随时恢复（面板中灰显行点击眼睛） |
| 添加多个间隔 | 允许，均为独立 token，可分别移动/移除 |
| 连续间隔（中间按钮被隐藏 / 扩展未加载 / showChat 未渲染） | 双遍归一化：面板 order 保位展示（两个间隔中间是灰显按钮，语义清晰）；顶栏 visible 只显示一个 |
| 面板类按钮（语言/系统/分支）在"⋯"内 | 锚点规则（§4.4）：系统/分支/会话全宽锚顶栏；语言锚"⋯"按钮；点击先关"⋯" |
| BranchNavigator 双副本 | 行内副本 `display:none` → 其 fixed 下拉随祖先隐藏，仅"⋯"副本展示，无重复 |
| 同一扩展两槽注册同 id | AppShell 拍平去重（保留首次） |
| 极窄（<400px） | itemsRow 可能只剩极少空间，绝大部分进"⋯"；"⋯"/统计固定不溢出；间隔溢出直接不渲染 |
| 会话统计宽度变化 | ResizeObserver 覆盖（行宽连带变化） |
| 无会话（showChat=false） | history/export/title/branch/system/会话统计不渲染，条目列表变化自动重测 |
| 溢出条目重复渲染（行内 display:none + 下拉一份） | 仅按钮进下拉，无 `id`/`htmlFor` 冲突；扩展按钮为纯组件（props 驱动），可接受 |
| Esc | 下拉/面板打开时 capture 阶段拦截关闭（stopPropagation，不误停 agent）；未打开时保持现有全局 Esc 语义 |
| 无障碍 | "⋯" `aria-expanded` + `aria-haspopup`；面板 `role=menu/menuitem`；眼睛按钮 `aria-pressed` + title |

## 6. 实施步骤

1. `lib/topbar-order.ts`（新增）：常量（含 `SEPARATOR`）+ order/hidden 读写 + `resolveTopbarLayout`（merge + 双遍归一化）纯函数。
2. `lib/topbar-order.test.mjs`（新增）：merge/容错/滤除/隐藏-恢复保位/间隔 token 保序/**双遍归一化**（行首行尾删除、连续合并、隐藏按钮锚定的间隔在 visible 中正确合并、按钮回归后还原）单测。
3. `components/AppShell.tsx`：
   - 顶栏改造为条目数组渲染（按钮 + 间隔）；移除 `!isMobile` 守卫；BranchNavigator 入列；
   - itemsRow + 溢出测量 effect（截断式）；删除拖拽滚动 effect、`.topbar-scroll` CSS、scroll 监听、`overflowX:auto`→`hidden`；
   - 通用"⋯"下拉（溢出按钮 + 自定义入口，间隔不进）+ 互斥 + "⋯"内按钮先关再执行 + 语言锚点规则；
   - 排序 + 隐藏 + 间隔面板（↑/↓ + 眼睛切换（含灰显原位恢复）+ 添加/移除间隔 + 恢复默认）；
   - Esc 关闭下拉（capture 拦截）。
4. `lib/i18n/messages/{en,zh-CN}.ts`：新增 §4.7 keys。
5. 验证（§7）；`node_modules/.bin/tsc --noEmit` + lint。

> 注意：pi-web 工作区当前有**无关的未提交改动**（ChatWindow/MarkdownBody/MessageView/QuoteReplyPopover/lib/quote-reply.ts），实施时不要触碰这些文件。

## 6.5 实施落地记录（实现时的偏差与细节，2026-08）

> 已实施并验证（dev 实例 /dev/，real 浏览器 DevTools 验证）。以下为与 §4 方案的偏差/确认：

1. **测量从"行内全渲染 + visibility 隐藏"改为"行内只渲染放得下的 + 离屏 measure strip"**（§4.3 的实现选择）：itemsRow 渲染 `visible.slice(0, cutoffIndex+1)`，离屏 strip（`left:-100000`、`visibility:hidden`、`pointer-events:none`、`aria-hidden`）渲染全部 visible 条目用于量宽。无 visibility 翻转、无重复可交互元素，更稳。**strip 副本必须去掉可交互副作用**：语言按钮在 strip 中不挂 `languageBtnRef`（否则锚点矩形跑到离屏 -98k 处）——`renderTopbarItem(id, inRow, forMeasure)` 三态。
2. **扩展条目必须按 React 元素渲染**（`<ExtComponent {...props}/>`，而非函数直调 `item.render(props)`）：aiti-devtools 等扩展组件内部用 `ctx.useState/useEffect`，直调会把 hooks 注入 AppShell 的 hook 序 → 异步注册后报 "Rendered more hooks than during the previous render"。已修。
3. **"添加间隔"插到最后一个按钮之前**：追加在末尾会被尾部间隔归一化（§4.1）删掉、用户看不到——改为在最后一个按钮前插入（两按钮之间，立即显示，用户再用 ↑/↓ 移动）。
4. **BranchNavigator 增加 `buttonHidden` prop**（§4.4 锚点规则的实现）：分支溢出时，"⋯"菜单行是普通按钮（先关"⋯"再 `toggleTopPanel("branches")`），下拉面板由顶栏级 host（`<BranchNavigator buttonHidden .../>`，仅渲染 fixed 下拉、锚 `topBarRef`）承载——避免"⋯"关闭后面板无宿主。行内副本（若在行内）保持原逻辑。
5. **间隔归一化语义确认**：连续间隔**总是**合并（按钮之间也合并）；自定义序末尾的间隔在默认尾巴追加后成为"按钮间间隔"（存活），只有真正的行首/行尾/连续被清理。
6. **Esc**：capture 阶段 `stopPropagation` 关闭下拉/面板，不触发全局 Esc 停 agent（已验证）。
7. **联动验证**：desktop 900px / 375px mobile 下溢出→⋯、⋯→分支面板、⋯→语言面板（锚点回退）、顺序/隐藏/间隔持久化（刷新保持）、恢复默认、连续间隔合并均通过；console 无 React/hook 错误。

## 7. 验证清单

- `npm run dev`（30142）：
  - 桌面宽屏（无溢出）：按钮按序展示；"⋯"存在，下拉只有"自定义顺序"行；调序（如把"服务"移到最前）即时生效；**刷新后顺序保持**；"恢复默认"还原。
  - **隐藏/恢复**：面板内隐藏"生成标题"→ 顶栏与"⋯"中都不再出现，刷新后仍隐藏；**面板中灰显行仍显示在它原来的位置**，点击眼睛恢复 → 回到原位；全部隐藏 → 顶栏只剩固定项但入口可用。
  - **间隔分组**：在"主题/语言"之间添加间隔 → 顶栏出现竖线，视觉分组生效；间隔可 ↑/↓ 移动、✕ 移除、可添加多个；**刷新后间隔保持**；窄窗时间隔随行溢出直接消失（不进"⋯"）；"恢复默认"清除全部间隔。
  - **连续间隔合并**：添加"间隔-按钮-间隔"后隐藏中间按钮 → 顶栏只显示**一个**间隔；恢复中间按钮 → 两个间隔回到原位、布局还原；行首/行尾的间隔不显示。
  - **面板类按钮溢出**：把"语言"排到最后并收窄窗口 → 语言进"⋯"；从"⋯"点语言 → 面板在"⋯"旁正确展开（非 0 尺寸）；系统/分支从"⋯"打开 → 全宽面板正常；各面板与"⋯"互斥（开一个关另一个）。
  - **Esc**：面板/"⋯"打开时按 Esc → 关闭且不误停 agent；无下拉时 Esc 停 agent 行为不变。
  - **桌面窄窗 / 拖动窗口变窄**：放不下的按钮按序收进"⋯"，顺序正确、点击可用；拉宽窗口自动回到行内——**与移动端完全同一套逻辑**。
  - 移动设备模拟：同上行为，无特判。
  - 扩展参与：aiti-devtools 的 🧰/🔍 按钮出现在列表与面板中，可排序、可隐藏、可溢出、可进"⋯"。
  - 回归：语言/服务/系统/分支/会话统计面板定位（行内正常态不动）；文件面板开关右上角无遮挡；首帧无按钮闪现。
- `node_modules/.bin/tsc --noEmit`、`npm run lint`、`node --test lib/topbar-order.test.mjs`。
