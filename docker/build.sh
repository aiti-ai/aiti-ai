#!/usr/bin/env bash
# build.sh — aiti Docker image build entry (aiti-docker-image-plan §3/§4.1; self-sufficient-repo edition since 2026-10-30)
# Usage:
#   ./docker/build.sh --target core --tag aiti/aiti:core
#   ./docker/build.sh --target full --tag aiti/aiti:full
# Mechanism: this repo (aiti-ai) IS the release repo — app sources = repo root, extensions/ = the ported
# extensions, packages/ = the aiti-bridge chain, pi-plugins/ = the pi plugin sources; assemble the staging
# build context, then docker build (BuildKit).
# The staging layout matches the historical one (pi-web/, pi-web-ext/, packages/, pi-ext/) — zero Dockerfile changes.
# External dependency (env-overridable, with a sensible default):
#   JUSTGET_SRC (default ~/workspace/justget, the standalone justdb/justget repo; if missing the image ships without justget, everything else proceeds)
#   PI_SUBAGENTS_NOTE: @aiti-ai/pi-subagents installs from the private npm source (source repo aiti-ai/pi-subagents-private, not this repo)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
# Self-sufficient repo: app/extensions/bridge/plugins all come from this repo; justget remains an external source (standalone repo)
PI_WEB_SRC="${PI_WEB_SRC:-$REPO_ROOT}"           # app sources = repo root
PI_WEB_EXT_SRC="${PI_WEB_EXT_SRC:-$REPO_ROOT/extensions}"  # extensions = the ported mirror in this repo
PACKAGES_SRC="${PACKAGES_SRC:-$REPO_ROOT/packages}"        # the aiti-bridge chain
PI_EXT_SRC="${PI_EXT_SRC:-$REPO_ROOT/pi-plugins}"          # pi plugins (models-combo/git-trace/plan-sandbox; the qoder-family private plugins stay in the private source repo, not here)
JUSTGET_SRC="${JUSTGET_SRC:-$HOME/workspace/justget}"

TARGET="core"
TAG=""
PLATFORM=""
CN=0
PRIVREG="${AITI_PRIVATE_REGISTRY:-}"
NPM_REG="${NPM_REG:-}"   # override the global registry (when the private source is a proxying repo it can be used directly, covering public + private deps)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --platform) PLATFORM="$2"; shift 2;;
    --cn) CN=1; shift;;
    --private-registry) PRIVREG="$2"; shift 2;;
    --npm-registry) NPM_REG="$2"; shift 2;;
    *) echo "unknown arg $1"; exit 1;;
  esac
done
TAG="${TAG:-aiti/aiti:${TARGET}}"
CORE_IMAGE="${CORE_IMAGE:-aiti/aiti:core}"   # the FROM base for full (tag alias, see ③)

# ① Preflight (design §4.1 step 1): base image reachability (26.04 pull via registry-mirror verified on the dev machine)
if ! docker image inspect ubuntu:26.04 >/dev/null 2>&1; then
  echo "[build] preflight: pulling ubuntu:26.04 ..."
  docker pull ubuntu:26.04
fi

# ①a Mirror policy: official sources by default (GitHub and other non-CN CI / official releases); --cn (or env AITI_CN=1) injects CN mirrors.
# The private registry (--private-registry / env AITI_PRIVATE_REGISTRY) is a **temporary** testing channel for
# @aiti-ai/* packages not yet on public npm; at release time omit it = @aiti-ai/* from public npm, no configuration needed.
EXTRA_ARGS=()
if [[ "$CN" = "1" || "${AITI_CN:-0}" = "1" ]]; then
  EXTRA_ARGS=(
    --build-arg APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
    --build-arg NPM_MIRROR=https://registry.npmmirror.com
    --build-arg HF_ENDPOINT=https://hf-mirror.com
    --build-arg PIP_MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple
  )
  echo "[build] CN mirror mode (--cn): apt=tuna npm=npmmirror hf=hf-mirror pypi=tuna"
else
  echo "[build] official-source mode (non-CN network / GitHub / releases; add --cn for CN builds)"
fi
if [[ -n "$NPM_REG" ]]; then
  EXTRA_ARGS+=(--build-arg "NPM_MIRROR=${NPM_REG}")
  echo "[build] global registry override: ${NPM_REG}"
fi
PRIV_ARGS=()
if [[ -n "$PRIVREG" ]]; then
  EXTRA_ARGS+=(--build-arg "AITI_NPM_REGISTRY=${PRIVREG}")
  echo "[build] private-registry test mode: @aiti-ai/* ← ${PRIVREG} (temporary; omitted for official releases)"
