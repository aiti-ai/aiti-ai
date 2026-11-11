# @aiti-ai/aiti-model-check

> 模型健康度探测 —— 对每个模型发极小探针消息，看是否可用 / 429 限流 / 异常；解析限流恢复时间（Retry-After 等），记录历史识别可用窗口；长期限流到期提醒（纯本地时间检查零探测）

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

模型健康度探测 —— 对每个模型发极小探针消息，看是否可用 / 429 限流 / 异常；解析限流恢复时间（Retry-After 等），记录历史识别可用窗口；长期限流到期提醒（纯本地时间检查零探测）

AI 能力 · tags: `model` · `probe` · `429` · `rate-limit` · `availability` · `recovery-notify`

## Positioning (English)

Model health probing — sends a tiny probe message to each model to check availability / 429 rate limiting / errors; parses the rate-limit recovery time (Retry-After etc.), records history to identify availability windows; long-term rate-limit expiry reminders (pure local time checks, zero probing)

## 安装 / 部署

```bash
# 部署到 ~/.pi/web/extensions/aiti-model-check/ 后 reload
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-model-check.html>
- English docs: <https://aiti.pw/en/extensions/aiti-model-check.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
