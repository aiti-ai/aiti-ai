/**
 * aiti-containers · client entry.
 *
 * Plain hyperscript via the host renderer (ctx.h): no JSX build step, no runtime
 * dependencies. Registers a toolbar button, a panel in the dialogs slot, and one
 * command-catalog entry so the app center / command hints can find it.
 *
 * Views (single panel, back stack of one): list → details / logs / run form.
 * Refresh is explicit only (button / after a successful action). No polling:
 * live stats arrive as frames on the shared page event bus.
 *
 * Phase 2: i18n (ctx.t), per-tab filtering, object details, port tab with
 * service-tunnels enrollment, and the three run paths (detached run / run in a
 * PTY / exec into a running container via aiti-cmd).
 */

const EXT = "aiti-containers";
const SHELLS = ["sh", "bash", "ash", "zsh"];

// Host primitives captured at register() time (modules are loaded before render).
let H: any = null;
let hostCtx: Record<string, any> | null = null;
let apiUrlFn: ((p: string) => string) | null = null;

function api(p: string): string {
  try {
    return apiUrlFn ? apiUrlFn(p) : p;
  } catch {
    return p;
  }
}

function t(key: string, params?: Record<string, unknown>): string {
  try {
    const fn = H?.t;
    return typeof fn === "function" ? String(fn(key, params)) : key;
  } catch {
    return key;
  }
}

// ---------- module-level open state (toolbar button <-> dialogs panel) ----------
let open = false;
const listeners = new Set<() => void>();
function setOpen(v: boolean): void {
  open = v;
  for (const l of listeners) l();
}
function useOpen(): boolean {
  const [v, setV] = H.useState(open);
  H.useEffect(() => {
    const l = () => setV(open);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return v;
}

// ---------- live stats (frames arrive on the shared page event bus; no dedicated SSE) ----------
const STATS_CLIENT_ID = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
let liveLeaseActive = false;

/** Published host port -> owning container (source: last /state load). Read by
 *  service-tunnels through the `aiti-containers.port-map` client service. */
let portMap: Record<number, { container: string; image: string }> = {};

/** Cross-extension deep link request (aiti-containers.open): consumed on panel mount. */
let pendingFocus: { container?: string; port?: number | string; tab?: string } | null = null;
function takePendingFocus(): typeof pendingFocus {
  const f = pendingFocus;
  pendingFocus = null;
  return f;
}

function statsSubscribe(): ((handler: (frame: any) => void, types: string[], onStatus?: (s: string) => void) => { off?: () => void } | null) | null {
  const get = hostCtx?.getExtService as ((name: string) => unknown) | undefined;
  if (typeof get !== "function") return null;
  const fn = get("aiti-event-bus.subscribe-topics");
  return typeof fn === "function" ? (fn as any) : null;
}

function statsLease(verb: "start" | "stop", keepalive = false): Promise<any> {
  return fetch(api("/api/extensions/" + EXT + "/stats/" + verb), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: STATS_CLIENT_ID }),
    keepalive,
  }).then((r) => r.json());
}

function releaseStatsOnUnload(): void {
  if (!liveLeaseActive) return;
  liveLeaseActive = false;
  try {
    const url = api("/api/extensions/" + EXT + "/stats/stop");
    const body = JSON.stringify({ clientId: STATS_CLIENT_ID });
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    } else {
      void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true });
    }
  } catch {
    /* best effort */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", releaseStatsOnUnload);
}

// ---------- cross-extension helpers (soft dependencies) ----------
async function ensureExt(id: string): Promise<void> {
  try {
    const fn = hostCtx?.ensureMaterialized as ((id: string) => Promise<boolean>) | undefined;
    if (typeof fn === "function") await fn(id);
  } catch {
    /* not materialized: callers fall back to an unavailable message */
  }
}

function extService(name: string): any {
  try {
    const fn = hostCtx?.getExtService as ((n: string) => unknown) | undefined;
    return typeof fn === "function" ? fn(name) : null;
  } catch {
    return null;
  }
}

function openCmdSession(sessionId: string, title: string): boolean {
  const openSession = extService("aiti-cmd.open-session");
  if (typeof openSession !== "function") return false;
  try {
    openSession(sessionId, title);
    return true;
  } catch {
    return false;
  }
}

// ---------- styles ----------
const overlay: Record<string, unknown> = {
  position: "fixed",
  inset: 0,
  zIndex: 320,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 12,
};
const panelStyle: Record<string, unknown> = {
  display: "flex",
  flexDirection: "column",
  width: "min(860px, 96vw)",
  height: "min(680px, 84vh)",
  maxHeight: "84vh",
  borderRadius: 10,
  background: "var(--bg-panel, #17181c)",
  border: "1px solid var(--border, #2c2e36)",
  color: "var(--text, #e6e6e6)",
  boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
  overflow: "hidden",
};
const headStyle: Record<string, unknown> = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid var(--border, #2c2e36)",
};
const tabsStyle: Record<string, unknown> = {
  display: "flex",
  gap: 4,
  padding: "8px 12px 0",
  borderBottom: "1px solid var(--border, #2c2e36)",
  flexWrap: "wrap",
  alignItems: "center",
};
const bodyStyle: Record<string, unknown> = { flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 12px" };
const footStyle: Record<string, unknown> = {
  padding: "8px 12px",
  borderTop: "1px solid var(--border, #2c2e36)",
  fontSize: 11,
  color: "var(--text-muted, #9aa0aa)",
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  alignItems: "center",
};
const rowStyle: Record<string, unknown> = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 8px",
  borderRadius: 7,
  border: "1px solid transparent",
};
const emptyStyle: Record<string, unknown> = { padding: "16px 4px", fontSize: 11.5, color: "var(--text-muted, #9aa0aa)" };
const btn = (danger?: boolean): Record<string, unknown> => ({
  background: danger ? "rgba(220,60,60,0.14)" : "rgba(255,255,255,0.06)",
  border: "1px solid " + (danger ? "rgba(220,60,60,0.45)" : "var(--border, #2c2e36)"),
  color: danger ? "#ff8a80" : "var(--text, #e6e6e6)",
  borderRadius: 5,
  fontSize: 11,
  padding: "2px 7px",
  cursor: "pointer",
  lineHeight: "18px",
  whiteSpace: "nowrap",
});
const chip: Record<string, unknown> = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 999,
  border: "1px solid var(--border, #2c2e36)",
  color: "var(--text-muted, #9aa0aa)",
};
const tabBtn = (active: boolean): Record<string, unknown> => ({
  background: active ? "rgba(255,255,255,0.10)" : "none",
  border: "none",
  borderBottom: "2px solid " + (active ? "var(--accent, #4f8cff)" : "transparent"),
  color: active ? "var(--text, #e6e6e6)" : "var(--text-muted, #9aa0aa)",
  fontSize: 12,
  padding: "5px 9px",
  cursor: "pointer",
  fontWeight: active ? 600 : 400,
});
const inputStyle: Record<string, unknown> = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid var(--border, #2c2e36)",
  color: "var(--text, #e6e6e6)",
  borderRadius: 5,
  padding: "3px 7px",
  fontSize: 11,
  minWidth: 120,
};
const areaStyle: Record<string, unknown> = { ...inputStyle, width: "100%", minHeight: 46, resize: "vertical", fontFamily: "inherit" };
const dot = (color: string): Record<string, unknown> => ({ width: 7, height: 7, borderRadius: 999, background: color, flex: "none" });

