# @aiti-ai/aiti-onlyoffice

> Full-fidelity preview + editing for .docx/.xlsx/.pptx (OnlyOffice DocumentServer Docker backend). AGPL community edition, feature off by default

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Developer tools · Tags: `word` · `excel` · `powerpoint` · `onlyoffice` · `editor` · `docker`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-onlyoffice/` and reload pi-web.

1. Start DocumentServer: `scripts/onlyoffice-up.sh` (Docker, ~2 GB RAM steady-state).
2. Extension manager → aiti-onlyoffice → Features → check **Enable OnlyOffice**, refresh the page.

Requires `aiti-editor` (the multi-editor arbitration host) + Docker.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-onlyoffice.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-onlyoffice.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

AGPL-3.0
