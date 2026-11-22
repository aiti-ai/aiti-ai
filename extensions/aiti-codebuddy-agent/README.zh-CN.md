# @aiti-ai/aiti-codebuddy-agent

> 腾讯 CodeBuddy Code CLI（cbc）驱动 —— stream 长连接（默认）+ exec 兜底双模式 + --resume 接入 All Sessions，control_request 三通道，API-key env 登录

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 多 agent 后端 · tags: `codebuddy` · `tencent` · `cbc` · `workbuddy` · `cli` · `session` · `multi-agent` · `glm` · `kimi`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-codebuddy-agent/` 后 reload。

需要本机可用 cbc：`npm i -g @tencent-ai/codebuddy-code`（或依赖 npx 兜底）。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-codebuddy-agent.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-codebuddy-agent.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
