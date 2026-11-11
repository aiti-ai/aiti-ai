# @aiti-ai/aiti-codebuddy-agent

> 腾讯 CodeBuddy Code CLI（cbc）驱动 —— stream 长连接（默认）+ exec 兜底双模式 + --resume 接入 All Sessions，control_request 三通道，API-key env 登录

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

腾讯 CodeBuddy Code CLI（cbc）驱动 —— stream 长连接（默认）+ exec 兜底双模式 + --resume 接入 All Sessions，control_request 三通道，API-key env 登录

多 agent 后端 · tags: `codebuddy` · `tencent` · `cbc` · `workbuddy` · `cli` · `session` · `multi-agent` · `glm` · `kimi`

## Positioning (English)

Tencent CodeBuddy Code CLI (cbc) driver — stream long connection (default) + exec fallback dual mode + --resume into All Sessions, control_request three channels, API-key env login

## 安装 / 部署

```bash
# 部署到 ~/.pi/web/extensions/aiti-codebuddy-agent/ 后 reload
# 需要本机可用 cbc：npm i -g @tencent-ai/codebuddy-code（或依赖 npx 兜底）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-codebuddy-agent.html>
- English docs: <https://aiti.pw/en/extensions/aiti-codebuddy-agent.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
