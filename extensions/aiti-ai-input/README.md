# @aiti-ai/aiti-ai-input

> Input enhancement for the AI chat composer: two-tier autocomplete (instant local → AI fallback), speech-input detection with spelling repair, streaming ASR with 2-pass refinement, switchable recognition engines (self-hosted / xfyun / Baidu / SiliconFlow / any OpenAI-compatible endpoint), hotwords, and usage reports.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## Features

### Autocomplete (L0 local, instant → L1 AI)

Typing pause of 700ms with the caret at the end → grey ghost text for the next sentence (Tab/→ accept, Esc/keep typing cancel). Two tiers:

- **L0 local tier (zero-model, instant)**: after the pause, local sources are checked first — favorite prompts + session input history, prefix-matched server-side (`POST /complete`, `mode=local`). Hits show immediately with a ↦favorite/↦history badge, **no AI request**.
- **L1 AI tier**: only when L0 misses, a small request to the session's model produces the ghost text.
- Governance via ExtMan feature toggles: `autocomplete.enabled`, `autocomplete.localOnly` (L0 only, zero egress), `autocomplete.minChars`, context budget.

### Voice input (dictation detection + spelling repair + L2 ASR)

1. **Detects speech-input / fast bulk input** (system IME dictation, rapid paste-like sentence entry) from pure browser event signatures (`beforeinput` inputType + `getTargetRanges` + rhythm) — zero server dependency.
2. When detected → a marker bar above the input ("🎤 fast bulk input detected · checking transcription errors"), dismissable.
3. On send, applies **spelling repair** for speech/fast-input artifacts (AI-repaired; replacement suggestions only when ambiguous).
4. **L2 ASR fallback**: browser recording (webm/opus, ≤60s) → `/voice/transcribe` → server transcription → text inserted.
5. **Real-time streaming + candidate words + 2-pass refinement (🎤 main path)**: hold 🎤 and speak → PCM streams over WebSocket to the self-hosted streaming server (paraformer-zh-streaming, ~600ms latency). Real-time partial text is off by default (streaming model quality); when recording stops, an offline 2-pass model (Qwen3-ASR-0.6B / Fun-ASR-Nano / seaco, switchable in the panel) refines the text and inserts it immediately.
   - Insert format: sentence-ending punctuation auto-appended (per UI language), inserted at the caret (replacing selection), caret lands after the new text.
   - Master switches: `voice.enabled` (🎤 button, off by default) · `toolbar.enabled` (toolbar 🎙️ management dialog entry, off by default).

### Switchable ASR engines

| Engine id | Notes | Latency (4s zh, measured) |
|---|---|---|
| `builtin` | self-hosted (FunASR/Qwen3/GLM): true streaming + model-level hotwords + 2-pass | seconds on local GPU — best with local compute |
| `xfyun` | iFlytek iat — true streaming (client WS → local bridge → iFlytek WSS; one-shot submit fallback) | 0.3–2.6s |
| `baidu` | Baidu short-speech REST (30-day token cache) | 0.3–0.7s |
| `siliconflow` | SiliconFlow SenseVoiceSmall | 27–82s (queued, fallback only) |
| `openai` | any OpenAI-compatible endpoint (`baseUrl` + `model`, auto-appends `/audio/transcriptions`) — e.g. Groq `whisper-large-v3-turbo` | depends on endpoint |

Groq: create an API key at console.groq.com, use the `openai` engine with `https://api.groq.com/openai/v1` + model `whisper-large-v3-turbo` (free tier, no code changes). Azure: create a Speech resource (Free F0), use key + region with the `azure` engine.

Engine-specific capabilities (WS / hotwords / start-stop) gate automatically; the client pipeline is unchanged (local VAD splitting → per-sentence quick recognition → final refinement).

### Hotwords (v0.4.2+)

- **Automatic hotwords** extracted by session-manager from the All Sessions index (watched paths + global terms, four tiers × `asr.hotwords.count` each, user words first), time-weighted with caching.
- **Workspace granularity**: the ASR server stores hotwords per workspace hash — parallel workspaces never collide; model-level hotwords (`context=` for Qwen3, `hotword=` for Fun-ASR-Nano/seaco).
- **User hotwords**: `GET/PUT /api/extensions/aiti-ai-input/asr/user-hotwords` (up to 500, merged with automatic words at top priority).

### Management dialog & usage reports

Toolbar 🎙️ opens "ASR engine management" (three sections): engine switching cards, engine configuration (fields driven by backend metadata, secrets masked; 🩺 test connection runs 1s of silence through the engine), and per-day usage stats (requests / audio minutes / errors / estimated cost). A detailed SVG report (`📊 详细报表`) shows KPI cards, 30-day stacked bars by engine, per-engine and per-pipeline breakdowns (data retained 90 days).

## Self-hosted streaming server

```bash
cd server
bash start-stream.sh              # start (idempotent) · status / stop / restart
powershell -File start-stream.ps1 # Windows equivalent
```

- Env: `ASR_STREAM_PORT` (8767) · `ASR_MAX_SECONDS` (60). Models are configured in `~/.pi/web/data/aiti-ai-input/asr-config.json` (`stream_model`, `offline_model`, ...), not on the command line.
- 2-pass offline models: `Qwen/Qwen3-ASR-0.6B` (default, 52 languages + 22 zh dialects, punctuation + term casing, `context=` hotwords), `FunAudioLLM/Fun-ASR-Nano-2512` (faster, `hotword=`), seaco paraformer (legacy).
- **Self-healing**: each 🎤 press probes the server via `/asr/ensure` and auto-starts it when down (via the aiti-cmd PTY); no systemd required. Management endpoint: `POST /asr/control {action: start|stop|restart}`.

Configuration via API (effective immediately, no restart):

```bash
# read (keys masked: configured + last 4 chars)
curl -s http://127.0.0.1:3001/api/extensions/aiti-ai-input/asr/config
# write: set key and switch engine (empty string = delete)
curl -s -X POST http://127.0.0.1:3001/api/extensions/aiti-ai-input/asr/config \
  -H 'content-type: application/json' \
  -d '{"provider":"siliconflow","providers":{"siliconflow":{"apiKey":"sk-...","model":"FunAudioLLM/SenseVoiceSmall"}}}'
```

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-ai-input/` and reload pi-web. The streaming ASR server (optional, for the `builtin` engine) lives in this package's `server/` directory.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-ai-input.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-ai-input.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
