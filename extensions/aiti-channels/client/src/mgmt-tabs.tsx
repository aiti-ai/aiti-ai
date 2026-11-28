/**
 * aiti-channels · mgmt-tabs (v2 P1) — full-capability tabs backed by the
 * management proxy (GET/POST/PATCH/DELETE via /api/extensions/aiti-channels/
 * mgmt/<path>?instance=<id>):
 *   - TabCron      /cron list + pause/resume/exec/delete/interval + create
 *   - TabProviders global providers CRUD + per-project provider activate/remove
 *   - TabSkills    /skills + /skills/presets (installed matrix + preset catalog)
 *   - TabSystem    global settings (GET/PATCH /settings) + bridge adapters
 *
 * API shapes mirror cc-connect's own web client (web/src/api/*.ts). All tabs
 * degrade to a "instance not running" hint when the proxy reports 0/502.
 */
import { useState, useEffect, useCallback } from "react";
import { apiUrl, t } from "./host-shim";
import { btnStyle, cardStyle, inp, sectionTitle, chip } from "./channels-app";

const API = (p: string) => apiUrl(p);

/** One mgmt-proxy call; returns {ok, status, data} with the {data} unwrap. */
async function mgmt(instance: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const r = await fetch(API(`/api/extensions/aiti-channels/mgmt/${path}?instance=${encodeURIComponent(instance)}`), {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await r.text();
  let raw: any = text;
  try { raw = JSON.parse(text); } catch { /* TOML/raw text */ }
  const data = raw && typeof raw === "object" && "data" in raw && !("projects" in raw || "jobs" in raw || "adapters" in raw) ? raw.data : raw;
  return { ok: r.status >= 200 && r.status < 300, status: r.status, data, error: r.status === 0 || r.status >= 500 ? (raw && (raw.error || raw.message)) || `HTTP ${r.status}` : undefined };
}

function useMgmtTab(instance: string, loader: (instance: string) => Promise<void>, deps: unknown[] = []) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { await loader(instance); } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, ...deps]);
  useEffect(() => { void load(); }, [load]);
  return { loading, err, setErr, msg, setMsg, reload: load };
}

const hintBox = { fontSize: 11, color: "#6b7280", lineHeight: 1.6 } as Record<string, string>;
const noteStyle = (ok: boolean) => ({ fontSize: 12, color: ok ? "#16a34a" : "#ea580c", padding: "0 2px" });

// ================= TabCron =================
type CronJob = {
  id: string; project: string; cron_expr: string; prompt: string; exec: string;
  description: string; enabled: boolean; silent: boolean; session_mode: string;
  last_run: string; last_error: string;
};
let cronCache: CronJob[] | null = null;

