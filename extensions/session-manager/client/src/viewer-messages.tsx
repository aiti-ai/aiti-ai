/**
 * session-manager · 查看器消息区（归档 ArchivedViewer / 外部 ExtViewer 共用）——聊天式布局。
 *
 * 用户消息右侧气泡、助手左侧气泡（配色沿用主聊天窗 --user-bg/--assistant-bg/--tool-bg），
 * 工具结果折叠为紧凑卡；时间角标 + 跨天日期分隔；模型徽标；图片缩略图；单条复制；
 * 超长折叠；🧑/🤖/🛠 角色过滤；搜索高亮；⤒/⤓ 顶底跳转。
 * 规则细节见 docs/session-manager-viewer-chat-plan.md §3。
 *
 * 输入形状 = 服务端归一化 IndexedMessage（lib/session-file.ts）：归档 pi jsonl 与各外部
 * adapter 同一形状，本组件不区分来源。
 */
import { useState, useEffect, useRef, useLayoutEffect, useMemo } from "react";
import { t } from "./host-shim";
import { highlight, ensureReadability, inputStyle, AGENT_META } from "./helpers";
import {
  type ViewerRole as Role, TOOL_MAX_LINES, TOOL_PREVIEW_CHARS,
  roleOf, isToolCard, bucketOf, dayKey, fmtTime, shortModel, countLines, firstLine,
  isLong, clampText, splitToolLines, toolCardText, searchHaystack,
} from "./viewer-text";

export interface ViewerMsg {
  entryId?: string;
  role: string;
  ts?: string | null;
  model?: string;
  provider?: string;
  toolName?: string;
  text?: string;
  images?: Array<{ mime: string; filename?: string; dataUrl: string }>;
  tool?: { callID?: string; name: string; input: Record<string, unknown> | null; output?: string; isError?: boolean };
}

const AVATAR = 22;
const AVATAR_GAP = 6;

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/* ── 样式 ── */

const proseStyle = { fontSize: 12, lineHeight: 1.55, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" } as any;
const toolLineStyle = {
  fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.5, color: "var(--text-muted)",
  whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--bg-subtle)",
  borderRadius: 6, padding: "3px 7px", margin: "4px 0",
} as any;
const monoBody = {
  fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, color: "var(--text)",
  whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
} as any;
const linkBtn = {
  background: "none", border: "none", cursor: "pointer", padding: "2px 0", marginTop: 2,
  fontSize: 11, color: "var(--accent)", display: "block",
} as any;
const metaRow = { display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 10, color: "var(--text-dim)", lineHeight: 1.2 } as any;
const chipBtn = (on: boolean, color: string) => ({
  fontSize: 11, lineHeight: "18px", padding: "0 7px", borderRadius: 999, cursor: "pointer", flexShrink: 0,
  background: on ? color + "22" : "transparent",
  border: `1px solid ${on ? ensureReadability(color) + "88" : "var(--border)"}`,
  color: on ? ensureReadability(color) : "var(--text-dim)",
  opacity: on ? 1 : 0.7,
}) as any;
const fabBtn = {
  width: 26, height: 26, borderRadius: "50%", cursor: "pointer", fontSize: 13, lineHeight: "24px", textAlign: "center",
  background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text-muted)",
  boxShadow: "0 2px 8px rgba(0,0,0,0.18)", padding: 0,
} as any;

/* ── 子组件 ── */

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = (text: string) => {
    const done = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    };
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, () => { if (fallbackCopy(text)) done(); });
      } else if (fallbackCopy(text)) done();
    } catch { /* 剪贴板不可用：静默 */ }
  };
  return [copied, copy];
}

