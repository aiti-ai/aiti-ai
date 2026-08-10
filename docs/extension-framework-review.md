# 扩展框架（Phase 0）审查报告

> 审查对象：commit `12092d0`（框架）+ `3b3cbf3`–`f387de7`（AGENTS.md 与
> 插槽演进）+ `~/.pi/web/extensions/` 下三个实际扩展（demo / session-manager /
> service-tunnels）。审查时间：2026-08-10。

## 1. 验证结果（实测）

| 项 | 结果 |
|---|---|
| `lib/ext/registry.test.mjs`（8 用例） | ✅ 全绿（loader/lifecycle/dispatch/middleware/asset guard/manifest/reload） |
| `tsc --noEmit` | ✅ 通过 |
| `/api/extensions/status` | ✅ 3 个扩展全部 loaded（demo 0.1.0 / service-tunnels 0.2.0 / session-manager 0.2.0） |
| `/api/extensions/manifest` | ✅ clientUrl + ui 元数据 + i18n 正常 |
| client bundle 静态服务 | ✅ `200 text/javascript` |
| assets 穿越防护 | ✅ 实测 `..` 与 URL 编码 `%2e%2e` 均 404 |
| API 分发 + core 数据契约 | ✅ counter 持久化、`core.listSessions` 返回真实会话 |
| middleware fail-closed | ✅ 抛异常 → 403（代码路径 + 测试） |
| 扩展真实使用 | ✅ session-manager 用足 server.startup/shutdown/api + 5 个 UI 插槽 + 1780 行 client bundle |

**框架本身质量高，可以进入下一阶段。** 以下问题按严重度排列。

---

## 2. 必须处理（安全/方向）

### 2.1 【安全·信任边界】扩展 middleware 钩子绕过 core 全部门禁

`proxy.ts` 中扩展钩子在 DNS-rebinding / Basic auth / allowlocal **之前**，且
`handled: true` 的响应**直接返回，不经过任何 core 门禁**。这是设计意图
（"Extensions own their host/path namespaces"），demo 扩展已用它处理
`/demo-middleware/*`。

这意味着：**任何加载的扩展都能通过 middleware 钩子开出一条绕过
`PI_WEB_PASSWORD` 与直连门禁的通道**。在"扩展 = 完全信任"模型下可接受，
但必须：

- [ ] README / `lib/ext/types.ts` 中**显式文档化**：`server.middleware` = 完全
      信任；只加载自己写的扩展（对齐 Open WebUI "信任即全部能力"的明示）；
- [ ] core 在代理扩展响应时**强制 `cache-control: no-store`**（不依赖扩展自觉），
      防止有 bug 的扩展把敏感响应交给 CDN/浏览器缓存；
- [ ] status 接口对声明了 `middleware` 的扩展加标记（如 `hasMiddleware: true`），
      让运维一眼看出谁拥有全局请求面。

### 2.2 【方向偏离】service-tunnels 扩展目前是"纯 UI viewer"，未实现抽取目标

`service-tunnels/index.ts` 注释明确：库实例留在 core，扩展只读 `/api/services`
渲染一个 Ports 弹窗。**core 里完整的 service-tunnels 集成原封未动**：

```
lib/service-tunnels-integration.ts + lib/service-ports.ts + lib/tunnels.ts
app/api/service-tunnels/route.ts + app/api/services/route.ts
proxy.ts 的 vhost 分支 + allowlocal 门禁
components/ServicesDialog.tsx（2321 行）+ SelfExposeAlert.tsx + 202 个 i18n key
```

后果：
- 用户看到**两个服务入口**：core 的 globe（ServicesDialog）+ 扩展的 🌐
  （Ports viewer）；后者只读，无 expose/隧道/认证，是能力倒退；
- 若抽取是终态，`service-proxy-shared.ts` 中 service-tunnels 专属部分
  （base domains / allowlocal 状态 / self-forward token / allowed ports /
  stripBasePath / mapSelfTunnelToVhost）也要随扩展迁移，proxy.ts 的 vhost
  分支删除，`/api/service-tunnels` 改兼容壳。

**需要明确路线**（三选一）：
1. **继续抽取（原方案）**：Phase 2 把 server 侧迁入扩展（middleware 钩子接管
   vhost + allowlocal），core 删对应代码；UI 用扩展版替换 ServicesDialog；
2. **UI-first 过渡**：明确承认 service-tunnels 扩展只是"第二个 viewer"，
   暂不抽取 server 侧（当前状态），但 UI 上避免双入口（隐藏 globe 或扩展按钮）；
3. **放弃抽取**：框架只服务于 session-manager 类新功能，service-tunnels 保持
   core 集成。

无论选哪个，都应**先删掉或重命名当前扩展的 🌐 按钮**，避免双入口。

