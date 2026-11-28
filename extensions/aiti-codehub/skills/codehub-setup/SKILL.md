---
name: codehub-setup
title: 平台接入配置（PAT / OAuth / 设备码向导）
title.en: "Provider setup (PAT / OAuth / device code guide)"
placeholder: 例：帮我把云效登录配好 / GitHub 的设备码怎么弄…
placeholder.en: "e.g. help me sign in to Yunxiao / how does GitHub device code work…"
summary: 逐步指导用户配置四个平台的 PAT、云效 OAuth（DCR+PKCE）、GitHub/GitLab 设备码与多账号（别名/默认/删除）
summary.en: "Step-by-step setup for the four providers: PAT, Yunxiao OAuth (DCR+PKCE), GitHub/GitLab device code, plus multiple accounts per platform (alias/default/delete)"
outputs:
  format: text
---

# codehub-setup · 平台接入向导

配置入口：pi-web → 顶栏 CodeHub 图标（或扩展管理打开「研发平台」）→ 设置 → 左侧**账号树**。
敏感值只存本机服务端（0600，每个账号一个文件），API 不回显；让用户自己在设置页填写，不要索要明文令牌。

## 多账号（同一平台多个账号）

同一平台可以配多个账号（个人 / 公司 / 机器人），凭据、收藏、最近、缓存按账号隔离：

1. 左树平台行右侧 `+` → 填**别名**（如「公司云效」）→「创建并配置」；
2. 右侧表单填 PAT 或走对应平台的 OAuth/设备码（GitHub/GitLab 的共享 Client ID 全平台共用一个，不必每个账号重填）；
3. 「设为默认」决定各面首次打开的账号；行内 `×` 删除账号（凭据/缓存/收藏/最近/未完成的登录一并清理，需二次确认）；
4. 别名随时可在表单顶部改；**实例 id 不可改**（默认账号 = 平台 id，其余 = `平台~slug`）；
5. 首次「测试连接」成功后，别名会自动取平台账号名（用户手动改过则不再覆盖）。

各组选择器按平台分组（`云效 / 个人云效 / 公司云效`），单账号时压平。

## 云效（零配置 OAuth）

1. 设置 → 云效 → 鉴权选 **OAuth** → 点「OAuth 登录」。
2. 扩展自动完成元数据发现 + 动态客户端注册（DCR）+ PKCE（S256），无需预先申请应用。
3. 浏览器登录并同意 → 回到扩展的虚拟落地页（`/<basePath?>/aiti-codehub/oauth/yunxiao`），页面同源兑换后提示完成。
4. 回调默认 `http://127.0.0.1:30141`（pi-web CLI 默认端口）。**当前实例端口不同时**，在设置里把「默认回调地址」改成实际地址（dev 例：`http://127.0.0.1:30142/dev`）。
5. 不想走 OAuth：PAT + 组织 ID。PAT 权限：组织（用户只读）、项目（项目/工作项只读）、代码管理（代码组/仓库/分支只读、合并请求读写）。

## GitHub（三选一：gh CLI / 设备码 / PAT）

**gh CLI（零应用注册，推荐已登录 gh 的开发者）**：设置 → GitHub → 鉴权选 **gh CLI** → 「检测 gh」→ 选择账号（显示 host/login/scopes）→「保存并使用」。
令牌由 `gh auth token` 按需读取，只存在服务端内存（60s 缓存），不写 config/state；scope 由 gh 决定（可能含写权限），扩展只做读操作。

**设备码（共享应用）**：

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App → 勾选 **Enable Device Flow**。
2. 复制 **Client ID**（不需要 secret、不需要回调地址）→ CodeHub 设置 → GitHub → 填入「共享应用 Client ID」→ 保存。
3. 点「OAuth 登录」→ 页面显示设备码并打开授权页 → 输入设备码并同意 → 设置页自动更新。
4. GHES：API 地址填 `https://ghe.example.com`（设备码端点同域）。

## GitLab（设备码，17.1+）

1. GitLab → 用户设置 → Applications → 新建 **non-confidential** 应用（不要 secret）。
2. Scopes：`read_api`、`read_user`；复制 **Application ID** → CodeHub 设置 → GitLab → 填入 Client ID → 保存。
3. 点「OAuth 登录」→ 输入设备码并同意。低于 17.1 的自建实例回退 PAT。
4. 自建：API 地址填 `https://gitlab.example.com`。

## Gitee（PAT）

1. `https://gitee.com/profile/personal_access_tokens` → 生成私人令牌，勾选 `projects`、`issues`。
2. 设置 → Gitee → PAT → 保存 → 测试连接。
3. 本轮不提供 Gitee OAuth（避免误以为需要注册应用）。

## 排障

- 云效回调打不开：确认「默认回调地址」是浏览器能访问的本机地址（端口/`basePath` 要对）；跨设备用不了 `127.0.0.1`。
- 云效落地页显示 `state 无效或已过期`：重新发起登录（state 一次性、10 分钟）。
- GitHub/GitLab 提示需要 Client ID：先在设置里填共享应用 Client ID。
- 设备码过期：重新点登录；服务端轮询在成功/取消/过期时立即停止。
- 云效 403：检查 PAT 权限与组织 ID；OAuth 用户检查是否登录了正确站点。
- 限流：面板会提示重试时间；列表有 TTL 缓存，减少刷新频率即可。