fi
# scope private-registry auth (paired with --private-registry; credentials kept in a separate env, never on the command line)
if [[ -n "$PRIVREG" ]]; then
  [[ -n "${AITI_NPM_REGISTRY_USER:-}" ]] && EXTRA_ARGS+=(--build-arg "AITI_NPM_REGISTRY_USER=${AITI_NPM_REGISTRY_USER}")
  [[ -n "${AITI_NPM_REGISTRY_PASS:-}" ]] && EXTRA_ARGS+=(--build-arg "AITI_NPM_REGISTRY_PASS=${AITI_NPM_REGISTRY_PASS}")
fi

# ② Assemble the staging build context (git-irrelevant files handled by rsync excludes)
STAGE="${REPO_ROOT}/.docker-build-context"
# Wipe and rebuild every time: rsync --exclude protects (does not delete) pre-existing excluded files on the
# receiving side, so stale staging dirs (.next-*/.venv/ai-configs) would permanently leak into the build context (20GB first-run lesson)
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$HERE/.dockerignore" "$STAGE/.dockerignore"
echo "[build] staging -> $STAGE"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.next' --exclude '.next-*' --exclude '.git' \
  --exclude '.docker-build-context' --exclude 'dist' \
  --exclude '.aiti-trace' --exclude 'tsconfig.tsbuildinfo' \
  --exclude '/extensions' --exclude '/pi-plugins' --exclude '/packages' \
  --exclude '/docker' --exclude '/test-results' \
  "$PI_WEB_SRC/" "$STAGE/pi-web/"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' \
  "$PI_WEB_EXT_SRC/" "$STAGE/pi-web-ext/"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'dist' \
  "$PACKAGES_SRC/" "$STAGE/packages/"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'dist' \
  "$PI_EXT_SRC/" "$STAGE/pi-ext/"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' \
  "$HERE/" "$STAGE/docker/"
if [ -d "$JUSTGET_SRC" ]; then
  rsync -a --delete --exclude 'node_modules' --exclude '.git' "$JUSTGET_SRC/" "$STAGE/justget/"
elif [ -f "$REPO_ROOT/vendor/npm/justget-0.2.4.tgz" ]; then
  # CI / source-less fallback: the published form of vendor (package.json + dist/cli.js complete, satisfying Dockerfile ⑦)
  echo "[build] JUSTGET_SRC missing → unpacking the vendor/npm/justget tgz"
  mkdir -p "$STAGE/justget"
  tar xzf "$REPO_ROOT/vendor/npm/justget-0.2.4.tgz" -C "$STAGE/justget" --strip-components=1
else
  echo "[build] ⚠ no justget source and no vendor tgz — the Dockerfile COPY justget will fail (fail-fast)"
fi
# ②.5 dependency source selection (official chain = registry: npm publish first → the container build pulls deps from the same registry;
#  temporary test chain = vendor rewrite (file:/opt/vendor, zero registry), enabled with env AITI_DOCKER_VENDOR_REWRITE=1;
#  default off = the official-repo path. Once @aiti-ai/* is on the official registry this section and the Dockerfile /opt/vendor can retire together)
mkdir -p "$STAGE/vendor/rewritten"   # empty-dir backstop: the Dockerfile COPY always matches
if [[ "${AITI_DOCKER_VENDOR_REWRITE:-0}" == "1" ]]; then
  echo "[build] temporary chain: vendor rewrite enabled (file:/opt/vendor, no registry)"
  mkdir -p "$STAGE/vendor/npm"
  rsync -a "$REPO_ROOT/vendor/npm/" "$STAGE/vendor/npm/"
  node "$HERE/scripts/rewrite-vendor.mjs" "$STAGE" "pi-web-ext pi-ext packages"
else
  echo "[build] official chain: deps from the registry (NPM_MIRROR / AITI_NPM_REGISTRY scope)"
fi

# ③ Build (full requires core first: the docker build FROM aiti/aiti:core resolves the local image)
PLATFORM_ARG=(); [[ -n "$PLATFORM" ]] && PLATFORM_ARG=(--platform "$PLATFORM")
echo "[build] docker build --target ${TARGET} -> ${TAG}"
if [[ "$TARGET" == "full" ]]; then
  # The FROM base for full resolves by image name: if TAG moved repos (e.g. aitiai/pi-web:core), alias the freshly built core back to the default name
  docker tag "${TAG%:*}:core" "${CORE_IMAGE}" 2>/dev/null || docker tag "aiti/aiti:core" "${CORE_IMAGE}" || true
  EXTRA_ARGS+=(--build-arg "CORE_IMAGE=${CORE_IMAGE}")
fi
docker build ${PLATFORM_ARG+"${PLATFORM_ARG[@]}"} "${EXTRA_ARGS[@]}" \
  -f "$STAGE/docker/Dockerfile.${TARGET}" \
  -t "$TAG" \
  "$STAGE"

echo "[build] done: ${TAG}"
echo "[build] smoke (design §4.1 step 4):"
echo "  docker run --rm -p 30142:30142 -v aiti-data:/opt/aiti -v ~/workspace:/workspace ${TAG}"
