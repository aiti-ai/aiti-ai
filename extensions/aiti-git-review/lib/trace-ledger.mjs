/**
 * aiti-git-review · trace 台账解析（纯函数，index.ts 与单测共用）。
 *
 * 输入：aiti-git-trace 的操作台账（<configDir>/cache/aiti-git-trace/ops/<sessionId>.jsonl，
 * schema 见 docs/aiti-git-trace-plan.md §3.6——每行一个 op，stores[] 一项一个仓）。
 * 输出：「消息 → 操作」两级分组（trace 任务的修订选择器数据源，选两节点 = base/target）。
 */

/** 解析台账文本（JSON Lines；坏行跳过，op 无效跳过） */
export function parseLedger(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (!o || typeof o.op !== "number" || !Array.isArray(o.stores)) continue;
    out.push(o);
  }
  return out;
}

/** 取 op 在指定仓的条目（root 精确匹配优先，缺省第一条）；无 → null */
export function pickStoreEntry(op, storeRoot) {
  const stores = Array.isArray(op.stores) ? op.stores : [];
  if (stores.length === 0) return null;
  if (storeRoot) {
    const hit = stores.find((s) => s && s.root === storeRoot);
    if (hit) return hit;
  }
  return stores[0];
}

function entryFilesCount(entry) {
  const f = (entry && entry.files) || {};
  let n = 0;
  for (const k of Object.keys(f)) { if (k !== "skipped") n += f[k] | 0; }
  return n;
}

function short(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * 分组：按 msgSeq 聚成消息组（组内按 op 升序），每组：
 *   { msgSeq, label, ops: [{ op, tool, summary, t1, before, after, filesCount, root, partial }] }
 * storeRoot 缺省时取每 op 的第一条 store（主 store 恒在首）。
 */
export function groupRevisions(ops, storeRoot) {
  const byMsg = new Map();
  for (const op of ops) {
    const entry = pickStoreEntry(op, storeRoot);
    if (!entry) continue;
    const msgSeq = typeof op.msgSeq === "number" ? op.msgSeq : 0;
    if (!byMsg.has(msgSeq)) byMsg.set(msgSeq, { msgSeq, ops: [] });
    byMsg.get(msgSeq).ops.push({
      op: op.op,
      tool: String(op.tool || "?"),
      summary: short(op.summary, 60),
      t1: op.t1 || 0,
      before: entry.before || null,
      after: entry.after || null,
      filesCount: entryFilesCount(entry),
      root: entry.root || "",
      partial: !!entry.partial,
    });
  }
  const messages = [...byMsg.values()].map((m) => {
    m.ops.sort((a, b) => a.op - b.op);
    m.label = "#" + m.msgSeq + " " + short(m.ops[0] && m.ops[0].summary, 40) + "（" + m.ops.length + " ops）";
    return m;
  });
  messages.sort((a, b) => a.msgSeq - b.msgSeq);
  return messages;
}
