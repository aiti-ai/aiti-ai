/**
 * example-lib —— 本地"npm 风格"工具模块。
 *
 * 演示：JSX client 里可以用 import/export 拆成多个模块（模拟第三方库），
 * esbuild 打包时全部内联进单个 bundle 产物（client/demo-jsx.mjs）。
 * 真正 import npm 包也同理（见 jsx-example.tsx 里 `import QRCode from "qrcode"`）。
 */

/** 把文本缩写到 n 个字符（长文本截断展示用）。 */
export function truncate(text: string, n = 18): string {
  const s = String(text ?? "");
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** 当前时间（HH:MM:SS）。 */
export function nowClock(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/** 构造一个 slug（小写 + 连字符），演示纯函数工具。 */
export function slugify(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "empty";
}

/** 从 host-shim 拿 apiUrl，组合一次 fetch 的骨架（client ⇄ server 联动演示）。 */
export function apiGet(apiUrl: (p: string) => string, path: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  return fetch(apiUrl(path))
    .then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => null) }))
    .catch((e) => ({ ok: false, status: 0, data: String(e?.message ?? e) }));
}
