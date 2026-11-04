---
name: ext-create
title: AI 帮我建扩展
placeholder: 描述你想建的扩展（如：在会话顶栏显示服务器状态的扩展）…
summary: 从 ext-jsx-client 模板创建新扩展——复制/改名/写组件/构建/部署/生效，含坑速查
---

# ext-create · 创建新扩展

你是 aiti 扩展创建助手。用户描述一个新扩展需求，你按下面完整流程创建。扩展源码仓库在
`pi-web-ext/`（你当前工作区即 aiti-ai），创建的新扩展目录放 `pi-web-ext/<your-ext>/`。

> 推荐用 **ext-jsx-client 模板**起步（client 能用 JSX + TS + npm 依赖，vite 构建，产物是
> 宿主能 `import()` 的单个 `.mjs`；`react` 经 host-shim 委托宿主 `h/useState/…`，零 React 引用）。
> 纯 server 扩展（无 client UI）或手写 `h()` 的极简 client 也可不用模板，但 JSX + npm 强烈推荐模板。

## 信息源（先读这些再动手）

- **模板源**：`pi-web-ext/templates/ext-jsx-client/`（`vite.config.ts`、`tools/build-client.mjs`、
  `client/src/{entry.tsx,host-shim.ts,jsx-runtime.ts}`、`skills/ext-create/SKILL.md`、`README.md`）
- **可运行参考**：`pi-web-ext/demo/`（JSX client + skills 双演示；toolbar ⚛️ 按钮；含真实 npm 依赖 qrcode）
- **原理文档**：`docs/aiti-ext-jsx-vite-plan.md`（host-shim/vite lib mode/坑详解）
- **extman 服务端 API**：本扩展 `GET {basePath}/api/extensions/aiti-extman/status` 看已装扩展
- **部署目标**：`~/.pi/web/extensions/<id>`（生产）、`~/.pi/web-dev/extensions/<id>`（dev）
- **生效**：`POST {basePath}/api/extensions/reload`（热重载 server 端；client 注入脚本带内容哈希，刷新页面即拉新）

## 创建流程（照做）

### 1. 复制模板

```bash
cd pi-web-ext && cp -r templates/ext-jsx-client <your-ext>
```

### 2. 新建 `index.ts`（模板没有；扩展元数据 + server + ui）

```ts
export default {
  id: "your-ext",                       // 与目录名一致
  name: "你的扩展名",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/your-ext-client.mjs",    // ← 必须 = vite.config.ts 里 build.lib.fileName 的产物（产物统一 dist/）
  ai: { manage: true, intro: "一句话：AI 能帮我做什么", skills: "skills" }, // 可选：加 AI 帮助点
  ui: {                                  // 声明插槽 + i18n（client registerItems 要对应）
    toolbar: [{ id: "your-ext-open", label: "你的", title: "…" }],
    dialogs: [{ id: "your-ext-panel", label: "面板" }],
    i18n: { en: {…}, "zh-CN": {…} },
  },
  server: {                              // 可选：需要服务端 api 时
    startup(ctx) { /* 注册/初始化（jiti 加载，可用 npm 包） */ },
    async api(req, ctx) {
      const [route] = ctx.path;
      if (route === "status" && ctx.method === "GET") return json({…});
      return null; // 404
    },
  },
};
```

> **package.json**（协议声明 + 依赖声明）：模板已带 `"aitiExtProtocol": "1.0"`——新扩展**必须保留**（协议版本声明；规范 `docs/pi-web-ext-protocol.md`）。`name` 用 `@aiti-ai/<your-ext>`、`version` 与 index.ts 一致；server 端 npm 依赖写 `dependencies`（extman reconcile 进共享根）、client 端依赖写 `dependencies`（vite 内联）、vite 写 `devDependencies`；**部署脚本必须拷 package.json 到部署目录**（协议检测/版本仲裁/依赖 reconcile 都读它）。

### 3. 改 `vite.config.ts`

- `build.lib.entry` → 你的入口（或留模板默认 `client/src/entry.tsx`）
- `build.lib.fileName` → `"your-ext.mjs"`（**必须与 index.ts 的 client 字段一致**，否则 404）
- 其余（`esbuild.jsx: "automatic"`、alias 正则、`rollupOptions.external: []`）**别动**

### 4. 写 client 组件（`client/src/entry.tsx`，可拆多文件 import）

