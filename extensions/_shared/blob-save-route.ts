/**
 * blob-save-route —— 二进制文件保存 route 工厂（共享权威源，部署时拷进扩展目录）。
 *
 * 消费方：aiti-sheet-univer / aiti-word-superdoc 等带 edit 能力的实现扩展
 * （docs/aiti-editor-office-plan.md §2.0 共享层）。
 *
 * 端点语义（POST，body JSON）：
 *   { filePath: string, dataBase64: string, baseMtimeMs?: number, cwd?: string }
 *   → 200 { ok: true, mtimeMs, size }
 *   → 400 路径不在白名单 / 扩展名不在白名单 / dataBase64 非法
 *   → 409 { ok:false, conflict:true, diskMtimeMs } 磁盘已被外部修改（乐观锁）
 *   → 413 超过 maxBytes
 * 写盘原子（tmp + rename），目标目录自动创建（同名文件保存必然已存在，目录防御性兜底）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

/** ~ 展开（浏览器无 homedir；对齐 core /api/files filePathFromSegments） */
function expandTildePath(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** 保存白名单（对标 aiti-editor M1 宽松版：workspace + 用户根） */
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
  /** 扩展 id（tmp 文件命名/日志前缀） */
  extId: string;
  /** 允许保存的扩展名白名单（小写含点，如 [".xlsx", ".xlsm"]） */
  allowedExts: string[];
  /** 单文件字节上限（默认 30MB，方案 §2.1 maxBytes feature 档） */
  maxBytes?: number;
}

export interface BlobSaveBody {
  filePath?: unknown;
  dataBase64?: unknown;
  baseMtimeMs?: unknown;
  cwd?: unknown;
}

/**
 * 生成 route handler：`if (p[p.length-1] === "save-blob") return await handle(req);`
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
      return json({ ok: false, error: "body 需为 JSON" }, 400);
    }
    const filePath = typeof body.filePath === "string" ? body.filePath : "";
    const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    if (!filePath || !dataBase64) return json({ ok: false, error: "需要 filePath 与 dataBase64" }, 400);

    const lower = filePath.toLowerCase();
    if (![...allowed].some((ext) => lower.endsWith(ext))) {
      return json({ ok: false, error: "扩展名不在白名单内（" + [...allowed].join(" ") + "）" }, 400);
    }
    const target = resolveAllowedWriteRoot(filePath, cwd);
    if (!target) return json({ ok: false, error: "路径不在可写白名单内" }, 400);

    let buf: Buffer;
    try {
      buf = Buffer.from(dataBase64, "base64");
    } catch {
      return json({ ok: false, error: "dataBase64 非法" }, 400);
    }
    if (buf.length === 0) return json({ ok: false, error: "空内容拒绝保存" }, 400);
    if (buf.length > maxBytes) return json({ ok: false, error: "文件超过 " + Math.round(maxBytes / 1024 / 1024) + "MB 上限" }, 413);

    // 乐观锁：baseMtimeMs 与磁盘不一致 → 409（沿用 aiti-editor 冲突 UI 范式）
    let st;
    try { st = statSync(target); } catch { /* 新文件（理论上保存目标必已存在；防御） */ }
    if (st) {
      if (!st.isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
      if (typeof body.baseMtimeMs === "number" && Math.abs(st.mtimeMs - (body.baseMtimeMs as number)) > 1) {
        return json({ ok: false, conflict: true, diskMtimeMs: st.mtimeMs }, 409);
      }
    }

    // 原子写：tmp 必须与目标同目录（同文件系统，rename 才不跨设备 EXDEV）
    const tmp = join(dirname(target), "." + opts.extId + "-save-tmp-" + process.pid + "-" + Date.now());
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(tmp, buf);
      renameSync(tmp, target);
    } catch (e) {
      try { require("node:fs").rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
      log("写盘失败: " + String((e as Error).message || e));
      return json({ ok: false, error: "写盘失败: " + String((e as Error).message || e) }, 500);
    }
    const after = statSync(target);
    log("已保存 " + target + " (" + after.size + " bytes)");
    return json({ ok: true, mtimeMs: after.mtimeMs, size: after.size });
  };
}

/** 内容哈希（调试/日志用） */
export function blobHash(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex").slice(0, 8);
}