function CopyBtn(props: { text: string; visible: boolean }) {
  const [copied, copy] = useCopy();
  return (
    <button
      onClick={(e) => { e.stopPropagation(); copy(props.text); }}
      title={copied ? t("sm.viewer.copied") : t("sm.viewer.copy")}
      aria-label={t("sm.viewer.copy")}
      style={{
        background: "none", border: "none", cursor: "pointer", padding: "0 2px", lineHeight: 1, fontSize: 11,
        color: copied ? ensureReadability("var(--ok, #22c55e)") : "var(--text-dim)",
        opacity: props.visible || copied ? 1 : 0, transition: "opacity .12s",
      } as any}
    >{copied ? "✓" : "⧉"}</button>
  );
}

function Avatar(props: { agent?: string }) {
  const meta = props.agent && props.agent !== "pi" ? (AGENT_META[props.agent] ?? AGENT_META.default) : null;
  return (
    <div
      title={props.agent && props.agent !== "pi" ? props.agent : t("sm.viewer.assistant")}
      style={{
        width: AVATAR, height: AVATAR, borderRadius: "50%", flexShrink: 0, marginTop: 2,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: meta ? 9 : 13, fontWeight: 700, letterSpacing: meta ? "0.04em" : undefined,
        background: meta ? meta.color + "22" : "var(--bg-hover)",
        border: `1px solid ${meta ? ensureReadability(meta.color) + "66" : "var(--border)"}`,
        color: meta ? ensureReadability(meta.color) : "var(--text-muted)",
      } as any}
    >{meta ? meta.short : "🤖"}</div>
  );
}

function Images(props: { images?: ViewerMsg["images"] }) {
  const imgs = props.images;
  if (!imgs || !imgs.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
      {imgs.map((img, i) => (
        <img
          key={i}
          src={img.dataUrl}
          alt={img.filename ?? ""}
          title={`${img.filename ?? img.mime}（${t("sm.viewer.openImage")}）`}
          onClick={() => { try { window.open(img.dataUrl, "_blank"); } catch { /* 弹窗拦截：忽略 */ } }}
          style={{ maxWidth: 200, maxHeight: 160, borderRadius: 6, objectFit: "contain", display: "block", cursor: "zoom-in", border: "1px solid var(--border)", background: "var(--bg)" } as any}
        />
      ))}
    </div>
  );
}

/** 正文渲染：🛠 调用行（等宽小字）与普通段落分开；搜索命中高亮；超长折叠（搜索态强制全文） */
function MsgText(props: { text: string; q: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = props.text;
  const long = isLong(text);
  const forceFull = !!props.q;
  const showFull = expanded || forceFull || !long;
  const segs = splitToolLines(showFull ? text : clampText(text));
  return (
    <>
      {segs.map((s, i) => (
        <div key={i} style={s.tool ? toolLineStyle : proseStyle} dangerouslySetInnerHTML={{ __html: highlight(s.text, props.q) }} />
      ))}
      {long && !forceFull && (
        <button onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} style={linkBtn}>
          {expanded ? t("sm.viewer.collapse") : t("sm.viewer.expandAll", { n: text.length })}
        </button>
      )}
    </>
  );
}

