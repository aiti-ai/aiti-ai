# @aiti-ai/aiti-models-import

> 其他 agent models 配置导入——扫描 codex/ZCode/OpenCode 的 provider·模型配置成草稿，首启弹窗一次性引导导入；落盘一律经 aiti-model-wizard saveBatch（可一步撤销），绝不直写 models.json

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

其他 agent models 配置导入——扫描 codex/ZCode/OpenCode 的 provider·模型配置成草稿，首启弹窗一次性引导导入；落盘一律经 aiti-model-wizard saveBatch（可一步撤销），绝不直写 models.json

AI 能力 · tags: `models` · `import` · `migration` · `codex` · `zcode` · `opencode` · `onboarding` · `wizard`

## Positioning (English)

Imports models config from other agents — scans codex/ZCode/OpenCode provider·model configs into drafts, with a first-launch dialog guiding a one-time import; persistence always goes through aiti-model-wizard saveBatch (undoable in one step), never writes models.json directly

## 安装 / 部署

```bash
node pi-web-ext/aiti-models-import/tools/deploy.mjs   # vite 构建 + 双实例部署 + reconcile + reload
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-models-import.html>
- English docs: <https://aiti.pw/en/extensions/aiti-models-import.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
