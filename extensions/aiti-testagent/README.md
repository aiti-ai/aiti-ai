# @aiti-ai/aiti-testagent

> Java 后端 AI 调试 MCP + IDE —— 扫描 Java 进程/attach 一键连桥/Tunnel 桥多端点纳管，JVM 内任意修改/Mock·SQL 拦截模拟/热更新/诊断采样，57 工具 10 组按需暴露，全可逆

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

Java 后端 AI 调试 MCP + IDE —— 扫描 Java 进程/attach 一键连桥/Tunnel 桥多端点纳管，JVM 内任意修改/Mock·SQL 拦截模拟/热更新/诊断采样，57 工具 10 组按需暴露，全可逆

调试 · tags: `java` · `jvm` · `debug` · `hotswap` · `mcp` · `testagent` · `spring-boot` · `solon` · `arthas` · `mock` · `hot-reload` · `tunnel` · `bridge` · `multi-endpoint`

## Positioning (English)

AI debugging MCP + IDE for Java backends — scan Java processes / attach one-click bridge connect / tunnel-bridge multi-endpoint management; arbitrary in-JVM modification / Mock & SQL interception simulation / hot updates / diagnostic sampling; 57 tools in 10 groups exposed on demand, fully reversible

## 安装 / 部署

```bash
# 1) 目标 JVM 挂载 agent（httpPort 开出 HTTP API；也可运行后用 ta_attach 动态挂载）
java -javaagent:testagent.jar=conf-dir -Dtestagent.httpPort=8564 -jar app.jar
# 2) MCP 客户端（~/.config/mcp/mcp.json）加：
"aiti-testagent": { "command": "node", "args": ["<pi-web-ext>/aiti-testagent/mcp-testagent.cjs"] }
# 3) 按组过滤暴露面（可选）：--tools "lifecycle observe jvm" --exclude ta_heapdump
# 开关多时不必堆 -D：项目根放 testagent.properties（testagent.* 前缀），从子目录启动自动向上发现
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-testagent.html>
- English docs: <https://aiti.pw/en/extensions/aiti-testagent.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
