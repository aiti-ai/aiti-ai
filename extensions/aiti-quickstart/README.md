# @aiti-ai/aiti-quickstart

> Blank-state onboarding extension — new-session welcome page widgets (getting-started steps / quick actions / while-it-runs concepts / sample prompts, via the host newSessionWidgets slot, ⚙ customizable) + a left sidebar DockStack fully-collapsed blank guide card (shares the screen with the app center, ✕ dismissible) + a v2 workspace-acquisition Hub (Git clone / upload archive / local directory / create new) + a sidebar "Quick Start" static entry (pinnable as a card in the app center; clicking returns to the quickstart welcome page)

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Sessions & projects · Tags: `quickstart` · `onboarding` · `guide` · `welcome` · `new-session-widgets` · `filler` · `get-started`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-quickstart/` and reload pi-web.

Soft dependencies (degrade gracefully when absent): `session-manager` (renders into the DockStack filler via the `aiti-quickstart.api` service, above the app center), `aiti-event-bus` (clone progress frames), `aiti-model-wizard` (model-setup deep links).

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-quickstart.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-quickstart.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