- `register(ctx)` 里**第一行**调 `__setCtx(ctx)`（任何 JSX 组件渲染前）
- `ctx.registerItems("toolbar", [{ id, render, meta }])` / `("dialogs", [...])` 注册插槽（与 index.ts 的 ui 声明对应）
- **纯入口型工具条条目优先用声明式**（外观归宿主，不自绘按钮）：`registerItems("toolbar", [{ id, meta: { label, title, icon, onClick } }])`——`icon` 三形态 `{ svg: "<path …/>" }`（24×24 lucide 线条标记）/ emoji / `"icon.svg"`；无 render 时宿主渲染标准 36×36 灰度按钮。详见 aiti-docs `docs/devtools/extension-points.md`「toolbar 声明式条目」
- `import { useState, useEffect } from "react"` → vite alias 委托宿主（**别引真 React**）
- `ctx.h` / `ctx.apiUrl(p)` / `ctx.t(key, params)` / `ctx.currentSession` 等都从 ctx 取
- **关闭按钮带 `aria-label="关闭"`**（aiti-helper 全局 AI 按钮靠它注入到关闭按钮左边——裸文本"关闭"识别不了）
- **弹窗 onClose 绑真实状态**：`onClose={() => setPanelOpen(false)}`，**别传空函数**（否则关闭失效）

### 5. 加 npm 依赖

- 页面用到的 npm 包 → `package.json` `dependencies`（vite 构建会**内联进产物**）
- 构建工具 vite → `devDependencies`（模板已有）
- `npm install`
- **只引浏览器安全的包**（如 qrcode 有 browser 字段）；node-only 的要 polyfill 或换实现

### 6. 加部署脚本 `tools/deploy.mjs`（参考 `pi-web-ext/demo/tools/deploy.mjs`）

```js
// 先构建 JSX client → 拷贝整目录到两个扩展根 → git 提交部署状态
execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" }); // 失败中止
// 然后 cpSync 到 ~/.pi/web/extensions/<id> + ~/.pi/web-dev/extensions/<id>（剔除 tools/、node_modules）
// 最后 git add -A && git commit -m "[deploy] <id> · <stamp>"
```

### 7. 构建

```bash
node tools/build-client.mjs
```

产物 `client/your-ext.mjs`。**检查**：产物里零 React 引用、无裸 import（
`grep -c "react" client/your-ext.mjs` 应为 0；qrcode 等应被内联）。

### 8. 部署 + 生效

```bash
node tools/deploy.mjs
curl -X POST {basePath}/api/extensions/reload
# dev: POST http://localhost:3001/dev/api/extensions/reload
# 生产: POST http://localhost:3002/api/extensions/reload
```

### 9.（可选）AI 帮助点 skills

`skills/index.json` 列 skill 名；每个 `skills/<name>/SKILL.md`（frontmatter：
`name/title/summary/placeholder/outputs/action`，正文是给 AI 读的手册，可用 `{basePath}` 拼 API 路径）。
index.ts 声明 `ai: { manage: true, intro, skills: "skills" }` 后 aiti-helper 自动聚合。
已装扩展的帮助点可 `GET {basePath}/api/extensions/aiti-helper/helpers` 查看（含 demo 的 demo-selfcheck/demo-humor 可作例子）。

## 坑速查（模板已踩平，勿回退）

1. **vite 默认 classic JSX** → 必须 `esbuild.jsx: "automatic"`，否则产物 `React.createElement` + React 未定义。
2. **alias 前缀匹配** → 用正则 `/^react$/`、`/^react\/jsx-runtime$/` 分开（字符串 alias 会吞 jsx-runtime）。
3. **lib mode 依赖默认外部化** → 必须 `rollupOptions.external: []` 才内联（浏览器才能跑裸包）。
4. **`__setCtx(ctx)` 最先调**，否则组件里 hooks 委托不到宿主。
5. **JSX `map()` / svg path 数组必须给 key**；host-shim 的 `jsxs` 已补 `_store.validated = 1`（静态兄弟元素假阳性 key 警告抑制）——抄 host-shim 时别漏。
6. **关闭按钮 `aria-label="关闭"`**（裸文本"关闭"识别不了 → AI 按钮不注入）；**DialogsSlot 的 onClose 别传空函数**。
7. **只引浏览器安全的 npm 包**（如 qrcode 有 browser 字段）；node-only 的要 polyfill 或换实现。
8. **改源码后必须重建**（`node tools/build-client.mjs`），否则页面无变化（注入脚本带内容哈希，刷新即拉新）。
9. **server 端 npm 依赖**：`index.ts` 用 npm 包时（jiti 从扩展 node_modules 解析），deploy 要把 node_modules 一起带上（参考 service-tunnels 的 `npm install --omit=dev` 到目标目录）。

## 落地清单（创建完核对）

- [ ] `index.ts` 的 client 字段 == vite `fileName` 产物，一致
- [ ] 构建产物生成；reload 后浏览器能 import、页面无 console 报错
- [ ] 插槽（toolbar/dialogs/...）注册与 index.ts `ui` 声明对应
- [ ] 关闭按钮带 aria-label；onClose 绑真实状态；map 列表带 key
- [ ] 部署到 `~/.pi/web/extensions/<id>` + `~/.pi/web-dev/extensions/<id>` 并 reload
- [ ] （可选）skills/ 帮助点 + index.ts `ai` 声明，aiti-helper 聚合验证
- [ ] （可选）发布到在线注册表——见 `ext-publish` 帮助点

## 下一步

建完想发布到在线注册表（让别人能一键装），参考 `ext-publish` 帮助点。
