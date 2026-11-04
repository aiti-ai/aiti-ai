/**
 * sidebar/session-search —— 会话全文搜索面板（宿主 components/SessionSearch.tsx 完整复制）。
 * open && 有 query 时替换 children 渲染搜索结果；否则原样渲染 children（会话列表）。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiUrl, t, getLocale } from "../host-shim";
import { formatRelativeTime, type SessionInfo } from "./pure";
import { agentBadge } from "../helpers";

interface SessionSearchResponse {
  results: Array<{
    session: SessionInfo;
    entryId?: string;
    blockIndex?: number;
    before: string;
    match: string;
    after: string;
  }>;
  truncated?: boolean;
}

/** sm 自有 FTS 端点（/api/extensions/session-manager/search）的命中形状——覆盖外部 agent 会话。 */
interface SmSearchHit {
  sessionId: string;
  title: string;
  cwd: string;
  modified: string;
  archived: boolean;
  text: string;
  role: string;
}

/** 文档条件（todo-sm-sidebar-search-doc-condition §3/§4-P1）：勾选文档 → 结果=触达该文档的会话 */
export interface DockDocCondition { docId: number; title: string; relpath: string }

export function SessionSearchDock({ open, query, refreshKey, children, selectedSessionId, onSelectSession, extraFilter, resolveExternal, docCondition, sessionById }: {
  open: boolean;
  query: string;
  refreshKey: number | null;
  children: ReactNode;
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  /** 高级模式过滤谓词（agent/tag 客户端过滤）；null/省略 = 不过滤。 */
  extraFilter?: ((s: SessionInfo) => boolean) | null;
  /** sm FTS 外部命中 → 会话对象回联（store.sessions byId；返回 null = 跳过该行）。
   *  宿主 /api/sessions/search 只索引 pi 会话且结果无 agent 字段，agent 过滤要真实
   *  生效必须并入 sm 自有索引（含外部源 composite id 行）。 */
  resolveExternal?: (hit: SmSearchHit) => SessionInfo | null;
  /** 文档条件（P1 关联视图）：设置时结果改为「触达该文档的会话」——无文本也生效，
   *  文本匹配文档内容属 P2（当前文本条件在文档模式下不参与）。 */
  docCondition?: DockDocCondition | null;
  /** 文档触达 sid → 会话对象回联（store.sessions byId；null = 跳过该行） */
  sessionById?: (sid: string) => SessionInfo | null;
}) {
  const locale = getLocale();
  const [state, setState] = useState<{ query: string; response?: SessionSearchResponse; failed?: boolean }>({ query: "" });
  const search = query.trim();
  const response = state.query === search ? state.response : undefined;
  const failed = state.query === search && state.failed;

  useEffect(() => {
    if (!open || !search) return;
    const controller = new AbortController();
    setState({ query: search });
    const timer = setTimeout(async () => {
      // 双源并行：宿主全片搜索（pi 会话，带 entryId/blockIndex 精准跳转）+ sm 自有
      // FTS（外部 agent 会话，仅 extraFilter 即高级模式生效时并入）。外部命中按 id
      // 回联 store.sessions 得完整会话对象（含 agent），host 结果去重优先。
      const jobs: Array<Promise<SessionSearchResponse["results"]>> = [
        (async () => {
          const res = await fetch(apiUrl(`/api/sessions/search?${new URLSearchParams({ q: search })}`), { signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json() as SessionSearchResponse).results;
        })(),
      ];
      if (extraFilter) {
        jobs.push((async () => {
          const res = await fetch(apiUrl(`/api/extensions/session-manager/search?${new URLSearchParams({ q: search })}`), { signal: controller.signal });
          if (!res.ok) return [];
          const d = await res.json() as { hits?: SmSearchHit[] };
          return (d.hits ?? []).map((hit) => {
            const session = resolveExternal?.(hit) ?? null;
            return session ? { session, before: hit.text || "", match: "", after: "" } : null;
          }).filter((x): x is NonNullable<typeof x> => x !== null);
        })().catch(() => []));
      }
      try {
        const [host = [], ext = []] = await Promise.all(jobs);
        const seen = new Set<string>();
        const merged = [...host, ...ext].filter((r) => !seen.has(r.session.id) && seen.add(r.session.id));
        if (!controller.signal.aborted) setState({ query: search, response: { results: merged } });
      } catch {
        if (!controller.signal.aborted) setState({ query: search, failed: true });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, search, refreshKey, extraFilter, resolveExternal]);

  // ── 文档条件（P1 关联视图）：勾选文档后结果=doc_sessions 反查，替换常规搜索列表 ──
  const [docState, setDocState] = useState<{ docId: number; sessions: Array<{ sessionId: string; opCount: number }> | null; available?: boolean; failed?: boolean; matched?: boolean; snippet?: string } | null>(null);
  const docId = docCondition?.docId ?? 0;
  useEffect(() => {
    if (!open || !docId) {
      setDocState(null);
      return;
    }
    const controller = new AbortController();
    setDocState({ docId, sessions: null });
    (async () => {
      try {
        // A02 P2：q 非空 = 文本条件改道文档检索（命中文档才出会话；不回退会话全文搜索）
        const qp = search ? "&q=" + encodeURIComponent(search) : "";
        const res = await fetch(apiUrl(`/api/extensions/session-manager/doc-sessions?docId=${docId}${qp}`), { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json() as { available?: boolean; sessions?: Array<{ sessionId: string; opCount: number }>; matched?: boolean; snippet?: string };
        if (!controller.signal.aborted) setDocState({ docId, sessions: d.sessions ?? [], available: d.available !== false, matched: d.matched, snippet: d.snippet });
      } catch {
        if (!controller.signal.aborted) setDocState({ docId, sessions: [], failed: true });
      }
    })();
    return () => controller.abort();
  }, [open, docId, refreshKey, search]);
  const docRows = useMemo(() => {
    if (!docCondition || docState?.docId !== docCondition.docId || !docState.sessions) return null;
    return docState.sessions
      .map((s) => ({ ...s, session: sessionById?.(s.sessionId) ?? null }))
      .filter((r): r is typeof r & { session: SessionInfo } => !!r.session && (!extraFilter || extraFilter(r.session)));
  }, [docCondition, docState, sessionById, extraFilter]);

  const shown = (response?.results ?? []).filter((r) => !extraFilter || extraFilter(r.session));
  if (open && docCondition) {
    return (
      <div className="min-h-20 flex-1 overflow-y-auto" aria-busy={docState?.sessions == null}>
        <div role="status" className="px-3 py-2 text-xs text-text-muted">
          {failed || docState?.failed ? t("sidebar.sessionSearchFailed")
            : !docState?.sessions ? t("sidebar.sessionSearching")
            : docState.matched === false ? `📄 ${docCondition.title} · ` + t("sidebar.sessionSearchEmpty")
            : `📄 ${docCondition.title} · ` + t("sm.dockAdvDocCount", { count: docRows?.length ?? 0 })}
        </div>
        {docState?.snippet ? (
          <div className="px-3 pb-2 text-xs text-text-muted wrap-anywhere"
            dangerouslySetInnerHTML={{ __html: docState.snippet }} />
        ) : null}
        {docState?.available === false && (
          <div role="status" className="px-3 pb-2 text-xs text-text-dim">aiti-doc-center unavailable</div>
        )}
        {(docRows ?? []).map(({ session, opCount }) => (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelectSession(session)}
            aria-current={session.id === selectedSessionId ? "true" : undefined}
            className={`block w-full cursor-pointer border-b border-border px-3 py-2 text-left hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent ${session.id === selectedSessionId ? "bg-bg-selected" : ""}`}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {agentBadge(session.agent)}
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{session.name || session.firstMessage}</span>
            </span>
            <span className="mt-1 flex min-w-0 gap-2 text-[10px] text-text-dim">
              <span className="min-w-0 flex-1 truncate" title={session.cwd}>{session.cwd}</span>
              <span className="shrink-0">{formatRelativeTime(session.modified, locale)}</span>
            </span>
            <span className="mt-1 block truncate text-[10px] text-text-dim" title={docCondition.relpath}>
              📄 {docCondition.relpath} · op×{opCount}
            </span>
          </button>
        ))}
      </div>
    );
  }
  return !open || !search ? children : (
    <div className="min-h-20 flex-1 overflow-y-auto" aria-busy={!response && !failed}>
      <div role="status" className="px-3 py-2 text-xs text-text-muted">
        {failed ? t("sidebar.sessionSearchFailed") : !response ? t("sidebar.sessionSearching")
          : shown.length === 0 ? t("sidebar.sessionSearchEmpty")
          : t("sidebar.sessionSearchCount", { count: shown.length })}
      </div>
      {response?.truncated && (
        <div role="status" className="px-3 pb-2 text-xs text-text-muted">{t("sidebar.sessionSearchPartial")}</div>
      )}
      {shown.map(({ session, entryId, blockIndex, before, match, after }) => (
        <button
          key={session.id}
          type="button"
          onClick={() => onSelectSession(session, entryId, blockIndex)}
          aria-current={session.id === selectedSessionId ? "true" : undefined}
          className={`block w-full cursor-pointer border-b border-border px-3 py-2 text-left hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent ${session.id === selectedSessionId ? "bg-bg-selected" : ""}`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {agentBadge(session.agent)}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{session.name || session.firstMessage}</span>
          </span>
          <span className="mt-1 flex min-w-0 gap-2 text-[10px] text-text-dim">
            <span className="min-w-0 flex-1 truncate" title={session.cwd}>{session.cwd}</span>
            <span className="shrink-0">{formatRelativeTime(session.modified, locale)}</span>
          </span>
          <span className="mt-1 block text-xs leading-relaxed wrap-anywhere text-text-muted">
            {before}<mark className="rounded-sm bg-accent/20 text-text">{match}</mark>{after}
          </span>
        </button>
      ))}
    </div>
  );
}
