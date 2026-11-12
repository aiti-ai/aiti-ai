# ext-jsx-client 模板 —— 扩展 client 用 JSX + npm 依赖

> 复制的骨架：让扩展 client 能用 **JSX + TypeScript + npm 依赖**，产物仍是宿主能
> `import()` 的单个 `.mjs`。原理与完整说明见 `docs/aiti-ext-jsx-vite-plan.md`；
> 可运行例子见 `pi-web-ext/demo/`（toolbar ⚛️ 按钮）。

## 目录

```
ext-jsx-client/
├── package.json               # scripts + devDeps(vite)；dependencies 放你的 npm 包
├── vite.config.ts             # lib mode 配置（改 fileName → 产物名）
├── skills/                    # AI 帮助点（aiti-helper skills 机制）
│   ├── index.json             # 列 skill 名（如 ["ext-create"]）
│   └── ext-create/SKILL.md    # 「用本模板创建新扩展」完整指南（AI 参考它创建/维护扩展）
├── client/
│   └── src/
│       ├── entry.tsx          # register(ctx) 入口（复制后换成你的 UI）
│       ├── host-shim.ts       # react → 宿主 h/useState… 委托桥（一般不用改）
│       └── jsx-runtime.ts     # 一行，不动
└── tools/
    └── build-client.mjs       # 构建脚本（包装 vite build）
```

## AI 帮助点（skills 机制）

扩展在 `index.ts` 声明后，aiti-helper 会自动聚合该扩展的 AI 帮助点（弹窗 AI 按钮 →
按扩展分组高亮）：

```ts
export default {
  id: "your-ext",
  // ...
  ai: { manage: true, intro: "一句话：AI 能帮我做什么", skills: "skills" },
}
```

- `skills/index.json` 只列 skill 名（避免全目录扫描）；每个 skill 一个 `skills/<name>/SKILL.md`
- SKILL.md frontmatter：`name / title / summary / placeholder / outputs / action`；正文是给 AI 读的手册（可用 `{basePath}` 拼 API 路径）
- 模板自带 `ext-create`：**「用本模板创建新扩展」完整指南**（复制模板 → 改 index.ts/vite.config → 写组件 → 构建 → 部署 → 生效，含坑速查与落地清单）——复制后把它改成你扩展自己的帮助点即可
- 示例见 `pi-web-ext/demo/skills/`（demo-selfcheck / demo-humor）

## 三步接入（复制到你的扩展）

```bash
cd pi-web-ext
cp -r templates/ext-jsx-client <your-ext>-tmp && mv <your-ext>-tmp <your-ext>
cd <your-ext>
```

1. **改 vite.config.ts**：`build.lib.fileName` 改成你的产物名（如 `"my-ext.mjs"`）。
   需要的 npm 包加进 `package.json` 的 `dependencies`，然后 `npm install`。

2. **写 UI**：在 `client/src/` 写组件（`import { useState, useEffect } from "react"` 会被
   alias 委托宿主；`map()`/svg path 数组必须给 key），在 `entry.tsx` 的 register 里
   `ctx.registerItems("toolbar"/"dialogs"/...)` 注册。纯入口型工具条条目优先用声明式
   `meta: { label, icon, onClick }`（外观归宿主渲染，不自绘按钮，详见 aiti-docs
   `docs/devtools/extension-points.md`「toolbar 声明式条目」）。

3. **index.ts 指向产物 + deploy 先构建**：
   ```ts
   export default { id: "your-ext", client: "client/my-ext.mjs", ui: { /* ... */ } }
   ```
   `tools/deploy.mjs` 里部署前加：
   ```js
   execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
   ```

## 命令

```bash
npm run build:client   # 构建（改源码后必跑，否则页面无变化）
npm run watch          # vite build --watch：改源码自动重建（rev 变化）
npm run deploy         # 你扩展自己的部署脚本（模板只给了 build，deploy 按需写）
```

## 常见坑（勿回退）

- **vite 默认 classic JSX** → 必须 `esbuild.jsx: "automatic"`，否则产物 `React.createElement` + React 未定义。
- **alias 前缀匹配** → 用正则 `/^react$/`、`/^react\/jsx-runtime$/` 分开。
- **lib mode 默认外部化 dependencies** → 必须 `rollupOptions.external: []` 才内联。
- **`__setCtx(ctx)` 要最先调**（任何 JSX 渲染前），否则组件里 hooks 委托不到宿主。
- **产物先构建再部署**；git 可忽略 `client/*.mjs`（deploy 前总是重建）。
- **弹窗关闭按钮必须带 `aria-label="关闭"`（+title）**：aiti-helper 的全局 AI 按钮靠
  `findCloseBtn`（识别 aria-label/class 含 close 或文本 `×`）注入到关闭按钮左边。
  裸文本"关闭"按钮识别不了 → AI 按钮不注入（demo 曾踩坑）。
