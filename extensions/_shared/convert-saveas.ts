/**
 * convert-saveas —— 老格式「转可编辑格式另存并打开」route 工厂（共享权威源，部署拷进扩展目录）。
 *
 * 场景（方案 §八 追加）：.xls/.ods → .xlsx（Excel 编辑）、.doc → .docx（Word 编辑）。
 * 规则：
 *   - soffice 无头转换；tmp 目录放在目标同目录（同文件系统，rename 不跨设备）
 *   - 新文件与源同目录，命名 `<stem>-from<ext>.<toExt>`（如 报告-fromxls.xlsx）；
 *     已存在则 `<stem>-from<ext>(1).<toExt>` 递增——绝不覆盖任何既有文件
 *   - 源文件不动；单 soffice 实例互斥（globalThis 级，跨扩展模块共享进程内互斥）
 *
 * 端点语义（POST，body JSON）：{ filePath: string, cwd?: string }
 *   → 200 { ok: true, newPath, size }
 *   → 400 路径不在白名单 / 源扩展不支持
 *   → 409 目标并发竞争（罕见，客户端重试即可）
 *   → 500 soffice 转换失败
 */
import { mkdirSync, renameSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

/** 异步 execFile（Promise 化）。性能红线（2026-09-13）：原 execFileSync 同步跑 soffice
 *  转换（timeout 90s）会把 pi-web 主线程冻结至秒/分钟级；改异步后语义不变、主线程不占用。 */
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

/** 写白名单（对标 aiti-editor/blob-save-route M1 宽松版：workspace + 用户根） */
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
  /** 目标扩展名（不含点，如 "xlsx"） */
  toExt: string;
  /** soffice --convert-to 过滤器（如 `xlsx:Calc MS Excel 2007 XML`；缺省用 toExt） */
  filter?: string;
}

export interface ConvertSaveAsOptions {
  extId: string;
  /** fromExt（不含点）→ 转换目标 */
  conversions: Record<string, ConvertTarget>;
  /** 源文件大小上限（默认 50MB） */
  maxBytes?: number;
  /** soffice 定位器（_shared/soffice-locate 的 makeSofficeLocator）；缺失 → 503 soffice-missing */
  sofficePath: () => string | null;
}

/**
 * 候选路径生成（纯函数，可测）：<stem>-from<ext>.<toExt>，冲突递增 (n)。
 * @param exists 路径存在性探测（注入以便测试）
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
 * 生成 route handler：`if (p[p.length-1] === "convert-saveas") return await handle(req);`
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
      return json({ ok: false, error: "body 需为 JSON" }, 400);
    }
    const filePath = typeof body.filePath === "string" ? body.filePath : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    if (!filePath) return json({ ok: false, error: "需要 filePath" }, 400);

    const ext = (filePath.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    const conv = opts.conversions[ext];
    if (!conv) {
      return json({ ok: false, error: "源扩展不支持（支持: " + Object.keys(opts.conversions).map((k) => "." + k).join(" ") + "）" }, 400);
    }
    const target = resolveAllowedWriteRoot(filePath, cwd);
    if (!target) return json({ ok: false, error: "路径不在可写白名单内" }, 400);
    let st;
    try {
      st = statSync(target);
    } catch {
      return json({ ok: false, error: "源文件不存在" }, 400);
    }
    if (!st.isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
    if (st.size > maxBytes) return json({ ok: false, error: "文件超过 " + Math.round(maxBytes / 1024 / 1024) + "MB 上限" }, 413);

    // 候选名（转换前定一次；rename 前再校验一次防并发竞争）
    const dir = dirname(target);
    const sourceName = basename(target);
    let finalPath = nextSaveAsPath(dir, sourceName, ext, conv.toExt, (p) => { try { statSync(p); return true; } catch { return false; } });

    const soffice = opts.sofficePath();
    if (!soffice) {
      return json({
        ok: false,
        code: "soffice-missing",
        error: "未找到 LibreOffice (soffice)：老格式转换需要它。可安装 LibreOffice，或在 aiti-editor 功能配置 soffice.path",
      }, 503);
    }
    if (mutex()) return json({ ok: false, error: "上一个转换还在进行，请稍后重试" }, 409);
    const g = globalThis as any;
    g.__aitiConvertBusy = 1;
    const tmpOut = join(dir, "." + opts.extId + "-conv-" + process.pid + "-" + Date.now());
    try {
      mkdirSync(tmpOut, { recursive: true });
      const filter = conv.filter || conv.toExt;
      await execFileP(soffice, ["--headless", "--convert-to", filter, "--outdir", tmpOut, target], 90_000);
      const producedName = sourceName.replace(/\.[^.]+$/, "") + "." + conv.toExt;
      const produced = join(tmpOut, producedName);
      const ps = statSync(produced); // 不存在会 throw → 落入 catch
      if (ps.size === 0) throw new Error("转换产物为空");
      // rename 前最终防覆盖（转换期间目标可能被并发创建）
      finalPath = nextSaveAsPath(dir, sourceName, ext, conv.toExt, (p) => { try { statSync(p); return true; } catch { return false; } });
      renameSync(produced, finalPath);
      const size = statSync(finalPath).size;
      log(sourceName + " → " + basename(finalPath) + " (" + size + " bytes)");
      return json({ ok: true, newPath: finalPath, size });
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes("ENOENT") && msg.includes(producedNameHint(sourceName, conv.toExt))) {
        return json({ ok: false, error: "soffice 未产出转换结果（源文件可能损坏或格式不支持）" }, 500);
      }
      log("转换失败: " + msg.slice(0, 200));
      return json({ ok: false, error: "转换失败: " + msg.slice(0, 200) }, 500);
    } finally {
      try { require("node:fs").rmSync(tmpOut, { recursive: true, force: true }); } catch { /* 忽略 */ }
      g.__aitiConvertBusy = 0;
    }
  };
}

function producedNameHint(sourceName: string, toExt: string): string {
  return sourceName.replace(/\.[^.]+$/, "") + "." + toExt;
}
