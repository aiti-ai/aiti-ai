---
name: import-sxcu
title: AI 帮我导入 ShareX .sxcu 配置
title.en: "AI: import a ShareX .sxcu config"
summary: 校验 .sxcu 配置的兼容性并注册为新的分享目标（ShareX 官方仓 148 份配置可直接用）
summary.en: Validate a .sxcu config's compatibility and register it as a new share target.
placeholder: 粘贴 .sxcu JSON，或给出配置来源（如 ShareX CustomUploaders 里的某个服务名）…
placeholder.en: Paste the .sxcu JSON, or name the service from the ShareX CustomUploaders catalog.
description: Import a ShareX .sxcu custom-uploader config as a new aiti-msg-share target, with compatibility report.
---

# Import a ShareX .sxcu config

The user provides a `.sxcu` JSON config (file, pasted JSON, or a URL from the
[ShareX CustomUploaders catalog](https://github.com/ShareX/CustomUploaders)).

1. Parse and validate: required `RequestURL`; check `Body` is one of
   `MultipartFormData` / `JSON` / `FormURLEncoded` / `Binary` / `XML`;
   `DestinationType` maps to text/image/file kinds.
2. Report compatibility before import:
   - Full support: `$json:path$`, `$regex:N$`, `$base64:`, `$header:`,
     `{{content}}/{{title}}/{{tags}}` variables.
   - Partial: other ShareX functions degrade to empty strings; note them.
   - Placeholders like `<API KEY HERE>` become required fields in the target form.
3. Import via `POST /api/extensions/aiti-msg-share/import-sxcu` with the config.
4. Tell the user to open the target manager, fill any required credential
   fields, and click **Test connection**.

Never invent credentials. If the config contains a hard-coded token, warn the
user to remove it before saving (configs are stored in plain text).
