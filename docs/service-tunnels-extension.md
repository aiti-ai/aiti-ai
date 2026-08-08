# service-tunnels 集成抽取为扩展 — 调研与方案

> 目标：把 pi-web 当前硬编码的 service-tunnels 集成（服务端 + 前端）抽取为
> **可动态加载的扩展**。本文档先盘点现状、论证可行性，再给出插入点设计、
> 迁移映射与分阶段实施计划。**尚未实施，待评审。**

---

## 1. 现状盘点

### 1.1 服务端（进程内单例 + middleware 内嵌决策）

| 模块 | 职责 | 依赖 |
|---|---|---|
| `lib/service-tunnels-integration.ts` (≈430 行) | 单例创建（`globalThis.__piServiceTunnels`）、`exposeService` / `exposeSelf` / `ensureSites` / `stopSelf` / `getSelfExposeState` / `getSelfAccessUrls`、`PI_WEB_EXPOSE` env 解析（含 `maybeExposeSelf` 启动钩子） | `service-tunnels` 库 |
| `lib/service-ports.ts` | 端口发现适配器（`discoverServicePorts` / `getServicePorts` / `isServicePortAllowed` / host 后缀） | integration + 库 |
| `lib/tunnels.ts` | 隧道信息形状适配（`getTunnelInfos`） | integration + 库 |
| `lib/service-proxy-shared.ts` (293 行) | middleware 安全助手：`getPiWebPort`、`getBaseDomains`、allowlocal 两阶段门禁、self-forward token、allowed ports、`stripBasePath`、`mapSelfTunnelToVhost`。**刻意零库依赖**（middleware 不能 import 库） | 无 |
| `app/api/service-tunnels/route.ts` (437 行) | 大 API：GET 状态/发现/内部端口/隧道/provider/schema/日志/self；POST 的 expose、tunnel start/stop、user CRUD、TOTP、allow-tool-download、user-summary、self-expose/stop/allowlocal/allowhosts | integration |
| `app/api/services/route.ts` (24 行) | 发现列表 API（`?refresh=1`） | service-ports |
| `proxy.ts` (Next middleware) | ① service vhost 分支：`st.proxy.parseHost` + `st.proxy.resolve()` 决策 → pipe/redirect/forward/deny；② allowlocal 直连门禁（含两阶段封禁 HTML）；③ DNS-rebinding 门禁；④ `PI_WEB_PASSWORD` Basic 门禁 | 经 `globalThis.__piServiceTunnels` 读库实例 |
| `instrumentation.ts` (Next 启动钩子) | `getServiceTunnels()` 建单例 + `void maybeExposeSelf()` | integration |

### 1.2 前端

| 模块 | 职责 |
|---|---|
| `components/ServicesDialog.tsx` (2321 行) | 主弹窗：Ports / Self / Users 三页签，含 expose 表单（schema 驱动）、隧道日志、TOTP 管理、自暴露详情 |
| `components/SelfExposeAlert.tsx` (170 行) | 自暴露无认证的页面顶部红色告警（事件驱动 + 原因弹窗） |
| `components/AppShell.tsx` | globe 按钮（第 984 行附近）+ 弹窗挂载（第 1812 行）+ 告警挂载（第 1623 行） |
| i18n | `services.*` 前缀 **202 个 key × 2 语言**（en/zh-CN） |

### 1.3 现状关键机制（抽取方案的立足点）

1. **跨 bundle 共享已验证**：`globalThis.__piServiceTunnels` 由 app server
   （`instrumentation.ts`）创建，middleware（`proxy.ts`，独立 bundle）只读
   `globalThis`，不 import 库。TypeScript 用 `declare global` 声明。
2. **middleware 是 Node runtime**：`.next/server/middleware.js` 的 nft 包含
   `next-server.runtime.prod.js`，且现有代码已 import `node:net` / `node:crypto`
   —— middleware 与 app server 同进程、共享 `globalThis`（已验证，AGENTS.md
   「共享 globalThis」注释即为此意）。
3. **动态 import 已有先例**（commit 520e909）：
   - `import(/* webpackIgnore: true */ <runtime computed url>)` 让 webpack 保留
     原生 import（否则替换成 context stub 运行时报 MODULE_NOT_FOUND）；
   - `serverExternalPackages: ["service-tunnels"]` 让库不打包、运行时原生
     require（库内部要做 computed `import()` 加载插件）。
