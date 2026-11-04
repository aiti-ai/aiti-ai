/**
 * git-plan · CommitPlanDialog（git-ops 融合方案 M4；原 folder 案 §5 交互流的用户主导版）。
 *
 * - 打开：引擎 refs 重探（fresh dirtyFiles）→ 启发式分组（folder server，含偏好）；
 *   若 state 层已有本仓 plan 且组文件仍 ⊆ 当前脏集 → 恢复用户上次编辑。
 * - 编辑：组消息改写 / 文件「→」移到下一组（学 dirKey 共现）/ 「✕」剔除（学路径）/ 恢复 / 新建组。
 * - 逐笔提交：引擎 `/git/plan/execute`（逐组 add→commit，失败即停返回 completed/failedGroup）；
 *   失败 → 断点 UI（卡在第 N 组）+「回滚本计划」= 引擎 `/git/plan/rollback`（reset --mixed baseHEAD）。
 * - AI 精修（两级第二级）留待 aiti-git-review aiReview services 落地（同步取模型输出通道未拍板）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "./host-shim";
import { ct } from "./comp-i18n";
import { createGitOpsApi } from "../../../_shared/git-ops-client/api.mjs";
import type { FolderGit } from "./git-toolbar";

interface PlanGroupEdit { key: string; message: string; files: string[]; note?: string }

const statusOf = (xy: string): string => {
  if (xy === "??") return "untracked";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  if (xy.includes("R") || xy.includes("C")) return "renamed";
  return "modified";
};

const groupColor = (i: number): string => `color-mix(in srgb, var(--accent) ${[85, 60, 40, 25][i % 4]}%, var(--text))`;

export function CommitPlanDialog(p: { root: string; git: FolderGit; onClose: () => void }) {
  const api = useMemo(() => createGitOpsApi({ apiUrl }), []);
  const [groups, setGroups] = useState<PlanGroupEdit[] | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [baseHEAD, setBaseHEAD] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAvail, setAiAvail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ completed: number; failedGroup: number | null; shas: string[] } | null>(null);
  const [rolled, setRolled] = useState(false);

  // 打开：重探 refs → 启发式 → 与已存 plan 合并（组文件仍 ⊆ 当前脏集才恢复）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api.refs(p.root);
      if (cancelled) return;
      const dirty: { xy: string; path: string }[] = r.data?.dirtyFiles ?? [];
      setBaseHEAD(r.data?.head ?? "");
      const files = dirty.map((f) => ({ path: f.path, status: statusOf(f.xy) }));
      const g = await fetch(apiUrl("/api/extensions/aiti-folder/git-plan-group"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: p.root, files }),
      }).then((x) => x.json()).catch(() => null);
      if (cancelled) return;
      setAiAvail(!!g?.aiRefine);
      let next: PlanGroupEdit[] = (g?.groups ?? []).map((x: any, i: number) => ({ key: x.key ?? `g${i}`, message: x.message ?? "", files: x.files ?? [] }));
      let exc: string[] = g?.excluded ?? [];
      const saved = await fetch(apiUrl("/api/extensions/aiti-folder/git-plan-get"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: p.root }),
      }).then((x) => x.json()).catch(() => null);
      const sp = saved?.plan;
      if (sp && Array.isArray(sp.groups) && sp.groups.length > 0 && sp.baseHEAD === (r.data?.head ?? "")) {
        const dirtySet = new Set(files.map((f) => f.path));
        const restored = sp.groups
          .map((sg: any) => ({ key: sg.id ?? "g", message: sg.message ?? "", files: (sg.files ?? []).filter((f: string) => dirtySet.has(f)) }))
          .filter((sg: any) => sg.files.length > 0);
        if (restored.length > 0) {
          next = restored;
          exc = sp.excluded ?? exc;
        }
      }
      setGroups(next);
      setExcluded(exc);
    })().catch(() => { if (!cancelled) { setError(ct("i18n.networkError")); setGroups([]); setExcluded([]); } });
    return () => { cancelled = true; };
  }, [p.root, api]);

  const learn = useCallback((action: "move" | "exclude", payload: Record<string, string>) => {
    void fetch(apiUrl("/api/extensions/aiti-folder/git-plan-learn"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: p.root, action, ...payload }),
    }).catch(() => {});
  }, [p.root]);

  const moveFile = useCallback((fromGroup: number, file: string) => {
    setGroups((prev) => {
      if (!prev || prev.length < 2) return prev;
      const next = prev.map((g) => ({ ...g, files: g.files.filter((f) => f !== file) }));
      const to = (fromGroup + 1) % prev.length;
      next[to].files.push(file);
      const kept = next.filter((g) => g.files.length > 0);
      learn("move", { file, toKey: kept[to >= kept.length ? 0 : to]?.key ?? next[to].key });
      return kept.length > 0 ? kept : next;
    });
  }, [learn]);

  const excludeFile = useCallback((file: string) => {
    setGroups((prev) => prev ? prev.map((g) => ({ ...g, files: g.files.filter((f) => f !== file) })).filter((g) => g.files.length > 0) : prev);
    setExcluded((prev) => [...prev, file]);
    learn("exclude", { path: file });
  }, [learn]);

  const restoreFile = useCallback((file: string) => {
    setExcluded((prev) => prev.filter((f) => f !== file));
    setGroups((prev) => {
      if (!prev || prev.length === 0) return prev;
      const next = [...prev];
      next[0] = { ...next[0], files: [...next[0].files, file] };
      return next;
    });
  }, []);

  const addGroup = useCallback(() => {
    setGroups((prev) => {
      if (!prev || prev.length === 0) return prev;
      const donor = prev.reduce((a, b) => (b.files.length > a.files.length ? b : a), prev[0]);
      const file = donor.files[donor.files.length - 1];
      if (!file) return prev;
      return [...prev.map((g) => g === donor ? { ...g, files: g.files.slice(0, -1) } : g).filter((g) => g.files.length > 0),
        { key: "g" + Date.now(), message: ct("git.planNewGroupMessage"), files: [file] }];
    });
  }, []);

  const aiRefine = useCallback(async () => {
    if (!groups || aiBusy) return;
    setAiBusy(true); setError(null);
    try {
      // basePath 从 apiUrl 推导（host-shim 前缀 /dev 等）；origin 本页已知
      const p1 = apiUrl("/api/agent/new");
      const basePath = p1.slice(0, Math.max(0, p1.indexOf("/api/")));
      const r = await fetch(apiUrl("/api/extensions/aiti-folder/git-plan-ai-refine"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: p.root, origin: location.origin, basePath, groups, excluded }),
      }).then((x) => x.json());
      if (!r?.ok) { setError(r?.error || "AI refine failed"); return; }
      const res = r.result as { groups: any[]; excluded: string[] };
      setGroups(res.groups.map((x: any, i: number) => ({ key: x.key ?? `ai-${i}`, message: x.message ?? "", files: x.files ?? [], note: x.note || undefined })));
      setExcluded(res.excluded ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  }, [groups, aiBusy, p.root, excluded]);

  const execute = useCallback((startIdx = 0) => {
    if (!groups || busy) return;
    const remaining = groups.slice(startIdx);
    if (remaining.length === 0) return;
    const messages = remaining.map((g, i) => `${startIdx + i + 1}. ${g.message} (${g.files.length})`).join("\n");
    if (!window.confirm(ct("git.planConfirm", { count: remaining.length }) + "\n" + messages)) return;
    setBusy(true); setError(null); setResult(null); setRolled(false);
    (async () => {
      // plan 落盘（state 层）→ 引擎逐笔执行（断点语义）
      await fetch(apiUrl("/api/extensions/aiti-folder/git-plan-save"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: p.root, baseHEAD, groups: groups.map((g) => ({ id: g.key, files: g.files, message: g.message, state: "pending" })), excluded }),
      }).catch(() => {});
      const r = await api.planExecute(p.root, remaining.map((g) => ({ files: g.files, message: g.message })));
      if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
      const d = r.data as { ok: boolean; completed: number; failedGroup: number | null; shas: string[]; error?: string };
      const failedAbs = d.failedGroup != null ? startIdx + d.failedGroup : null;
      setResult({ completed: startIdx + d.completed, failedGroup: failedAbs, shas: d.shas ?? [] });
      if (d.ok) {
        p.git.refresh();
        p.onClose();
      } else {
        setError(d.error ?? "");
      }
    })().finally(() => setBusy(false));
  }, [groups, busy, api, p.root, p.git, p.onClose, baseHEAD, excluded]);

  const rollback = useCallback(() => {
    if (!baseHEAD || busy) return;
    setBusy(true);
    (async () => {
      const r = await api.planRollback(p.root, baseHEAD);
      if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
      setRolled(true);
      setResult(null);
      p.git.refresh();
    })().finally(() => setBusy(false));
  }, [baseHEAD, busy, api, p.root, p.git]);

  const totalFiles = (groups ?? []).reduce((t, g) => t + g.files.length, 0);

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget && !busy) p.onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 430, maxWidth: "94vw", maxHeight: "84vh", display: "flex", flexDirection: "column", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)", boxShadow: "0 14px 36px color-mix(in srgb, var(--text) 16%, transparent)", fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)", fontWeight: 600, gap: 6 }}>
          {ct("git.planTitle")}
          {groups ? <span style={{ color: "var(--text-dim)", fontSize: 10.5, fontWeight: 400, fontFamily: "var(--font-mono)" }}>{groups.length} / {totalFiles}</span> : null}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={p.onClose} style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "8px 12px" }}>
          {!groups ? <div style={{ color: "var(--text-dim)", fontSize: 11, padding: "8px 0" }}>…</div> : (
            <>
              {groups.map((g, gi) => (
                <div key={g.key + gi} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "7px 9px", marginBottom: 7, background: "var(--bg-hover)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: groupColor(gi), flexShrink: 0 }} />
                    <input value={g.message} onChange={(e) => setGroups((prev) => prev ? prev.map((x, xi) => xi === gi ? { ...x, message: e.target.value } : x) : prev)}
                      placeholder={ct("git.commitPlaceholder")}
                      style={{ flex: 1, minWidth: 0, height: 24, boxSizing: "border-box" as const, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)", padding: "0 7px", outline: "none" }} />
                    {result && gi < result.completed ? <span title="committed" style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>✓</span> : null}
                    {g.note ? <span title={g.note} style={{ fontSize: 10, flexShrink: 0, color: "var(--text-dim)", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{g.note.startsWith("✓") ? "" : "⚠ "}{g.note}</span> : null}
                  </div>
                  {g.files.map((f) => (
                    <div key={f} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1.5px 0 1.5px 14px", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1, minWidth: 0 }}>{f}</span>
                      {groups.length > 1 ? (
                        <button type="button" title={ct("git.planMoveTo")} onClick={() => moveFile(gi, f)} style={planIconBtn()}>→</button>
                      ) : null}
                      <button type="button" title={ct("git.planExclude")} onClick={() => excludeFile(f)} style={planIconBtn()}>✕</button>
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button type="button" onClick={addGroup} disabled={totalFiles === 0}
                  style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: totalFiles === 0 ? "default" : "pointer", fontSize: 11, padding: "2px 0" }}>
                  {ct("git.planAddGroup")}
                </button>
                {aiAvail ? (
                  <button type="button" onClick={() => void aiRefine()} disabled={aiBusy || !groups}
                    style={{ border: "none", background: "none", color: aiBusy ? "var(--text-dim)" : "var(--accent)", cursor: aiBusy ? "default" : "pointer", fontSize: 11, padding: "2px 0" }}>
                    {aiBusy ? ct("git.aiRefineBusy") : ct("git.aiRefine")}
                  </button>
                ) : null}
              </div>
              {excluded.length > 0 ? (
                <div style={{ marginTop: 6, padding: "6px 9px", border: "1px dashed var(--border)", borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 3 }}>{ct("git.planExcluded")}</div>
                  {excluded.map((f) => (
                    <div key={f} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", padding: "1.5px 0" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1, minWidth: 0 }}>{f}</span>
                      <button type="button" title={ct("git.planRestore")} onClick={() => restoreFile(f)} style={planIconBtn()}>↩</button>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
        <div style={{ padding: "8px 12px 10px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 7 }}>
          {error || result && result.failedGroup != null ? (
            <div style={{ fontSize: 10.5, color: "var(--text)", background: "color-mix(in srgb, var(--text) 6%, transparent)", borderRadius: 5, padding: "5px 8px", overflowWrap: "anywhere" as const }}>
              ⚠ {ct("git.planStuck", { group: (result?.failedGroup ?? 0) + 1 })}{error ? "：" + error : ""}
              {rolled ? " · " + ct("git.planRolledBack") : ""}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 6 }}>
            {result && result.failedGroup != null && baseHEAD ? (
              <button type="button" disabled={busy} onClick={() => void rollback()} style={planSecBtn(busy)}>{ct("git.planRollback")}</button>
            ) : null}
            {result && result.failedGroup != null ? (
              <button type="button" disabled={busy} onClick={() => execute(result.failedGroup ?? 0)} style={planSecBtn(busy)}>{ct("git.planRetry")}</button>
            ) : null}
            <button type="button" disabled={busy || !groups || groups.length === 0} onClick={() => execute(0)} style={{
              flex: 1, height: 27, borderRadius: 7, fontSize: 11.5, fontWeight: 600,
              background: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)",
              cursor: busy || !groups || groups.length === 0 ? "not-allowed" : "pointer", opacity: busy || !groups || groups.length === 0 ? 0.6 : 1,
            }}>{busy ? "…" : ct("git.planExecute")}</button>
            <button type="button" onClick={p.onClose} style={{ border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-muted)", borderRadius: 7, fontSize: 11, padding: "0 12px", cursor: "pointer" }}>{ct("files.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const planIconBtn = () => ({
  border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 10.5,
  padding: "1px 4px", flexShrink: 0,
} as const);
const planSecBtn = (busy: boolean) => ({
  height: 27, borderRadius: 7, fontSize: 11, padding: "0 10px", cursor: busy ? "not-allowed" : "pointer",
  background: "var(--bg-hover)", color: "var(--text)", border: "1px solid var(--border)", opacity: busy ? 0.6 : 1,
} as const);
