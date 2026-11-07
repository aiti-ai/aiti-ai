# @aiti-ai/aiti-devtools-opencode

> OpenCode host 插件（16 工具进程内注册 + messages.transform 占位符改写）+ 官方 web UI 即 AI 窗（nginx 反代剥 CSP + sub_filter 注入，不 fork）

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

OpenCode host 插件（16 工具进程内注册 + messages.transform 占位符改写）+ 官方 web UI 即 AI 窗（nginx 反代剥 CSP + sub_filter 注入，不 fork）

宿主适配 · tags: `opencode` · `adapter` · `plugin` · `messages-transform` · `webui` · `placeholder`

## Positioning (English)

OpenCode host plugin (16 tools registered in-process + messages.transform placeholder rewriting) + the official web UI serves as the AI window (nginx reverse proxy strips CSP + sub_filter injection, no fork)

## 安装 / 部署

```bash
# npm 包（opencode.json）
{ "plugin": ["@aiti-ai/aiti-devtools-opencode"] }
# 或本地：cd opencode-ext/aiti-devtools-opencode && npm run deploy（→ ~/.config/opencode/plugins/）
# 桥默认 http://127.0.0.1:8777（AITI_BRIDGE_URL 覆盖——裸 base，不带 /aiti，插件自补；带尾巴会变 /aiti/aiti）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-devtools-opencode.html>
- English docs: <https://aiti.pw/en/extensions/aiti-devtools-opencode.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
