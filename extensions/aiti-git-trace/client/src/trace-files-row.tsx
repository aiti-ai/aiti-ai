/**
 * aiti-git-trace · assistantMessageFooter 变更文件行
 * （方案 docs/aiti-git-trace-message-files-ext-plan.md §3.3/§3.4）
 *
 * 宿主在 assistant 消息「改动的文件」chips 之后挂 assistantMessageFooter 插槽：
 * turn 最终回答渲染点 extra 带整轮 assistantEntryIds + 宿主推导的 writtenFiles
 * （write/edit 口径）；普通 assistant 消息渲染点只有自身 entryId（消息级兜底）。
 * 本组件把台账 ops 按这些 entryId 聚合、与 writtenFiles 求差集，只补 write/edit
 * 之外的变更文件（bash 等），避免与宿主「改动的文件」重复；差集为空整行不画。
 *
 * 数据面：与徽标共用 common.fetchOpsCached 单缓存（§11.3 性能审计合并，TTL 4s + ETag
 * 再校验）；挂载时拉取非轮询（严禁 setInterval）。live 轮次的最后几条 op 常在 TTL
 * 窗口内落账——refcount 共享一条 SSE /events（本扩展自有通道，panels.tsx 同款），
 * op 事件 → invalidateOpsCache 清缓存 + 800ms trailing 防抖通知挂载行重取（事件驱动，
 * 连接零挂载即断）。
 */
import { useState, useEffect, apiUrl, t } from "./host-shim";
import { bindSession, getSessionId, openPanel, chipStyle, EXT_API, fetchOpsCached, invalidateOpsCache } from "./common";
import { aggregateTraceTurnFiles, diffAgainstWritten } from "./trace-files-row.pure";

// ---------- 台账 op 事件 → 失效重取（refcount 共享 SSE；事件驱动非轮询） ----------

const MAX_CHIPS = 8;
const OP_DEBOUNCE_MS = 800; // panels.tsx 时间线同款：busy 轮 op 连爆不逐条重取

const opSubs = new Set<(sid: string) => void>();
let opEs: EventSource | null = null;
let opDebounce: ReturnType<typeof setTimeout> | null = null;

function subscribeOps(cb: (sid: string) => void): () => void {
  opSubs.add(cb);
  if (!opEs) {
    try {
      opEs = new EventSource(apiUrl(EXT_API + "/events"));
      opEs.addEventListener("op", (e: any) => {
        let sid = "";
        try { sid = String(JSON.parse(String(e?.data || "{}"))?.sessionId || ""); } catch { return; }
        if (!sid) return;
        invalidateOpsCache(sid);
        if (opDebounce) clearTimeout(opDebounce);
        opDebounce = setTimeout(() => {
          opDebounce = null;
          for (const fn of [...opSubs]) { try { fn(sid); } catch { /* noop */ } }
        }, OP_DEBOUNCE_MS);
      });
    } catch { opEs = null; /* EventSource 不可用：退化为挂载时取数，仅失实时化 */ }
  }
  return () => {
    opSubs.delete(cb);
    if (opSubs.size === 0) {
      if (opEs) { try { opEs.close(); } catch { /* ignore */ } opEs = null; }
      if (opDebounce) { clearTimeout(opDebounce); opDebounce = null; }
    }
  };
}

export function TraceFilesRow(props?: any): any {
  bindSession(props);
  // turn 粒度优先（assistantEntryIds）；缺省降级消息粒度（自身 entryId，§3.4 兜底）
  const ids: string[] = Array.isArray(props?.assistantEntryIds) && props.assistantEntryIds.length
    ? props.assistantEntryIds.map(String).filter(Boolean)
    : props?.entryId ? [String(props.entryId)] : [];
  const writtenFiles: string[] = Array.isArray(props?.writtenFiles)
    ? props.writtenFiles.map(String).filter(Boolean)
    : [];
  const sessionId = String(props?.sessionId || "") || getSessionId();
  const idKey = ids.join("|");
  const [ops, setOps] = useState<any[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!idKey || !sessionId) return;
    let dead = false;
    const refetch = () => { fetchOpsCached(sessionId).then((list) => { if (!dead) setOps(list); }); };
    refetch();
    const dispose = subscribeOps((sid) => { if (sid === sessionId) refetch(); });
    return () => { dead = true; dispose(); };
  }, [idKey, sessionId]);
  if (!idKey || ops === null) return null;
  const info = aggregateTraceTurnFiles(ops, ids);
  if (!info) return null;
  const extra = diffAgainstWritten(info.absPaths, writtenFiles);
  if (extra.length === 0) return null;
  const shown = expanded ? extra : extra.slice(0, MAX_CHIPS);
  const hidden = extra.length - shown.length;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", marginTop: -2 }}>
      <span aria-hidden title={t("gt.footer.title", { n: info.ops })}
        style={{ fontSize: 11, color: "var(--text-dim)", cursor: "default" }}>⎇</span>
      {shown.map((p: string) => (
        <button key={p}
          style={{ ...chipStyle, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={p}
          onClick={() => openPanel("timeline", { sessionId, view: "file", file: p })}>
          {p.split("/").pop() || p}
        </button>
      ))}
      {hidden > 0 && (
        <button style={chipStyle} title={t("gt.footer.title", { n: info.ops })}
          onClick={() => setExpanded(true)}>{t("gt.footer.more", { n: hidden })}</button>
      )}
      {expanded && extra.length > MAX_CHIPS && (
        <button style={chipStyle} onClick={() => setExpanded(false)}>{t("gt.footer.collapse")}</button>
      )}
      {info.truncated && (
        <span title={t("gt.footer.truncated")} aria-label={t("gt.footer.truncated")}
          style={{ fontSize: 11, color: "var(--text-dim)", cursor: "default" }}>…</span>
      )}
    </div>
  );
}
