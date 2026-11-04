/**
 * /sessions 列表 v2 传输编码（aiti-web-sessions-payload-plan §9.4 字段瘦身）。
 *
 * 纯函数、零依赖：服务端 encode / 客户端 decode 共用同一映射约定（两端各持一份
 * 副本——本扩展 client 是独立 vite 产物，不与 server 同包）。rev/ETag 指纹基于
 * 标准行计算（编码只发生在响应出口），v1/v2 的 rev 语义完全一致。
 *
 * wire 形态（fmt=2）：
 *   { rev, fmt: 2, cwds: ["<唯一 cwd/projectRoot 字符串>", ...], sessions: [紧凑行...], archived?: [紧凑行...] }
 *   patch 形态：{ rev, fmt: 2, cwds, patch: { up: [紧凑行...], rm: [id...] } }
 *
 * archived 独立数组（服务端拆分返回，2026-09-07）：sessions=纯 live+外部行，
 * 归档行进 archived；两桶共享同一 cwds 枚举表（encodeSessionsV2 第二参数）。
 * patch.up 行自描述（行带 archived 位），客户端按位分拣到对应桶。
 *
 * 紧凑行映射（相对标准行）：
 *   cwd         → c  = cwds 索引（cwd 与 projectRoot 共用一张枚举表，61/57 唯一值高度重合）
 *   projectRoot → r  = cwds 索引
 *   projectKey  → k  = cwds 索引（win32 语义小写形态，与 projectRoot 高度重合；2026-09-08 加）
 *   created     → ct = epoch ms（客户端还原 ISO；SessionInfo 契约不变）
 *   modified    → mt = epoch ms
 *   其余字段（id/name/firstMessage/lastMessage/messageCount/parentSessionId/agent/
 *   lastRole/model/archived/extId/planFirst/planRel）原样保留。
 *
 * 实测（1747 行）：801KB → ~640KB wire（-20%）；无 fmt=2 的请求走旧形态零改动。
 */

export interface CompactResult {
  fmt: 2;
  cwds: string[];
  sessions: Record<string, unknown>[];
  /** 归档行独立数组（第二参数传入时才带；共享同一 cwds 枚举表）。 */
  archived?: Record<string, unknown>[];
}

const enumOf = (table: string[], idx: Map<string, number>, v: unknown): number | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  let i = idx.get(v);
  if (i === undefined) {
    i = table.length;
    table.push(v);
    idx.set(v, i);
  }
  return i;
};

const epochOf = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  // 无损约束：仅当 ms → ISO 回写与原串完全一致才编码（真实数据偶见微秒精度
  // ISO，如 .043205Z——ms 截去微秒会破坏 round-trip 恒等，此时保留原串）。
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== v) return undefined;
  return ms;
};

/** 服务端：标准行数组 → v2 紧凑形态。archivedRows 传入时拆分返回（共享 cwds 表）。 */
export function encodeSessionsV2(rows: Record<string, unknown>[], archivedRows?: Record<string, unknown>[]): CompactResult {
  const cwds: string[] = [];
  const idx = new Map<string, number>();
  const encRow = (r: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...r };
    const c = enumOf(cwds, idx, r.cwd);
    if (c !== undefined) { out.c = c; delete out.cwd; }
    const rt = enumOf(cwds, idx, r.projectRoot);
    if (rt !== undefined) { out.r = rt; delete out.projectRoot; }
    const kt = enumOf(cwds, idx, r.projectKey);
    if (kt !== undefined) { out.k = kt; delete out.projectKey; }
    const ct = epochOf(r.created);
    if (ct !== undefined) { out.ct = ct; delete out.created; }
    const mt = epochOf(r.modified);
    if (mt !== undefined) { out.mt = mt; delete out.modified; }
    return out;
  };
  const result: CompactResult = { fmt: 2, cwds, sessions: rows.map(encRow) };
  if (archivedRows) result.archived = archivedRows.map(encRow);
  return result;
}

/** 客户端：v2 行 → 标准行（还原 cwd/projectRoot 字符串与 ISO 时间戳）。 */
export function decodeRowV2(row: Record<string, unknown>, cwds: string[]): Record<string, unknown> {
  const out = { ...row };
  if (typeof out.c === "number") {
    const v = cwds[out.c];
    if (typeof v === "string") out.cwd = v;
    delete out.c;
  }
  if (typeof out.r === "number") {
    const v = cwds[out.r];
    if (typeof v === "string") out.projectRoot = v;
    delete out.r;
  }
  if (typeof out.k === "number") {
    const v = cwds[out.k];
    if (typeof v === "string") out.projectKey = v;
    delete out.k;
  }
  if (typeof out.ct === "number") {
    out.created = new Date(out.ct).toISOString();
    delete out.ct;
  }
  if (typeof out.mt === "number") {
    out.modified = new Date(out.mt).toISOString();
    delete out.mt;
  }
  return out;
}

/**
 * 客户端：响应 body → 标准行数组（v2 解码；v1/旧形态原样返回）。
 * 服务端返回的 patch.up 行与全量行同构，同样经此处还原。
 */
export function decodeSessionsPayload(body: unknown): Record<string, unknown>[] | undefined {
  const d = body as { fmt?: number; cwds?: unknown; sessions?: unknown } | null;
  if (!d || d.fmt !== 2 || !Array.isArray(d.cwds)) return (d?.sessions ?? undefined) as Record<string, unknown>[] | undefined;
  const cwds = d.cwds as string[];
  return (Array.isArray(d.sessions) ? d.sessions : []).map((r) => decodeRowV2(r as Record<string, unknown>, cwds));
}

/**
 * 客户端：归档行独立数组解码（服务端 /sessions 拆分返回；与 sessions 共享 cwds 表）。
 * 无 archived 字段（旧服务端/patch 响应）→ undefined，调用方 keep last。
 */
export function decodeArchivedPayload(body: unknown): Record<string, unknown>[] | undefined {
  const d = body as { fmt?: number; cwds?: unknown; archived?: unknown } | null;
  if (!d || !Array.isArray(d.archived)) return undefined;
  if (d.fmt !== 2 || !Array.isArray(d.cwds)) return d.archived as Record<string, unknown>[];
  const cwds = d.cwds as string[];
  return (d.archived as Record<string, unknown>[]).map((r) => decodeRowV2(r, cwds));
}
