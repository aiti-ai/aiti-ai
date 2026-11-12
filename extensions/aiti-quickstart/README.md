# @aiti-ai/aiti-quickstart

> 空白态引导扩展——新建会话欢迎页 widget（上手步骤 / 快捷操作 / 任务运行时 / 示例提示词，走宿主 newSessionWidgets 插槽可 ⚙ 自定义）+ 左栏 DockStack 全折叠空白引导卡（与应用中心同屏共存，✕ 可关闭）+ v2 工作区获取 Hub（Git 克隆 / 上传压缩包 / 本地目录 / 新建）+ 侧栏「快速上手」静态条目（应用中心可钉住卡片，点击重返 quickstart 欢迎页）

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

空白态引导扩展——新建会话欢迎页 widget（上手步骤 / 快捷操作 / 任务运行时 / 示例提示词，走宿主 newSessionWidgets 插槽可 ⚙ 自定义）+ 左栏 DockStack 全折叠空白引导卡（与应用中心同屏共存，✕ 可关闭）+ v2 工作区获取 Hub（Git 克隆 / 上传压缩包 / 本地目录 / 新建）+ 侧栏「快速上手」静态条目（应用中心可钉住卡片，点击重返 quickstart 欢迎页）

会话与项目 · tags: `quickstart` · `onboarding` · `guide` · `welcome` · `new-session-widgets` · `filler` · `get-started`

## Positioning (English)

Blank-state onboarding extension — new-session welcome page widgets (getting-started steps / quick actions / while-it-runs concepts / sample prompts, via the host newSessionWidgets slot, ⚙ customizable) + a left sidebar DockStack fully-collapsed blank guide card (shares the screen with the app center, ✕ dismissible) + a v2 workspace-acquisition Hub (Git clone / upload archive / local directory / create new) + a sidebar "Quick Start" static entry (pinnable as a card in the app center; clicking returns to the quickstart welcome page)

## 安装 / 部署

```bash
node pi-web-ext/aiti-quickstart/tools/deploy.mjs   # 双实例部署 + reload；
# 消费方 session-manager（optionalDependsOn 软依赖）经 aiti-quickstart.api 服务渲染进 DockStack filler（上半，应用中心在下）；
# 另软依赖 aiti-event-bus（clone 进度帧）与 aiti-model-wizard（配置模型深链，缺席降级）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-quickstart.html>
- English docs: <https://aiti.pw/en/extensions/aiti-quickstart.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
