# 需求文档：修复 pi-web 两个 React 渲染问题

> 状态：可转交实施
> 仓库：`/home/pi/workspace/pi-web`（pi 的 Web UI，Next.js 16 + React 19，dev 端口 30142，systemd service：`pi-web-dev`）
> 两个问题**相互独立、互不影响**，可分开实施、分开验证。均与 aiti-devtools 无关。

---

## 1. 问题 1：markdown 表格 `<tr>` 内直接渲染 `<span>`（hydration error）

### 1.1 现象

agent 回复包含 markdown 表格时，浏览器 console 报错：

```
In HTML, <span> cannot be a child of <tr>.
This will cause a hydration error.
```

堆栈指向 `MarkdownBody → QuoteableParagraph (as="tr")`。

### 1.2 根因

`components/MarkdownBody.tsx` 的 `QuoteableParagraph`（第 171 行起）通过 `<Tag as={as}>`（第 273 行）渲染包裹节点，`as` 可为 `"p" | "li" | "tr"`。`tr` 渲染器（第 136–140 行）把整行包进 `QuoteableParagraph as="tr"`，于是 `<tr>` 的直接子元素除了 `<td>/<th>` 还包含：

1. **引用提示 tooltip**（第 282–303 行）：`{showTip && !segments && <span data-quote-tip …/>}`——`position: fixed`，但 DOM 上仍是 `<tr>` 的直接子节点；
2. **引用弹窗 `QuoteReplyPopover`**（第 307–318 行）：其根节点是 `<span>`（见 `components/QuoteReplyPopover.tsx` 第 ~80 行 `return (<span …>`），同样作为 `<tr>` 直接子节点。

HTML 规范 `<tr>` 只允许 `<td>/<th>/<script>/<template>` 子元素，React 在渲染/hydration 时对非法嵌套报上述警告。

> 说明：弹窗打开时同样违反嵌套规则（只是当前代码里提示 tip 是最先被 console 暴露的那个）。修复需**同时覆盖 tip 与弹窗**。

### 1.3 修复方案（推荐：Portal 到 `document.body`）

tip 与弹窗在 `as === "tr"` 时**已经是 `position: fixed`**（不参与表格布局、不产生幻影列，见第 210–230 行注释与 `floatPos` 逻辑）。因此把它们挂到 body 下是语义最干净、改动最小的方式：

```tsx
// MarkdownBody.tsx 顶部新增
import { createPortal } from "react-dom";

// QuoteableParagraph 渲染处：
// 仅 tr 变体走 portal；p/li 变体保持原状（弹窗是流内布局，不能 portal）
const overlay =
  as === "tr" && typeof document !== "undefined"
    ? (node: ReactNode) => createPortal(node, document.body)
    : (node: ReactNode) => node;
```

然后把 tip（第 282–303 行）与 `QuoteReplyPopover`（第 307–318 行）分别用 `overlay(...)` 包裹：

```tsx
{overlay(
  <>
    {showTip && !segments && (<span ref={tipRef} data-quote-tip …/>)}
    {segments && segments.length > 0 && (<QuoteReplyPopover …/>)}
  </>
)}
```

注意点：

- **SSR 守卫**：`createPortal` 只能在客户端创建（`typeof document !== "undefined"`）。tip/弹窗都是用户交互（mouseenter/click）后才出现，初始渲染为 `null`，SSR/首屏 hydration 不受影响。
- tip 的位置由 `tipRef` 指令式 style 控制、弹窗用 `floatPos` fixed 定位 + `scrollIntoView`（第 194–201 行）——挂到 body 后视觉与行为均不变。
- `getQuoteText()`（第 166–169 行）通过 `[data-quote-tip]` 过滤提示文本——portal 不影响 clone 逻辑，无需改动。
- **备选方案（不推荐）**：用 `cloneElement` 把 tip/弹窗注入第一个 `<td>`——需要克隆/遍历 children，破坏性大、容易与单元格内容冲突；portal 方案已覆盖其全部诉求。

### 1.4 验收标准

1. 让 agent 回复含 markdown 表格（例：`请给我一个包含 3 行数据的 markdown 表格`）→ 浏览器 console **无** `In HTML, <span> cannot be a child of <tr>` 警告；
2. 表格行 hover 仍显示引用提示 tooltip，点击行弹出引用弹窗，选择引用可正常插入输入框；
3. 表格列宽不受弹窗/提示影响（无幻影列）；
4. `<p>/<li>` 段落的引用功能回归正常（流内弹窗样式不变）。

---

## 2. 问题 2：session-manager 扩展 tag 输入 autocomplete 无限循环（Maximum update depth）

### 2.1 现象

编辑 tag 输入框（触发 autocomplete）时，浏览器 console 报：

```
Maximum update depth exceeded. This can happen when a component calls setState
inside useEffect, but useEffect either doesn't have a dependency array, or one
of the dependencies changes on every render.
```

### 2.2 根因

文件：`~/.pi/web/extensions/session-manager/client/session-manager.mjs`（独立扩展，**不在** pi-web 主仓库；经 `/api/extensions/session-manager` 加载）。`TopbarTags` 组件（约第 1490 行起）：

