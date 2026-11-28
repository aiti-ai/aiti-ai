/**
 * aiti-git-review · client 共享工具（自手写版迁移；逻辑一比一保留）。
 *
 * 含：全局打开状态 G / api 封装 / 小工具函数 / 布局持久化 / 流水线站点构建 /
 *     textarea 自动增高 / 标注样式注入 / 布局与按钮样式常量。
 */
import { apiUrl } from "./host-shim";

export const api = (p: string, init?: RequestInit) =>
  fetch(apiUrl("/api/extensions/aiti-git-review" + p), { cache: "no-store", ...init });
export const jsonBody = (o: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

// ── 全局打开状态 ──
export const G: { open: any; probePath: string; presetRepo: string } = {
  open: null as any,
  probePath: "",
  presetRepo: "",
};

// 宿主 ctx（entry register 时注入；sendChatMessage 等非 shim 能力从这里取）
let _ctx: any = null;
export function setGRCtx(ctx: unknown) { _ctx = ctx; }
export function getCtx(): any { return _ctx; }

export const lastSeg = (p: string) => { const s = String(p).split("/"); return s[s.length - 1]; };
export const MONO = "var(--font-mono,ui-monospace,monospace)";
export const statusIcon = (st: string) => (st === "A" ? "+" : st === "D" ? "-" : st === "R" ? "↻" : "~");
export const statusColor = (st: string) => (st === "A" ? "var(--ok, #4ade80)" : st === "D" ? "var(--danger, #f87171)" : st === "R" ? "var(--warn, #fbbf24)" : "#e0e0e0");
export const sevColor = (s: string) => (s === "must" ? "var(--danger, #f87171)" : s === "suggest" ? "var(--warn, #fbbf24)" : s === "question" ? "#4f8ef7" : "#888");
export const sevLabel = (s: string) => (s === "must" ? "必须" : s === "suggest" ? "建议" : s === "question" ? "疑问" : s);

// 小屏断点（与 aiti-extman/configs 同）：宽≤640（高度变化如输入法弹起不翻转布局）
export const SMALL_MQ = "(max-width: 640px)";

// ── 布局配置持久化（按宽度桶 + 浏览器 origin 自动作用域）──
const LAYOUT_KEY = "aiti-gr-layout";
export function getSaved(bucket: number) {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const configs = JSON.parse(raw);
    const c = configs && configs[String(bucket)];
    // 只返回 version===1 的配置（跳过部署时误存的旧桌面布局——无 version 字段）
    return c && c._touched && c.version === 1 ? c : null;
  } catch { return null; }
}
export function saveConfig(bucket: number, cfg: any) {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const configs = raw ? JSON.parse(raw) : {};
    configs[String(bucket)] = { view: cfg.view, showFiles: cfg.showFiles, showDiff: cfg.showDiff, showPanel: cfg.showPanel, _touched: true, version: 1 };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(configs));
  } catch {}
}
/** 启动时收集已触及的桶集（version===1） */
export function loadTouchedBuckets(): Set<number> {
  const out = new Set<number>();
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const configs = JSON.parse(raw);
      for (const b of Object.keys(configs)) {
        if (configs[b] && configs[b]._touched && configs[b].version === 1) out.add(parseInt(b, 10));
      }
    }
  } catch {}
  return out;
}

// ── 流水线站点构建：标注与 git 变更同等重要的循环站点 ──
// 第 0 站 = 块默认标注位（首变更行起：add 优先，纯删块用 del 行；与提交流水线落点一致，锚在首行的既有标注并入此站）；
// 之后 = 块内已有标注（AI/用户、未解决、非默认位）按行序各成一站——点下一步就逐站走到它们
export function buildStops(hk: any, annos: any[]) {
  if (!hk) return [];
  const segs = hk.segments || [];
  const addL = segs.filter((s: any) => s.type === "add" && s.newLine).map((s: any) => s.newLine);
  const delL = segs.filter((s: any) => s.type === "del" && s.oldLine).map((s: any) => s.oldLine);
  const defSide = addL.length ? "new" : (delL.length ? "old" : null);
  const rangeLines = addL.length ? addL : delL;
  const defLine = rangeLines.length ? Math.min.apply(null, rangeLines) : null;
  const defLineEnd = rangeLines.length > 1 ? Math.max.apply(null, rangeLines) : defLine;
  const stops: any[] = [];
  if (defSide && defLine) stops.push({ side: defSide, line: defLine, lineEnd: defLineEnd, anno: null });
  // 块内标注：行号命中本块该侧任意 segment（ctx/del→old 行、ctx/add→new 行）
  const inHunk: any[] = [];
  for (const a of annos || []) {
    if (a.resolved) continue;
    const ln = a.side === "old" ? a.oldLine : a.newLine;
    if (!ln) continue;
    const hit = (a.side === "old" && segs.some((s: any) => s.oldLine === ln)) || (a.side === "new" && segs.some((s: any) => s.newLine === ln));
    if (hit) inHunk.push(a);
  }
  inHunk.sort((x: any, y: any) => ((x.side === "old" ? x.oldLine : x.newLine) || 0) - ((y.side === "old" ? y.oldLine : y.newLine) || 0));
  for (const a of inHunk) {
    const ln = a.side === "old" ? a.oldLine : a.newLine;
    const en = a.side === "old" ? a.oldLineEnd : a.newLineEnd;
    const head = stops[0];
    if (head && !head.anno && head.side === a.side && head.line === ln) { head.anno = a; continue; } // 锚在默认位首行的标注：并入第 0 站（预填编辑）
    stops.push({ side: a.side, line: ln, lineEnd: typeof en === "number" && en > ln ? en : ln, anno: a });
  }
  return stops;
}

