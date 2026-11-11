# @aiti-ai/aiti-app-center

> 左栏区块栈全部折叠后空白态的应用抽屉（开始菜单）——应用视图（动作/面板/管理入口卡，hover 快捷钉 + 信息页）与开关视图（feature 开关按扩展分组）双视图单行切换，tag 式分类（内部固定分类多语 + 自定义分类 + 默认 other）、按视图搜索、编辑模式排序/隐藏/恢复

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

左栏区块栈全部折叠后空白态的应用抽屉（开始菜单）——应用视图（动作/面板/管理入口卡，hover 快捷钉 + 信息页）与开关视图（feature 开关按扩展分组）双视图单行切换，tag 式分类（内部固定分类多语 + 自定义分类 + 默认 other）、按视图搜索、编辑模式排序/隐藏/恢复

系统与管理 · tags: `app-center` · `launcher` · `start-menu` · `dock` · `spacer` · `category` · `apps`

## Positioning (English)

The app drawer (start menu) shown in the blank state after every left-column dock block is collapsed — a single-row switch between the Apps view (action/panel/manage entry cards, hover quick-pin + info page) and the Toggles view (feature toggles grouped by extension), tag-style categories (8 fixed internal categories with i18n + custom categories + default other), search scoped per view, and edit-mode reorder/hide/restore

## 安装 / 部署

```bash
node pi-web-ext/aiti-app-center/tools/deploy.mjs   # 双实例部署 + reload；
# 消费方 session-manager（optionalDependsOn 软依赖）经 aiti-app-center.api 服务渲染进 DockStack filler
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-app-center.html>
- English docs: <https://aiti.pw/en/extensions/aiti-app-center.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