---

## 3. 建议修复（质量/健壮性）

### 3.1 前端 manifest 拉取失败后永不重试

`ExtSlots.tsx` 的 `loadStarted` 是模块级单例，fetch 失败后置 true，**整个
会话不再重试**（只有整页刷新才恢复）。且服务端 `/api/extensions/reload` 后
客户端不感知（没有版本信号 / 重拉路径）。

建议：fetch 失败时 `loadStarted = false`（下次组件挂载重试）；reload 响应带
`version`（如时间戳），客户端在下次 `visibilitychange`/focus 时若版本变化则
重新拉 manifest + `resetExtUiItems()` + 重新 import bundle（URL 带版本 query
破缓存）。

### 3.2 reload 并发空窗

`reload()` = `shutdown → loadAll → startAll`；`loadAll` 的 `clear()` 后、
`await jiti.import` 完成前，middleware 遍历**空 Map** → 所有扩展请求短暂
fall-through。fail-safe（落到 core 门禁），但热重载时服务降级。

建议：`loadAll` 改为"新 Map 填满后原子替换"（调研文档 §4.2 的原子 swap），
并保留 `this.loaded` 期间的旧扩展继续服务；或至少在文档记录该窗口。

### 3.3 i18n 不感知当前语言

`ExtSlots.tsx`：`ext.ui?.i18n?.["zh-CN"] ?? ext.ui?.i18n?.en` 硬编码 zh-CN
优先，不跟随用户界面语言（AppShell 的 `locale` 状态），`ctx.t` 用的也是
注册时的固定表。

建议：`ExtClientContext` 增加 `locale` 或 `useLocale()`，`t` 按当前 locale
查表（i18n 表已随 manifest 下发，只是选择逻辑写死）。

### 3.4 middleware 全量遍历

每次请求遍历**全部扩展**并逐个 `await middleware()`。扩展多时（比如
10+）累积延迟。建议：声明式前缀过滤（扩展声明 `middleware: { paths: [...] }`
或 `hosts: [...]`），core 先匹配再调用 —— 即调研文档"惰性激活"的落地点。

### 3.5 类型不严谨

- `ExtSlots.tsx` `registerItems` 的 `meta?: Record<string, unknown>` 与
  `ext-ui-store.ts` `ExtUiItemRegistered.meta?: { label?; title?; badge? }`
  不一致（运行时无碍，但契约漂移）；
- `assets` 路由 `CONTENT_TYPES` 缺 `.ts/.tsx/.jsx`（扩展若服务源码映射返回
  octet-stream）；
- manifest `clientUrl` 未 URL 编码（client 路径含空格/特殊字符时坏）。

### 3.6 proxy 钩子顺序耦合

扩展 middleware 钩子位于 `mapSelfTunnelToVhost`（改写 Host）**之后** ——
扩展看到的是改写后的请求。当前无冲突（扩展未用），但将来 service-tunnels
扩展接管 vhost 时，`mapSelfTunnelToVhost` / self-forward token 的读取必须
一并迁入扩展，否则顺序错乱。迁移时注意。

---

## 4. 与调研方案（docs/extension-mechanisms-survey.md）的差距

| 调研建议 | 落地情况 |
|---|---|
| 目录约定对齐 pi + 热重载 API + fail-closed + asset 防穿越 | ✅ 全部落地 |
| core 数据契约（ExtCoreApi） | ✅ 落地且克制（listSessions/running/home/readSession/fileAccess） |
| ctx 传 hooks 避免 React 双实例 | ✅ 落地（比 importmap 更简单可靠，已验证 3 个扩展 bundle） |
| **惰性激活（activationEvents）** | ❌ 未落地（全量 load + middleware 全量遍历） |
| **manifest 权限声明** | ❌ 未落地（无 fs/port/process 声明，加载即全权） |
| **API 版本化（compatVersion）** | ❌ 未落地（无版本校验，未来 breaking change 无保护） |
| 进程隔离（Phase 3 预期） | 未开始（符合计划） |
| 前端 reload 感知 | ❌ 未落地（见 3.1） |

---

## 5. 结论

框架验收通过：**契约清晰、测试充分、三个真实扩展（含 1780 行前端 bundle）
在生产进程运行正常、类型与运行时双验证通过**。

进入下一阶段前必须处理两件事：
1. **信任边界文档化**（2.1）——middleware = 完全信任，强制 no-store，status
   标记；
2. **service-tunnels 路线决策**（2.2）——三选一，先消掉双入口。

其余（3.1–3.6）为质量项，可与 Phase 2 并行；调研方案中的惰性激活 / 权限
声明 / 版本化建议在扩展 API 定型前补上（改动面小，收益大）。
