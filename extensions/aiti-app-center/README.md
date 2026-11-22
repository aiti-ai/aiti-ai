# @aiti-ai/aiti-app-center

> The app drawer (start menu) shown in the blank state after every left-column dock block is collapsed — a single-row switch between the Apps view (action/panel/manage entry cards, hover quick-pin + info page) and the Toggles view (feature toggles grouped by extension), tag-style categories (8 fixed internal categories with i18n + custom categories + default other), search scoped per view, and edit-mode reorder/hide/restore

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: System & admin · Tags: `app-center` · `launcher` · `start-menu` · `dock` · `spacer` · `category` · `apps`

## Extension authors

- **Commands are entries**: an item registered in the `commands` slot (with `meta.onClick` + `icon`) shows up in the App Center **and** in the composer's command suggestions — e.g. "Select model" / "Compact context" (registered by `aiti-ai-input`) let users finish work without leaving the input box.
- **Keywords are self-declared**: put search vocabulary on the item (`meta.keywords`) or on the extension (`keywords` in `index.ts`, passed through the manifest). The app center only falls back to its legacy override table — new extensions must never be added there. Extension-level keywords apply to every card, so command aliases belong on the item.

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-app-center/` and reload pi-web.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-app-center.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-app-center.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
