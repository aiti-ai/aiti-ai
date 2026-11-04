---
name: demo-humor
title: AI 帮我玩 demo 幽默彩蛋
placeholder: 看一条随机幽默 / 切换彩蛋开关（如：给我来一条 demo 幽默）…
summary: 读取/切换 demo 扩展自带的幽默语料彩蛋
---

# demo-humor · demo 幽默彩蛋

demo 扩展自带幽默语料彩蛋（`server/humor*.ts`，启动时从语料源异步拉取）。AI 可以帮用户：

- **读一条随机幽默**：`GET {basePath}/api/extensions/demo/humor/random` → 返回一条幽默条目
- **查看语料与开关**：`GET {basePath}/api/extensions/demo/humor` → `{ items: [...], enabled }`
- **切换彩蛋开关**：`POST {basePath}/api/extensions/demo/humor/toggle` body `{ "on": true|false }` → 返回新状态

## 输出

- 读幽默：把幽默文本**原样**展示给用户（不要改写）
- 切换开关：告知操作后的开关状态（enabled: true/false）
