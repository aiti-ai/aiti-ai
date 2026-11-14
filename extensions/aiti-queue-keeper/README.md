# @aiti-ai/aiti-queue-keeper

> Full queue panel for the composer (queuePanel-slot takeover): banners, row operations (move / drag / steer-send / to-followUp / recall / delete) and a recycle bin — fully client-side.

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## What it does

Renders the full queue panel through the `queuePanel` slot (**while taken over**, core hides its fallback banner):

- Queue banner (collapse/expand, counts, recall-all)
- Row operations (↑↓ move, drag sort, steer-send, convert to followUp, recall, delete)
- Recycle bin (restore / restore-all / purge / purge-all)
- Undo bar (8s window after delete)
- Import/export (pending-recovery dialog parsing + JSON download)
- Notice bar (import/delete/recycle-bin feedback)

## Architecture (zero data migration)

- **Core keeps the mechanisms**: rpc-manager queue mirror / sidecar persistence / 12 RPCs / trash all stay in core; ChatInput keeps only the single-slot hookup + fallback banner.
- **The extension keeps the strategy**: all UI state (collapse/notice/recycle bin/undo/drag) lives in `client/src/QueuePanel.tsx`; every operation goes through the **actions primitives** (`QueuePanelProps.actions`) calling core RPCs — the extension has zero storage of its own. Disabling the extension simply falls back to the core banner; no state data is ever lost.
- **Contract**: `lib/composer/queue-api.ts` (core-side types + controller bus) + `/client/src/types.ts` (extension-side structural mirror); export download / import parsing pass through core pure functions via `actions.downloadExport/parseImport` (single implementation).

## Control flow

- **core → ext**: ChatInput assembles `QueuePanelProps` (live projection + trash + actions) passed through the slot.
- **ext → core**: `ctx.registerQueuePanelController({expand, notice})` — core recovery flows call `getQueuePanelController()?.expand()` to force-expand the panel; without a takeover the core fallback banner is a no-op.
- **Takeover detection**: ChatInput `useExtSlotItems("queuePanel").length > 0` (feature off / uninstalled / still loading → falls back to the core banner).

## Feature

- `queuePanel.enabled` (per-item toggle in extman): off → the slot item is not registered → falls back to the core banner.

## i18n

35 `chat.queue*` keys in three languages (zh-CN/en/zh-TW) declared in the extension's `ui.i18n` (read via `ctx.t()`).

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-queue-keeper/` and reload pi-web.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-queue-keeper.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-queue-keeper.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
