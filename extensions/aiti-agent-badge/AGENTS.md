# aiti-agent-badge (deployed direct-edit guide)

## Layout

- `index.ts` — manifest (feature + i18n). Loaded by the host from this directory.
- `client/src/*` — client source (JSX + TS).
- `dist/aiti-agent-badge.mjs` — built bundle; never edit by hand.
- `tools/build-client.mjs` / `tools/deploy.mjs` — build and deploy.

## Small edit loop (copy/style/logic)

1. Edit `client/src/*`.
2. `node tools/build-client.mjs`.
3. `curl -X POST http://127.0.0.1:30142/dev/api/extensions/reload` (dev; prod 20341).
4. Refresh the page and open the badge.

## Back to the source repo

- Source: `extensions/aiti-agent-badge/` in the aiti-ai repo.
- Deploy: `node tools/deploy.mjs` or `node scripts/deploy-all.mjs --only aiti-agent-badge`.

## Red lines

- No polling: refresh comes from the `aiti-event-bus` `running` topic or the manual refresh button.
- Do not edit `dist/` or the deployed flat manifest by hand.
- The host API (`/api/sessions/[id]/hosting`) owns hosting inspection/switching; this extension only renders and calls it.
