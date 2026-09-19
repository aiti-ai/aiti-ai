/**
 * client-bundle — server-side batch bundling of eager extension client bundles
 * (page-load request-count governance).
 *
 * Background: opening a page loads each extension's client bundle individually
 * (~35 requests with zero interaction, plus a dozen-odd sub-chunks per
 * extension). These extensions materialize on first paint regardless, so
 * per-request loading is pure network overhead. This module uses esbuild to
 * bundle the client entries of all "eager" (ui.clientImmediately !== false)
 * extensions into **one ESM** exporting `registry: { [extId]: registerFn }`;
 * the frontend loader imports it once and materializes each item per the graph.
 *
 * Static imports are inlined; **dynamic import() is always externalized** into
 * relative references (`./<extId>/assets/<rel>`, resolved as relative package
 * URLs → basePath follows automatically). What extensions express with dynamic
 * imports are lazy resources loaded only on first interaction (wizards, file
 * browsers, follow-along readers, etc.) and must not be downloaded early just
 * because of bundling. Externalized URLs are still served by the original
 * extension asset route (content-hashed filenames can be cached immutable);
 * network behavior is identical to before bundling.
 *
 * Exclusions (not batch-bundled; still served per-extension URL):
 *  - Extensions whose entry (or its submodules) use `import.meta` — their asset
 *    base depends on `import.meta.url` (`/assets/(dist|client)/` prefix matching),
 *    and URL drift after bundling would break CSS/vendor path resolution
 *    (especially dangerous under subpath deployment). Detection is
 *    defense-in-depth: a build-time onLoad plugin re-scans; any straggler is
 *    automatically dropped and the bundle rebuilt (reported as offenders).
 *  - Lazy (immediately:false) extensions: must stay on-demand, never enter the
 *    batch bundle.
 *
 * Split-bundle extensions (thin shell + lazy chunks, e.g. trace/speech
 * extensions): **kept in the batch bundle**, but their static relative imports
 * (shared entry chunk) are likewise externalized into relative package URL
 * references — the shared chunk must keep the file URL as its single runtime
 * instance; otherwise the batch bundle inlines one copy and the lazy chunk loads
 * another by URL, duplicating shared modules like the host shim (`_ctx` never
 * injected; observed at render time as `v is not a function or its return value
 * is not iterable` plus hooks order corruption). See usesLazyChunks for the test.
 *
 * Caching: the bundle rev is derived from the participating extensions' (id, rev)
 * set (content-addressed); callers cache by rev. URLs look like
 * /api/extensions/client-bundle?rev=<rev> and can be cached immutable forever.
 *
 * Fault tolerance: the frontend loader has a per-extension fallback path for
 * batch-bundle import failures/missing entries — a batch failure just means
 * falling back to the old behavior, never breaking all extensions at once.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath, relative as relativePath, isAbsolute, sep } from "node:path";
import { build } from "esbuild";
import { clientBundleRev } from "./client-modules.ts";

/** Entry files above this size skip the import.meta scan (guards against large synchronous reads); conservatively treated as sensitive. */
const MAX_META_SCAN_BYTES = 4 * 1024 * 1024;

export interface ClientBundleEntry {
  id: string;
  /** Extension code root directory (ownership test: any input file under it counts as this extension's). */
  dir: string;
  /** Absolute path of the client entry. */
  file: string;
  /** Entry content hash (same source as the boot graph row rev). */
  rev: string;
  /** Materialize priority (bundle order = priority descending, keeping side-effect order stable). */
  priority?: number;
  /** Order within the graph (ties at equal priority follow graph order). */
  order: number;
}

export interface BuiltClientBundle {
  rev: string;
  code: string;
  /** Extension ids actually included in the bundle (callers use it to backfill boot graph bundle.ids). */
  ids: string[];
  /** Extensions found using import.meta during the build (should already have been excluded by entry scanning; any that appear slipped through and were dropped). */
  offenders: string[];
  /** Split-bundle extension ids (static relative imports externalized: shared chunks keep a single runtime instance). */
  chunked: string[];
}

interface FileScan {
  mtime: number;
  size: number;
  /** File body contains `import.meta`. */
  usesMeta: boolean;
  /** The file itself has a relative dynamic import (`import("./x")`) — a split-bundle signal. */
  selfLazyChunk: boolean;
  /** The file's own static relative dependency specifiers (`from "./x"` / `import "./x"`), for closure walks. */
  staticRel: string[];
}
/** "sensitive" = unreadable/over the size limit: conservatively treated as sensitive (excluded from the batch bundle). */
const fileScanCache = new Map<string, FileScan | "sensitive">();

const REL_FROM_RE = /\bfrom\s*["'](\.\.?\/[^"']+)["']/g;
const REL_BARE_IMPORT_RE = /\bimport\s*["'](\.\.?\/[^"']+)["']/g;
const REL_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']/g;

/** Scan a single file, caching by mtime+size; null = unreadable/over the limit (sensitive). */
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
 * Whether the entry file uses `import.meta` (a sensitivity marker for relative
 * asset positioning). Cached by mtime+size; unreadable or oversized (>4MB) files
 * are always treated as sensitive (conservatively excluded).
 */
