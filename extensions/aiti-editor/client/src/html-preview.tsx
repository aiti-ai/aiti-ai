/**
 * aiti-editor · HTML 预览面板（快速态 srcdoc / 真预览态服务路由）。
 *
 * 方案：docs/aiti-editor-html-preview-plan.md §3.4
 * 纯逻辑在 `./html.ts`（node --test 直测），本文件只做装配与消息接线。
 *
 * 安全边界（不可谈判）：两态文档都落 **opaque origin**——快速态 `sandbox="allow-scripts …"`
 * 且**永不写 allow-same-origin**；真预览态由服务端响应头 `Content-Security-Policy: sandbox …`
 * 负责（iframe 上不再叠 sandbox 属性，避免双重限制里的 `csp` 属性兼容性差异）。
 * 所以预览里的 `fetch`/`localStorage`/读父页 DOM 必然失败——那是设计目标，不是 bug（方案 §七-1）。
 */
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { editorBase, ensureEditorTicket } from "./host-shim";
import { buildPreviewShim, PREVIEW_MSG } from "../../preview/preview-shim";
import {
  buildHtmlPreviewSrcdoc, previewUrl, resolvePreviewRel, absBase,
  VIEWPORT_PRESETS, viewportWidthOf, viewportStyle,
} from "./html";

export interface HtmlPreviewPaneProps {
  filePath: string;
  /** 编辑器当前缓冲（快速态「未保存即所见」；缺席则退回已加载文本） */
  getBufferText: () => string;
  /** 路径票据（"" / null = 未签发或已失效：真预览不可用，快速态也拿不到兄弟资源） */
  ticket: string | null;
  /** 内容变更计数（父页 300ms 防抖后自增）→ 快速态 srcdoc 的重建触发器 */
  previewTick: number;
  dirty: boolean;
  onSave: () => void;
  dark: boolean;
  showToast: (kind: string, text: string) => void;
  /** 相对链接改道：在 dock 里打开预览目录内的目标文件 */
  onOpenPath: (absPath: string) => void;
}

interface Report { kind: string; level: string; text: string }

type Prefs = { mode: "fast" | "served"; scripts: boolean; viewport: string };
const PREF_KEY = "pi:editor:html-preview";
const REPORTS_CAP = 50;
const BAR_H = 32;
const DEFAULT_PREFS: Prefs = { mode: "fast", scripts: false, viewport: "auto" };

/** 预览偏好（跨 tab 保持；读失败退默认——「脚本默认关」是用户拍板的，不能靠猜）。 */
function readPrefs(): Prefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PREF_KEY) : null;
    if (!raw) return DEFAULT_PREFS;
    const d = JSON.parse(raw) as Partial<Prefs>;
    return {
      mode: d && d.mode === "served" ? "served" : "fast",
      scripts: !!(d && d.scripts === true),
      viewport: d && typeof d.viewport === "string" && VIEWPORT_PRESETS.some((x) => x.id === d.viewport) ? d.viewport : "auto",
    };
  } catch { return DEFAULT_PREFS; }
}

function savePrefs(p: Prefs): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* 写不进就在本 tab 内保持 */ }
}

const barS: Record<string, string> = {
  position: "absolute", top: 0, left: 0, right: 0, zIndex: 20,
  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
  padding: "4px 10px", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)",
  color: "var(--text,#1a1a1a)", background: "var(--bg,#fff)",
  borderBottom: "1px solid var(--border,#e0e0e0)",
};
const segS = (active: boolean, tone = "#7c3aed"): Record<string, string> => ({
  fontSize: 11, padding: "2px 8px", height: 22, cursor: "pointer", whiteSpace: "nowrap",
  border: "1px solid " + (active ? tone : "var(--border,#d0d0d0)"), borderRadius: 6,
  background: active ? "rgba(124,58,237,.10)" : "var(--bg,#fff)",
  color: active ? tone : "var(--text,#1a1a1a)", fontFamily: "inherit",
});
const btnS: Record<string, string> = {
  fontSize: 11, padding: "2px 8px", height: 22, cursor: "pointer", whiteSpace: "nowrap",
  border: "1px solid var(--border,#d0d0d0)", borderRadius: 6,
  background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontFamily: "inherit",
};

