# 三市场发布指南（Chrome Web Store / Edge Add-ons / Firefox AMO）

> 配套：[STORE-REVIEW.md](STORE-REVIEW.md)（合规基线与审核应答文案）——本文是**逐步操作手册**。
> 产物：`npm run build && npm run package` → `dist/aiti-devtools-chrome.zip` / `-edge.zip` / `-firefox.zip` / `-firefox.xpi`。

## 0. 通用前置（三市场共用）

### 0.1 版本号
- 唯一来源：`package.json` 的 `version` → build 时写入三端 manifest
- **每次重传必须递增**（三市场都拒收同版本号）；语义化建议：功能 +0.1、大改 +1.0
- 对齐生态版本节奏：随 `pi-web-ext/tools/publish-all.mjs` 的发布轮一起 bump

### 0.2 隐私政策页（提交阻塞项）✅ 已就绪
- 页面已入库：`aiti-docs/docs/.vuepress/public/privacy.html`（双语品牌页，静态无依赖）——
  随文档站部署后 **https://aiti.pw/privacy.html** 即为三市场表单填写的 URL
- 下一次文档站 deploy 后生效；提交前 curl 校验 200 即可

### 0.3 审核应答文案
- `eval`/`<all_urls>`/单一用途的**现成粘贴文案**：见 [STORE-REVIEW.md §2](STORE-REVIEW.md)（英文）
- 提交表单的「权限用途说明」栏逐项填：storage=保存用户设置；activeTab/scripting=按需向当前被调试页注入；host_permissions=任意网页可作为调试目标（默认关，用户显式启用）

## 1. Chrome Web Store

