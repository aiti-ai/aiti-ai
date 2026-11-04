window.__ModuleLoader__.load({
  id: "@aiti-ai/aiti-devtools-dsh",
  factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var name = "aiti-devtools-dsh";
var inject = ["sessions", "locale"];
try {
  if (typeof window !== "undefined" && (/[?&]_dbg=/.test(window.location.search) || window.name === "aiti-ai-popup")) {
    ;
    window.__AITI_AI_WIN__ = true;
  }
} catch {
}
try {
  if (typeof document !== "undefined" && !document.getElementById("aiti-picked-tag-style")) {
    const st = document.createElement("style");
    st.id = "aiti-picked-tag-style";
    st.textContent = [
      ".aiti-picked-tag{user-select:none}",
      ".aiti-picked-tag:hover{text-decoration:underline;opacity:.85}",
      ".aiti-candidate-chip:hover{border-color:var(--dsw-alias-border-l4)}",
      ".aiti-candidate-desc:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}",
      ".aiti-candidate-x:hover{color:var(--dsw-static-red-500)!important;opacity:1}",
      ".aiti-candidates-clear:hover{background:var(--dsw-alias-interactive-bg-hover-danger)!important}",
      ".aiti-detail-close:hover{color:var(--dsw-alias-label-primary)!important}",
      ".aiti-detail-row:hover{background:var(--dsw-alias-interactive-bg-hover)}"
    ].join("\n");
    document.head.appendChild(st);
  }
} catch {
}
var AI18N_NS = "aiti.candidates";
var AI18N = {
  zh: {
    clear: "\u6E05\u7A7A",
    detailSuffix: " \u8BE6\u60C5",
    close: "\u2715 \u5173\u95ED",
    fieldsTitle: "\u53D1\u9001\u7ED9 AI \u7684\u5B57\u6BB5\uFF08\u52FE\u9009\uFF09\uFF1A",
    errHint: "\u53D1\u9001\u65F6 [\u9519\u8BEFN] \u66FF\u6362\u4E3A\u5B8C\u6574\u9519\u8BEF\u8BE6\u60C5\uFF08\u7C7B\u578B/\u6D88\u606F/\u5806\u6808/\u65F6\u95F4\uFF09\u3002",
    orphanNote: "\uFF08\u5360\u4F4D\u7B26\u53D1\u9001\u65F6\u7531 host \u66FF\u6362\u4E3A\u5143\u7D20\u8BE6\u60C5\uFF09",
    tipTag: "\u70B9\u51FB\uFF1A\u4EC5\u8F93\u5165\u6846\u8865\u5360\u4F4D\u7B26\uFF08\u4E0D\u5F39\u8BE6\u60C5\uFF09",
    tipDesc: "\u70B9\u51FB\uFF1A\u8F93\u5165\u6846\u8865\u5360\u4F4D\u7B26 + \u67E5\u770B\u8BE6\u60C5/\u7B5B\u9009/\u6253\u5F00\u6587\u4EF6",
    tipOpenFile: "\u7ECF\u6865\u5728\u540E\u53F0\u6253\u5F00\uFF08\u7F16\u8F91\u5668\u7531 AITI_OPEN_CMD \u73AF\u5883\u53D8\u91CF\u6307\u5B9A\uFF0C\u65E0\u5219\u7CFB\u7EDF\u9ED8\u8BA4\uFF09"
  },
  en: {
    clear: "Clear all",
    detailSuffix: " details",
    close: "\u2715 Close",
    fieldsTitle: "Fields sent to the AI (checked):",
    errHint: "[\u9519\u8BEFN] expands to full error details (type/message/stack/time) on send.",
    orphanNote: "(placeholder expands to element details on send, host-side)",
    tipTag: "Click: insert placeholder only (no detail dialog)",
    tipDesc: "Click: insert placeholder + open details/filters/open-file",
    tipOpenFile: "Open in background via bridge (editor from AITI_OPEN_CMD, else system default)"
  }
};
function tt(t, key) {
  return (t && typeof t === "function" ? t(key) : "") || AI18N.zh[key];
}
function bridgeBase() {
  return "/aiti";
}
function assetUrl(f) {
  return "/aiti/" + f;
}
var hp = null;
var pickedElements = [];
var pickedListeners = /* @__PURE__ */ new Set();
function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}
function syncPicked(list) {
  pickedElements = list || [];
  for (const l of pickedListeners) l();
  reportPickedToHost();
}
var reportTimer = null;
function reportPickedToHost() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    try {
      let pageId = pickedElements.find((x) => x.pageId)?.pageId || null;
      if (!pageId && hp && hp.hostIdentity) {
        try {
          pageId = hp.hostIdentity()?.pageId || null;
        } catch {
        }
      }
      const payload = pickedElements.map((el) => ({
        tag: el.tag || "",
        pageId: el.pageId || pageId,
        describe: hp && hp.describe ? hp.describe(el, el.pageId || pageId) : String(el.tag || "")
      }));
      void fetch("/aiti/picked", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(() => {
      });
    } catch {
    }
  }, 150);
}
function initHostProtocol() {
  const w = window;
  if (hp || !w.AitiHostProtocol) return hp;
  hp = w.AitiHostProtocol.create({
    onPicked: syncPicked,
    onBoot: () => {
    },
    insertPlaceholder: (el) => insertPlaceholderIntoTextarea(el),
    // 宿主指示文本（launcher HUD 👆 按钮的 element_instruction）→ 追加输入框（pi-web 同款）
    onUserMessage: (p) => {
      if (!p || p.kind !== "element_instruction" || !p.text) return;
      try {
        const ta = document.querySelector("textarea");
        if (!ta) return;
        setTaValue(ta, (ta.value.trim() ? ta.value.trim() + " " : "") + p.text);
        ta.focus();
      } catch {
      }
    },
    onInspect: () => {
    },
    // 宿主页面事件（page_log/page_network/page_error/open_file…）→ 桥（AI 窗是桥唯一浏览器端点；
    // 此前空回调导致页面日志/网络/错误环形缓冲全空——aiti_page_logs/page_network 拉不到数据）
    onBridgeEvent: (type, payload, target) => {
      try {
        if (window.BridgeClient) window.BridgeClient.postEvent(type, payload, target && target.pageId || null);
      } catch {
      }
    }
  });
  window.__aitiDshHp = hp;
  return hp;
}
async function ensureHostProtocol() {
  if (hp) return hp;
  if (window.AitiHostProtocol) {
    initHostProtocol();
    return hp;
  }
  await loadScript(assetUrl("host-protocol.js"));
  if (window.AitiHostProtocol) {
    initHostProtocol();
    return hp;
  }
  console.error("[aiti-dsh-client] host-protocol.js \u52A0\u8F7D\u5931\u8D25");
  return null;
}
async function ensureBridgeClient() {
  const w = window;
  if (w.BridgeClient && typeof w.BridgeClient.connect === "function") return true;
  await loadScript(assetUrl("bridge-client.js"));
  return !!(w.BridgeClient && typeof w.BridgeClient.connect === "function");
}
async function ensureCdpCore() {
  const w = window;
  if (w.__AitiCdpCore) return true;
  await loadScript(assetUrl("cdp-core.js"));
  return !!w.__AitiCdpCore;
}
function launcherHost() {
  if (window.opener && !window.opener.closed) return window.opener;
  if (window.parent !== window) return window.parent;
  return window;
}
function postToLauncher(msg) {
  try {
    launcherHost().postMessage(msg, "*");
  } catch {
  }
}
function setTaValue(ta, v) {
  try {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, v);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  } catch {
  }
}
function insertPlaceholderIntoTextarea(el) {
  try {
    const ta = document.querySelector("textarea");
    if (!ta) return;
    const tag = el && el.tag || "";
    if (!tag) return;
    if (ta.value.includes(tag)) {
      ta.focus();
      return;
    }
    setTaValue(ta, (ta.value.trim() ? ta.value.trim() + " " : "") + tag);
    ta.focus();
  } catch {
  }
}
var detailIdx = -1;
var detailListeners = /* @__PURE__ */ new Set();
function setDetail(idx) {
  detailIdx = idx;
  for (const l of detailListeners) l();
}
function briefText(el) {
  try {
    if (hp && hp.brief) return hp.brief(el);
    if (el && el.kind === "error") return "\u26A0 " + String(el.message || "");
    return "<" + (el && el.tag ? el.tag.replace(/[\[\]]/g, "") : "?") + ">";
  } catch {
    return "<" + (el && el.tag || "?") + ">";
  }
}
function detailRowsText(el) {
  try {
    if (hp && hp.detailRows) {
      const pid = pickedElements.find((x) => x.pageId)?.pageId || null;
      return hp.detailRows(el, pid) || [];
    }
  } catch {
  }
  return [];
}
function stripTagsFromInput(tags) {
  try {
    const ta = document.querySelector("textarea");
    if (!ta || !ta.value || !tags || !tags.length) return;
    const items = tags.filter(Boolean).map((t) => ({ tag: t }));
    if (!items.length) return;
    let v = hp && hp.stripFromText ? hp.stripFromText(ta.value, items) : ta.value;
    if (v !== ta.value) setTaValue(ta, v.trim());
  } catch {
  }
}
function removeOneCandidate(el) {
  try {
    const ta = document.querySelector("textarea");
    if (hp && hp.removeCandidate) hp.removeCandidate(el);
    const v = hp && hp.stripFromText && ta ? hp.stripFromText(ta.value, [el]) : ta ? ta.value : "";
    if (ta && v !== ta.value) setTaValue(ta, v.trim());
  } catch {
  }
}
function clearAllCandidates() {
  try {
    const tags = pickedElements.map((el) => el.tag);
    pickedElements.forEach((el) => {
      try {
        if (hp && hp.removeCandidate) hp.removeCandidate(el);
      } catch {
      }
    });
    stripTagsFromInput(tags);
    if (hp && hp.setPicked) hp.setPicked([]);
    else syncPicked([]);
  } catch {
  }
}
var bridgeConnecting = false;
function connectBridge() {
  const w = window;
  if (w.BridgeClient && w.BridgeClient.isConnected && w.BridgeClient.isConnected()) {
    return Promise.resolve({ ok: true, already: true });
  }
  if (bridgeConnecting) return Promise.resolve({ ok: true, inFlight: true });
  bridgeConnecting = true;
  void ensureCdpCore();
  return ensureBridgeClient().then((ok) => {
    bridgeConnecting = false;
    if (!ok) return { ok: false, error: "bridge-client.js \u52A0\u8F7D\u5931\u8D25" };
    const common = hp && hp.bridgeConnectParams ? hp.bridgeConnectParams() : { role: "ai", token: "dev", useForward: true };
    w.BridgeClient.connect({
      base: bridgeBase(),
      ...common,
      onStatus: () => {
      },
      onReady: () => {
        if (!hp) return;
        try {
          hp.resetAiPageReport?.();
          hp.reportAiPage?.(bridgeBase());
        } catch {
        }
        try {
          hp.resetSelfPageReport?.();
          hp.reportSelfPage?.(bridgeBase());
        } catch {
        }
        try {
          hp.reportActive?.(bridgeBase());
        } catch {
        }
      },
      onExec: () => {
      },
      // 桥用户交互（confirm/choose/input/presence/pick_element）→ 转发 launcherHost
      // （DSH 在 iframe 里时 launcher 在父窗口；作答回传经 dbg_mcp_result → 下方监听 → postResult）
      onInteraction: (m) => {
        postToLauncher({ __dbg: 1, type: "dbg_mcp_interaction", payload: { requestId: m.requestId, interaction: m.interaction } });
      },
      onResult: (m) => {
        postToLauncher({ __dbg: 1, _aiBridge: 1, type: "dbg_mcp_result", payload: { requestId: m.requestId, ok: m.ok, result: m.result } });
      },
      onEvent: (m) => {
        const evName = typeof m === "string" ? m : m && (m.event || m.type) || "";
        if (evName === "aiti_consumed") {
          clearAllCandidates();
          return;
        }
        if (!m || m.type !== "user_answer") return;
        const pv = m.payload || {};
        if (pv.status === "answered") {
          const cand = { kind: pv.kind || "answer", answer: String(pv.answer || "").trim() };
          if (!cand.answer) return;
          if (!pickedElements.some((x) => x.answer === cand.answer)) {
            const next = [...pickedElements, cand];
            if (hp && hp.setPicked) hp.setPicked(next);
            else syncPicked(next);
            insertPlaceholderIntoTextarea(cand);
          }
        }
      }
    });
    try {
      if (hp) hp.reportAiPage?.(bridgeBase());
    } catch {
    }
    return { ok: true };
  });
}
function CandidatesBar(props) {
  const t = typeof props?.t === "function" ? props.t : void 0;
  const [, force] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    const l = () => force((n) => n + 1);
    pickedListeners.add(l);
    return () => {
      pickedListeners.delete(l);
    };
  }, []);
  if (!pickedElements.length) return null;
  return (0, import_react.createElement)(
    "div",
    {
      className: "aiti-candidates-bar",
      style: {
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        padding: "4px 8px 6px",
        fontSize: 11,
        marginBottom: 6,
        borderRadius: 8,
        background: "var(--dsw-alias-bg-layer-3)",
        border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
        boxShadow: "var(--dsw-shadow-lv2)",
        color: "var(--dsw-alias-label-primary)"
      }
    },
    ...pickedElements.map((el, i) => {
      const tag = el && el.tag || (el.kind === "answer" ? `[\u56DE\u7B54${i + 1}]` : el.kind === "error" ? `[\u9519\u8BEF${i + 1}]` : `[\u5143\u7D20${i + 1}]`);
      const isErr = el && el.kind === "error";
      return (0, import_react.createElement)(
        "span",
        {
          key: String(el?.tag || i),
          className: "aiti-candidate-chip",
          style: {
            display: "inline-flex",
            alignItems: "center",
            maxWidth: "100%",
            background: isErr ? "var(--dsw-alias-interactive-bg-hover-danger)" : "var(--dsw-alias-interactive-bg-hover-accent)",
            border: "1px solid var(--dsw-alias-border-l2)",
            borderRadius: 6,
            padding: "1px 2px 1px 0",
            whiteSpace: "nowrap",
            color: isErr ? "var(--dsw-static-red-500)" : "var(--dsw-alias-label-primary)"
          }
        },
        // 占位符区：点击仅补输入框占位符（不弹详情）
        (0, import_react.createElement)("span", {
          className: "aiti-picked-tag",
          onClick: (e) => {
            e.stopPropagation();
            insertPlaceholderIntoTextarea(el);
          },
          title: tt(t, "tipTag"),
          style: {
            padding: "0 6px",
            borderRight: "1px dashed var(--dsw-alias-border-l2)",
            fontWeight: 600,
            cursor: "pointer",
            flexShrink: 0,
            userSelect: "none"
          }
        }, tag),
        // 描述区：点击补占位符 + 开详情弹窗（信息/字段筛选/打开文件）
        (0, import_react.createElement)("span", {
          className: "aiti-candidate-desc",
          onClick: (e) => {
            e.stopPropagation();
            insertPlaceholderIntoTextarea(el);
            setDetail(i);
          },
          title: tt(t, "tipDesc"),
          style: {
            padding: "0 4px",
            cursor: "pointer",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 220,
            flexShrink: 1,
            color: "var(--dsw-alias-label-secondary)"
          }
        }, briefText(el)),
        // 逐条清除
        (0, import_react.createElement)("button", {
          className: "aiti-candidate-x",
          onClick: (e) => {
            e.stopPropagation();
            removeOneCandidate(el);
          },
          style: {
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--dsw-alias-label-tertiary)",
            padding: "0 3px",
            fontSize: 11,
            lineHeight: 1,
            flexShrink: 0
          },
          title: "\u6E05\u9664\u8BE5\u5019\u9009\uFF08\u540C\u6B65\u5220\u8F93\u5165\u6846\u91CC\u7684 " + tag + "\uFF09"
        }, "\u2715")
      );
    }),
    // 清空全部
    (0, import_react.createElement)("button", {
      className: "aiti-candidates-clear",
      onClick: (e) => {
        e.stopPropagation();
        clearAllCandidates();
      },
      style: {
        marginLeft: "auto",
        padding: "1px 8px",
        fontSize: 11,
        borderRadius: 4,
        cursor: "pointer",
        color: "var(--dsw-static-red-500)",
        background: "transparent",
        border: "1px solid var(--dsw-alias-border-l2)"
      }
    }, tt(t, "clear")),
    // 详情弹窗（fixed 覆盖层，portal 到 body；react-dom 不可用时退回 inline）；t 透传（locale 渐进增强）
    (0, import_react.createElement)(DetailDialog, { t })
  );
}
var createPortalFn = null;
try {
  const rd = require("react-dom");
  if (rd && typeof rd.createPortal === "function") createPortalFn = rd.createPortal;
} catch {
}
function DetailDialog(props) {
  const t = typeof props?.t === "function" ? props.t : void 0;
  const FIELD_LABELS = [["tag", "\u6807\u7B7E"], ["text", "\u6587\u672C"], ["xpath", "xpath"], ["selector", "selector"], ["rect", "\u5C3A\u5BF8"], ["docRect", "\u6587\u6863\u4F4D\u7F6E"], ["attributes", "\u5C5E\u6027"], ["computed", "\u6837\u5F0F"], ["framework", "\u6846\u67B6"], ["component", "\u7EC4\u4EF6"], ["file", "\u7EC4\u4EF6\u6E90\u7801"], ["usedAt", "\u8C03\u7528\u4F4D\u7F6E"], ["frame", "\u9875\u9762"]];
  const readInc = (c) => {
    const o = {};
    const inc = c && c.include || {};
    FIELD_LABELS.forEach(([fld]) => {
      o[fld] = inc[fld] !== false;
    });
    return o;
  };
  const [d, setD2] = (0, import_react.useState)(detailIdx);
  const [, force] = (0, import_react.useState)(0);
  const [incState, setIncState] = (0, import_react.useState)(() => readInc(null));
  (0, import_react.useEffect)(() => {
    const l = () => {
      setD2(detailIdx);
      force((n) => n + 1);
    };
    detailListeners.add(l);
    return () => {
      detailListeners.delete(l);
    };
  }, []);
  (0, import_react.useEffect)(() => {
    setIncState(readInc(d >= 0 ? pickedElements[d] || null : null));
  }, [d]);
  if (d < 0) return null;
  const el = pickedElements[d];
  if (!el) return null;
  if (!el.include) el.include = {};
  const toggle = (fld) => {
    setIncState((m) => ({ ...m, [fld]: !m[fld] }));
    el.include[fld] = !(incState[fld] !== false);
    if (hp && hp.setPicked) hp.setPicked([...pickedElements]);
    else syncPicked([...pickedElements]);
  };
  const close = () => setDetail(-1);
  const overlay = (0, import_react.createElement)(
    "div",
    {
      className: "aiti-detail-overlay",
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "var(--dsw-alias-bg-mask-3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      },
      onClick: close
    },
    (0, import_react.createElement)(
      "div",
      {
        className: "aiti-detail-dialog",
        style: {
          width: 380,
          maxWidth: "92vw",
          maxHeight: "80vh",
          overflow: "auto",
          padding: 14,
          borderRadius: 10,
          background: "var(--dsw-alias-bg-layer-3)",
          border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
          color: "var(--dsw-alias-label-primary)",
          boxShadow: "var(--dsw-shadow-lv2)",
          fontFamily: "inherit"
        },
        onClick: (e) => e.stopPropagation()
      },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
        (0, import_react.createElement)("b", { style: { fontSize: 13 } }, (el.tag || "") + tt(t, "detailSuffix")),
        (0, import_react.createElement)("button", {
          className: "aiti-detail-close",
          onClick: close,
          style: {
            background: "var(--dsw-alias-interactive-bg-hover)",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 4,
            lineHeight: 1.4,
            color: "var(--dsw-alias-label-secondary)"
          },
          "aria-label": "\u5173\u95ED",
          title: "\u5173\u95ED"
        }, tt(t, "close"))
      ),
      // 信息行
      (0, import_react.createElement)(
        "div",
        { className: "aiti-detail-rows", style: { marginBottom: 10 } },
        ...detailRowsText(el).map(([k, v], i) => {
          const fi = hp && hp.rowFileInfo ? hp.rowFileInfo(el, k) || {} : {};
          const file = fi.file || null;
          const line = fi.line || null;
          return (0, import_react.createElement)(
            "div",
            {
              key: i,
              className: "aiti-detail-row",
              style: {
                display: "flex",
                gap: 6,
                fontSize: 11,
                padding: "3px 0",
                borderBottom: "1px solid var(--dsw-alias-border-l1)",
                alignItems: "center",
                borderRadius: 4
              }
            },
            (0, import_react.createElement)("span", { style: { color: "var(--dsw-alias-label-secondary)", minWidth: 64, fontWeight: 600, flexShrink: 0 } }, k),
            (0, import_react.createElement)("code", { style: { flex: 1, wordBreak: "break-all", fontSize: 11 } }, v),
            file && (0, import_react.createElement)("button", {
              className: "aiti-file-open",
              onClick: (e) => {
                e.stopPropagation();
                try {
                  if (window.BridgeClient) window.BridgeClient.postEvent("open_file", { file, line });
                } catch {
                }
              },
              title: tt(t, "tipOpenFile"),
              style: {
                background: "var(--dsw-alias-interactive-bg-hover)",
                border: "1px solid var(--dsw-alias-border-l2)",
                borderRadius: 4,
                padding: "0 6px",
                fontSize: 10,
                cursor: "pointer",
                flexShrink: 0,
                color: "var(--dsw-alias-label-secondary)",
                lineHeight: 1.6
              }
            }, "\u{1F4C2} " + (tt(t, "close") === "\u2715 Close" ? "Open" : "\u540E\u53F0\u6253\u5F00"))
          );
        })
      ),
      // 字段筛选（元素候选）
      el.kind === "error" ? (0, import_react.createElement)("p", { style: { margin: "8px 0", fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, tt(t, "errHint")) : (0, import_react.createElement)(
        "div",
        { style: { borderTop: "1px solid var(--dsw-alias-border-l1)", padding: "8px 0", marginBottom: 4 } },
        (0, import_react.createElement)("p", { style: { marginBottom: 6, fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, tt(t, "fieldsTitle")),
        (0, import_react.createElement)(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: "4px 12px" } },
          ...FIELD_LABELS.map(
            ([fld, label]) => (0, import_react.createElement)(
              "label",
              {
                key: fld,
                style: { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, cursor: "pointer", color: "var(--dsw-alias-label-secondary)" }
              },
              (0, import_react.createElement)("input", {
                type: "checkbox",
                checked: incState[fld] !== false,
                onChange: () => toggle(fld),
                style: { accentColor: "var(--dsw-alias-label-primary)" }
              }),
              label
            )
          )
        )
      )
    )
  );
  return createPortalFn ? createPortalFn(overlay, document.body) : overlay;
}
function onLauncherMessage(e) {
  const m = e.data;
  if (!m || m.__dbg !== 1) return;
  const w = window;
  if (m.type === "dbg_mcp_result") {
    if (m._aiBridge) return;
    const p = m.payload || {};
    if (p.requestId && w.BridgeClient) w.BridgeClient.postResult(p.requestId, p.ok !== false, p.result);
  } else if (m.type === "dbg_mcp_interaction_control") {
    const p = m.payload || {};
    if (p.requestId && w.BridgeClient) w.BridgeClient.postInteraction(p.requestId, p.action);
  }
}
function apply(ctx) {
  const logger = ctx.logger;
  logger?.info?.("aiti-devtools-dsh client: loaded");
  const localeCtx = ctx;
  if (localeCtx.locale?.register) {
    const dispose = localeCtx.locale.register(AI18N_NS, { zh: { ...AI18N.zh }, en: { ...AI18N.en } });
    localeCtx.effect?.(() => dispose, "aiti-devtools-dsh: locale dictionaries");
  }
  ;
  window.__aitiDshAddCandidate = (el) => {
    try {
      const H = window.__aitiDshHp || hp;
      if (H && H.setPicked) H.setPicked([...H.getPicked() || [], el]);
      else syncPicked([...pickedElements, el]);
    } catch {
    }
  };
  window.__aitiDshGetPicked = () => pickedElements;
  window.__aitiDshInsert = (tag) => insertPlaceholderIntoTextarea({ tag });
  const fx = ctx;
  fx.effect?.(() => {
    window.addEventListener("message", onLauncherMessage);
    return () => {
      window.removeEventListener("message", onLauncherMessage);
    };
  }, "aiti-devtools-dsh: launcher message relay");
  if (!fx.effect) window.addEventListener("message", onLauncherMessage);
  void ensureHostProtocol().then((h) => {
    if (h) {
      try {
        h.sendReady();
      } catch {
      }
    }
    return connectBridge();
  }).catch((e) => logger?.error?.("aiti-devtools-dsh client: protocol bootstrap failed: " + String(e)));
  ctx.inject(["slots"], (scope) => {
    scope.slots.inject("conversation.input.overlay", () => scope.slots.register(
      {
        name: "conversation.input.overlay",
        id: "aiti-devtools-candidates",
        order: 1e3,
        locale: AI18N_NS
      },
      CandidatesBar
    ));
  });
}

return module.exports;
  },
});