export function TabCron({ instance }: { instance: string }) {
  const [jobs, setJobs] = useState<CronJob[]>(() => cronCache || []);
  const [form, setForm] = useState<{ project: string; cron_expr: string; prompt: string }>({ project: "", cron_expr: "", prompt: "" });
  const [openNew, setOpenNew] = useState(false);
  const tab = useMgmtTab(instance, async (inst) => {
    const r = await mgmt(inst, "GET", "cron");
    cronCache = r.ok && Array.isArray(r.data?.jobs) ? r.data.jobs : [];
    setJobs(cronCache);
    if (!r.ok) throw new Error(r.error || `HTTP ${r.status}`);
  });
  const act = async (path: string, method = "POST", label?: string, body?: unknown) => {
    const r = await mgmt(instance, method, path, body);
    tab.setMsg(r.ok ? (label || "OK") : null);
    if (!r.ok) tab.setErr(r.error || `${path}: HTTP ${r.status}`);
    void tab.reload();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t("Cron jobs")}</span>
        <span style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{String(jobs.length)}</span>
        <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => setOpenNew(!openNew)}>{openNew ? t("Collapse") : "+ " + t("New")}</button>
        <button style={btnStyle} onClick={() => void tab.reload()}>{t("Refresh")}</button>
      </div>
      {openNew && (
        <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder={t("Project name")} value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} style={inp} />
            <input placeholder='cron expression (e.g. "30 6,18 * * *")' value={form.cron_expr} onChange={(e) => setForm({ ...form, cron_expr: e.target.value })} style={inp} />
          </div>
          <textarea placeholder={t("prompt (sent to the agent on schedule)")} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} style={{ ...inp, minHeight: 60 }} />
          <button style={{ ...btnStyle, alignSelf: "flex-start", background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }}
            onClick={async () => {
              if (!form.project || !form.cron_expr || !form.prompt) { tab.setErr(t("project + cron + prompt required")); return; }
              const r = await mgmt(instance, "POST", "cron", { project: form.project, cron_expr: form.cron_expr, prompt: form.prompt });
              if (r.ok) { setOpenNew(false); setForm({ project: "", cron_expr: "", prompt: "" }); tab.setMsg(t("Created")); void tab.reload(); }
              else tab.setErr(r.error || `HTTP ${r.status}`);
            }}>{t("Create")}</button>
        </div>
      )}
      {jobs.length === 0 && !tab.loading && <div style={{ ...cardStyle, ...hintBox }}>{t("No cron jobs (cc-connect /cron)")}</div>}
      {jobs.map((j) => (
        <div key={j.id} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{j.project}</span>
            <span style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{j.cron_expr}</span>
            <span style={chip(j.enabled ? "rgba(34,197,94,0.15)" : "rgba(127,127,127,0.14)", j.enabled ? "#16a34a" : "#6b7280")}>{j.enabled ? t("active") : t("paused")}</span>
            {j.last_error && <span style={{ fontSize: 11, color: "#ea580c", flex: 1, minWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.last_error}</span>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button style={btnStyle} onClick={() => {
                const v = window.prompt(`${t("cron expression (current ")} ${j.cron_expr})`, j.cron_expr);
                if (v && v.trim()) void act(`cron/${encodeURIComponent(j.id)}`, "PATCH", t("Expression updated"), undefined, { cron_expr: v.trim() });
              }}>{t("Expr")}</button>
              <button style={btnStyle} onClick={() => void act(`cron/${encodeURIComponent(j.id)}/exec`, "POST", t("Triggered"))}>{t("run")}</button>
              <button style={btnStyle} onClick={() => void act(`cron/${encodeURIComponent(j.id)}`, "PATCH", j.enabled ? t("Paused") : t("Resumed"))}>{j.enabled ? t("pause") : t("resume")}</button>
              <button style={{ ...btnStyle, color: "#dc2626" }} onClick={() => { if (window.confirm(t("Delete this cron job?"))) void act(`cron/${encodeURIComponent(j.id)}`, "DELETE", t("Deleted")); }}>{t("Del")}</button>
            </span>
          </div>
          <div style={{ ...hintBox, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{(j.prompt || j.exec || "").slice(0, 200)}</div>
        </div>
      ))}
      {tab.err && <div style={noteStyle(false)}>{t("Failed: ") + tab.err}</div>}
      {tab.msg && <div style={noteStyle(true)}>{tab.msg}</div>}
    </div>
  );
}

// ================= TabProviders =================
type GlobalProvider = { name: string; base_url?: string; model?: string; api_key?: string };
type ProjProvider = { name: string; active: boolean; model: string; base_url: string };
let provCache: { global: GlobalProvider[]; byProject: Record<string, { providers: ProjProvider[]; active: string }> } | null = null;

export function TabProviders({ instance, projects }: { instance: string; projects: string[] }) {
  const [store, setStore] = useState(() => provCache || { global: [] as GlobalProvider[], byProject: {} as Record<string, { providers: ProjProvider[]; active: string }> });
  const [addForm, setAddForm] = useState<{ name: string; base_url: string; model: string; api_key: string }>({ name: "", base_url: "", model: "", api_key: "" });
  const [openAdd, setOpenAdd] = useState(false);
  // preset catalog (GET /providers/presets) → one-click form prefill
  const [presets, setPresets] = useState<Array<{ name: string; display_name?: string; agents?: Record<string, { base_url?: string; model?: string }> }>>([]);
  const tab = useMgmtTab(instance, async (inst) => {
    const g = await mgmt(inst, "GET", "providers");
    const byProject: Record<string, { providers: ProjProvider[]; active: string }> = {};
    for (const p of projects) {
      const r = await mgmt(inst, "GET", `projects/${encodeURIComponent(p)}/providers`);
      if (r.ok && r.data) byProject[p] = { providers: r.data.providers || [], active: r.data.active_provider || "" };
    }
    provCache = { global: g.ok && Array.isArray(g.data) ? g.data : (g.data?.providers || []), byProject };
    setStore(provCache);
    const pr = await mgmt(inst, "GET", "providers/presets");
    const prData = pr.data?.data || pr.data;
    setPresets(Array.isArray(prData?.providers) ? prData.providers : []);
  }, [projects.join(",")]);
  const prefill = (presetName: string) => {
    const p = presets.find((x) => x.name === presetName);
    if (!p) return;
    const agent = p.agents && (p.agents["claudecode"] || p.agents["codex"] || Object.values(p.agents)[0]);
    setAddForm({ name: p.name, base_url: agent?.base_url || "", model: agent?.model || "", api_key: addForm.api_key });
    tab.setMsg(`${t("Prefilled from preset")} ${p.display_name || p.name} (${t("api_key must be filled in")})`);
  };
  const call = async (fn: () => Promise<{ ok: boolean; error?: string; status: number }>, okMsg: string) => {
    const r = await fn();
    if (r.ok) { tab.setMsg(okMsg); void tab.reload(); } else tab.setErr(r.error || `HTTP ${r.status}`);
  };
  const projEntries = Object.entries(store.byProject);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t("Model providers")}</span>
        <span style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{`${t("Global")} ${store.global.length}`}</span>
        <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => setOpenAdd(!openAdd)}>{openAdd ? t("Collapse") : "+ " + t("New global")}</button>
        <button style={btnStyle} onClick={() => void tab.reload()}>{t("Refresh")}</button>
      </div>
      {openAdd && (
        <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
          {presets.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#6b7280" }}>{t("Prefill from preset:")}</span>
              <select style={{ ...inp, flex: "0 0 220px", cursor: "pointer" }} value="" onChange={(e) => e.target.value && prefill(e.target.value)}>
                <option value="">{`${t("preset catalog")} (${presets.length})`}</option>
                {presets.map((p) => <option key={p.name} value={p.name}>{p.display_name || p.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder={t("Name (e.g. deepseek)")} value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} style={inp} />
            <input placeholder="base_url" value={addForm.base_url} onChange={(e) => setAddForm({ ...addForm, base_url: e.target.value })} style={inp} />
            <input placeholder={t("Default model")} value={addForm.model} onChange={(e) => setAddForm({ ...addForm, model: e.target.value })} style={inp} />
            <input placeholder="api_key" type="password" value={addForm.api_key} onChange={(e) => setAddForm({ ...addForm, api_key: e.target.value })} style={inp} />
          </div>
          <button style={{ ...btnStyle, alignSelf: "flex-start", background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }}
            onClick={() => void call(async () => {
              if (!addForm.name) return { ok: false, error: t("name required"), status: 400 };
              const body: any = { name: addForm.name };
              if (addForm.base_url) body.base_url = addForm.base_url;
              if (addForm.model) body.model = addForm.model;
              if (addForm.api_key) body.api_key = addForm.api_key;
              return mgmt(instance, "POST", "providers", body);
            }, t("Created"))}>{t("Create global provider")}</button>
        </div>
      )}
      {/* global list */}
      {store.global.map((p) => (
        <div key={p.name} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</span>
          {p.model && <span style={chip("rgba(127,127,127,0.12)", "#6b7280")}>{p.model}</span>}
          {p.base_url && <span style={{ ...hintBox, fontFamily: "monospace" }}>{p.base_url}</span>}
          <button style={{ ...btnStyle, marginLeft: "auto", color: "#dc2626" }}
            onClick={() => { if (window.confirm(`${t("Delete global provider")} ${p.name}?`)) void call(() => mgmt(instance, "DELETE", `providers/${encodeURIComponent(p.name)}`), t("Deleted")); }}>{"🗑"}</button>
        </div>
      ))}
      {/* per-project */}
      {projEntries.length > 0 && <div style={sectionTitle}>{t("Per-project")}</div>}
      {projEntries.map(([pj, info]) => (
        <div key={pj} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{pj}</div>
          {info.providers.map((p) => (
            <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5 }}>{p.name}</span>
              {p.model && <span style={chip("rgba(127,127,127,0.12)", "#6b7280")}>{p.model}</span>}
              {info.active === p.name && <span style={chip("rgba(34,197,94,0.15)", "#16a34a")}>{t("active")}</span>}
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                {info.active !== p.name && <button style={btnStyle} onClick={() => void call(() => mgmt(instance, "POST", `projects/${encodeURIComponent(pj)}/providers/${encodeURIComponent(p.name)}/activate`), t("Activated"))}>{t("Activate")}</button>}
                <button style={{ ...btnStyle, color: "#dc2626" }} onClick={() => { if (window.confirm(`${t("Remove project provider")} ${p.name}?`)) void call(() => mgmt(instance, "DELETE", `projects/${encodeURIComponent(pj)}/providers/${encodeURIComponent(p.name)}`), t("Removed")); }}>{"🗑"}</button>
              </span>
            </div>
          ))}
          {info.providers.length === 0 && <div style={hintBox}>{t("(no project providers)")}</div>}
        </div>
      ))}
      {tab.err && <div style={noteStyle(false)}>{t("Failed: ") + tab.err}</div>}
      {tab.msg && <div style={noteStyle(true)}>{tab.msg}</div>}
    </div>
  );
}

