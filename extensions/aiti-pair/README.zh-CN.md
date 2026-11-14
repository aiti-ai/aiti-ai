# @aiti-ai/aiti-pair

> 设备互连——连同一个桥的设备（手机浏览器 / 其他电脑 / agent 会话 / 注入页面）互发消息、互传文件。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 功能定位

连同一个桥的设备（手机浏览器、其他电脑、agent 会话、注入页面）之间互发消息、互传文件。

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

## 跨桥联邦（feature 门控，默认关）

可达域默认 = 单个桥实例。开启 aiti-devtools 扩展的 `pairFed.enabled` 后，本实例面板/agent 工具可见并发消息/文件给**权威桥**（默认 `http://127.0.0.1:8777/aiti`，`pairFed.url` 可配）的设备（`fed:` 前缀命名空间）；权威桥用户向「pi-web 桥」设备发送 = 广播进本桥全部 pair 设备（v1 非对称语义）。fed 文件下载经权威桥同机直读（跨机部署不可用）。

## 安全模型

- pair 消息/文件下载需 peer token（注册时下发，浏览器 localStorage 记忆）
- 上线/发现面（register/events/devices）双层门槛：桥内私网 gate（`X-Real-IP` 判内网；`AITI_PAIR_PUBLIC=1` 全开 / `AITI_PAIR_TOKEN` 档 B 注册 token）+ 反向代理对外暴露套认证
- 临时性：消息内存态不落盘、文件 TTL 1h 自清、设备掉线 1h 回收

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-pair/` 后 reload。

## 文档

- aiti-devtools（所连接的桥）: <https://aiti.pw/devtools/>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