export function HtmlPreviewPane(props: HtmlPreviewPaneProps) {
  const prefs0 = useRef<Prefs | null>(null);
  if (!prefs0.current) prefs0.current = readPrefs();
  const [mode, setMode] = useState<Prefs["mode"]>(prefs0.current.mode);
  const [scripts, setScripts] = useState<boolean>(prefs0.current.scripts);
  const [viewport, setViewport] = useState<string>(prefs0.current.viewport);
  const [reports, setReports] = useState<Report[]>([]);
  const [showReports, setShowReports] = useState(false);
  const [docRel, setDocRel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [bust, setBust] = useState(0);
  // 票据本地覆盖：父页每文件只签发一次（TTL 1h 滑动），过期后真预览会静默 403——
  // 刷新动作顺手走一遍 ensureEditorTicket（客户端缓存命中即零请求，过期才真的换票）
  const [tkOver, setTkOver] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const freshTicket = useCallback(() => {
    // 不带 force：客户端缓存按 TTL-5min 过期，有效期内命中缓存 = 零请求，过期才真的换票
    ensureEditorTicket(props.filePath).then(setTkOver).catch(() => { /* 签发失败：下面的未就绪提示兜底 */ });
  }, [props.filePath]);

  const persist = useCallback((patch: Partial<Prefs>) => {
    savePrefs({ mode, scripts, viewport, ...patch });
  }, [mode, scripts, viewport]);

  // 预览路由基址：根相对（iframe 能用）+ 绝对（srcdoc 的 <base> 与 shim 的前缀判定都要 origin）
  const ticket = tkOver || props.ticket || "";
  const rootBase = ticket ? editorBase() + "/preview/" + encodeURIComponent(ticket) + "/" : "";
  const abs = absBase(rootBase, typeof location !== "undefined" ? location.href : "");
  const shim = useMemo(() => buildPreviewShim({ base: abs, docRel: "" }), [abs]);

  const fastDoc = useMemo(() => {
    if (mode !== "fast") return "";
    return buildHtmlPreviewSrcdoc({
      content: props.getBufferText() || "",
      base: abs,
      scripts,
      dark: props.dark,
      shim,
    }).doc;
    // deps 里是「内容变了」的信号本身，不是 getBufferText（每次渲染新函数，放进去等于每帧重渲染）
  }, [mode, props.previewTick, abs, scripts, props.dark, shim]); // eslint-disable-line react-hooks/exhaustive-deps

  // 入口恒为票据文件本身：站内链接由 shim 改道到 dock（不在此框架里导航），
  // 所以 shim 报回的 docRel 只作面包屑显示——回流进 src 会自己刷自己
  const servedSrc = mode === "served" && abs ? previewUrl(abs, "", { scripts, v: bust }) : "";
  const src = mode === "fast" ? fastDoc : servedSrc;

  // 换文档 = 上一份的报错/装载状态作废
  useEffect(() => { setReports([]); setShowReports(false); setLoaded(false); }, [src]);
  // 换文件（同 tab ‹ › 导航）：票据覆盖与「当前预览文档」面包屑都属于上一份
  useEffect(() => { setTkOver(null); setDocRel(""); }, [props.filePath]);

  // iframe → 父页（三型消息，见 preview/preview-shim.ts）。校验 e.source：预览文档虽无同源能力，
  // 消息面仍是全局的——别的 iframe/窗口也能 postMessage 到这儿
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Record<string, unknown> | null;
      if (!d || typeof d.type !== "string") return;
      const fr = iframeRef.current;
      if (!fr || !fr.contentWindow || e.source !== fr.contentWindow) return;
      if (d.type === PREVIEW_MSG.ready) {
        setLoaded(true);
        if (mode === "served" && typeof d.docRel === "string") setDocRel(d.docRel);
        return;
      }
      if (d.type === PREVIEW_MSG.open) {
        const rel = typeof d.rel === "string" ? d.rel : "";
        const target = resolvePreviewRel(props.filePath, rel);
        if (!target) { props.showToast("warn", "链接指向预览目录之外，未改道"); return; }
        props.onOpenPath(target);
        return;
      }
      if (d.type === PREVIEW_MSG.report) {
        setReports((rs) => [{
          kind: typeof d.kind === "string" ? d.kind : "console",
          level: typeof d.level === "string" ? d.level : "error",
          text: typeof d.text === "string" ? d.text : "",
        }, ...rs].slice(0, REPORTS_CAP));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [mode, props.filePath, props.showToast, props.onOpenPath]);

  const errs = reports.filter((r) => r.level === "error").length;
  const vpWidth = viewportWidthOf(viewport);
  const st = viewportStyle(vpWidth, props.dark);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "var(--bg,#fff)" }}>
      <div style={barS}>
        <span style={{ display: "inline-flex", gap: 4 }}>
          <button type="button" style={segS(mode === "fast")} title="编辑器缓冲直接进 srcdoc：未保存即所见，相对资源走预览路由"
            onClick={() => { setMode("fast"); persist({ mode: "fast" }); }}>快速</button>
          <button type="button" style={segS(mode === "served")} title="iframe 指向服务端磁盘文档：原生相对解析与站内导航（未保存编辑不可见）"
            onClick={() => { if (!abs) { props.showToast("warn", "票据未就绪，真预览暂不可用"); return; } setMode("served"); setDocRel(""); freshTicket(); persist({ mode: "served" }); }}>真预览</button>
        </span>
        <button type="button" style={segS(scripts, "#0891b2")}
          title={scripts
            ? "作者脚本执行中（仍无同源能力：fetch/localStorage/读父页 DOM 不可用）"
            : "作者脚本已剥离（快速态剥 srcdoc／真预览态服务端剥响应）；预览自身的报错回传与链接改道不受影响"}
          onClick={() => { const v = !scripts; setScripts(v); persist({ scripts: v }); }}>
          {"脚本 " + (scripts ? "●开" : "○关")}
        </button>
        <select value={viewport} title="视口宽度预设（只改宽度，不伪造 UA／像素比——设备模拟是 devtools 的活）"
          style={{ ...btnS, height: 24, padding: "2px 4px" }}
          onChange={(e) => { const v = e.target.value; setViewport(v); persist({ viewport: v }); }}>
          {VIEWPORT_PRESETS.map((v) => <option key={v.id} value={v.id} title={v.title}>{v.label}</option>)}
        </select>
        <button type="button" style={btnS} title={mode === "served" ? "重新拉取磁盘文档（换破缓存参数）" : "用当前缓冲重建预览"}
          onClick={() => { if (mode === "served") freshTicket(); setBust((v) => v + 1); }}>↻ 刷新</button>
        {props.dirty && mode === "served" && (
          <button type="button" style={{ ...btnS, borderColor: "rgba(245,158,11,.6)", color: "#b45309" }}
            title="真预览读的是磁盘文件，当前有未保存修改"
            onClick={() => { props.onSave(); freshTicket(); setBust((v) => v + 1); }}>保存并刷新</button>
        )}
        {docRel ? (
          <span title={"当前预览文档：" + docRel}
            style={{ opacity: .7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 170 }}>{docRel}</span>
        ) : (mode === "fast" ? <span style={{ opacity: .55 }}>{"缓冲 · 未保存可见"}</span> : null)}
        <span style={{ flex: 1 }} />
        {reports.length > 0 && (
          <button type="button" style={segS(showReports, errs ? "#dc2626" : "#b45309")}
            title={"预览内 console／报错回传（上限 " + REPORTS_CAP + " 条，最新在前）"}
            onClick={() => setShowReports((v) => !v)}>
            {"⚠ " + reports.length + (errs ? " · " + errs + " err" : "")}
          </button>
        )}
      </div>
      <div style={{ ...st.wrap, top: BAR_H }}>
        {mode === "served" && !abs ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim,#888)", fontSize: 12 }}>
            票据未就绪或已过期——重开文件或切回「快速」
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            key={mode + ":" + bust}
            title="HTML 预览"
            // 快速态：sandbox 且**不给 allow-same-origin** = opaque origin（唯一硬边界；剥脚本只是便利层）
            // 真预览态：origin 隔离由响应头 CSP: sandbox 负责，这里不再叠属性
            sandbox={mode === "fast" ? "allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock" : undefined}
            src={mode === "served" ? src : undefined}
            srcDoc={mode === "fast" ? src : undefined}
            style={st.frame}
          />
        )}
        {src && !loaded && (
          <div style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", zIndex: 25,
            fontSize: 11, color: "var(--text-dim,#888)", background: "var(--bg,#fff)",
            border: "1px solid var(--border,#e0e0e0)", borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap" }}>
            等待预览装载…（久候无响应多为脚本出错或资源路径越出预览目录）
          </div>
        )}
        {showReports && (
          <div style={{ position: "absolute", right: 10, top: 6, width: 400, maxWidth: "80%", maxHeight: "70%",
            overflowY: "auto", zIndex: 30, background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)",
            borderRadius: 8, boxShadow: "0 8px 28px rgba(0,0,0,.18)", padding: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 6px" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim,#888)" }}>{"预览上报 · " + reports.length}</span>
              <span style={{ flex: 1 }} />
              <button type="button" style={btnS} onClick={() => {
                try {
                  navigator.clipboard?.writeText(reports.map((r) => "[" + r.level + "] " + r.text).join("\n"));
                  props.showToast("ok", "已复制上报内容");
                } catch { props.showToast("warn", "复制失败"); }
              }}>复制</button>
              <button type="button" style={btnS} onClick={() => { setReports([]); setShowReports(false); }}>清空</button>
            </div>
            {reports.map((r: Report, i: number) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "baseline", padding: "3px 4px",
                borderTop: "1px solid var(--border,#eee)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                <span style={{ flexShrink: 0, color: r.level === "error" ? "#dc2626" : r.level === "warn" ? "#b45309" : "var(--text-dim,#888)" }}>
                  {(r.kind === "error" ? "✖" : r.kind === "notice" ? "ⓘ" : "•") + " " + r.level}
                </span>
                <span style={{ wordBreak: "break-all" }}>{r.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
