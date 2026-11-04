# Queue Keeper（aiti-queue-keeper）

pi-web 去 fork 化 P3 的产物（`docs/pi-web-queue-cluster-ext-plan.md`）：把 ChatInput 内
~900–1000 行队列增强 UI 外迁为独立扩展；core 回到「上游同形机制 + 薄接入」。

## 职责

经 `queuePanel` 插槽渲染完整队列面板（**接管时** core 隐藏兜底 banner）：

- 队列横幅（折叠/展开、计数、Recall all）
- 行操作（↑↓ 移动、拖拽排序、steer-send、转 followUp、取回、删除）
- 回收站（restore / restore-all / purge / purge-all）
- 撤销条（删除后 8s 窗口）
- 导入导出（pending recovery 弹窗解析 + JSON 下载）
- 通知条（导入/删除/回收站反馈）

## 架构（数据零迁移）

- **core 保机制**：rpc-manager 队列镜像/sidecar 持久化/12 个 RPC/trash 全部留核；
  ChatInput 只留：ExtSlot 单行接入 + edit-intent 检查 + bottomMode 三态 + 兜底 banner。
- **扩展保策略**：全部 UI 状态（折叠/通知/回收站/撤销/拖拽）在
  `client/src/QueuePanel.tsx`；操作统一经 **actions 原语**（`QueuePanelProps.actions`）
  调 core RPC，扩展零自有存储——关停扩展只是回到兜底 banner，任何状态数据无损。
- **契约**：`lib/composer/queue-api.ts`（core 侧类型 + controller bus）+ `/client/src/types.ts`
  （扩展侧结构镜像）；下载导出/导入解析经 `actions.downloadExport/parseImport` 透传
  core 纯函数（单实现，扩展零逻辑）。

## 控制流

- **core → ext**：ChatInput 组装 `QueuePanelProps`（live 投影 + trash + actions）经插槽传入。
- **ext → core**：`ctx.registerQueuePanelController({expand, notice})`——core 恢复流
  （ChatWindow/useAgentSession 恢复/导入解析后）调用 `getQueuePanelController()?.expand()`
  强制展开面板；无接管时 core 兜底 banner（无折叠态）no-op。
- **接管判定**：ChatInput `useExtSlotItems("queuePanel").length > 0`（feature 关闭/卸载/
  异步未加载 → 回落兜底 banner）。

## feature

- `queuePanel.enabled`（extman 可逐项启停）：关闭 → 不注册插槽项 → 回落 core 兜底。

## i18n

35 个 `chat.queue*` key 三语（zh-CN/en/zh-TW）在 `index.ts` `ui.i18n`（随 UI 外迁，
core 已删同名 key，恢复上游 key 集）。扩展经 ctx.t() 读取。

## 构建 / 部署

```bash
npm run build:client   # vite lib mode → client/aiti-queue-keeper.mjs
node tools/deploy.mjs  # 构建 + 拷贝到 ~/.pi/web{,-dev}/extensions/ + git 提交
```

生效：`POST /api/extensions/reload`；client 刷新页面即新（内容哈希）。

## 契约依赖（core 侧）

- `<ExtSlot name="queuePanel" extra={QueuePanelProps}/>`（P3 新增插槽）
- `ctx.registerQueuePanelController`
- `lib/composer/queue-api.ts`（QueueEntryView / QueueLiveView / QueuePanelActions /
  QueuePanelController / QueuePanelProps）