/** 工具卡：默认折叠（工具名 · N 行 · 首行预览），点头部展开；搜索态自动展开 */
function ToolCard(props: { m: ViewerMsg; q: string }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const m = props.m;
  const name = m.tool?.name ?? m.toolName ?? "";
  const { inText, outText, full } = toolCardText(m);
  const lines = countLines(full);
  const preview = firstLine(outText || inText || String(m.text ?? "")).slice(0, TOOL_PREVIEW_CHARS);
  const isErr = !!m.tool?.isError;
  const isOpen = open || !!props.q;
  const errColor = ensureReadability("var(--danger, #f87171)");

  const renderBody = (label: string | null, body: string) => {
    if (!body) return null;
    const ls = body.split("\n");
    const truncated = ls.length > TOOL_MAX_LINES;
    const shown = truncated ? ls.slice(0, TOOL_MAX_LINES).join("\n") : body;
    return (
      <div style={{ marginTop: 6 }}>
        {label && <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 2 }}>{label}</div>}
        <pre style={monoBody} dangerouslySetInnerHTML={{ __html: highlight(shown, props.q) }} />
        {truncated && <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>{t("sm.viewer.truncated", { n: ls.length - TOOL_MAX_LINES })}</div>}
      </div>
    );
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        maxWidth: "88%", minWidth: 0, background: "var(--tool-bg)",
        border: `1px dashed ${isErr ? errColor + "88" : "var(--border)"}`, borderRadius: 8, padding: "5px 9px",
      } as any}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        role="button"
        aria-expanded={isOpen}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 0, fontSize: 11, color: isErr ? errColor : "var(--text-muted)" } as any}
      >
        <span style={{ flexShrink: 0 }}>{isOpen ? "▾" : "▸"}</span>
        <span style={{ flexShrink: 0, fontWeight: 600 }}>{`${name || t("sm.viewer.toolResult")}`}</span>
        <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{`· ${t("sm.viewer.lines", { n: lines })}`}</span>
        {!isOpen && preview && (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5 } as any}>{preview}</span>
        )}
        <span style={{ marginLeft: "auto", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
          {fmtTime(m.ts) && <span style={{ fontSize: 10, color: "var(--text-dim)" }} title={m.ts ?? ""}>{fmtTime(m.ts)}</span>}
          <CopyBtn text={full} visible={hover} />
        </span>
      </div>
      {isOpen && (m.tool
        ? <>{renderBody(t("sm.viewer.input"), inText)}{renderBody(t("sm.viewer.output"), outText)}</>
        : renderBody(null, outText))}
    </div>
  );
}

