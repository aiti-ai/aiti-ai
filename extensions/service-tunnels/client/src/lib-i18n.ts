/**
 * lib-i18n — 客户端专用：构建期静态合并库 CATALOG 新域键进 I18N（esbuild
 * 内联 bundle；构建机 fresh 解析官方 JS 子路径，宿主进程解析缓存无碍）。
 * server 侧走 server/i18n.ts 的惰性 mergeLibCatalog()（startup 调用）。
 */
import { CATALOG as LIB_CATALOG } from "service-tunnels/i18n";
import { I18N } from "../../server/i18n";

const LIB_KEY_PREFIXES = ["ui.ddns.", "ui.portmap.", "ui.ipv6.", "ui.doctor.", "ui.ports.", "ui.detail."];
const LOCALE_MAP: Record<string, string> = { en: "en", zh: "zh-CN" };

function pickLibKeys(table: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(table)) {
    if (LIB_KEY_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

for (const [libLang, locale] of Object.entries(LOCALE_MAP)) {
  I18N[locale] = { ...pickLibKeys((LIB_CATALOG as Record<string, Record<string, string>>)[libLang] ?? {}), ...I18N[locale] };
}
