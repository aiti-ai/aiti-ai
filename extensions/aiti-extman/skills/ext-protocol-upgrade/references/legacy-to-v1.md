# legacy-to-v1 · 无声明扩展 → 协议 1.0

> 适用：`package.json` 没有 `aitiExtProtocol` 字段的遗留扩展（状态 `missing`），或声明 `invalid` 的扩展。
> 目标：核验扩展符合 v1.0 契约后，补上 `"aitiExtProtocol": "1.0"`。
> 规范依据：`docs/pi-web-ext-protocol.md`（v1.0 边界 + 版本化之前历史破坏性变更）；契约细节：`docs/pi-web-ext-authoring-reference.md`。

## 0. 为什么这跳是「核验 + 补声明」而不是机械改名

v1.0 是**现状基线**，没有「迁移动作」——但遗留扩展可能是在某次破坏性变更之前写的（见规范 §5 历史归档）。所以先逐项核验，确认它真的符合 v1.0，再补声明；发现不符合 → 先修不符合项。

## 1. 核验清单（逐项 grep/阅读，命中即修）

| # | 特征（grep 提示） | 正确做法 |
|---|---|---|
| 1 | `ctx.dataDir`（含 `dataDir` 访问） | 配置 → `ctx.configDir`；不可再生 → `ctx.stateDir`（旧宿主 fallback `?? join(ctx.configDir,"state")`）；可再生 → `ctx.cacheDir`。**访问即抛**，必炸 |
| 2 | `globalThis.__<extId>` / `window.__<extId>` 跨扩展直穿、`registry.byId` 穿透 | 一律 `ctx.services`（服务端 provide/get/require/onChange；客户端 registerExtService/getExtService）；feature 走 `ctx.features` |
| 3 | `new EventSource(` / 自建 `/events` SSE | 页面事件一律 aiti-event-bus topics（`subscribeTopics`）；禁兜底另起 SSE |
| 4 | `setInterval` 轮询拉状态 | 改事件/回调/SSE/`waitUntil` 类机制（禁轮询红线） |
| 5 | `client:` 指向旧路径（如 `client/<id>.mjs`） | 产物统一 `dist/<id>-client.mjs`；`client/src/` 是源；`vite.config.ts` 的 `fileName` 与 `client:` 一致 |
| 6 | 部署脚本没拷 `package.json` | 加拷贝（协议声明、版本仲裁、共享依赖 reconcile 都读部署目录 package.json）；整目录同步的可忽略 |
| 7 | `clientImmediately: false` 但扩展没有可懒加载插槽/有全局副作用 | 懒加载只适合有插槽 UI 的扩展；增强型保持缺省立即加载（见 authoring-reference §5.1） |
| 8 | 服务端同步重活：`execFileSync`/`spawnSync` 调外部程序、大文件 `readFileSync`、SQLite 单事务全量 | 改异步/分批 + `setImmediate` 让步/WAL；重活子进程（红线 §2.2） |
| 9 | 弹窗自绘拖拽/缩放/matchMedia | `data-ext-float="1"` + `data-ext-float-full`（浮窗契约） |
| 10 | 数据路径写==读不同源（迁移常见坑） | 写与读用同一取值（事故教训 INC-20260912-01） |

> 以上均为规范 §5「版本化之前」归档的破坏面；扩展若已合规，本跳通常只需第 6 项检查 + 补声明。

## 2. 操作

1. 按上表核验 `pi-web-ext/<id>/`（含 `tools/deploy.mjs`、`skills/`）。
2. 修掉命中项（保持最小改动；不确定 → 停止并汇报）。
3. `package.json` 增加：
   ```json
   "aitiExtProtocol": "1.0"
   ```
4. 部署脚本确认拷 `package.json`；然后构建/部署：
   ```bash
   node pi-web-ext/<id>/tools/deploy.mjs
   ```

## 3. 验证

```bash
node scripts/check-ext-protocol.mjs --deployed
```

- 该扩展源与部署目录均 `1.0` / `ok`；
- 无专属测试时至少 `node scripts/test-web-ext.mjs --only _shared` 不回归；
- 浏览器冒烟：扩展入口/插槽行为与原一致。
