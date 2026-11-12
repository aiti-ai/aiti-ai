#!/usr/bin/env bash
# entrypoint.sh — unified aiti container entrypoint (aiti-docker-image-plan §3.3)
# Root startup does initialization (user rebuild / chown / dirs) → gosu drops to `aiti` for the main services.
# The phases semantics are shared with Windows start.ps1 / Linux systemd (design §9.3 S5 acceptance):
#   piweb | bridge | gui | asr | term — AITI_PHASES comma-separated, default piweb,bridge
# No polling, no sleep-wait loops: processes start in the background + wait; signals forwarded via trap (docker --init as backstop).

set -e

# ⚠ $UID/$GID cannot be used — read-only bash builtins (always 0 under root), env cannot override them.
# Use the linuxserver.io PUID/PGID convention (mirrored in compose/README), default 1000.
UID_HOST="${PUID:-1000}"
GID_HOST="${PGID:-1000}"
AITI_HOME="/home/aiti"

# ── 0. identity & directories ──────────────────────────────────────────────────────────────
# Root start (default path): rebuild the user to match PUID/PGID + chown mutable dirs + gosu drop.
# --user direct start (design §2.1.4 simplified path, docker run --user 1000:1000): non-root has no
# setuid power, gosu would blow up (smoke-verified "failed switching to 'aiti'") — skip all root
# initialization; as_aiti degrades to direct execution.
if [ "$(id -u)" = "0" ]; then
  # When UID/GID align with the host (linuxserver.io PUID/PGID mode), rebuild the same-named user
  if [ "$(id -u aiti 2>/dev/null)" != "$UID_HOST" ] || [ "$(id -g aiti 2>/dev/null)" != "$GID_HOST" ]; then
    userdel -r aiti 2>/dev/null || true
    groupadd -g "$GID_HOST" aiti 2>/dev/null || { groupmod -o -g "$GID_HOST" aiti 2>/dev/null || true; }
    useradd -m -u "$UID_HOST" -g "$GID_HOST" -s /bin/bash aiti
    echo "aiti ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/aiti
    chmod 0440 /etc/sudoers.d/aiti
  fi
  mkdir -p /workspace /opt/aiti/data /opt/aiti/agent
  # AITI_SKIP_CHOWN=1: the user starts directly with a fixed uid via docker --user (design §2.1.4 simplified path)
  if [ "${AITI_SKIP_CHOWN:-0}" != "1" ]; then
    # chown only the mutable dirs (data/agent/workspace) — app/extensions are already owned by aiti
    # in the image layer (first-run finding: a full chown -R over hundreds of thousands of files blocks startup for minutes)
    chown -R aiti:aiti /opt/aiti/data /opt/aiti/agent /workspace 2>/dev/null || true
  fi
  as_aiti() { gosu aiti "$@"; }
else
  echo "[entrypoint] non-root start (--user $(id -u):$(id -g)) — skipping root init and gosu"
  mkdir -p /workspace /opt/aiti/data /opt/aiti/agent 2>/dev/null || true
  as_aiti() { "$@"; }
fi
# ── 0.5 pi config (default settings generation + optional host ~/.pi inheritance, design §2.1.3) ──────────
# settings.json is no longer pre-written at image build time (30-install-pi.sh only installs the CLI) — the first
# startup generates the defaults here (the six packages). If the user mounted ~/.pi (compose option):
#   auth.json / models.json  adopted only when missing (seed semantics; runtime files never overwritten)
#   settings.json            target absent → adopt wholesale; present → jq merge (user keys win + packages union)
AGENT_DIR=/opt/aiti/agent
mkdir -p "$AGENT_DIR" 2>/dev/null || true
if [ ! -f "$AGENT_DIR/settings.json" ] && [ -f "$AITI_HOME/.pi/agent/settings.json" ]; then
  cp "$AITI_HOME/.pi/agent/settings.json" "$AGENT_DIR/settings.json"
  echo "[entrypoint] config inheritance: settings.json ← host ~/.pi/agent"
elif [ -f "$AITI_HOME/.pi/agent/settings.json" ] && command -v jq >/dev/null; then
  T=$(mktemp)
  # jq object merge: right side wins — $u = the host user file → user keys win; packages take the union.
  # ⚠ `. as [$t,$u]` must bind first — after the pipe `.` is already the merged object, and `.[0]` would raise Cannot index object with number
  if jq -s '. as [$t, $u] | ($t * $u) | .packages = ((($t.packages // []) + ($u.packages // [])) | unique)' \
      "$AGENT_DIR/settings.json" "$AITI_HOME/.pi/agent/settings.json" > "$T" 2>/dev/null; then
    mv "$T" "$AGENT_DIR/settings.json"
    echo "[entrypoint] config inheritance: settings.json merged with host config (user keys win + packages union)"
  else
    rm -f "$T"
  fi
elif [ ! -f "$AGENT_DIR/settings.json" ]; then
  cat > "$AGENT_DIR/settings.json" <<'EOF'
{
  "packages": [
    "npm:pi-mcp-adapter",
    "npm:@aiti-ai/pi-subagents",
    "npm:@aiti-ai/pi-models-combo",
    "/opt/aiti/pi-plugins/pi-git-trace",
    "npm:pi-opencode-free",
    "npm:pi-freeflow"
  ]
}
EOF
  echo "[entrypoint] settings.json defaults generated (six packages)"
