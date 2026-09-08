#!/usr/bin/env bash
# pi-web-win (Windows 155) artifact build & push — run on 48.
#
# Usage:
#   scripts/win-build-push.sh             # build (.next-prod) + push artifact to 155
#                                         # ⚠覆盖前必须确认 155 prod 实例已停止：实例运行中
#                                         # 持有 .next-prod 文件锁，tar 覆盖会静默半失败
#                                         # （aiti-ai/docs/pi-web-win-deployment.md §8 实证）。
#                                         # 实例在跑时请用 --restart（远端 pullbuild 闭环）。
#   scripts/win-build-push.sh --restart   # build + restart 155 prod instance — 155 端
#                                         # `pi-web-win.bat pullbuild`：先 stop 实例，再经 ssh
#                                         # 回调本脚本 --stdout 拉 tar、解压、校验 BUILD_ID、
#                                         # start（stop→拉→验→起 完整闭环，优先用这个）
#   scripts/win-build-push.sh --stdout    # build only; artifact tar to stdout
#                                         # (155-side `pi-web-win.bat pullbuild` pulls this via ssh)
#
# 155 cannot build locally (15.7G RAM OOM + DingTalk cache EPERM, see
# aiti-ai/docs/pi-web-win-deployment.md §8), so prod artifacts are always
# built here and shipped over. basePath opt-in is REQUIRED for the /win
# sub-path deployment — build AND start must both see PI_WEB_BUILD_BASEPATH=1.
set -euo pipefail
cd "$(dirname "$0")/.."

WIN_HOST=user@192.168.122.155
WIN_DIR="C:/workspace/pi-web"

export NODE_ENV=production
export PI_WEB_DIST_DIR=.next-prod
export PI_WEB_BUILD_BASEPATH=1
export PI_WEB_BASE_PATH=/win

# 构建缓存不进产物：155 不 build，cache 纯冗余且占传输大头（产物 ~600M）
tar_artifact() { tar czf - --exclude='.next-prod/cache' .next-prod; }

case "${1:-}" in
  --stdout)
    bun run build >&2
    tar_artifact
    ;;
  "")
    bun run build >&2
    # 远端校验 BUILD_ID 缺失即 exit 1（失败性检查：半失败覆盖时 BUILD_ID 常在而 chunk 缺，这里兜不住
    # 全部半失败形态——运行中覆盖的根本防护是「先停实例」，见头注释与 --restart）
    tar_artifact | ssh "$WIN_HOST" "tar -xzf - -C $WIN_DIR && if not exist $WIN_DIR\\.next-prod\\BUILD_ID exit 1"
    echo "[win-build-push] artifact pushed to $WIN_HOST:$WIN_DIR/.next-prod"
    echo "[win-build-push] NOTE: 若 155 prod 实例运行中，本次覆盖可能静默半失败——请访问 /win/ 验证，或改用 --restart"
    ;;
  --restart)
    # 不在本地 push 后再 restart（实例运行中覆盖=静默半失败）；交由 155 端 pullbuild 闭环：
    # stop 实例 → ssh 回调本脚本 --stdout 拉 tar → 解压 → 校验 BUILD_ID → start
    ssh "$WIN_HOST" "call C:\\workspace\\pi-web\\pi-web-win.bat pullbuild"
    ;;
  *)
    echo "unknown option: $1 (use --restart | --stdout)" >&2
    exit 2
    ;;
esac
