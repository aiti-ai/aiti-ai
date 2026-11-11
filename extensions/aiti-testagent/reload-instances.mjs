/**
 * _shared/reload-instances.mjs · pi-web 双实例热重载（各扩展 deploy.mjs 共用）
 *
 * dev 3001 / 生产 3002；端口可经 AITI_DEV_PORT / AITI_PROD_PORT 覆盖；
 * basePath 双 env（AITI_DEV_BASE_PATH / AITI_PROD_BASE_PATH）按机器设值，
 *   推荐值不带斜杠（48：dev 与 空；155：系统级 wdev 与 win）——git-bash 启动
 *   原生程序时会把 / 开头的 env 值做 MSYS 路径转换（/wdev → D:/apps/Git/wdev）
 *   致 URL 非法；不带斜杠则不触发转换。此处自动补 /（旧 /xxx 格式仍兼容），
 *   兼容不了时提示 MSYS_NO_PATHCONV=1。
 * 避免「server 端代码改了、实例没 reload 导致跑旧逻辑」。
 *
 * 用法（静态 import 或顶层 await import 均可）：
 *   import { reloadInstances } from "../../_shared/reload-instances.mjs";
 *   await reloadInstances();              // 默认 "[deploy] " 前缀
 */
const BASE_PATH_RE = /^\/[A-Za-z0-9._-]*$/;

function buildInstance(name, portEnv, portDefault, pathEnv, pathDefault) {
  const origin = `http://127.0.0.1:${process.env[portEnv] || portDefault}`;
  const raw = process.env[pathEnv];
  if (raw === undefined || raw === null || String(raw).trim() === "") return { name, base: origin + pathDefault };
  // 自动补 /：wdev → /wdev（推荐无斜杠格式，MSYS 不转换）；/wdev → /wdev（旧格式兼容）
  const p = "/" + String(raw).trim().replace(/^\/+|\/+$/g, "");
  if (BASE_PATH_RE.test(p)) return { name, base: origin + p };
  return { name, base: null, raw };
}

/** 双实例清单（dev/prod 各 {name, base}）；reload-instances 与 reconcile-deps 等共用。 */
export function buildInstances() {
  return [
    buildInstance("dev", "AITI_DEV_PORT", 3001, "AITI_DEV_BASE_PATH", "/dev"),
    buildInstance("prod", "AITI_PROD_PORT", 3002, "AITI_PROD_BASE_PATH", ""),
  ];
}

export async function reloadInstances(prefix = "[deploy] ") {
  // 批次合并（deploy-all 场景）：子条目部署脚本被注入 PI_WEB_DEFER_RELOAD=1 时不各自 reload，
  // 由 deploy-all 在全部条目完成后统一执行一轮（N 条目 × 2 实例 → 2 次 POST）。
  // 避免批量部署时的 reload 风暴（2026-09-15 实测：65 条目逐个 reload 把 dev 实例打满）。
  // 单独跑某个扩展 deploy.mjs 不带该 env → 行为不变（部署完立即 reload）。
  if (process.env.PI_WEB_DEFER_RELOAD === "1") {
    console.log(`${prefix}reload 已 defer（PI_WEB_DEFER_RELOAD=1，由 deploy-all 收尾统一执行）`);
    return;
  }
  // 允许失败：网络异常/非 2xx/服务未启动/env 非法一律只打提示，永不 throw——不影响 deploy 退出码
  for (const inst of buildInstances()) {
    if (inst.base === null) {
      const msysHint = /[\\:]/.test(inst.raw) ? "——疑似 git-bash MSYS 路径转换，用 MSYS_NO_PATHCONV=1 前缀重跑" : "";
      console.log(`${prefix}reload ${inst.name} 跳过：AITI_${inst.name.toUpperCase()}_BASE_PATH="${inst.raw}" 非法（须形如 /xxx 或留空）${msysHint}`);
      continue;
    }
    try {
      const r = await fetch(inst.base + "/api/extensions/reload", { method: "POST" });
      console.log(`${prefix}reload ${inst.name} → HTTP ${r.status} ${r.ok ? "✓" : "⚠ 失败（请手动 POST /api/extensions/reload）"}`);
    } catch (e) {
      const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : String((e && e.message) || e);
      console.log(`${prefix}reload ${inst.name} 不可达（${cause}）— 需手动 POST /api/extensions/reload`);
    }
  }
}