function stateColor(c: any): string {
  if (c && c.running) return "#3ecf8e";
  const s = String((c && (c.state || c.status)) || "").toLowerCase();
  if (s.startsWith("exited") || s.startsWith("stopped") || s.startsWith("created") || s.startsWith("dead")) return "#8b8f98";
  return "#e8b34a";
}

function shortText(s: unknown, n: number): string {
  const txt = String(s ?? "");
  return txt.length > n ? txt.slice(0, n - 1) + "…" : txt;
}

/** Case-insensitive AND match over several fields. */
function matches(hay: unknown[], needle: string): boolean {
  const words = String(needle || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = hay.map((x) => String(x ?? "")).join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Parse "8080:80" lines into run-form port objects. */
function parsePortLines(text: string): { ok: boolean; ports: Array<{ host: number; container: number }>; bad?: string } {
  const ports: Array<{ host: number; container: number }> = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const m = s.match(/^(\d{1,5})\s*:\s*(\d{1,5})$/);
    if (!m) return { ok: false, ports, bad: s };
    ports.push({ host: Number(m[1]), container: Number(m[2]) });
  }
  return { ok: true, ports };
}

/** Extract a compact, human-readable summary from `docker inspect` JSON. */
function detailRows(kind: string, raw: any): Array<[string, string]> {
  const d = Array.isArray(raw) ? raw[0] || {} : raw || {};
  const rows: Array<[string, string]> = [];
  const push = (k: string, v: unknown) => {
    const s = Array.isArray(v) ? v.join(", ") : v === undefined || v === null || v === "" ? "" : String(v);
    if (s) rows.push([k, shortText(s, 400)]);
  };
  if (kind === "containers") {
    push("id", d.Id);
    push("image", d.Config?.Image);
    push("state", [d.State?.Status, d.State?.Running === false ? "" : "running"].filter(Boolean).join(" · "));
    push("created", d.Created);
    push("command", (d.Config?.Cmd || []).join(" "));
    push("entrypoint", (d.Config?.Entrypoint || []).join(" "));
    push("restart", d.HostConfig?.RestartPolicy?.Name);
    push("networks", Object.keys(d.NetworkSettings?.Networks || {}));
    push("mounts", (d.Mounts || []).map((m: any) => m.Name || m.Source).slice(0, 8));
    const ports = d.NetworkSettings?.Ports || {};
    push("ports", Object.entries(ports).map(([k, v]) => k + (Array.isArray(v) && v[0] ? " -> " + (v as any[])[0].HostPort : "")).slice(0, 12));
    push("env", (d.Config?.Env || []).map((e: string) => (e.includes("PASS") || e.includes("TOKEN") || e.includes("SECRET") ? e.split("=")[0] + "=***" : e)).slice(0, 10));
  } else if (kind === "images") {
    push("id", d.Id);
    push("tags", d.RepoTags);
    push("created", d.Created);
    push("size", d.Size ? (Number(d.Size) / 1024 / 1024).toFixed(1) + " MB" : "");
    push("entrypoint", (d.Config?.Entrypoint || []).join(" "));
    push("cmd", (d.Config?.Cmd || []).join(" "));
    push("env", (d.Config?.Env || []).slice(0, 10));
  } else if (kind === "volumes") {
    push("name", d.Name);
    push("driver", d.Driver);
    push("scope", d.Scope);
    push("mountpoint", d.Mountpoint);
    push("created", d.CreatedAt);
    push("labels", Object.keys(d.Labels || {}));
  } else if (kind === "networks") {
    push("id", d.Id);
    push("driver", d.Driver);
    push("scope", d.Scope);
    push("subnet", (d.IPAM?.Config || []).map((c: any) => c.Subnet).join(", "));
    push("gateway", (d.IPAM?.Config || []).map((c: any) => c.Gateway).join(", "));
    push("containers", Object.values(d.Containers || {}).map((c: any) => c.Name).slice(0, 12));
  }
  return rows;
}

// ---------- toolbar button ----------
function ToolbarButton() {
  const { h } = H;
  useOpen();
  return h(
    "button",
    {
      type: "button",
      title: t("ac.toolbar.title"),
      onClick: () => setOpen(true),
      style: { display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, padding: 0, background: "none", border: "none", color: "var(--text-muted, #9aa0aa)", cursor: "pointer" },
    },
    h(
      "svg",
      { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" }),
      h("path", { d: "m3.3 7 8.7 5 8.7-5" }),
      h("path", { d: "M12 22V12" }),
    ),
  );
}

// ---------- panel ----------
function Panel() {
  const { h, useState, useEffect } = H;
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [tab, setTab] = useState("containers");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<any>(null); // {kind:"details"|"logs"|"run", ...}
  const [pending, setPending] = useState<any>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [live, setLive] = useState(false);
  const [liveNote, setLiveNote] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [portContainer, setPortContainer] = useState("");
  const [focus, setFocus] = useState<any>(null);
  const [stats, setStats] = useState<Record<string, any>>({});
  const [usage, setUsage] = useState<any[]>([]);
  const subRef = H.useRef<any>(null);

  const load = (force: boolean) => {
    setLoading(true);
    setError("");
    fetch(api("/api/extensions/" + EXT + "/state" + (force ? "?refresh=1" : "")), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setData(d || null);
        const next: Record<number, { container: string; image: string }> = {};
        for (const c of (d && d.containers) || []) {
          for (const p of c.portsList || []) {
            if (!p || !p.published || !p.hostPort) continue;
            if (!next[p.hostPort]) next[p.hostPort] = { container: String(c.name || ""), image: String(c.image || "") };
          }
        }
        portMap = next;
        if (d && d.ok === false && !d.containers) setError(String(d.error || (d.errors && d.errors[0] && d.errors[0].error) || ""));
      })
      .catch((e) => setError(t("ac.msg.requestFailed", { error: String((e && e.message) || e) })))
      .finally(() => setLoading(false));
    fetch(api("/api/extensions/" + EXT + "/usage"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d && Array.isArray(d.usage) && d.usage.length) setUsage(d.usage);
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    load(true);
    const req = takePendingFocus();
    if (req) setFocus(req);
  }, []);

  // Deep link: once the container list is in, jump to the requested object.
  useEffect(() => {
    if (!focus || !data) return;
    if (focus.container) {
      const target = ((data.containers || []) as any[]).find((x) => x.name === focus.container);
      if (target) {
        setTab("containers");
        setFilter(String(focus.container));
        openDetails("containers", target);
        setFocus(null);
      }
    } else if (focus.port !== undefined) {
      setTab("ports");
      setFilter(String(focus.port));
      setFocus(null);
    }
  }, [focus, data]);

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), 5000);
    return () => clearTimeout(timer);
  }, [pending]);

  // ---------- live stats ----------
  const startLive = () => {
    const subFn = statsSubscribe();
    if (!subFn) {
      setLiveNote(t("ac.msg.busUnavailable"));
      return;
    }
    setLiveNote("");
    statsLease("start")
      .then((d) => {
        if (!d || !d.running) {
          setLiveNote(t("ac.msg.liveUnavailable", { detail: d && d.error ? "：" + String(d.error) : "" }));
          return;
        }
        liveLeaseActive = true;
        const sub = subFn(
          (frame: any) => {
            if (frame && frame.samples) setStats(frame.samples);
          },
          ["containers-stats"],
          (s: string) => {
            if (s === "up" && liveLeaseActive) void statsLease("start").catch(() => undefined);
          },
        );
        subRef.current = sub || null;
        setLive(true);
      })
      .catch((e) => setLiveNote(t("ac.msg.liveFailed", { error: String((e && e.message) || e) })));
  };

  const stopLive = () => {
    setLive(false);
    setStats({});
    setLiveNote("");
    const sub = subRef.current;
    subRef.current = null;
    try {
      sub?.off?.();
    } catch {
      /* noop */
    }
    if (liveLeaseActive) {
      liveLeaseActive = false;
      try {
        void statsLease("stop", true);
      } catch {
        /* noop */
      }
    }
  };

  useEffect(
    () => () => {
      const sub = subRef.current;
      subRef.current = null;
      try {
        sub?.off?.();
      } catch {
        /* noop */
      }
      releaseStatsOnUnload();
    },
    [],
  );

  // ---------- ports (loaded on demand; enrollment status comes from service-tunnels) ----------
  const loadPorts = () => {
    fetch(api("/api/extensions/" + EXT + "/ports"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setPorts(d || null))
      .catch(() => setPorts({ ok: false, ports: [] }));
  };
  useEffect(() => {
    if (tab === "ports") loadPorts();
  }, [tab]);

  const enroll = (port: number, mode: "enroll" | "unenroll") => {
    setError("");
    setNote("");
    fetch(api("/api/extensions/" + EXT + "/expose"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port, mode }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d || d.ok === false) {
          setError(t("ac.msg.enrollFailed", { error: String((d && d.error) || "") }));
          return;
        }
        setNote(t(mode === "enroll" ? "ac.msg.enrolled" : "ac.msg.unenrolled", { port }));
        loadPorts();
      })
      .catch((e) => setError(t("ac.msg.enrollFailed", { error: String((e && e.message) || e) })));
  };

  const copyText = (text: unknown, key: string) => {
    try {
      void navigator.clipboard?.writeText(String(text ?? ""));
    } catch {
      /* clipboard unavailable */
    }
    setCopied(key);
    setTimeout(() => setCopied((cur) => (cur === key ? null : cur)), 1500);
  };

  /** Fill the run form from the remembered defaults (stateDir/run-defaults.json). */
  const loadRunDefaults = () => {
    fetch(api("/api/extensions/" + EXT + "/run-defaults"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const def = d && d.defaults;
        if (!def) return;
        setDraft((cur) => ({
          ...cur,
          runName: cur.runName || String(def.name || ""),
          runPorts: cur.runPorts || (def.ports || []).map((x: any) => x.host + ":" + x.container).join("\n"),
          runEnv: cur.runEnv || (def.env || []).join("\n"),
          runRm: cur.runRm !== undefined ? cur.runRm : def.rm === true ? "1" : "0",
        }));
      })
      .catch(() => undefined);
  };

  const saveRunDefaults = (body: { name?: string; ports?: unknown[]; env?: string[]; rm?: boolean }) => {
    fetch(api("/api/extensions/" + EXT + "/run-defaults"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: body.name || "", ports: body.ports || [], env: body.env || [], rm: body.rm === true }),
    }).catch(() => undefined);
  };

  /** Open the tunnel panel; with a port it deep-links that port's expose form. */
  const openTunnels = (port?: number) => {
    ensureExt("service-tunnels").then(() => {
      const openDialog = extService("service-tunnels.open-dialog");
      if (typeof openDialog === "function") {
        try {
          openDialog("ports", port ? { port } : undefined);
          return;
        } catch {
          /* fall through */
        }
      }
      setError(t("ac.msg.openTunnelFallback"));
    });
  };

  /** Enroll (if needed) then deep-link the tunnel panel's expose form for this port. */
  const exposePort = (p: any) => {
    const go = () => openTunnels(Number(p.port));
    if (p.enrolled) {
      go();
      return;
    }
    setError("");
    fetch(api("/api/extensions/" + EXT + "/expose"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: Number(p.port), mode: "enroll" }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d || d.ok === false) {
          setError(t("ac.msg.enrollFailed", { error: String((d && d.error) || "") }));
          return;
        }
        setNote(t("ac.msg.exposeOpened", { port: p.port }));
        loadPorts();
        go();
      })
      .catch((e) => setError(t("ac.msg.enrollFailed", { error: String((e && e.message) || e) })));
  };

  // ---------- terminal / run ----------
  const openTerminal = (c: any, shell: string) => {
    setError("");
    fetch(api("/api/extensions/" + EXT + "/exec-session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: c.id, shell, name: c.name }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d || d.ok === false || !d.sessionId) {
          setError(String((d && d.error) || t("ac.msg.terminalUnavailable")));
          return;
        }
        if (!openCmdSession(String(d.sessionId), "容器 " + String(c.name))) setError(t("ac.msg.terminalUnavailable"));
        else setOpen(false);
      })
      .catch((e) => setError(t("ac.msg.terminalUnavailable") + " " + String((e && e.message) || e)));
  };

  const submitRun = () => {
    const interactive = view && view.interactive === true;
    const reference = String((view && view.reference) || draft.runRef || "").trim();
    if (!reference) return;
    const parsed = parsePortLines(draft.runPorts || "");
    if (!parsed.ok) {
      setError(t("ac.form.invalidPort", { value: String(parsed.bad || "") }));
      return;
    }
    const body = {
      reference,
      name: String(draft.runName || "").trim() || undefined,
      ports: parsed.ports,
      env: String(draft.runEnv || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      command: String(draft.runCommand || "").trim() || undefined,
      rm: interactive ? (draft.runRm !== "0") : draft.runRm === "1",
    };
    setError("");
    setNote("");
    const url = interactive ? "/image-session" : "/action";
    const payload = interactive ? body : { kind: "images", action: "run", ...body };
    fetch(api("/api/extensions/" + EXT + url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d || d.ok === false) {
          setError(t("ac.msg.actionFailed", { error: String((d && d.error) || "") }));
          return;
        }
        saveRunDefaults(body);
        if (interactive) {
          if (!openCmdSession(String(d.sessionId), "镜像 " + reference)) setError(t("ac.msg.terminalUnavailable"));
          else setOpen(false);
          return;
        }
        setView(null);
        setNote(t("ac.msg.runOk", { name: body.name || String((d.stdout || "").trim().slice(0, 12)) }));
        load(false);
      })
      .catch((e) => setError(t("ac.msg.actionFailed", { error: String((e && e.message) || e) })));
  };

  // ---------- details / logs ----------
  const openDetails = (kind: string, item: any) => {
    setDetail({ loading: true, kind, item, rows: [], raw: "" });
    setView({ kind: "details" });
    const id = kind === "containers" ? item.id : kind === "images" ? item.id : kind === "volumes" ? item.name : item.id;
    fetch(api("/api/extensions/" + EXT + "/inspect?kind=" + encodeURIComponent(kind) + "&id=" + encodeURIComponent(String(id))), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        let raw: any = null;
        try {
          raw = d && d.text ? JSON.parse(d.text) : null;
        } catch {
          raw = null;
        }
        setDetail({ loading: false, kind, item, rows: raw ? detailRows(kind, raw) : [], raw: (d && d.text) || "", error: (d && d.error) || "" });
      })
      .catch((e) => setDetail({ loading: false, kind, item, rows: [], raw: "", error: String((e && e.message) || e) }));
  };

  const openContainerByName = (name: string) => {
    setView(null);
    setTab("containers");
    setFilter(name);
    const target = containers.find((x) => x.name === name);
    if (target) openDetails("containers", target);
  };

  const openLogs = (target: Record<string, unknown>) => {
    setView({ kind: "logs", ...target, text: "", loading: true });
    const q = new URLSearchParams();
    if (target.compose) {
      q.set("kind", "compose");
      q.set("project", String(target.project || ""));
      if (target.dir) q.set("dir", String(target.dir));
    } else {
      q.set("kind", "containers");
      q.set("id", String(target.id || ""));
    }
    q.set("tail", String(target.tail || 200));
    fetch(api("/api/extensions/" + EXT + "/logs?" + q.toString()), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) =>
        setView((v: any) => (v && v.kind === "logs" ? { ...v, loading: false, text: String((d && d.text) || ""), error: (d && d.error) || "", truncated: !!(d && d.truncated) } : v)),
      )
      .catch((e) => setView((v: any) => (v && v.kind === "logs" ? { ...v, loading: false, text: "", error: String((e && e.message) || e) } : v)));
  };

  // ---------- actions with danger confirmation ----------
  const post = (kind: string, action: string, extra: Record<string, unknown>) => {
    setNote("");
    setError("");
    const key = kind + "." + action + ":" + String(extra.id || extra.project || extra.name || "");
    fetch(api("/api/extensions/" + EXT + "/action"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, action, ...extra }),
    })
      .then((r) => r.json().then((d) => ({ status: r.status, d })))
      .then(({ status, d }) => {
        if (status === 428 || (d && d.needConfirm)) {
          setPending({ key, label: String((d && d.danger) || kind + "." + action) });
          return;
        }
        if (d && d.ok === false) {
          setError(t("ac.msg.actionFailed", { error: String(d.error || "") }));
          return;
        }
        setNote(t("ac.msg.done", { cmd: String((d && d.sent) || kind + "." + action) }));
        load(false);
      })
      .catch((e) => setError(t("ac.msg.actionFailed", { error: String((e && e.message) || e) })));
  };

  const act = (kind: string, action: string, extra: Record<string, unknown>) => {
    const key = kind + "." + action + ":" + String(extra.id || extra.project || extra.name || "");
    if (pending && pending.key === key) {
      setPending(null);
      post(kind, action, { ...extra, confirm: true });
      return;
    }
    post(kind, action, extra);
  };

  // ---------- data shaping ----------
  const rt = data && data.runtime;
  const containers: any[] = (data && data.containers) || [];
  const images: any[] = (data && data.images) || [];
  const volumes: any[] = (data && data.volumes) || [];
  const networks: any[] = (data && data.networks) || [];
  const projects: any[] = (data && data.composeProjects) || [];
  const usageRows: any[] = usage.length ? usage : (data && data.usage) || [];
  const showStopped = !data || data.showStopped !== false;
  const visible = (showStopped ? containers : containers.filter((c) => c.running)).filter((c) =>
    matches([c.name, c.image, c.ports, c.compose && c.compose.project, c.compose && c.compose.service], filter),
  );
  const byProject = new Map<string, any[]>();
  const loose: any[] = [];
  for (const c of visible) {
    const p = c.compose && c.compose.project;
    if (p) {
      const arr = byProject.get(p) || [];
      arr.push(c);
      byProject.set(p, arr);
    } else loose.push(c);
  }
  const filteredImages = images.filter((im) => matches([im.ref, im.id, im.size], filter));
  const filteredVolumes = volumes.filter((v) => matches([v.name, v.driver, v.mountpoint], filter));
  const filteredNetworks = networks.filter((n) => matches([n.name, n.driver, n.scope], filter));
  const filteredPorts: any[] = ((ports && ports.ports) || []).filter(
    (p: any) => (!portContainer || p.container === portContainer) && matches([p.port, p.containerPort, p.container, p.image, p.proto], filter),
  );

  // ---------- small builders ----------
  const actionButtons = (c: any) => {
    const nodes: any[] = [];
    if (c.running) {
      nodes.push(h("button", { key: "stop", style: btn(), title: t("ac.action.stop"), onClick: () => act("containers", "stop", { id: c.id }) }, "■"));
      nodes.push(h("button", { key: "restart", style: btn(), title: t("ac.action.restart"), onClick: () => act("containers", "restart", { id: c.id }) }, "↻"));
    } else {
      nodes.push(h("button", { key: "start", style: btn(), title: t("ac.action.start"), onClick: () => act("containers", "start", { id: c.id }) }, "▶"));
    }
    nodes.push(h("button", { key: "logs", style: btn(), title: t("ac.action.logs"), onClick: () => openLogs({ id: c.id, title: c.name, tail: (data && data.defaultTail) || 200 }) }, t("ac.action.logs")));
    nodes.push(h("button", { key: "details", style: btn(), title: t("ac.action.details"), onClick: () => openDetails("containers", c) }, t("ac.action.details")));
    if (c.running) {
      nodes.push(h("button", { key: "term", style: btn(), title: t("ac.action.terminal"), onClick: () => openTerminal(c, "sh") }, t("ac.action.terminal")));
    }
    nodes.push(
      h("button", { key: "rm", style: btn(true), title: t("ac.action.remove"), onClick: () => act("containers", "remove", { id: c.id, force: true }) }, pending && pending.key === "containers.remove:" + c.id ? t("ac.action.reclick") : t("ac.action.remove")),
    );
    return nodes;
  };

  const containerRow = (c: any) => {
    const st = live ? stats[c.name] : null;
    const sub = [c.image, c.status, c.ports, st ? "CPU " + st.cpu + " · MEM " + st.memPerc : ""].filter(Boolean).join(" · ");
    return h(
      "div",
      { key: c.id, style: rowStyle, onMouseEnter: (e: any) => (e.currentTarget.style.background = "rgba(255,255,255,0.035)"), onMouseLeave: (e: any) => (e.currentTarget.style.background = "transparent") },
      h("span", { style: dot(stateColor(c)) }),
      h(
        "div",
        { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.name),
        h("div", { style: { fontSize: 10.5, color: "var(--text-muted, #9aa0aa)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, sub),
      ),
      c.compose && c.compose.service ? h("span", { style: chip }, c.compose.service) : null,
      h("div", { style: { display: "flex", gap: 4, flex: "none" } }, actionButtons(c)),
    );
  };

  const groupHeader = (key: string, title: string, badge: string, extraActions: any[]) => {
    const isCollapsed = !!collapsed[key];
    return h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, padding: "8px 4px 4px", marginTop: 6, flexWrap: "wrap" } },
      h("button", { style: { ...btn(), border: "none", background: "none", padding: "0 2px", fontSize: 11 }, title: isCollapsed ? "▸" : "▾", onClick: () => setCollapsed((m) => ({ ...m, [key]: !m[key] })) }, isCollapsed ? "▸" : "▾"),
      h("span", { style: { fontSize: 11.5, fontWeight: 700, letterSpacing: 0.2 } }, title),
      h("span", { style: chip }, badge),
      h("div", { style: { flex: 1 } }),
      ...extraActions,
    );
  };

  // ---------- views ----------
  const containersView = () => {
    if (!visible.length) return h("div", { style: emptyStyle }, loading ? t("ac.loading") : filter ? t("ac.noMatch") : t("ac.empty.containers"));
    const nodes: any[] = [];
    for (const p of projects) {
      const list = byProject.get(p.project);
      if (!list || !list.length) continue;
      const key = "p:" + p.project;
      const confirmKey = "compose.down:" + p.project;
      nodes.push(
        groupHeader(key, p.project, t("ac.group.count", { running: p.running, total: p.total }), [
          h("button", { key: "up", style: btn(), title: "compose up -d", onClick: () => act("compose", "up", { project: p.project, dir: p.workingDir }) }, t("ac.group.up")),
          h("button", { key: "restart", style: btn(), title: "compose restart", onClick: () => act("compose", "restart", { project: p.project, dir: p.workingDir }) }, t("ac.group.restart")),
          h("button", { key: "logs", style: btn(), title: t("ac.group.logs"), onClick: () => openLogs({ compose: true, project: p.project, dir: p.workingDir, title: "compose · " + p.project }) }, t("ac.action.logs")),
          h("button", { key: "down", style: btn(true), title: "compose down", onClick: () => act("compose", "down", { project: p.project, dir: p.workingDir }) }, pending && pending.key === confirmKey ? t("ac.action.reclick") : t("ac.group.down")),
        ]),
      );
      if (!collapsed[key]) for (const c of list) nodes.push(containerRow(c));
    }
    if (loose.length) {
      const key = "p:__loose";
      nodes.push(groupHeader(key, t("ac.group.loose"), String(loose.length), []));
      if (!collapsed[key]) for (const c of loose) nodes.push(containerRow(c));
    }
    return nodes;
  };

  const imagesView = () => {
    const nodes: any[] = [
      h(
        "div",
        { style: { display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" } },
        h("input", { style: { ...inputStyle, minWidth: 220 }, placeholder: "nginx:alpine", value: draft.pull || "", onInput: (e: any) => setDraft((d) => ({ ...d, pull: e.target.value })) }),
        h("button", { style: btn(), onClick: () => (draft.pull || "").trim() && act("images", "pull", { reference: (draft.pull || "").trim() }) }, t("ac.action.pull")),
        h("button", { style: btn(), onClick: () => act("images", "prune", {}) }, pending && pending.key === "images.prune:" ? t("ac.action.reclick") : t("ac.action.pruneDangling")),
      ),
    ];
    if (!filteredImages.length) nodes.push(h("div", { style: emptyStyle }, loading ? t("ac.loading") : filter ? t("ac.noMatch") : t("ac.empty.images")));
    for (const im of filteredImages) {
      const key = "images.remove:" + (im.dangling ? im.id : im.ref);
      nodes.push(
        h(
          "div",
          { key: im.id + im.ref, style: rowStyle },
          h("span", { style: dot(im.dangling ? "#e8b34a" : "#7aa2f7") }),
          h(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, im.ref),
            h("div", { style: { fontSize: 10.5, color: "var(--text-muted, #9aa0aa)" } }, [im.size, im.dangling ? "dangling" : "", shortText(im.id, 19)].filter(Boolean).join(" · ")),
          ),
          h("button", { style: btn(), title: t("ac.action.run"), onClick: () => { loadRunDefaults(); setView({ kind: "run", interactive: false, reference: im.ref }); setDraft((d) => ({ ...d, runRef: im.ref })); } }, t("ac.action.run")),
          h("button", { style: btn(), title: t("ac.action.runTerminal"), onClick: () => { loadRunDefaults(); setView({ kind: "run", interactive: true, reference: im.ref }); setDraft((d) => ({ ...d, runRef: im.ref })); } }, t("ac.action.runTerminal")),
          h("button", { style: btn(), onClick: () => openDetails("images", im) }, t("ac.action.details")),
          h("button", { style: btn(true), onClick: () => act("images", "remove", { id: im.id }) }, pending && pending.key === key ? t("ac.action.reclick") : t("ac.action.remove")),
        ),
      );
    }
    return nodes;
  };

  const volumesView = () => {
    const name = draft.volume || "";
    const nodes: any[] = [
      h(
        "div",
        { style: { display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" } },
        h("input", { style: inputStyle, placeholder: t("ac.form.name"), value: name, onInput: (e: any) => setDraft((d) => ({ ...d, volume: e.target.value })) }),
        h("button", { style: btn(), onClick: () => name.trim() && act("volumes", "create", { name: name.trim() }) }, t("ac.action.create")),
        h("button", { style: btn(), onClick: () => act("volumes", "prune", {}) }, pending && pending.key === "volumes.prune:" ? t("ac.action.reclick") : t("ac.action.pruneVolumes")),
      ),
    ];
    if (!filteredVolumes.length) nodes.push(h("div", { style: emptyStyle }, loading ? t("ac.loading") : filter ? t("ac.noMatch") : t("ac.empty.volumes")));
    for (const v of filteredVolumes) {
      const key = "volumes.remove:" + v.name;
      nodes.push(
        h(
          "div",
          { key: v.name, style: rowStyle },
          h("span", { style: dot("#7aa2f7") }),
          h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontSize: 12, fontWeight: 600 } }, v.name), h("div", { style: { fontSize: 10.5, color: "var(--text-muted, #9aa0aa)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, [v.driver, v.mountpoint].filter(Boolean).join(" · "))),
          h("button", { style: btn(), onClick: () => openDetails("volumes", v) }, t("ac.action.details")),
          h("button", { style: btn(true), onClick: () => act("volumes", "remove", { id: v.name }) }, pending && pending.key === key ? t("ac.action.reclick") : t("ac.action.remove")),
        ),
      );
    }
    return nodes;
  };

  const networksView = () => {
    const name = draft.network || "";
    const nodes: any[] = [
      h(
        "div",
        { style: { display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" } },
        h("input", { style: inputStyle, placeholder: t("ac.form.name"), value: name, onInput: (e: any) => setDraft((d) => ({ ...d, network: e.target.value })) }),
        h("button", { style: btn(), onClick: () => name.trim() && act("networks", "create", { name: name.trim() }) }, t("ac.action.create")),
        h("button", { style: btn(), onClick: () => act("networks", "prune", {}) }, pending && pending.key === "networks.prune:" ? t("ac.action.reclick") : t("ac.action.pruneNetworks")),
      ),
    ];
    if (!filteredNetworks.length) nodes.push(h("div", { style: emptyStyle }, loading ? t("ac.loading") : filter ? t("ac.noMatch") : t("ac.empty.networks")));
    for (const n of filteredNetworks) {
      const key = "networks.remove:" + n.id;
      nodes.push(
        h(
          "div",
          { key: n.id, style: rowStyle },
          h("span", { style: dot(n.name === "bridge" || n.name === "host" || n.name === "none" ? "#8b8f98" : "#7aa2f7") }),
          h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontSize: 12, fontWeight: 600 } }, n.name), h("div", { style: { fontSize: 10.5, color: "var(--text-muted, #9aa0aa)" } }, [n.driver, n.scope, n.ipv6 ? "IPv6" : ""].filter(Boolean).join(" · "))),
          h("button", { style: btn(), onClick: () => openDetails("networks", n) }, t("ac.action.details")),
          h("button", { style: btn(true), onClick: () => act("networks", "remove", { id: n.id }) }, pending && pending.key === key ? t("ac.action.reclick") : t("ac.action.remove")),
        ),
      );
    }
    return nodes;
  };

  const portsView = () => {
    if (!ports) return h("div", { style: emptyStyle }, t("ac.loading"));
    const tunnelsAvailable = ports.tunnelsAvailable === true;
    const nodes: any[] = [];
    if (portContainer) {
      nodes.push(
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 } },
          h("span", { style: { ...chip, borderColor: "var(--accent, #4f8cff)", color: "var(--accent, #4f8cff)" } }, t("ac.filter.container", { name: portContainer })),
          h("button", { style: btn(), onClick: () => setPortContainer("") }, t("ac.filter.clear")),
        ),
      );
    }
    if (!tunnelsAvailable) nodes.push(h("div", { style: { ...emptyStyle, color: "#e8b34a" } }, t("ac.port.tunnelsOff")));
    if (!filteredPorts.length) nodes.push(h("div", { style: emptyStyle }, filter ? t("ac.noMatch") : t("ac.empty.ports")));
    for (const p of filteredPorts) {
      nodes.push(
        h(
          "div",
          { key: p.port + "/" + p.proto, style: rowStyle },
          h("span", { style: dot(p.enrolled ? "#3ecf8e" : "#7aa2f7") }),
          h(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            h(
              "div",
              { style: { fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
              h("span", null, String(p.port) + " → " + String(p.containerPort) + "/" + String(p.proto) + "  ·  "),
              h(
                "button",
                { style: { ...btn(), border: "none", background: "none", padding: 0, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--accent, #4f8cff)" }, title: t("ac.action.details") + " · " + String(p.image || ""), onClick: () => openContainerByName(String(p.container)) },
                String(p.container),
              ),
            ),
            h("div", { style: { fontSize: 10.5, color: "var(--text-muted, #9aa0aa)" } }, [p.image, p.project ? p.project + "/" + (p.service || "") : "", p.hostIp].filter(Boolean).join(" · ")),
          ),
          h("button", { style: btn(), title: t("ac.filter.container", { name: p.container }), onClick: () => setPortContainer(String(p.container)) }, t("ac.filter.only")),
          h("span", { style: { ...chip, color: p.enrolled ? "#3ecf8e" : undefined } }, p.enrolled ? t("ac.port.enrolled") : t("ac.port.notEnrolled")),
          p.enrolled
            ? h("button", { style: btn(), title: t("ac.action.unenroll"), onClick: () => enroll(p.port, "unenroll") }, t("ac.action.unenroll"))
            : h("button", { style: btn(), title: t("ac.action.enroll"), disabled: !tunnelsAvailable, onClick: () => enroll(p.port, "enroll") }, t("ac.action.enroll")),
          h("button", { style: btn(), title: t("ac.port.publicHint"), disabled: !tunnelsAvailable, onClick: () => exposePort(p) }, t("ac.action.expose")),
        ),
      );
    }
    if (tunnelsAvailable && filteredPorts.length) nodes.push(h("div", { style: { ...emptyStyle, fontSize: 10.5 } }, t("ac.port.publicHint")));
    return nodes;
  };

  const detailActions = () => {
    if (!detail) return [];
    const kind = String(detail.kind || "");
    const item = detail.item || {};
    if (kind === "containers") {
      const nodes: any[] = [];
      nodes.push(
        item.running
          ? h("button", { key: "stop", style: btn(), onClick: () => act("containers", "stop", { id: item.id }) }, t("ac.action.stop"))
          : h("button", { key: "start", style: btn(), onClick: () => act("containers", "start", { id: item.id }) }, t("ac.action.start")),
      );
      nodes.push(h("button", { key: "restart", style: btn(), onClick: () => act("containers", "restart", { id: item.id }) }, t("ac.action.restart")));
      if (item.running) nodes.push(h("button", { key: "term", style: btn(), onClick: () => openTerminal(item, "sh") }, t("ac.action.terminal")));
      nodes.push(h("button", { key: "logs", style: btn(), onClick: () => openLogs({ id: item.id, title: item.name, tail: (data && data.defaultTail) || 200 }) }, t("ac.action.logs")));
      nodes.push(
        h("button", { key: "rm", style: btn(true), onClick: () => act("containers", "remove", { id: item.id, force: true }) }, pending && pending.key === "containers.remove:" + item.id ? t("ac.action.reclick") : t("ac.action.remove")),
      );
      return nodes;
    }
    if (kind === "images") {
      return [
        h("button", { key: "run", style: btn(), onClick: () => { loadRunDefaults(); setView({ kind: "run", interactive: false, reference: item.ref }); setDraft((d) => ({ ...d, runRef: item.ref })); } }, t("ac.action.run")),
        h("button", { key: "run-t", style: btn(), onClick: () => { loadRunDefaults(); setView({ kind: "run", interactive: true, reference: item.ref }); setDraft((d) => ({ ...d, runRef: item.ref })); } }, t("ac.action.runTerminal")),
        h("button", { key: "rm", style: btn(true), onClick: () => act("images", "remove", { id: item.id }) }, t("ac.action.remove")),
      ];
    }
    const id = kind === "volumes" ? item.name : item.id;
    return [h("button", { key: "rm", style: btn(true), onClick: () => act(kind, "remove", { id }) }, t("ac.action.remove"))];
  };

  const detailsView = () => {
    if (!detail) return null;
    const title = detail.item ? detail.item.name || detail.item.ref || detail.item.id : "";
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 8 } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
        h("button", { style: btn(), onClick: () => { setView(null); setDetail(null); } }, t("ac.btn.back")),
        h("span", { style: { fontSize: 12, fontWeight: 700 } }, t("ac.detail.title", { name: String(title) })),
        h("div", { style: { flex: 1 } }),
        ...detailActions(),
        h("button", { style: btn(), onClick: () => copyText(detail.item?.id || detail.item?.name || "", "copy-id") }, copied === "copy-id" ? t("ac.msg.copied") : t("ac.action.copyId")),
        h("button", { style: btn(), onClick: () => { try { window.open("data:application/json;charset=utf-8," + encodeURIComponent(detail.raw || "{}"), "_blank"); } catch { /* noop */ } } }, t("ac.detail.openRaw")),
      ),
      detail.loading
        ? h("div", { style: emptyStyle }, t("ac.detail.loading"))
        : h(
            "div",
            { style: { border: "1px solid var(--border, #2c2e36)", borderRadius: 8, padding: 8 } },
            ...(detail.rows || []).map(([k, v]: [string, string]) =>
              h(
                "div",
                { key: k, style: { display: "flex", gap: 8, padding: "3px 2px", fontSize: 11.5, alignItems: "flex-start" } },
                h("span", { style: { width: 92, flex: "none", color: "var(--text-muted, #9aa0aa)" } }, k),
                h("span", { style: { flex: 1, wordBreak: "break-all" } }, v),
                h("button", { style: { ...btn(), padding: "0 5px", flex: "none" }, title: t("ac.action.copy"), onClick: () => copyText(v, k) }, copied === k ? "✓" : "📋"),
              ),
            ),
            detail.error ? h("div", { style: { color: "#ff8a80", fontSize: 11 } }, String(detail.error)) : null,
            h(
              "details",
              { style: { marginTop: 6 } },
              h("summary", { style: { fontSize: 11, cursor: "pointer", color: "var(--text-muted, #9aa0aa)" } }, t("ac.detail.raw")),
              h("pre", { style: { margin: "6px 0 0", maxHeight: 240, overflow: "auto", fontSize: 10, lineHeight: 1.4, background: "rgba(0,0,0,0.35)", padding: 8, borderRadius: 6 } }, detail.raw || t("ac.detail.none")),
            ),
          ),
    );
  };

  const logsView = () => {
    if (!view || view.kind !== "logs") return null;
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 6, height: "100%" } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
        h("button", { style: btn(), onClick: () => setView(null) }, t("ac.btn.back")),
        h("span", { style: { fontSize: 12, fontWeight: 600, flex: 1 } }, String(view.title || view.id || view.project)),
        ...[200, 500, 2000].map((n) => h("button", { key: n, style: btn(), onClick: () => openLogs({ ...view, tail: n }) }, String(n))),
        h("button", { style: btn(), onClick: () => openLogs(view) }, t("ac.btn.refresh")),
      ),
      view.loading
        ? h("div", { style: emptyStyle }, t("ac.loading"))
        : h(
            "pre",
            { style: { flex: 1, margin: 0, overflow: "auto", fontSize: 10.5, lineHeight: 1.45, background: "rgba(0,0,0,0.35)", padding: 8, borderRadius: 6, minHeight: 220, maxHeight: "54vh" } },
            view.error ? "[" + view.error + "]\n" + (view.text || "") : view.text || "(empty)",
          ),
      view.truncated ? h("div", { style: { fontSize: 10.5, color: "var(--text-muted, #9aa0aa)" } }, t("ac.msg.truncated")) : null,
    );
  };

  const runView = () => {
    if (!view || view.kind !== "run") return null;
    const interactive = view.interactive === true;
    const rmDefault = interactive ? "1" : "0";
    const rmValue = draft.runRm === undefined ? rmDefault : draft.runRm;
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 8 } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8 } },
        h("button", { style: btn(), onClick: () => setView(null) }, t("ac.btn.back")),
        h("span", { style: { fontSize: 12, fontWeight: 700 } }, t(interactive ? "ac.form.runTerminalTitle" : "ac.form.runTitle")),
      ),
      h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } }, h("span", { style: { width: 110, fontSize: 11, color: "var(--text-muted, #9aa0aa)" } }, t("ac.form.reference")), h("span", { style: { fontSize: 12, fontWeight: 600 } }, String(view.reference))),
      h("label", { style: { display: "flex", gap: 8, alignItems: "center" } }, h("span", { style: { width: 110, fontSize: 11, color: "var(--text-muted, #9aa0aa)" } }, t("ac.form.name")), h("input", { style: { ...inputStyle, flex: 1 }, placeholder: t("ac.form.namePlaceholder"), value: draft.runName || "", onInput: (e: any) => setDraft((d) => ({ ...d, runName: e.target.value })) })),
      h("label", { style: { display: "flex", gap: 8, alignItems: "flex-start" } }, h("span", { style: { width: 110, fontSize: 11, color: "var(--text-muted, #9aa0aa)" } }, t("ac.form.ports")), h("textarea", { style: areaStyle, placeholder: t("ac.form.portsPlaceholder"), value: draft.runPorts || "", onInput: (e: any) => setDraft((d) => ({ ...d, runPorts: e.target.value })) })),
      h("label", { style: { display: "flex", gap: 8, alignItems: "flex-start" } }, h("span", { style: { width: 110, fontSize: 11, color: "var(--text-muted, #9aa0aa)" } }, t("ac.form.env")), h("textarea", { style: areaStyle, placeholder: t("ac.form.envPlaceholder"), value: draft.runEnv || "", onInput: (e: any) => setDraft((d) => ({ ...d, runEnv: e.target.value })) })),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 2 } },
        h("label", { style: { display: "flex", gap: 8, alignItems: "center" } }, h("span", { style: { width: 110, fontSize: 11, color: "var(--text-muted, #9aa0aa)" } }, t("ac.form.command")), h("input", { style: { ...inputStyle, flex: 1 }, placeholder: t("ac.form.commandPlaceholder"), value: draft.runCommand || "", onInput: (e: any) => setDraft((d) => ({ ...d, runCommand: e.target.value })) })),
        h("div", { style: { fontSize: 10, color: "var(--text-muted, #9aa0aa)", paddingLeft: 118 } }, t("ac.form.commandHint")),
      ),
      h("label", { style: { display: "flex", gap: 8, alignItems: "center" } }, h("span", { style: { width: 110, fontSize: 11, color: "var(--text-muted, #9aa0aa)" } }, t("ac.form.rm")), h("input", { type: "checkbox", checked: rmValue === "1", onChange: (e: any) => setDraft((d) => ({ ...d, runRm: e.target.checked ? "1" : "0" })) })),
      h("div", { style: { display: "flex", gap: 6, marginTop: 4 } }, h("button", { style: btn(), onClick: submitRun }, t("ac.form.submit")), h("button", { style: btn(), onClick: () => setView(null) }, t("ac.form.cancel"))),
    );
  };

  const runtimeBadge = () => {
    if (!rt) return loading ? h("span", { style: chip }, t("ac.loading")) : null;
    if (!rt.ok) return h("span", { style: { ...chip, color: "#ff8a80", borderColor: "rgba(220,60,60,0.45)" } }, "CLI ✗");
    return h("span", { style: chip }, String(rt.kind) + (rt.version ? " " + rt.version : "") + (rt.compose ? " · compose" : " · no compose"));
  };

  const counts: Record<string, number> = { containers: containers.length, images: images.length, volumes: volumes.length, networks: networks.length, ports: (ports && (ports.ports || []).length) || 0 };
  const tabDefs: Array<[string, string]> = [
    ["containers", t("ac.tab.containers")],
    ["images", t("ac.tab.images")],
    ["volumes", t("ac.tab.volumes")],
    ["networks", t("ac.tab.networks")],
    ["ports", t("ac.tab.ports")],
  ];

  const content = view && view.kind === "logs" ? logsView() : view && view.kind === "details" ? detailsView() : view && view.kind === "run" ? runView() : tab === "containers" ? containersView() : tab === "images" ? imagesView() : tab === "volumes" ? volumesView() : tab === "networks" ? networksView() : portsView();

  return h(
    "div",
    { style: overlay, onClick: () => setOpen(false) },
    h(
      "div",
      { "data-ext-float": "1", "data-ext-float-w": 860, "data-ext-float-h": 680, "data-ext-float-full": "1", style: panelStyle, onClick: (e: any) => e.stopPropagation() },
      h(
        "div",
        { style: headStyle },
        h("span", { style: { fontSize: 15 } }, "📦"),
        h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontSize: 13, fontWeight: 700 } }, t("ac.title")), h("div", { style: { fontSize: 10.5, color: "var(--text-muted, #9aa0aa)" } }, t("ac.subtitle"))),
        runtimeBadge(),
        h("button", { style: btn(), title: t("ac.btn.refresh"), onClick: () => load(true), disabled: loading }, loading ? "…" : t("ac.btn.refresh")),
        h("button", { style: { ...btn(), border: "none", background: "none", fontSize: 14 }, title: t("ac.btn.close"), onClick: () => setOpen(false) }, "✕"),
      ),
      view && view.kind === "logs" ? h("div", { style: { ...bodyStyle, display: "flex", flexDirection: "column" } }, content) : h(
        "div",
        { style: { display: "contents" } },
        h(
          "div",
          { style: tabsStyle },
          ...tabDefs.map(([id, label]) => h("button", { key: id, style: tabBtn(!view && tab === id), onClick: () => { setView(null); setTab(id); setFilter(""); } }, label + " " + String(counts[id] ?? 0))),
          h("div", { style: { flex: 1 } }),
          h("input", { style: { ...inputStyle, minWidth: 140 }, placeholder: t("ac.filter.placeholder"), value: filter, onInput: (e: any) => setFilter(e.target.value) }),
          h("button", { style: btn(live), title: t("ac.btn.live"), onClick: () => (live ? stopLive() : startLive()) }, live ? t("ac.btn.liveOn") : t("ac.btn.live")),
          h("button", { style: btn(true), title: t("ac.btn.pruneSystemTitle"), onClick: () => act("system", "prune", {}) }, pending && pending.key === "system.prune:" ? t("ac.action.reclick") : t("ac.btn.pruneSystem")),
        ),
        h(
          "div",
          { style: bodyStyle },
          error ? h("div", { style: { ...emptyStyle, color: "#ff8a80" } }, error) : null,
          liveNote ? h("div", { style: { ...emptyStyle, color: "#e8b34a" } }, liveNote) : null,
          note ? h("div", { style: { fontSize: 10.5, color: "var(--text-muted, #9aa0aa)", marginBottom: 6 } }, note) : null,
          content,
        ),
      ),
      h(
        "div",
        { style: footStyle },
        rt && rt.ok ? h("span", null, t("ac.footer.cli", { cli: String(rt.bin || rt.kind) })) : null,
        ...usageRows.map((u: any) => h("span", { key: String(u.type) }, String(u.type) + " " + String(u.totalCount) + (u.reclaimable ? " · " + t("ac.footer.reclaim", { value: String(u.reclaimable) }) : ""))),
        h("div", { style: { flex: 1 } }),
        pending ? h("span", { style: { color: "#e8b34a" } }, t("ac.msg.confirmPending", { label: String(pending.label) })) : null,
      ),
    ),
  );
}

