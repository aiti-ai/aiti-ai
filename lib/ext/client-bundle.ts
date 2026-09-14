/**
 * client-bundle — eager 扩展 client bundle 的服务端批量打包（开页请求数治理）。
 *
 * 背景：开页会逐扩展加载 client bundle（无交互即 ~35 个请求 + 各扩展的子 chunk
 * 十几请求）。这些扩展无论如何都要在首屏物化，逐请求加载只有网络开销。
 * 本模块用 esbuild 把所有「eager（ui.clientImmediately !== false）」扩展的 client
 * 入口打成**一个 ESM**，导出 `registry: { [extId]: registerFn }`；前端 loader 一次
 * import 后按图逐项 materialize。
 *
 * 静态导入内联；**动态 import() 一律外置**为相对引用（`./<extId>/assets/<rel>`，
 * 相对包 URL 解析 → 自动带 basePath）——扩展用动态 import 表达的都是「首次交互才
 * 加载」的懒资源（向导/文件浏览器/跟读引擎等），不得因打包提前下载。外置 URL 仍由
 * 原扩展资产路由服务（内容 hash 文件名可 immutable 缓存），与打包前网络行为一致。
 *
 * 排除项（不参与批量打包，仍走单扩展 URL）：
 *  - 入口（及其子模块）使用 `import.meta` 的扩展——它们的资产基址依赖
 *    `import.meta.url`（`/assets/(dist|client)/` 前缀匹配），批量打包后 URL 漂移会
 *    导致 CSS/vendor 路径解析失败（subpath 部署尤其危险）。检测含兜底：
 *    构建期 onLoad 插件二次扫描，发现漏网者自动剔除并重打包（返回 offenders）。
 *  - 懒加载（immediately:false）扩展：必须保持按需加载，不进批量包。
 *
 * 拆包扩展（薄壳 + 懒 chunk，如 aiti-git-trace / aiti-ai-speek）：**留在批量包**，
 * 但其静态相对 import（共享 entry chunk）同样外置为相对包 URL 引用——共享 chunk
 * 必须以文件 URL 为唯一运行时实例；否则批量包内联一份、懒 chunk 再按 URL 加载一份，
 * host-shim 等共享模块双实例（`_ctx` 丢失，实测渲染期 `v is not a function or its
 * return value is not iterable` + hooks 顺序错乱）。判断见 usesLazyChunks。
 *
 * 缓存：bundle rev 由参与扩展的 (id, rev) 集合导出（内容寻址），调用方按 rev 缓存；
 * URL 形如 /api/extensions/client-bundle?rev=<rev>，可 immutable 永久缓存。
 *
 * 容错：前端 loader 对批量包 import 失败/缺项有逐扩展回退路径——批量失败就等于
 * 退回旧行为，不会让全部扩展一起失效。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath, relative as relativePath, isAbsolute, sep } from "node:path";
import { build } from "esbuild";
import { clientBundleRev } from "./client-modules.ts";

/** 超过此大小的入口文件不做 import.meta 扫描（防同步读大文件），保守视为敏感。 */
const MAX_META_SCAN_BYTES = 4 * 1024 * 1024;

export interface ClientBundleEntry {
  id: string;
  /** 扩展代码根目录（归属判定用：任何位于其下的输入文件都算该扩展）。 */
  dir: string;
  /** client 入口的绝对路径。 */
  file: string;
  /** 入口内容 hash（与 boot graph 行 rev 同源）。 */
  rev: string;
  /** materialize 优先级（打包顺序 = priority 降序，保持侧效应顺序稳定）。 */
  priority?: number;
  /** 图内顺序（同优先级按图序）。 */
  order: number;
}

export interface BuiltClientBundle {
  rev: string;
  code: string;
  /** 实际打进包里的扩展 id（调用方用于回填 boot graph 的 bundle.ids）。 */
  ids: string[];
  /** 构建期发现的 import.meta 使用扩展（应已在入口扫描中排除；出现即漏网，已剔除）。 */
  offenders: string[];
  /** 拆包扩展 id（静态相对 import 已外置：共享 chunk 保持运行时单实例）。 */
  chunked: string[];
}

interface FileScan {
  mtime: number;
  size: number;
  /** 文件正文含 `import.meta`。 */
  usesMeta: boolean;
  /** 文件自身含相对动态 import（`import("./x")`）——拆包信号。 */
  selfLazyChunk: boolean;
  /** 文件自身的静态相对依赖说明符（`from "./x"` / `import "./x"`），闭包遍历用。 */
  staticRel: string[];
}
/** "sensitive" = 不可读/超限：保守视为敏感（排除出批量包）。 */
const fileScanCache = new Map<string, FileScan | "sensitive">();

