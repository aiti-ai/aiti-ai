---
name: ext-create
title: 用本模板创建新扩展
placeholder: 描述你想创建的扩展（如：创建一个在会话顶栏显示服务器状态的扩展）…
summary: 完整创建流程——复制模板、改 index.ts/vite.config、写 client 组件、构建、部署、生效
---

# ext-create · 用 ext-jsx-client 模板创建新扩展

你是本模板（ext-jsx-client）的向导。用户描述一个新扩展需求，你按下面完整流程创建。
模板让扩展 client 能用 **JSX + TypeScript + npm 依赖**（vite lib mode 构建，产物是宿主
能 `import()` 的单个 `.mjs`；`react` 经 host-shim 委托宿主 `h/useState/…`，零 React 引用）。

## 信息源（先读这些再动手）

- **本模板源码（安装后即当前扩展目录）**：`client/src/entry.tsx`、`vite.config.ts`、
  `tools/build-client.mjs`、`README.md`——以下 `client/` 均指当前扩展的 `client/`。
- **已安装参考**：`GET {basePath}/api/extensions` 列出已装扩展；demo 扩展若已装，
  可参考其 `client/` 产物结构与 `skills/`（JSX client + skills 双演示；顶栏 ⚛️ 按钮）。
- **扩展根（部署目标）**：`~/.pi/web/extensions/<id>`（生产）、`~/.pi/web-dev/extensions/<id>`（dev）
- **生效**：`POST {basePath}/api/extensions/reload`（热重载 server 端；client 改动刷新页面即拉新——注入脚本带内容哈希）

> 开发者源码参考（**仅源码仓库环境**，安装目录不可访问）：`pi-web-ext/demo/`（可运行例子）、
> `pi-web-ext/templates/ext-jsx-client/`（模板源）、方案文档 `pi-work/docs/aiti-ext-jsx-vite-plan.md`。
> 安装环境的 AI 用上面 `{basePath}` 的 API 拿信息，不依赖这些源码路径。

## 创建流程（照做）

### 1. 复制模板（开发者从源码仓库复制）

模板源码在 pi-web 仓库的 `pi-web-ext/templates/ext-jsx-client/`（**源码环境**）。创建新扩展：

```bash
cd <pi-web 仓库>/pi-web-ext && cp -r templates/ext-jsx-client <your-ext>
```

### 2. 新建 index.ts（模板没有；扩展元数据 + server + ui）

```ts
export default {
  id: "your-ext",                       // 与目录名一致
  name: "你的扩展名",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/<your-ext>-client.mjs",  // ← 必须 = vite.config.ts 里 build.lib.fileName 的产物（产物统一 dist/）
  ai: { manage: true, intro: "一句话：AI 能帮我做什么", skills: "skills" }, // 可选：加 AI 帮助点
  server: { /* 需要服务端 api 时写（jiti 加载，可用 npm 包） */ },
  ui: { toolbar: [...], dialogs: [...], i18n: { "en": {...}, "zh-CN": {...} } }, // 声明的插槽与 client registerItems 对应
}
```

### 3. 改 vite.config.ts

- `build.lib.entry` → 你的入口（或留模板默认）
- `build.lib.fileName` → `"<your-ext>.mjs"`（**必须与 index.ts 的 client 字段一致**，否则 404）
- 其余（`esbuild.jsx: "automatic"`、alias 正则、`rollupOptions.external: []`）**别动**

### 4. 写 client 组件（client/src/entry.tsx 或拆多个文件 import）

