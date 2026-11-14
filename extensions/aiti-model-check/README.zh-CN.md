# @aiti-ai/aiti-model-check

> 模型健康度探测 —— 对每个模型发极小探针消息，看是否可用 / 429 限流 / 异常；解析限流恢复时间（Retry-After 等），记录历史识别可用窗口；长期限流到期提醒（纯本地时间检查零探测）

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: AI 能力 · tags: `model` · `probe` · `429` · `rate-limit` · `availability` · `recovery-notify`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-model-check/` 后 reload。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-model-check.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-model-check.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
