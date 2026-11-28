/**
 * blob-save-route — binary file save route factory (shared authoritative source, copied into the
 * extension directory at deploy time).
 *
 * Consumers: implementation extensions with edit capability such as aiti-sheet-univer /
 * aiti-word-superdoc (docs/aiti-editor-office-plan.md §2.0 shared layer).
 *
 * Endpoint semantics (POST, JSON body):
 *   { filePath: string, dataBase64: string, baseMtimeMs?: number, cwd?: string }
 *   -> 200 { ok: true, mtimeMs, size }
 *   -> 400 path outside the allowlist / extension outside the allowlist / invalid dataBase64
 *   -> 409 { ok:false, conflict:true, diskMtimeMs } the file on disk was modified externally (optimistic lock)
 *   -> 413 over maxBytes
 * Writes are atomic (tmp + rename); the target directory is created automatically (a same-name save
 * target must already exist; the directory creation is a defensive fallback).
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

/** ~ expansion (browsers have no homedir; aligns with core /api/files filePathFromSegments) */
function expandTildePath(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Save allowlist (modeled on the aiti-editor M1 lenient variant: workspace + user root) */
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

export interface BlobSaveRouteOptions {
  /** Extension id (tmp file naming / log prefix) */
  extId: string;
  /** Allowlist of savable extensions (lowercase with dot, e.g. [".xlsx", ".xlsm"]) */
  allowedExts: string[];
  /** Per-file byte cap (default 30MB, plan §2.1 maxBytes feature tier) */
  maxBytes?: number;
}

export interface BlobSaveBody {
  filePath?: unknown;
  dataBase64?: unknown;
  baseMtimeMs?: unknown;
  cwd?: unknown;
}

/**
 * Build the route handler: `if (p[p.length-1] === "save-blob") return await handle(req);`
 */
export function createBlobSaveRoute(opts: BlobSaveRouteOptions) {
  const maxBytes = opts.maxBytes ?? 30 * 1024 * 1024;
  const allowed = new Set(opts.allowedExts.map((e) => e.toLowerCase()));
  const log = (m: string) => console.log("[" + opts.extId + "][save-blob] " + m);

  return async function handleSaveBlob(req: Request): Promise<Response> {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
    let body: BlobSaveBody;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "body must be JSON" }, 400);
    }
    const filePath = typeof body.filePath === "string" ? body.filePath : "";
    const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    if (!filePath || !dataBase64) return json({ ok: false, error: "filePath and dataBase64 are required" }, 400);

    const lower = filePath.toLowerCase();
    if (![...allowed].some((ext) => lower.endsWith(ext))) {
      return json({ ok: false, error: "extension not in the allowlist (" + [...allowed].join(" ") + ")" }, 400);
    }
    const target = resolveAllowedWriteRoot(filePath, cwd);
    if (!target) return json({ ok: false, error: "path outside the writable allowlist" }, 400);

    let buf: Buffer;
    try {
      buf = Buffer.from(dataBase64, "base64");
    } catch {
      return json({ ok: false, error: "invalid dataBase64" }, 400);
    }
    if (buf.length === 0) return json({ ok: false, error: "empty content refused" }, 400);
    if (buf.length > maxBytes) return json({ ok: false, error: "file exceeds the " + Math.round(maxBytes / 1024 / 1024) + "MB cap" }, 413);

    // Optimistic lock: baseMtimeMs disagrees with disk -> 409 (follows the aiti-editor conflict UI pattern)
    let st;
    try { st = statSync(target); } catch { /* new file (theoretically the save target must already exist; defensive) */ }
    if (st) {
      if (!st.isFile()) return json({ ok: false, error: "target is not a file" }, 400);
      if (typeof body.baseMtimeMs === "number" && Math.abs(st.mtimeMs - (body.baseMtimeMs as number)) > 1) {
        return json({ ok: false, conflict: true, diskMtimeMs: st.mtimeMs }, 409);
      }
    }

    // Atomic write: tmp must live in the target's directory (same filesystem, so rename never crosses devices with EXDEV)
    const tmp = join(dirname(target), "." + opts.extId + "-save-tmp-" + process.pid + "-" + Date.now());
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(tmp, buf);
      renameSync(tmp, target);
    } catch (e) {
      try { require("node:fs").rmSync(tmp, { force: true }); } catch { /* ignore */ }
      log("disk write failed: " + String((e as Error).message || e));
      return json({ ok: false, error: "disk write failed: " + String((e as Error).message || e) }, 500);
    }
    const after = statSync(target);
    log("saved " + target + " (" + after.size + " bytes)");
    return json({ ok: true, mtimeMs: after.mtimeMs, size: after.size });
  };
}

/** Content hash (debug/logging) */
export function blobHash(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex").slice(0, 8);
}