4. **middleware 的 service 分支必须跑在 core 门禁之前**：service vhost 是独立
   origin 命名空间，`/api/*` 归测试服务所有，不能过主域名 DNS-rebinding 门禁。

---

## 2. 可行性结论

**可以抽取，但受三个平台约束限制，方案必须这样设计：**

| 约束 | 影响 | 对策 |
|---|---|---|
| Next.js App Router 的路由文件必须在**构建期**存在于文件系统 | 扩展无法在运行时注册新 API 路由 | core 提供**静态壳路由**（catch-all + 两个兼容壳），运行时查注册表分发到扩展 handler |
| middleware 是**独立 bundle**，构建期静态编译 | middleware 无法动态 import 扩展代码 | middleware 只读 `globalThis.__piWebExt` 注册表并调用钩子（与 `__piServiceTunnels` 同模式）；注册表对象由 app server 侧创建 |
| 浏览器**无法 import 磁盘上的 TS** | 前端扩展不能直接复用 server 的 jiti 加载 | 扩展自带**预编译 ESM bundle**（esbuild 打包，React 走 host importmap），manifest 给 URL，客户端动态 `import()` |

安全性上：扩展 = 完全服务器权限的代码，必须走**受信目录 + 显式启用**的信任
模型（与 pi 的 `~/.pi/agent/extensions` 一致）。middleware 钩子必须 **fail-closed**
（异常 → 403，与现在 `resolve()` 的 try/catch 一致）。

---

## 3. 扩展 API 设计（草案）

```ts
// lib/ext/types.ts（core 提供）
interface PiWebExtension {
  id: string;            // 唯一 id，如 "service-tunnels"
  name: string;
  version: string;
  server?: {
    startup?(ctx: ExtServerContext): Promise<void>;   // instrumentation 调用
    shutdown?(): Promise<void>;                       // 热重载/退出时调用
    api?(req: NextRequest, ctx: ExtApiContext): Promise<Response>;
    middleware?(req: NextRequest): Promise<ExtMiddlewareResult>;
  };
  ui?: {
    toolbar?: ExtToolbarItem[];    // 顶部工具条按钮（globel 位置）
    dialogs?: ExtDialog[];         // 弹窗（挂载到 AppShell 弹窗区）
    banners?: ExtBanner[];         // 页面顶部告警条幅（SelfExposeAlert 位置）
    i18n?: Record<Locale, Record<string, string>>;   // 合并进 useI18n
  };
  client?: string;       // 预编译 ESM bundle 相对路径，经 /api/extensions/<id>/assets/ 提供
}

type ExtMiddlewareResult =
  | { handled: true; response: NextResponse }
  | { handled: false }         // 交给 core 继续
  ;                            // 抛异常 = fail-closed 403（core 兜底）
```

**扩展目录布局**（对齐 pi 的扩展约定）：

```
~/.pi/web/extensions/            # PI_WEB_EXTENSIONS_DIR 可覆盖
├── service-tunnels/
│   ├── index.ts                 # 入口：default export PiWebExtension
│   ├── server/…                 # 单例、expose、discovery、api handlers
│   ├── client/                  # 前端源码（React 组件）
│   ├── dist/client.js           # 预编译 ESM bundle（esbuild，react 外部化）
│   └── package.json             # 依赖声明（service-tunnels 库等）
```

---

## 4. 服务端插入点（core 新增 4 个）

### 4.1 `instrumentation.ts` — 启动钩子

```ts
const { extRegistry } = await import("@/lib/ext/registry");
await extRegistry.loadAll();          // jiti 加载 ~/.pi/web/extensions/*
await extRegistry.startAll();         // 逐个调 server.startup
```
替换现有 `getServiceTunnels() + void maybeExposeSelf()` 直接调用。
加载器对每个扩展 `import(/* webpackIgnore: true */ url)`，jiti 转译 TS
（pi 同款机制，jiti 已是 devDependency）。

### 4.2 `proxy.ts` — middleware 钩子（关键决策点）

插入位置：**DNS-rebinding 门禁之前**（service vhost 独立 origin，现状即如此）：

```ts
const st = globalThis.__piWebExt;                 // 注册表（app server 侧创建）
const res = st ? await st.middleware(request) : null;   // 只调钩子，不 import 扩展
if (res?.handled) return res.response;            // 扩展处理完（pipe/redirect/403/…）
if (res === "error") return failClosed403();      // fail-closed
// 未处理 → 继续 core 门禁（DNS-rebinding + Basic auth）
```

