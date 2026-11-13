# aiti Docker images (base `core` / all-in-one `full`)

> full-image additions over core: funasr default-engine four-model pre-download (2.7GB, pinned via `MODELSCOPE_CACHE`) + Google Chrome installed directly (CDP works after the `--no-first-run --user-data-dir` dual fix) + ttyd pinned to 1.7.7 + locale generation.

## TL;DR

```bash
docker run -p 30142:30142 -v aiti-data:/opt/aiti -v ~/workspace:/workspace aitiai/pi-web:core
# open http://localhost:30142 — the pi-web fork + all extensions + node/git + the justget tool market
# GUI / voice / tunnels → aitiai/pi-web:full
```

The default working directory is `/workspace`; the container runs as the unprivileged user `aiti` (sudo available). Data is kept separate from `~/.pi` (`PI_WEB_EXTENSIONS_DIR` / `PI_WEB_DATA_DIR` / `PI_CODING_AGENT_DIR` all point into `/opt/aiti`).

## Building

```bash
./docker/build.sh --target core --tag aitiai/pi-web:core   # core first; full after core passes smoke
./docker/build.sh --target full --tag aitiai/pi-web:full
```

- The build context is assembled by `build.sh` (staging: pi-web sources + the extension mirror + justget); git metadata and build artifacts stay out.
- Preflight: `ubuntu:26.04` pullability through a registry mirror verified (R1 resolved).
- Known first-run calibration points: the Chromium deb (R4 — Dockerfile.full ① carries an a→b→c fallback chain), funasr streaming model names (TODO in 40-asr-setup.sh), the ngrok/frpc download layer, and the extension deploy allow-list.

## Directory

| File | Role |
|---|---|
| `Dockerfile.core` | base: apt mirrors / Node 22 / core tools / gosu+sudo + the pi-web production build + deployed extensions + the pi engine + justget + aiti-bridge |
| `Dockerfile.full` | core + GUI (Xvfb/openbox/x11vnc/noVNC/dbus/at-spi/xdotool) + Chromium + ASR models + edge-tts + tunnels + ttyd |
| `entrypoint.sh` | root initialization (PUID/PGID overridable + chown) → gosu drop-privileges → phases (`piweb,bridge` / full adds `gui,asr,term`) |
| `start.ps1` | Windows-native launcher (same `AITI_PHASES` semantics; foreground / NSSM service install / -Status) |
| `compose.yaml` | one-command start (volumes/ports/security defaults: GUI/CDP/RDP not exposed) |
| `build.sh` | staging assembly + preflight + docker build |
| `scripts/10-apt-mirror.sh` | deb822 apt sources switched to CN mirrors |
| `scripts/deploy-extensions.sh` | runs each extension's deploy.mjs inside the build container → copies into /opt/aiti/extensions (to be replaced by aiti-ext-install once the S4 npm chain lands) |
| `scripts/30-install-pi.sh` | global pi CLI install + /opt/aiti/agent/settings.json packages |
| `scripts/40-asr-setup.sh` | ASR venv + whisper small + funasr model pre-download (HF mirror) |
| `scripts/50-gui-start.sh` | in-container GUI autostart (no-systemd branch, R2) |
| `scripts/gen-deps.mjs` | S3: scans extension package.json `aiti` metadata blocks → generates the dependency matrix |
| `scripts/smoke.sh` | automated smoke suite (the repeatable form of the test report): 22 checks in one run, exit code = failure count. Usage: `./docker/scripts/smoke.sh core\|full [--keep]` |
| `scripts/e2e-ui.mjs` | UI typing E2E (Playwright Chromium): pick project → new session → type → Enter, the full user journey. Needs host `npm i playwright-core` + `npx playwright install chromium`; run after publishing container port 30142 |

## Standardization notes (S1–S5)

- **S2 path hygiene**: appendix C A1–A12/B1/B2 implemented (env-first; unset behavior unchanged).
- **S3 metadata**: `gen-deps.mjs` is one consumer — extensions that add the `aiti` block get the dependency matrix generated automatically.
- **S4 install chain**: `deploy-extensions.sh` keeps the current deploy channel with the upgrade point annotated.
- **S5 runners**: entrypoint (container) / systemd (bare-metal Linux, via aiti-ui-env) / `start.ps1`+NSSM (Windows) — one `AITI_PHASES` semantics across all three platforms.
