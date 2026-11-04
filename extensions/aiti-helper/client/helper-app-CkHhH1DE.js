import { u as useState, a as useEffect, b as useRef, c as useCallback, d as apiUrl, j as jsx, e as jsxs, F as Fragment, f as extSvc, g as extDisplayName, h as hostCtx } from "./entry-DRyxFoKB.js";
let mcCtx = null;
function setMcCtx(ctx) {
  mcCtx = ctx;
}
const _state = {
  open: false,
  opts: null,
  lastResult: "",
  loading: false,
  error: null,
  historyId: null,
  // 当前结果对应历史记录 id（落地时回传标记）
  sessionId: null,
  // 当前结果对应的 agent 会话 id（追问 steer 同一会话，上下文完整延续）
  dialogEl: null,
  // 触发本次 invoke 的弹窗元素（fill 回填用）
  pageId: null,
  // 当前发起页面在 aiti-devtools 桥里的 pageId——预取后随 invoke 报告
  isAiWin: false,
  // 是否 AI 主窗口（xxx/ai）
  pos: { x: null, y: null },
  // 弹窗位置（null=默认右上角）
  compact: false,
  dim: false,
  // 失焦半透明
  activeTab: "ai"
};
const _listeners = /* @__PURE__ */ new Set();
const notify = () => _listeners.forEach((fn) => fn());
const closePanel = () => {
  _state.open = false;
  notify();
};
const Ic = ({ size, paths }) => /* @__PURE__ */ jsx(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: paths.map((d, i) => /* @__PURE__ */ jsx("path", { d }, i))
  }
);
const ICONS = {
  // sparkles 已删：AI 星星统一走 SparkIcon（单源 icons/sparkles.svg，见上）
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  help: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"],
  plus: ["M5 12h14", "M12 5v14"],
  bot: ["M12 8V4H8", "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
  copy: ["M8 8H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2", "M14 2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6l-4-4z", "M14 2v6h6"],
  msg: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
  refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  chevron: ["m9 18 6-6-6-6"],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
  wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"]
};
function computeAvoidingPos(dialogEl) {
  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  const pw = Math.min(440, Math.max(320, vw - 32));
  const ph = Math.min(Math.round(vh * 0.7), vh - 32);
  let dr = null;
  try {
    if (dialogEl && dialogEl.getBoundingClientRect) dr = dialogEl.getBoundingClientRect();
  } catch {
  }
  if (!dr || dr.width < 50 || dr.height < 50) return null;
  const cand = [
    { x: vw - pw - 16, y: 16, label: "tr" },
    { x: 16, y: 16, label: "tl" },
    { x: vw - pw - 16, y: vh - ph - 16, label: "br" },
    { x: 16, y: vh - ph - 16, label: "bl" }
  ];
  const ov = (c) => {
    const cx = Math.max(0, Math.min(c.x + pw, dr.right) - Math.max(c.x, dr.left));
    const cy = Math.max(0, Math.min(c.y + ph, dr.bottom) - Math.max(c.y, dr.top));
    return cx * cy;
  };
  let best = cand[0], bo = ov(best);
  for (const c of cand) {
    const o = ov(c);
    if (o < bo) {
      bo = o;
      best = c;
    }
  }
  return { x: best.x, y: best.y, compact: true };
}
function installInvokeEntry() {
  const invoke = function(opts = {}) {
    _state.open = true;
    _state.opts = opts;
    _state.lastResult = "";
    _state.loading = false;
    _state.error = null;
    _state.historyId = null;
    _state.sessionId = null;
    _state.activeTab = "ai";
    _state.dim = false;
    _state.dialogEl = opts.dialogEl || null;
    const avoid = opts.dialogEl ? computeAvoidingPos(opts.dialogEl) : null;
    if (avoid) {
      _state.pos = { x: avoid.x, y: avoid.y };
      _state.compact = true;
    } else {
      _state.pos = { x: null, y: null };
      _state.compact = false;
    }
    notify();
    return true;
  };
  return invoke;
}
let _heavyMounted = false;
function mountHeavyUI() {
  if (_heavyMounted) {
    return (opts) => {
      try {
        window.__aitiHelperInvoke(opts);
      } catch {
      }
      return true;
    };
  }
  _heavyMounted = true;
  const ctx = hostCtx();
  ctx?.registerItems?.("pages", [{ id: "aiti-helper-dialog", render: AiHelperDialog }]);
  return installInvokeEntry();
}
function tabStyle(active) {
  return {
    padding: "3px 10px",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 12,
    border: "1px solid " + (active ? "var(--accent,#2563eb)" : "transparent"),
    background: active ? "rgba(37,99,235,.12)" : "transparent",
    color: "inherit"
  };
}
function closeBtnStyle() {
  return { background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 17, padding: "0 4px", lineHeight: 1, flexShrink: 0 };
}
function btnStyle(variant) {
  const base = { padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, border: "1px solid var(--border,#e0e0e0)", background: "rgba(128,128,128,.08)", color: "inherit" };
  if (variant === "primary") {
    base.background = "rgba(37,99,235,.12)";
    base.borderColor = "var(--accent,#2563eb)";
    base.fontWeight = 500;
  }
  return base;
}
function inputStyle() {
  return { width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)", color: "inherit", fontSize: 12, outline: "none", boxSizing: "border-box" };
}
const SparkIcon = ({ size = 16 }) => {
  const mask = `url("${apiUrl("/api/extensions/aiti-helper/assets/icons/sparkles.svg")}")`;
  return /* @__PURE__ */ jsx("span", { "aria-hidden": true, style: {
    display: "inline-block",
    width: size,
    height: size,
    flexShrink: 0,
    background: "currentColor",
    WebkitMaskImage: mask,
    maskImage: mask,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain"
  } });
};
function prefetchPageId() {
  try {
    _state.isAiWin = window.name === "aiti-ai-popup" || !!window.__AITI_AI_WIN__;
  } catch {
  }
  let tries = 0;
  const attempt = () => {
    tries++;
    try {
      if (!window.BridgeClient || typeof window.BridgeClient.listSessions !== "function") {
        if (tries < 5) setTimeout(attempt, 1200 * tries);
        return;
      }
      window.BridgeClient.listSessions().then((rows) => {
        const active = (rows || []).filter((r) => r.active);
        const cur = active.find((r) => r.url && location.href && (r.url === location.href || location.href.startsWith(r.url))) || active.find((r) => r.self);
        if (cur && cur.pageId) {
          _state.pageId = cur.pageId;
          if (cur.self) _state.isAiWin = true;
          notify();
        } else if (tries < 5) setTimeout(attempt, 1200 * tries);
      }).catch(() => {
        if (tries < 5) setTimeout(attempt, 1200 * tries);
      });
    } catch {
      if (tries < 5) setTimeout(attempt, 1200 * tries);
    }
  };
  attempt();
}
function AiHelperDialog(props) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    _listeners.add(fn);
    return () => {
      _listeners.delete(fn);
    };
  }, []);
  const isOpen = _state.open;
  const opts = _state.opts || {};
  const [input, setInput] = useState("");
  const [followup, setFollowup] = useState("");
  const [turns, setTurns] = useState([]);
  const [helpers, setHelpers] = useState(null);
  const [extMeta, setExtMeta] = useState({});
  const [iconFail, setIconFail] = useState({});
  useEffect(() => {
    const o = _state.opts || {};
    if (o.message) setInput(String(o.message));
    if (!o.helperId) return;
    if (helpers && helpers.length) {
      const hit = helpers.find((x) => x && x.id === o.helperId);
      setSelHelper(hit || { id: o.helperId, title: o.helperId, optimistic: true });
    } else if (!helpers) {
      setSelHelper((prev) => prev && prev.id === o.helperId ? prev : { id: o.helperId, title: o.helperId, optimistic: true });
    }
  }, [_state.opts, helpers]);
  const [selHelper, setSelHelper] = useState(null);
  const [viewingSkill, setViewingSkill] = useState(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [showSkillForm, setShowSkillForm] = useState(false);
  const [skillForm, setSkillForm] = useState({ name: "", owner: "", title: "", summary: "", body: "" });
  const [savingSkill, setSavingSkill] = useState(false);
  const [skillMsg, setSkillMsg] = useState(null);
  const [historyList, setHistoryList] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [skillSearch, setSkillSearch] = useState("");
  const [monitor, setMonitor] = useState(null);
  const monitorRef = useRef(null);
  const [bgActive, setBgActive] = useState(null);
  const [restoreNote, setRestoreNote] = useState(null);
  const restoredRef = useRef(false);
  const taRef = useRef(null);
  const panelRef = useRef(null);
  const dragRef = useRef(null);
  const buildGroups = useCallback((list, extId, extName) => {
    if (!list || !list.length) return [];
    const byOwner = /* @__PURE__ */ new Map();
    for (const hp of list) {
      const o = hp.owner || "";
      if (!byOwner.has(o)) byOwner.set(o, []);
      byOwner.get(o).push(hp);
    }
    const groups = [];
    if (extId && byOwner.has(extId)) groups.push({ key: "ext:" + extId, label: "本扩展 · " + extDisplayName(extId, extName || extId), items: byOwner.get(extId), kind: "ext", extId });
    const genItems = [...byOwner.get("") || [], ...byOwner.get("aiti-helper") || []];
    if (genItems.length) groups.push({ key: "general", label: "通用 Skills", items: genItems, kind: "general", extId: "aiti-helper" });
    const others = [...byOwner.keys()].filter((o) => o && o !== "aiti-helper" && o !== extId).sort();
    for (const o of others) groups.push({ key: "other:" + o, label: extDisplayName(o, o), items: byOwner.get(o), kind: "other", extId: o });
    return groups;
  }, []);
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    fetch(apiUrl("/api/extensions/aiti-helper/helpers"), { cache: "no-store" }).then((r) => r.json()).then((d) => {
      if (alive && d.ok) setHelpers(d.helpers || []);
    }).catch(() => {
    });
    fetch(apiUrl("/api/extensions/manifest"), { cache: "no-store" }).then((r) => r.json()).then((d) => {
      if (!alive || !d || !Array.isArray(d.extensions)) return;
      const m = {};
      for (const e of d.extensions) {
        if (e && e.id) m[e.id] = { icon: e.icon || null };
      }
      setExtMeta(m);
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen || _state.activeTab !== "history") return;
    let alive = true;
    fetch(apiUrl("/api/extensions/aiti-helper/history?limit=50"), { cache: "no-store" }).then((r) => r.json()).then((d) => {
      if (alive && d.ok) setHistoryList(d.history || []);
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, [isOpen, _state.activeTab]);
  const loading = _state.loading;
  const result = _state.lastResult;
  const err = _state.error;
  const activeTab = _state.activeTab;
  const dim = _state.dim;
  const pos = _state.pos;
  const compact = _state.compact;
  const sessionCtx = {
    sessionId: props.currentSession?.id || props.sessionId || null,
    cwd: opts.cwd || props.activeCwd || props.currentSession?.cwd || props.cwd || null,
    sessionName: props.currentSession?.name || props.sessionName || null,
    model: props.model || null,
    inputValue: props.inputValue || null,
    isStreaming: props.isStreaming || false
  };
  const fetchResult = useCallback(async (sid) => {
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-helper/invoke/" + encodeURIComponent(sid) + "/result"), { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (d && d.ok) {
        _state.lastResult = d.text || "";
        _state.historyId = d.historyId || null;
      } else {
        _state.error = d && d.error || "取结果失败";
      }
    } catch (e) {
      _state.error = String(e.message || e);
    } finally {
      _state.loading = false;
      notify();
    }
  }, []);
  const openMonitor = useCallback((sid) => {
    if (monitorRef.current) {
      try {
        monitorRef.current.off();
      } catch {
      }
      monitorRef.current = null;
    }
    const detach = () => {
      if (monitorRef.current?.sid !== sid) return;
      try {
        monitorRef.current.off();
      } catch {
      }
      monitorRef.current = null;
    };
    const topics = extSvc("aiti-event-bus.subscribe-topics");
    if (!topics || typeof topics.subscribeTopics !== "function") {
      setMonitor(null);
      void fetchResult(sid);
      return;
    }
    const onFrame = (frame) => {
      const evt = frame?.evt;
      if (evt === "message_start") {
        const blocks = frame.message?.content;
        let txt = "";
        const tools = [];
        if (Array.isArray(blocks)) for (const b of blocks) {
          if (b && b.type === "text" && typeof b.text === "string") txt += b.text;
          if (b && b.type === "toolCall" && b.name) tools.push({ id: b.id || b.toolCallId, name: b.name, status: "running" });
        }
        setMonitor((m) => m && { ...m, text: txt || m.text, tools: tools.length ? tools : m.tools });
      } else if (evt === "message_update" && frame.assistantMessageEvent) {
        const ae = frame.assistantMessageEvent;
        if (ae.type === "text_delta") setMonitor((m) => m && { ...m, status: "thinking", text: (m.text || "") + (ae.delta || "") });
        else if (ae.type === "thinking_delta") setMonitor((m) => m && { ...m, thinking: (m.thinking || "") + (ae.delta || "") });
        else if (ae.type === "toolcall_start") setMonitor((m) => m && { ...m, status: "tool", tools: [...m.tools || [], { id: ae.id, name: ae.toolName, status: "running" }] });
        else if (ae.type === "toolcall_end") setMonitor((m) => m && { ...m, tools: (m.tools || []).map((t) => ae.toolCall && t.id === (ae.toolCall.id || ae.toolCall.toolCallId) ? { ...t, status: "done" } : t) });
      } else if (evt === "tool_execution_update") {
        setMonitor((m) => m && { ...m, status: "tool", tools: (m.tools || []).map((t) => t.id === frame.toolCallId ? { ...t, name: frame.toolName || t.name, status: "running", partial: frame.partialResult } : t) });
      } else if (evt === "agent_end") {
        setMonitor((m) => m && { ...m, status: "done", tools: (m.tools || []).map((t) => ({ ...t, status: "done" })) });
        detach();
        void fetchResult(sid);
      } else if (evt === "end" || evt === "unsupported") {
        detach();
        if (_state.loading) void fetchResult(sid);
      }
    };
    const sub = topics.subscribeTopics(onFrame, ["helper-" + sid], (status) => {
      if (status === "reconnecting") setMonitor((m) => m && (m.status === "done" ? m : { ...m, status: "reconnecting" }));
      else if (status === "up") setMonitor((m) => m && (m.status === "reconnecting" ? { ...m, status: "thinking" } : m));
    });
    monitorRef.current = { off: () => {
      try {
        sub.off();
      } catch {
      }
    }, sid };
    sub.ready.catch(() => {
      if (_state.loading && _state.sessionId === sid) void fetchResult(sid);
    });
  }, [fetchResult]);
  const goBackground = useCallback(() => {
    if (!_state.sessionId || !_state.loading) return;
    const sid = _state.sessionId;
    if (monitorRef.current) {
      try {
        monitorRef.current.off();
      } catch {
      }
      monitorRef.current = null;
    }
    _state.open = false;
    notify();
    try {
      const n = new Notification("AI Helper 后台执行中", { body: "任务在 session " + String(sid).slice(0, 8) + " 后台运行。从 🕘 历史或该会话可恢复查看。" });
      void n;
    } catch {
    }
  }, []);
  const restoreActive = useCallback((t) => {
    if (!t || !t.sessionId) return;
    const sid = String(t.sessionId);
    _state.sessionId = sid;
    _state.activeTab = "ai";
    _state.loading = true;
    _state.error = null;
    _state.lastResult = "";
    _state.historyId = null;
    setRestoreNote("已接回后台任务 · 第" + (t.turn || 1) + "轮执行中");
    setMonitor({ status: "connecting", text: "", thinking: "", tools: [], startedAt: Date.now() });
    notify();
    openMonitor(sid);
  }, [openMonitor]);
  useEffect(() => {
    if (!isOpen) {
      restoredRef.current = false;
      setRestoreNote(null);
      return;
    }
    if (restoredRef.current) return;
    restoredRef.current = true;
    fetch(apiUrl("/api/extensions/aiti-helper/active"), { cache: "no-store" }).then((r) => r.json()).then((d) => {
      if (d && d.ok) setBgActive(d.active || []);
    }).catch(() => {
    });
    const cur = props.currentSession?.id || props.sessionId || null;
    if (!cur) return;
    if (_state.opts?.message) return;
    let alive = true;
    fetch(apiUrl("/api/extensions/aiti-helper/origin/" + encodeURIComponent(cur)), { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (!alive || !d || !d.ok) return;
      const o = d.origin || {};
      if (o.message) setInput(String(o.message));
      if (o.helperId && helpers && helpers.length) setSelHelper(helpers.find((x) => x.id === o.helperId) || null);
      if (o.placeholder || o.contextLabel) {
        _state.opts = { ..._state.opts || {}, placeholder: o.placeholder || _state.opts?.placeholder, contextLabel: o.contextLabel || _state.opts?.contextLabel };
      }
      _state.sessionId = cur;
      if (d.status === "running") {
        setRestoreNote("已接回后台任务 · 第" + (o.turn || 1) + "轮执行中");
        _state.loading = true;
        _state.error = null;
        _state.lastResult = "";
        _state.historyId = null;
        setMonitor({ status: "connecting", text: "", thinking: "", tools: [], startedAt: Date.now() });
        notify();
        openMonitor(cur);
      } else if (d.result) {
        setRestoreNote("已恢复该会话上次结果（第" + (o.turn || 1) + "轮）");
        _state.lastResult = d.result.text || "";
        _state.historyId = d.result.historyId || null;
        _state.loading = false;
        notify();
      }
      notify();
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, [isOpen, helpers, props.currentSession, props.sessionId, openMonitor]);
  useEffect(() => {
    if (isOpen) return;
    if (monitorRef.current) {
      try {
        monitorRef.current.off();
      } catch {
      }
      monitorRef.current = null;
    }
  }, [isOpen]);
  const doInvoke = useCallback(async (isFollowup = false) => {
    prefetchPageId();
    const text = (isFollowup ? followup : input).trim();
    if (!text || loading) return;
    let prevTurns = turns;
    if (isFollowup && result) {
      prevTurns = [...turns, { message: input, result, system: selHelper?.system || opts.system }];
      setTurns(prevTurns);
      setInput(text);
      setFollowup("");
    }
    _state.loading = true;
    _state.error = null;
    _state.lastResult = "";
    _state.historyId = null;
    setRestoreNote(null);
    notify();
    setMonitor({ status: "connecting", text: "", thinking: "", tools: [], startedAt: Date.now() });
    try {
      let data = null;
      if (isFollowup && _state.sessionId) {
        const fr = await fetch(apiUrl("/api/extensions/aiti-helper/followup"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: _state.sessionId, message: text, contextLabel: opts.contextLabel || null })
        });
        data = await fr.json().catch(() => null);
        if (!data || !data.ok) {
          if (data && data.code === "session_gone") _state.sessionId = null;
          data = null;
        }
      }
      if (!data) {
        const r = await fetch(apiUrl("/api/extensions/aiti-helper/invoke"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            system: selHelper?.system || opts.system,
            message: text,
            contextLabel: opts.contextLabel || null,
            helperId: selHelper?.id || opts.helperId || null,
            placeholder: opts.placeholder || null,
            prevTurns,
            // 手工上下文（新建 session 时给 AI 前几轮要求与回复）
            sessionCtx,
            sourcePageId: _state.pageId || null,
            // 发起方 pageId（如 xxx/ai），报告给 AI
            sourceIsAiWin: _state.isAiWin || false
          })
        });
        data = await r.json();
      }
      if (!data.ok) throw new Error(data.error + (data.debug ? " | " + JSON.stringify(data.debug) : ""));
      const sid = data.sessionId;
      _state.sessionId = sid;
      openMonitor(sid);
      notify();
    } catch (e) {
      _state.error = String(e.message || e);
      _state.loading = false;
      setMonitor(null);
      notify();
    }
  }, [input, followup, turns, result, loading, opts, sessionCtx, selHelper, openMonitor]);
  const autoSentRef = useRef(null);
  useEffect(() => {
    const o = _state.opts;
    if (!o || !o.autoSend) return;
    if (autoSentRef.current === o) return;
    if (!o.message) return;
    if (input !== String(o.message)) return;
    autoSentRef.current = o;
    void doInvoke();
  }, [input, _state.opts]);
  const [landing, setLanding] = useState(null);
  const findField = useCallback((dialog, label) => {
    const els = dialog.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]');
    const key = String(label).toLowerCase().trim();
    if (!key) return null;
    let best = null;
    let bestScore = 0;
    for (const el of els) {
      const lblEl = el.closest("label");
      const labelText = lblEl ? (lblEl.textContent || "").trim().toLowerCase() : "";
      const ph = (el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("aria-label") || "").toLowerCase();
      const elName = (el.getAttribute("name") || "").toLowerCase();
      const elId = (el.id || "").toLowerCase();
      let score = 0;
      if (labelText === key) score = 4;
      else if (labelText && labelText.includes(key)) score = 3;
      else if (key.includes(labelText) && labelText.length >= 2) score = 2;
      if (ph === key) score = Math.max(score, 3);
      else if (ph && ph.includes(key)) score = Math.max(score, 1);
      if (elName === key) score = Math.max(score, 3);
      else if (elName && elName.includes(key)) score = Math.max(score, 1);
      if (elId === key) score = Math.max(score, 3);
      else if (elId && elId.includes(key)) score = Math.max(score, 1);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return bestScore >= 2 ? best : null;
  }, []);
  const setNativeValue = useCallback((el, value) => {
    const text = String(value == null ? "" : value);
    if (el.isContentEditable || el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT" && el.hasAttribute && el.hasAttribute("contenteditable")) {
      try {
        el.focus();
      } catch {
      }
      try {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {
      }
      let done = false;
      try {
        done = document.execCommand("insertText", false, text);
      } catch {
      }
      if (!done) {
        try {
          el.textContent = text;
        } catch {
        }
        try {
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
        } catch {
          try {
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } catch {
          }
        }
      }
      el.style.outline = "2px solid var(--accent,#2563eb)";
      el.style.outlineOffset = "1px";
      setTimeout(() => {
        el.style.outline = "";
      }, 1800);
      return;
    }
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    try {
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
    } catch {
      el.value = text;
    }
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    el.style.outline = "2px solid var(--accent,#2563eb)";
    el.style.outlineOffset = "1px";
    setTimeout(() => {
      el.style.outline = "";
    }, 1800);
  }, []);
  const doFill = useCallback((parsed, action) => {
    const dialog = _state.dialogEl;
    if (!dialog || !document.body.contains(dialog)) {
      setLanding({ status: "err", msg: "原弹窗已关闭，无法回填（请从弹窗 AI 按钮唤起）" });
      return 0;
    }
    const fields = action.fields || null;
    const mapping = action.mapping || null;
    let filled = 0;
    for (const [aiKey, val] of Object.entries(parsed)) {
      if (val === void 0 || val === null) continue;
      let targetLabel = null;
      if (Array.isArray(fields) && typeof fields[0] === "object") {
        const f = fields.find((x) => x.key === aiKey || x.label && String(x.label).toLowerCase() === aiKey.toLowerCase());
        if (f) targetLabel = f.label || aiKey;
      } else if (Array.isArray(fields)) {
        if (!fields.some((x) => String(x).toLowerCase() === aiKey.toLowerCase())) continue;
        targetLabel = aiKey;
      } else if (mapping) {
        targetLabel = mapping[aiKey] || aiKey;
      } else {
        targetLabel = aiKey;
      }
      const el = findField(dialog, targetLabel || aiKey);
      if (el) {
        setNativeValue(el, val);
        filled++;
      }
    }
    return filled;
  }, [findField, setNativeValue]);
  const doLand = useCallback(async (resultText, helper, historyId) => {
    if (!resultText || !helper?.action) {
      setLanding({ status: "err", msg: "该条无落地动作（自由发挥结果）" });
      return;
    }
    const action = helper.action;
    let parsed = null;
    try {
      let t = resultText.trim();
      t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      parsed = JSON.parse(t);
    } catch (e) {
      setLanding({ status: "err", msg: "结果不是有效 JSON：" + (e.message || e) });
      return;
    }
    if (action.type === "fill") {
      const source = parsed && typeof parsed === "object" && parsed.filled && typeof parsed.filled === "object" ? parsed.filled : parsed;
      const filled = doFill(source, action);
      const detail = filled > 0 ? "已回填 " + filled + " 个表单字段" + (parsed.note ? "（" + parsed.note + "）" : "") : parsed.note ? parsed.note : "没有可回填的字段（AI 输出需为 {字段:值} JSON）";
      setLanding({ status: filled > 0 ? "ok" : "info", msg: detail });
      if (historyId) {
        try {
          await fetch(apiUrl("/api/extensions/aiti-helper/history/" + historyId + "/land"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ detail }) });
        } catch {
        }
      }
      return;
    }
    try {
      const body = {};
      if (action.mapping) {
        for (const [aiKey, apiKey] of Object.entries(action.mapping)) {
          if (parsed[aiKey] !== void 0) body[apiKey] = parsed[aiKey];
        }
      } else {
        Object.assign(body, parsed);
      }
      let path = action.path.startsWith("/api/") ? action.path : "/api/" + action.path;
      const placeholders = path.match(/\{[a-zA-Z0-9_]+\}/g) || [];
      for (const ph of placeholders) {
        const key = ph.slice(1, -1);
        if (body[key] !== void 0) {
          path = path.replace(ph, encodeURIComponent(String(body[key])));
          delete body[key];
        }
      }
      const url = apiUrl(path);
      const r = await fetch(url, {
        method: action.method || "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || d && d.ok === false) {
        setLanding({ status: "err", msg: "入库失败：" + (d && d.error || r.status) });
      } else {
        const detail = "已入库" + (d && d.command ? "：「" + (d.command.name || d.command.cmd) + "」" : "");
        setLanding({ status: "ok", msg: detail });
        if (historyId) {
          try {
            await fetch(apiUrl("/api/extensions/aiti-helper/history/" + historyId + "/land"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ detail }) });
          } catch {
          }
        }
      }
    } catch (e) {
      setLanding({ status: "err", msg: "入库异常：" + (e.message || e) });
    }
  }, [doFill]);
  const adoptChat = useCallback((text) => {
    if (!text) return;
    try {
      mcCtx?.sendChatMessage(text, "steer");
    } catch {
    }
    closePanel();
  }, []);
  const copyResult = useCallback((text) => {
    if (!text) return;
    try {
      navigator.clipboard.writeText(text);
    } catch {
    }
  }, []);
  const retry = useCallback(() => {
    if (monitorRef.current) {
      try {
        monitorRef.current.off();
      } catch {
      }
      monitorRef.current = null;
    }
    setMonitor(null);
    setRestoreNote(null);
    _state.lastResult = "";
    _state.error = null;
    _state.loading = false;
    _state.historyId = null;
    notify();
    setTurns([]);
    setFollowup("");
    if (taRef.current) taRef.current.focus();
  }, []);
  const viewSkill = useCallback(async (helper) => {
    if (!helper || !helper.id) return;
    setSkillLoading(true);
    setViewingSkill({ id: helper.id, title: helper.title || helper.id, body: "", summary: helper.summary || "" });
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-helper/skill/" + encodeURIComponent(helper.id)), { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setViewingSkill({ id: helper.id, title: d.helper?.title || helper.title || helper.id, body: d.body || "", summary: d.helper?.summary || helper.summary || "", meta: d.meta || {}, tools: d.tools || null });
      else setViewingSkill((v) => v && { ...v, body: "", err: d.error || "读取失败" });
    } catch {
      setViewingSkill((v) => v && { ...v, body: "", err: "读取失败" });
    }
    setSkillLoading(false);
  }, []);
  const closeSkillView = useCallback(() => setViewingSkill(null), []);
  const saveUserSkill = useCallback(async () => {
    const name = (skillForm.name || "").trim();
    if (!name) {
      setSkillMsg({ status: "err", msg: "请填写 skill 名" });
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setSkillMsg({ status: "err", msg: "skill 名只能用字母/数字/下划线/连字符" });
      return;
    }
    setSavingSkill(true);
    setSkillMsg(null);
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-helper/user-skills"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, owner: (skillForm.owner || "").trim() || void 0, title: (skillForm.title || name).trim(), summary: (skillForm.summary || "").trim() || void 0, body: skillForm.body || "" })
      });
      const d = await r.json();
      if (!d.ok) {
        setSkillMsg({ status: "err", msg: d.error || "保存失败" });
        return;
      }
      setSkillMsg({ status: "ok", msg: "✅ 已保存到 data 目录（归属 " + (d.skill?.owner || "aiti-helper") + "）" });
      const hr = await fetch(apiUrl("/api/extensions/aiti-helper/helpers"), { cache: "no-store" });
      const hd = await hr.json();
      if (hd.ok) setHelpers(hd.helpers || []);
      setSkillForm({ name: "", owner: "", title: "", summary: "", body: "" });
    } catch (e) {
      setSkillMsg({ status: "err", msg: "保存失败: " + (e.message || e) });
    }
    setSavingSkill(false);
  }, [skillForm]);
  const closeSkillForm = useCallback(() => {
    setShowSkillForm(false);
    setSkillMsg(null);
  }, []);
  const restoreHistory = useCallback((h) => {
    _state.lastResult = h.result;
    _state.historyId = h.id;
    _state.error = null;
    _state.activeTab = "ai";
    _state.opts = { contextLabel: h.contextLabel || (h.helperId ? h.helperId : null) };
    if (h.message) setInput(h.message);
    setTurns([]);
    setFollowup("");
    _state.sessionId = h.agentSessionId || null;
    if (h.helperId && helpers) setSelHelper(helpers.find((x) => x.id === h.helperId) || null);
    setLanding(null);
    notify();
  }, [helpers]);
  const onDragStart = useCallback((e) => {
    if (e.target.closest("button, textarea, input, pre, select")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
    const onMove = (ev) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      _state.pos = { x: dragRef.current.origX + dx, y: dragRef.current.origY + dy };
      notify();
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  const onOverlayClick = useCallback((e) => {
    const panel = panelRef.current;
    if (panel && panel.contains(e.target)) {
      _state.dim = false;
      notify();
    } else {
      _state.dim = true;
      notify();
    }
  }, []);
  if (!isOpen) return null;
  const fmtTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const panelLeft = pos.x != null ? pos.x : null;
  const panelTop = pos.y != null ? pos.y : null;
  const skillGroups = buildGroups(helpers || [], opts.extId || "", opts.extName || "");
  const skillSearchLc = skillSearch.trim().toLowerCase();
  const matchSearch = (hp) => !skillSearchLc || (hp.title || "").toLowerCase().includes(skillSearchLc) || (hp.summary || "").toLowerCase().includes(skillSearchLc) || (hp.id || "").toLowerCase().includes(skillSearchLc);
  const groupIsCollapsed = (g) => g.key in collapsedGroups ? !!collapsedGroups[g.key] : true;
  const allExpandedNow = skillGroups.length > 0 && skillGroups.every((g) => !groupIsCollapsed(g));
  const skillToolbar = activeTab === "ai" && !viewingSkill && !showSkillForm && skillGroups.length > 0;
  const groupHeader = (g, collapsed) => {
    const expanded = !collapsed;
    const rawIcon = extMeta[g.extId]?.icon || (g.extId ? "icon.svg" : null);
    const isFileIcon = !!rawIcon && /\.[a-zA-Z0-9]+$/.test(rawIcon);
    const iconSrc = rawIcon && isFileIcon && g.extId ? apiUrl("/api/extensions/" + g.extId + "/assets/" + rawIcon) : null;
    const showLogo = !!iconSrc && !iconFail[g.extId];
    const emojiIcon = rawIcon && !isFileIcon ? rawIcon : null;
    return /* @__PURE__ */ jsxs(
      "button",
      {
        onClick: () => {
          setCollapsedGroups((m) => ({ ...m, [g.key]: !collapsed }));
          notify();
        },
        title: (expanded ? "收起 " : "展开 ") + g.label + " 的 skills",
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
          userSelect: "none",
          padding: "3px 8px",
          borderRadius: 8,
          fontSize: 11,
          fontWeight: 700,
          flexShrink: 0,
          maxWidth: "100%",
          border: "1px solid " + (g.kind === "ext" || expanded ? "var(--accent,#2563eb)" : "rgba(128,128,128,.38)"),
          background: g.kind === "ext" || expanded ? "rgba(37,99,235,.14)" : "rgba(128,128,128,.18)",
          color: g.kind === "ext" || expanded ? "var(--accent,#2563eb)" : "inherit"
        },
        children: [
          showLogo ? /* @__PURE__ */ jsx(
            "img",
            {
              src: iconSrc,
              alt: "",
              width: 12,
              height: 12,
              onError: () => setIconFail((m) => m[g.extId] ? m : { ...m, [g.extId]: true }),
              style: { width: 12, height: 12, objectFit: "contain", flexShrink: 0, pointerEvents: "none" }
            }
          ) : emojiIcon ? /* @__PURE__ */ jsx("span", { style: { fontSize: 11, lineHeight: 1, flexShrink: 0 }, children: emojiIcon }) : g.kind === "general" ? /* @__PURE__ */ jsx("span", { style: { display: "inline-flex", flexShrink: 0 }, children: /* @__PURE__ */ jsx(SparkIcon, { size: 11 }) }) : /* @__PURE__ */ jsx("span", { style: { display: "inline-flex", width: 9, flexShrink: 0, transition: "transform .15s", transform: expanded ? "rotate(90deg)" : "none" }, children: /* @__PURE__ */ jsx(Ic, { size: 9, paths: ICONS.chevron }) }),
          /* @__PURE__ */ jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: g.label }),
          /* @__PURE__ */ jsx("span", { style: {
            fontSize: 10,
            fontWeight: 600,
            flexShrink: 0,
            lineHeight: 1,
            padding: "2px 5px",
            borderRadius: 7,
            background: g.kind === "ext" || expanded ? "rgba(37,99,235,.18)" : "rgba(128,128,128,.22)"
          }, children: g.items.length }),
          (() => {
            const ot = g.items.find((x) => x.ownerTools && x.ownerTools.total > 0)?.ownerTools;
            if (!ot || ot.total <= 0) return null;
            const pend = ot.pending > 0;
            return /* @__PURE__ */ jsxs(
              "span",
              {
                title: `共 ${ot.total} 个 AI 工具，当前待启用 ${ot.pending} 个（默认关；经 🤖 执行该扩展的 skill 时自动带上）`,
                style: {
                  fontSize: 10,
                  fontWeight: 600,
                  flexShrink: 0,
                  lineHeight: 1,
                  padding: "2px 5px",
                  borderRadius: 7,
                  background: pend ? "rgba(250,204,21,.18)" : "rgba(128,128,128,.22)",
                  color: pend ? "var(--warn,#b45309)" : "inherit",
                  border: pend ? "1px solid rgba(250,204,21,.5)" : "1px solid transparent"
                },
                children: [
                  "(",
                  pend ? ot.pending : ot.total,
                  ")"
                ]
              }
            );
          })()
        ]
      },
      "hdr-" + g.key
    );
  };
  const chip = (hp, kind) => /* @__PURE__ */ jsx(
    "button",
    {
      onClick: () => {
        setSelHelper(selHelper && selHelper.id === hp.id ? null : hp);
        if (hp.placeholder) {
          if (_state.opts) _state.opts.placeholder = hp.placeholder;
          notify();
        }
      },
      title: hp.summary || "",
      style: {
        // skill chip：与扩展分组头（方角+填充+加粗）反向区分——全圆角、透明底、常规字重、淡描边
        padding: "3px 10px",
        borderRadius: 999,
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 400,
        border: "1px solid " + (hp.user ? "rgba(250,204,21,.6)" : selHelper && selHelper.id === hp.id ? "var(--accent,#2563eb)" : "rgba(128,128,128,.32)"),
        background: hp.user ? "rgba(250,204,21,.08)" : selHelper && selHelper.id === hp.id ? "rgba(37,99,235,.12)" : "transparent",
        color: "inherit"
      },
      children: (selHelper && selHelper.id === hp.id ? "✓ " : "") + (hp.user ? "✦ " : "") + hp.title
    },
    hp.id
  );
  return /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, zIndex: 2147483647, pointerEvents: "none" }, onClick: onOverlayClick, children: /* @__PURE__ */ jsxs(
    "div",
    {
      ref: panelRef,
      onMouseDown: onDragStart,
      style: {
        position: "fixed",
        zIndex: 2147483647,
        left: panelLeft != null ? panelLeft + "px" : "auto",
        top: panelTop != null ? panelTop + "px" : "72px",
        right: panelLeft != null ? "auto" : "16px",
        width: compact ? "min(420px, 90vw)" : "min(580px, 90vw)",
        maxHeight: compact ? "70vh" : "78vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg,#fff)",
        color: "var(--text,#1a1a1a)",
        border: "1px solid var(--border,#e0e0e0)",
        borderRadius: 14,
        boxShadow: "0 16px 64px rgba(0,0,0,.25)",
        opacity: dim ? 0.45 : 1,
        transition: "opacity .2s",
        pointerEvents: "auto",
        overflow: "hidden"
      },
      children: [
        /* @__PURE__ */ jsxs("div", { style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "move",
          padding: "10px 14px",
          borderBottom: "1px solid var(--border,#e0e0e0)",
          flexShrink: 0,
          userSelect: "none"
        }, children: [
          /* @__PURE__ */ jsxs("span", { style: { fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5 }, children: [
            /* @__PURE__ */ jsx(SparkIcon, { size: 15 }),
            " ",
            "AI Helper"
          ] }),
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 2, marginLeft: 12 }, children: [
            /* @__PURE__ */ jsx("button", { onClick: () => {
              _state.activeTab = "ai";
              notify();
            }, title: "AI 助手", style: tabStyle(activeTab === "ai"), children: "助手" }, "ai"),
            /* @__PURE__ */ jsx("button", { onClick: () => {
              _state.activeTab = "history";
              notify();
            }, title: "执行历史", style: tabStyle(activeTab === "history"), children: "历史" }, "hist")
          ] }, "tabs"),
          opts.contextLabel ? /* @__PURE__ */ jsx("span", { style: { fontSize: 10, opacity: 0.55, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: opts.contextLabel }, "ctx") : /* @__PURE__ */ jsx("span", { style: { flex: 1 } }, "ctx-empty"),
          skillToolbar ? /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => {
                setCollapsedGroups(Object.fromEntries(skillGroups.map((g) => [g.key, allExpandedNow])));
                notify();
              },
              title: allExpandedNow ? "收起全部" : "展开全部",
              style: closeBtnStyle(),
              children: /* @__PURE__ */ jsx(Ic, { size: 14, paths: ICONS.expand })
            },
            "sk-expand"
          ) : null,
          skillToolbar ? /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => {
                setShowSkillForm(true);
                setSelHelper(null);
              },
              title: "新增 Skill（存 data 目录）",
              style: closeBtnStyle(),
              children: /* @__PURE__ */ jsx(Ic, { size: 14, paths: ICONS.plus })
            },
            "sk-new"
          ) : null,
          /* @__PURE__ */ jsx("button", { onClick: closePanel, title: "关闭（历史已保存，可随时从 🕘 历史找回）", style: closeBtnStyle(), children: /* @__PURE__ */ jsx(Ic, { size: 12, paths: ICONS.x }) }, "close")
        ] }, "header"),
        /* @__PURE__ */ jsxs("div", { style: { padding: 14, display: "flex", flexDirection: "column", gap: 10, overflow: "auto", flex: 1 }, children: [
          activeTab === "ai" ? viewingSkill ? (
            /* 技能说明面板（查看某帮助点做什么） */
            /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 10 }, children: [
              /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
                /* @__PURE__ */ jsxs("span", { style: { fontSize: 13, fontWeight: 600, flex: 1, display: "inline-flex", alignItems: "center", gap: 5 }, children: [
                  /* @__PURE__ */ jsx(Ic, { size: 13, paths: ICONS.help }),
                  viewingSkill.title
                ] }),
                /* @__PURE__ */ jsx("button", { onClick: closeSkillView, style: btnStyle(), children: "← 返回" })
              ] }),
              viewingSkill.summary ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, opacity: 0.75, background: "var(--bg-subtle,#f5f5f5)", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)" }, children: viewingSkill.summary }) : null,
              viewingSkill.tools && viewingSkill.tools.total > 0 ? (() => {
                const pend = viewingSkill.tools.pending > 0;
                return /* @__PURE__ */ jsxs("div", { style: {
                  fontSize: 12,
                  background: pend ? "rgba(250,204,21,.08)" : "var(--bg-subtle,#f5f5f5)",
                  border: "1px solid " + (pend ? "rgba(250,204,21,.4)" : "var(--border,#e0e0e0)"),
                  borderRadius: 8,
                  padding: "8px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6
                }, children: [
                  /* @__PURE__ */ jsxs("div", { style: { opacity: 0.9, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }, children: [
                    /* @__PURE__ */ jsx(Ic, { size: 12, paths: ICONS.wrench }),
                    /* @__PURE__ */ jsx("span", { style: { fontWeight: 600 }, children: "AI 工具" }),
                    /* @__PURE__ */ jsxs("span", { style: { opacity: 0.7 }, children: [
                      "共 ",
                      viewingSkill.tools.total,
                      " 个",
                      pend ? ` · 当前待启用 ${viewingSkill.tools.pending} 个` : " · 已全部启用"
                    ] })
                  ] }),
                  /* @__PURE__ */ jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 }, children: (viewingSkill.tools.names || []).map((n) => /* @__PURE__ */ jsx("code", { style: {
                    fontSize: 11,
                    background: "rgba(128,128,128,.14)",
                    padding: "1px 6px",
                    borderRadius: 5,
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    color: "inherit"
                  }, children: n }, n)) }),
                  pend ? /* @__PURE__ */ jsx("div", { style: { fontSize: 11, opacity: 0.7 }, children: "💡 默认关：点「执行」经本 skill 建的任务会话会自动带上这些工具（会话级，用完即还原，不全局开启）。" }) : null
                ] });
              })() : null,
              skillLoading ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, opacity: 0.6 }, children: "加载说明…" }) : null,
              viewingSkill.err ? /* @__PURE__ */ jsxs("div", { style: { color: "#ef4444", fontSize: 12 }, children: [
                "⚠️ ",
                viewingSkill.err
              ] }) : null,
              viewingSkill.body ? /* @__PURE__ */ jsx("pre", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "12px 14px", background: "var(--bg-subtle,#f5f5f5)", color: "inherit", borderRadius: 8, fontSize: 12, lineHeight: 1.6, border: "1px solid var(--border,#e0e0e0)", maxHeight: 320, overflow: "auto", margin: 0 }, children: viewingSkill.body }) : null
            ] })
          ) : showSkillForm ? (
            /* 新增 skill 表单（用户自己给扩展加 skill，存 data 目录） */
            /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 10 }, children: [
              /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
                /* @__PURE__ */ jsxs("span", { style: { fontSize: 13, fontWeight: 600, flex: 1, display: "inline-flex", alignItems: "center", gap: 5 }, children: [
                  /* @__PURE__ */ jsx(Ic, { size: 13, paths: ICONS.plus }),
                  "新增 Skill"
                ] }),
                /* @__PURE__ */ jsx("button", { onClick: closeSkillForm, style: btnStyle(), children: "← 返回" })
              ] }),
              /* @__PURE__ */ jsx("div", { style: { fontSize: 11, opacity: 0.6 }, children: "自定义 skill 存到 data 目录（不覆盖任何扩展的部署产物）；归属扩展不打标签则默认归 ai-helper。" }),
              /* @__PURE__ */ jsx("label", { style: { fontSize: 12, opacity: 0.8 }, children: "名称（必填，字母/数字/_/-）" }),
              /* @__PURE__ */ jsx("input", { value: skillForm.name, onInput: (e) => setSkillForm((f) => ({ ...f, name: e.target.value })), placeholder: "如 session-archive-30d", style: inputStyle() }),
              /* @__PURE__ */ jsx("label", { style: { fontSize: 12, opacity: 0.8 }, children: "归属扩展（不指定归 ai-helper）" }),
              /* @__PURE__ */ jsxs("select", { value: skillForm.owner, onInput: (e) => setSkillForm((f) => ({ ...f, owner: e.target.value })), style: { ...inputStyle(), padding: "7px 10px" }, children: [
                /* @__PURE__ */ jsx("option", { value: "", children: "（不指定 · 归 ai-helper）" }, "__none__"),
                (helpers || []).filter((x) => x.owner && x.owner !== "aiti-helper").map((x) => x.owner).filter((v, i, a) => a.indexOf(v) === i).map((o) => /* @__PURE__ */ jsx("option", { value: o, children: o }, o))
              ] }),
              /* @__PURE__ */ jsx("label", { style: { fontSize: 12, opacity: 0.8 }, children: "显示标题（可空，默认用名称）" }),
              /* @__PURE__ */ jsx("input", { value: skillForm.title, onInput: (e) => setSkillForm((f) => ({ ...f, title: e.target.value })), placeholder: "如 AI 帮我归档 30 天会话", style: inputStyle() }),
              /* @__PURE__ */ jsx("label", { style: { fontSize: 12, opacity: 0.8 }, children: "一句话说明（可空）" }),
              /* @__PURE__ */ jsx("input", { value: skillForm.summary, onInput: (e) => setSkillForm((f) => ({ ...f, summary: e.target.value })), placeholder: "这个 skill 能做什么", style: inputStyle() }),
              /* @__PURE__ */ jsx("label", { style: { fontSize: 12, opacity: 0.8 }, children: "正文手册（可空；可让 AI 帮你写）" }),
              /* @__PURE__ */ jsx("textarea", { value: skillForm.body, onInput: (e) => setSkillForm((f) => ({ ...f, body: e.target.value })), placeholder: "SKILL.md 正文（任务说明、API、输出格式…）。留空则先建骨架，再用「AI 帮我新增/修改 skill」补全。", style: { ...inputStyle(), minHeight: 90, resize: "vertical", lineHeight: 1.5 } }),
              skillMsg ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, padding: "7px 10px", borderRadius: 6, background: skillMsg.status === "ok" ? "rgba(16,185,129,.12)" : "rgba(239,68,68,.12)", color: skillMsg.status === "ok" ? "#16a34a" : "#dc2626" }, children: skillMsg.msg }) : null,
              /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, marginTop: 4 }, children: [
                /* @__PURE__ */ jsx("button", { onClick: () => saveUserSkill(), disabled: savingSkill, style: btnStyle("primary"), children: savingSkill ? "保存中…" : "💾 保存" }),
                /* @__PURE__ */ jsxs("button", { onClick: () => {
                  setShowSkillForm(false);
                  setSelHelper(helpers && helpers.find((x) => x.id === "skill-manage") || null);
                }, style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }, children: [
                  /* @__PURE__ */ jsx(Ic, { size: 13, paths: ICONS.bot }),
                  "让 AI 写"
                ] })
              ] })
            ] })
          ) : /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 10 }, children: [
            restoreNote ? /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, padding: "5px 10px", borderRadius: 6, background: "rgba(37,99,235,.10)", border: "1px solid rgba(37,99,235,.3)", color: "inherit" }, children: [
              "↩ ",
              restoreNote
            ] }) : null,
            bgActive && bgActive.length ? /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, padding: "5px 10px", borderRadius: 6, background: "rgba(245,158,11,.10)", border: "1px solid rgba(245,158,11,.35)", color: "inherit", display: "flex", flexDirection: "column", gap: 2 }, children: [
              /* @__PURE__ */ jsxs("span", { children: [
                "🕘 ",
                bgActive.length,
                " 个后台任务执行中"
              ] }),
              bgActive.slice(0, 3).map((t) => /* @__PURE__ */ jsxs(
                "button",
                {
                  onClick: () => restoreActive(t),
                  title: "接回此会话的实时进度",
                  style: { textAlign: "left", background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 11, padding: 0, opacity: 0.8 },
                  children: [
                    "· ",
                    String(t.sessionId).slice(0, 8),
                    "「",
                    (t.message || "").slice(0, 30),
                    "」"
                  ]
                },
                t.sessionId
              ))
            ] }) : null,
            !skillGroups.length && helpers === null ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, opacity: 0.6 }, children: "加载帮助点…" }) : null,
            !skillGroups.length && helpers !== null ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, opacity: 0.6 }, children: "暂无 skills（可新增自定义）" }) : null,
            skillGroups.length ? /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
              /* @__PURE__ */ jsx(
                "input",
                {
                  value: skillSearch,
                  onInput: (e) => setSkillSearch(e.target.value),
                  placeholder: "搜索 skills…（标题 / 说明 / id）",
                  style: {
                    width: "100%",
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--border,#e0e0e0)",
                    background: "var(--bg-subtle,#f5f5f5)",
                    color: "inherit",
                    fontSize: 12,
                    outline: "none",
                    boxSizing: "border-box"
                  }
                }
              ),
              /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }, children: [
                skillGroups.map((g) => {
                  const items = skillSearchLc ? g.items.filter(matchSearch) : g.items;
                  if (skillSearchLc && !items.length) return null;
                  const collapsed = groupIsCollapsed(g) && !skillSearchLc;
                  return /* @__PURE__ */ jsxs("div", { style: {
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    alignItems: "center",
                    flexBasis: collapsed ? "auto" : "100%",
                    minWidth: 0,
                    maxWidth: "100%"
                  }, children: [
                    groupHeader(g, collapsed),
                    collapsed ? null : items.map((hp) => chip(hp, g.kind))
                  ] }, g.key);
                }),
                skillSearchLc && !skillGroups.some((g) => g.items.some(matchSearch)) ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, opacity: 0.55, padding: "4px 2px" }, children: "无匹配 skill" }) : null
              ] })
            ] }) : null,
            selHelper ? /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 2 }, children: [
              /* @__PURE__ */ jsxs("span", { style: { fontSize: 12, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 }, children: [
                /* @__PURE__ */ jsx(SparkIcon, { size: 12 }),
                " 已选：" + selHelper.title
              ] }),
              /* @__PURE__ */ jsxs(
                "button",
                {
                  onClick: () => viewSkill(selHelper),
                  title: "查看这个帮助点（skill）能做什么",
                  style: {
                    padding: "6px 14px",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    border: "1px dashed var(--border,#e0e0e0)",
                    background: "rgba(128,128,128,.07)",
                    color: "inherit",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4
                  },
                  children: [
                    /* @__PURE__ */ jsx(Ic, { size: 13, paths: ICONS.help }),
                    "看看它能做什么"
                  ]
                }
              )
            ] }) : null,
            /* @__PURE__ */ jsx(
              "textarea",
              {
                ref: taRef,
                value: input,
                onInput: (e) => setInput(e.target.value),
                placeholder: opts.placeholder || "描述你想让 AI 做什么…",
                disabled: loading,
                style: {
                  width: "100%",
                  minHeight: 110,
                  maxHeight: 220,
                  resize: "vertical",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border,#e0e0e0)",
                  background: "var(--bg-subtle,#f5f5f5)",
                  color: "inherit",
                  fontSize: 13,
                  lineHeight: 1.5,
                  boxSizing: "border-box",
                  outline: "none",
                  opacity: loading ? 0.6 : 1
                },
                onDoubleClick: () => {
                  const ph = opts.placeholder || "描述你想让 AI 做什么…";
                  if (!input) setInput(ph);
                },
                onKeyDown: (e) => {
                  const ph = opts.placeholder || "描述你想让 AI 做什么…";
                  if (e.key === "Tab") {
                    e.preventDefault();
                    if (!input) setInput(ph);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    doInvoke();
                  }
                }
              }
            ),
            /* @__PURE__ */ jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }, children: [
              loading ? /* @__PURE__ */ jsxs(
                "button",
                {
                  onClick: goBackground,
                  title: "隐藏弹窗，AI 继续在后台执行（可从历史或该会话恢复）",
                  style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 },
                  children: [
                    /* @__PURE__ */ jsx(Ic, { size: 13, paths: ICONS.moon }),
                    "后台执行"
                  ]
                }
              ) : /* @__PURE__ */ jsx("span", {}),
              /* @__PURE__ */ jsx(
                "button",
                {
                  onClick: () => doInvoke(),
                  disabled: loading || !input.trim(),
                  style: {
                    padding: "6px 15px",
                    borderRadius: 8,
                    cursor: "pointer",
                    border: "1px solid var(--accent,#2563eb)",
                    background: loading ? "rgba(37,99,235,.08)" : "rgba(37,99,235,.12)",
                    color: "inherit",
                    fontSize: 13,
                    fontWeight: 500,
                    opacity: loading || !input.trim() ? 0.5 : 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5
                  },
                  children: loading ? "⏳ 执行中…" : /* @__PURE__ */ jsxs(Fragment, { children: [
                    /* @__PURE__ */ jsx(SparkIcon, { size: 13 }),
                    "执行"
                  ] })
                }
              )
            ] }),
            loading && monitor ? (() => {
              const sl = { connecting: "🔌 正在连接 AI 会话…", thinking: "🤔 AI 思考中…", tool: "🔧 调用工具…", done: "✅ 完成", reconnecting: "🔄 重新连接…" };
              return /* @__PURE__ */ jsxs("div", { style: { border: "1px solid var(--border,#e0e0e0)", borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }, children: [
                /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500 }, children: [
                  /* @__PURE__ */ jsx("span", { style: { width: 7, height: 7, borderRadius: "50%", background: monitor.status === "done" ? "#16a34a" : "var(--accent,#2563eb)", flexShrink: 0, opacity: monitor.status === "done" ? 1 : 0.85 } }),
                  /* @__PURE__ */ jsx("span", { style: { flex: 1 }, children: sl[monitor.status] || "执行中…" }),
                  _state.sessionId ? /* @__PURE__ */ jsxs("span", { style: { fontSize: 10, opacity: 0.5 }, children: [
                    "session ",
                    String(_state.sessionId).slice(0, 8)
                  ] }) : null
                ] }),
                monitor.tools && monitor.tools.length ? /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: monitor.tools.map((t, i) => /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, display: "flex", alignItems: "center", gap: 5, minWidth: 0 }, children: [
                  /* @__PURE__ */ jsx("span", { style: { color: t.status === "done" ? "#16a34a" : "var(--accent,#2563eb)", flexShrink: 0 }, children: t.status === "done" ? "✓" : "▹" }),
                  /* @__PURE__ */ jsx("span", { style: { opacity: 0.85, flexShrink: 0 }, children: t.name }),
                  t.partial ? /* @__PURE__ */ jsx("span", { style: { opacity: 0.5, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }, children: String(t.partial).replace(/\s+/g, " ").slice(0, 80) }) : null
                ] }, i)) }) : null,
                monitor.text ? /* @__PURE__ */ jsx("pre", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, fontSize: 12, lineHeight: 1.5, maxHeight: 160, overflow: "auto", color: "inherit" }, children: monitor.text }) : monitor.thinking ? /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, opacity: 0.55, fontStyle: "italic", maxHeight: 60, overflow: "auto" }, children: [
                  "💭 ",
                  String(monitor.thinking).slice(-200)
                ] }) : null
              ] });
            })() : null,
            err ? /* @__PURE__ */ jsxs("div", { style: { color: "#ef4444", fontSize: 12, padding: "7px 10px", background: "rgba(239,68,68,.1)", borderRadius: 6 }, children: [
              "❌ ",
              err
            ] }) : null,
            result ? /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, opacity: 0.6, marginBottom: 5, display: "inline-flex", alignItems: "center", gap: 4 }, children: [
                /* @__PURE__ */ jsx(Ic, { size: 12, paths: ICONS.copy }),
                " 结果预览（审核后落地；关闭后可在历史找回）"
              ] }),
              /* @__PURE__ */ jsx("pre", { style: {
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                padding: "10px 12px",
                background: "var(--bg-subtle,#f5f5f5)",
                color: "inherit",
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.5,
                border: "1px solid var(--border,#e0e0e0)",
                maxHeight: 220,
                overflow: "auto",
                margin: 0
              }, children: result }),
              /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }, children: [
                selHelper?.action ? /* @__PURE__ */ jsx("button", { onClick: () => doLand(result, selHelper, _state.historyId), style: btnStyle("primary"), children: selHelper.action.type === "fill" ? "📝 回填弹窗" : "📥 入库" }) : null,
                /* @__PURE__ */ jsxs("button", { onClick: () => adoptChat(result), style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }, children: [
                  /* @__PURE__ */ jsx(Ic, { size: 13, paths: ICONS.msg }),
                  "填入聊天框"
                ] }),
                /* @__PURE__ */ jsxs("button", { onClick: () => copyResult(result), style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }, children: [
                  /* @__PURE__ */ jsx(Ic, { size: 13, paths: ICONS.copy }),
                  "复制"
                ] }),
                /* @__PURE__ */ jsxs("button", { onClick: retry, style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }, children: [
                  /* @__PURE__ */ jsx(Ic, { size: 13, paths: ICONS.refresh }),
                  "重来"
                ] })
              ] }),
              /* @__PURE__ */ jsxs("div", { style: { marginTop: 10, display: "flex", gap: 8, alignItems: "flex-start" }, children: [
                /* @__PURE__ */ jsx(
                  "input",
                  {
                    value: followup,
                    onInput: (e) => setFollowup(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        doInvoke(true);
                      }
                    },
                    placeholder: "不满意？输入追加要求继续，如「改成中文输出」「加个确认」「再详细点」…",
                    disabled: loading,
                    style: {
                      flex: 1,
                      minWidth: 0,
                      padding: "7px 10px",
                      borderRadius: 8,
                      border: "1px solid var(--border,#e0e0e0)",
                      background: "var(--bg-subtle,#f5f5f5)",
                      color: "inherit",
                      fontSize: 12,
                      outline: "none"
                    }
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: () => doInvoke(true),
                    disabled: loading || !followup.trim(),
                    style: {
                      padding: "6px 12px",
                      borderRadius: 8,
                      cursor: "pointer",
                      flexShrink: 0,
                      border: "1px solid var(--accent,#2563eb)",
                      background: loading ? "rgba(37,99,235,.08)" : "rgba(37,99,235,.12)",
                      color: "inherit",
                      fontSize: 12,
                      opacity: loading || !followup.trim() ? 0.5 : 1
                    },
                    children: "↪ 追问"
                  }
                )
              ] }),
              _state.sessionId || turns.length ? /* @__PURE__ */ jsxs("div", { style: { marginTop: 5, fontSize: 10, opacity: 0.55 }, children: [
                "💬 已",
                _state.sessionId ? "在同一 AI 会话延续（上下文完整）" : "迭代 " + (turns.length + 1) + " 轮·追问带手工上下文"
              ] }) : null,
              landing ? /* @__PURE__ */ jsx("div", { style: { marginTop: 8, fontSize: 12, padding: "7px 10px", borderRadius: 6, background: landing.status === "ok" ? "rgba(16,185,129,.12)" : "rgba(239,68,68,.12)", color: landing.status === "ok" ? "#16a34a" : "#dc2626" }, children: landing.msg }) : null
            ] }) : null
          ] }) : null,
          activeTab === "history" ? /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
            /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, opacity: 0.6, display: "inline-flex", alignItems: "center", gap: 4 }, children: [
              /* @__PURE__ */ jsx(Ic, { size: 12, paths: ICONS.clock }),
              " 历史记录（server 持久化，关闭不丢）" + (historyList && historyList.length ? " · " + historyList.length + " 条" : "")
            ] }),
            !historyList ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, opacity: 0.5, padding: 12 }, children: "加载中…" }) : !historyList.length ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, opacity: 0.5, padding: 12 }, children: "暂无历史记录。用 ✨ AI 生成一次就有了。" }) : historyList.map((rec) => /* @__PURE__ */ jsxs(
              "div",
              {
                onClick: () => restoreHistory(rec),
                title: "点击恢复此结果",
                style: { border: "1px solid var(--border,#e0e0e0)", borderRadius: 8, padding: "8px 10px", cursor: "pointer", background: "var(--bg-subtle,#f5f5f5)" },
                children: [
                  /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }, children: [
                    /* @__PURE__ */ jsx("span", { style: { fontSize: 10, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }, children: (rec.contextLabel || rec.helperId || "自由发挥") + (rec.turn && rec.turn > 1 ? " · 第" + rec.turn + "轮" : "") + " · " + fmtTime(rec.at) }),
                    /* @__PURE__ */ jsx("span", { style: { fontSize: 10, padding: "1px 7px", borderRadius: 9, border: "1px solid " + (rec.landed ? "rgba(22,163,74,.5)" : "rgba(220,38,38,.4)"), color: rec.landed ? "#16a34a" : "#dc2626" }, children: rec.landed ? "✓ 已落地" : "未落地" })
                  ] }),
                  /* @__PURE__ */ jsxs("div", { style: { fontSize: 12, fontWeight: 500, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: 1.4 }, children: [
                    "💬 ",
                    (rec.message || "（早期记录无输入）").slice(0, 200)
                  ] }),
                  /* @__PURE__ */ jsx("div", { style: { fontSize: 11, opacity: 0.75, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }, children: (rec.result || "").slice(0, 200) }),
                  rec.landed && rec.landDetail ? /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "#16a34a", marginTop: 4 }, children: rec.landDetail }) : null
                ]
              },
              rec.id
            ))
          ] }) : null
        ] }, "body")
      ]
    }
  ) });
}
export {
  AiHelperDialog,
  _state,
  closePanel,
  installInvokeEntry,
  mountHeavyUI,
  notify,
  prefetchPageId,
  setMcCtx
};