// ================= TabSkills =================
type SkillInfo = { name: string; display_name?: string; description?: string; source: string };
type ProjectSkills = { project: string; agent_type: string; dirs: string[]; skills: SkillInfo[] };
type SkillPreset = { name: string; display_name: string; description?: string; description_zh?: string; agent_types?: string[]; tags?: string[]; featured?: boolean };
let skillsCache: { installed: ProjectSkills[]; presets: SkillPreset[] } | null = null;

export function TabSkills({ instance }: { instance: string }) {
  const [store, setStore] = useState(() => skillsCache || { installed: [], presets: [] });
  const [q, setQ] = useState("");
  const tab = useMgmtTab(instance, async (inst) => {
    const a = await mgmt(inst, "GET", "skills");
    const b = await mgmt(inst, "GET", "skills/presets");
    skillsCache = {
      installed: a.ok && Array.isArray(a.data?.projects) ? a.data.projects : [],
      presets: b.ok && Array.isArray(b.data?.skills) ? b.data.skills : [],
    };
    setStore(skillsCache);
  });
  const ql = q.trim().toLowerCase();
  const installedCount = store.installed.reduce((n, p) => n + (p.skills?.length || 0), 0);
  const presets = store.presets.filter((p) => !ql || p.name.toLowerCase().includes(ql) || (p.display_name || "").toLowerCase().includes(ql) || (p.tags || []).some((x) => x.toLowerCase().includes(ql)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t("Skills")}</span>
        <span style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{`${t("installed")} ${installedCount}`}</span>
        <span style={chip("rgba(127,127,127,0.12)", "#6b7280")}>{`${t("presets")} ${store.presets.length}`}</span>
        <input placeholder={t("Search presets…")} value={q} onChange={(e) => setQ(e.target.value)} style={{ ...inp, flex: "0 0 200px", marginLeft: "auto" }} />
        <button style={btnStyle} onClick={() => void tab.reload()}>{t("Refresh")}</button>
      </div>
      {/* installed matrix */}
      {store.installed.map((p) => (
        <div key={p.project} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{`${p.project} · ${p.agent_type}`}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(p.skills || []).map((s) => (
              <span key={s.name} title={s.description || s.display_name || s.name} style={chip("rgba(34,197,94,0.12)", "#16a34a")}>{s.display_name || s.name}</span>
            ))}
            {(p.skills || []).length === 0 && <span style={hintBox}>{t("(no installed skills)")}</span>}
          </div>
        </div>
      ))}
      {/* presets catalog */}
      <div style={sectionTitle}>{t("Skill catalog presets (/skills/presets)")}</div>
      {presets.slice(0, 40).map((p) => (
        <div key={p.name} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>{p.display_name || p.name}</span>
          {(p.tags || []).slice(0, 4).map((tg) => <span key={tg} style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{tg}</span>)}
          <span style={{ ...hintBox, flex: 1, minWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description_zh || p.description || ""}</span>
          {p.featured && <span style={chip("rgba(245,158,11,0.16)", "#d97706")}>{t("Featured")}</span>}
        </div>
      ))}
      {tab.err && <div style={noteStyle(false)}>{t("Failed: ") + tab.err}</div>}
    </div>
  );
}