- `register(ctx)` 里 `__setCtx(ctx)` 放**第一行**（任何 JSX 组件渲染前）
- `ctx.registerItems("toolbar", [{ id, render, meta }])` / `("dialogs", [{ id, render, meta }])` 注册插槽（与 index.ts 的 ui 声明对应）
- **纯入口型工具条条目优先用声明式**（外观归宿主，不自绘按钮）：`registerItems("toolbar", [{ id, meta: { label, title, icon, onClick } }])`——`icon` 三形态 `{ svg: "<path …/>" }`（24×24 lucide 线条标记）/ emoji / `"icon.svg"`；无 render 时宿主渲染标准 36×36 灰度按钮。详见 aiti-docs `docs/devtools/extension-points.md`「toolbar 声明式条目」
- 组件 `import { useState, useEffect } from "react"` → vite alias 委托宿主（**别引真 React**）
- 关闭按钮带 `aria-label="关闭"`（aiti-helper 全局 AI 按钮靠它注入到关闭按钮左边）
- 弹窗 DialogsSlot 的 onClose 绑真实状态（`onClose={() => setPanelOpen(false)}`），**别传空函数**（否则关闭失效）

### 5. 加 npm 依赖

- 页面用到的 npm 包 → package.json `dependencies`（vite 构建会**内联进产物**）
- 构建工具 vite → devDependencies（模板已有）
- `npm install`

> `package.json` 的 `"aitiExtProtocol"` 字段必须保留（协议版本声明；规范 `docs/pi-web-ext-protocol.md`）——部署脚本记得把 package.json 拷进部署目录（协议检测/版本仲裁/依赖 reconcile 都读它）。

### 6. 构建

```bash
npm run build:client
```

产物 `dist/<your-ext>-client.mjs`。检查：产物里**零 React 引用、无裸 import**（`grep -c "react" 产物` 应为 0，qrcode 等应被内联）。

### 7. 部署 + 生效

```bash
node tools/deploy.mjs          # 模板只给了 build；deploy 参考 demo/tools/deploy.mjs（构建→拷贝两扩展根→git commit）
curl -X POST {basePath}/api/extensions/reload
```

### 8.（可选）AI 帮助点

`skills/index.json` 列你的 skill 名；每个 `skills/<name>/SKILL.md`（frontmatter：`name/title/summary/placeholder/outputs/action`，正文是给 AI 读的手册，可用 `{basePath}` 拼 API 路径）。index.ts 声明 `ai: { manage: true, ... }` 后 aiti-helper 自动聚合。已装扩展的帮助点可用 `GET {basePath}/api/extensions/aiti-helper/helpers` 查看（含 demo 的 demo-selfcheck/demo-humor 可作例子）。

## 坑速查（模板已踩平，勿回退）

1. **vite 默认 classic JSX** → 必须 `esbuild.jsx: "automatic"`，否则产物 `React.createElement` + React 未定义。
2. **alias 前缀匹配** → 用正则 `/^react$/`、`/^react\/jsx-runtime$/` 分开（字符串 alias 会吞 jsx-runtime）。
3. **lib mode 依赖默认外部化** → 必须 `rollupOptions.external: []` 才内联（浏览器才能跑裸包）。
4. **`__setCtx(ctx)` 最先调**，否则组件里 hooks 委托不到宿主。
5. **JSX `map()` / svg path 数组必须给 key**；host-shim 的 `jsxs` 已补 `_store.validated = 1`（静态兄弟元素假阳性 key 警告的抑制）——抄 host-shim 时别漏这段。
6. **关闭按钮 `aria-label="关闭"`**（裸文本"关闭"识别不了 → AI 按钮不注入）；DialogsSlot 的 onClose 别传空函数。
7. **只引浏览器安全的 npm 包**（如 qrcode 有 browser 字段）；node-only 的要 polyfill 或换实现。
8. **改源码后必须重建**（`npm run build:client`），否则页面无变化（同"注入脚本带内容哈希，刷新即拉新"）。

## 落地清单（创建完核对）

- [ ] `index.ts` 的 client 字段 == vite `fileName` 产物，一致
- [ ] 构建产物生成；reload 后浏览器能 import、页面无 console 报错
- [ ] 插槽（toolbar/dialogs/...）注册与 index.ts `ui` 声明对应
- [ ] 关闭按钮带 aria-label；onClose 绑真实状态；map 列表带 key
- [ ] 部署到 `~/.pi/web/extensions/<id>` + `~/.pi/web-dev/extensions/<id>` 并 reload
- [ ] （可选）skills/ 帮助点 + index.ts `ai` 声明，aiti-helper 聚合验证
