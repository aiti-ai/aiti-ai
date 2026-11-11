# @aiti-ai/aiti-git-ops

> 白名单 git 写引擎——checkout 预检 / stash / plan 断点 / 审计 / changed topic，供 folder 与 session-manager 消费

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

白名单 git 写引擎——checkout 预检 / stash / plan 断点 / 审计 / changed topic，供 folder 与 session-manager 消费

服务端引擎 · tags: `git` · `server-side` · `engine`

## Positioning (English)

Whitelisted git write engine — checkout precheck / stash / plan breakpoints / audit / changed topic, consumed by folder and session-manager

## 安装 / 部署

```bash
# 部署到 ~/.pi/web/extensions/aiti-git-ops/ 后 reload
node pi-web-ext/aiti-git-ops/tools/deploy.mjs
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-git-ops.html>
- English docs: <https://aiti.pw/en/extensions/aiti-git-ops.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