// ================= TabSystem =================
type GlobalSettings = Record<string, string | number | boolean>;
const SETTING_LABELS: Array<[string, string]> = [
  ["language", "Language (en/zh/zh-TW/ja/es/ko/ru)"],
  ["log_level", "Log level"],
  ["idle_timeout_mins", "Idle timeout (min)"],
  ["thinking_messages", "Show thinking messages"],
  ["thinking_max_len", "Thinking max length"],
  ["tool_messages", "Show tool messages"],
  ["tool_max_len", "Tool messages max length"],
  ["stream_preview_enabled", "Stream preview"],
  ["stream_preview_interval_ms", "Stream preview interval (ms)"],
  ["rate_limit_max_messages", "Rate limit: max messages"],
  ["rate_limit_window_secs", "Rate limit: window (s)"],
  ["attachment_send", "Attachment sending"],
];
let sysCache: { settings: GlobalSettings; adapters: Array<{ platform: string; project: string; capabilities: string[]; connected_at: string }> } | null = null;

export function TabSystem({ instance }: { instance: string }) {
  const [store, setStore] = useState(() => sysCache || { settings: {}, adapters: [] });
  const [draft, setDraft] = useState<GlobalSettings>({});
  const tab = useMgmtTab(instance, async (inst) => {
    const a = await mgmt(inst, "GET", "settings");
    const b = await mgmt(inst, "GET", "bridge/adapters");
    sysCache = {
      settings: a.ok && a.data && typeof a.data === "object" ? a.data : {},
      adapters: b.ok && Array.isArray(b.data?.adapters) ? b.data.adapters : [],
    };
    setStore(sysCache);
    setDraft({});
  });
  const dirty = Object.keys(draft).length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t("Global settings (/settings)")}</span>
        <button style={{ ...btnStyle, marginLeft: "auto", ...(dirty ? { background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" } : {}) }}
          disabled={!dirty || tab.loading}
          onClick={async () => {
            const r = await mgmt(instance, "PATCH", "settings", draft);
            if (r.ok) { tab.setMsg(t("Settings saved")); setDraft({}); void tab.reload(); } else tab.setErr(r.error || `HTTP ${r.status}`);
          }}>{t("Save changes") + (dirty ? ` (${Object.keys(draft).length})` : "")}</button>
        <button style={btnStyle} onClick={() => void tab.reload()}>{t("Refresh")}</button>
      </div>
      <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 6 }}>
        {SETTING_LABELS.map(([key, label]) => {
          const cur = draft[key] !== undefined ? draft[key] : store.settings[key];
          return (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, color: "#6b7280", flex: "0 0 240px" }}>{t(label)}</span>
              {typeof cur === "boolean" || store.settings[key] === undefined || typeof store.settings[key] === "boolean" ? (
                <select
                  value={String(cur === true || cur === "true")}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value === "true" })}
                  style={{ ...inp, flex: "0 0 160px", cursor: "pointer" }}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  value={String(cur ?? "")}
                  onChange={(e) => {
                    const v = e.target.value;
                    const num = Number(v);
                    setDraft({ ...draft, [key]: v !== "" && Number.isFinite(num) && typeof store.settings[key] === "number" ? num : v });
                  }}
                  style={{ ...inp, flex: "0 0 220px" }} />
              )}
            </div>
          );
        })}
      </div>
      <div style={sectionTitle}>{t("Bridge adapters (/bridge/adapters)")}</div>
      {store.adapters.map((a, i) => (
        <div key={i} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>{a.platform}</span>
          <span style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{a.project}</span>
          {(a.capabilities || []).map((c) => <span key={c} style={chip("rgba(34,197,94,0.12)", "#16a34a")}>{c}</span>)}
          <span style={{ ...hintBox, marginLeft: "auto" }}>{a.connected_at || ""}</span>
        </div>
      ))}
      {store.adapters.length === 0 && <div style={{ ...cardStyle, ...hintBox }}>{t("(no bridge adapters connected)")}</div>}
      {tab.err && <div style={noteStyle(false)}>{t("Failed: ") + tab.err}</div>}
      {tab.msg && <div style={noteStyle(true)}>{tab.msg}</div>}
    </div>
  );
}

