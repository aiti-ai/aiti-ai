# @aiti-ai/aiti-model-wizard

> 引导添加 AI 提供商/模型：目录搜索（models.dev + 国内 AI 目录，中英文，贴 API 地址也能反向搜到）→ 填 token → 测试（2xx/429 都算通过）→ 选/输模型 → 写 models.json；找不到用 baseUrl 反向匹配（任意文档/代码片段自动提取 URL）/ 自动探测（漏 v1/v2 也能补，命中带 key 拉模型列表 + OpenAPI/模型前缀品牌信号）；编辑时 token 打码不返回前端

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

引导添加 AI 提供商/模型：目录搜索（models.dev + 国内 AI 目录，中英文，贴 API 地址也能反向搜到）→ 填 token → 测试（2xx/429 都算通过）→ 选/输模型 → 写 models.json；找不到用 baseUrl 反向匹配（任意文档/代码片段自动提取 URL）/ 自动探测（漏 v1/v2 也能补，命中带 key 拉模型列表 + OpenAPI/模型前缀品牌信号）；编辑时 token 打码不返回前端

AI 能力 · tags: `model` · `provider` · `wizard` · `onboarding` · `models.dev` · `catalog`

## Positioning (English)

Guided AI provider/model onboarding — catalog search (models.dev + domestic AI catalog, Chinese/English, paste an API URL to reverse-search) → enter token → test (both 2xx/429 count as pass) → pick/type a model → write models.json; on miss, baseUrl reverse matching (auto-extracts URLs from any doc/code snippet) or auto detection (fills missing v1/v2, pulls the model list with a key + OpenAPI/model-prefix brand signals); tokens are masked on every read and never returned to the frontend

## 安装 / 部署

```bash
# 部署到 ~/.pi/web/extensions/aiti-model-wizard/ 后 reload
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-model-wizard.html>
- English docs: <https://aiti.pw/en/extensions/aiti-model-wizard.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
