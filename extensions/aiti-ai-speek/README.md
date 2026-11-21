# @aiti-ai/aiti-ai-speek

> Voice reading of AI output — switchable voice/pause/skip/stop; browser Web Speech by default, plus optional edge-tts and a **local TTS engine** (Hojo-TTS-Light 40M/80M, ONNX CPU, OpenAI-compatible service with voice cloning)

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Chat enhancements · Tags: `tts` · `speech` · `audio`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-ai-speek/` and reload pi-web.

## Engines

| Engine | Requirement | Notes |
|---|---|---|
| Browser Web Speech | none | default fallback, zero backend |
| edge-tts | `pip install edge-tts` | server-side quality tier |
| Local (Hojo-TTS-Light) | Python 3.10-3.12 (`uv` recommended) | 100% local, CPU-friendly; selecting it bootstraps venv + deps + model (~240MB) automatically, no manual download. 40M = 17 built-in voices; 80M = voice cloning from 3-30s reference audio. Idle-exits after 30 min. |

The local service listens on `127.0.0.1:8768` (auto 8769-8778 when busy) and speaks the OpenAI
`/v1/audio/speech` subset, so any OpenAI-compatible client can reuse it. Status/start/stop/
progress/log/voice management live in the extension settings panel; `skills/tts-local-install`
documents the one-command workflow (`bash server/tts-service/start-tts.sh start`).

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-ai-speek.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-ai-speek.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
