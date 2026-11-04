/**
 * aiti-configs · 安全盾 UI（🛡）—— JSX 版（自手写 h() 版迁移，功能一比一）。
 *
 * 设计：docs/aiti-configs-extension-plan.md §4.2
 * 功能：状态（变更清单 + 提交）/ 历史（版本列表 + diff 预览 + 恢复）/ 自检报告 / 配置查看编辑
 * 架构：toolbar 🛡 按钮 → 独立置顶 dialog（pages slot，不随 session 切换关闭）
 */
import { useState, useEffect, useCallback } from "react";
import { apiUrl } from "./host-shim";
import { uiConfirm, uiPrompt } from "../../../_shared/ui-dialogs";

declare global {
  interface Window { __aitiConfigsOpen?: () => void }
}

const api = (p: string, init?: RequestInit) =>
  fetch(apiUrl("/api/extensions/aiti-configs" + p), { cache: "no-store", ...init });
const jsonBody = (o: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

// lucide 图标（与系统内建线条图标同风格）
const Ic = ({ size, paths }: { size: number; paths: string[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const ICONS = {
  shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z", "m9 12 2 2 4-4"],
  package: ["m7.5 4.27 9 5.15", "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z", "M3.3 7 12 12l8.7-5", "M12 22V12"],
  tag: ["M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z", "M7.5 7.5h.01"],
  camera: ["M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
};

const C: Record<string, any> = {
  root: { position: "fixed", right: 18, bottom: 70, width: 560, maxWidth: "92vw", maxHeight: "76vh",
    display: "flex", flexDirection: "column", zIndex: 2147483101, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
    border: "1px solid var(--border,#e0e0e0)", borderRadius: 16, boxShadow: "0 16px 64px rgba(0,0,0,.25)",
    font: "13px/1.5 system-ui, -apple-system, sans-serif", overflow: "hidden" },
  head: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)" },
  tabs: { display: "flex", gap: 4, flex: 1, overflowX: "auto" },
  tab: { padding: "5px 12px", border: "none", borderRadius: 8, cursor: "pointer", background: "transparent", color: "var(--text,#1a1a1a)", fontWeight: 500 },
  tabOn: { background: "var(--accent,#2563eb)", color: "#fff" },
  body: { padding: 12, overflow: "auto", flex: 1 },
  btn: { padding: "5px 12px", border: "1px solid var(--border,#e0e0e0)", borderRadius: 8, cursor: "pointer", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontWeight: 500 },
  btnPrimary: { background: "var(--accent,#2563eb)", borderColor: "var(--accent,#2563eb)", color: "#fff" },
  row: { padding: "6px 8px", borderBottom: "1px solid var(--border,#e0e0e0)", cursor: "pointer" },
  mono: { font: "11.5px/1.5 ui-monospace, monospace", wordBreak: "break-all" },
  pre: { background: "var(--bg-subtle,#f5f5f5)", border: "1px solid var(--border,#e0e0e0)", borderRadius: 8, padding: 10, overflow: "auto", maxHeight: 260, whiteSpace: "pre-wrap", wordBreak: "break-all", font: "11.5px/1.5 ui-monospace, monospace" },
  // 黄色错误提示样式：当有错误时显示黄色警告框
  errorMsg: { padding: "6px 10px", borderRadius: 8, background: "#fef3c7", color: "#92400e", marginBottom: 8, fontSize: 12, border: "1px solid #fcd34d" },
  msg: { padding: "6px 10px", borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)", marginBottom: 8, fontSize: 12 },
};

function App({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState("status");
  // 小屏（窄窗口）→ 全屏弹层：标题、tab 切换、关闭按钮常驻可见（同 aiti-model-wizard）
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const upd = () => setSmall(mq.matches);
    upd();
    if (mq.addEventListener) mq.addEventListener("change", upd); else (mq as any).addListener(upd);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", upd); else (mq as any).removeListener(upd); };
  }, []);
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [diff, setDiff] = useState<any>(null);
  const [fileDiff, setFileDiff] = useState<any>(null);
  const [tagList, setTagList] = useState<any>(null);
  const [encStatus, setEncStatus] = useState<any>(null);

  const load = useCallback(async (t: string) => {
    if (!open) return;
    setBusy(true); setMsg("");
    try {
      const ep = t === "status" ? "/status" : t === "log" ? "/log?n=15" : t === "selfcheck" ? "/selfcheck" : "/config";
      const r = await api(ep);
      setData(await r.json());
      if (t === "config") { try { setEncStatus(await (await api("/key")).json()); } catch {} }
    } catch (e: any) { setMsg("加载失败：" + (e.message || e)); }
    setBusy(false);
  }, [open]);

  useEffect(() => { if (open) load(tab); }, [open, tab, load]);

  // 状态 tab：点击变更文件行 → 展示该文件的未提交 diff（再点收起）
  const showFileDiff = async (path: string) => {
    if (fileDiff?.path === path) { setFileDiff(null); return; }
    setBusy(true);
    try {
      const r = await api("/diff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "HEAD", path }) });
      const d = await r.json();
      setFileDiff({ path, diff: d.diff || d.error || "（无差异）" });
    } catch (e: any) { setFileDiff({ path, diff: "加载失败：" + (e.message || e) }); }
    setBusy(false);
  };

  const doCommit = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api("/commit", { method: "POST", ...jsonBody({}) });
      const d = await r.json();
      setMsg(d.noop ? "无可提交变更" : "✅ 已提交 " + d.hash + " · " + String(d.message || "").split("\n")[0]);
      load("status");
    } catch (e: any) { setMsg("提交失败：" + (e.message || e)); }
    setBusy(false);
  };
  const doRestore = async (version: string) => {
    if (!(await uiConfirm({ message: "恢复至 " + version + "？恢复协议五步走：先固化现场+打 tag，可回退，不丢数据。", danger: true }))) return;
    setBusy(true); setMsg("");
    try {
      const r = await api("/restore", { method: "POST", ...jsonBody({ version, confirm: "确认恢复" }) });
      const d = await r.json();
      setMsg(d.ok ? "✅ 恢复完成（tag=" + d.tag + "）" : "❌ " + (d.error || d.hint || JSON.stringify(d.steps || "")));
      if (d.ok) { load("log"); setDiff(null); }
    } catch (e: any) { setMsg("恢复失败：" + (e.message || e)); }
    setBusy(false);
  };
  const showDiff = async (version: string) => {
    setBusy(true);
    try { const r = await api("/diff?version=" + encodeURIComponent(version)); setDiff(await r.json()); } catch (e: any) { setDiff({ error: e.message }); }
    setBusy(false);
  };
  const doSaveConfig = async (setObj: Record<string, unknown>) => {
    setBusy(true); setMsg("");
    try {
      const r = await api("/config", { method: "POST", ...jsonBody({ set: setObj }) });
      const d = await r.json();
      setMsg(d.ok ? "已更新配置" : "失败：" + d.error);
      if (d.ok) load("config");
    } catch (e: any) { setMsg("保存失败：" + (e.message || e)); }
    setBusy(false);
  };
  const loadTags = async () => {
    try { const r = await api("/tag"); setTagList(await r.json()); } catch {}
  };
  const doTag = async (hash: string) => {
    const name = await uiPrompt({ message: "给此版本打 tag（标记'好用版本'，如 good-v1）：", value: "good-v" + hash.slice(0, 4) });
    if (!name) return;
    setBusy(true); setMsg("");
    try {
      const r = await api("/tag", { method: "POST", ...jsonBody({ name: name.trim() }) });
      const d = await r.json();
      setMsg(d.ok ? "✅ 已打 tag: " + d.name : "失败：" + (d.error || ""));
      load("log"); loadTags();
    } catch (e: any) { setMsg("打 tag 失败：" + (e.message || e)); }
    setBusy(false);
  };
  const doDelTag = async (name: string) => {
    if (!(await uiConfirm({ message: "删除 tag: " + name + "？", danger: true }))) return;
    setBusy(true); setMsg("");
    try {
      const r = await api("/tag?name=" + encodeURIComponent(name), { method: "DELETE" });
      const d = await r.json();
      setMsg(d.ok ? "已删 tag: " + name : "失败：" + (d.error || ""));
      loadTags();
    } catch (e: any) { setMsg("删 tag 失败：" + (e.message || e)); }
    setBusy(false);
  };
  const doSnapshot = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api("/snapshot", { method: "POST", ...jsonBody({}) });
      const d = await r.json();
      setMsg(d.noop ? "已是最新（无变更可固化）" : "✅ 已固化现场：" + d.hash);
      load("status"); load("log");
    } catch (e: any) { setMsg("快照失败：" + (e.message || e)); }
    setBusy(false);
  };

  const renderStatus = () => {
    const d = data || {};
    const rs = d.remote || {};
    return (
      <div>
        {rs && rs.url ? (
          <div style={{ fontSize: 12, marginBottom: 8, padding: "6px 8px", borderRadius: 8, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1d4ed8" }}>
            {"远端同步：" + (rs.push ? "启用" : "停用") + " · " + rs.url + (rs.autoPull ? " · pull --rebase" : "") + " · branch=" + (rs.branch || "main")}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button style={{ ...C.btn, ...C.btnPrimary, display: "inline-flex", alignItems: "center", gap: 5 }} onClick={doCommit}>
            <Ic size={13} paths={ICONS.package} />提交变更
          </button>
          <button style={C.btn} onClick={() => load("status")}>↻ 刷新</button>
        </div>
        {d.clean === true ? (
          <div style={{ color: "#16a34a", fontWeight: 600 }}>✅ 工作区干净（无可提交变更）</div>
        ) : (d.changed && d.changed.length ? (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{"待提交 " + d.changed.length + " 个文件："}</div>
            {d.changed.map((c: any, i: number) => (
              <div key={i} style={{ ...C.row, background: fileDiff?.path === c.path ? "var(--bg-subtle,#f5f5f5)" : undefined }}
                onClick={() => showFileDiff(c.path)} title="点击查看该文件未提交 diff">
                <span style={{ color: c.status === "D" ? "#dc2626" : c.status === "??" ? "#16a34a" : "#2563eb", fontWeight: 700, marginRight: 6 }}>
                  {c.status === "D" ? "DEL" : c.status === "??" ? "NEW" : "MOD"}
                </span>
                <span style={C.mono}>{c.path}</span>
              </div>
            ))}
            {fileDiff ? (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{"未提交变更：" + fileDiff.path}</div>
                <pre style={C.pre}>{String(fileDiff.diff).slice(0, 3000)}</pre>
              </div>
            ) : null}
          </div>
        ) : null)}
        {d.skipped && d.skipped.length > 0 ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "#d97706" }}>
            {"⏭ 拦截 " + d.skipped.length + " 项：" + d.skipped.map((s: any) => s.reason).slice(0, 5).join("；") + (d.skipped.length > 5 ? "…" : "")}
          </div>
        ) : null}
      </div>
    );
  };

  const renderLog = () => {
    const d = data || {};
    return (
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button style={{ ...C.btn, padding: "3px 10px", display: "inline-flex", alignItems: "center", gap: 4 }} onClick={loadTags}>
            <Ic size={12} paths={ICONS.tag} />tags
          </button>
          <button style={{ ...C.btn, padding: "3px 10px", display: "inline-flex", alignItems: "center", gap: 4 }} onClick={doSnapshot}>
            <Ic size={12} paths={ICONS.camera} />固化现场
          </button>
        </div>
        {tagList && tagList.tags && tagList.tags.length > 0 ? (
          <div style={{ marginBottom: 8 }}>
            {tagList.tags.map((t: any) => (
              <span key={t.name} style={{ display: "inline-flex", alignItems: "center", gap: 4, margin: "0 6px 4px 0", padding: "2px 8px", borderRadius: 10, background: "#fef3c7", color: "#92400e", fontSize: 11, border: "1px solid #fcd34d" }}>
                <Ic size={11} paths={ICONS.tag} />{" "}{t.name}
                <button style={{ border: "none", background: "transparent", cursor: "pointer", color: "#92400e", display: "flex" }} onClick={() => doDelTag(t.name)} aria-label="删除 tag">
                  <Ic size={10} paths={ICONS.x} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {(d.log || []).map((r: any) => (
          <div key={r.hash} style={C.row} onClick={() => showDiff(r.hash)}>
            <div>
              <span style={{ color: "var(--accent,#2563eb)", fontWeight: 700, marginRight: 6 }}>{r.hash}</span>
              <span style={{ color: "var(--text-subtle,#666)", marginRight: 6 }}>{String(r.date || "").slice(5, 16)}</span>
              {(r.tags || []).map((t: string) => (
                <span key={t} style={{ marginRight: 4, padding: "1px 6px", borderRadius: 8, background: "#fef3c7", color: "#92400e", fontSize: 10 }}>
                  <Ic size={10} paths={ICONS.tag} />{t}
                </span>
              ))}
              <span>{r.subject}</span>
            </div>
            <div style={{ marginTop: 4, display: "flex", gap: 6 }}>
              <button style={{ ...C.btn, padding: "2px 8px" }} onClick={(e) => { e.stopPropagation(); doRestore(r.hash); }}>↩ 恢复</button>
              <button style={{ ...C.btn, padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 4 }} onClick={(e) => { e.stopPropagation(); doTag(r.hash); }}>
                <Ic size={11} paths={ICONS.tag} />tag
              </button>
            </div>
          </div>
        ))}
        {diff ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>版本 diff 预览</div>
            <pre style={C.pre}>{String((diff.show || "") + "\n" + (diff.diff || diff.error || "")).slice(0, 3000)}</pre>
          </div>
        ) : null}
      </div>
    );
  };

  const renderSelfcheck = () => {
    const d = data || {};
    return (
      <div>
        <div style={{ fontWeight: 600, marginBottom: 6, color: d.ok ? "#16a34a" : "#dc2626" }}>
          {d.ok ? "✅ 自检通过" : "❌ 自检未通过（" + ((d.bad || []).length) + " 项）"}
        </div>
        {(d.rows || []).map((r: any, i: number) => (
          <div key={i} style={C.row}>
            <span style={{ marginRight: 6, display: "inline-flex" }}><Ic size={13} paths={r.ok ? ICONS.check : ICONS.x} /></span>
            <b>{r.name}</b>
            <span style={{ color: "var(--text-subtle,#666)", marginLeft: 6 }}>{r.detail}</span>
          </div>
        ))}
        <button style={{ ...C.btn, marginTop: 8 }} onClick={() => load("selfcheck")}>↻ 重新自检</button>
      </div>
    );
  };

  const doGenKey = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api("/key", { method: "POST", ...jsonBody({}) });
      const d = await r.json();
      setMsg(d.ok ? "✅ 已生成密钥：" + d.keyFile + "（请立即备份！）" : "生成失败：" + d.error);
      load("config");
    } catch (e: any) { setMsg("生成失败：" + (e.message || e)); }
    setBusy(false);
  };

  const renderConfig = () => {
    const d = data || {};
    const rc = (d.config && d.config.remote) || {};
    const en = (d.config && d.config.encrypt) || {};
    const es = encStatus && encStatus.encrypt ? encStatus.encrypt : {};
    const warn = { padding: "8px 10px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 12, marginBottom: 8, lineHeight: 1.6 };
    const inp = { padding: "5px 8px", border: "1px solid var(--border,#e0e0e0)", borderRadius: 6, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontSize: 12 };
    const g = (id: string) => document.getElementById(id) as HTMLInputElement | null;
    return (
      <div>
        <div style={warn}>
          ⚠ 本仓包含 settings/models.json 等含 API Key 的敏感配置——<b>严禁配置为公开仓库（GitHub/Gitee 公开仓、任意公网可见仓）</b>！只能配私有/自建 git 仓；url 内嵌 token 仅存本机，不写日志不展示明文。
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, marginTop: 4 }}>远端同步（remote）</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
          <input id="cfg-remote-url" type="text" placeholder="git@github.com:user/private-configs.git 或 https://token@…" defaultValue={rc.url || ""} style={{ flex: 1, ...inp }} />
        </div>
        <div style={{ display: "flex", gap: 14, marginBottom: 8, fontSize: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}><input id="cfg-remote-push" type="checkbox" defaultChecked={rc.push === true} />提交后自动 push</label>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}><input id="cfg-remote-pull" type="checkbox" defaultChecked={rc.autoPull !== false} />push 前 pull --rebase</label>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button style={{ ...C.btn, ...C.btnPrimary }} onClick={() => {
            const url = g("cfg-remote-url")?.value || "";
            const push = g("cfg-remote-push") ? g("cfg-remote-push")!.checked : false;
            const autoPull = g("cfg-remote-pull") ? g("cfg-remote-pull")!.checked : true;
            doSaveConfig({ remote: { url, push, autoPull } });
          }}>保存 remote</button>
          <button style={C.btn} onClick={() => doSaveConfig({ remote: { url: "", push: false, autoPull: true } })}>清除 remote</button>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, marginTop: 10 }}>密文 commit（encrypt）</div>
        <div style={warn}>
          🔑 开启后仓内为密文，push 到任何仓库（含公开仓）都安全；但密钥文件（{en.keyFile || "{repo}/.git/configs-key"}）<b>丢失则永远无法恢复</b>！请备份密钥；密钥文件在 .git 下，git 永不跟踪、不入仓。
        </div>
        <div style={{ display: "flex", gap: 14, marginBottom: 6, fontSize: 12, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}><input id="cfg-enc-enabled" type="checkbox" defaultChecked={en.enabled === true} />启用密文 commit</label>
          <span style={{ color: es.keyExists === true ? "#16a34a" : "#dc2626" }}>{es.keyExists === true ? "✅ 密钥已生成（" + (es.keyFile || "") + "）" : "❌ 密钥未生成（先点生成密钥）"}</span>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input id="cfg-enc-patterns" type="text" defaultValue={(en.patterns || ["pi/agent/**"]).join(",")} placeholder="加密文件 glob（逗号分隔，如 pi/agent/**）" style={{ flex: 1, ...inp }} />
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button style={{ ...C.btn, ...C.btnPrimary }} onClick={() => {
            const enabled = g("cfg-enc-enabled") ? g("cfg-enc-enabled")!.checked : false;
            const raw = g("cfg-enc-patterns")?.value;
            const patterns = raw ? String(raw).split(",").map((s) => s.trim()).filter(Boolean) : ["pi/agent/**"];
            doSaveConfig({ encrypt: { enabled, algo: en.algo || "aes-256-gcm", keyFile: en.keyFile || "", patterns } });
          }}>保存 encrypt</button>
          <button style={C.btn} onClick={doGenKey}>生成密钥</button>
        </div>
        <pre style={{ ...C.pre, maxHeight: 320 }}>{JSON.stringify(d.config || {}, null, 2)}</pre>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button style={{ ...C.btn, ...C.btnPrimary }} onClick={() => doSaveConfig({ sentry: { enabled: true } })}>开启自动哨兵</button>
          <button style={C.btn} onClick={() => load("config")}>↻ 刷新</button>
        </div>
      </div>
    );
  };

  if (!open) return null;
  // 小屏全屏交给 aiti-float 的 data-ext-float-full 标记；small 只管安全区内边距
  const headStyle = small ? { ...C.head, paddingTop: "max(10px, env(safe-area-inset-top, 0px))" } : C.head;
  const bodyStyle = small ? { ...C.body, paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" } : C.body;
  return (
    <div
      data-ext-float="1" data-ext-float-w={560} data-ext-float-h={520} data-ext-float-full="1"
      style={C.root}
    >
      <div style={headStyle}>
        <span style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
          <Ic size={15} paths={ICONS.shield} />配置安全盾
        </span>
        <div style={C.tabs}>
          {[["status", "状态"], ["log", "历史"], ["selfcheck", "自检"], ["config", "配置"]].map(([k, label]) => (
            <button key={k} style={{ ...C.tab, ...(tab === k ? C.tabOn : {}) }} onClick={() => { setTab(k); setDiff(null); setFileDiff(null); }}>{label}</button>
          ))}
        </div>
        <button style={C.btn} onClick={() => onClose()} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>
      </div>
      <div style={bodyStyle}>
        {busy ? <div style={{ color: "var(--text-subtle,#666)", marginBottom: 6 }}>处理中…</div> : null}
        {msg ? (<div style={C.msg}>{msg.startsWith("❌") || msg.startsWith("⚠") || msg.startsWith("错误") || msg.startsWith("失败") || msg.startsWith("\u274c") ? <div style={C.errorMsg}>{msg}</div> : <div style={C.msg}>{msg}</div>}</div>) : null}
        {tab === "status" ? renderStatus() : tab === "log" ? renderLog() : tab === "selfcheck" ? renderSelfcheck() : renderConfig()}
      </div>
    </div>
  );
}

// toolbar 按钮：只负责触发全局打开（真正的 dialog 在 pages slot，避免 toolbar 容器裁剪 fixed 弹层）
export function ConfigsButton() {
  const open = () => { try { window.__aitiConfigsOpen && window.__aitiConfigsOpen(); } catch {} };
  // 顶栏按钮样式与系统内建按钮一致（AppShell topbarRowBtnStyle：flex 居中 + fixed 36×36）
  return (
    <button
      title="aiti-configs：配置版本化 + 自检"
      onClick={open}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      }}
    >
      {/* lucide shield：安全盾——与系统内建线条图标同风格 */}
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path key="p1" d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path key="p2" d="m9 12 2 2 4-4" />
      </svg>
    </button>
  );
}

// pages dialog：常驻 host 渲染层，注册全局打开函数，打开时渲染安全盾
export function ConfigsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    window.__aitiConfigsOpen = () => setOpen(true);
    return () => { delete window.__aitiConfigsOpen; };
  }, []);
  if (!open) return null;
  return <App open={true} onClose={() => setOpen(false)} />;
}
