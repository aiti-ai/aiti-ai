# @aiti-ai/aiti-testagent-native

> testagent-native（Windows 原生进程活体操控）可视面 —— broker 进程/会话/挂钩/事件流；原 aiti-wintrace（2026-11-07 改名）

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

testagent-native（Windows 原生进程活体操控）可视面 —— broker 进程/会话/挂钩/事件流；原 aiti-wintrace（2026-11-07 改名）

调试 · tags: `windows` · `native` · `win32` · `com` · `detours` · `injection` · `hook` · `trace` · `hotpatch` · `tan` · `testagent-native`

## Positioning (English)

Visual panel for testagent-native (live Windows-native process control) — broker processes/sessions/hooks/event stream; formerly aiti-wintrace (renamed 2026-11-07)

## 安装 / 部署

```bash
# 1) 常驻 tan broker（155：Startup 文件夹 start-tan.vbs——broker 8765/8766 + MCP HTTP 8767）
#    手动：C:\workspace\testagent-native\native\build\win64-release\bin\<current-broker.txt> --port 8765 --http-port 8766
# 2) 本面板随 pi-web 扩展部署自动生效（工具条「Win」入口）；数据源 broker HTTP 8766（env TAN_BROKER_HTTP 可改）
# 3) AI 侧走 testagent-native-mcp：node mcp/testagent-native-mcp/register.js（38 tan_* + 7 app_* 工具）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-testagent-native.html>
- English docs: <https://aiti.pw/en/extensions/aiti-testagent-native.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
