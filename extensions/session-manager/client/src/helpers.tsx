/**
 * session-manager · 纯函数/样式助手（自手写版迁移，逻辑一比一）。
 */
import { t } from "./host-shim";

/* ── 配色可读性工具：品牌色在当前主题面板底色上不足 4.5:1 时，
   向正文色方向加深（浅色主题）/提亮（暗色主题）到刚好达标。
   用于徽标/chip 等彩色文字 —— 暗色主题下原色通常已可读，浅色下自动加深。 */
const _lum = (hex: string) => {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const f = (i: number) => { let c = parseInt(v.slice(i, i + 2), 16) / 255; c = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); return c; };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
};
const _contrast = (a: string, b: string) => { const l1 = _lum(a), l2 = _lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const _blend = (a: string, b: string, t: number) => {
  const p = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const to = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return "#" + [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t].map(to).join("");
};
export function ensureReadability(hex: string, ratio = 5.5): string {
  try {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
    const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    const bg = dark ? "#242424" : "#f5f5f5";
    if (_contrast(hex, bg) >= ratio) return hex;
    const anchor = dark ? "#e8e8e8" : "#1a1a1a";
    let lo = 0, hi = 1;
    for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (_contrast(_blend(hex, anchor, mid), bg) >= ratio) hi = mid; else lo = mid; }
    return _blend(hex, anchor, hi);
  } catch { return hex; }
}

/* ── M1 multi-agent: badge metadata for external sources ── */
export const AGENT_META: Record<string, { short: string; color: string; icon?: string }> = {
  pi: { short: "Pi", color: "#0ea5e9" },
  claude: { short: "CC", color: "#d97757" },
  qoder: { short: "Qo", color: "#22c55e" },
  qodercn: { short: "Qc", color: "#16a34a" }, // Qoder 中国版：同族深绿，与 intl 区分
  codex: { short: "Cx", color: "#6366f1" },
  gemini: { short: "Gx", color: "#3b82f6" },
  trae: { short: "Tr", color: "#06b6d4" },
  cursor: { short: "Cu", color: "#8b5cf6" },
  "cursor-ide": { short: "Ci", color: "#a78bfa" },
  opencode: { short: "Oc", color: "#ec4899" },
  zcode: { short: "Zc", color: "#38bdf8" },
  codebuddy: { short: "Cb", color: "#0052d9" }, // 腾讯 CodeBuddy 品牌蓝
  dsh: { short: "Ds", color: "#f97316" },
  devin: { short: "Dv", color: "#06b6d4" },
  windsurf: { short: "Dv", color: "#06b6d4" }, // 存储键沿用 windsurf, 展示归一为 Devin
  cline: { short: "Cl", color: "#f59e0b" },
  goose: { short: "Go", color: "#84cc16" },
  amp: { short: "Am", color: "#e11d48" },
  factory: { short: "Fx", color: "#8b5cf6" },
  antigravity: { short: "Ag", color: "#1a73e8" },
  default: { short: "Ai", color: "#64748b" },
};

/** Small colored agent badge (e.g. [CC]) — pi rows render nothing. */
export function agentBadge(agent?: string) {
  if (!agent || agent === "pi") return null;
  const m = AGENT_META[agent] ?? AGENT_META.default;
  return (
    <span
      title={agent}
      style={{
        flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: "0.04em",
        padding: "0 5px", borderRadius: 6, lineHeight: "15px",
        color: ensureReadability(m.color), background: m.color + "1f", border: `1px solid ${ensureReadability(m.color)}55`,
      }}
    >{m.short}</span>
  );
}