### 1.1 账号（一次性）
1. [注册开发者账号](https://developer.chrome.com/docs/webstore/register)——**$5 一次性**（2025-2026 未变）
2. 需 Google 账号 + 邮箱验证 + 身份/税费信息

### 1.2 上传包
`dist/aiti-devtools-chrome.zip`（manifest 在 zip 根；icons 已随包）

### 1.3 提交步骤
1. 开发者后台 → New item → 上传 zip
2. **Store listing**：名称 `aiti devtools`、简短描述（≤132 字符）、详细描述、分类 `Developer Tools`、语言、截图 1280×800 ×1-5（`store-assets/cws/` 有现成合成图）、商店 icon 128×128
3. **Privacy 标签**（关键）：
   - Single purpose：`An in-page AI debugging assistant for web developers — inject a debugging console into the page being developed and collaborate with an AI agent.`
   - Host permission justification：`Injects the debugging assistant into any webpage the user chooses to debug. Injection is OFF by default and only happens on explicit per-page enable, site allowlist, or user action.`
   - `storage` justification：`Saves the user's local settings (AI target address, site rules).`
   - Remote code：`No remotely hosted code. All code is bundled at build time; runtime network calls go only to user-configured local/self-hosted services.`
   - 隐私政策 URL：`https://aiti.pw/privacy`
   - Data usage 表单：不收集个人数据 / 不出售数据 / 数据仅存浏览器本地
4. Distribution：Public 或 Unlisted（内部用选 Unlisted 可大幅降低审核强度——**首推**）
5. Submit for review

### 1.4 审核预期
- 常规数小时～数天；`<all_urls>`+content script 偶发人工深审（可能要求演示视频：录「popup ⚡ 启用 → AI 修页面元素」30 秒）
- 被拒高频原因与应答：见 STORE-REVIEW.md §2 的 eval/host_permissions 文案

### 1.5 更新
- bump `package.json` version → 重新 build/package → 后台上传新 zip（listing 保留）

## 2. Edge Add-ons

### 2.1 账号（免费）
1. [Partner Center 注册](https://partner.microsoft.com/dashboard/microsoftedge)——**免费**，Microsoft 账号即可

### 2.2 上传包
`dist/aiti-devtools-chrome.zip`（与 CWS 同一份 Chromium 包）

### 2.3 提交步骤
1. Partner Center → Create new extension → 上传 zip（素材：logo 用 `store-assets/edge/logo-300x300.png`）
2. Listing：名称/描述/分类 `Developer Tools`/隐私政策 URL（**必填**）/截图 1280×800/商店 logo 300×300（可由 icon128 放大或重出）
3. 权限说明：同 §0.3 文案
4. Submit

### 2.4 审核预期
- 通常 1-7 个工作日；被拒原因同 CWS（应答同款）

### 2.5 更新
- Partner Center 上传新 zip（version 递增同 §0.1）

**首版已提交（2026-11-14）**：Individual/China 账号 · productID `a67742d4-29b9-486b-a885-e614ffabf13d` · Store ID `0RDCK9WD8CT8` · CRX ID `hmlahjeickndfhaabglgiejhhmcfijil` · Public · 241 市场 · In review（~7 工作日）。标识存 `~/.aiti/store-credentials.json`。

实测踩坑（chrome-devtools MCP 自动化）：① listing 编辑页的 Save draft 后 UI alert 不可靠，用 `list_network_requests` 抓 `PUT /listings/storeListings/...` 200 验证；② Add Image 有 4 个（logo/promo小图/截图/promo大图），传错区会报尺寸错误且错误 alert 残留；③ Publish → Submit 页必填 Notes for certification（审核员说明），漏填提交仍会成功但有被 flag 风险；④ submission 一旦发出状态即 In review，Cancel submission 可撤回。

## 3. Firefox Add-ons（AMO）

Firefox 三条安装路线（按需选）：

### 3.1 临时载入（开发调试，免签）
`about:debugging#/runtime/this-firefox` → 载入 `dist/firefox/manifest.json`（重启消失）

### 3.2 自分发签名（unlisted——Android/正式版永久安装的唯一路）
1. AMO 注册账号 → [Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/) 生成 JWT Key/Secret
2. `npm i -g web-ext`
3. 签名：
   ```bash
   web-ext sign \
     --api-key=$AMO_JWT_KEY --api-secret=$AMO_JWT_SECRET \
     --channel=unlisted \
     --source-dir=dist/firefox
   # → web-ext-artifacts/aiti-devtools-<ver>-signed.xpi
   ```
   - unlisted 签名即时完成、不上架商店；**已签 xpi 可在正式版/Android 直接安装**（gecko id 已固定，同 id 重签可覆盖更新）
4. Android 安装：把签名 xpi 放到可达 URL / 传到手机 → Firefox Android 打开该文件 → 确认安装

### 3.3 上架 AMO（listed，可选）
- AMO 后台上传 `dist/aiti-devtools-firefox.xpi`（或 zip）+ listing 素材 + 隐私政策
- **eval 说明必填**（AMO 对 eval 敏感）：粘贴 STORE-REVIEW.md §2.1 英文应答
- **源码可能被索**：构建非压缩可读 ✓；被要求时提交 `browser-ext/` 源码目录 + 构建说明
- AMO 审核数天；未过会有明确 rejection reason 与申诉入口

### 3.4 更新
- 同 gecko id 重传新版本（listed）或重签（unlisted）；已装用户按 Firefox 更新机制拉取（unlisted 需自建 update_url 或引导重装）

## 4. 发布节奏建议

1. 版本 bump（package.json）→ `npm run build && npm run package`
2. 本地冒烟：三端各装一遍（Chrome/Edge 加载目录、Firefox 临时载入）
3. 三市场同版本号提交（CWS/Edge zip、AMO xpi）
4. 审核通过后：aiti.pw 文档站版本角标 / README 对齐

## 5. 自动发布途径（2026-11 调查结论）

三市场**均有官方自动化途径**，但凭据均未配置（2026-11-14 核查）；AI 发布 skills：`~/.pi/agent/skills/publish-browser-ext/`（双模式：API 优先 / chrome-devtools MCP 浏览器自动化兜底）。

| 市场 | API | 首次上架 | 凭据前置 |
|---|---|---|---|
| AMO | `web-ext sign --channel=unlisted`（JWT） | ✅ unlisted 免后台即时签名 | AMO API key（网页一键生成） |
| CWS | Publish API v1.1（upload/publish/status） | ❌ API 不能建新 item，首版必须后台 | OAuth client + refresh_token |
| Edge | Partner Center REST（draft/package + publish） | ❌ 首版要后台创建 | Azure AD client_id/secret + productID |

凭据统一存 `~/.aiti/store-credentials.json`（不进 git）；首次上架走浏览器自动化（登录态 + `upload_file` 传 zip + 表单文案见 §1.3/§0.3）。

## 6. 被拒高频原因 → 应对速查

| 拒因 | 应对 |
|---|---|
| Remote code policy | 引用 §0.3 Remote code 文案（构建期内联、无第三方代码源） |
| Broad host permissions | 引用 §0.3 host permission 文案 + 默认关 + 演示视频 |
| Missing privacy policy | 部署 §0.2 页面后重提 |
| Misleading functionality | listing 描述与实际能力一致（调试助手，非「AI 修 bug 神器」类营销话术） |
| Signature invalid (AMO/Android) | 重跑 §3.2 签名；确认 gecko id 未变 |
| 同版本号拒收 | bump `package.json` version 重新 build/package（§0.1） |
