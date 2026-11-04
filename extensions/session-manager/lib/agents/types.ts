/**
 * session-manager — multi-agent adapter contracts (M1).
 *
 * An AgentAdapter normalizes one external coding-agent's session storage into
 * the extension's internal shapes (SessionFileMeta + IndexedMessage, aligned
 * with lib/session-file.ts). Built-in adapters live beside this file; third
 * parties register their own via the standard slot mechanism (§4.8 of the
 * plan: EXT_PROVIDES "session-agent-source" + HTTP contract — see docs).
 *
 * Lifecycle rule (§4.7): adapters are only PROBED by default (stat-level,
 * milliseconds); nothing is indexed until the user activates the source.
 */

/** A discovered-but-unparsed session reference. */
export interface ExtSessionRef {
  /** Native session id inside the source agent (uuid-ish). */
  sid: string;
  /** Storage artifact this session lives in (file path; DB-backed agents use virtual paths). */
  path: string;
  /**
   * 源侧会话版本（如 zcode/opencode 的 session.time_updated ms）。带 rev 的 ref
   * 走 per-session 版本水位：syncExt 比对 files.mtime_ms === rev，不再 statSync
   * 物理文件——db 型源的物理文件每次同步都在变（写入/WAL），按文件 stat 恒判变 →
   * 全量重解析（2026-09-12 拷贝风暴事故根因之一）。不带 rev 的 ref 维持 stat 水位。
   */
  rev?: number;
}

/** Cheap discovery probe — MUST NOT parse contents. */
export interface ExtSourceProbe {
  /** false when none of the roots exist (source not installed). */
  ok: boolean;
  /** Rough session-artifact count (files / db rows estimate). */
  count: number;
  /** Max artifact mtime in ms — the staleness watermark. */
  watermarkMs: number;
}

/**
 * Provider-side agent descriptor from a third-party extension's manifest
 * (§4.8 slot contract).
 */
export interface AgentSourceDescriptor {
  id: string;
  label: string;
  dependencyHint?: string;
}

/**
 * 轻量「新鲜度」快照：不 parse 消息，只报一个会话的最新时间戳/标题。
 * 供运行中 ext 会话的时间戳刷新通道（listFresh）用——运行中源永不静置
 * → 全量 sync 被 2min 静置门控饿死 → 时间戳走这条零成本通道单独前进。
 */
export interface ExtFreshMeta {
  sid: string;
  /** 源侧权威 modified（epoch ms）；缺省/非法则调用方跳过该行。 */
  timeUpdatedMs?: number;
  title?: string;
}

/**
 * AgentAdapter: methods MAY return promises (third-party proxy adapters call
 * their providing extension in-process; built-ins stay synchronous).
 */
export interface AgentAdapter {
  /** Stable short id, used as prefix in composite ids ("claude:<sid>"). */
  readonly id: string;
  readonly label: string;
  /** Why activation might fail before it starts (e.g. missing sqlcipher binary). */
  dependencyHint?: string;
  roots(): string[];
  probe(): ExtSourceProbe | Promise<ExtSourceProbe>;
  list(): ExtSessionRef[] | Promise<ExtSessionRef[]>;
  /** Full parse of one session into the normalized shape. */
  parse(ref: ExtSessionRef): ParsedExtSession | null | Promise<ParsedExtSession | null>;
  /**
   * 可选 · 轻量新鲜度快照（标题 + modified 时间戳，零 message parse）。
   * 实现必须 cheap（读单表/少量 stat），不复制大文件、不读 messages——
   * 否则运行中源的高频刷新会放大复制成本。缺省 = 不支持该通道。
   */
  listFresh?(): ExtFreshMeta[] | Promise<ExtFreshMeta[]>;

  // ── A03 真归档原语（docs/todo-session-manager-ext-archive-delete.md §2；全部可选，缺省=纯只读零破坏）──

  /** 能力自述：remove/putBack 已实现 + 删除粒度。缺省（未声明）= 纯只读。 */
  capabilities?: {
    /** removeSession 已实现（从源存储删除）。 */
    remove?: boolean;
    /** putBack 已实现（快照写回源存储，remove 的逆）。 */
    putBack?: boolean;
    /** 删除粒度：artifact=整文件/目录移动级 | rows=库内行级 | api=远端调用 */
    granularity?: "artifact" | "rows" | "api";
  };
  /** 快照：源 artifact 原始字节（字节级保真是恢复可靠性的根基，禁 normalized 形状）。
   *  layout = 写回目标定位串（原始存储路径/定位），由 putBack 消费。null = 不可读。 */
  snapshot?(ref: ExtSessionRef): { bytes: Buffer; layout: string } | null | Promise<{ bytes: Buffer; layout: string } | null>;
  /** 从源存储删除一个会话。幂等（不存在=成功）；抛错=失败（管线保留源数据）。 */
  removeSession?(ref: ExtSessionRef): void | Promise<void>;
  /** 快照原样写回源存储；恢复后 agent 自身必须能 resume。 */
  putBack?(sid: string, snap: { bytes: Buffer; layout: string }): void | Promise<void>;
}

import type { ParsedSessionFile } from "../session-file.ts";
export type ParsedExtSession = ParsedSessionFile;
export type ParsedExtSessionLike = ParsedSessionFile;

/** Composite id used everywhere downstream (index/tags/favorites). */
export function extId(agent: string, sid: string): string {
  return `${agent}:${sid}`;
}

export function splitExtId(id: string): { agent: string; sid: string } {
  const i = id.indexOf(":");
  if (i <= 0) return { agent: "pi", sid: id };
  return { agent: id.slice(0, i), sid: id.slice(i + 1) };
}
