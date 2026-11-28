---
name: codehub-code
title: 仓库 / 分支 / 克隆（多平台代码托管）
title.en: "Repositories, branches and clone (multi-platform code hosting)"
placeholder: 例：找一下云效代码组里的 xxx 仓库，看它的分支，克隆到工作区…
placeholder.en: "e.g. find repo xxx in the Yunxiao group, list its branches, and clone it into a workspace…"
summary: 用 aiti_codehub_repos / aiti_codehub_branches 浏览多平台仓库与分支，并指导克隆到工作区
summary.en: "Browse repositories and branches across platforms with aiti_codehub_repos / aiti_codehub_branches and guide cloning into a workspace"
outputs:
  format: text
---

# codehub-code · 代码库助手

工具：

| 工具 | 用途 |
|---|---|
| `aiti_codehub_providers` | 平台清单 + 已配置账号（`platforms` / `instances`，属多账号必先查） |
| `aiti_codehub_repos` | 列出/搜索仓库（可给 `namespace`：云效代码组 / GitHub org / Gitee 组织 / GitLab group） |
| `aiti_codehub_branches` | 列出/搜索某仓库的分支（`repoPath` 必填，`repoId` 可选） |

## 多账号（先查实例）

先调 `aiti_codehub_providers` 看 `platforms`（能配什么）与 `instances`（已配哪些账号）。
传参两种写法等价：

- `provider: "github~work"`（实例 id）；
- `provider: "github", account: "工作号"`（别名或 slug）。

只给平台 id（`github`）时用该平台的**默认账号**；平台有多个账号而用户没说清是谁，先列 `instances` 让用户选。
UI 里选择器按平台分组显示（`云效 / 个人云效 / 公司云效`）。

## 平台差异

- **云效**：命名空间是「代码组」；仓库 id 是数字，`repoPath` 形如 `group/repo`。
- **GitHub**：命名空间是 org 或用户名；`repoPath` = `owner/repo`。
- **Gitee**：命名空间是组织或用户名；`repoPath` = `owner/repo`。
- **GitLab**：命名空间是 group；`repoPath` = `group/subgroup/project`（含斜杠）。

## 克隆（UI 动作）

克隆由 UI 完成（「获取工作区」Hub 的「代码托管」来源，或代码面板的「克隆」按钮）：

1. 选平台 → 选仓库 → 选分支/协议（HTTPS/SSH）→ 选目标父目录；
2. 服务端复用 `aiti-quickstart` 的克隆引擎（staging、不覆盖已有目录、进度帧）；
3. 完成后自动切换新会话工作区。

你不需要自己拼 `git clone`；如用户坚持命令行，给出仓库的 HTTPS/SSH 地址即可（列表返回 `cloneHttp` / `cloneSsh`）。

## 只读边界

本版本 GitHub / Gitee / GitLab 只读：不创建 PR、不改 Issue、不 push。
云效可以创建合并请求（`aiti_codehub_mr_create`，需用户同意 + `confirm: true`）。