- middleware bundle **不 import** 扩展代码，只经 `globalThis` 调钩子函数
  （函数活在 app server 堆中，middleware 拿引用）——与 `__piServiceTunnels` 相同。
- 扩展的 `middleware` 钩子内部自己实现 vhost 分支（`st.proxy.resolve()`）+
  allowlocal 门禁 + self-forward token 校验（这些逻辑随扩展迁移，见 §6）。
- 启动顺序保证：`instrumentation.register()` 先于任何请求，注册表必然已存在；
  热重载用**原子替换**（新对象先完全就绪再 swap `globalThis.__piWebExt`）。

### 4.3 `app/api/extensions/[...path]/route.ts` — catch-all API 壳

```
/api/extensions/<extId>/<action>?query   → 查注册表 → ext.server.api(request, ctx)
```
- core 先跑 `isApiRequestAllowed`（DNS-rebinding 门禁），再分发；
- 无匹配扩展 / 扩展未提供 api → 404；
- 响应格式由扩展自定（JSON）。

### 4.4 `app/api/extensions/manifest/route.ts` — 前端清单

```
GET /api/extensions/manifest → {
  extensions: [{ id, name, version, ui: {...}, clientUrl, i18n }]
}
```
前端插槽以此渲染按钮/弹窗/告警，并动态 import `clientUrl`。

### 4.5 （可选）生命周期管理 API

`POST /api/extensions/reload`（热重载：shutdown → 清缓存 → loadAll → startAll）、
`GET /api/extensions/status`（加载状态/版本/错误）。

---

## 5. 前端插入点（core 新增 4 个）

### 5.1 `components/ExtSlots.tsx` — 通用插槽

从 `GET /api/extensions/manifest` 拉元数据，对每个带 `client` 的扩展动态
`import(apiUrl(clientUrl))`，bundle 导出 `register(ctx)`，向客户端注册表
`window.__piWebExtUI` 注册组件；插槽按 name 渲染：

| 插槽 | 挂载位置 | 承载 |
|---|---|---|
| `<ExtSlot name="toolbar" />` | AppShell 顶部工具条（globe 旁） | 扩展按钮 |
| `<ExtSlot name="dialogs" />` | AppShell 弹窗区（ServicesDialog 挂载处） | 扩展弹窗 |
| `<ExtSlot name="banners" />` | SelfExposeAlert 位置 | 扩展告警 |
| `<ExtSlot name="statusbar" />`（可选） | ExtensionStatusBar 旁 | 扩展状态行 |

### 5.2 `components/AppShell.tsx`

- 删除 globe 按钮硬编码与 `ServicesDialog` 直接 import → 替换为 `<ExtSlot name="toolbar" />` + `<ExtSlot name="dialogs" />`；
- `ServicesDialog` 的开关状态（`servicesOpen` / `servicesInitialTab`）迁入扩展
  client bundle 内部。

### 5.3 i18n 合并

- manifest 返回扩展 `ui.i18n`（en/zh-CN 消息表）；
- `lib/i18n/registry.ts` 增加 `registerExtensionMessages(id, locale, messages)`，
  合并进 `useI18n` 的 `getMessages()`（客户端在挂载插槽时注册）。
- 现有 `t()` 签名已接受任意 string key，202 个 `services.*` key 无需改动 core
  类型。

### 5.4 扩展 client bundle 协议

- 扩展前端用 esbuild 打包为 ESM，**React/react-dom 外部化**（`external`），
  host 侧用 `<script type="importmap">` 提供 `react` / `react-dom` / `apiUrl`
  （module federation 思路，避免版本双实例）；
- bundle 导出 `register(ctx)`：`ctx.ui.registerToolbarItem(...)` /
  `registerDialog(...)` / `registerBanner(...)` / `t(key, params)`；
- 服务端经 `app/api/extensions/[...path]/assets/...` 只读扩展目录内文件
  （复用 `lib/file-access.ts` 的 allow-root 机制，仅限该扩展目录）。

---

## 6. 迁移映射（service-tunnels → 扩展）

