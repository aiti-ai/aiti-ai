# @aiti-ai/aiti-codehub

> Research collaboration hub for pi-web — one meta-model for work items and code
> across **Yunxiao**, **GitHub**, **Gitee** and **GitLab** (PAT + OAuth), with agent tools
> and a "Get a workspace" clone source.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/aiti-ai)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench & monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: R&D collaboration · Tags: `codehub` · `workitem` · `yunxiao` · `github` · `gitee` · `gitlab` · `multi-account` · `agent`

## Install

Experimental extension — currently distributed as source, not yet bundled with a release or published to npm.

Manual install: place this package at `~/.pi/web/extensions/aiti-codehub/`, run `node tools/build-client.mjs`, and reload pi-web.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-codehub.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-codehub.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## What it does

- **Work items surface** — Yunxiao projects/work items (search, filters, detail, comments,
  custom fields); GitHub/Gitee/GitLab issues (repo-scoped, list/detail/comments). The
  work-items window opens as a **floating dialog by default**; it can be docked to the
  right/left panel from the float header.
- **Rich descriptions** — RICHTEXT (sanitized HTML) and Markdown bodies are rendered with
  formatting; images and attachments inside Yunxiao work items are proxied through the
  extension (the PAT never reaches the browser).
- **Repositories surface** — namespaces/groups → repositories → branches, favorites,
  clone URLs, and merge-request creation (Yunxiao).
- **Two independent surfaces** — each docks in the right panel by default and can be
  floated or moved to the left sidebar; "Recent" belongs to the work-items surface and
  "Settings" is shared.
- **Multiple accounts** — a platform can hold several accounts (personal + work + bot).
  The default account keeps the platform id (`github`), extra ones are `github~work`;
  each has an editable alias and its own credentials, favorites, recents and cache.
- **Agent tools** — `aiti_codehub_*` lets the AI query work items, read repos/branches,
  create a branch from a template, and (opt-in) create merge requests.
- **Workspace integration** — clones run through the `aiti-quickstart` clone engine and
  appear as a "代码托管" source tab in the *Get a workspace* dialog.

## Providers

| Provider | Auth | Work items | Code | Merge request |
|---|---|---|---|---|
| Yunxiao | PAT + OAuth (DCR + PKCE, zero setup) | projects/work items | groups/repos/branches | create |
| GitHub | PAT + device code (shared OAuth App) + local `gh` CLI | issues | org/repos/branches | read-only |
| Gitee | PAT only (this round) | issues | org/repos/branches | read-only |
| GitLab | PAT + device code (shared non-confidential app, 17.1+) | issues | groups/repos/branches | read-only |

## Multiple accounts

- Settings → left tree: `+` adds an account per platform, the row's gear renames it,
  `×` deletes it (credentials, cache, favorites, recents and pending logins go with it).
- Pickers group accounts by platform (`云效 / 个人云效 / 公司云效`) and stay flat when a
  platform has a single account.
- Account ids are stable — `<platform>` for the default account, `<platform>~<slug>` for
  the rest; only the alias is user-editable. "Set as default" picks the account a
  surface opens with first.
- Agent tools accept an instance id (`github~work`) or `provider` + `account`
  (alias/slug). Templates gain `{account}`; `{provider}` stays the platform label.

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-codehub/`, run `node tools/build-client.mjs`, and reload pi-web.

## Setup

Open the CodeHub settings (toolbar icon → gear, or the extension manager) and pick a
provider tab. PATs are stored server-side in `config/providers/<id>.json` (mode 0600) and
are never echoed by the API.

- **Yunxiao OAuth** needs no app registration: metadata discovery, Dynamic Client
  Registration and PKCE. The callback is a virtual landing page served by the extension
  middleware (not `/api`); it defaults to `http://127.0.0.1:30141` and can be changed in
  settings (`oauthCallbackBase`, e.g. `http://127.0.0.1:30142/dev` for a dev instance).
- **GitHub / GitLab** use the device-code flow with a single shared public app: enter the
  app's Client ID in settings, then log in by entering the displayed code. No secret, no
  callback.
- **Gitee** uses a PAT this round; no OAuth app.
- Self-hosted: GitLab `baseUrl` and GitHub Enterprise `baseUrl` are supported.

## Usage

- Toolbar icon → work-items floating dialog (dockable); right-panel tab "代码库" (and "工作项" once docked).
- Work item detail: copy / write commit box / create branch / send to current session /
  send to a new session / open in browser.
- Repositories: search, favorite, copy clone URL, clone (opens the clone dialog),
  create merge request (Yunxiao).
- "Get a workspace" → "代码托管" tab → provider → repo → branch → destination → clone.

## Agent tools

`aiti_codehub_providers`, `aiti_codehub_workitems`, `aiti_codehub_workitem`,
`aiti_codehub_repos`, `aiti_codehub_branches`, `aiti_codehub_branch_create`,
`aiti_codehub_mr_create`. Write tools are off by default (`tool.*` features) and require
`confirm: true`.

Skills: `codehub-workitems`, `codehub-code`, `codehub-setup`.

## Development

```bash
npm run build:client   # vite → dist/aiti-codehub-client.mjs
npm test               # node --test tests/*.test.mjs
node tools/deploy.mjs  # dev deploy + reload
```

Server code is plain TypeScript loaded by the host (no build step); the client is a
single ESM bundle with React aliased to the host shim.

## Security

- Tokens/secrets: server-only, file mode 0600, redacted from every API response and log.
- OAuth: one-shot `state` (10 min TTL) + PKCE; the landing page is a non-API middleware
  route and exchanges the code via a same-origin POST. Device-code polling is the single
  protocol-mandated exception (stops on success/cancel/expiry).
- Outbound hosts are allow-listed per provider; clone URLs come from the provider API only.
- Each account has its own `providers/<instance>.json` (0600); the config API never
  returns tokens. Rich text is sanitized with DOMPurify; provider data never reaches `innerHTML` unsanitized. Authenticated Yunxiao files go through a server-side proxy (only work-item file endpoints on allow-listed hosts).

## License

MIT
