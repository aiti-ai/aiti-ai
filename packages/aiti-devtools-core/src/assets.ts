/**
 * aiti-devtools-core · 公共资产加载（载体无关）
 *
 * 构建产物（aiti-launcher.js / cockpit.html / bridge-client.js / aiwin.js / host-protocol.js / pair-client.js / pair.html）
 * 统一构建进本包 assets/（tools/build-assets.mjs），vite / webpack / 其他载体从这里读，
 * 一份资产多处复用（避免各载体包各自拷贝、漂移）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StaticFile } from "./http.ts";

export const ASSET_NAMES = ["aiti-launcher.js", "bridge-client.js", "cockpit.html", "aiwin.js", "host-protocol.js", "pair-client.js", "pair.html"] as const;

/** 读取资产 → 路径映射（键如 /aiti-launcher.js；剥挂载前缀后匹配，同独立桥/connect 语义） */
export function loadAssets(assetsDir?: string): Record<string, StaticFile> {
  const dir = assetsDir || new URL("../assets/", import.meta.url).pathname;
  const out: Record<string, StaticFile> = {};
  for (const name of ASSET_NAMES) {
    try {
      const content = readFileSync(join(dir, name), "utf8");
      const type = name.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8";
      out["/" + name] = { type, content };
    } catch (e) {
      console.warn(`[aiti-devtools] ⚠ 资产缺失：${join(dir, name)}（${(e as Error).message}）——先跑 packages/aiti-devtools-core/tools/build-assets.mjs 或传 assetsDir`);
    }
  }
  return out;
}
