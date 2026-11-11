# @aiti-ai/aiti-plan-first

> AI 开发先方案后动手 —— aiti-git-trace 事件感知（推-听架构零扫描）：md 变更弹绑定向导（方案命名优先）、大改未跟方案提醒、领先提醒「先做方案」、tags 闭环（front-matter 事实源 + 手工/自荐标签）、会话列表行前部 📋 绑定标

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

AI 开发先方案后动手 —— aiti-git-trace 事件感知（推-听架构零扫描）：md 变更弹绑定向导（方案命名优先）、大改未跟方案提醒、领先提醒「先做方案」、tags 闭环（front-matter 事实源 + 手工/自荐标签）、会话列表行前部 📋 绑定标

开发工具 · tags: `plan-first` · `git-trace` · `reminder` · `sse` · `workflow` · `tags` · `plan`

## Positioning (English)

AI development, plan first then act — aiti-git-trace event awareness (push-listen architecture, zero scanning): md changes pop the binding wizard (plan-named files prioritized), reminders for big changes without plan updates and for getting ahead with "do the plan first", a tags closed loop (front-matter as the source of truth + manual/self-nominated tags), and a 📋 binding badge at the front of session list rows

## 安装 / 部署

```bash
# 依赖：aiti-git-trace ≥0.2.0（services.trace v2 事件出口；缺席自动休眠，手动绑定仍可用）
# 部署：node pi-web-ext/aiti-plan-first/tools/deploy.mjs 后 POST /api/extensions/reload
# pi 扩展 emit 需重启 pi 进程生效（终端桥接会话不触发自动提醒——见方案文档 §9）；另需
#   aiti-prompts（slogan 提示词编辑）、aiti-doc-center（tag 词表/🧵 会话视图消费绑定标）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-plan-first.html>
- English docs: <https://aiti.pw/en/extensions/aiti-plan-first.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