fi
for f in auth.json models.json; do
  if [ -f "$AITI_HOME/.pi/agent/$f" ] && [ ! -f "$AGENT_DIR/$f" ]; then
    cp "$AITI_HOME/.pi/agent/$f" "$AGENT_DIR/$f"
    echo "[entrypoint] config inheritance: $f ← host ~/.pi/agent"
  fi
done
if [ "$(id -u)" = "0" ]; then
  chown aiti:aiti "$AGENT_DIR/settings.json" "$AGENT_DIR/auth.json" "$AGENT_DIR/models.json" 2>/dev/null || true
fi
# AITI_NPM_REGISTRY (optional, temporary): private-package channel for testing — when pi first pulls the
# @aiti-ai/* packages from settings.json, they resolve via the aiti user's npm and ~/.npmrc gets a scope
# pointing at the private registry; omit the env at release time = public npm.
if [ -n "${AITI_NPM_REGISTRY:-}" ]; then
  printf '@aiti-ai:registry=%s\n' "$AITI_NPM_REGISTRY" > "$AITI_HOME/.npmrc"
  echo "[entrypoint] private-registry test mode: @aiti-ai/* ← ${AITI_NPM_REGISTRY} (~/.npmrc)"
fi
cd /workspace

# Mode probe: full when the full layer-marker file exists (explicit AITI_MODE wins)
MODE="${AITI_MODE:-auto}"
if [ "$MODE" = "auto" ]; then
  [ -f /opt/aiti/.aiti-full ] && MODE=full || MODE=core
fi

PHASES="${AITI_PHASES:-piweb,bridge}"
want() { case ",$PHASES," in *",$1,"*) return 0;; *) return 1;; esac; }

# as_aiti was defined above per root/non-root (gosu drop / direct execution)

# ── phase: bridge (aiti-bridge 8777, design §3.3 core branch 1) ───────────────────
start_bridge() {
  as_aiti env AITI_BRIDGE_DATA_DIR="${AITI_BRIDGE_DATA_DIR:-/opt/aiti/data/aiti-bridge}" \
    node /opt/aiti/bridge/bin/aiti-bridge.mjs --host 0.0.0.0 --port "${AITI_BRIDGE_PORT:-8777}" &
  CHILD_PIDS+=("$!")
  echo "[entrypoint] bridge :${AITI_BRIDGE_PORT:-8777}"
}

# ── phase: piweb (standalone server.js first; AITI_DEV=1 mounts sources and runs next dev, R8) ────
start_piweb() {
  if [ "${AITI_DEV:-0}" = "1" ]; then
    as_aiti bash -lc "cd /opt/aiti/app && npx next dev -H 0.0.0.0 -p ${AITI_PIWEB_PORT:-30142}" &
    CHILD_PIDS+=("$!")
    echo "[entrypoint] piweb :${AITI_PIWEB_PORT:-30142} dev=${AITI_DEV:-0}"
  elif [ -f /opt/aiti/app/.next/standalone/server.js ]; then
    # standalone: self-contained minimal dependency tree; PORT/HOSTNAME read by server.js itself
    as_aiti env PORT="${AITI_PIWEB_PORT:-30142}" HOSTNAME=0.0.0.0 \
      node /opt/aiti/app/.next/standalone/server.js &
    CHILD_PIDS+=("$!")
    echo "[entrypoint] piweb :${AITI_PIWEB_PORT:-30142} standalone"
  else
    as_aiti bash -lc "cd /opt/aiti/app && npx next start -H 0.0.0.0 -p ${AITI_PIWEB_PORT:-30142}" &
    CHILD_PIDS+=("$!")
    echo "[entrypoint] piweb :${AITI_PIWEB_PORT:-30142}"
  fi
}

# ── full additions (trimmed by AITI_PHASES; GUI/CDP/VNC ports loopback by default, external access via tunnels + TOTP, R5) ──
start_gui() {
  [ "$MODE" = "full" ] || { echo "[entrypoint] gui: not a full image, skipping"; return 0; }
  as_aiti /usr/local/bin/aiti-gui-start &
  CHILD_PIDS+=("$!")
  echo "[entrypoint] gui (xvfb+openbox+x11vnc+noVNC+cdp)"
}

start_asr() {
  # aiti-ai-input single ASR service (streaming + offline in one, default 8767); venv = uv-managed CPython 3.12
  [ "$MODE" = "full" ] || return 0
  as_aiti env ASR_STREAM_PORT=8767 /opt/aiti-asr/.venv/bin/python /opt/aiti-asr/app/voice-asr-stream.py &
  CHILD_PIDS+=("$!")
  echo "[entrypoint] asr :8767"
}

start_term() {
  [ "$MODE" = "full" ] || return 0
  as_aiti ttyd --port 7681 --writable bash &
  CHILD_PIDS+=("$!")
  echo "[entrypoint] ttyd :7681"
}

# ── start + signal forwarding ────────────────────────────────────────────────────────────
# The trap kills the recorded child pids directly: under docker --init (tini as PID1) the entrypoint is not a
# process-group leader, so `kill -- -$$` has no valid group (first version verifiably never received TERM) —
# forwarding per pid is the only reliable way.
CHILD_PIDS=()
want bridge && start_bridge
want piweb  && start_piweb
want gui    && start_gui
want asr    && start_asr
want term   && start_term

on_term() {
  kill -TERM ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"} 2>/dev/null || true
}
trap on_term TERM INT
wait
