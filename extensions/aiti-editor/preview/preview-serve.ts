/**
 * aiti-editor · HTML 预览服务态的**纯逻辑**（路由处理器在 index.ts，本模块零 ctx/无副作用）。
 *
 * 方案：docs/aiti-editor-html-preview-plan.md §3.2
 * 为什么需要它：票据只绑单个文件，页面里的 `./style.css`、`../img/a.png` 无处可去——
 *   本模块把「票据入口文件所在目录」变成预览命名空间的根，让相对解析成立。
 *
 * 四道守卫（缺一不可）：URL 解码/非法字符 → 目录越界（`..`）→ 软链逃逸（realpath 二次校验）
 *   → 扩展名白名单（**默认拒绝**：`.env`/`.git/*`/凭据文件不得随一个 html 一起被读走）。
 *
 * 为什么在 `preview/` 而不是扩展根：扩展根 package.json 是 `"type": "commonjs"`，node 直跑 .ts
 *   会按 CJS 解析 import 语句炸掉；本目录自带 `{ "type": "module" }`，`node --test` 才吃得下
 *   （同 client/src 惯例）。别把它们搬回根目录。
 */
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { buildPreviewShim, type PreviewShimOpts } from "./preview-shim.ts";
import { stripUserScripts } from "./strip-scripts.ts";

/** 预览文档体积上限（超过不注入 shim，直接原样流式；整读进内存的代价上限）。 */
export const PREVIEW_DOC_MAX_BYTES = 2 * 1024 * 1024;
/** 预览可服务的兄弟文件体积上限。 */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 兄弟资源扩展名白名单（默认拒绝）。判据 = 「浏览器能当子资源渲染/加载的静态资产」，
 * 不是「工作区里可能存在的一切」：`.env`/`.pem`/`.key`/`.git`/锁文件与各类配置一律不在列。
 */
export const PREVIEW_ALLOWED_EXT = new Set<string>([
  "html", "htm",
  "css", "map",
  "js", "mjs", "cjs", "json", "json5", "webmanifest",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tiff",
  "txt", "xml", "csv", "md",
  "woff", "woff2", "ttf", "otf", "eot",
  "wasm",
  "mp4", "webm", "mov", "m4a", "mp3", "wav", "ogg", "oga", "flac", "opus",
  "pdf", "vtt", "srt", "gltf", "glb", "gpx", "geojson",
]);

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", json5: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  ico: "image/x-icon", tiff: "image/tiff",
  txt: "text/plain; charset=utf-8", xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8", md: "text/markdown; charset=utf-8",
  map: "application/json",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  wasm: "application/wasm",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4a: "audio/mp4",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", opus: "audio/opus",
  pdf: "application/pdf", vtt: "text/vtt; charset=utf-8", srt: "application/x-subrip",
  gltf: "model/gltf+json", glb: "model/gltf-binary", gpx: "application/gpx+xml",
  geojson: "application/geo+json",
};

