# aiti-append-system · 追加系统提示词管理（pi-web 扩展）

管理 pi 的追加系统提示词（APPEND_SYSTEM.md）：**全局** `~/.pi/agent/APPEND_SYSTEM.md`
（所有项目生效）与**项目级** `<cwd>/.pi/APPEND_SYSTEM.md`（仅该项目）两级，在线编辑、
即时写入，无需登录服务器手改文件。

## 功能

| 功能 | 说明 |
|---|---|
| 两级作用域 | 全局 / 项目（`<cwd>/.pi/`）——面板内切换，写入即生效 |
| 在线编辑 | 现有内容读入 + 编辑 + 覆盖/追加两种写入模式（write / append） |
| 🤖 AI 起草（write-append skill） | 帮助点输入"想让 AI 永远记住什么"→ AI 起草命令式规则（JSON 契约：scope/cwd/mode/content）→ 直写目标文件 |
| 📝 工具条入口 | 工具条按钮（feature `append.toolbar` 默认关，extman 开启）；面板也可从 extman 打开 |

## pi 侧语义

- pi 引擎自动加载全局与项目的 `APPEND_SYSTEM.md` 追加进系统提示词；本扩展只管
  **编辑与写入**，不改变 pi 的加载行为
- 写入为原样文本（多条规则换行分隔，简短命令式）
- AI 起草契约（`skills/write-append/SKILL.md`）：`{scope: global|project, cwd, mode: write|append, content}`

## 安装与构建

```bash
# 扩展目录内安装依赖并构建 client（本仓 clone 后首次）
npm install && npm run build:client

# pi-web extman 安装（本地路径 / git 来源均可）
#   extman › install › pi-web 扩展目录路径
# 或放到 PI_WEB_EXTENSIONS_DIR 后：POST /api/extensions/reload
```

## 依赖

- 运行时共享层：`@aiti-ai/ext-shared`（本仓 `extensions/_shared/`）
- 无轮询；配置文件写入遵守 config 层（aiti-configs 备份范围）