// ================= ProjectDetailPanel (P2: project detail editor — PATCH settings / heartbeat / workspaces / models) =================
type ProjDetail = Record<string, any>;
type HeartbeatStatus = { enabled: boolean; paused: boolean; interval_mins: number; last_run?: string; last_error?: string };
type WorkspaceBinding = { channel_key: string; channel_name?: string; workspace: string };

export function ProjectDetailPanel({ instance, project, onClose }: { instance: string; project: string; onClose?: () => void }) {
  const [detail, setDetail] = useState<ProjDetail | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [hb, setHb] = useState<HeartbeatStatus | null>(null);
  const [wsBindings, setWsBindings] = useState<WorkspaceBinding[]>([]);
  const [wsBase, setWsBase] = useState<{ base_dir?: string } | null>(null);
  const [models, setModels] = useState<{ models: string[]; current: string } | null>(null);
  const [newBind, setNewBind] = useState<{ channel_key: string; workspace: string }>({ channel_key: "", workspace: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    const g = (path: string) => mgmt(instance, "GET", path).then((r) => (r.ok ? (r.data && r.data.data ? r.data.data : r.data) : null)).catch(() => null);
    const [d, h, w, m] = await Promise.all([
      g(`projects/${encodeURIComponent(project)}`),
      g(`projects/${encodeURIComponent(project)}/heartbeat`),
      g(`projects/${encodeURIComponent(project)}/workspaces`),
      g(`projects/${encodeURIComponent(project)}/models`),
    ]);
    setDetail(d || {});
    setDraft({});
    setHb(h);
    setWsBindings(Array.isArray(w?.bindings) ? w.bindings : []);
    setWsBase(w || null);
    setModels(m && (m.models || m.current !== undefined) ? { models: m.models || [], current: m.current || "" } : null);
  }, [instance, project]);
  useEffect(() => { void reload(); }, [reload]);

  const call = async (path: string, method: string, body?: unknown, okMsg?: string) => {
    setBusy(true); setErr(null); setMsg(null);
    const r = await mgmt(instance, method, path, body);
    setBusy(false);
    if (r.ok) { setMsg(okMsg || "OK"); void reload(); } else setErr(r.error || `${path}: HTTP ${r.status}`);
    return r.ok;
  };
  const dirty = Object.keys(draft).length > 0;
  const F = (key: string, label: string, ph?: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 12, color: "#6b7280", flex: "0 0 200px" }}>{label}</span>
      <input value={String(draft[key] !== undefined ? draft[key] : (detail?.[key] ?? ""))} placeholder={ph || ""}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} style={{ ...inp, flex: "0 0 260px" }} />
    </div>
  );
  const FB = (key: string, label: string) => {
    const cur = draft[key] !== undefined ? draft[key] : detail?.[key];
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 12, color: "#6b7280", flex: "0 0 200px" }}>{label}</span>
        <select value={String(cur === true || cur === "true")} onChange={(e) => setDraft({ ...draft, [key]: e.target.value === "true" })}
          style={{ ...inp, flex: "0 0 120px", cursor: "pointer" }}>
          <option value="true">true</option><option value="false">false</option>
        </select>
      </div>
    );
  };

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10, borderColor: "rgba(99,102,241,0.35)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{`${t("Project detail")} · ${project}`}</span>
        <button style={{ ...btnStyle, marginLeft: "auto", ...(dirty ? { background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" } : {}) }}
          disabled={!dirty || busy}
          onClick={async () => { if (await call(`projects/${encodeURIComponent(project)}`, "PATCH", draft, t("Settings saved"))) setDraft({}); }}>
          {t("Save changes") + (dirty ? ` (${Object.keys(draft).length})` : "")}
        </button>
        <button style={btnStyle} onClick={() => void reload()}>{t("Refresh")}</button>
        {onClose && <button style={btnStyle} onClick={onClose}>{t("Collapse")}</button>}
      </div>

      {/* General settings */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>{t("General settings (PATCH /projects/{name})")}</div>
        {F("work_dir", "work_dir (working directory)")}
        {F("language", "language (reply language)")}
        {F("admin_from", "admin_from (admin identity)")}
        {F("disabled_commands", "disabled_commands (comma separated)")}
        {F("agent_type", "agent_type")}
        {F("mode", "mode")}
        {FB("reply_footer", "reply_footer (reply footer)")}
        {FB("inject_sender", "inject_sender (inject sender)")}
        {FB("show_context_indicator", "show_context_indicator")}
        {FB("show_workdir_indicator", "show_workdir_indicator")}
        {detail?.workspace_mode !== undefined && F("workspace_mode", "workspace_mode")}
        {detail?.workspace_base_dir !== undefined && F("workspace_base_dir", "workspace_base_dir")}
      </div>

      {/* models */}
      {models && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{t("Models (/projects/{name}/models)")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <select style={{ ...inp, flex: "0 0 260px", cursor: "pointer" }} value={models.current}
              onChange={(e) => void call(`projects/${encodeURIComponent(project)}/model`, "POST", { model: e.target.value }, t("Model switched"))}>
              {models.models.map((m) => <option key={m} value={m}>{m}{m === models.current ? " ●" : ""}</option>)}
            </select>
            {models.models.length === 0 && <span style={hintBox}>{t("(no models — configure Providers first)")}</span>}
          </div>
        </div>
      )}

      {/* heartbeat */}
      {hb && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{t("Heartbeat")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={chip(hb.enabled ? "rgba(34,197,94,0.15)" : "rgba(127,127,127,0.14)", hb.enabled ? "#16a34a" : "#6b7280")}>{hb.enabled ? t("Enabled") : t("Not configured")}</span>
            {hb.enabled && <span style={chip(hb.paused ? "rgba(245,158,11,0.16)" : "rgba(34,197,94,0.12)", hb.paused ? "#d97706" : "#16a34a")}>{hb.paused ? t("Paused") : t("running")}</span>}
            <span style={hintBox}>{`interval ${hb.interval_mins ?? "-"} min · last ${hb.last_run || "-"}`}</span>
            {hb.enabled && <>
              {!hb.paused
                ? <button style={btnStyle} onClick={() => void call(`projects/${encodeURIComponent(project)}/heartbeat/pause`, "POST", undefined, t("Paused"))}>{t("pause")}</button>
                : <button style={btnStyle} onClick={() => void call(`projects/${encodeURIComponent(project)}/heartbeat/resume`, "POST", undefined, t("Resumed"))}>{t("resume")}</button>}
              <button style={btnStyle} onClick={() => void call(`projects/${encodeURIComponent(project)}/heartbeat/run`, "POST", undefined, t("Triggered"))}>{t("run")}</button>
              <button style={btnStyle} onClick={() => {
                const v = window.prompt(t("Heartbeat interval (min)"), String(hb.interval_mins || ""));
                if (v && Number(v) > 0) void call(`projects/${encodeURIComponent(project)}/heartbeat/interval`, "POST", { minutes: Number(v) }, t("Interval updated"));
              }}>{t("Interval")}</button>
            </>}
            {hb.last_error && <span style={{ fontSize: 11, color: "#ea580c" }}>{hb.last_error}</span>}
          </div>
        </div>
      )}

      {/* workspaces */}
      {detail?.workspace_mode !== undefined && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{t("Workspace bindings (/workspaces)")}</div>
          {wsBase?.base_dir && <div style={hintBox}>{`base_dir: ${wsBase.base_dir}`}</div>}
          {wsBindings.map((b) => (
            <div key={b.channel_key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12 }}>{b.channel_name || b.channel_key}</span>
              <span style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{b.workspace}</span>
              <button style={{ ...btnStyle, marginLeft: "auto", color: "#dc2626" }}
                onClick={() => { if (window.confirm(`${t("Unbind")} ${b.channel_key}?`)) void call(`projects/${encodeURIComponent(project)}/workspaces/${encodeURIComponent(b.channel_key)}`, "DELETE", undefined, t("Unbound")); }}>{t("Unbind")}</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder="channel_key" value={newBind.channel_key} onChange={(e) => setNewBind({ ...newBind, channel_key: e.target.value })} style={{ ...inp, flex: "0 0 200px" }} />
            <input placeholder="workspace (directory path)" value={newBind.workspace} onChange={(e) => setNewBind({ ...newBind, workspace: e.target.value })} style={{ ...inp, flex: "0 0 260px" }} />
            <button style={btnStyle} disabled={!newBind.channel_key || !newBind.workspace}
              onClick={async () => { if (await call(`projects/${encodeURIComponent(project)}/workspaces`, "POST", newBind, t("Bound"))) setNewBind({ channel_key: "", workspace: "" }); }}>{t("Bind")}</button>
          </div>
        </div>
      )}

      {/* danger */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid rgba(239,68,68,0.3)", paddingTop: 8 }}>
        <span style={{ fontSize: 12, color: "#dc2626", fontWeight: 700 }}>{t("Danger zone")}</span>
        <span style={hintBox}>{t("Delete the project (all platforms and session mappings)")}</span>
        <button style={{ ...btnStyle, marginLeft: "auto", color: "#dc2626", borderColor: "rgba(239,68,68,0.4)" }}
          onClick={() => { if (window.confirm(`${t("Confirm project deletion")} ${project}?`)) void call(`projects/${encodeURIComponent(project)}`, "DELETE", undefined, t("Deleted (applies after instance restart)")); }}>🗑 {t("Delete project")}</button>
      </div>

      {err && <div style={noteStyle(false)}>{t("Failed: ") + err}</div>}
      {msg && <div style={noteStyle(true)}>{msg}</div>}
    </div>
  );
}
