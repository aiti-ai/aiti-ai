# @aiti-ai/aiti-app-center

> 左栏区块栈全部折叠后空白态的应用抽屉（开始菜单）——应用视图（动作/面板/管理入口卡，hover 快捷钉 + 信息页）与开关视图（feature 开关按扩展分组）双视图单行切换，tag 式分类（内部固定分类多语 + 自定义分类 + 默认 other）、按视图搜索、编辑模式排序/隐藏/恢复

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 系统与管理 · tags: `app-center` · `launcher` · `start-menu` · `dock` · `spacer` · `category` · `apps`

## 扩展作者须知

- **命令即条目**：注册在 `commands` 命令目录槽的条目（带 `meta.onClick` + `icon`）会同时出现在应用中心**和**输入框的命令联想里——例如「选择模型」「压缩上下文」（由 `aiti-ai-input` 注册），用户不离开输入框就能完成操作。
- **关键词自声明**：搜索词写在条目 `meta.keywords` 或扩展顶层 `keywords`（`index.ts`，经 manifest 透传）。应用中心只对存量扩展兜底覆盖表——新扩展严禁再加表。扩展级关键词对该扩展所有卡片生效，命令别名请放条目级。

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-app-center/` 后 reload。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-app-center.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-app-center.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