function DayDivider(props: { day: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 12px", color: "var(--text-dim)", fontSize: 10 }}>
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      <span style={{ flexShrink: 0 }}>{props.day}</span>
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}

function MsgRow(props: { m: ViewerMsg; q: string; agent?: string }) {
  const [hover, setHover] = useState(false);
  const m = props.m;
  const role = roleOf(m);
  const time = fmtTime(m.ts);
  const rowStyle = { marginBottom: 10, contentVisibility: "auto", containIntrinsicSize: "0 64px" } as any;

  if (isToolCard(m)) {
    return (
      <div style={{ ...rowStyle, display: "flex", justifyContent: "flex-start", paddingLeft: AVATAR + AVATAR_GAP }}>
        <ToolCard m={m} q={props.q} />
      </div>
    );
  }

  const text = String(m.text ?? "");
  if (role === "user") {
    return (
      <div style={{ ...rowStyle, display: "flex", justifyContent: "flex-end" }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <div style={{
          maxWidth: "82%", minWidth: 0, background: "var(--user-bg)", border: "1px solid rgba(59,130,246,0.2)",
          borderRadius: "12px 12px 4px 12px", padding: "7px 11px",
        } as any}>
          <Images images={m.images} />
          <MsgText text={text} q={props.q} />
          <div style={{ ...metaRow, justifyContent: "flex-end" }}>
            {time && <span title={m.ts ?? ""}>{time}</span>}
            <CopyBtn text={text} visible={hover} />
          </div>
        </div>
      </div>
    );
  }

  const model = shortModel(m.model);
  return (
    <div style={{ ...rowStyle, display: "flex", justifyContent: "flex-start", alignItems: "flex-start", gap: AVATAR_GAP }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <Avatar agent={props.agent} />
      <div style={{
        maxWidth: "88%", minWidth: 0, background: "var(--assistant-bg)", border: "1px solid var(--border)",
        borderRadius: "12px 12px 12px 4px", padding: "7px 11px",
      } as any}>
        <Images images={m.images} />
        <MsgText text={text} q={props.q} />
        <div style={metaRow}>
          {model && (
            <span title={m.model} style={{ padding: "0 5px", borderRadius: 5, background: "var(--bg-subtle)", border: "1px solid var(--border)", color: "var(--text-muted)", lineHeight: "14px", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as any}>{model}</span>
          )}
          {time && <span title={m.ts ?? ""}>{time}</span>}
          <CopyBtn text={text} visible={hover} />
        </div>
      </div>
    </div>
  );
}

/* ── 主组件 ── */

export function ViewerMessages(props: { messages: ViewerMsg[]; agent?: string }) {
  const [q, setQ] = useState("");
  const [roles, setRoles] = useState<Record<Role, boolean>>({ user: true, assistant: true, toolResult: true });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const query = q.trim();
  const lower = query.toLowerCase();
  const all = props.messages ?? [];

  const totals = useMemo(() => {
    const c = { user: 0, assistant: 0, toolResult: 0 };
    for (const m of all) c[bucketOf(m)]++;
    return c;
  }, [all]);

  const filtered = useMemo(() => all.filter((m) => {
    if (!roles[bucketOf(m)]) return false;
    return !lower || searchHaystack(m).toLowerCase().includes(lower);
  }), [all, roles, lower]);

  // 首次挂载滚到底（与主聊天窗打开会话一致）；搜索态不滚
  const didInit = useRef(false);
  useLayoutEffect(() => {
    if (didInit.current || query) return;
    didInit.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, query]);

  const jump = (toBottom: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    try { el.scrollTo({ top: toBottom ? el.scrollHeight : 0, behavior: "smooth" }); }
    catch { el.scrollTop = toBottom ? el.scrollHeight : 0; }
  };
  const toggleRole = (r: Role) => setRoles((prev) => ({ ...prev, [r]: !prev[r] }));

  const statsText = t("sm.viewer.stats", { total: filtered.length, user: totals.user, assistant: totals.assistant, tool: totals.toolResult });

  return (
    <>
      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 12px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setQ(""); } }}
          placeholder={t("sm.viewerSearch")}
          style={{ ...inputStyle, fontSize: 12, padding: "4px 9px", minWidth: 120 } as any}
        />
        {query && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0, whiteSpace: "nowrap" }}>
            {`${filtered.length}/${all.length}`}
          </span>
        )}
        <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <button onClick={() => toggleRole("user")} title={t("sm.viewer.filterUser")} aria-pressed={roles.user} style={chipBtn(roles.user, "#3b82f6")}>{`${totals.user}`}</button>
          <button onClick={() => toggleRole("assistant")} title={t("sm.viewer.filterAssistant")} aria-pressed={roles.assistant} style={chipBtn(roles.assistant, "var(--ok, #22c55e)")}>{`${totals.assistant}`}</button>
          <button onClick={() => toggleRole("toolResult")} title={t("sm.viewer.filterTool")} aria-pressed={roles.toolResult} style={chipBtn(roles.toolResult, "var(--warn, #f59e0b)")}>{`${totals.toolResult}`}</button>
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }} title={statsText}>
          {t("sm.msgCount", { count: all.length })}
        </span>
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "10px 14px 14px" }}>
          {filtered.length === 0
            ? <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>{t("sm.viewerNoMatch")}</div>
            : filtered.map((m, i) => {
              const day = dayKey(m.ts);
              const prevDay = i > 0 ? dayKey(filtered[i - 1].ts) : "";
              const showDay = !!day && day !== prevDay;
              // entryId 在部分 adapter 里按消息计数生成、可能重复——拼下标保证唯一
              return (
                <div key={`${m.entryId ?? ""}:${i}`}>
                  {showDay && <DayDivider day={day} />}
                  <MsgRow m={m} q={query} agent={props.agent} />
                </div>
              );
            })}
        </div>
        {filtered.length > 8 && (
          <div style={{ position: "absolute", right: 14, bottom: 10, display: "flex", flexDirection: "column", gap: 6, zIndex: 1 }}>
            <button onClick={() => jump(false)} title={t("sm.viewer.toTop")} aria-label={t("sm.viewer.toTop")} style={fabBtn}>⤒</button>
            <button onClick={() => jump(true)} title={t("sm.viewer.toBottom")} aria-label={t("sm.viewer.toBottom")} style={fabBtn}>⤓</button>
          </div>
        )}
      </div>
    </>
  );
}
