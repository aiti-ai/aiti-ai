# @aiti-ai/aiti-codehub（研发平台）

> pi-web 的多平台研发协作入口：用同一套元语管理 **云效 / GitHub / Gitee / GitLab** 的工作项与代码库，
> 支持 PAT + OAuth（每个平台可有多个账号）、AI 工具，以及「获取工作区」里的克隆来源。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/aiti-ai) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台 / 生态仓库（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 研发协作 · tags: `codehub` · `workitem` · `yunxiao` · `github` · `gitee` · `gitlab` · `multi-account` · `agent`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-codehub/`，运行 `node tools/build-client.mjs` 后 reload。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-codehub.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-codehub.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 功能

- **工作项面**：云效项目/工作项（搜索、筛选、详情、评论、自定义字段）；GitHub/Gitee/GitLab 的 Issues（按仓库，列表/详情/评论）。工作项窗口**默认浮窗**，可从浮窗头行停靠到右栏/左栏。
- **代码面**：命名空间/代码组 → 仓库 → 分支，收藏、克隆地址、合并请求（云效）。
- **两个独立功能面**：默认停靠右栏，可浮窗或移到左栏；「最近」属于工作项面，「设置」两面共享。
- **多账号**：同一平台可配多个账号（个人 / 公司 / 机器人）。默认账号 id 就是平台 id（`github`），其余为 `github~work`；别名可改，凭据、收藏、最近、缓存按账号隔离。
- **AI 工具**：`aiti_codehub_*` 查工作项、仓库、分支，按模板建分支，创建合并请求（需显式开启）。
- **富文本**：RICHTEXT（净化 HTML）与 Markdown 描述都按格式渲染；云效工作项里的图片/附件经扩展代理读取（PAT 不下发浏览器）。
- **工作区集成**：克隆复用 aiti-quickstart 的克隆引擎，在「获取工作区」里以「代码托管」来源出现。

## 平台支持

| 平台 | 鉴权 | 工作项 | 代码 | 合并请求 |
|---|---|---|---|---|
| 云效 | PAT + OAuth（DCR + PKCE，零配置） | 项目/工作项 | 代码组/仓库/分支 | 创建 |
| GitHub | PAT + 设备码（共享 OAuth App）+ 本机 `gh` CLI | Issues | org/仓库/分支 | 只读 |
| Gitee | 仅 PAT（本轮） | Issues | 组织/仓库/分支 | 只读 |
| GitLab | PAT + 设备码（共享 non-confidential 应用，17.1+） | Issues | group/仓库/分支 | 只读 |

## 多账号

- 设置页左树：平台行 `+` 新建账号，行内齿轮改名（别名），`×` 删除（凭据、缓存、收藏、最近、未完成的登录一并清理）。
- 选择器按平台分组（`云效 / 个人云效 / 公司云效`），单账号时压平，与旧版视觉一致。
- 账号 id 稳定：默认账号 = 平台 id，其余 = `平台~slug`；只有别名可改。「设为默认」决定各面首次打开的账号。
- AI 工具可直接传实例 id（`github~work`），或在平台 id 上加 `account`（别名/slug）；模板新增 `{account}`，`{provider}` 仍是平台名。

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-codehub/`，运行 `node tools/build-client.mjs` 后 reload。

生产部署需明确同意后加 `--prod`。

## 配置

打开 CodeHub 设置（工具图标 → 齿轮，或扩展管理）→ 平台页签：

- **云效 OAuth 无需注册应用**：扩展自动做元数据发现、DCR 动态注册与 PKCE；回调是扩展 middleware 提供的虚拟落地页（非 `/api`），默认 `http://127.0.0.1:30141`，可在设置里改成当前实例（如 `http://127.0.0.1:30142/dev`）。
- **GitHub / GitLab** 用设备码：设置里填共享公共应用的 Client ID，登录时输入页面显示的代码；无 secret、无回调。
- **Gitee** 本轮用 PAT，无需应用。
- 自建 GitLab / GitHub Enterprise 支持自定义 `baseUrl`。
- PAT 只存本机服务端 `config/providers/<id>.json`（0600），API 不回显。

## 使用

- 工具图标 → 工作项浮窗（可停靠）；右栏「代码库」页签（工作项停靠后也有「工作项」页签）。
- 工作项详情：富文本描述（Markdown/HTML）+ 图片 + 附件；复制 / 写提交框 / 建分支 / 发送当前会话 / 新会话 / 打开网页。
- 代码库：搜索、收藏、复制 clone 地址、克隆（弹窗）、创建 MR（云效）。
- 获取工作区 → 「代码托管」→ 平台 → 仓库 → 分支 → 目标目录 → 克隆。

## 开发

```bash
npm run build:client   # vite → dist/aiti-codehub-client.mjs
npm test               # node --test tests/*.test.mjs
node tools/deploy.mjs  # dev 部署 + reload
```

## 安全

每个账号独立存 `providers/<实例>.json`（0600），API 与日志脱敏；富文本经 DOMPurify 净化；云效文件经服务端代理（仅工作项文件端点 + 域名白名单）；OAuth 一次性 state（10 分钟）+ PKCE；落地页为非 `/api` 的 middleware 路由，同源 POST 兑换；设备码轮询仅登录期间（成功/取消/过期即停）；
出站域名按平台白名单；克隆地址只取平台 API 返回值；富文本转纯文本 + 图片链接（不用 innerHTML）。

## License

MIT
