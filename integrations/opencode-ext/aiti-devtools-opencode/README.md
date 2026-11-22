# @aiti-ai/aiti-devtools-opencode

> OpenCode host 插件（动态注册桥全部 aiti_* 工具 + messages.transform 占位符改写 + session.error 中止/出错回桥 + 冷启动全清单自愈占位）+ 官方 web UI 即 AI 窗（nginx 反代剥 CSP + sub_filter 注入，不 fork）

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

OpenCode host 插件（动态注册桥全部 aiti_* 工具（tools/list 驱动，当前 19 个） + messages.transform 占位符改写）+ 官方 web UI 即 AI 窗（nginx 反代剥 CSP + sub_filter 注入，不 fork）

宿主适配 · tags: `opencode` · `adapter` · `plugin` · `messages-transform` · `webui` · `placeholder`

## Positioning (English)

OpenCode host plugin (dynamic in-process registration of all bridge aiti_* tools, driven by tools/list, currently 19 + messages.transform placeholder rewriting) + the official web UI serves as the AI window (nginx reverse proxy strips CSP + sub_filter injection, no fork)

## v0.3.2 变更（2026-11-13）

- **session.error 回桥**：只有 session.idle 不足以收尾——会话报错/用户中止时 AI 窗侧会悬挂；现在 `session.error`（`MessageAbortedError` → ⏹ 中止提示，其余 → ⚠️ 错误文本）也回桥落消息流
- **冷启动全清单自愈占位**：opencode 先于桥启动时，此前只注册 2 个占位工具且重启前不自愈；现按核心静态清单 `BRIDGE_TOOLS`（core 0.3.13 新导出）注册全量 19 工具占位（真实 schema），execute 调用时重拉 tools/list 自动派发——桥恢复即自愈，无需重启 opencode。注：opencode 插件工具表进程级静态，桥重启后**新增**的工具仍需重启才进模型工具列表
- 依赖：`@aiti-ai/aiti-devtools-core` ^0.3.13（注意：私仓 0.3.12 是 2026-11-11 一次游离发布，内容系旧基底不含 pair 模块；0.3.13 为仓库谱系超集，^range 解析自动落到 0.3.13）

## 测试 / Testing

```bash
# 桥/插件全链路自动化 E2E（6 用例：工具清单 / 注册 / 推送注入回桥 / 占位符改写 / 交互卡闭环）
# 环境依赖：独立桥 127.0.0.1:8777 + opencode serve 127.0.0.1:19870（缺任一自动 skip，同 shim-e2e 约定）
# 默认用 opencode 免费模型（opencode/glm-5.3-flash-free，零成本）；AITI_OC_E2E_MODEL 覆盖
node --test opencode-ext/aiti-devtools-opencode/test/e2e-bridge.test.mjs
# 或进标准测试面（PKG_ROOTS 已含 opencode-ext）：
node scripts/test-web-ext.mjs --with-pkg --only e2e-bridge
```

基线（2026-11-13，48 机）：7/7 pass（T1 工具清单 19 个 / T2 注册 / T3 推送→注入→回显→answer 落桥 / T4 占位符展开→aiti_consumed 清候选 / T5 user_confirm→SSE 卡→模拟点击→模型收到 approved+comment / T6 中途 abort→session.error→⏹ 回桥落消息流）。手动 E2E（真 Chrome 页面腿）见上 2026-11-07 复检记录。

## 安装 / 部署

```bash
# npm 包（opencode.json）
{ "plugin": ["@aiti-ai/aiti-devtools-opencode"] }
# 或本地：cd opencode-ext/aiti-devtools-opencode && npm run deploy（→ ~/.config/opencode/plugins/）
# 桥默认 http://127.0.0.1:8777（AITI_BRIDGE_URL 覆盖——裸 base，不带 /aiti，插件自补；带尾巴会变 /aiti/aiti）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-devtools-opencode.html>
- English docs: <https://aiti.pw/en/extensions/aiti-devtools-opencode.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
