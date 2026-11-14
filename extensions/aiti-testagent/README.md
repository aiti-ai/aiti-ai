# @aiti-ai/aiti-testagent

> AI debugging MCP + IDE for Java backends — scan Java processes / attach one-click bridge connect / tunnel-bridge multi-endpoint management; arbitrary in-JVM modification / Mock & SQL interception simulation / hot updates / diagnostic sampling; 57 tools in 10 groups exposed on demand, fully reversible

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Debugging · Tags: `java` · `jvm` · `debug` · `hotswap` · `mcp` · `testagent` · `spring-boot` · `solon` · `arthas` · `mock` · `hot-reload` · `tunnel` · `bridge` · `multi-endpoint`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-testagent/` and reload pi-web.

Attach the agent to the target JVM and register the MCP server:

```bash
# 1) Attach the agent to the target JVM (httpPort exposes the HTTP API; ta_attach can also attach at runtime)
java -javaagent:testagent.jar=conf-dir -Dtestagent.httpPort=8564 -jar app.jar

# 2) Register in your MCP client config (~/.config/mcp/mcp.json):
#    "aiti-testagent": { "command": "node", "args": ["<pi-web-ext>/aiti-testagent/mcp-testagent.cjs"] }

# 3) (Optional) filter the exposed tool surface by group: --tools "lifecycle observe jvm" --exclude ta_heapdump
#    Many toggles? Drop a testagent.properties (testagent.* keys) in the project root instead of -D flags —
#    it is discovered by walking up from the startup directory.
```

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-testagent.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-testagent.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
