# @aiti-ai/ext-shared

> Server-side shared layer for aiti-agent extensions: agent-spawn-env (spawn env governance / resolveCliLaunch), seed-tool (history-replay seeds), cursor-cli-store (Cursor CLI session reader), exec-async, git-ops-client and more. Declared in each extension's package.json and installed into the shared node_modules root by extman reconcile (resolved via jiti walk-up).

## Origin

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/aiti-ai)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench / ecosystem repo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## Positioning

Server-side shared layer for aiti-agent extensions: agent-spawn-env (spawn env governance / resolveCliLaunch), seed-tool (history-replay seeds), cursor-cli-store (Cursor CLI session reader), exec-async, git-ops-client and more. Declared in each extension's package.json and installed into the shared node_modules root by extman reconcile (resolved via jiti walk-up).

## Install / Deploy

Deployed as part of the aiti-agent extension system (extman install / deploy scripts copy it to `~/.pi/web/extensions/`); usually not installed standalone — when referenced as a dependency it is installed into the shared node_modules automatically by extman reconcile.

## Documentation

- Full docs, Chinese (aiti-docs): <https://aiti.pw/guide/ext-services.html>
- English docs: <https://aiti.pw/en/guide/ext-services.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
