# AITI Web — official Docker images (core / full)

[中文文档](https://github.com/aiti-ai/aiti-ai/blob/main/docs/README.zh-CN.md) | [日本語](https://github.com/aiti-ai/aiti-ai/blob/main/docs/README.ja.md) | [Русский](https://github.com/aiti-ai/aiti-ai/blob/main/docs/README.ru.md)

**AITI Web** (`@aiti-ai/pi-web`) is a browser workbench for the [pi coding agent](https://github.com/earendil-works/pi) — and the base of the [aiti](https://aiti.pw/) tooling ecosystem: page-injected debugging tools, an MCP bridge for AI agents, and a growing library of bundled extensions. This image ships the whole workbench in one container: pi-web with all bundled extensions, the pi engine, Node/git tooling, and the aiti-bridge — and in `full`, a web desktop with Chrome/CDP, voice and tunnels on top.

## Why this fork?

Upstream [pi-web](https://github.com/agegr/pi-web) is an excellent local UI for pi — but a full AI development workbench needs more than a UI: an extension runtime, session tooling around git and queues, service tunnels for sharing local ports, page-level debugging injection, and deep AI ↔ page ↔ IDE collaboration. Upstream's architecture didn't leave room for those layers, so this fork ships them as **bundled extensions that come with the package** — nothing to install per-extension, and the Docker images are the fastest way to run all of it. The engine stays pi (shared JSONL sessions, same local configuration), so everything upstream documents still applies.

## Where it comes from

Two 15-year-old projects — [TestAgent](https://aiti.pw/extensions/aiti-testagent.html), a Java runtime debugger, and [JustDB](https://justdb.ai), a database IDE — met the AI era. Daily development moved onto pi-web, feature by feature it drifted from upstream, and **aiti** began as its own distribution, built for real daily use first: commute-time coding, spare-device development, making every spare token count. The full story lives at [aiti.pw/guide/origin.html](https://aiti.pw/guide/origin.html).

## Documentation & links

| | |
|---|---|
| Docs home (EN / 中文 / 日本語 / Русский) | **[aiti.pw](https://aiti.pw/)** |
| Source code | [github.com/aiti-ai/aiti-ai](https://github.com/aiti-ai/aiti-ai) |
| 中文文档 | [README.zh-CN.md](https://github.com/aiti-ai/aiti-ai/blob/main/docs/README.zh-CN.md) |
| 日本語ドキュメント | [README.ja.md](https://github.com/aiti-ai/aiti-ai/blob/main/docs/README.ja.md) |
| Русская документация | [README.ru.md](https://github.com/aiti-ai/aiti-ai/blob/main/docs/README.ru.md) |
| Origin story | [aiti.pw/guide/origin.html](https://aiti.pw/guide/origin.html) |
| Prefer npm? | `npm i -g @aiti-ai/pi-web` · [package page](https://www.npmjs.com/package/@aiti-ai/pi-web) |
| License | [MIT](https://github.com/aiti-ai/aiti-ai/blob/main/LICENSE) |

## What's bundled (highlights)

The upstream UI remains; everything below ships as bundled extensions, pre-deployed inside the image.

- **Sessions & queues** — cross-project session manager (kanban, tags, archives, full-text search, forking), queue editing, restart-recovery wizard
- **Git toolchain** — commit graph with AI-grouped commit plans and rollback, Monaco diff review workspace, AI change-tracking timeline
- **Page-injected debugging (aiti-devtools)** — AI debugging inside any local web app: HUD/Inspector, a CDP-like command set, and the MCP bridge that lets AI agents talk to the page
- **Multi-agent backends** — Claude Code, Codex, Cursor, Qoder, ZCode, OpenCode, Kimi, Gemini, iFlow and more (CLI + ACP drivers), with unified login management
- **Models & usage** — model wizard (catalog search, multi-key rotation, aggregation), availability probing with 429 detection, provider balance/usage reports
- **Ops infrastructure** — service tunnels with auth, extension manager with online registry, config versioning + crash self-check, backups, event bus, VNC UI environments, docs center
- **Reading & interaction** — speech in/out, floating dialogs, prompt library, plan-first workflow, document viewers (docx/xlsx/pdf/pptx), and ~40 more

Prefer npm over Docker? `npm i -g @aiti-ai/pi-web` — see the [GitHub README](https://github.com/aiti-ai/aiti-ai#readme).

---

# Usage manual

> Images: `aitiai/pi-web:core` (base, 2.13GB) / `aitiai/pi-web:full` (all-in-one, 7.76GB).

## 1. Quick start

```bash
# Base image: open http://localhost:30144 for the full workbench
docker run -d --name aiti --init \
  -p 30144:30142 \
  -v aiti_data:/opt/aiti/data \
  -v aiti_agent:/opt/aiti/agent \
  -v ~/my-project:/workspace \
  aitiai/pi-web:core
```

- First launch: sidebar "Select project → Use default directory" (= /workspace) → "New session" → "Settings" at the bottom to configure a model key → chat.
- Data lives in two volumes: `aiti_data` (extension runtime data) and `aiti_agent` (pi sessions / model config) — **upgrading the image keeps your data**.
- ⚠ Mount only sub-paths of `/opt/aiti`, **never the whole `/opt/aiti`**: a named volume is populated once, so mounting the root would make image upgrades ineffective forever (see test report O22).

## 2. Choosing an image

| | core | full |
|---|---|---|
| Size | 2.13GB | 7.76GB |
| pi-web + bundled extensions + pi engine + justget + bridge | ✅ | ✅ |
| GUI (Xvfb/VNC/noVNC/Chrome+CDP) | — | ✅ |
| ASR speech recognition (funasr, four models, :8767) | — | ✅ |
| TTS edge-tts / web terminal ttyd (:7681) | — | ✅ |
| Tunnels cloudflared/ngrok/frpc | — | ✅ |
| Memory floor | 1GB | **8GB** (full + voice; 2–6GB OOMs) |

full's extra phases are controlled with `AITI_PHASES` (see §4).

## 3. Ports

| Port | Service | Default |
|---|---|---|
| 30142 | pi-web main UI | must map |
| 8777 | aiti-bridge (page injection / MCP / agent REST) | map when using external agents / injection |
| 8767 | ASR WS/HTTP (full) | on by default in full; map as needed |
| 6080 | noVNC web desktop (full) | loopback, map as needed |
| 5900 | VNC (full) | loopback |
| 9222 | Chrome CDP (full) | loopback |
| 7681 | ttyd web terminal (full) | loopback |

`AITI_PIWEB_PORT` / `AITI_BRIDGE_PORT` change the container-side ports (rarely needed).

## 4. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AITI_PHASES` | `piweb,bridge` | Comma-separated: `piweb,bridge,gui,asr,term`. gui/asr/term are implemented in full only (core logs and skips them) |
| `PUID`/`PGID` | 1000 | Runtime uid/gid (align with the host user so mounted directories just work). ⚠ Do not use `UID` (read-only bash builtin) |
| `TZ` | UTC | e.g. `Asia/Shanghai` |
| `AITI_PIWEB_PORT` / `AITI_BRIDGE_PORT` | 30142 / 8777 | Container-side ports; HEALTHCHECK follows automatically |
| `AITI_MODE` | auto | `core`/`full`/`auto` (per image-layer marker); setting core on a full image downgrades to the base phases |
| `AITI_DEV` | 0 | `1` = mount sources and run `next dev` with hot reload (development mode) |
| `AITI_SKIP_CHOWN` | 0 | `1` = skip root initialization when starting directly with `--user` |
| `AITI_GUI_NOFILE` | 65536 | GUI session fd limit (do not raise — a large NOFILE deadlocks x11vnc, test report O20) |
| `AITI_GUI_SIZE` | 1920x1080x24 | Virtual display resolution |

### Domain / reverse-proxy (same semantics as pi-web)

| Variable | Meaning |
|---|---|
| `PI_WEB_ALLOWED_HOSTS` | Trusted hostnames (comma-separated) — reverse-proxy domains **must** be listed or requests 403. Unlisted hosts stay rejected (the Host gate remains) |
| `PI_WEB_BASE_DOMAIN` | Domain used to build service-tunnels expose URLs (`host:port`) |
| `AITI_BASE_URL` | Public base URL for aiti-devtools injection pages / MCP (set to your proxy URL) |
| `API_ALLOW_ORIGINS` | Bridge CORS (`*` or explicit origins; needed when the proxy domain differs from the served origin) |
| `PI_WEB_EXTRA_EXTENSIONS_DIRS` | Extra extension directories (container paths, comma-separated; pair with `-v` mounts for user extensions) |

Reverse-proxy example (domain → `127.0.0.1:30144`, bridge → `18777`):

```bash
docker run -d --name aiti --init \
  -p 127.0.0.1:30144:30142 -p 127.0.0.1:18777:8777 \
  -e PI_WEB_ALLOWED_HOSTS="pi.example.com,aiti.pi.example.com" \
  -e PI_WEB_BASE_DOMAIN="pi.example.com:8443" \
  -e AITI_BASE_URL="https://aiti.pi.example.com:8443" \
  -e API_ALLOW_ORIGINS="*" \
  -v aiti_data:/opt/aiti/data -v aiti_agent:/opt/aiti/agent \
  aitiai/pi-web:core
```

Measured behavior (test reports T-E/T-H): listed Hosts answer 200, unlisted 403; adding subdomains under a `*.pi.example.com` wildcard + wildcard certificate needs no extra work.

## 5. Volumes & persistence

| Mount | Contents | Recommendation |
|---|---|---|
| `/opt/aiti/data` | Extension runtime data (config store / indexes / caches) | Named volume |
| `/opt/aiti/agent` | pi session JSONL / models.json / mcp-cache | Named volume (**the moat — always persist**) |
| `/workspace` | Workspace (default cwd at startup; pi sessions group by project) | Bind-mount a host project directory |
| `/home/aiti/.pi` | **Optional**: inherit host pi config | Adopts auth.json/models.json on first run; settings.json is jq-merged with the built-in defaults (user keys win, packages union) |
| `/opt/aiti/extensions` | Extension code | **Do not mount** — owned by the image layer; upgrading refreshes it |

## 6. full-image features at a glance

| Feature | Entry point |
|---|---|
| Web desktop | noVNC `:6080/vnc.html` (RFB via websockify→x11vnc→Xvfb :99) |
| CDP debugging | Chrome `:9222` (headful, `--user-data-dir=/opt/aiti/data/chrome-profile`) |
| Voice input | ASR `ws://<host>:8767/ws/stream` (realtime) / `/voice/quick` (quick) / `/voice/transcribe` (refined) / `/ws/vad` (segmentation) — the aiti-ai-input extension wires up automatically via `AITI_ASR_STREAM_BASE` |
| Voice readout | edge-tts installed; enable the `tts.edge` feature in the aiti-ai-speak extension |
| Web terminal | ttyd `:7681` |
| Tunnels | `cloudflared` / `ngrok` / `frpc` usable inside the container (ngrok needs your own authtoken) |
| Download tool | `justget <url> -o <file> -m <mirror-url>` multi-source racing |

## 7. Operations

```bash
docker logs -f aiti                 # logs (extension readiness / bridge / banner all here)
docker exec -it aiti bash           # into the container (user aiti, passwordless sudo)
docker stats aiti                   # resources
docker inspect aiti --format '{{.State.Health.Status}}'   # healthy = OK
docker stop aiti && docker rm aiti  # stop & remove (volumes kept)
docker volume rm aiti_data aiti_agent   # remove the data too (careful)
```

- **Graceful stop**: `docker stop` exits within ~1s (signals are forwarded to each service by the entrypoint).
- **Upgrading**: `docker pull` the new image, then remove and recreate the container (same-name volumes carry the data); extensions refresh with the image.
- **Rebuild + smoke**: `./docker/scripts/rebuild-and-smoke.sh core full` (CI-ready; exit code = number of failures).

## 8. Building & publishing (maintainers)

```bash
# Non-CN network / GitHub CI: official mirrors directly
./docker/build.sh --target core --tag aitiai/pi-web:core
./docker/build.sh --target full --tag aitiai/pi-web:full     # requires core first

# CN local builds: --cn injects mirrors (apt=tuna / npm=npmmirror / hf=hf-mirror / pypi=tuna)
./docker/build.sh --target core --tag aitiai/pi-web:core --cn
# Equivalent env: AITI_CN=1 (pre-set in the systemd unit template)

./docker/scripts/smoke.sh full [--keep]                  # 22-check smoke suite (exit = failure count)
node docker/scripts/e2e-ui.mjs                           # UI journey E2E (needs playwright-core + chromium)
node docker/scripts/gen-deps.mjs                         # S3 dependency matrix (reads extension `aiti` metadata blocks)
```

> `--cn` only affects public-source mirrors; **the `@aiti-ai/*` private registry is a separate temporary channel**: `--private-registry <private-registry-url>`
> (or env `AITI_PRIVATE_REGISTRY`) — for local testing only. Once `@aiti-ai/*` is on public npm, omit it and the official registry is used.
> Same at runtime: `docker run -e AITI_NPM_REGISTRY=<private-registry-url>` lets pi pull private packages on first boot (written into the in-container `~/.npmrc`).
> Known limitations (see the test report's remaining-issues section): arm64 has no official Chrome (CDP missing; all other download layers ready); ngrok/frpc downloads occasionally need retries (the build carries a gh-mirror racing fallback); UI E2E depends on host chromium.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Container restart-looping | `docker logs` for the first error; usually port conflicts / volume permissions (align PUID) |
| Reverse proxy 403 | Domain not in `PI_WEB_ALLOWED_HOSTS` |
| `/api/models` 403 | Normal — it only allows existing session cwds; the health check uses `/api/home` |
| x11vnc connects but no picture / very slow | NOFILE deadlock (O20) — confirm `AITI_GUI_NOFILE` was not raised and use the image's own 50-gui-start |
| CDP 9222 unreachable | Confirm `--user-data-dir` is among the flags (Chrome 136+ ignores CDP on the default profile) + first-run EULA skipped |
| ASR first response slow | Models load lazily (full pre-downloaded 2.7GB, zero re-download; switching models downloads incrementally) |
| OOM | full + voice needs ≥8GB memory (2–6GB OOMs in practice, test report T-H5) |
