/**
 * convert-saveas — route factory for old-format "convert to an editable format, save-as and open" (shared authoritative source, deployed by copy into extension dirs).
 *
 * Scenario (plan §8 addendum): .xls/.ods → .xlsx (Excel editing), .doc → .docx (Word editing).
 * Rules:
 *   - soffice headless conversion; tmp dir sits in the target's dir (same filesystem, rename never crosses devices)
 *   - the new file lives next to the source, named `<stem>-from<ext>.<toExt>` (e.g. report-fromxls.xlsx);
 *     if taken, `<stem>-from<ext>(1).<toExt>` increments — never overwrites any existing file
 *   - the source file is untouched; single soffice instance mutex (globalThis-level, in-process mutex shared across extension modules)
 *
 * Endpoint semantics (POST, JSON body): { filePath: string, cwd?: string }
 *   → 200 { ok: true, newPath, size }
 *   → 400 path outside the whitelist / source extension unsupported
 *   → 409 concurrent race on the target (rare; the client just retries)
 *   → 500 soffice conversion failed
 */
import { mkdirSync, renameSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

/** Async execFile (Promise-wrapped). Perf red line (2026-09-13): the old execFileSync running the soffice
 *  conversion synchronously (timeout 90s) froze the pi-web main thread for seconds/minutes; the async
 *  version keeps the semantics without occupying the main thread. */
function execFileP(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "ignore", "pipe"] }, (err) => (err ? reject(err) : resolve()));
  });
}

function expandTildePath(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Write whitelist (mirrors the aiti-editor/blob-save-route M1 loose variant: workspace + user home) */
export function resolveAllowedWriteRoot(filePath: string, cwd?: string): string | null {
  if (!filePath) return null;
  const expanded = expandTildePath(filePath);
  if (!isAbsolute(expanded)) return null;
  const home = homedir();
  const roots: string[] = [];
  if (cwd && isAbsolute(cwd)) roots.push(normalize(cwd));
  roots.push(join(home, "workspace"));
  roots.push(home);
  const fp = normalize(expanded);
  return roots.some((r) => fp === r || fp.startsWith(r + sep)) ? fp : null;
}

export interface ConvertTarget {
  /** Target extension (no dot, e.g. "xlsx") */
  toExt: string;
  /** soffice --convert-to filter (e.g. `xlsx:Calc MS Excel 2007 XML`; defaults to toExt) */
  filter?: string;
}

export interface ConvertSaveAsOptions {
  extId: string;
  /** fromExt (no dot) → conversion target */
  conversions: Record<string, ConvertTarget>;
  /** Source file size cap (default 50MB) */
  maxBytes?: number;
  /** soffice locator (_shared/soffice-locate's makeSofficeLocator); missing → 503 soffice-missing */
  sofficePath: () => string | null;
}

/**
 * Candidate path generation (pure function, testable): <stem>-from<ext>.<toExt>, increments (n) on conflict.
 * @param exists path existence probe (injected for testability)
 */
export function nextSaveAsPath(dir: string, sourceName: string, fromExt: string, toExt: string, exists: (p: string) => boolean): string {
  const stem = sourceName.replace(/\.[^.]+$/, "");
  const tag = "-from" + fromExt.replace(/^\./, "");
  let n = 0;
  for (;;) {
    const suffix = n === 0 ? "" : "(" + n + ")";
    const candidate = join(dir, stem + tag + suffix + "." + toExt);
    if (!exists(candidate)) return candidate;
    n++;
  }
}

/**
 * Generate the route handler: `if (p[p.length-1] === "convert-saveas") return await handle(req);`
 */
export function createConvertSaveAsRoute(opts: ConvertSaveAsOptions) {
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const log = (m: string) => console.log("[" + opts.extId + "][convert-saveas] " + m);
  const mutex = (): number => ((globalThis as any).__aitiConvertBusy = (globalThis as any).__aitiConvertBusy || 0);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

  return async function handle(req: Request): Promise<Response> {
    let body: { filePath?: unknown; cwd?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "body must be JSON" }, 400);
    }
    const filePath = typeof body.filePath === "string" ? body.filePath : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    if (!filePath) return json({ ok: false, error: "filePath required" }, 400);

    const ext = (filePath.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    const conv = opts.conversions[ext];
    if (!conv) {
      return json({ ok: false, error: "source extension unsupported (supported: " + Object.keys(opts.conversions).map((k) => "." + k).join(" ") + ")" }, 400);
    }
    const target = resolveAllowedWriteRoot(filePath, cwd);
    if (!target) return json({ ok: false, error: "path outside the writable whitelist" }, 400);
    let st;
    try {
      st = statSync(target);
    } catch {
      return json({ ok: false, error: "source file not found" }, 400);
    }
    if (!st.isFile()) return json({ ok: false, error: "target is not a file" }, 400);
    if (st.size > maxBytes) return json({ ok: false, error: "file exceeds the " + Math.round(maxBytes / 1024 / 1024) + "MB cap" }, 413);

    // Candidate name (fixed once before conversion; revalidated right before rename against concurrent races)
    const dir = dirname(target);
    const sourceName = basename(target);
    let finalPath = nextSaveAsPath(dir, sourceName, ext, conv.toExt, (p) => { try { statSync(p); return true; } catch { return false; } });

    const soffice = opts.sofficePath();
    if (!soffice) {
      return json({
        ok: false,
        code: "soffice-missing",
        error: "LibreOffice (soffice) not found: old-format conversion needs it. Install LibreOffice, or set soffice.path in the aiti-editor feature config",
      }, 503);
    }
    if (mutex()) return json({ ok: false, error: "previous conversion still running, retry shortly" }, 409);
    const g = globalThis as any;
    g.__aitiConvertBusy = 1;
    const tmpOut = join(dir, "." + opts.extId + "-conv-" + process.pid + "-" + Date.now());
    try {
      mkdirSync(tmpOut, { recursive: true });
      const filter = conv.filter || conv.toExt;
      await execFileP(soffice, ["--headless", "--convert-to", filter, "--outdir", tmpOut, target], 90_000);
      const producedName = sourceName.replace(/\.[^.]+$/, "") + "." + conv.toExt;
      const produced = join(tmpOut, producedName);
      const ps = statSync(produced); // missing throws → falls into catch
      if (ps.size === 0) throw new Error("conversion output is empty");
      // Final no-overwrite check before rename (the target may be created concurrently during conversion)
      finalPath = nextSaveAsPath(dir, sourceName, ext, conv.toExt, (p) => { try { statSync(p); return true; } catch { return false; } });
      renameSync(produced, finalPath);
      const size = statSync(finalPath).size;
      log(sourceName + " → " + basename(finalPath) + " (" + size + " bytes)");
      return json({ ok: true, newPath: finalPath, size });
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes("ENOENT") && msg.includes(producedNameHint(sourceName, conv.toExt))) {
        return json({ ok: false, error: "soffice produced no conversion result (source file may be corrupt or the format unsupported)" }, 500);
      }
      log("convert failed: " + msg.slice(0, 200));
      return json({ ok: false, error: "convert failed: " + msg.slice(0, 200) }, 500);
    } finally {
      try { require("node:fs").rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignored */ }
      g.__aitiConvertBusy = 0;
    }
  };
}

function producedNameHint(sourceName: string, toExt: string): string {
  return sourceName.replace(/\.[^.]+$/, "") + "." + toExt;
}
