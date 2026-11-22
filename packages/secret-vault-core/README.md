# @aiti-ai/secret-vault-core

> Local encrypted secret vault engine for AI agents — host-agnostic, zero third-party dependencies.

Adds **persistence** on top of `@aiti-ai/secret-mask-core`:

- values at rest are AES-256-GCM ciphertext, one IV per entry; metadata (alias, description, tags, version, timestamps) stays plaintext so lists/diffs are cheap
- master key = 32-byte keyfile (`0600`, `master.key`); unlock is fail-closed (wrong key never decrypts)
- two scope buckets: `global.json` + `vault.<cwdHash8>.json` (project entries shadow global aliases)
- rotation keeps `createdAt`, increments `version`, and records `lastUsedAt` / `lastUsedSession` for attribution
- atomic writes (temp + rename), `0600` where the platform supports it

## What's inside

| module | exports | role |
|---|---|---|
| `crypto` | `encryptValue`, `decryptValue`, `generateKey`, `readKeyFile`/`createKeyFile`, `writeFileAtomic` | AES-256-GCM envelopes + safe file handling |
| `store` | `VaultStore`, `VaultError`, `ALIAS_RE`, `CHECK_PLAINTEXT` | add/rotate/get/list/remove, scopes, unlock/lock, status |
| `entries` | `captureStdout`, `captureIntoVault`, `parseEnvFile`, `importEnvFile`, `importProcessEnv`, `findAliasForValue`, `suggestAutoAlias` | command-stdout capture (bounded, tree-kill), `.env`/env import, value→alias lookup |
| `tools` | `vaultList`, `vaultGet`, `mountAlias`, `VAULT_GET_NOTE` | read-only AI surface: list aliases, mount one as a stable `rsec_<hash8>` token |
| `landing` | `landValueInVault` | G1 `vault` landing: prompt values → library → stable token (reuses aliases) |
| `commands` | `handleVaultCommand` | `/vault add/set/capture/import/import-env/list/get/reveal/remove/forget/scope/mode/lock/unlock/status` |
| `session-state` | `readSessionState`, `writeSessionRecord` | zero-value session records for management UIs (alias names only) |

## Usage

```ts
import { VaultStore, vaultGet, vaultList, handleVaultCommand } from "@aiti-ai/secret-vault-core";
import { Registry } from "@aiti-ai/secret-mask-core";

const store = new VaultStore({ cwd: process.cwd() }); // ~/.pi/agent/secret-vault
const registry = new Registry();
const sessionId = "…";

// human write path (masked input wiring is the host's job)
await handleVaultCommand({ store, registry, sessionId, cwd: process.cwd() }, "add openai-key OpenAI", {
  input: async () => await maskedInput(),
});

// AI read path
const list = vaultList({ store, registry, sessionId });        // metadata only
const got = vaultGet({ store, registry, sessionId }, { alias: "openai-key" }); // token + contract
```

## Threat model

Encryption protects the case "the vault file leaves this machine" (backups, sync, accidental commit, theft). It does **not** protect against a same-uid malicious process (it can read the keyfile) or against prompt injection using a restored value in an outbound command. Fail-closed on key mismatch; no backdoor.

See the pi integration package `@aiti-ai/pi-secret-vault` for the full hook wiring, `/vault` UI surface, and coexistence handshake with `@aiti-ai/pi-secret-mask`.

## Testing

```bash
npm test       # node --test — crypto/store/commands/tools/landing
npm run build  # esbuild → dist/index.js
```

License: MIT.
