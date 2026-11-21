# aiti-secret-vault (pi-web extension)

Web management surface for the encrypted vault owned by the pi package
`@aiti-ai/pi-secret-vault`.

- Toolbar key icon → dialog with two tabs:
  - **Vault**: weak-password warning on add/rotate (dictionary/short/low-entropy), weak-entry count and per-row `⚠` badge; entries (alias / scope / description / tags / version / last use), add or rotate
    (value field is write-only), reveal (display + copy), delete (two-step), lock/unlock,
    unlock-mode switch (keyfile ↔ OS keychain, re-encrypts with a fresh key).
  - **Sessions**: zero-value records written by the pi extension (session id, cwd, landing mode,
    mounted alias names). Useful to see which session currently holds a mounted alias.
- The extension talks to the same files as the pi extension:
  `~/.pi/agent/secret-vault/{global.json, vault.<cwdHash8>.json, config.json, master.key?}`.
- Values never go to the AI/model: browser → local pi-web server → encrypted vault. The API is
  same-origin behind pi-web's authentication; responses are `cache-control: no-store` and values
  are never logged.

## Pre-send check (composer gate)

Before a message leaves the composer the extension scans it with a **stricter** rule set than
auto-masking (relaxed keyword-bound values plus standalone machine-shaped tokens) and asks:

- **Mask and send** — the value is encrypted into the vault first, the message text becomes the
  stable vault placeholder (`rsec_<hash8>`); the model never sees the plaintext.
- **Send as-is** / **Cancel** (cancel keeps the composer untouched).

Details:

- `ui.clientImmediately: true` on purpose: the gate is registered by the client bundle, so a lazy
  client would only materialize when the dialog is opened and the gate would silently not exist.
- "Do not ask again this session" remembers the answer in `sessionStorage`; the dialog header has a
  persistent on/off toggle (`localStorage`).
- Wired into every send path: Enter, steer/follow-up while streaming, new-session fork, side chat.
  Cancelling never clears typed text, and text typed while the dialog is open is preserved.
- A locked vault or a failed write cancels the send — a mask that did not happen never sends
  plaintext. Messages over 20 KB skip the gate (auto-masking still applies agent-side).
- API: `POST /preflight/scan` returns masked previews only, `POST /preflight/mask` takes candidate
  indices from a deterministic re-scan. Values never travel back to the browser.

The agent side (`@aiti-ai/pi-secret-vault`) resolves those placeholders against the vault on
`input`/`context`, so tool arguments still get the real value and the unresolved-token guard
stays intact.

Server dependency: `@aiti-ai/secret-vault-core` (AES-256-GCM store, keyfile/keychain backends).
Shared-root `node_modules` is reconciled by aiti-extman from the extension's `dependencies`.

Deploy: `node tools/deploy.mjs` (or `node scripts/deploy-all.mjs --only aiti-secret-vault`).
