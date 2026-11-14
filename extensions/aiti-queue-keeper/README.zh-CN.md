# @aiti-ai/aiti-queue-keeper

> 输入框完整队列面板（queuePanel 插槽接管）：横幅、行操作（移动 / 拖拽 / steer 发送 / 转 followUp / 取回 / 删除）与回收站——纯客户端实现。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 功能定位

经 `queuePanel` 插槽渲染完整队列面板（**接管时** core 隐藏兜底横幅）：

- 队列横幅（折叠/展开、计数、全部取回）
- 行操作（↑↓ 移动、拖拽排序、steer 发送、转 followUp、取回、删除）
- 回收站（restore / restore-all / purge / purge-all）
- 撤销条（删除后 8s 窗口）
- 导入导出（pending recovery 弹窗解析 + JSON 下载）
- 通知条（导入/删除/回收站反馈）

## 架构（数据零迁移）

- **core 保机制**：rpc-manager 队列镜像 / sidecar 持久化 / 12 个 RPC / 回收站全部留在 core；ChatInput 只留插槽单行接入 + 兜底横幅。
- **扩展保策略**：全部 UI 状态（折叠/通知/回收站/撤销/拖拽）在 `client/src/QueuePanel.tsx`；操作统一经 **actions 原语**（`QueuePanelProps.actions`）调 core RPC，扩展零自有存储——关停扩展只是回到兜底横幅，任何状态数据无损。
- **契约**：`lib/composer/queue-api.ts`（core 侧类型 + controller bus）+ `/client/src/types.ts`（扩展侧结构镜像）；导出下载/导入解析经 `actions.downloadExport/parseImport` 透传 core 纯函数（单实现，扩展零逻辑）。

## 控制流

- **core → ext**：ChatInput 组装 `QueuePanelProps`（live 投影 + trash + actions）经插槽传入。
- **ext → core**：`ctx.registerQueuePanelController({expand, notice})`——core 恢复流调用 `getQueuePanelController()?.expand()` 强制展开面板；无接管时 no-op。
- **接管判定**：ChatInput `useExtSlotItems("queuePanel").length > 0`（feature 关闭/卸载/异步未加载 → 回落兜底横幅）。

## feature

- `queuePanel.enabled`（extman 可逐项启停）：关闭 → 不注册插槽项 → 回落 core 兜底。

## i18n

35 个 `chat.queue*` key 三语（zh-CN/en/zh-TW）在 `index.ts` `ui.i18n`（经 `ctx.t()` 读取）。

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-queue-keeper/` 后 reload。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-queue-keeper.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-queue-keeper.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