// 内嵌标注输入框：textarea 自动增高（内容多时撑开显示全部，超出 maxPx 内部滚动）
export function autoGrow(el: HTMLTextAreaElement | null, maxPx?: number) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, maxPx || 300) + "px";
}

// ── 标注 CSS（一次性注入）──
let stylesInjected = false;
export function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
      .aiti-gr-anno-line { background: rgba(255, 200, 0, .07) !important; }
      .aiti-gr-glyph-must { border-left: 3px solid var(--danger, #f87171) !important; }
      .aiti-gr-glyph-suggest { border-left: 3px solid var(--warn, #fbbf24) !important; }
      .aiti-gr-glyph-question { border-left: 3px solid #4f8ef7 !important; }
      .aiti-gr-glyph-must-ai { border-left: 4px dashed var(--danger, #f87171) !important; }
      .aiti-gr-glyph-suggest-ai { border-left: 4px dashed var(--warn, #fbbf24) !important; }
      .aiti-gr-glyph-question-ai { border-left: 4px dashed #4f8ef7 !important; }
      .aiti-gr-margin-must { background: var(--danger, #f87171); width: 3px !important; border-radius: 2px; }
      .aiti-gr-margin-suggest { background: var(--warn, #fbbf24); width: 3px !important; border-radius: 2px; }
      .aiti-gr-margin-question { background: #4f8ef7; width: 3px !important; border-radius: 2px; }
      .aiti-gr-mark-line { background: rgba(180, 83, 9, .14) !important; }
      .aiti-gr-mark-deco { display: flex; align-items: center; justify-content: center; color: #b45309; font-size: 11px; font-weight: 700; cursor: pointer; }
      .aiti-gr-mark-deco::before { content: "↩"; }
      .aiti-gr-bubble-host { } /* 按需 add/remove（Monaco 接管 display，不用 CSS 显隐） */
      .aiti-gr-bubble {
        font: 11px/1.5 system-ui, sans-serif; color: var(--text,#333);
        background: var(--bg,#fff); border: 1px solid var(--border,#d0d0d0); border-left: 3px solid var(--warn, #fbbf24);
        border-radius: 8px; padding: 6px 9px; max-width: 380px; box-shadow: 0 4px 16px rgba(0,0,0,.15);
        white-space: pre-wrap; word-break: break-word; margin: 2px 0 6px 22px;
      }
      .aiti-gr-bubble-tag { display: inline-block; font-size: 10px; font-weight: 700; border: 1px solid; border-radius: 4px; padding: 0 5px; margin-bottom: 3px; }
      .aiti-gr-bubble-text { display: block; }
    `;
  document.head.appendChild(s);
}

// ── 样式常量 ──
export const overlay: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 2147483000, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", display: "flex", flexDirection: "column", font: "13px/1.5 system-ui, -apple-system, sans-serif" };
// 允许换行（flexWrap:wrap）：窄屏时顶栏两簇放不下 → 右侧工具簇整簇折到第二行，关闭按钮不再被挤出视口
export const topBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border,#e0e0e0)", background: "var(--bg-panel,#fafafa)", flexShrink: 0, flexWrap: "wrap" };
export const bodyRow: React.CSSProperties = { flex: 1, display: "flex", minHeight: 0 };
export const fileList: React.CSSProperties = { width: 240, borderRight: "1px solid var(--border,#e0e0e0)", overflowY: "auto", background: "var(--bg-subtle,#f8f8f8)", flexShrink: 0, display: "flex", flexDirection: "column" };
export const fileRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", cursor: "pointer", borderBottom: "1px solid var(--border,#f0f0f0)" };
export const panel: React.CSSProperties = { width: 320, borderLeft: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f8f8f8)", display: "flex", flexDirection: "column", padding: 8, flexShrink: 0 };
export const allRow: React.CSSProperties = { padding: "6px 6px", borderBottom: "1px solid var(--border,#eee)", background: "var(--bg,#fff)", marginBottom: 4, borderRadius: 6 };
export const segBtn: React.CSSProperties = { padding: "4px 10px", borderWidth: 1, borderStyle: "solid", borderColor: "var(--border,#d0d0d0)", borderRadius: 6, background: "var(--bg,#fff)", color: "var(--text,#333)", cursor: "pointer", fontSize: 12, flexShrink: 0 };
export const segOn: React.CSSProperties = { background: "var(--accent,#2563eb)", borderColor: "var(--accent,#2563eb)", color: "#fff" };
export const miniBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 12, padding: "1px 3px", color: "var(--text-dim,#888)" };
export const btnPrimary: React.CSSProperties = { padding: "5px 10px", border: "none", borderRadius: 6, background: "var(--accent,#2563eb)", color: "#fff", cursor: "pointer", fontSize: 12, flexShrink: 0 };
export const bottomBar: React.CSSProperties = { padding: "6px 12px", borderTop: "1px solid var(--border,#e0e0e0)", color: "var(--text-muted,#888)", fontSize: 11, flexShrink: 0 };
export const btn: React.CSSProperties = { padding: "5px 12px", border: "1px solid var(--border,#d0d0d0)", borderRadius: 6, cursor: "pointer", background: "var(--bg,#fff)", color: "var(--text,#333)", marginTop: 10 };
export const pickerCard: React.CSSProperties = { width: "min(680px, 94vw)", maxHeight: "92vh", margin: "auto", background: "var(--bg,#fff)", borderRadius: 12, boxShadow: "0 12px 50px rgba(0,0,0,.25)", padding: 16, display: "flex", flexDirection: "column", overflow: "hidden", font: "13px/1.5 system-ui, sans-serif", color: "var(--text,#1a1a1a)" };

// ── trace 任务源（docs/aiti-git-trace-plan.md §6.3）：跨扩展 API + 部分回滚 ──

/** aiti-git-trace 扩展 API（跨扩展：写操作全部收敛在 trace 侧，本扩展保持只读 git） */
export const traceApi = (p: string, init?: RequestInit) =>
  fetch(apiUrl("/api/extensions/aiti-git-trace" + p), { cache: "no-store", ...init });

/** mock 开关：localStorage.aiti-gr-rollback-mock === "1" 时回滚请求本地模拟（对端未部署也能联调 UI） */
export const rollbackMockOn = (): boolean => {
  try { return localStorage.getItem("aiti-gr-rollback-mock") === "1"; } catch { return false; }
};

/** 部分回滚（§6.3）：{ storeRoot, sessionId, base, target, files:[{file, hunkIdx:[…]}] }。
 *  真实请求转发 aiti-git-trace /rollback-partial（safety + 过滤逆 patch + apply -R + 记账都在对端）。 */
export function rollbackPartial(payload: any): Promise<any> {
  if (rollbackMockOn()) {
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, mock: true, applied: payload }), 300));
  }
  return traceApi("/rollback-partial", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then((r) => r.json());
}

/** 选区（行号区间，含端点）→ 命中 hunk 索引集合。side="new" 按 newStart/newLines；"old" 按 oldStart/oldLines
 *  （纯新增 hunk oldLines=0，old 侧选区永不命中）。 */
export function hunksForSelection(hunks: any[], start: number, end: number, side: string): number[] {
  const out: number[] = [];
  (hunks || []).forEach((hk: any, i: number) => {
    if (side === "old" && !(hk.oldLines > 0)) return;
    const s = side === "old" ? hk.oldStart : hk.newStart;
    const c = side === "old" ? hk.oldLines : hk.newLines;
    if (typeof s !== "number") return;
    const lo = s, hi = s + Math.max(1, c) - 1;
    if (start <= hi && end >= lo) out.push(i);
  });
  return out;
}

/** hunk 集合的 ±行数统计（确认卡用） */
export function hunksDelta(hk: any): { adds: number; dels: number } {
  let adds = 0, dels = 0;
  for (const sg of hk.segments || []) { if (sg.type === "add") adds++; else if (sg.type === "del") dels++; }
  return { adds, dels };
}