| 现状模块 | 目标归属 |
|---|---|
| `lib/service-tunnels-integration.ts` | 扩展 `server/`（单例、exposeService/exposeSelf/ensureSites、PI_WEB_EXPOSE 解析） |
| `lib/service-ports.ts`、`lib/tunnels.ts` | 扩展 `server/` |
| `app/api/service-tunnels/route.ts` 全部 action | 扩展 `server.api`（经兼容壳分发） |
| `app/api/services/route.ts` | 扩展 `server.api`（经兼容壳分发） |
| `proxy.ts` vhost 分支 + allowlocal 门禁 + self-forward token | 扩展 `server.middleware` 钩子 |
| `instrumentation.ts` 直接调用 | `extRegistry.startAll()` → 扩展 `server.startup` |
| `components/ServicesDialog.tsx` | 扩展 client bundle（dialog 组件） |
| `components/SelfExposeAlert.tsx` | 扩展 client bundle（banner 组件） |
| AppShell globe 按钮 + 弹窗/告警挂载 | 扩展 `ui.toolbar` + `ui.dialogs` + `ui.banners` |
| i18n `services.*` 202×2 keys | 扩展 `ui.i18n` |

**URL 兼容方案**：core 保留 `/api/service-tunnels` 与 `/api/services` 两个
**静态壳路由**（各约 30 行：门禁 + 查注册表 + 调扩展 handler），扩展的
`server.api` 注册这两个 path。好处：现有外部脚本/前端 bundle 无需改 URL，
catch-all `/api/extensions/[...path]` 留给未来其他扩展。壳路由在扩展未加载时
返回 404。

### 6.1 留在 core（安全边界，不随扩展加载状态漂移）

| 保留项 | 理由 |
|---|---|
| DNS-rebinding 门禁 + `PI_WEB_PASSWORD` Basic auth | pi-web 自身流量的无条件核心安全 |
| 扩展 loader / registry / 生命周期 API | 扩展基础设施本身 |
| catch-all API 壳 + manifest + 兼容壳路由 | 静态路由壳，不能进扩展 |
| 前端插槽 + client 注册表 + i18n 合并 | 前端基础设施 |
| `lib/request-security.ts` / `lib/web-auth.ts` | 无扩展依赖，永远生效 |

**明确一个设计决策**：`lib/service-proxy-shared.ts` 拆分为「core 通用」
（`getPiWebPort` 等）与「service-tunnels 专属」（base domains、host 后缀、
allowlocal 状态、self-forward token、allowed ports、`stripBasePath`、
`mapSelfTunnelToVhost`）——后者整体随扩展迁移。proxy.ts 中 allowlocal 直连
门禁分支随之移入扩展的 middleware 钩子；扩展未加载时该门禁不存在（无自暴露
即无需门禁），语义自洽。

---

## 7. 动态加载机制

### 7.1 服务端

- **目录**：`~/.pi/web/extensions/`（`PI_WEB_EXTENSIONS_DIR` 覆盖），单文件
  `.ts` / 目录 `index.ts` / npm 包三种布局（对齐 pi 约定）；
- **加载**：`import(/* webpackIgnore: true */ pathToFileURL(absPath))` +
  jiti 转译 TS；**先扫描目录、逐个尝试加载，单个失败不阻塞其余**，错误进入
  `GET /api/extensions/status`；
- **热重载**：`POST /api/extensions/reload` → 逐个 `shutdown()` → 清
  `require.cache` → 重新 `loadAll()` → `startAll()`；成功后原子 swap
  `globalThis.__piWebExt`（旧对象释放）；
- **构建期配置**：`next.config.ts` 的 `serverExternalPackages` 追加
  `jiti`（保险起见），loader 代码放 `lib/ext/`（服务端专用，client 零引用）。

### 7.2 前端

- 扩展仓库自带构建产物（`dist/client.js`），经 esbuild 打包、React 外部化；
- 服务端只读扩展目录内文件（allow-root 白名单限定该目录）；
- 客户端 `import(apiUrl(clientUrl))` → `register(ctx)` 挂到
  `window.__piWebExtUI`；
- 首屏策略：manifest 轻量（~KB 级），插槽组件对未加载扩展渲染 null，加载失败
  静默降级（不影响主 UI）；
- 热重载前端：重新拉 manifest + 重新 import（URL 加版本 query 破缓存）。

---

## 8. 分阶段实施计划

