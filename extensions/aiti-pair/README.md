# aiti-pair — 设备互连（临时聊天 / 互传文件）

连同一个桥的设备（手机浏览器 / 其他电脑 / agent 会话 / 注入页面）互发消息、互传文件。方案与架构见仓库根 `docs/aiti-bridge-pair-plan.md`。

## 形态

- 本扩展 = pi-web 载体薄壳：工具条按钮（「更多」溢出菜单内「设备互连」）→ 浮窗面板（`data-ext-float` 契约，aiti-float 接管拖拽/小屏全屏）内懒挂 pair widget
- widget 与协议**不在本扩展**——来自 aiti-devtools 公共资产 `pair-client.js`（桥 core 构建产物，协议唯一来源）；本扩展运行时动态加载该资产（软依赖：aiti-devtools 未部署时面板显示引导，不崩）
- 可达域 = 本实例内嵌桥的设备集合（与独立桥 8777 不互通）

## 同能力的其他入口

| 入口 | 位置 |
|---|---|
| 手机/外部浏览器独立页 | 桥 serve 的 `/pair.html`（独立桥 = `https://<host>/aiti/pair.html`；pi-web = `/api/extensions/aiti-devtools/pair.html`） |
| cockpit 操作台 | 工具条 ✉ 按钮 → 弹层 widget |
| agent（MCP） | `bridge_status`（devices 统一设备视图）+ `aiti_pair_send` / `aiti_pair_file` / `aiti_pair_fetch` |

## 安全模型

- pair 消息/文件下载需 peer token（注册时下发，浏览器 localStorage 记忆）
- 上线/发现面（register/events/devices）双层门槛：桥内私网 gate（`X-Real-IP` 判内网；`AITI_PAIR_PUBLIC=1` 全开 / `AITI_PAIR_TOKEN` 档 B 注册 token）+ nginx 对外来源套 Authelia
- 临时性：消息内存态不落盘、文件 TTL 1h 自清、设备掉线 1h 回收

## 部署

```bash
node tools/deploy.mjs   # → ~/.pi/web{,-dev}/extensions/ + 双实例热重载
```
