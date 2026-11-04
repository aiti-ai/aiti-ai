/**
 * archive-artifact —— A03 P1：文件/目录 artifact 粒度的真归档原语（共享实现）。
 *
 * 适用：ref.path 直接指向源 artifact（单文件或整目录）的 adapter——快照读原样字节、
 * remove rm 掉、putBack 原样写回（目录按 per-file base64 容器逐文件还原，字节级保真）。
 * 数据流与管线（server/runtime.ts runExtArchive/restoreExtArchive）约定见
 * docs/todo-session-manager-ext-archive-delete.md §2/§3。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentAdapter, ExtSessionRef } from "./types.ts";

const DIR_PACK_MAGIC = '{"v":1,"kind":"dir",';

/** 目录 → 单 buffer 容器（per-file base64 + 相对路径；还原即原样字节）。 */
function packDir(dir: string): Buffer {
  const files: Array<{ rel: string; b64: string }> = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push({ rel: relativePosix(dir, p), b64: readFileSync(p).toString("base64") });
    }
  };
  walk(dir);
  return Buffer.from(JSON.stringify({ v: 1, kind: "dir", files }));
}

function relativePosix(from: string, to: string): string {
  const rel = to.slice(from.length).replace(/^[/\\]/, "");
  return rel.replace(/\\/g, "/");
}

function isDirPack(bytes: Buffer): boolean {
  return bytes.subarray(0, DIR_PACK_MAGIC.length).toString("utf8") === DIR_PACK_MAGIC;
}

function unpackDir(bytes: Buffer, dir: string): void {
  const parsed = JSON.parse(bytes.toString("utf8")) as { kind?: string; files?: Array<{ rel: string; b64: string }> };
  if (parsed?.kind !== "dir" || !Array.isArray(parsed.files)) throw new Error("unexpected dir snapshot payload");
  for (const f of parsed.files) {
    const p = join(dir, f.rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.from(f.b64, "base64"));
  }
}

/** artifact 粒度三原语：targetOf 缺省 = ref.path（绝大多数文件型 adapter 的约定）。 */
export function artifactPrimitives(targetOf: (ref: ExtSessionRef) => string | null = (ref) => ref.path): Pick<
  AgentAdapter, "snapshot" | "removeSession" | "putBack"
> {
  return {
    snapshot(ref) {
      const t = targetOf(ref);
      if (!t || !existsSync(t)) return null;
      const st = statSync(t);
      const bytes = st.isDirectory() ? packDir(t) : readFileSync(t);
      return { bytes, layout: t };
    },
    removeSession(ref) {
      const t = targetOf(ref);
      if (!t || !existsSync(t)) return; // 幂等：不存在=成功
      rmSync(t, { recursive: true, force: true });
    },
    putBack(_sid, snap) {
      if (isDirPack(snap.bytes)) {
        mkdirSync(snap.layout, { recursive: true });
        unpackDir(snap.bytes, snap.layout);
        return;
      }
      mkdirSync(dirname(snap.layout), { recursive: true });
      writeFileSync(snap.layout, snap.bytes);
    },
  };
}

/** artifact 粒度能力自述。 */
export function artifactCapabilities(): AgentAdapter["capabilities"] {
  return { remove: true, putBack: true, granularity: "artifact" };
}
