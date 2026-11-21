/**
 * search.ts — workspace content search via ripgrep (dsh-better-sidebar borrow plan §2.5;
 * self-contained and directly testable, git-plan/watch same spot).
 *
 * Bounded by design (session-search discipline, DSH OOM lessons §4):
 *   - per-file match cap (rg --max-count), global match/file caps, wall-clock timeout;
 *   - --max-filesize skips huge/binary-ish files; .gitignore respected (rg default);
 *   - over-limit = explicit `truncated: true` — never silently cut.
 * Spawned async (server red line: no sync exec of external programs).
 */
import { spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";

const CONTENT_SEARCH_TIMEOUT_MS = 8_000;
const CONTENT_MAX_MATCHES = 200;
const CONTENT_MAX_FILES = 60;
const CONTENT_MAX_PER_FILE = 5;
const CONTENT_MAX_FILESIZE = "2M";
const CONTENT_LINE_TEXT_MAX = 240;

export interface ContentMatch { path: string; line: number; col: number; text: string }

export interface ContentSearchResult {
  ok: boolean;
  error?: string;
  rgMissing?: boolean;
  matches?: ContentMatch[];
  files?: number;
  truncated?: boolean;
  elapsedMs?: number;
}

/** Resolve the rg binary: PATH first, then common install locations. Cached per process. */
let rgPath: string | null | undefined;
function resolveRg(): Promise<string | null> {
  if (rgPath !== undefined) return Promise.resolve(rgPath);
  const candidates = ["rg", "/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg"];
  return new Promise((resolve) => {
    let pending = candidates.length;
    let found: string | null = null;
    for (const c of candidates) {
      const p = spawn(c, ["--version"], { stdio: "ignore" });
      p.on("error", () => { if (--pending === 0) { rgPath = found; resolve(rgPath); } });
      p.on("exit", (code) => {
        if (code === 0 && !found) found = c;
        if (--pending === 0) { rgPath = found; resolve(rgPath); }
      });
    }
  });
}

/** Run a bounded rg search; resolves with an explicit result (never throws). */
export function runContentSearch(root: string, query: string): Promise<ContentSearchResult> {
  const started = Date.now();
  return resolveRg().then((rg) => {
    if (!rg) return { ok: false, error: "ripgrep 不可用（未安装 rg）", rgMissing: true } as ContentSearchResult;
    return new Promise<ContentSearchResult>((resolve) => {
      const args = [
        "--json", "--smart-case", "--color", "never",
        "--max-count", String(CONTENT_MAX_PER_FILE),
        "--max-filesize", CONTENT_MAX_FILESIZE,
        "--no-require-git",
        "-g", "!.git/**",
        "-g", "!node_modules/**",
        "-g", "!*.min.js",
        "--", query, root,
      ];
      let child;
      try {
        child = spawn(rg, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        resolve({ ok: false, error: "ripgrep 启动失败: " + String((e as Error)?.message || e), rgMissing: true });
        return;
      }
      const matches: ContentMatch[] = [];
      const files = new Set<string>();
      let truncated = false;
      let stderrTail = "";
      let buf = "";
      const finish = (reason?: string) => {
        if (reason) truncated = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve({
          ok: true,
          matches,
          files: files.size,
          truncated,
          elapsedMs: Date.now() - started,
        });
      };
      const timer = setTimeout(() => finish("timeout"), CONTENT_SEARCH_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev?.type !== "match" || !ev?.data) continue;
          const path = String(ev.data.path?.text || "");
          const text = String(ev.data.lines?.text || "").replace(/\n$/, "").slice(0, CONTENT_LINE_TEXT_MAX);
          if (!path) continue;
          files.add(path);
          matches.push({
            path,
            line: Number(ev.data.line_number) || 0,
            col: Number(ev.data.submatches?.[0]?.start) || 0,
            text,
          });
          if (matches.length >= CONTENT_MAX_MATCHES || files.size >= CONTENT_MAX_FILES) {
            clearTimeout(timer);
            finish("cap");
            return;
          }
        }
      });
      child.stderr.on("data", (c: Buffer) => {
        stderrTail = (stderrTail + c.toString("utf8")).slice(-400);
      });
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === "ENOENT") resolve({ ok: false, error: "ripgrep 不可用（未安装 rg）", rgMissing: true });
        else resolve({ ok: false, error: "ripgrep 运行失败: " + String(e.message || e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== null && code !== 1 && matches.length === 0) {
          // rg exit codes: 0=hits, 1=no hits, 2=error — surface errors, treat 1 as empty
          resolve({ ok: false, error: "ripgrep 退出码 " + code + (stderrTail ? "：" + stderrTail.trim() : "") });
          return;
        }
        resolve({ ok: true, matches, files: files.size, truncated, elapsedMs: Date.now() - started });
      });
    });
  });
}

/** content-search route (route = last pathname segment); non-module routes return null for the main api. */
export async function contentSearchApi(req: Request, ctx: any, route: string): Promise<Response | null> {
  if (route !== "content-search") return null;
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: { "content-type": "application/json" } });
  const body = await req.json().catch(() => null);
  const q = typeof body?.q === "string" ? body.q.trim() : "";
  const root = typeof body?.root === "string" ? body.root : "";
  if (!q || q.length > 200) return new Response(JSON.stringify({ ok: false, error: "query 需 1..200 字符" }), { status: 400, headers: { "content-type": "application/json" } });
  if (!root || !isAbsolute(root)) return new Response(JSON.stringify({ ok: false, error: "需要绝对路径" }), { status: 400, headers: { "content-type": "application/json" } });
  const dir = normalize(root);
  try {
    if (!(await ctx?.core?.fileAccess?.isAllowed?.(dir))) return new Response(JSON.stringify({ ok: false, error: "目录不在可读范围" }), { status: 403, headers: { "content-type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "目录不在可读范围" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const result = await runContentSearch(dir, q);
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : (result.rgMissing ? 501 : 500),
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
