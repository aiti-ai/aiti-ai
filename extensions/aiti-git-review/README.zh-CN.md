# @aiti-ai/aiti-git-review

> 专职审核未提交变更 —— Monaco diff 工作区（并排/合并/纯新/大纲）+ 行级标注（必须/建议/疑问）+ anchor 标志行重映射（边审边改不失效）+ 汇总终审清单 + AI 预审（aiti_review_* 工具只注入评审会话，日常零工具）

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 开发工具 · tags: `git` · `review` · `diff` · `monaco` · `annotation` · `pre-review`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-git-review/` 后 reload。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-git-review.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-git-review.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
