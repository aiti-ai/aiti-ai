# @aiti-ai/aiti-draft-keeper

> Draft persistence and crash recovery for the composer — the sole owner of the composer draft state machine (v2 intent contract), shared slots across tabs, 7-day stale pruning.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## What it does

Draft persistence + recovery takeover for the composer. All of pi-web core's draft logic has moved into this extension — core has zero draft-store dependencies and reaches the storage API through the `lib/composer/draft-api.ts` registry; key/value changes broadcast via the composer enhancement contract.

## Architecture (v2: the sole state-machine owner)

- `client/core.mjs` = pure draft state-machine logic (storage/timers/onRestore injected, covered by `core.test.mjs`); `client/aiti-draft-keeper-client.mjs` = thin shell (window/localStorage adapters + hydration gating + DraftApi registration).
- Core's (pi-web's) only write entry is **intents** (`applyDraftIntent`, composer-enhancement-contract v2):
  - `sessionCreated {provisionalKey, sessionId}`: provisional drafts are voided on promote; new input during the promote window (before the key prop switches) is redirected into the sid slot;
  - `rejected {key, text, images}`: a failed send merges back into the draft (written back directly when it's the current box).
- `slotKeyOf` takes the cwd segment after the **last colon** — a draftId may itself contain colons (`initial:<cwd>` form).
- `pruneStale()`: one-time cleanup of slots unwritten for >7 days at startup (including legacy per-tab leftovers and old formats without timestamps).

## Model (shared slots + no-contribution-no-writeback)

- **One shared slot per session** `crashrestore-<key>` (no tabId) — multiple tabs on the same session naturally share one draft; new views use `crashrestore-new:<cwd>`.
- **known** = the value this tab last displayed/wrote.
- **onChange** (only real input writes):
  - `snap === known` → no write (no contribution, no writeback — the core of anti-oscillation);
  - `snap === ""` → clear the slot (with a 300ms confirm delay against stale empty snapshots);
  - otherwise → write the new value (last-write-wins).
- **scan** (read-only, never writes → no oscillation source):
  - empty box + stored draft → silently restore into the box (restore does not clear the stash);
  - non-empty box + stored ⊇ known (another tab extended the draft) → sync into the box;
  - diverged → leave alone (the writer writes its new value).
- **Restore waits for host hydration** (`pi-web:hydrated` signal + stage-replay second line of defense) — otherwise a restore before hydration is wiped by the re-render from server HTML.

## Multi-tab semantics

Shared draft + last-write-wins + passive sync:
- Two tabs typing in the same session → each refreshes/restores independently (shared slots);
- One tab extends the draft → the other passively syncs it into its box;
- Simultaneous typing → last-write-wins (inherent to shared-draft semantics);
- "Current page wins while typing": never popup/restore over a non-empty box.

## Contract dependencies (core side)

- `ctx.registerComposerEnhancement` (value observation / key switch / pre-send hooks)
- `ctx.restoreComposerDraft` / `ctx.writeComposerValue` (controlled writes)
- `ctx.registerDraftApi` (core accesses storage via `getDraftApi()`: applyIntent/getDraft/clearAllDrafts/flushAll are the v2 surface; saveDraft/clearDraft/rekeyDraft/restoreSubmission are deprecated, kept only for older cores)
- `window.__piWebHydrated` + the `pi-web:hydrated` event (hydration signal)

## Known edges

- Turning the keeper off in extman → draft features stop (core has no fallback; the keeper is the sole owner; runtime toggles apply immediately).
- Two tabs typing at the exact same time = last-write-wins (inherent to shared-draft semantics).
- Legacy per-tab slots (`crashrestore-<key>-<tabId>`) migrate automatically to shared slots on first read.

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-draft-keeper/` and reload pi-web.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-draft-keeper.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-draft-keeper.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
