# @aiti-ai/aiti-recovery

> 恢复 UI 扩展——队列恢复对话框（会话中断排队消息逐条决议）+ 重启恢复向导（中断会话两步处理），红线语义保留：绝不自动投递，续跑只发「继续」

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

恢复 UI 扩展——队列恢复对话框（会话中断排队消息逐条决议）+ 重启恢复向导（中断会话两步处理），红线语义保留：绝不自动投递，续跑只发「继续」

聊天增强 · tags: `recovery` · `queue` · `restart` · `wizard` · `defork`

## Positioning (English)

Recovery UI extension — queue recovery dialog (resolving queued messages left by interrupted sessions one by one) + restart recovery wizard (two-step handling of interrupted sessions), red-line semantics preserved: never auto-deliver, resuming only sends "continue"

## 安装 / 部署

```bash
# 部署到 ~/.pi/web/extensions/aiti-recovery/ 后 reload（需宿主 ≥ recoveryDialog 插槽版本，defork B3）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-recovery.html>
- English docs: <https://aiti.pw/en/extensions/aiti-recovery.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
