/**
 * aiti-cmd client · TerminalView — real PTY view (xterm.js + event-bus downlink + POST uplink).
 *
 * Moved verbatim from the old single-file client; only the ctx-bound identifiers now come
 * from the kit (t/h/api/alive/…) so that both the terminal dialog app and the workspace
 * terminal tab (views/workspace-terminal.js) can render the same component.
 *
 * pullBack: tab-mode "⇲ pull back into the window" (absent in the dialog app).
 * onNewShell / onNewPiSession: "＋ new" / "💬 new session" at the current live cwd.
 * onSaveFavorite: "★ save this command" (dialog app only; hidden for bare shells).
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";
import { btnStyle, inputStyle, smallStyle, TERM_THEME, TERM_FONT, TERM_SIZES, LS_TERM_SIZE, LS_TERM_KBD, lsGet, lsSet, installTermLinkProvider, installTermClipboard } from "../kit.js";

// inject xterm.css (inlined as text at build time)
if (typeof document !== "undefined" && !document.getElementById("aiti-cmd-xterm-css")) {
  const style = document.createElement("style");
  style.id = "aiti-cmd-xterm-css";
  style.textContent = xtermCss;
  document.head.appendChild(style);
}

/** Link confirmation overlay: clicking a URL asks first, then opens a new window (noopener). */
export function TermLinkConfirm({ h, t, link, onClose }) {
  if (!link) return null;
  const open = () => {
    try { window.open(link.uri, "_blank", "noopener"); } catch (e) {}
    onClose();
  };
  return h("div", {
    style: { position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
    onClick: onClose,
  },
    h("div", { style: { width: 440, maxWidth: "100%", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", padding: 14 }, onClick: (e) => e.stopPropagation() },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
        h("span", { style: { fontSize: 15, display: "inline-flex" } }, h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [h("path", { key: "p1", d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }), h("path", { key: "p2", d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" })])),
        h("b", { style: { fontSize: 14 } }, t("cmd.k224")),
      ),
      h("code", { style: { display: "block", fontSize: 13, color: "var(--accent)", wordBreak: "break-all", whiteSpace: "pre-wrap", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", marginBottom: 4, fontFamily: "var(--font-mono)" } }, link.uri),
      h("div", { style: { fontSize: 13, color: "var(--text-muted)", marginBottom: 10 } }, t("cmd.k179")),
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        h("button", { onClick: onClose, style: { ...btnStyle, padding: "5px 16px" } }, t("cmd.k155")),
        h("button", { onClick: open, style: { ...btnStyle, background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", padding: "5px 18px", fontWeight: 600 } }, t("cmd.k223")),
      ),
    ),
  );
}

export function createTerminalView(kit) {
  const { h, t, api, Ic, ICONS, useRef, useState, useEffect, useIsZh, SHIFTED, KEYPAD_FULL_ROWS, KEYPAD_ROWS, TERM_SHORTCUTS, TOOLBAR_LEGEND, aliveAdd, aliveDel } = kit;

  // Window size: fit = follow the container (default); the rest are fixed cols×rows.
  // Fullscreen / virtual keyboard / help / scroll: toolbar and keypad below.
  return function TerminalView({ sessionId, onExit, height, counts, pullBack, onNewShell, onNewPiSession, sendToTab, killPending, onSaveFavorite, onReopen }) {
    const isZh = useIsZh();
    const ref = useRef(null);
    const [status, setStatus] = useState("connecting");
    const [meta, setMeta] = useState(null);
    const [exitInfo, setExitInfo] = useState(null);
    const [linkConfirm, setLinkConfirm] = useState(null); // {uri} — terminal URL click confirmation
    const termRef = useRef(null);
    const fitRef = useRef(null);
    // size / fullscreen / on-screen keyboard / help (size + keyboard preference persisted)
    const [sizeId, setSizeId] = useState(() => lsGet(LS_TERM_SIZE, "fit"));
    const [fullscreen, setFullscreen] = useState(false);
    const [kbdOpen, setKbdOpen] = useState(() => lsGet(LS_TERM_KBD, false));
    const [helpOpen, setHelpOpen] = useState(false);
    const [ctrlLock, setCtrlLock] = useState(false);
    const [altLock, setAltLock] = useState(false);
    const [shiftLock, setShiftLock] = useState(false);
    const [winLock, setWinLock] = useState(false);
    const [kbdMode, setKbdMode] = useState("common"); // common=extra keys / full=ABC keyboard
    const sizeRef = useRef(sizeId);
    sizeRef.current = sizeId;
    // small-screen breakpoint (max-width: 640px) — layout flips on width only
    const [isSmall, setIsSmall] = useState(() => typeof window !== "undefined" && (window.matchMedia ? (window.matchMedia("(max-width: 640px)").matches) : false));
    useEffect(() => {
      if (typeof window === "undefined" || !window.matchMedia) return;
      const mq = window.matchMedia("(max-width: 640px)");
      const onChange = () => setIsSmall(mq.matches);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }, []);

    // the on-screen keyboard / shortcuts write bytes straight to the PTY (no DOM keyboard)
    const sendKey = (data) => {
      const sid = sessionId;
      try { fetch(api(`/sessions/${sid}/input`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) }).catch(() => {}); } catch {}
    };
    // fixed-size mode: keep following the newest output unless the user scrolled up
    const maybeAutoScroll = () => {
      const c = ref.current;
      if (!c || sizeRef.current === "fit") return;
      if (c.scrollHeight - c.scrollTop - c.clientHeight < 40) c.scrollTop = c.scrollHeight;
    };
    const scrollBottom = () => {
      try { const c = ref.current; if (c) c.scrollTop = c.scrollHeight; } catch {}
      try { termRef.current?.scrollToBottom(); } catch {}
    };
    const applySize = () => {
      const term = termRef.current;
      if (!term) return;
      const p = TERM_SIZES.find((s) => s.id === sizeRef.current) || TERM_SIZES[0];
      if (!p.cols) { try { fitRef.current?.fit(); } catch {} }
      else { try { term.resize(p.cols, p.rows); } catch {} } // onResize syncs the PTY
    };
    const cycleSize = () => setSizeId((prev) => {
      const ids = TERM_SIZES.map((s) => s.id);
      const next = ids[(ids.indexOf(prev) + 1) % ids.length];
      lsSet(LS_TERM_SIZE, next);
      return next;
    });
    const toggleKbd = () => setKbdOpen((x) => { lsSet(LS_TERM_KBD, !x); return !x; });

    useEffect(() => {
      if (!ref.current) return;
      const term = new Terminal({ fontFamily: TERM_FONT, fontSize: 13, scrollback: 1000, cursorBlink: true, convertEol: false, rendererType: "dom", theme: TERM_THEME });
      // rendererType "dom": xterm 6 defaults to WebGL where available (e.g. Edge); some GPU/driver
      // combos render nothing until a reopen. The DOM renderer is the stable, GPU-free choice.
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      termRef.current = term;
      fitRef.current = fit;
      try { applySize(); } catch {}
      term.focus();
      // link detection: clickable URLs → confirmation overlay → new window
      const linkDisp = installTermLinkProvider(term, (uri) => setLinkConfirm({ uri }));
      const sid = sessionId;
      let disposed = false; // effect teardown flag: async bus/snapshot results must not touch a disposed term
      const send = (path, body) => {
        try { fetch(api(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}); } catch {}
      };
      term.onData((data) => send(`/sessions/${sid}/input`, { data }));
      term.onResize(({ cols, rows }) => send(`/sessions/${sid}/resize`, { cols, rows }));
      // copy/paste: right-click copies the selection; Ctrl+Shift+C / Ctrl+Insert copy; Ctrl+Shift+V / Shift+Insert paste
      const pasteClip = () => { try { navigator.clipboard?.readText?.().then((tx) => { if (tx) send(`/sessions/${sid}/input`, { data: tx }); }).catch(() => {}); } catch {} };
      const clip = installTermClipboard(term, ref.current, pasteClip);
      // in-terminal shortcuts: Ctrl+Shift+F fullscreen / Ctrl+Shift+K keypad / Ctrl+Shift+S cycle size;
      // Esc closes the keypad only while it is open (never stealing the terminal's own Esc)
      term.attachCustomKeyEventHandler((ev) => {
        if (clip.handleKey(ev)) return false;
        if (ev.type === "keydown" && ev.ctrlKey && ev.shiftKey) {
          const k = (ev.key || "").toLowerCase();
          if (k === "f") { ev.preventDefault(); setFullscreen((x) => !x); return false; }
          if (k === "k") { ev.preventDefault(); toggleKbd(); return false; }
          if (k === "s") { ev.preventDefault(); cycleSize(); return false; }
        }
        if (ev.type === "keydown" && ev.key === "Escape" && kbdOpen) {
          ev.preventDefault(); toggleKbd(); return false;
        }
        return true;
      });
      // ---------- downlink: the aiti-event-bus topic cmd-<sid> is the only live channel (no fallbacks) ----------
      // Live frames go over the bus; the initial replay (ring up to ~1MB) does not — after the
      // subscription is ready we pull /sessions/{id}/buffered once, reset + replay, and de-dupe by
      // seq. On reconnect (up) the snapshot is re-pulled to fill the gap.
      let busOff = null;
      let seenSeq = -1;
      let exited = false;
      let everDown = false;
      // exit banner (terminated → red, non-zero → amber, clean → green); idempotent, rewritten after reset
      const writeExitBanner = (m) => {
        const tail = `${t("cmd.k375")}${m.code ?? "?"}${m.signal ? " · " + m.signal : ""}${t("cmd.k8")}${((m.durationMs || 0) / 1000).toFixed(1)}s${m.truncated ? " · 输出已截断" : ""}`;
        if (m.signal) term.write(`\r\n\x1b[41;97m ⏹ 会话已停止（被 ${m.signal}${t("cmd.k26")}${tail} \x1b[0m\r\n`);
        else if ((m.code ?? 0) !== 0) term.write(`\r\n\x1b[43;30m ⚠ 会话已结束 · ${tail} \x1b[0m\r\n`);
        else term.write(`\r\n\x1b[42;30m ✓ 会话已结束 · ${tail} \x1b[0m\r\n`);
      };
      const hideCursor = () => { try { term.options.cursorBlink = false; term.write("\x1b[?25l"); } catch {} };
      const applyExit = (m, opts) => {
        if (exited) { if (opts?.rewrite) writeExitBanner(m); return; }
        exited = true;
        setStatus("exit"); setExitInfo({ code: m.code, signal: m.signal, durationMs: m.durationMs, truncated: m.truncated });
        hideCursor();
        writeExitBanner(m);
        busOff?.(); busOff = null; aliveDel("cmd-" + sid); // exited: drop the subscription + keepalive
        if (onExit) onExit(m);
      };
      const applyFrame = (m) => {
        if (m.evt === "started") { setStatus("running"); setMeta(m); }
        else if (m.evt === "queued") { setStatus("queued"); setMeta(m); }
        else if (m.evt === "pid") { setMeta((prev) => ({ ...(prev || {}), pid: m.pid })); }
        else if (m.evt === "data") {
          if (exited) return; // no frames after exit (prevents status rollback / cursor revival)
          if (typeof m.seq === "number") { if (m.seq <= seenSeq) return; seenSeq = m.seq; }
          term.write(m.data); try { term.scrollToBottom(); } catch {} maybeAutoScroll(); setStatus("running");
        }
        else if (m.evt === "exit") applyExit(m);
      };
      const applySnapshot = (d) => {
        if (!d || !d.ok) return;
        // reset drops frames that arrived between subscribe-ready and the snapshot response;
        // the snapshot seq becomes the de-dupe baseline → seamless, no duplicates
        if (d.status === "queued") setStatus("queued"); else if (!exited) setStatus(d.status === "exit" ? "exit" : "running");
        setMeta({ sessionId: sid, pid: d.pid, cmd: d.cmd, cwd: d.cwd });
        try { term.reset(); } catch {}
        for (const c of d.chunks || []) { term.write(c.data); if (typeof c.seq === "number" && c.seq > seenSeq) seenSeq = c.seq; }
        if (typeof d.seq === "number" && d.seq > seenSeq) seenSeq = d.seq;
        if (d.status === "exit") applyExit({ code: d.exitCode, signal: d.signal, durationMs: d.durationMs, truncated: d.truncated }, { rewrite: true });
        else { try { term.scrollToBottom(); } catch {} }
      };
      // subscribe first, then pull the full snapshot once the subscription is ready
      const setupLive = () => {
        if (exited || disposed) return;
        const topicsSub = kit.ctx?.getExtService?.("aiti-event-bus.subscribe-topics");
        if (!topicsSub) return;
        const pullSnap = () => { fetch(api(`/sessions/${sid}/buffered`)).then((r) => r.json()).then((d) => { if (!disposed) applySnapshot(d); }).catch(() => {}); };
        const sub = topicsSub(applyFrame, ["cmd-" + sid], (s) => {
          if (s === "reconnecting") { everDown = true; setStatus("reconnecting"); }
          else if (s === "down") { everDown = true; }
          else if (s === "up") {
            setStatus((prev) => (prev === "reconnecting" ? "running" : prev));
            if (everDown && !exited) {
              everDown = false;
              pullSnap(); // fill the gap (full replay + seq de-dupe, idempotent)
            }
          }
        });
        busOff = () => { try { sub.off(); } catch {} };
        aliveAdd("cmd-" + sid); // keepalive: the backend keeps pushing only while we report alive
        sub.ready.then(pullSnap).catch(() => {
          // bus unreachable: still pull one snapshot (no live stream, content visible)
          pullSnap();
        });
      };
      // init: cheap status probe first (GET /sessions/{id} has no chunks) —
      // exit → one full snapshot, no subscription/keepalive;
      // running/queued → subscribe first (zero gap), snapshot after ready;
      // probe failure → conservative live path
      fetch(api(`/sessions/${sid}`)).then((r) => r.json()).then((info) => {
        if (disposed) return;
        if (info && info.ok) {
          if (info.status === "exit") {
            setMeta({ sessionId: sid, cmd: info.cmd, cwd: info.cwd });
            setStatus("exit");
            fetch(api(`/sessions/${sid}/buffered`)).then((r) => r.json()).then((d) => { if (!disposed) applySnapshot(d); }).catch(() => {});
            return;
          }
          setMeta((prev) => ({ ...(prev || {}), sessionId: sid, cmd: info.cmd, cwd: info.cwd }));
        }
        setupLive();
      }).catch(() => setupLive());
      // refit only in fit mode when the container changes (fixed sizes scroll in the outer box)
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { try { if (sizeRef.current === "fit") fit.fit(); } catch {} }) : null;
      if (ro) ro.observe(ref.current);
      // xterm 6 has no native touch scrolling — compensate on the container with simple inertia
      const touchState = { active: false, lastY: 0, lastTime: 0, velocity: 0, inertia: null };
      const endTouch = () => {
        touchState.active = false;
        document.removeEventListener("touchmove", onTouchMove, { passive: false });
        document.removeEventListener("touchend", onTouchEnd);
        document.removeEventListener("touchcancel", onTouchEnd);
      };
      const onTouchStart = (e) => {
        if (e.touches.length !== 1) { touchState.active = false; return; }
        touchState.active = true;
        touchState.lastY = e.touches[0].clientY;
        touchState.lastTime = Date.now();
        touchState.velocity = 0;
        if (touchState.inertia) { cancelAnimationFrame(touchState.inertia); touchState.inertia = null; }
        document.addEventListener("touchmove", onTouchMove, { passive: false });
        document.addEventListener("touchend", onTouchEnd);
        document.addEventListener("touchcancel", onTouchEnd);
      };
      const onTouchMove = (e) => {
        if (!touchState.active || e.touches.length !== 1) { endTouch(); return; }
        const currentY = e.touches[0].clientY;
        const currentTime = Date.now();
        const deltaY = currentY - touchState.lastY;
        const dt = currentTime - touchState.lastTime;
        if (dt > 0) touchState.velocity = deltaY / dt;
        const tt = termRef.current;
        if (tt) {
          const rowHeight = tt._core?._renderService?.dimensions?.css?.cell?.height || (ref.current?.clientHeight / (tt.rows || 1));
          const lines = Math.round(deltaY / rowHeight);
          if (lines) try { tt.scrollLines(lines); } catch {}
        }
        touchState.lastY = currentY;
        touchState.lastTime = currentTime;
        e.preventDefault();
      };
      const onTouchEnd = () => {
        const wasActive = touchState.active;
        endTouch();
        if (!wasActive) return;
        const v = touchState.velocity;
        if (Math.abs(v) > 0.15) {
          let velocity = v;
          const step = () => {
            velocity *= 0.92;
            if (Math.abs(velocity) < 0.05) { touchState.inertia = null; return; }
            const tt = termRef.current;
            if (tt) {
              const rowHeight = tt._core?._renderService?.dimensions?.css?.cell?.height || (ref.current?.clientHeight / (tt.rows || 1));
              const lines = Math.round(velocity * 16 / rowHeight);
              if (lines) try { tt.scrollLines(lines); } catch {}
            }
            touchState.inertia = requestAnimationFrame(step);
          };
          touchState.inertia = requestAnimationFrame(step);
        }
      };
      if (ref.current) ref.current.addEventListener("touchstart", onTouchStart, { passive: false });
      return () => {
        disposed = true;
        busOff?.();
        aliveDel("cmd-" + sid);
        linkDisp?.dispose?.();
        clip.dispose();
        ro?.disconnect();
        term.dispose();
        termRef.current = null;
        endTouch();
        if (touchState.inertia) cancelAnimationFrame(touchState.inertia);
        ref.current?.removeEventListener("touchstart", onTouchStart, { passive: false });
      };
    }, [sessionId]);
    // size switch: fit → refit the container; fixed → term.resize (onResize syncs the PTY)
    useEffect(applySize, [sizeId]);
    const miniBtn = { ...btnStyle, padding: "2px 8px", fontSize: 13 };
    const selStyle = { ...inputStyle, flex: "none", width: "auto", fontSize: 13, padding: "1px 8px" };
    // keypad key renderer (common / ABC): Ctrl/Alt lock + letter = combo; Ctrl lock + arrow = word-wise move
    const renderKey = (k, i) => {
      const active = (k.mod === "ctrl" && ctrlLock) || (k.mod === "alt" && altLock) || (k.mod === "shift" && shiftLock) || (k.mod === "win" && winLock);
      const press = () => {
        if (k.mod === "ctrl") { setCtrlLock((x) => { if (!x) { setAltLock(false); setWinLock(false); } return !x; }); return; }
        if (k.mod === "alt") { setAltLock((x) => { if (!x) { setCtrlLock(false); setWinLock(false); } return !x; }); return; }
        if (k.mod === "shift") { setShiftLock((x) => !x); return; }
        if (k.mod === "win") { setWinLock((x) => { if (!x) setAltLock(false); return !x; }); return; }
        let seq = k.seq;
        // modifier precedence: Ctrl (byte combo) > SHIFT (uppercase/shifted) > ALT/WIN (ESC prefix Meta)
        if (k.txt) {
          if (ctrlLock && /^[a-zA-Z]$/.test(k.txt)) { seq = String.fromCharCode(k.txt.toLowerCase().charCodeAt(0) - 96); setCtrlLock(false); setShiftLock(false); }
          else if (shiftLock && /^[a-z]$/.test(k.txt)) { seq = k.txt.toUpperCase(); setShiftLock(false); }
          else if (shiftLock && SHIFTED[k.txt]) { seq = SHIFTED[k.txt]; setShiftLock(false); }
          else if (altLock) { seq = "\x1b" + k.txt; setAltLock(false); }
          else if (winLock) { seq = "\x1b" + k.txt; setWinLock(false); }
          else seq = k.txt;
          if (shiftLock && seq === k.txt) setShiftLock(false); // unmapped symbol/space: drop the lock
        }
        // arrows × modifiers → standard xterm CSI (mod: 2=Shift 3=Alt 5=Ctrl 6=Shift+Ctrl)
        if (seq && /^\x1b\[[ABCD]$/.test(seq)) {
          const mod = (ctrlLock && shiftLock) ? 6 : ctrlLock ? 5 : shiftLock ? 2 : (altLock || winLock) ? 3 : 0;
          if (mod) { seq = "\x1b[1;" + mod + seq.slice(-1); setCtrlLock(false); setShiftLock(false); setAltLock(false); setWinLock(false); }
        }
        // F1-F12 × modifiers → modified CSI (F1-F4 SS3 → CSI 1;2P; F5-F12 \x1b[15~ → [15;5~)
        if (seq && /^\x1b(O[PQRS]|\[(?:15|17|18|19|20|21|23|24)~)$/.test(seq)) {
          const mod = (ctrlLock && shiftLock) ? 6 : ctrlLock ? 5 : shiftLock ? 2 : (altLock || winLock) ? 3 : 0;
          if (mod) {
            seq = seq[1] === "O" ? "\x1b[1;" + mod + seq[2] : seq.slice(0, -1) + ";" + mod + "~";
            setCtrlLock(false); setShiftLock(false); setAltLock(false); setWinLock(false);
          }
        }
        sendKey(seq);
      };
      return h("button", {
        key: i,
        onPointerDown: (e) => { e.preventDefault(); press(); }, // pointerdown + preventDefault: keep focus, no mobile IME popup
        title: k.mod ? (k.mod === "ctrl" ? t("cmd.k34") : k.mod === "alt" ? t("cmd.k32") : k.mod === "shift" ? t("cmd.k37") : k.mod === "win" ? t("cmd.k38") : "") : (k.c || ""),
        style: { minWidth: 34, height: 30, borderRadius: 6, border: "1px solid " + (active ? "var(--accent)" : "var(--border)"), background: active ? "var(--accent)" : "var(--bg-hover)", color: active ? "#fff" : "var(--text)", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "0 6px", fontFamily: "inherit", flexShrink: 0 },
      }, k.k);
    };
    const kbdRows = kbdMode === "full" ? KEYPAD_FULL_ROWS : KEYPAD_ROWS;
    const keypad = h("div", { style: { flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, maxHeight: "48%", overflowY: "auto" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 } },
        h("button", { onClick: () => setKbdMode("common"), title: t("cmd.k212"), style: { ...miniBtn, fontSize: 12, padding: "1px 8px", background: kbdMode === "common" ? "var(--accent)" : "transparent", color: kbdMode === "common" ? "#fff" : "var(--text-muted)", border: "1px solid " + (kbdMode === "common" ? "var(--accent)" : "var(--border)") } }, t("cmd.k206")),
        h("button", { onClick: () => setKbdMode("full"), title: t("cmd.k108"), style: { ...miniBtn, fontSize: 12, padding: "1px 8px", background: kbdMode === "full" ? "var(--accent)" : "transparent", color: kbdMode === "full" ? "#fff" : "var(--text-muted)", border: "1px solid " + (kbdMode === "full" ? "var(--accent)" : "var(--border)") } }, t("cmd.k28")),
        h("span", { style: { ...smallStyle, marginLeft: "auto", fontSize: 12, whiteSpace: "nowrap" } }, kbdMode === "full" ? t("cmd.k33") : t("cmd.k152")),
        // close button always visible; aria-label deliberately not "close" (the ai-helper dialog 🤖
        // injection looks for the dialog close button by aria-label and would latch onto this one)
        h("button", { onClick: toggleKbd, title: t("cmd.k111"), "aria-label": t("cmd.k253"), style: { ...miniBtn, fontSize: 13, padding: "0 8px", height: 22, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 3 } }, "×", h("span", { style: { fontSize: 12 } }, t("cmd.k109"))),
      ),
      kbdRows.map((row, ri) => h("div", { key: ri, style: { display: "flex", flexWrap: "wrap", gap: 3 } },
        row.map((k, i) => renderKey(k, i)),
      )),
    );
    const help = h("div", { style: { flexShrink: 0, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", maxHeight: "45%", overflowY: "auto", fontSize: 13 } },
      h("div", { style: { fontWeight: 700, marginBottom: 6 } }, t("cmd.k210")),
      h("table", { style: { borderCollapse: "collapse", width: "100%" } },
        h("tbody", {},
          TERM_SHORTCUTS.map((pair) =>
            h("tr", { key: pair[0] },
              h("td", { style: { padding: "2px 10px 2px 0", whiteSpace: "nowrap", color: "var(--accent)", fontWeight: 600 } }, pair[0]),
              h("td", { style: { padding: "2px 0", color: "var(--text-muted)" } }, pair[1]),
            )),
        ),
      ),
      h("div", { style: { marginTop: 6, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 } }, t("cmd.k346")),
      h("div", { style: { fontWeight: 700, margin: "8px 0 4px", borderTop: "1px solid var(--border)", paddingTop: 8 } }, t("cmd.k196")),
      h("table", { style: { borderCollapse: "collapse", width: "100%" } },
        h("tbody", {},
          TOOLBAR_LEGEND(isZh).map((pair) =>
            h("tr", { key: pair[0] },
              h("td", { style: { padding: "2px 10px 2px 0", whiteSpace: "nowrap", color: "var(--accent)", fontWeight: 600, textAlign: "center", width: 56 } }, pair[0]),
              h("td", { style: { padding: "2px 0", color: "var(--text-muted)" } }, pair[1]),
            )),
        ),
      ),
    );
    const isFit = sizeId === "fit";
    const saveable = !!(meta && meta.cmd && !/^\$SHELL/i.test(String(meta.cmd)));
    return h("div", { style: fullscreen
      ? { position: "fixed", inset: 0, zIndex: 500, background: "var(--bg-panel)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4, boxSizing: "border-box" }
      : { display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 } },
      h("div", { style: { ...smallStyle, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
        // status: exit gets a colored badge (red terminated / amber non-zero / green clean)
        status === "exit" ? h("span", { style: { display: "inline-flex", alignItems: "center", flexShrink: 0, padding: "1px 8px", borderRadius: 6, fontWeight: 700, fontSize: 11, lineHeight: "16px", color: exitInfo?.signal ? "#fff" : exitInfo && (exitInfo.code ?? 0) !== 0 ? "var(--warn, #facc15)" : "var(--ok, #4ade80)", background: exitInfo?.signal ? "var(--danger, #ef4444)" : exitInfo && (exitInfo.code ?? 0) !== 0 ? "color-mix(in srgb, var(--warn, #facc15) 22%, transparent)" : "color-mix(in srgb, var(--ok, #4ade80) 18%, transparent)" } },
          isSmall
            ? (exitInfo?.signal ? t("cmd.k198") : exitInfo && (exitInfo.code ?? 0) !== 0 ? t("cmd.k203") : t("cmd.k203"))
            : (exitInfo?.signal ? t("cmd.k83") + exitInfo.signal + t("cmd.k25") : exitInfo && (exitInfo.code ?? 0) !== 0 ? t("cmd.k85") + exitInfo.code + "）" : t("cmd.k84")))
        : h("span", { style: { color: status === "running" ? (killPending ? "var(--warn, #f59e0b)" : "var(--ok, #4ade80)") : "var(--text)" } },
          isSmall
            ? (killPending ? "⏳" : status === "running" ? "●" : status === "queued" ? "⏳" : status === "replaying" ? "⟳" : status === "reconnecting" ? "⚠" : "…")
            : (killPending && status === "running" ? t("cmd.k321") : status === "running" ? t("cmd.k60") : status === "queued" ? t("cmd.k239") : status === "replaying" ? t("cmd.k61") : status === "reconnecting" ? t("cmd.k370") : t("cmd.k51"))),
        meta && !isSmall && h("span", { title: meta.cwd, style: { fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1 } }, "📁 " + (meta.cwd || "")),
        meta && !isSmall && h("code", { style: { ...smallStyle, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 2 } }, "$ " + String(meta.cmd).slice(0, 60)),
        // window size (fit / fixed presets); Ctrl+Shift+S also cycles
        h("select", { value: sizeId, onChange: (e) => { const v = e.target.value; setSizeId(v); lsSet(LS_TERM_SIZE, v); }, style: selStyle, title: t("cmd.k330") },
          TERM_SIZES.map((s) => h("option", { key: s.id, value: s.id }, s.labelKey ? t(s.labelKey) : s.label)),
        ),
        h("button", { onClick: scrollBottom, title: t("cmd.k302"), "aria-label": t("cmd.k302"), style: miniBtn }, isZh ? t("cmd.k54") : "⇊"),
        h("button", { onClick: toggleKbd, title: t("cmd.k348"), "aria-label": t("cmd.k345"), style: { ...miniBtn, background: kbdOpen ? "var(--accent)" : undefined, color: kbdOpen ? "#fff" : undefined } }, "⌨"),
        h("button", { onClick: () => setHelpOpen((x) => !x), title: t("cmd.k211"), "aria-label": t("cmd.k211"), style: { ...miniBtn, background: helpOpen ? "var(--accent)" : undefined, color: helpOpen ? "#fff" : undefined } }, "?"),
        // dialog-mode actions: ⇱ move to workspace tab · ＋ new shell · 💬 new pi session · ★ save as favorite
        sendToTab && h("button", { onClick: sendToTab, title: t("cmd.k364"), "aria-label": t("cmd.k360"), style: miniBtn }, isSmall ? "⇱" : t("cmd.k56")),
        onNewShell && h("button", { onClick: onNewShell, title: t("cmd.k268"), "aria-label": t("cmd.k265"), style: miniBtn }, isSmall ? "＋" : t("cmd.k404")),
        onNewPiSession && h("button", { onClick: onNewPiSession, title: t("cmd.k264"), "aria-label": t("cmd.k261"), style: miniBtn }, isSmall ? "💬" : t("cmd.k259")),
        onSaveFavorite && saveable && h("button", { onClick: () => onSaveFavorite(meta), title: t("cmd.app.saveFavorite"), "aria-label": t("cmd.app.saveFavorite"), style: miniBtn }, "★"),
        pullBack && h("button", { onClick: pullBack, title: t("cmd.k232"), "aria-label": t("cmd.k231"), style: miniBtn }, isSmall ? "⇲" : t("cmd.k57")),
        // maximize last: sits where aiti-float injects its ⛶/❐ (before close)
        h("button", { onClick: () => setFullscreen((x) => !x), title: t("cmd.k103"), "aria-label": t("cmd.k101"), style: { ...miniBtn, background: fullscreen ? "var(--accent)" : undefined, color: fullscreen ? "#fff" : undefined } }, fullscreen ? "⤡" : "⛶"),
        exitInfo && onReopen && h("button", { onClick: onReopen, title: t("cmd.app.reopen"), style: miniBtn }, isSmall ? "↻" : t("cmd.app.reopen")),
        exitInfo && h("span", { style: { fontWeight: 700, color: exitInfo.signal ? "var(--danger, #ef4444)" : (exitInfo.code ?? 0) !== 0 ? "#b45309" : "var(--text-muted)" } }, `${t("cmd.k375")}${exitInfo.code ?? "?"}${exitInfo.signal ? " · " + exitInfo.signal : ""} · ${((exitInfo.durationMs || 0) / 1000).toFixed(1)}s`),
      ),
      h("div", { ref, style: { flex: 1, minHeight: 0, background: "#0f172a", borderRadius: 8, padding: 6, overflow: isFit ? "hidden" : "auto", touchAction: "none" } }),
      // small screens: bottom status bar (cwd/command + counts) since the top row collapses
      isSmall && meta && h("div", { style: { flexShrink: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)", padding: "4px 6px 0", overflow: "hidden", minHeight: 0, whiteSpace: "nowrap" } },
        counts && h("span", { title: t("cmd.k217"), style: { flexShrink: 0 } }, "🤖" + counts.piRunning + "/" + counts.piTotal + " 🖥" + counts.ptyRunning),
        meta.cwd && h("span", { title: t("cmd.k194"), style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 } }, "📁 " + meta.cwd),
        h("code", { title: String(meta.cmd), style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 2, color: "var(--text)" } }, "$ " + String(meta.cmd).slice(0, 60)),
      ),
      kbdOpen && keypad,
      helpOpen && help,
      h(TermLinkConfirm, { h, t, link: linkConfirm, onClose: () => setLinkConfirm(null) }),
    );
  };
}
