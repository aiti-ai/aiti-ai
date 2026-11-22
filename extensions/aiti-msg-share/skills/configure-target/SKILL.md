---
name: configure-target
title: AI 帮我配置分享目标
title.en: "AI: set up a share target"
summary: 一步步拿到并填入 Gitee / ImgBB / 兰空 / OSS / Joplin / memos 等平台的 token 或密钥，再测活保存
summary.en: Walk through obtaining and storing an access token/key for Gitee, ImgBB, Lsky, OSS, Joplin, memos, then verify it.
placeholder: 说你要配哪个平台，或直接把 token 贴给我（如：配 Gitee 分享 / 这是我的兰空 token xxx）…
placeholder.en: Name the platform you want to configure, or paste the token (e.g. set up Gitee sharing / here is my Lsky token)…
---

# Configure a share target

You are helping the user set up a **aiti-msg-share** target. The user may say
"help me configure Gitee sharing" or paste a token. Follow these steps:

## 1. Identify the provider

Check the target list (the share dialog → "Add more…" → target manager). If no
provider is named, ask which one: Gitee Snippet (text, China), Lsky Pro (images),
Alibaba OSS (any file), ImgBB (images), Joplin (local notes), memos (self-hosted).

## 2. Guide credential creation — exact paths

- **Gitee Snippet**: open https://gitee.com/profile/personal_access_tokens →
  generate a personal access token with the `gists` scope → paste into the
  "token" field. Target config: `access_token`.
- **ImgBB**: open https://api.imgbb.com/ → request a free API key (no card) →
  paste into `key`.
- **Lsky Pro**: log in to your Lsky instance → 个人设置 → 图片 Token → copy the
  Bearer token. Also set your instance endpoint in `RequestURL`.
- **Alibaba OSS**: RAM console → AccessKey management → create an AccessKey pair
  (`accessKeyId`/`accessKeySecret`) → fill `endpoint` (e.g.
  `oss-cn-hangzhou.aliyuncs.com`), `bucket`, and a `publicBaseUrl`.
- **Joplin**: Tools → Options → Web Clipper → enable the clipper service and copy
  the authorization token. API runs at `http://localhost:41184`.
- **memos**: Settings → Access Tokens → create; API at `http://localhost:5230`.
- **Obsidian Local REST**: install the Local REST API plugin → copy its API key;
  API at `http://localhost:27123`.

## 3. Store and verify

Open the target manager, pick the provider, fill the fields, then click
**Save & test**. Confirm the status turns green (✓ Configured) before using it.
Or via API: `POST /api/extensions/aiti-msg-share/targets` then
`POST .../targets/test`.

## Rules

- **Never echo a full token back** into chat, logs, commits or files. Masks like
  `gh3e****d21c` are fine.
- Credentials are stored only in `configDir/targets.json` with mode 0600; uploads
  go through the extension server proxy (browser never sees the token).
- If the test fails, report the HTTP status and reason; do not guess secrets.
- If the service is unreachable from this machine (e.g. `catbox.moe` returns
  "fetch failed"), suggest a China-friendly target (Gitee / Lsky / OSS) or
  `local-link`.
