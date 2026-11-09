# @aiti-ai/session-manager

> 跨项目会话面板 —— tag 树+颜色 / 收藏 / 搜索 / 归档 / 看板 / 新建会话分支·Worktree 选择器 / 23 家 agent 历史解析 / DockStack 编排

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

跨项目会话面板 —— tag 树+颜色 / 收藏 / 搜索 / 归档 / 看板 / 新建会话分支·Worktree 选择器 / 23 家 agent 历史解析 / DockStack 编排

会话管理 · tags: `sessions` · `tag` · `search` · `archive` · `worktree` · `dock` · `agents`

## Positioning (English)

Cross-project session panel — tag tree + colors / favorites / search / archive / kanban / new-session branch·Worktree picker / history parsing for 23 agent families / DockStack orchestration

## 安装 / 部署

```bash
# 部署到 ~/.pi/web/extensions/session-manager/ 后 reload：
curl -X POST http://127.0.0.1:<端口>/api/extensions/reload
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/session-manager.html>
- English docs: <https://aiti.pw/en/extensions/session-manager.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
