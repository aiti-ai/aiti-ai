/**
 * aiti-model-wizard · 启用作用域区块（G1+G2，docs/aiti-model-wizard-settings-takeover-plan.md）
 *
 * 直调宿主现成 API（零向导服务端依赖，与 loadSubs 调 /api/auth/providers 同范式）：
 *   GET /api/models/enabled?cwd=        → EnabledModelsView（allEnabled/stalePatterns/providers/scope/settingsPath/editable）
 *   PUT /api/models/enabled             → ops models/provider/clear/prune/resync（成功返回新视图）
 *   POST /api/models/refresh {provider} → 目录刷新（pi 内置模型清单冻结在 SDK 版本，新模型要刷才出现）
 * contextWindow 覆盖读写在向导 /model-override（providers[id].modelOverrides 的唯一写口）。
 *
 * 行为映射（原生 EnabledModelsSection / EnabledModelsBanner 语义一比一，2026-10 审核定稿）：
 *   - custom provider（models.json 自定义）只有 provider 整体开关；builtin（订阅/key/运行时注册）
 *     另有可展开 per-model 行：开关 + :level pin 只读徽标 + 上下文覆盖输入框（G2）。
 *   - provider 开关全开才 checked；部分选中显示 off + N/M 计数（原生 enabledModelsProviderToggle 同语义）；
 *     last-model 挡住的开关 disabled + 提示。
 *   - 批量启停：未筛选走 provider op（服务端解析浏览器未见模型），筛选过走 models op 点名 refs。
 *   - 横幅：settingsPath + enabledModels N/M + 失配计数（hover 解释）+ 清理失效（prune）+ 启用全部（clear）；
 *     editable=false（项目 .pi/settings.json 遮蔽）→ 全部只读 + 指路。
 *   - provider 不在运行时视图 ≠ 要去登录：builtin→登录提示，custom→保存/key 提示（原生 enabledCustomEmpty 同义）。
 *   - 序列化突变：单飞 + 排队一槽（原生同语义，防同面板并发写丢一）。
 *   - G6 对外暴露 resyncEnabledModels：向导 provider 改名保存后跟随重写 enabledModels 模式。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { apiUrl } from "./host-shim";
import { Ic, ICONS } from "./wizard-lib";

// 宿主 409/守卫原因 → 中文文案（原生 FAILURE_KEYS 对应项；向导中文单语直出）
const REASON_TEXT: Record<string, string> = {
  "last-model": "至少需要保留一个启用的模型。",
  "project-scope": "当前项目的 .pi/settings.json 设置了 enabledModels 并覆盖全局配置，这些开关为只读——请直接修改该文件。",
};

interface EnabledModelRow { id: string; name: string; ref: string; enabled: boolean; contextWindow?: number; thinkingPin?: string }
interface EnabledProviderView { id: string; name: string; kind: "builtin" | "custom"; enabledCount: number; models: EnabledModelRow[] }
interface EnabledView {
  allEnabled: boolean; patterns: string[] | null; stalePatterns: string[];
  enabledTotal: number; availableTotal: number; providers: EnabledProviderView[];
  scope: "global" | "project"; settingsPath: string; editable: boolean;
}

const fmtBytes = (n: number): string => {
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (u === 0 ? v : Math.round(v * 10) / 10) + " " + units[u];
};

/** G6：向导 provider 改名保存后调用——enabledModels 模式跟随重写（宿主 resync op）。
 *  失败静默（改名已成功，模式失配可后续 prune / 手动清），不阻塞改名主流程。 */
export async function resyncEnabledModels(renames: { from: string; to: string }[], cwd?: string | null): Promise<void> {
  if (!renames.length) return;
  try {
    await fetch(apiUrl("/api/models/enabled"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "resync", renames, modelRenames: [], fullyEnabled: [], ...(cwd ? { cwd } : {}) }),
    });
  } catch { /* 静默：见上 */ }
}

