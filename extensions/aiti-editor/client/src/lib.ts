/**
 * aiti-editor · 纯工具/常量（自手写版原样搬运，无 ctx/base 依赖）。
 */

// ── 语言表（对齐核心 lib/file-types）──
export const LANG_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less", html: "html", htm: "html", vue: "html",
  md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml", xml: "xml", svg: "xml",
  py: "python", pyw: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  sql: "sql", toml: "toml", ini: "ini", conf: "ini", cfg: "ini",
  env: "env", dotenv: "env", properties: "env",
  log: "log", logs: "log",
  csv: "csv", tsv: "csv",
  dockerfile: "dockerfile", makefile: "makefile", groovy: "groovy", lua: "lua", pl: "perl",
  r: "r", dart: "dart", coffee: "coffeescript", ps1: "powershell",
};

export const BINARY_EXT = new Set<string>([
  "png","jpg","jpeg","gif","webp","bmp","ico","avif","heic","svg",
  "mp3","wav","ogg","flac","m4a","aac","opus","mid","mp4","webm","avi","mov","mkv",
  "pdf","docx","doc","xls","xlsx","xlsm","xlsb","ppt","pptx","odt","ods","odp",
  "zip","gz","tar","7z","rar","bz2","xz","zst",
  "bin","iso","img","class","jar","war","so","dll","exe","dylib",
  "ttf","woff","woff2","eot","otf",
  "db","sqlite","sqlite3","pyc","pyo","o","a","lib","obj",
]);

/** 浏览器可渲染的二进制文件扩展名（图片/视频/音频/PDF） */
export const VIEWABLE_BINARY_EXT = new Set<string>([
  "png","jpg","jpeg","gif","webp","bmp","ico","avif","heic","svg",
  "mp3","wav","ogg","flac","m4a","aac","opus","mid","mp4","webm","avi","mov","mkv",
  "pdf",
  "zip","tar","tgz","gz","bz2","xz","zst","7z","rar","cab","iso","wim","dmg",
]);

/** 文件类型检测：text / image / video / audio / pdf / archive */
export function detectFileType(fp: string): string {
  const ext = fp.split(".").pop()?.toLowerCase() || "";
  const name = fp.split("/").pop()?.toLowerCase() || "";
  if (["png","jpg","jpeg","gif","webp","bmp","ico","avif","heic","svg"].includes(ext)) return "image";
  if (["mp4","webm","avi","mov","mkv"].includes(ext)) return "video";
  if (["mp3","wav","ogg","flac","m4a","aac","opus","mid"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  // 压缩文件：zip/tar/tgz/tar.gz/tar.bz2/tar.xz/tar.zst/7z/rar
  if (["zip","tar","tgz","7z","rar","cab","iso","wim","dmg"].includes(ext) || /^tar\.(gz|bz2|xz|zst)$/.test(name) || ext === "gz" || ext === "bz2" || ext === "xz" || ext === "zst") return "archive";
  return "text";
}

/** 浏览器可渲染的二进制（图片/视频/音频/PDF）→ true；否则 false（zip/exe 等回退核心） */
export function isViewableBinary(fp: string): boolean {
  const ext = fp.split(".").pop()?.toLowerCase() || "";
  return VIEWABLE_BINARY_EXT.has(ext);
}

export function isTextFile(fp: string): boolean {
  const ext = fp.split(".").pop()?.toLowerCase() || "";
  return !BINARY_EXT.has(ext);
}

// 简单的 glob 匹配（* → [^/]*，** → .*，逗号分隔）
export function matchSelector(fp: string, sel: any): boolean {
  if (typeof sel === "string") {
    const p = sel.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "___DOUBLESTAR___").replace(/\*/g, "[^/]*").replace(/___DOUBLESTAR___/g, ".*");
    return new RegExp("^" + p + "$", "i").test(fp);
  }
  if (sel.extensions) return sel.extensions.some((e: string) => fp.endsWith(e));
  if (sel.filename) return fp.split("/").pop() === sel.filename;
  if (sel.pattern) return matchSelector(fp, sel.pattern);
  if (sel.mime) return false; // 需要 MIME 解析，M3+
  return false;
}
export function matches(filePath: string, selectors: any): boolean {
  if (!selectors) return false;
  // 单 selector 对象（如 { extensions: [".zip"] }，内建 BINARY_PROVIDERS 形态）与数组均支持——
  // 旧 resolve 用 find 短路从未评估到对象 selector，M0 仲裁 filter 全量评估后必须兼容两种形态
  if (Array.isArray(selectors)) return selectors.some((s: any) => matchSelector(filePath, s));
  return matchSelector(filePath, selectors);
}

// CSV 彩虹列装饰颜色
export const CSV_RAINBOW = [
  'rgba(255,99,71,0.2)', 'rgba(60,179,113,0.2)', 'rgba(70,130,180,0.2)',
  'rgba(218,165,32,0.2)', 'rgba(147,112,219,0.2)', 'rgba(255,140,0,0.2)',
  'rgba(0,128,128,0.2)', 'rgba(220,20,60,0.2)', 'rgba(46,139,87,0.2)',
  'rgba(100,149,237,0.2)', 'rgba(210,105,30,0.2)', 'rgba(72,61,139,0.2)',
];

export function detectDelimiter(line: string): string {
  const scores: Record<string, number> = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (const ch of line) { if (ch in scores) scores[ch]++; }
  let best = ','; let bestN = 0;
  for (const [k, v] of Object.entries(scores)) { if (v > bestN) { bestN = v; best = k; } }
  return best;
}

export function parseCsvLine(line: string, delim: string): string[] {
  const fields: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ; continue;
    }
    if (c === delim && !inQ) { fields.push(cur); cur = ''; continue; }
    cur += c;
  }
  fields.push(cur);
  return fields;
}

