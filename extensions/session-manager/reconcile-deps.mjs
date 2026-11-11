/**
 * _shared/reconcile-deps.mjs · 通知 pi-web 双实例对齐扩展共享依赖（各扩展 deploy.mjs 共用）
 *
 * 背景：扩展运行时依赖统一装进共享根 <webRoot>/node_modules（jiti 从扩展目录向上解析
 * 自动命中；机制仿 pi 本体 npm: 包安装）。共享根的唯一写入方是 aiti-extman 的
 * shared-deps reconcile——deploy.mjs 拷完文件后 POST 本通知即可，不在部署脚本里跑 npm。
 *
 * 用法（与 reload-instances 同款：允许失败，永不 throw、不影响 deploy 退出码）：
 *   import { notifyReconcile } from "../../_shared/reconcile-deps.mjs";
 *   await notifyReconcile();               // 默认 "[deploy] " 前缀；建议在 reloadInstances() 之前调
 *
 * 失败无害：extman 在下一次 install/remove/reconcile-deps 时会自愈对齐；双实例各自
 * reconcile 各自的 webRoot（~/.pi/web 与 ~/.pi/web-dev），互不相干。
 */
import { buildInstances } from "./reload-instances.mjs";

export async function notifyReconcile(prefix = "[deploy] ") {
  for (const inst of buildInstances()) {
    if (inst.base === null) {
      console.log(`${prefix}reconcile ${inst.name} 跳过：basePath 非法`);
      continue;
    }
    try {
      const r = await fetch(inst.base + "/api/extensions/aiti-extman/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reconcile-deps", source: "deploy" }),
      });
      const body = await r.json().catch(() => null);
      const err = body && body.deps && body.deps.error;
      if (r.ok && body && body.ok) {
        console.log(`${prefix}reconcile ${inst.name} → ✓（${Object.keys(body.deps?.deps || {}).length} 个共享依赖）`);
      } else {
        console.log(`${prefix}reconcile ${inst.name} → HTTP ${r.status} ⚠${err ? " " + err : "（extman 未就绪？下次安装时自动对齐）"}`);
      }
    } catch (e) {
      const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : String((e && e.message) || e);
      console.log(`${prefix}reconcile ${inst.name} 不可达（${cause}）— 下次安装时自动对齐`);
    }
  }
}
