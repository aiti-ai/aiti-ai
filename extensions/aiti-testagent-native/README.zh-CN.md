# @aiti-ai/aiti-testagent-native

> testagent-native（Windows 原生进程活体操控）可视面 —— broker 进程/会话/挂钩/事件流；原 aiti-wintrace（2026-11-07 改名）

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 调试 · tags: `windows` · `native` · `win32` · `com` · `detours` · `injection` · `hook` · `trace` · `hotpatch` · `tan` · `testagent-native`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-testagent-native/` 后 reload。

常驻 tan broker 并接入面板 / AI：

```bash
# 1) 常驻 tan broker（Windows：Startup 文件夹放 start-tan.vbs 自启——broker 8765/8766 + MCP HTTP 8767）
#    手动：<repo>/native/build/win64-release/bin/<current-broker.txt> --port 8765 --http-port 8766

# 2) 本面板随 pi-web 扩展部署自动生效（工具条「Win」入口）；数据源 broker HTTP 8766（env TAN_BROKER_HTTP 可改）

# 3) AI 侧走 testagent-native-mcp：node mcp/testagent-native-mcp/register.js（38 tan_* + 7 app_* 工具）
```

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-testagent-native.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-testagent-native.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
