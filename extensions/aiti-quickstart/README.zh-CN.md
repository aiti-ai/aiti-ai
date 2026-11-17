# @aiti-ai/aiti-quickstart

> 空白态引导扩展——新建会话欢迎页 widget（上手步骤 / 快捷操作 / 任务运行时 / 示例提示词，走宿主 newSessionWidgets 插槽可 ⚙ 自定义）+ 左栏 DockStack 全折叠空白引导卡（与应用中心同屏共存，✕ 可关闭）+ v2 工作区获取 Hub（Git 克隆 / 上传压缩包 / 本地目录 / 新建）+ 侧栏「快速上手」静态条目（应用中心可钉住卡片，点击重返 quickstart 欢迎页）

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 会话与项目 · tags: `quickstart` · `onboarding` · `guide` · `welcome` · `new-session-widgets` · `filler` · `get-started`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-quickstart/` 后 reload。

软依赖（缺席自动降级）：session-manager（经 `aiti-quickstart.api` 服务渲染进 DockStack filler，上半、应用中心在下）、aiti-event-bus（clone 进度帧）、aiti-model-wizard（配置模型深链）。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-quickstart.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-quickstart.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
