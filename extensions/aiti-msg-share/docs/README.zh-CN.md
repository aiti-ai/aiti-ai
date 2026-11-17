# @aiti-ai/aiti-msg-share

> 分享会话、单条消息、划选内容、文件与图片——通过可配置的分享目标（Gitee / 图床 / 对象存储 / 笔记库），上传前自动脱敏，结果 URL 附二维码

[English](../README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的一部分——由 [pi](https://pi.dev) 驱动的个人 AI 开发工作台：**aiti-agent**（基于开源 [pi-web](https://github.com/aiti-ai/pi-web) 的自托管 Web 工作台），加上对主流开发工具的调试注入（aiti-devtools）与丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）：<https://github.com/aiti-ai/pi-web>
- 生态主仓：<https://github.com/aiti-ai/aiti-ai>
- 站点：<https://aiti.pw>

分类：内容与分享 · 标签：`分享` · `会话` · `消息` · `二维码` · `脱敏` · `sxcu` · `gitee` · `oss` · `joplin`

## 它做什么

工作台跑在你自己的机器上，会话 URL 外部访问不到。本扩展把你选中的内容通过**可配置的分享目标**上传，换回一个公网 URL——外加二维码、复制链接、以及（支持的平台上）系统分享面板。

只有你主动点分享才会发生，且**预览始终可编辑**，分享前能看到最终要发出去的内容。

## 可以从哪里分享

| 入口 | 分享内容 |
| --- | --- |
| 消息 hover 操作区 | 该条消息 |
| `msg-smart` 划选弹层（复制/引用/新会话那排） | 选中文本 |
| `msg-smart` 文件卡片 | 被引用的文件 |
| 会话行 → `⋯` 更多菜单 | 整个会话（markdown 导出） |
| 文件编辑器工具条 | 当前文件，或当前选区 |
| 图片预览窗 | 该图片 |
| 命令面板 | 分享中心 |

每个入口都是**宿主插槽或扩展 topic**——本扩展注册 provider，其他扩展负责渲染。没有硬编码按钮。

## 分享目标

161 个内置目标来自 [`@aiti-ai/content-share`](https://www.npmjs.com/package/@aiti-ai/content-share)：

- **发布类**（公网 URL）：Gitee Snippet、兰空图床、SM.MS、Pastebin、Rentry、paste.rs、阿里云 OSS，外加 ShareX `.sxcu` 全量目录（catbox、imgbb、gofile、0x0.st…）
- **存档类**（存进自己的笔记库）：Joplin、Obsidian Local REST、memos、思源、flomo
- **本机类**（不上传）：指向自己工作台会话的链接
- **自定义**：任意 HTTP 端点（`.sxcu` 配置或模板 provider）

分享弹窗默认只展示**推荐集**；「加更多…」打开完整目录（可搜索、带配置状态徽章 🟢 匿名 / 🟠 需配置 / ✓ 已配置 / 💀 已关停，一键**使用**）。

## 脱敏

上传前文本会过一遍 [`@aiti-ai/secret-mask-core`](https://www.npmjs.com/package/@aiti-ai/secret-mask-core)——与 `pi-secret-mask` 同源的确定性凭据检测引擎。命中的内容替换为 `[REDACTED:规则#hash]` 占位符并在预览中展示；勾选/取消会**立即重绘文本框**，取消时恢复原文。

二进制内容（图片/文件）不做扫描——界面会明确标注。

## 页面信息附加

预览区头部的多选框可以把上下文附加到分享内容前：**系统**、**浏览器**、**网址**、**会话 ID**、**会话名**。分享片段时方便对方知道来自哪台机器/哪个浏览器/哪个会话。

## AI 技能

通过 `aiti-helper` 的标准 `skills/` 机制声明：

- `configure-target` —— 引导获取并填入某平台的 token/密钥，然后测活
- `troubleshoot` —— 读分享历史、归类失败原因、建议修复或换目标
- `import-sxcu` —— 校验 ShareX 配置并注册为目标

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）打包——在应用内扩展管理器（ExtMan / 应用中心）启用。

单独使用需要 pi-web 宿主；本包不是通用库（通用能力见 [`@aiti-ai/content-share`](https://www.npmjs.com/package/@aiti-ai/content-share)）。

## 数据与隐私

- 目标凭据存于 `<configDir>/targets.json`（权限 `0600`），API 回显一律掩码。
- 上传走扩展自身 server 路由——浏览器不持有 token，也无 CORS 变通。
- 分享历史存于 `<stateDir>/shares.json`（保留最近 200 条）。
- 文件分享遵循宿主的允许目录策略（`ctx.core.fileAccess`）。

## 许可

MIT

[English](../README.md)