const REL_FROM_RE = /\bfrom\s*["'](\.\.?\/[^"']+)["']/g;
const REL_BARE_IMPORT_RE = /\bimport\s*["'](\.\.?\/[^"']+)["']/g;
const REL_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']/g;

/** 读取并按 mtime+size 缓存单文件扫描结果；null = 不可读/超限（敏感）。 */
function scanFile(file: string): FileScan | null {
  try {
    const st = statSync(file);
    const cached = fileScanCache.get(file);
    if (cached === "sensitive") return null;
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached;
    if (st.size > MAX_META_SCAN_BYTES) {
      fileScanCache.set(file, "sensitive");
      return null;
    }
    const text = readFileSync(file, "utf8");
    const staticRel: string[] = [];
    for (const re of [REL_FROM_RE, REL_BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) staticRel.push(m[1]);
    }
    REL_DYNAMIC_IMPORT_RE.lastIndex = 0;
    const result: FileScan = {
      mtime: st.mtimeMs,
      size: st.size,
      usesMeta: text.includes("import.meta"),
      selfLazyChunk: REL_DYNAMIC_IMPORT_RE.test(text),
      staticRel,
    };
    fileScanCache.set(file, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * 入口文件是否使用 `import.meta`（资产相对定位的敏感标记）。
 * 按 mtime+size 缓存；不可读 / 过大（>4MB）一律视为敏感（保守排除）。
 */
export function usesImportMeta(file: string): boolean {
  const scan = scanFile(file);
  return scan === null ? true : scan.usesMeta; // 不可读 → 不进批量包（交给单扩展路径暴露错误）
}

/** 相对说明符 → 磁盘文件；无扩展名时尝试 .mjs/.js/index 兜底。找不到返回 null。 */
function resolveStaticImport(fromFile: string, spec: string): string | null {
  const base = resolvePath(dirname(fromFile), spec);
  const candidates = [base];
  if (!/\.[cm]?js$/.test(base)) {
    candidates.push(`${base}.mjs`, `${base}.js`, `${base}/index.mjs`, `${base}/index.js`);
  }
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch { /* try next */ }
  }
  return null;
}

/**
 * 拆包检测：入口自身的静态相对依赖闭包里是否出现**相对动态 import**（`import("./x")`）。
 *
 * 命中 = 「薄壳 + 懒 chunk」形态（vite lib 拆包产物）：入口 stub 相对 import 共享
 * chunk，共享 chunk 里再动态 import 懒 chunk。批量包会静态内联入口/stub，但把动态
 * import 外置为文件 URL——懒 chunk 运行时按 URL 加载的共享 chunk 是**第二个模块实例**
 * （host-shim 的 `_ctx` 从未注入 → hooks 返回 undefined；实测渲染期 `v is not a
 * function or its return value is not iterable` + hooks 顺序错乱）。这类扩展不进批量包，
 * 走单扩展 URL 时 stub/共享 chunk/懒 chunk 天然共享同一实例。
 *
 * 只认**相对**动态 import：裸说明符会被 esbuild 一并打进包（无运行时 chunk），不构成
 * 双实例。不可读/超限 → 保守返回 true。
 */
export function usesLazyChunks(file: string): boolean {
  const seen = new Set<string>();
  const walk = (f: string): boolean => {
    if (seen.has(f)) return false;
    seen.add(f);
    const scan = scanFile(f);
    if (scan === null) return true; // 保守：读不了就排除
    if (scan.selfLazyChunk) return true;
    for (const spec of scan.staticRel) {
      const target = resolveStaticImport(f, spec);
      if (target && walk(target)) return true;
    }
    return false;
  };
  return walk(file);
}

/** 空包（无 eager 扩展时前端拿到合法模块）。 */
export function emptyClientBundleCode(): string {
  return "export const registry = {};\n";
}

function buildStdinSource(entries: ClientBundleEntry[]): string {
  const lines: string[] = [
    "// pi-web eager extension client bundle (generated; see lib/ext/client-bundle.ts)",
  ];
  entries.forEach((e, i) => {
    lines.push(`import * as __m${i} from ${JSON.stringify(e.file)};`);
  });
  lines.push("export const registry = {");
  entries.forEach((e, i) => {
    lines.push(`  ${JSON.stringify(e.id)}: (__m${i}.default ?? __m${i}.register ?? null),`);
  });
  lines.push("};");
  return lines.join("\n");
}

/**
 * 打一个包含全部 entries 的自包含 ESM。调用方负责（按 rev）缓存结果。
 * 若构建期发现某个已包含扩展的子模块使用 import.meta（入口扫描漏网），
 * 自动把它剔除后重打一次，并在返回的 offenders 里报告。
 */
export async function buildClientBundle(entries: ClientBundleEntry[]): Promise<BuiltClientBundle> {
  if (entries.length === 0) {
    return { rev: clientBundleRev([]), code: emptyClientBundleCode(), ids: [], offenders: [], chunked: [] };
  }
  const sorted = [...entries].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.order - b.order);
  const included = [...sorted];
  let offenders: string[] = [];
  // 拆包扩展（入口静态闭包含相对动态 import）：其静态相对 import 必须外置——
  // 懒 chunk 会按文件 URL 再加载共享 chunk，批量包内联会使共享模块双实例。
  const chunkedIds = new Set(included.filter((e) => usesLazyChunks(e.file)).map((e) => e.id));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inclusionById = new Map(included.map((e) => [e.id, e]));
    const owners = [...inclusionById.values()].map((e) => ({ id: e.id, dir: e.dir }));
    const detected = new Set<string>();
    const result = await build({
      stdin: {
        contents: buildStdinSource(included),
        resolveDir: process.cwd(),
        sourcefile: "pi-web-ext-client-bundle.mjs",
        loader: "js",
      },
      outfile: "client-bundle.mjs",
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      splitting: false,
      minify: true,
      logLevel: "silent",
      metafile: false,
      plugins: [
        {
          // 相对 import 外置（统一为相对包 URL 的文件引用，basePath 自动跟随）：
          //  · 动态 import：一律外置——扩展声明的「首次交互才加载」懒资源不得因
          //    打包提前下载；
          //  · 静态 import：仅拆包扩展（chunkedIds）外置——共享 chunk 必须以文件
          //    URL 为唯一实例，否则批量包内联一份 + 懒 chunk 加载一份 = 双实例。
          name: "pi-web-relative-import-external",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^\.{1,2}\// }, (args) => {
              const isDynamic = args.kind === "dynamic-import";
              const abs = resolvePath(args.resolveDir, args.path);
              if (!existsSync(abs)) return null;
              const owner = ownerOf(abs, owners);
              if (!owner) return null;
              // 静态：仅拆包扩展的 JS 依赖外置（非 JS 资产照旧交 esbuild 处理）。
              if (!isDynamic && (!chunkedIds.has(owner.id) || !/\.(mjs|js|cjs)$/.test(abs))) return null;
              const rel = relativePath(owner.dir, abs).split(sep).join("/");
              return { path: `./${owner.id}/assets/${rel}`, external: true };
            });
          },
        },
        {
          name: "pi-web-import-meta-detect",
          setup(pluginBuild) {
            pluginBuild.onLoad({ filter: /\.(mjs|js|cjs)$/ }, (args) => {
              const contents = readFileSync(args.path, "utf8");
              if (contents.includes("import.meta")) {
                const owner = ownerOf(args.path, owners);
                if (owner) detected.add(owner.id);
              }
              return { contents, loader: "js" };
            });
          },
        },
      ],
    });

    const output = result.outputFiles.find((f) => /\.(mjs|js)$/.test(f.path)) ?? result.outputFiles[0];
    const unexpected = [...detected].filter((id) => inclusionById.has(id));
    if (unexpected.length === 0 || attempt === 1) {
      offenders = [...new Set([...offenders, ...unexpected])];
      return {
        rev: clientBundleRev(included),
        code: output?.text ?? emptyClientBundleCode(),
        ids: included.map((e) => e.id),
        offenders,
        chunked: included.filter((e) => chunkedIds.has(e.id)).map((e) => e.id),
      };
    }
    // 漏网者剔除后重打（正常路径不会发生：boot graph 已按入口扫描排除）。
    offenders = [...new Set([...offenders, ...unexpected])];
    for (const id of unexpected) {
      const idx = included.findIndex((e) => e.id === id);
      if (idx >= 0) included.splice(idx, 1);
    }
    if (included.length === 0) {
      return { rev: clientBundleRev([]), code: emptyClientBundleCode(), ids: [], offenders, chunked: [] };
    }
  }
  // 不可达（循环内必返回）；保底。
  return { rev: clientBundleRev([]), code: emptyClientBundleCode(), ids: [], offenders, chunked: [] };
}

/** 输入文件归属的扩展（输入路径在扩展 client 入口所在目录之下；取最长匹配目录）。 */
function ownerOf(file: string, owners: Array<{ id: string; dir: string }>): { id: string; dir: string } | null {
  let best: { id: string; dir: string } | null = null;
  for (const o of owners) {
    if (isUnderDir(file, o.dir)) {
      if (!best || o.dir.length > best.dir.length) best = o;
    }
  }
  return best;
}

/** file 是否位于 dir 之下（`relative` 判定——Linux/Windows 路径分隔符与盘符均安全）。 */
function isUnderDir(file: string, dir: string): boolean {
  const rel = relativePath(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