function DialogsSlot() {
  const { h } = H;
  const isOpen = useOpen();
  return isOpen ? h(Panel, null) : null;
}

export default function register(ctx: Record<string, unknown>) {
  H = ctx;
  hostCtx = ctx as Record<string, any>;
  apiUrlFn = (ctx.apiUrl as ((p: string) => string) | undefined) || null;

  ctx.registerItems?.("toolbar", [{ id: "containers-open", render: ToolbarButton, meta: { label: t("ac.toolbar.label") } }]);
  ctx.registerItems?.("dialogs", [{ id: "containers-dialog", render: DialogsSlot }]);
  try {
    (ctx as any).registerExtService?.("aiti-containers.open", (opts?: Record<string, unknown>) => {
      pendingFocus = {
        container: opts && opts.container ? String(opts.container) : undefined,
        port: opts && opts.port !== undefined && opts.port !== null ? Number(opts.port) : undefined,
        tab: opts && typeof opts.tab === "string" ? String(opts.tab) : undefined,
      };
      setOpen(true);
    });
  } catch {
    /* old host without client services */
  }

  try {
    (ctx as any).registerExtService?.("aiti-containers.port-map", () => portMap);
  } catch {
    /* old host without client services */
  }

  ctx.registerItems?.("commands", [
    {
      id: "containers-command",
      meta: {
        label: t("ac.command.label"),
        icon: { svg: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>' },
        onClick: () => setOpen(true),
      },
    },
  ]);

  try {
    console.log("[aiti-containers] client ready (toolbar + dialogs + commands, i18n)");
  } catch {
    /* noop */
  }
}
