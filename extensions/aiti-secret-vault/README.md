# aiti-secret-vault (pi-web extension)

Web management surface for the encrypted vault owned by the pi package
`@aiti-ai/pi-secret-vault`.

- Toolbar key icon → dialog with two tabs:
  - **Vault**: entries (alias / scope / description / tags / version / last use), add or rotate
    (value field is write-only), reveal (display + copy), delete (two-step), lock/unlock,
    unlock-mode switch (keyfile ↔ OS keychain, re-encrypts with a fresh key).
  - **Sessions**: zero-value records written by the pi extension (session id, cwd, landing mode,
    mounted alias names). Useful to see which session currently holds a mounted alias.
- The extension talks to the same files as the pi extension:
  `~/.pi/agent/secret-vault/{global.json, vault.<cwdHash8>.json, config.json, master.key?}`.
- Values never go to the AI/model: browser → local pi-web server → encrypted vault. The API is
  same-origin behind pi-web's authentication; responses are `cache-control: no-store` and values
  are never logged.

Server dependency: `@aiti-ai/secret-vault-core` (AES-256-GCM store, keyfile/keychain backends).
Shared-root `node_modules` is reconciled by aiti-extman from the extension's `dependencies`.

Deploy: `node tools/deploy.mjs` (or `node scripts/deploy-all.mjs --only aiti-secret-vault`).
