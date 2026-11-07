/**
 * aiti-models-import · 导入弹窗（dialogs 插槽常驻挂载，显隐由本扩展状态控制）
 *
 * 契约：面板根 data-ext-float="1"（aiti-float 托管拖拽/最大化/小屏全屏 data-ext-float-full）
 * + 右上角 ✕（AI 按钮由框架注入）；打开时 GET /scan（用户动作触发，无轮询）。
 * 尺寸：data-ext-float-autoh（高度随内容自适应，上限 86vh）——展开预览会增高，固定高度只会把增长变成内层滚动。
 * 预览：provider 行「👁 N 模型」点开=待带入的模型清单（上下文/输出/推理/输入 + 新增|已有），
 *       数据随 /scan 载荷一并到达，展开零额外请求；label 只包「☑ + provider 名」，点预览不改勾选。
 * 导入：POST /import {saves, completed:true}（server 端走 wizard saveBatch）→
 *       成功后 dispatch "pi-web:models-changed" 让模型选择器即时刷新。
 */
import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./host-shim";

const api = (p: string, init?: RequestInit) =>
  fetch(apiUrl("/api/extensions/aiti-models-import" + p), { cache: "no-store", ...init });

// ---------- 模块级开合状态（dialogs 插槽常驻，toolbar/首启自动弹 共用） ----------
let dialogOpen = false;
const openListeners = new Set<() => void>();
export function setDialogOpen(v: boolean) {
  dialogOpen = v;
  for (const l of openListeners) l();
}
function useDialogOpen(): boolean {
  const [open, setOpen] = useState(dialogOpen);
  useEffect(() => {
    const l = () => setOpen(dialogOpen);
    openListeners.add(l);
    return () => { openListeners.delete(l); };
  }, []);
  return open;
}

const STATE_BADGE: Record<string, { text: string; color: string; bg: string }> = {
  "available-new": { text: "可导入", color: "#1d4ed8", bg: "rgba(59,130,246,.14)" },
  changed: { text: "有更新", color: "#b45309", bg: "color-mix(in srgb, var(--warn, #f59e0b) 16%, transparent)" },
  unchanged: { text: "无变化", color: "var(--text-muted, #6b7280)", bg: "rgba(107,114,128,.14)" },
  "source-gone": { text: "源已消失", color: "var(--text-muted, #6b7280)", bg: "rgba(107,114,128,.14)" },
};

/** 勾选默认值：新/有更新全选，无变化不选。 */
function defaultChecked(sources: any[]): Set<string> {
  const set = new Set<string>();
  for (const s of sources || []) {
    if (s.state === "available-new" || s.state === "changed") for (const d of s.drafts || []) set.add(s.id + ":" + d.key);
  }
  return set;
}

