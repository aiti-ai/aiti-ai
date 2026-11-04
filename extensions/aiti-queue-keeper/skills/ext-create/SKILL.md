---
title: aiti-queue-keeper 创建/迭代手册
outputs: []
action: []
---
aiti-queue-keeper 是 pi-web 去 fork 化 P3 的队列面板扩展。所有 UI 在
`client/src/`（JSX + vite 构建），manifest 在 `index.ts`。

开发迭代：改 `client/src/**` → `npm run build:client` → `node tools/deploy.mjs`。
契约镜像：`client/src/types.ts` 必须与 core `lib/composer/queue-api.ts` 结构同步。