export function usesImportMeta(file: string): boolean {
  const scan = scanFile(file);
  return scan === null ? true : scan.usesMeta; // unreadable → keep out of the batch bundle (let the single-extension path surface the error)
}

/** Relative specifier → file on disk; without an extension, try .mjs/.js/index fallbacks. Returns null when not found. */
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
 * Split-bundle detection: does the entry's own static relative dependency closure
 * contain a **relative dynamic import** (`import("./x")`)?
 *
 * A hit = the "thin shell + lazy chunks" shape (vite lib code-splitting output):
 * the entry stub statically imports a shared chunk, and the shared chunk dynamically
 * imports lazy chunks. The batch bundle statically inlines the entry/stub but
 * externalizes dynamic imports into file URLs — the shared chunk loaded by URL at
 * runtime for a lazy chunk is a **second module instance** (the host shim's `_ctx`
 * never injected → hooks return undefined; observed at render time as `v is not a
 * function or its return value is not iterable` plus hooks order corruption). Such
 * extensions stay out of the batch bundle: served per-extension URL, the stub,
 * shared chunk, and lazy chunks naturally share one instance.
 *
 * Only **relative** dynamic imports count: bare specifiers are bundled in by
 * esbuild (no runtime chunks), so no duplicate instance. Unreadable/over the limit
 * → conservatively return true.
 */
export function usesLazyChunks(file: string): boolean {
  const seen = new Set<string>();
  const walk = (f: string): boolean => {
    if (seen.has(f)) return false;
    seen.add(f);
    const scan = scanFile(f);
    if (scan === null) return true; // conservative: unreadable means exclude
    if (scan.selfLazyChunk) return true;
    for (const spec of scan.staticRel) {
      const target = resolveStaticImport(f, spec);
      if (target && walk(target)) return true;
    }
    return false;
  };
  return walk(file);
}

/** Empty bundle (the frontend gets a valid module when there are no eager extensions). */
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
 * Build a self-contained ESM containing all entries. Callers cache the result
 * (keyed by rev). If the build discovers an included extension's submodule using
 * import.meta (missed by entry scanning), it is dropped automatically, the bundle
 * is rebuilt once, and the id is reported in the returned offenders.
 */
export async function buildClientBundle(entries: ClientBundleEntry[]): Promise<BuiltClientBundle> {
  if (entries.length === 0) {
    return { rev: clientBundleRev([]), code: emptyClientBundleCode(), ids: [], offenders: [], chunked: [] };
  }
  const sorted = [...entries].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.order - b.order);
  const included = [...sorted];
  let offenders: string[] = [];
  // Split-bundle extensions (entry's static closure contains a relative dynamic
  // import): their static relative imports must be externalized — lazy chunks load
  // the shared chunk again by file URL, and inlining it in the batch bundle would
  // duplicate the shared module.
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
          // Externalize relative imports (as relative package URL file references;
          // basePath follows automatically):
          //  · dynamic imports: always externalized — lazy resources declared by
          //    extensions as "load on first interaction" must not be downloaded early
          //    just because of bundling;
          //  · static imports: externalized only for split-bundle extensions
          //    (chunkedIds) — the shared chunk must keep the file URL as its single
          //    instance, otherwise the batch bundle inlines one copy + lazy chunks
          //    load another = duplicate instance.
          name: "pi-web-relative-import-external",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^\.{1,2}\// }, (args) => {
              const isDynamic = args.kind === "dynamic-import";
              const abs = resolvePath(args.resolveDir, args.path);
              if (!existsSync(abs)) return null;
              const owner = ownerOf(abs, owners);
              if (!owner) return null;
              // Static: externalize only split-bundle extensions' JS dependencies (non-JS assets still go to esbuild).
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
    // Drop the stragglers and rebuild (never happens on the normal path: the boot graph already excludes them by entry scanning).
    offenders = [...new Set([...offenders, ...unexpected])];
    for (const id of unexpected) {
      const idx = included.findIndex((e) => e.id === id);
      if (idx >= 0) included.splice(idx, 1);
    }
    if (included.length === 0) {
      return { rev: clientBundleRev([]), code: emptyClientBundleCode(), ids: [], offenders, chunked: [] };
    }
  }
  // Unreachable (the loop always returns); kept as a safety net.
  return { rev: clientBundleRev([]), code: emptyClientBundleCode(), ids: [], offenders, chunked: [] };
}

/** The extension owning an input file (input path lies under the extension's client-entry directory; longest matching directory wins). */
function ownerOf(file: string, owners: Array<{ id: string; dir: string }>): { id: string; dir: string } | null {
  let best: { id: string; dir: string } | null = null;
  for (const o of owners) {
    if (isUnderDir(file, o.dir)) {
      if (!best || o.dir.length > best.dir.length) best = o;
    }
  }
  return best;
}

/** Whether file lies under dir (`relative`-based — safe across Linux/Windows separators and drive letters). */
function isUnderDir(file: string, dir: string): boolean {
  const rel = relativePath(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
