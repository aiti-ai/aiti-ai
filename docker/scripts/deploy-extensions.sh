#!/usr/bin/env bash
# deploy-extensions.sh — batch-deploy pi-web extension artifacts inside the build container (aiti-docker-image-plan §3.2 ⑤)
# Usage: bash deploy-extensions.sh <target dir, e.g. /opt/aiti/extensions>
# Mechanism: runs each extension's tools/deploy.mjs (HOME redirected to a temp dir); after deployment copies
#       from HOME/.pi/web/extensions to the target. deploy commit / reload POST may fail inside the build container (deploy.mjs tolerates that).
# S4 upgrade path: replace this whole section with aiti-ext-install once the npm publish chain lands.
set -euo pipefail
DEST="${1:?usage: deploy-extensions.sh <dest-dir>}"
# staging root (contains pi-web-ext/): inside the container this script is flattened to /opt/aiti/src/ — locate by walking up
find_root() {
  local d="$PWD"
  while [ "$d" != "/" ]; do
    if [ -d "$d/pi-web-ext" ]; then echo "$d"; return; fi
    d="$(dirname "$d")"
  done
  echo "[]" >&2; exit 1
}
SRC_ROOT="$(find_root)"
EXT_SRC="$SRC_ROOT/pi-web-ext"
cd "$EXT_SRC"
# Build scripts like cpu-meter/devtools locate esbuild by walking up the Node resolution chain (host = repo-root node_modules).
# The staging root has no package.json — add one with a local install for resolution
if [ ! -d "$SRC_ROOT/node_modules" ]; then
  (cd "$SRC_ROOT" && npm install esbuild --no-audit --no-fund --loglevel=error) >"/tmp/deps-root-esbuild.log" 2>&1 \
    || echo "[deploy-ext] WARN root esbuild install failed (log /tmp/deps-root-esbuild.log)"
fi
BUILD_HOME=/tmp/deploy-home
mkdir -p "$BUILD_HOME" "$DEST"
# After the HOME redirect npm cannot read the build-time global ~/.npmrc (registry/@scope config lost → private packages 404,
# e.g. service-tunnels' runtime self-referencing deps) — write an equivalent .npmrc from the current npm config
{
  echo "registry=$(npm config get registry)"
  _scope=$(npm config get @aiti-ai:registry 2>/dev/null || true)
  [ -n "$_scope" ] && [ "$_scope" != "null" ] && [ "$_scope" != "undefined" ] && echo "@aiti-ai:registry=$_scope"
  echo "legacy-peer-deps=true"
} > "$BUILD_HOME/.npmrc"

# Allow-list exclusions (design §8.1): dev samples / isolation-only / infrastructure stay out of the production image
EXCLUDE="^(_shared|shared|templates|ai-configs|sm-demo-source|demo|demo-lazy|aiti-crash-fatal)$"

for d in */; do
  ext="${d%/}"
  if [[ "$ext" =~ $EXCLUDE ]]; then echo "[deploy-ext] skip $ext (excluded)"; continue; fi
  if [ ! -f "$EXT_SRC/$ext/tools/deploy.mjs" ]; then echo "[deploy-ext] skip $ext (no deploy.mjs)"; continue; fi
  # vite-style extensions have no node_modules in staging (gitignored) — install on demand inside the container (one-time; cached afterwards)
  if [ -f "$EXT_SRC/$ext/package.json" ] && [ ! -d "$EXT_SRC/$ext/node_modules" ]; then
    echo "[deploy-ext] installing deps for $ext ..."
    # ci first: when the lock's resolved points at a private package (e.g. service-tunnels → the private registry URL) fetch the
    # locked URL directly so the default registry does not re-resolve and drop it; fall back to install when there is no lock or it drifted
    (cd "$EXT_SRC/$ext" && (npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error)) >"/tmp/deps-$ext.log" 2>&1 \
      || echo "[deploy-ext] WARN $ext deps install failed (deploy continues; log /tmp/deps-$ext.log)"
  fi
  echo "[deploy-ext] deploying $ext ..."
  if ! HOME="$BUILD_HOME" node "$EXT_SRC/$ext/tools/deploy.mjs" >/tmp/deploy-$ext.log 2>&1; then
    echo "[deploy-ext] WARN $ext deploy failed (continuing; last 8 log lines below)"
    tail -8 "/tmp/deploy-$ext.log" || true
  fi
done

# Copy out the deployment artifacts (deploy.mjs writes to $HOME/.pi/web/extensions/<id> by default)
if [ -d "$BUILD_HOME/.pi/web/extensions" ]; then
  cp -a "$BUILD_HOME/.pi/web/extensions/." "$DEST/"
  echo "[deploy-ext] deployed -> $DEST ($(ls "$DEST" | wc -l) extensions)"
  # aiti-editor Monaco gate: syncMonaco copies from the dev-installed monaco-editor — a
  # silently failed deps install would ship an editor that 404s on loader.js
  if [ -f "$DEST/aiti-editor/index.ts" ] && [ ! -f "$DEST/aiti-editor/monaco/vs/loader.js" ]; then
    echo "[deploy-ext] ERROR: aiti-editor deployed without monaco/vs assets (editor would 404 on loader.js)"; exit 1
  fi
  rm -rf "$BUILD_HOME" /root/.npm
else
  echo "[deploy-ext] ERROR: deployment artifacts not found at $BUILD_HOME/.pi/web/extensions"; exit 1
fi

# ── webRoot-level runtime dependency reconcile (the build-time equivalent of the host extman reconcile) ──────────
# The deployed copies carry no extension node_modules; extension runtime deps (@aiti-ai/ext-shared / command-exists /
# shell-quote / node-pty …) install into <webRoot>/node_modules for jiti walk-up resolution.
# Collects the dependencies of each deployed extension's package.json and merges them into one npm install.
echo "[deploy-ext] reconciling runtime deps into webRoot node_modules ..."
WEBROOT="$(dirname "$DEST")"
DEP_LIST=$(node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1], deps = {};
  for (const id of fs.readdirSync(root)) {
    const f = path.join(root, id, "package.json");
    if (!fs.existsSync(f)) continue;
    try { const p = JSON.parse(fs.readFileSync(f, "utf8")); Object.assign(deps, p.dependencies || {}); } catch {}
  }
  process.stdout.write(Object.keys(deps).join(" "));
' "$DEST")
if [ -n "$DEP_LIST" ]; then
  (cd "$WEBROOT" && npm install $DEP_LIST --omit=dev --no-audit --no-fund --loglevel=error) \
    >"/tmp/deps-webroot-reconcile.log" 2>&1 \
    || echo "[deploy-ext] WARN webRoot reconcile failed (log /tmp/deps-webroot-reconcile.log)"
  echo "[deploy-ext] reconciled: $DEP_LIST"
fi