// TOML 格式化：重排键值对 + 保留注释
export function formatToml(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) { out.push(lines[i]); continue; }
    if (trimmed.startsWith('[')) { out.push(lines[i]); continue; }
    // 简单的键值对格式化：确保 = 两边各一个空格
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      out.push(key + ' = ' + val);
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

// CSV 对齐格式化
export function formatCsv(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return text;
  const delim = detectDelimiter(lines[0]);
  const rows = lines.map((l) => parseCsvLine(l, delim));
  const maxCols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let j = 0; j < maxCols; j++) {
    widths[j] = Math.max(...rows.map((r) => (r[j] || '').length));
  }
  return rows.map((r) => {
    return r.map((f, j) => {
      if (j < widths.length - 1) return f + ' '.repeat(Math.max(0, widths[j] - f.length));
      return f;
    }).join(delim === ',' || delim === '\t' ? delim : delim + ' ');
  }).join('\n');
}

// 标题 slug（TOC 锚点 / 标题 id / 滚动同步统一算法，对齐 marked GitHub 风格）
export function mdSlug(text: string): string {
  return String(text).toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || "section";
}

// 预览 iframe 选中文本 → 源码行号（@ 提引用；找不到返回 null）
export function sourceLinesForText(source: string, text: string): { start: number; end: number } | null {
  const t = String(text || "").trim();
  if (!source || !t) return null;
  const srcLines = source.split("\n");
  const selLines = t.split("\n");
  const first = (selLines[0] || "").trim();
  let idx = -1;
  if (first) {
    idx = source.indexOf(first);
    if (idx < 0) {
      // markdown 渲染可能压缩空白：退化为折叠空白后重试
      const kw = first.replace(/\s+/g, " ").slice(0, 60);
      if (kw) idx = source.indexOf(kw);
    }
  }
  if (idx < 0) return null;
  let start = 1;
  for (let i = 0; i < idx; i++) if (source[i] === "\n") start++;
  const end = start + Math.max(1, selLines.length) - 1;
  if (end > srcLines.length) return null;
  return { start, end };
}

export function isDarkTheme(): boolean {
  // 按宿主实际渲染色判断：读 body/html 计算背景的相对亮度（ITU-R BT.709），
  // 天然兼容宿主全部主题（light/dark/mist/rose/pine）。此前 `html.dark ||
  // prefers-color-scheme` 在宿主亮主题 + OS 暗色时误判，且 5 主题被折叠成二值。
  for (const el of [document.body, document.documentElement]) {
    try {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)$/);
      if (!m) continue;
      const alpha = m[4] === undefined ? 1 : +m[4];
      if (alpha < 0.5) continue; // 透明背景不作数，看上一层
      const lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
      return lum < 0.5;
    } catch { /* getComputedStyle 不可用时走类名兜底 */ }
  }
  return document.documentElement.classList.contains("dark");
}