export function previewExtOf(p: string): string {
  // 按两种分隔符取末段：生产调用点传入的是 resolve() 产物（Windows 反斜杠形态），
  // 只切 "/" 会把 `D:\a.b\noext` 的目录点算进扩展名，白名单判定即错
  const base = String(p).split(/[/\\]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export function previewMimeOf(ext: string): string {
  return MIME[ext] || "application/octet-stream";
}

/** 预览文档（需要 CSP sandbox + shim 注入的那一类响应）。 */
export function isPreviewDoc(ext: string): boolean {
  return ext === "html" || ext === "htm";
}

export type PreviewResolve =
  | { ok: true; target: string; ext: string }
  | { ok: false; status: number; error: string };

export interface PreviewProbe {
  realpath(p: string): string;
  isFile(p: string): boolean;
}

const fsProbe: PreviewProbe = {
  realpath: (p) => realpathSync(p),
  isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
};

/** 相对段是否可接受（先于任何文件系统访问的语法级拒绝）。 */
function badRel(rel: string): string | null {
  if (!rel) return "缺少资源路径";
  if (rel.indexOf("\\") >= 0) return "路径不得含反斜杠"; // Windows 分隔符/转义歧义，一律拒
  if (rel.indexOf("\0") >= 0) return "路径含非法字符";
  if (isAbsolute(rel) || /^[a-zA-Z]:\//.test(rel)) return "不接受绝对路径";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rel.split("/")[0] || "")) return "不接受带协议的地址";
  for (const seg of rel.split("/")) {
    if (seg === ".") continue;
    if (seg === "") return "路径含空段";
  }
  // 不在这里再解码一次：rel 已是解码后的形态，二次解码会把文件名里的字面 `%`（`100%.html`）
  // 判成 "URI malformed" → 这类文件永远取不到。编码合法性由 resolvePreviewTarget 顶部那次解码负责。
  return null;
}

/**
 * 「票据 URL 本身 = 入口文档」：客户端 `previewUrl(base, "")` 拼出的就是目录根，而
 * `resolvePreviewTarget` 对空 rel 判 400（目录本身永不可寻址是有意守卫）。这条语义只能
 * 在知道票据文件的地方补齐——**先补成入口文件名再过守卫**，守卫本身不放宽。
 */
export function previewRelOrEntry(entryPath: string, rel: string): string {
  // 只看 URL 原样形态：解码统一在 resolvePreviewTarget 做一次（这里再解一次就是绕过面）
  const src = String(rel == null ? "" : rel).replace(/^\/+/, "").trim();
  if (src === "" || src === "." || src === "./") return encodeURIComponent(basename(String(entryPath || "")));
  return src;
}

/**
 * 把预览请求的相对路径解析到「票据入口文件所在目录」内。
 * @param entryPath 票据兑换出的真实文件绝对路径（预览的入口文档）
 * @param rel       URL 中 ticket 之后的相对段（已 split 好，可含子目录；空/`.` 先经 `previewRelOrEntry` 补成入口文件名）
 */
export function resolvePreviewTarget(entryPath: string, rel: string, probe: PreviewProbe = fsProbe): PreviewResolve {
  const rootDir = dirname(entryPath);
  let cleaned: string;
  try { cleaned = decodeURIComponent(rel).replace(/^\/+/, ""); }
  catch { return { ok: false, status: 400, error: "路径解码失败" }; }
  const bad = badRel(cleaned);
  if (bad) return { ok: false, status: 400, error: bad };

  let target: string;
  try { target = resolve(rootDir, cleaned); } catch { return { ok: false, status: 400, error: "路径解析失败" }; }
  const relFromRoot = relative(rootDir, target);
  if (relFromRoot === "" || isAbsolute(relFromRoot) || relFromRoot === ".." || relFromRoot.startsWith(".." + sep)) {
    return { ok: false, status: 403, error: "越出预览目录（相对路径不得跳出入口文件所在目录）" };
  }

  const ext = previewExtOf(target);
  if (!PREVIEW_ALLOWED_EXT.has(ext)) {
    return { ok: false, status: 403, error: "预览不接受 ." + (ext || "?") + " 文件（仅静态资产白名单）" };
  }
  if (!probe.isFile(target)) return { ok: false, status: 404, error: "资源不存在" };

  // 软链逃逸：两端都取真实路径再校验一次（`link -> /etc` 这类必须挡住）
  let realRoot: string, realTarget: string;
  try { realRoot = probe.realpath(rootDir); realTarget = probe.realpath(target); }
  catch { return { ok: false, status: 404, error: "资源不可读" }; }
  const realRel = relative(realRoot, realTarget);
  if (realRel === "" || isAbsolute(realRel) || realRel === ".." || realRel.startsWith(".." + sep)) {
    return { ok: false, status: 403, error: "软链指向预览目录之外" };
  }
  return { ok: true, target: realTarget, ext };
}

/**
 * 服务态文档的 CSP sandbox 值。不给 `allow-same-origin` = 文档落进 opaque origin：
 * 读不到 pi-web 的 DOM/localStorage/cookie，也发不出带凭据的同源请求。
 * scripts=false → 裸 `sandbox`（连脚本都不许执行）。
 */
export function previewCsp(scripts: boolean): string {
  return scripts ? "sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock" : "sandbox";
}

/** 把 shim 注入文档（优先 `</body>` 前，次选 `</html>` 前，都没有就追加）。 */
export function injectPreviewShim(html: string, opts: PreviewShimOpts & { maxBytes?: number }): string {
  const src = String(html == null ? "" : html);
  if (src.length > (opts && opts.maxBytes ? opts.maxBytes : PREVIEW_DOC_MAX_BYTES)) return src;
  const tag = "<script>" + buildPreviewShim(opts) + "<\/script>";
  const body = /<\/body[^>]*\s*>/i.exec(src);
  if (body) return src.slice(0, body.index) + tag + src.slice(body.index);
  const htmlEnd = /<\/html[^>]*\s*>/i.exec(src);
  if (htmlEnd) return src.slice(0, htmlEnd.index) + tag + src.slice(htmlEnd.index);
  return src + tag;
}

/**
 * 服务态文档装配（脚本开关 + shim 注入一次做完）。
 *
 * 「脚本关」= **剥掉作者脚本**而不是 `CSP: sandbox` 零授权：后者会把我们自己的 shim 一起杀掉，
 *   报错回传/链接改道/装载判定全失效——开关只该管作者的代码，不该管观测通道。
 *   因此 injected=true 时 CSP 恒带 allow-scripts（边界仍是 opaque origin）。
 * 超体积 → 原样返回 injected=false：整读代价太高，此时脚本关退化为「裸 sandbox」（无上报能力）。
 */
export function servePreviewDoc(
  html: string,
  opts: PreviewShimOpts & { scripts: boolean; maxBytes?: number },
): { body: string; injected: boolean; stripped: number } {
  const src = String(html == null ? "" : html);
  const limit = opts && typeof opts.maxBytes === "number" ? opts.maxBytes : PREVIEW_DOC_MAX_BYTES;
  if (src.length > limit) return { body: src, injected: false, stripped: 0 };
  const cut = opts && opts.scripts ? { html: src, removed: 0 } : stripUserScripts(src);
  return { body: injectPreviewShim(cut.html, opts), injected: true, stripped: cut.removed };
}

/** 预览路由基址（含尾斜杠）：`…/preview/<ticket>/`——注入 shim 与 iframe src 拼接的唯一口径。 */
export function previewBaseFromSegments(segments: string[], ticketIdx: number): string {
  return "/" + segments.slice(0, ticketIdx + 1).join("/") + "/";
}