export function ImportDialogSlot() {
  const open = useDialogOpen();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<any>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const doScan = async () => {
    setLoading(true);
    setError("");
    try {
      const r = await api("/scan");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "扫描失败");
      setScan(j);
      setChecked(defaultChecked(j.sources));
    } catch (e: any) {
      setError(String((e && e.message) || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // 每次打开都重扫：来源配置可能已变（变更状态/草稿要新鲜）；scan/勾选/结果状态随开合重置
    if (open) void doScan();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const doImport = async () => {
    const saves = [...checked].map((k) => {
      const i = k.indexOf(":");
      return { sourceId: k.slice(0, i), key: k.slice(i + 1) };
    });
    if (!saves.length) return;
    setImporting(true);
    setResult(null);
    try {
      const r = await api("/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ saves, completed: true }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "导入失败");
      const okN = j.imported || 0;
      const warn = (j.warnings || []).join("；");
      setResult({ ok: true, text: `已导入 ${okN} 个 provider` + (warn ? `（注意：${warn}）` : "") + "，模型选择器已可刷新查看" });
      try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch { /* 宿主未监听时忽略 */ }
      setChecked(new Set());
      await doScan();
    } catch (e: any) {
      setResult({ ok: false, text: String((e && e.message) || e) });
    } finally {
      setImporting(false);
    }
  };

  const doClose = async () => {
    // 关闭即记 dismiss（服务端幂等：已完成导入时跳过）——不再自动弹，可从工具条手动打开
    try { await api("/dismiss", { method: "POST" }); } catch { /* 忽略 */ }
    setDialogOpen(false);
  };

  const toggle = (k: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const importableSources = useMemo(() => (scan?.sources || []).filter((s: any) => s.kind === "importable"), [scan]);
  const otherSources = useMemo(() => (scan?.sources || []).filter((s: any) => s.kind !== "importable"), [scan]);
  const checkedCount = checked.size;

  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={doClose}>
      <div
        data-ext-float="1"
        data-ext-float-w={880}
        data-ext-float-autoh="1"
        data-ext-float-full="1"
        style={{
          width: 880, maxWidth: "94vw", maxHeight: "86vh", display: "flex", flexDirection: "column",
          padding: 16, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)",
        }}
        onClick={(e: any) => e.stopPropagation()}
      >
        {/* 标题栏（首个子元素 = aiti-float 拖拽把手） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "move" }}>
          <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>从其他 Agent 导入模型配置</div>
          <button onClick={() => void doScan()} disabled={loading} title="重新扫描本机 agent 配置"
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "3px 8px" }}>
            {loading ? "扫描中…" : "↻ 重新扫描"}
          </button>
          <button onClick={() => void doClose()} aria-label="关闭" title="关闭"
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
          扫描本机各 agent 的 provider/baseUrl/key/模型配置，勾选后经 🧙 模型向导合并写入（不覆盖已有 key，可一步撤销）。
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 2 }}>
          {error && <div style={{ fontSize: 12, color: "#dc2626" }}>扫描失败：{error}</div>}
          {result && (
            <div style={{ fontSize: 12, color: result.ok ? "#059669" : "#dc2626", padding: "6px 8px", borderRadius: 6, background: result.ok ? "color-mix(in srgb, var(--ok, #10b981) 10%, transparent)" : "rgba(220,38,38,.08)" }}>
              {result.text}
            </div>
          )}
          {!scan && !error && loading && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>正在扫描本机 agent 配置…</div>}
          {scan && importableSources.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>未发现可导入的 agent 配置（codex / zcode / opencode 均未安装或无 provider 配置）。</div>
          )}
          {importableSources.map((s: any) => <SourceCard key={s.id} s={s} checked={checked} toggle={toggle} />)}
          {otherSources.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", borderTop: "1px dashed var(--border)", paddingTop: 6 }}>
              {otherSources.map((s: any) => (
                <div key={s.id} style={{ marginBottom: 2 }}>· {s.label}：不可导入 —— {s.reason}</div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <div style={{ flex: 1, fontSize: 11, color: "var(--text-muted)" }}>
            {scan?.firstRun && !scan?.completed ? "首次启动引导：关闭后可从工具条「导入模型配置」再次打开" : ""}
          </div>
          <button onClick={() => void doClose()} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", cursor: "pointer", fontSize: 12, padding: "6px 12px" }}>
            暂不
          </button>
          <button onClick={() => void doImport()} disabled={importing || checkedCount === 0}
            style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, cursor: checkedCount ? "pointer" : "not-allowed", fontSize: 12, padding: "6px 14px", opacity: checkedCount ? 1 : 0.5 }}>
            {importing ? "导入中…" : `导入勾选项（${checkedCount}）`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceCard({ s, checked, toggle }: { s: any; checked: Set<string>; toggle: (k: string) => void }) {
  const badge = STATE_BADGE[s.state] || null;
  const [expanded, setExpanded] = useState(true);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <div style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>
          {s.label}
          <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
            {(s.notes || [])[0] || ""}
          </span>
        </div>
        {badge && <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, color: badge.color, background: badge.bg }}>{badge.text}</span>}
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {(s.drafts || []).map((d: any) => (
            <DraftRow key={d.key} s={s} d={d} checked={checked} toggle={toggle} />
          ))}
          {(s.drafts || []).length === 0 && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{(s.notes || []).join("；") || "无可导入 provider"}</div>}
        </div>
      )}
    </div>
  );
}

const fmtTok = (n: any) => (!n ? "" : n >= 1000000 ? Math.round(n / 100000) / 10 + "M" : Math.round(n / 1000) + "k");

const MODALITY_ZH: Record<string, string> = { text: "文本", image: "图像", video: "视频", audio: "音频" };

const GRID_COLS = "minmax(0, 1.5fr) 54px 54px minmax(0, 1.1fr)";

/** provider 行的预览展开：勾选控件只包「☑ + provider 名」，其余徽标/预览按钮在 label 外（点预览不得切换勾选）。 */
function DraftRow({ s, d, checked, toggle }: { s: any; d: any; checked: Set<string>; toggle: (k: string) => void }) {
  const ck = s.id + ":" + d.key;
  const isOn = checked.has(ck);
  const [showModels, setShowModels] = useState(false);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", opacity: s.state === "unchanged" ? 0.75 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={isOn} onChange={() => toggle(ck)} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{d.key}</span>
        </label>
        <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, minWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.baseUrl} · {d.api}
        </span>
        <span style={{ fontSize: 11, color: d.hasKey ? "#059669" : "var(--text-muted)" }}>
          {d.hasKey ? "key" + d.keyHint : d.apiKeyEnv ? "env:" + d.apiKeyEnv : "无 key"}
        </span>
        <button
          onClick={() => setShowModels(!showModels)}
          aria-expanded={showModels}
          title="点击查看待带入的模型清单"
          style={{
            background: showModels ? "rgba(59,130,246,.12)" : "none",
            border: "1px solid " + (showModels ? "rgba(59,130,246,.4)" : "var(--border)"),
            borderRadius: 6, color: showModels ? "#1d4ed8" : "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 8px", whiteSpace: "nowrap",
          }}
        >
          {showModels ? "▾" : "▸"} 👁 {d.modelsCount} 模型
        </button>
        {d.conflict === "override" && (
          <span style={{ fontSize: 11, color: "#b45309", background: "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)", padding: "1px 6px", borderRadius: 999 }} title={"将覆盖字段：" + d.overrideFields.join(", ")}>
            覆盖 {d.overrideFields.join("/")}
          </span>
        )}
        {d.conflict === "merge" && (
          <span style={{ fontSize: 11, color: "#1d4ed8", background: "rgba(59,130,246,.12)", padding: "1px 6px", borderRadius: 999 }} title="同名 provider 已存在且 baseUrl 一致，将合并字段">
            合并
          </span>
        )}
      </div>
      {(d.warnings || []).length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, paddingLeft: 24 }}>
          {d.warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
      {showModels && <ModelPreview d={d} />}
    </div>
  );
}

/** 待带入的模型清单（数据随 /scan 已在手里，展开零额外请求）。 */
function ModelPreview({ d }: { d: any }) {
  const models: any[] = d.models || [];
  const cell = { fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };
  if (!models.length) {
    return <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, paddingLeft: 24 }}>来源配置不带模型清单——导入后在 🧙 向导「拉取 /models」补齐</div>;
  }
  const known = models.length - (d.newModelsCount || 0);
  const noMeta = models.every((m: any) => !m.contextWindow && !m.maxTokens && m.reasoning == null && !m.input);
  return (
    <div style={{ marginTop: 6, marginLeft: 24, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "rgba(0,0,0,.02)" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
        将带入 {models.length} 个模型{known > 0 ? `（新增 ${models.length - known} · 已有 ${known}，同 id 合并字段不重复）` : ""}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: GRID_COLS, gap: 6, fontSize: 10, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", paddingBottom: 3, marginBottom: 3 }}>
        <div>模型</div><div style={{ textAlign: "right" }}>上下文</div><div style={{ textAlign: "right" }}>输出</div><div>能力 / 状态</div>
      </div>
      <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
        {models.map((m: any) => (
          <div key={m.id} style={{ display: "grid", gridTemplateColumns: GRID_COLS, gap: 6, alignItems: "center" }}>
            <div style={cell} title={m.id}>
              <span style={{ fontSize: 11 }}>{m.name || m.id}</span>
              {m.name && m.name !== m.id && <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 5 }}>{m.id}</span>}
            </div>
            <div style={{ ...cell, textAlign: "right", color: "var(--text-muted)" }}>{fmtTok(m.contextWindow) || "—"}</div>
            <div style={{ ...cell, textAlign: "right", color: "var(--text-muted)" }}>{fmtTok(m.maxTokens) || "—"}</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              {m.reasoning && <span style={{ fontSize: 10, color: "#1d4ed8", background: "rgba(59,130,246,.1)", padding: "0 5px", borderRadius: 999 }}>推理</span>}
              {(m.input || []).filter((x: string) => x && x !== "text").map((x: string) => (
                <span key={x} style={{ fontSize: 10, color: "var(--text-muted)", background: "rgba(107,114,128,.12)", padding: "0 5px", borderRadius: 999 }}>{MODALITY_ZH[x] || x}</span>
              ))}
              <span style={{ fontSize: 10, color: m.existing ? "#b45309" : "#059669" }}>{m.existing ? "已有" : "新增"}</span>
            </div>
          </div>
        ))}
      </div>
      {noMeta && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>来源配置未提供模型参数——上下文/输出上限由 🧙 向导保存时反填（本表「—」即待反填）。</div>
      )}
    </div>
  );
}