// 编码列表（VSCode 语义：显示 / 以编码重新打开 / 以编码保存）
export const ENCODINGS = [
  { id: "auto", label: "\u81EA\u52A8\u68C0\u6D4B" },
  { id: "utf-8", label: "UTF-8" },
  { id: "utf-8-bom", label: "UTF-8 with BOM" },
  { id: "utf-16le", label: "UTF-16 LE" },
  { id: "utf-16be", label: "UTF-16 BE" },
  { id: "gbk", label: "GBK / GB2312" },
  { id: "latin1", label: "Latin-1" },
];

export const encDisplay = (enc: string, hasBOM?: boolean): string => {
  if (enc === "utf-16le") return "UTF-16 LE";
  if (enc === "utf-16be") return "UTF-16 BE";
  if (enc === "gbk") return "GBK";
  if (enc === "latin1") return "Latin-1";
  return hasBOM ? "UTF-8 BOM" : "UTF-8";
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** 从图片 src 猜扩展名（data URL mime / URL 路径尾段）——消息图片无文件名时展示/下载名兜底。
 *  返回小写裸扩展名（不含点）；无法判断时返回 ""。 */
export function guessImageExt(src: string): string {
  if (!src) return "";
  if (src.startsWith("data:")) {
    const semi = src.indexOf(";");
    const mime = src.slice(5, semi > 0 ? semi : undefined).split("+")[0];
    return (mime.split("/")[1] || "").toLowerCase();
  }
  const path = src.split(/[?#]/)[0];
  const last = path.split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/** data URL base64 载荷估算字节数（信息面板「大小」显示；非 base64 data URL 返回 undefined） */
export function estimateDataUrlBytes(src: string): number | undefined {
  const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(src || "");
  if (!m) return undefined;
  const b64 = m[1].replace(/\s+/g, "");
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

// ── vendor 库加载器（fetch + 受控执行）──
// 不能用 <script> 直插：页面存在 Monaco AMD loader（window.define.amd）时，
// UMD 库会注册成 AMD 匿名模块而非挂载全局 → window.jsyaml 等永远不存在。
// 受控执行屏蔽 exports/module/define，强制走 globalThis 挂载分支。
const _vendorPromises: Record<string, Promise<any>> = {};
export function loadVendorGlobal(url: string, globalName: string, factory?: (g: any) => any): Promise<any> {
  const w = window as any;
  if (w[globalName]) return Promise.resolve(w[globalName]);
  const key = globalName + '|' + url;
  if (_vendorPromises[key]) return _vendorPromises[key];
  const p = new Promise((resolve, reject) => {
    fetch(url, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('vendor 加载失败: ' + url); return r.text(); })
      .then((code) => {
        try { new Function('exports', 'module', 'define', code)(undefined, undefined, undefined); }
        catch {}
        if (w[globalName]) resolve(factory ? factory(w[globalName]) : w[globalName]);
        else reject(new Error('vendor 全局未挂载: ' + globalName));
      })
      .catch(reject);
  });
  // 失败不永久缓存：下次调用可重试
  p.catch(() => { delete _vendorPromises[key]; });
  return p;
}

// ── Monaco 加载错误可读化 ──
// vscode AMD loader 对脚本加载失败会把原始 Event 直接 String() 进 Error.message
//（"[object Event]"），丢失 URL 等一切细节（2026-09-25 排障实测）。这里把该形态
// 转成可读文案；普通 Error 原样透传 message；Event 本体则尽量提取失败 src。
export function describeMonacoError(err: unknown): string {
  const e = err as any;
  const src = e && typeof e === "object" && e.target && (e.target.src || e.target.href);
  if (typeof Event !== "undefined" && e instanceof Event) {
    return "脚本加载失败" + (src ? "：" + String(src).slice(-140) : "（网络中断 / 404 / 被拦截）");
  }
  const msg = e && typeof e.message === "string" ? e.message : (typeof err === "string" ? err : "");
  if (/\[object Event\]/.test(msg)) {
    // loader 把 Event 字符串化塞进 Error.message，URL 已丢失 → 通用文案 + 自助指引
    return "脚本加载失败（网络中断 / 404 / 被拦截），已自动清除加载缓存，可重试；若仍失败请刷新页面";
  }
  if (msg) return msg;
  if (src) return "脚本加载失败：" + String(src).slice(-140);
  return String(err ?? "未知错误");
}