### Phase 0 — 可行性 PoC（约 0.5–1 天）
1. `lib/ext/registry.ts` + `lib/ext/types.ts` 最小骨架；
2. 示例扩展 `~/.pi/web/extensions/demo/index.ts`（仅 `startup` + 打印）；
3. `instrumentation.ts` 接入 `extRegistry.loadAll/startAll`；
4. `app/api/extensions/[...path]/route.ts` + `manifest` 路由；
5. `proxy.ts` 加空 middleware 钩子（fail-closed）；
6. 前端最小插槽 + 动态 import 一个 esbuild 产物（importmap 提供 React）。
   **验证点**：jiti 在 Next server bundle 中的可用性、middleware 经 globalThis
   调钩子、热重载原子 swap。

### Phase 1 — 基础设施落地
- 完整 registry（状态/错误收集）、loader（三布局 + 信任目录）、生命周期 API、
  4 服务端插入点 + 4 前端插入点、i18n 合并、扩展目录 allow-root；
- 单元测试（registry 加载/卸载/热重载/失败隔离，middleware 钩子 fail-closed）；
- 文档：扩展开发指南（server api / middleware / ui / client bundle 协议）。

### Phase 2 — service-tunnels 迁移
1. **服务端**：integration/ports/tunnels → 扩展 server；`/api/service-tunnels`、
   `/api/services` 改兼容壳；proxy.ts vhost 分支 + allowlocal 门禁 → 扩展
   middleware 钩子；`service-proxy-shared.ts` 拆分；
2. **前端**：ServicesDialog + SelfExposeAlert → client bundle；AppShell 换插槽；
3. **i18n**：202×2 keys 迁入扩展；
4. **回归**：现有 `lib/service-ports.test.mjs` / `request-security.test.mjs` /
   `web-auth.test.mjs` 全绿；手工验证发现/expose/隧道/认证/自暴露/告警；
5. 默认启用：扩展随 pi-web 一起发布到 `~/.pi/web/extensions/`（或在仓库内
   `extensions/` 目录随包分发，Phase 3 再改为按需安装）。

### Phase 3 — 可选增强
- 复用 `/api/plugins` 的 `DefaultPackageManager` 按需安装/卸载扩展包；
- 扩展沙箱（worker 进程 / vm）、包签名/哈希校验；
- 多扩展隔离与权限声明（声明所需 fs 范围、端口、进程）。

---

## 9. 风险与限制

| 风险 | 等级 | 缓解 |
|---|---|---|
| 扩展 = 完全服务器权限（可读全部文件、起进程） | 高 | 只从受信目录加载；文档明示风险；可选签名校验（Phase 3）；默认不加载未受信扩展 |
| middleware 钩子依赖 globalThis 顺序（instrumentation 先于请求） | 中 | Next 保证 register() 先于请求；热重载原子 swap；钩子内部 try/catch fail-closed |
| 前端动态模块的 React 双实例问题 | 中 | importmap 提供 react/react-dom 单实例；esbuild external + 构建期版本校验 |
| Next 构建期静态路由限制（扩展不能注册路由） | 低（已化解） | 静态壳 + 注册表分发，文档化扩展 API 必须走壳 |
| jiti 在 Next server bundle 内的兼容性 | 中 | Phase 0 PoC 先行验证；失败则退路：要求扩展自带编译产物（TS → JS 构建步骤） |
| 热重载期间正在进行的请求 | 低 | 原子 swap；旧实例不再接受新调用；请求级引用在 swap 前已持有（JS 单线程无悬挂引用） |
| 扩展升级与 service-tunnels 库版本漂移 | 低 | 扩展 package.json 声明依赖；manifest 暴露版本供 UI 显示 |

## 10. 验收标准

1. `PI_WEB_EXTENSIONS_DIR` 为空/不存在 → pi-web 以纯 core 运行，无
   service-tunnels 任何功能，无 globe 按钮，`/api/service-tunnels` 404；
2. 放入扩展 → 全部功能可用：发现 / expose / 隧道 / 认证 / 用户 / TOTP /
   自暴露 / 红色告警，URL 与现状完全一致；
3. `POST /api/extensions/reload` 修改扩展代码后生效，失败扩展不阻塞其他扩展；
4. middleware 安全性不降级：未 enroll 端口 403、伪造 Host 403、扩展崩溃
   fail-closed 403、自暴露无认证告警逻辑不变；
5. 现有测试全绿，新增 registry/hot-reload/fail-closed 测试。
