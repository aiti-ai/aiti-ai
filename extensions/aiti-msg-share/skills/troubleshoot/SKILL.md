---
name: troubleshoot
title: AI 帮我排查分享失败
title.en: "AI: troubleshoot a failed share"
summary: 读分享历史定位失败原因（网络不可达 / token 失效 / 内容超限 / 服务已关停），给出换目标或修配置的建议
summary.en: Read share history, classify the failure (network / token / size / dead service) and recommend a fix.
placeholder: 描述现象或直接说“分享失败了”（我会读最近历史诊断）…
placeholder.en: Describe the symptom, or just say "the share failed" and I will read the latest history.
description: Diagnose aiti-msg-share failures — read recent share history, classify the error (network/auth/size/dead service), and recommend a fix or alternative target.
---

# Troubleshoot a failed share

1. Read recent history via `GET /api/extensions/aiti-msg-share/history` (or the
   share dialog → history). Look at the newest failing record: targetId, kind,
   bytes, hits.
2. Classify the failure:
   - **401/403 / "invalid token"** → target credential expired; re-run
     `configure-target` for that provider.
   - **413 / "Content too large"** → use the compact export (folded tool output)
     or switch to OSS/Gofile (larger `maxBytes`).
   - **timeout / fetch failed** → network reachability. For a local service
     (Joplin :41184 / Obsidian :27123 / memos :5230), confirm the app is running
     and its API is enabled. For overseas hosts, suggest a China-friendly target
     (Gitee, Lsky, OSS).
   - **HTTP 5xx from provider** → service-side outage; `metadata.json` marks
     known dead/legacy services (`anonfiles`, `transfer.sh`, `0x0.st`, `uguu`).
     Recommend another target via "Add more…".
   - **"no URL in response"** → provider changed its response shape; an `.sxcu`
     config update via the remote overlay or a manual URL-extraction fix is needed.
3. If the error is redaction-related, check the preview banner: the
   `[REDACTED:*]` placeholders are intentional — disable "Share redaction" only
   after the user explicitly accepts the risk.

Report the diagnosis in plain language with one concrete next action.
