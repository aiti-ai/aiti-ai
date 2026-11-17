# @aiti-ai/aiti-msg-share

> Share sessions, single messages, selections, files and images through pluggable targets — Gitee / image hosts / object storage / note archives — with secret redaction before upload and a QR code for the resulting URL

English · [简体中文](./docs/README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Content & sharing · Tags: `share` · `session` · `message` · `qrcode` · `redaction` · `sxcu` · `gitee` · `oss` · `joplin`

## What it does

The workbench runs on your own machine, so a session URL is not reachable from outside. This extension uploads the content you pick through a **configurable share target** and gives you back a public URL — plus a QR code, clipboard copy and (where supported) the OS share sheet.

Sharing happens only when you say so, and the preview is always editable first.

## Where you can share from

| Entry | What gets shared |
| --- | --- |
| Message hover actions | That single message |
| `msg-smart` selection popover (copy/quote/new-session row) | The selected text |
| `msg-smart` file card | The referenced file |
| Session row → `⋯` more menu | The whole session (markdown export) |
| File editor toolbar | The open file, or the current selection |
| Image preview window | The image |
| Command palette | Share center |

Every entry is a **host slot or extension topic** — this extension registers providers, other extensions render them. No hard-coded buttons.

## Targets

161 built-in targets come from [`@aiti-ai/content-share`](https://www.npmjs.com/package/@aiti-ai/content-share):

- **Publish** (public URL): Gitee Snippet, Lsky Pro, SM.MS, Pastebin, Rentry, paste.rs, Alibaba Cloud OSS, plus the full ShareX `.sxcu` catalog (catbox, imgbb, gofile, 0x0.st, …)
- **Archive** (deep link into your own notes): Joplin, Obsidian Local REST, memos, SiYuan, Flomo
- **Local** (no upload): a link to the session on your own workbench
- **Custom**: any HTTP endpoint via a `.sxcu` config or the template provider

The share dialog shows a **recommended set** by default; "Add more…" opens the full catalog with search, config-state badges (🟢 anonymous / 🟠 needs setup / ✓ configured / 💀 dead) and a one-click **Use** action.

## Redaction

Before uploading, the text passes through [`@aiti-ai/secret-mask-core`](https://www.npmjs.com/package/@aiti-ai/secret-mask-core) — the same deterministic credential-detection engine that powers `pi-secret-mask`. Hits become `[REDACTED:RULE#hash]` placeholders, shown in the preview; the toggle re-renders the textarea immediately and restores the original when unchecked.

Binary content (images/files) is not scanned — the UI says so.

## Page info stamp

A multi-select in the preview header prepends optional context to the shared text: **OS**, **browser**, **URL**, **session id**, **session name**. Handy when sharing a screenshot-free snippet with someone who needs to know which machine/browser/session it came from.

## AI skills

Declared through `aiti-helper`'s standard `skills/` mechanism:

- `configure-target` — walk through obtaining and storing a token/key for a provider, then verify it
- `troubleshoot` — read share history, classify the failure, recommend a fix or another target
- `import-sxcu` — validate a ShareX config and register it as a target

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Standalone use requires the pi-web host; this package is not a general-purpose library (see [`@aiti-ai/content-share`](https://www.npmjs.com/package/@aiti-ai/content-share) for that).

## Data & privacy

- Target credentials live in `<configDir>/targets.json` with mode `0600`; API responses are masked.
- Uploads go through the extension's own server route — the browser never holds a token and there are no CORS workarounds.
- Share history is stored in `<stateDir>/shares.json` (last 200 entries).
- File shares respect the host's allowed-roots policy (`ctx.core.fileAccess`).

## License

MIT

[简体中文](./docs/README.zh-CN.md)
