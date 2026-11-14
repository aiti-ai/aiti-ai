# @aiti-ai/aiti-model-wizard

> 引导添加 AI 提供商/模型：目录搜索（models.dev + 国内 AI 目录，中英文，贴 API 地址也能反向搜到）→ 填 token → 测试（2xx/429 都算通过）→ 选/输模型 → 写 models.json；找不到用 baseUrl 反向匹配（任意文档/代码片段自动提取 URL）/ 自动探测（漏 v1/v2 也能补，命中带 key 拉模型列表 + OpenAPI/模型前缀品牌信号）；编辑时 token 打码不返回前端

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: AI 能力 · tags: `model` · `provider` · `wizard` · `onboarding` · `models.dev` · `catalog`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-model-wizard/` 后 reload。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-model-wizard.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-model-wizard.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
