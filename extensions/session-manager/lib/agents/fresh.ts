/**
 * session-manager — 共享 listFresh 实现（运行中 ext 会话的列表层时间戳通道）。
 *
 * 文件型 adapter（每会话一个 jsonl/json 文件）的通用实现：stat 每个会话文件取
 * mtime —— 与 pi 会话的列表层（pi-web lib/session-reader 的 statSync/lastActivity）
 * 同构。写消息必 touch 文件 → 文件 mtime ≥ 最后消息时间戳，配合
 * refreshExtTimestamps 的「仅新值才写」语义安全；文件被 touch 而无新消息时
 * mtime 略新，与 pi 的 mtime 兜底语义一致（活动即时间）。
 *
 * db 型 adapter（zcode/cursor-ide/trae/zed…）不适用本 helper：refs 的 path 是
 * copy db 虚拟路径（file#session:sid），stat 到的是全库共享 mtime，无单会话语义
 * —— 须各自直读源 db 的 session 表（参照 zcode.ts 的 listFresh 实现）。
 */
import { statSync } from "node:fs";
import type { ExtFreshMeta, ExtSessionRef } from "./types.ts";

export function statFreshList(refs: ExtSessionRef[]): ExtFreshMeta[] {
  const out: ExtFreshMeta[] = [];
  for (const ref of refs) {
    if (ref.path.includes("#")) continue; // db copy 虚拟路径：无单会话文件语义（db 型源自实现）
    try {
      // statSync 自带 ENOENT → catch：无需 existsSync+statSync 双 syscall
      out.push({ sid: ref.sid, timeUpdatedMs: statSync(ref.path).mtimeMs });
    } catch { /* raced/不存在：下轮再取 */ }
  }
  return out;
}
