# pi-models-combo

A small [pi package](https://pi.dev/packages) that keeps your model list tidy
and rotates API keys to prevent 429 rate limits.

> 🇨🇳 中文版：[README.zh-CN.md](https://github.com/aiti-ai/pi-models-combo/blob/main/README.zh-CN.md)

## About aiti

This package comes from [aiti](https://aiti.pw/) (GitHub org [aiti-ai](https://github.com/aiti-ai)) —
a personal AI development workbench ecosystem powered by pi.

**Works standalone**: any pi (coding agent) user can `pi install npm:@aiti-ai/pi-models-combo`
to get every capability on its own — model filtering, sticky multi-key rotation,
multi-provider aggregation (combo models), quality monitoring, and 429 management —
with no dependency on any other aiti component.

**Also works with aiti-agent** (self-hosted web workbench, browser-first): the 🧙 model wizard
recognizes the multi-key pools and combo models declared by this package for visual editing
(the "Model aggregation" tab, sticky multi-key rotation config), and 📡 model check shows
combo member composition and rate-limit status — multi-key / multi-provider aggregation
orchestration without hand-writing `models.json`.

### 1. Model filtering

For providers where you explicitly configure a `models` list in `models.json`,
only the models you configured stay visible — the hundreds of built-in catalog
models (e.g. openrouter's full catalog) quietly step aside.

### 2. Token rotation (proxy)

When a provider has multiple `apiKeys` in `models.json`, a local proxy server
is started on a **random port** and registered into the session via
`pi.registerProvider()` (extension-level overrides win over `models.json`, so
routing always goes through the proxy). The proxy:

- Injects the rotating key using the right scheme per API type:
  `Authorization: Bearer` (openai-completions / openai-responses),
  `x-api-key` (+ `anthropic-version`) for anthropic-messages,
  `x-goog-api-key` for google-generative-ai
- Rewrites `role: "developer"` → `"system"` on openai-completions bodies
  (GLM-style relays reject the OpenAI-style developer role with
  `[1214] Incorrect role information`; opt out with `PMC_NO_ROLE_REWRITE=1`)
- Injects `x-opencode-session` header for OpenCode Go (Console Go,
  `opencode.ai/zen/go`) upstreams — required by Console Go for prompt-cache
  routing. The value is a stable per-session hash (`runClient` = the truncated
  per-session dummy token), so it's cache-friendly within a session and isolated
  across sessions. Auto-detected by upstream host; override per provider with
  `compat.xOpenCodeSession` (`true` force-inject / `false` disable).
- Retries automatically on 429 (up to 5 attempts, exponential backoff + jitter)
- Puts rate-limited keys on cooldown (`Retry-After` or default 30s)
- Per-key `rpm` + even-spacing throttle (default: spacing auto-derives
  60000/rpm; `minIntervalMs: 0` opts out to burst-then-quiet sliding window)
- Enforces an upstream timeout (default 120s → responds 504)
- Upstream rate-limit errors can be very long (day-scale `retry-after`) and
  would stall multi-key rotation — returns a smaller rate-limit timeout
  (default ≤60s) and strips the rest of the rate-limit headers

pi only sees a normal URL (`http://127.0.0.1:{random_port}/`) and a random
dummy token. It never touches the real keys and never sees raw rate-limit headers.

Proxy state lives on a `globalThis` singleton, so repeated extension loads
(CLI invocations, every aiti-ai session) reuse the same running proxies instead
of leaking one port per session; `stopAllRespect()` plus process exit hooks
keep long-running hosts clean. Because `settings.json` is shared between CLI
and aiti-ai sessions, both channels load this same engine and coexist
idempotently.

Nothing is deleted: provider definitions, model definitions, and credentials
are all preserved. This only affects which models are *shown* and how API keys
are routed.

## Why

pi's `models.json` is additive: built-in providers keep their full catalog and
your explicit `models` entries are merged on top. For providers such as
openrouter, that means 300+ built-in models show up even though you only
configured a handful. There is no built-in way to shrink that list from
`models.json` alone. And when you hit 429 rate limits, pi has no way to
retry with a different key.

This package fills both gaps without changing how pi resolves providers.

### 3. Model aggregation (combo models)

Compose multiple real models into **one virtual model**: create a custom-named
provider in `models.json` with `"combo": true` and a `combo.members` list per
virtual model (optional `weight`, default 10). The local proxy routes requests
with **sticky sessions** (same member within an idle TTL — maximizes upstream
prompt cache hits), 429-cooldown failover, vision-aware routing, and
weight-based member selection. See the [Chinese README](https://github.com/aiti-ai/pi-models-combo/blob/main/README.zh-CN.md)
section 3 for the full config format and rationale.

**Content-class routing (`types`, v0.4.4)** — a member can declare which request
classes it serves via an optional `types` allowlist (`text` / `vision` / `other`
for audio/video/PDF, multi-selectable); **unset or empty = serves everything**
(previous behavior). `["vision"]` makes a **vision-dedicated** member: image
requests are routed to it while plain-text requests never hit it (requires the
model to declare `image` input). `["text"]` keeps it text-only. Request-class
sniffing covers openai (`image_url` / `input_audio`), anthropic (`image` /
`document`) and google (`inline_data` / `file_data` mime prefixes) payloads;
mixed image+media requests are served only by untyped (catch-all) members.
Typical setup: a text model plus a `["vision"]` image model — image and
text requests each get their dedicated model.

### 4. Quality monitoring & timeouts

Three-stage timeouts replace the old single 120s cap: TTFB 90s (rotate to next
key/member on timeout), stream-idle 45s (kills stalled SSE streams — the root
cause of sessions hanging for tens of minutes), total 15min, plus a **pool
deadline** (300s default): the total wall-clock budget for one client request
across ALL retries/member switches — free pools where every member TTFB-times
out serially used to burn 6×90s≈11.5min client-side; now the chain is cut with
a structured 504. Any timeout (TTFB/idle/total) also **halves that member's
weight** (frozen via the usual error cooldown) until its next real success.
Persistently slow slots (median TTFB of last 8 requests > 30s) are skipped
immediately even while their sticky TTL is still valid. Any >=400 response
expires the sticky pointer. See the [Chinese README](https://github.com/aiti-ai/pi-models-combo/blob/main/README.zh-CN.md) section 4 for details.

### 4.1 i18n (v0.4.3)

All proxy logs, client-visible structured errors, `/combo` command output and
startup/refresh messages are localized. Language detection priority:
**`PMC_LANG` (explicit override) > `PMC_LOCALE` > `LC_ALL` > `LC_MESSAGES` > `LANG`**
(POSIX chain): `zh*` → zh-CN, `en*` → en, other real languages → en fallback,
`C`/`POSIX`/empty skip to next. If the whole chain is undeclared, falls back to
the ICU default locale — **native Windows sets none of the LANG/LC_* vars, so
this layer is what detects the OS regional language** (Chinese Windows → zh-CN,
English → en); no Intl → zh-CN.
Protocol anchors stay untranslated by design: the `error.type` field,
the terminal-400 `[quota exceeded: …]` marker (pi-ai NON_RETRYABLE matching
relies on it) and the `upstream timeout` / `upstream error` log anchors.

## Install

```sh
pi install npm:@aiti-ai/pi-models-combo
```

Or point pi at this repository directly:

```sh
pi install git:github.com/aiti-ai/pi-models-combo
```

## How it works

The extension wraps the model query entry points on `ModelRuntime` and
`ModelRegistry` (`getModels`, `getAvailable`, `getAvailableSnapshot`, `getAll`,
`find`). For every provider that has an explicit `models` list in
`~/.pi/agent/models.json`, only those explicitly configured model ids remain
visible. Providers without an explicit `models` list are left completely
untouched.

The allowlist is generated 100% from `models.json` (re-read automatically by
file mtime). Add or remove models via your model wizard and the next query
reflects the change — no extension edits, no restarts.

## Example

With this in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "apiKeys": [
        { "name": "key-1", "key": "sk-xxx1" },
        { "name": "key-2", "key": "sk-xxx2" }
      ],
      "models": [
        { "id": "z-ai/glm-5.2:free" },
        { "id": "openai/gpt-oss-20b:free" }
      ]
    }
  }
}
```

Only `z-ai/glm-5.2:free` and `openai/gpt-oss-20b:free` remain visible for
openrouter — the rest of the built-in catalog is hidden from model selection,
`modelRegistry.getAll()`, `modelRegistry.getAvailable()`, and
`modelRegistry.find()`.

All API calls go through a local proxy that rotates between `key-1` and
`key-2`. If one key hits 429, the proxy retries with the other.

### Rate limits, cooldowns & the saturation gate

Free-tier upstreams sometimes answer 429 with a day-level `retry-after` (we've seen
1,600,000 s ≈ 18.5 days). Honoring it verbatim shelves a slot for days; forwarding it to
the client trips pi's 60 s retry-delay cap (`Server requested … retry delay (max: 60s)`,
no retry at all). Therefore the proxy:

- caps upstream `retry-after` to `PMC_RETRY_AFTER_CAP` seconds (default 60) for internal
  cooldowns **and** for the 429 header returned to the client, then re-probes after expiry;
- runs a **saturation gate**: when every slot of a pool stays rate-limited continuously
  beyond `PMC_SATURATION_TERMINAL_MS` (default 180 000 ms), it replies with a terminal
  400 carrying a `quota exceeded` anchor so clients stop retrying cleanly. Only a real
  upstream success (<400) resets the timer — merely picking an unfrozen slot does not,
  so even slow-rhythm clients (pi retries every ~60 s) reach the terminal state;
- treats all-slots-down-because-of-errors (401/402/403/5xx/timeouts) as 502 api_error,
  outside the gate (network trouble ≠ quota exhaustion).

## Configuration

There is no separate config file. Everything is in `models.json`:

| Field | Type | Description |
|---|---|---|
| `apiKey` | `string` | Single key (original behavior, no rotation) |
| `apiKeys` | `Array<{name, key, rpm?, minIntervalMs?, enabled?}>` | Named key pool (enables rotation); per-key rpm cap; `minIntervalMs`: unset = auto (60000/rpm even spacing), `0` = burst sliding window only, number = fixed gap in ms; `enabled: false` = temporarily disable that key (skipped from rotation, config kept, one-click re-enable) |
| `models` | `Array<{id, enabled?}>` | Allowlist of visible models; `enabled: false` on a model entry = temporarily disable that model (hidden from lists, skipped as combo member, config kept) |
| `enabled` | `boolean` (provider-level) | Temporarily disable the whole provider (no proxy, all models hidden, skipped as combo member source, config kept; `false` = disabled) |

- When `apiKeys` has **2+ entries**, token rotation is active.
- Each key needs a unique `name` (shown in model wizard / model check).
- `apiKey` (single) still works when `apiKeys` is absent.
- **Temporary disable without delete**: all three levels support `enabled: false` — provider (no proxy / models hidden), key (out of rotation), model (hidden / skipped as combo member). Config stays intact; the model wizard toggles them back on with one click. Combo members: `combo.members[i].enabled: false` skips that member; virtual model: `models[i].enabled: false` stops that whole model.

## Requirements

- pi (the coding agent) — this package is a pi extension
- `~/.pi/agent/models.json` with explicit `models` lists on the providers you
  want to narrow

## License

MIT