/** Client-side copy of the tag lib's defaultColorFor (display-only reset). */
export function defaultColorForClient(name: string) {
  const map: Record<string, string> = { todo: "#f59e0b", bugfix: "#ef4444", bug: "#ef4444", urgent: "#ef4444", feature: "#22c55e", review: "#8b5cf6", docs: "#3b82f6", test: "#06b6d4", refactor: "#64748b", chore: "#64748b" };
  const hit = map[name.trim().toLowerCase()];
  if (hit) return hit;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = ["#ef4444", "#f97316", "#f59e0b", "#22c55e", "#10b981", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#ec4899", "#64748b"];
  return palette[h % palette.length];
}

export function fmtRelative(iso: string) {
  const t0 = Date.parse(iso);
  if (Number.isNaN(t0)) return "";
  const diff = Date.now() - t0;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

export function byIdMap(data: any) {
  return new Map((data?.tags ?? []).map((n: any) => [n.id, n]));
}

/** node → "a/b/c" path (display form). */
export function tagPath(nodeId: string, data: any) {
  const byId = byIdMap(data);
  const segs: string[] = [];
  let cur = byId.get(nodeId);
  while (cur) {
    segs.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return segs.join("/");
}

export function sessionTagIds(sessionId: string, data: any): string[] {
  return data?.sessionTags?.[sessionId] ?? [];
}

/** session tag ids → matching when the tag or an ancestor is selected. */
export function matchesTags(sessionId: string, data: any, selectedIds: string[]) {
  if (!selectedIds.length) return true;
  const byId = byIdMap(data);
  const selected = new Set(selectedIds);
  for (const sid of sessionTagIds(sessionId, data)) {
    let cur = byId.get(sid);
    while (cur) {
      if (selected.has(cur.id)) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return false;
}

export function sessionTitle(s: any) {
  return s.name || s.firstMessage || s.id.slice(0, 12);
}

/* §14.2.6 search hit highlighting — escape, then wrap query terms in <mark>. */
function escapeHtml(text: unknown) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" } as Record<string, string>)[c]!);
}
export function highlight(text: string, q: string) {
  const safe = escapeHtml(text);
  const term = escapeHtml(q.trim());
  if (!term) return safe;
  const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return safe.replace(re, "<mark style='background:rgba(245,158,11,0.35);color:inherit;border-radius:2px;padding:0 1px'>$1</mark>");
}

/* §14.2.2 date presets (filter by session.modified). */
const datePresets: { key: string; label: () => string }[] = [
  { key: "", label: () => t("sm.allTags") },
  { key: "today", label: () => t("sm.today") },
  { key: "24h", label: () => t("sm.last24h") },
  { key: "2d", label: () => t("sm.last2d") },
  { key: "7d", label: () => t("sm.last7d") },
  { key: "30d", label: () => t("sm.last30d") },
];
export function getDatePresets() { return datePresets; }
export function dateFilterMatches(iso: string, preset: string) {
  if (!preset) return true;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return preset.startsWith("day:") ? false : true;
  if (preset === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return ts >= d.getTime(); }
  if (preset === "24h") return ts >= Date.now() - 86400000;
  if (preset === "2d") return ts >= Date.now() - 2 * 86400000;
  if (preset === "7d") return ts >= Date.now() - 7 * 86400000;
  if (preset === "30d") return ts >= Date.now() - 30 * 86400000;
  if (preset.startsWith("day:")) {
    const day = preset.slice(4);
    const d = new Date(ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return key === day;
  }
  return true;
}

/* §14.4.1 last-role badge + summary line. */
export function roleBadge(role?: string) {
  if (role === "user") return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path key="p1" d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
  if (role === "toolResult") return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path key="p1" d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path key="p1" d="M12 8V4H8" />
      <path key="p2" d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path key="p3" d="M2 14h2" />
      <path key="p4" d="M20 14h2" />
      <path key="p5" d="M15 13v2" />
      <path key="p6" d="M9 13v2" />
    </svg>
  );
}

export function descendantsLocal(tagId: string, byIdMapRef: Map<string, any>) {
  const out = [tagId];
  let i = 0;
  while (i < out.length) {
    const p = out[i++];
    for (const n of byIdMapRef.values()) if (n.parentId === p && !out.includes(n.id)) out.push(n.id);
  }
  return out;
}

/* ── shared styles ── */
export const inputStyle: Record<string, string | number> = {
  flex: 1, minWidth: 0, fontSize: 12, padding: "5px 9px",
  border: "1px solid var(--border)", borderRadius: 7, outline: "none",
  background: "var(--bg)", color: "var(--text)", boxSizing: "border-box",
};

export const ghostBtn: Record<string, string | number> = {
  padding: "4px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer",
  background: "var(--bg-hover)", border: "1px solid var(--border)",
  color: "var(--text-muted)", whiteSpace: "nowrap",
};

export const miniBtn: Record<string, string | number> = {
  background: "none", border: "none", cursor: "pointer",
  color: "var(--text-dim)", fontSize: 11, padding: "1px 4px",
};

export const selectStyle: Record<string, string | number> = {
  fontSize: 11, padding: "3px 8px", borderRadius: 7,
  border: "1px solid var(--border)", background: "var(--bg)",
  color: "var(--text)", maxWidth: 220, outline: "none",
};
