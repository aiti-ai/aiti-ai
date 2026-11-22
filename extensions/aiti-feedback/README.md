# aiti-feedback

Report an issue / send feedback from the pi-web UI: compose a sanitized report
in a dialog, preview the final markdown, then open a **prefilled GitHub issue** —
you log into GitHub yourself and just hit Submit. Zero tokens, zero server.

## Privacy model

- The dialog preview IS the final content (best-effort redaction applied:
  internal domains/IPs/repo names/paths and common token shapes → placeholders).
- Environment info (UA/platform/language/page path, query stripped) is opt-in.
- Session content is never auto-read; there is an opt-in paste box.
- The full text always lands in your clipboard as a fallback when GitHub
  truncates the prefilled body.

Plan: internal `aiti-feedback-plan.md` (workspace-tools docs).