```js
const data = s.tagData ?? { version: 0, favoriteIds: [], tags: [], sessionTags: {} };  // ← 第 1498 行

// §3.4 autocomplete（第 1520–1531 行）
useEffect(() => {
  const q = input.trim().toLowerCase();
  if (!q || !editing) { setSuggestions([]); return; }
  const byId = byIdMap(data);            // ← 死代码（未使用）
  const all = data.tags.map((n) => ({ id: n.id, path: tagPath(n.id, data) }))
    .filter((x) => x.path.toLowerCase().includes(q))
    .slice(0, 8);
  setSuggestions(all);
}, [input, editing, data]);
```

循环成因链：

1. `store.tagData` 初始为 `null`（`useStore()` 返回稳定的模块级 store，但 `tagData` 在首次 `refreshTags()` 完成前 / 拉取失败后为 `null`）；
2. `s.tagData ?? {...}` 在 `tagData === null` 时**每次渲染都新建一个 fallback 对象** → `data` 引用每帧都变；
3. effect 依赖 `[input, editing, data]` → `data` 变化 → effect 每帧重跑 → `setSuggestions(all)`（**每次都是新数组引用**）→ 触发重渲染 → 步骤 2 再次成立 → 死循环 → Maximum update depth。

> 只要 `data` 引用不稳定，`setSuggestions` 的"新数组"必然导致循环；即使建议内容相同也会循环。

### 2.3 修复方案

**核心修复：稳定 `data` 引用（根因）。**

```js
// register(ctx) 解构处（第 18 行）补充 useMemo（ctx 已提供，见
// pi-web components/ExtSlots.tsx 的 ExtClientContext）：
const { h, useState, useEffect, useRef, useMemo, t, apiUrl } = ctx;

// TopbarTags 内（替换第 1498 行）：
const data = useMemo(
  () => s.tagData ?? { version: 0, favoriteIds: [], tags: [], sessionTags: {} },
  [s.tagData],
);
```

修复后 `tagData` 为 `null` 期间 `data` 是稳定引用，effect 只在 `input`/`editing` 真正变化时执行，不再反馈循环；`tagData` 加载完成后引用随之更新（触发一次正常重算）。

**可选加固：避免冗余 `setSuggestions`（每键击一次新数组 → 一次多余重渲染）：**

```js
setSuggestions((prev) =>
  prev.length === all.length && prev.every((x, i) => x.id === all[i].id && x.path === all[i].path)
    ? prev
    : all
);
```

参考：pi-web 主仓库 `components/ExtSlots.tsx` 的 `useChatHooks` 用 `useSyncExternalStore` 解决过同类"每帧新引用导致循环"问题——思路一致：**保证 effect 依赖与 setState 值的引用稳定**。

### 2.4 验收标准

1. 打开 session-manager 面板，进入 tag 编辑输入框并输入文字触发 autocomplete → console **无** `Maximum update depth exceeded`；
2. autocomplete 建议列表正常显示（最多 8 条、按输入过滤）、可点选，点选后填入输入框；
3. 首次进入面板（`tagData` 尚未加载完成）时编辑 tag 也不报错；
4. 建议内容相同（如反复增删同一字符）时**无多余重渲染/闪烁**；
5. 扩展其他功能（收藏、看板、tag 筛选、pending 新会话 tag）回归正常。

### 2.5 注意点

- 扩展是**独立目录**：改动直接编辑 `~/.pi/web/extensions/session-manager/client/session-manager.mjs`（无构建步骤），保存后浏览器**强制刷新**（`Ctrl+Shift+R`）即可生效；必要时 `sudo systemctl restart pi-web-dev`。
- 同文件第 285/332/624/1141/1335/1667 行存在相同的 `s.tagData ?? {...}` 不稳定 fallback 写法，但目前均为**纯渲染读取**（无 effect+setState 反馈），不会循环——本次**不要扩大改动范围**，仅在注释中标注即可；后续若在这些位置加 effect 需同样处理。
- 第 1524 行 `const byId = byIdMap(data);` 为 effect 内死代码，可顺手删除。

---

## 3. 实施与验证步骤（通用）

1. 按 §1.3 / §2.3 分别实施改动（两个文件互不相干）。
2. 主仓库改动：`node_modules/.bin/tsc --noEmit` + `npm run lint` 通过（**不要** `next build`，会污染 `.next/` 破坏 dev）。
3. 扩展改动：无类型检查步骤，保存即可。
4. `sudo systemctl restart pi-web-dev`（不要手动 kill + nohup，避免占用 30142 起冲突）。
5. 浏览器 `Ctrl+Shift+R` 强刷后按 §1.4 / §2.4 验收。

## 4. 参考资料

- 主仓库 `AGENTS.md`：运维约定（systemctl 重启、`.next-dev` 目录、隔离测试用 `PI_WEB_DIST_DIR`、强刷验证）。
- 扩展加载机制：`components/ExtSlots.tsx`（ctx 提供 `useMemo/useCallback`，扩展仅解构了一部分）、`lib/ext/types.ts`。
- 相关文件与行号：
  - `components/MarkdownBody.tsx`：`QuoteableParagraph` 171 行；`tr` 渲染器 136–140 行；tip span 282–303 行；弹窗 307–318 行；`getQuoteText` 166–169 行。
  - `components/QuoteReplyPopover.tsx`：根节点 `<span>`（约 80 行）。
  - `~/.pi/web/extensions/session-manager/client/session-manager.mjs`：register 解构 18 行；`TopbarTags` 约 1490 行；`data` fallback 1498 行；autocomplete effect 1520–1531 行。