/** 启用作用域区块：provider 详情尾部的「模型启用范围」卡（横幅 + provider 开关 + 模型行）。 */
export function EnabledScopeBlock({ providerId, cwd }: { providerId: string; cwd?: string | null }) {
  const [view, setView] = useState<EnabledView | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState<Record<string, number | undefined> | null>(null); // modelId → contextWindow 覆盖
  const [ovDraft, setOvDraft] = useState<Record<string, string>>({}); // 覆盖输入草稿（打字中不落盘，blur 校验提交）
  const [ovErr, setOvErr] = useState<string>("");
  const [catBusy, setCatBusy] = useState(false);
  const [catNote, setCatNote] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);
  const pendingRef = useRef<string | null>(null);
  const queuedRef = useRef<{ key: string; body: any } | null>(null);
  const deadRef = useRef(false);

  useEffect(() => () => { deadRef.current = true; }, []);

  const load = useCallback(() => {
    setLoading(true);
    fetch(apiUrl("/api/models/enabled" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : "")), { cache: "no-store" })
      .then((r) => r.json())
      .then((d: EnabledView & { error?: string }) => {
        if (deadRef.current) return;
        if (d && d.error) setFailure(String(d.error));
        else setView(d);
      })
      .catch((e) => { if (!deadRef.current) setFailure(String(e && e.message || e)); })
      .finally(() => { if (!deadRef.current) setLoading(false); });
  }, [cwd]);

  useEffect(() => { pendingRef.current = null; queuedRef.current = null; load(); }, [load, reloadKey, providerId]);

  // 序列化突变：单飞 + 排队一槽（成功返回新视图直接 setView——宿主 PUT 语义）
  const mutate = useCallback((key: string, body: any) => {
    if (pendingRef.current) { queuedRef.current = { key, body }; return; }
    pendingRef.current = key;
    setPending(key);
    setFailure(null);
    void (async () => {
      try {
        const res = await fetch(apiUrl("/api/models/enabled"), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, ...(cwd ? { cwd } : {}) }),
        });
        const d = await res.json() as EnabledView & { error?: string; reason?: string };
        if (deadRef.current) return;
        if (!res.ok || d.error) {
          setFailure((d && d.reason && REASON_TEXT[d.reason]) || (d && d.error) || "HTTP " + res.status);
          return;
        }
        setView(d);
      } catch (e: any) {
        if (!deadRef.current) setFailure(String(e && e.message || e));
      } finally {
        pendingRef.current = null;
        setPending(null);
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (queued) mutate(queued.key, queued.body);
      }
    })();
  }, [cwd]);

  const provider = view ? view.providers.find((p) => p.id === providerId) || null : null;
  const editable = view?.editable === true;
  const busy = pending !== null;
  const scoped = !!(view && !view.allEnabled);
  const stale = view?.stalePatterns.length ?? 0;

  // builtin 展开 / custom 均需要覆盖值 → 展开或选中 provider 变化时拉一次（零轮询）
  useEffect(() => {
    if (!expanded && !overrides) return;
    let dead = false;
    setOvErr("");
    fetch(apiUrl("/api/extensions/aiti-model-wizard/model-override?provider=" + encodeURIComponent(providerId)), { cache: "no-store" })
      .then((r) => r.json())
      .then((d: any) => { if (!dead && d && d.ok) setOverrides(d.overrides || {}); })
      .catch(() => {});
    return () => { dead = true; };
  }, [expanded, providerId]);

  // 原生 enabledModelsProviderToggle 同语义：全开才 checked；blocked=开关移不动（last-model）
  const bulkRefs = (rows: EnabledModelRow[], enabled: boolean) => rows.filter((m) => m.enabled !== enabled).map((m) => m.ref);
  const toggle = (() => {
    if (!provider) return null;
    const rows = provider.models;
    const enableRefs = bulkRefs(rows, true);
    const disableRefs = bulkRefs(rows, false);
    const canEnable = editable && enableRefs.length > 0;
    const canDisable = editable && disableRefs.length > 0 && (view?.enabledTotal ?? 0) - disableRefs.length >= 1;
    const checked = rows.length > 0 && provider.enabledCount === rows.length;
    const blocked = checked ? !canDisable : !canEnable;
    return { checked, blocked, reason: !blocked ? null : editable ? "last-model" : "project-scope" };
  })();

  const setProviderEnabled = (enabled: boolean) => mutate("provider:" + providerId, { op: "provider", provider: providerId, enabled });

  const shown = provider ? provider.models.filter((m) => {
    const q = query.trim().toLowerCase();
    return !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
  }) : [];
  const filtered = !!provider && shown.length !== provider.models.length;
  const runBulk = (enabled: boolean) => {
    if (!provider) return;
    if (filtered) {
      const refs = bulkRefs(shown, enabled);
      if (refs.length) mutate("bulk:" + providerId, { op: "models", refs, enabled });
    } else setProviderEnabled(enabled);
  };
  const isLastEnabled = (m: EnabledModelRow) => m.enabled && (view?.enabledTotal ?? 0) <= 1;

  // G2：覆盖编辑（正整数或空；落 providers[id].modelOverrides，向导端点 + undo + 代理刷新）
  const setOverride = async (modelId: string, raw: string) => {
    const v = raw.trim();
    setOvErr("");
    if (v !== "" && (!/^\d+$/.test(v) || Number(v) < 1)) { setOvErr("上下文窗口需为正整数 tokens（留空=默认）；非法值未写盘。"); return; }
    try {
      const d = await (await fetch(apiUrl("/api/extensions/aiti-model-wizard/model-override"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providerId, model: modelId, ...(v === "" ? {} : { contextWindow: Number(v) }) }),
      })).json();
      if (!d.ok) { setOvErr(d.error || "保存失败"); return; }
      setOverrides((prev) => ({ ...(prev || {}), [modelId]: v === "" ? undefined : Number(v) }));
      setReloadKey((k) => k + 1); // 重拉视图（effective contextWindow 变化）
    } catch (e: any) { setOvErr(String(e && e.message || e)); }
  };

  // 目录刷新（builtin：pi 内置清单冻结在 SDK 版本）
  const refreshCatalog = () => {
    setCatBusy(true); setCatNote("");
    void (async () => {
      try {
        const d = await (await fetch(apiUrl("/api/models/refresh"), {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: providerId }),
        })).json() as { completed?: boolean; changed?: boolean; reason?: string; error?: string };
        if (d.error) setCatNote("无法获取模型目录：" + d.error);
        else if (d.reason === "offline") setCatNote("已设置 PI_OFFLINE，不会联网获取模型目录。");
        else if (!d.completed) setCatNote("无法获取模型目录。请检查网络连接和该 provider 的凭据后重试。");
        else { setCatNote(d.changed ? "已从服务商更新模型列表。" : "模型列表已是最新。"); if (d.changed) setReloadKey((k) => k + 1); }
      } catch (e: any) { setCatNote("无法获取模型目录：" + String(e && e.message || e)); }
      setCatBusy(false);
    })();
  };

  if (loading && !view) return <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-subtle,#888)" }}>启用范围读取中…</div>;

  // 横幅：作用域生效或存在失配时显示（原生 EnabledModelsBanner 同判据）
  const banner = view && (scoped || stale > 0) ? (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "5px 9px", marginBottom: 8, borderRadius: 8, background: "rgba(37,99,235,.08)", border: "1px solid rgba(37,99,235,.22)", fontSize: 11 }}>
      <code style={{ fontWeight: 650 }} title={view.settingsPath}>{view.settingsPath.split("/").slice(-2).join("/")}</code>
      <code style={{ color: "var(--text-subtle,#666)" }} title={view.settingsPath}>
        {"· enabledModels " + view.enabledTotal + "/" + view.availableTotal}
        {stale > 0 ? " · " + stale + " 条失配" : ""}
      </code>
      <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
        {editable && stale > 0 ? (
          <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} disabled={busy}
            title="删除匹配不到任何模型的配置条目。没有可用凭证的 provider 的条目会保留，其余也保持不变。"
            onClick={() => mutate("prune", { op: "prune" })}>清理无效条目</button>
        ) : null}
        {editable && scoped ? (
          <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} disabled={busy}
            title="清除所有 provider 的模型筛选。"
            onClick={() => mutate("clear", { op: "clear" })}>启用全部模型</button>
        ) : null}
      </div>
    </div>
  ) : null;

  const section = (() => {
    if (!view) return null;
    if (!provider) {
      // 不在运行时视图 ≠ 要去登录：custom→保存/key 提示（原生 enabledCustomEmpty 同义）
      return <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-subtle,#888)" }}>这个 provider 目前没有可用模型。请先保存修改，并确认 API key 有效（或完成登录）。</div>;
    }
    const lastBlocked = editable && toggle!.checked && toggle!.blocked; // 全开被 last-model 挡（不能再关）
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "6px 0" }}>
          <span style={{ fontWeight: 650, fontSize: 12 }}>模型启用范围</span>
          <span style={{ fontSize: 11, color: "var(--text-subtle,#888)" }}>{"已启用 " + provider.enabledCount + "/" + provider.models.length}</span>
          <label style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 11.5, cursor: busy || toggle!.blocked || !editable ? "default" : "pointer" }} title={toggle!.blocked ? (editable ? REASON_TEXT["last-model"] : REASON_TEXT["project-scope"]) : "启用/停用 " + (provider.name || providerId) + " 的全部模型"}>
            <input type="checkbox" checked={toggle!.checked} disabled={busy || toggle!.blocked || !editable}
              onChange={(e) => setProviderEnabled(e.target.checked)} />
            全部启用
          </label>
          <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} disabled={busy || !editable || !bulkRefs(shown, true).length}
            onClick={() => runBulk(true)}>{filtered ? "开启筛选结果" : "全部开启"}</button>
          <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }}
            disabled={busy || !editable || !bulkRefs(shown, false).length || (view!.enabledTotal - bulkRefs(shown, false).length < 1 && !filtered)}
            title={lastBlocked ? REASON_TEXT["last-model"] : undefined}
            onClick={() => runBulk(false)}>{filtered ? "关闭筛选结果" : "全部关闭"}</button>
          {provider.kind === "builtin" ? (
            <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} disabled={busy || catBusy} title="立即获取该 provider 当前发布的模型列表。pi 内置的列表固定在 pi-web 附带的 pi 版本上，新发布的模型需要刷新后才会出现。"
              onClick={refreshCatalog}>{catBusy ? "刷新中…" : (<><Ic size={11} paths={ICONS.refresh} /> 刷新目录</>)}</button>
          ) : null}
          {provider.kind === "builtin" && provider.models.length > 3 ? (
            <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} onClick={() => setExpanded((v) => !v)}>{expanded ? "收起模型行" : "逐模型开关"}</button>
          ) : null}
        </div>
        {catNote ? <div style={{ fontSize: 11, color: "var(--text-subtle,#888)", marginBottom: 6 }}>{catNote}</div> : null}
        {!editable ? <div style={{ fontSize: 11, color: "#b45309", marginBottom: 6 }}>{REASON_TEXT["project-scope"]}</div> : null}
        {failure ? <div style={{ fontSize: 11, color: "#dc2626", marginBottom: 6 }}>{failure}</div> : null}
        {lastBlocked ? <div style={{ fontSize: 11, color: "#b45309", marginBottom: 6 }}>{REASON_TEXT["last-model"]}</div> : null}
        {expanded && provider.kind === "builtin" ? (
          <div>
            {provider.models.length > 8 ? (
              <input className="amw-input" style={{ width: "100%", marginBottom: 6 }} value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder={"筛选 " + provider.models.length + " 个模型…"} aria-label="筛选可用模型" />
            ) : null}
            <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border,#e5e7eb)", borderRadius: 8 }}>
              {shown.length === 0 ? (
                <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-subtle,#888)" }}>没有匹配的模型。</div>
              ) : shown.map((m, i) => {
                const lastOne = isLastEnabled(m);
                const ov = overrides ? overrides[m.id] : undefined;
                return (
                  <div key={m.ref} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 9px", borderTop: i === 0 ? "none" : "1px solid var(--border,#eee)", fontSize: 11.5 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                      <code style={{ display: "block", fontSize: 10, color: "var(--text-subtle,#888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.id}</code>
                    </span>
                    {m.thinkingPin ? (
                      <span className="amw-tag" title={"由 enabledModels 固定的思考等级，需在 settings.json 中修改。"}>{m.thinkingPin}</span>
                    ) : null}
                    <input className="amw-input" style={{ width: 110, padding: "2px 6px", fontSize: 11 }} type="text" inputMode="numeric"
                      value={ovDraft[m.id] ?? (ov === undefined || ov === null ? "" : String(ov))}
                      placeholder={m.contextWindow ? String(m.contextWindow) : ""}
                      title={"上下文窗口覆盖（tokens），留空使用默认" + (m.contextWindow ? "（当前 " + fmtBytes(m.contextWindow) + "）" : "")}
                      aria-label={m.name + " 的上下文窗口"}
                      disabled={!editable}
                      onChange={(e) => setOvDraft((prev) => ({ ...prev, [m.id]: e.target.value }))}
                      onBlur={(e) => { const stored = overrides && typeof overrides[m.id] === "number" ? String(overrides[m.id]) : ""; if (e.target.value.trim() !== stored) void setOverride(m.id, e.target.value); }}
                      onKeyDown={(e: any) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    />
                    <label style={{ display: "inline-flex", alignItems: "center", cursor: busy || !editable || lastOne ? "default" : "pointer" }}
                      title={lastOne ? REASON_TEXT["last-model"] : "在模型选择器中显示 " + m.name}>
                      <input type="checkbox" checked={m.enabled} disabled={busy || !editable || lastOne}
                        onChange={(e) => mutate(m.ref, { op: "models", refs: [m.ref], enabled: e.target.checked })} />
                    </label>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-subtle,#888)", marginTop: 4 }}>
              上下文窗口（tokens），留空使用默认值；已加载的会话需重启 Pi Web 才会更新。开关 = 在模型选择器中显示/隐藏。
            </div>
            {ovErr ? <div style={{ fontSize: 11, color: "#dc2626", marginTop: 4 }}>{ovErr}</div> : null}
          </div>
        ) : null}
        {provider.kind === "custom" ? (
          <div style={{ fontSize: 10.5, color: "var(--text-subtle,#888)" }}>自定义 provider 的模型在「模型」编辑区直接增删；此开关控制整组是否出现在选择器。</div>
        ) : null}
      </>
    );
  })();

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border,#eee)", paddingTop: 8 }}>
      {banner}
      {section}
    </div>
  );
}
