/**
 * aiti-ai-input · 语音识别服务器管理面板（懒 chunk，2026-09-14 拆分自 components.tsx；
 * 方案 pi-web-eager-ext-split-plan.md §5.2）。
 *
 * 引擎设置/热词/启停 UI（重件）：toolbar 🎙️、extman「打开」、右栏 tab 面激活时由
 * entry 薄壳经 ext-lazy 动态 import（dialogs/rightFileDock 插槽常挂载，import 由
 * gate 驱动而非 mount）。共享模块 logic（AC 状态）/host-shim 在 entry chunk 单实例；
 * DockBody 等 dock UI 随本 chunk 走。
 */
import { useState, useEffect, useRef } from "react";
import { apiUrl } from "./host-shim";
import { AC } from "./logic";
// ==================== 语音识别服务器管理弹窗（toolbar 声明式注册 + dialogs 常挂；样式对齐宿主系统变量） ====================
// dock v3（P2 批）：显隐收口展示状态机——信箱 __aitiAsrOpen / 面板 ✕ 全部走 openFloat/closePanel
import { usePresent, DockBody, isSidebarDockState, sidebarZoneOf } from "../../../_shared/ext-float-dock";
// dock 头工具条 v3：face 声明按钮（刷新），内容实现命令 + 状态上报
import { useDockCommands, useDockHeaderState, useDockHeaderStateOf, requestDockCommand } from "../../../_shared/ext-float-dock";
import type { DockHeaderAction } from "../../../_shared/ext-float-dock";
// 键与开关的唯一所有 = entry 薄壳（原信箱 __aitiAsrOpen 随开关收编 entry 退役：
// asrOpenSet 直调 openFloat，不再经 window 间址，重试 5×200ms 一并删除）
import { ASR_KEY, asrOpenSet, usageOpenSet } from "./entry";

// 系统样式基准（对齐 aiti-model-check / 宿主 globals：全部 var(--*) 带兜底，杜绝逐扩展硬编码漂移）
const ST = {
  panel: ({ w }: { w?: string }): Record<string, string> => ({
    display: "flex", flexDirection: "column", zIndex: 2147483101,
    background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
    border: "1px solid var(--border,#e0e0e0)", borderRadius: 16,
    boxShadow: "0 16px 64px rgba(0,0,0,.25)",
    width: w ?? "440px", maxWidth: "94vw", maxHeight: "86vh",
    fontSize: 13, overflow: "hidden",
  }),
  head: (): Record<string, string> => ({
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    padding: "10px 14px", borderBottom: "1px solid var(--border,#e0e0e0)",
    background: "var(--bg-subtle,#f5f5f5)", flexShrink: 0,
  }),
  body: (): Record<string, string> => ({
    padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10,
    overflow: "auto", minHeight: 0,
  }),
  btn: (extra?: Record<string, string>): Record<string, string> => ({
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
    whiteSpace: "nowrap", flexShrink: 0, padding: "5px 12px",
    borderWidth: 1, borderStyle: "solid", borderColor: "var(--border,#e0e0e0)",
    borderRadius: 8, cursor: "pointer", background: "var(--bg,#fff)",
    color: "var(--text,#1a1a1a)", fontWeight: 500, fontSize: 13, lineHeight: 1.4,
    ...(extra || {}),
  }),
  btnPrimary: (): Record<string, string> => ({
    background: "var(--accent,#2563eb)", borderColor: "var(--accent,#2563eb)", color: "#fff",
  }),
  btnDanger: (): Record<string, string> => ({
    background: "var(--color-danger,#dc2626)", borderColor: "var(--color-danger,#dc2626)", color: "#fff",
  }),
  section: (): Record<string, string> => ({
    border: "1px solid var(--border,#e0e0e0)", borderRadius: 10,
    background: "var(--bg-subtle,#f5f5f5)", padding: "10px 12px",
    display: "flex", flexDirection: "column", gap: 6,
  }),
  row: (): Record<string, string> => ({
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12.5, lineHeight: 1.6,
  }),
  muted: (): Record<string, string> => ({ color: "var(--text-muted,#767676)" }),
  input: (): Record<string, string> => ({
    width: "100%", boxSizing: "border-box", background: "var(--bg,#fff)",
    color: "var(--text,#1a1a1a)", border: "1px solid var(--border,#e0e0e0)",
    borderRadius: 8, padding: "8px 10px", fontSize: 12.5, fontFamily: "inherit", resize: "vertical",
  }),
} as const;

// 语音识别服务器管理弹窗（aiti-float 契约：data-ext-float="1"）
// 模块级 FeatRow（feature 行 + ✎ 编辑态）：避免定义在 AsrPanelSlot 内——内联组件每次渲染新类型
// → React 卸载重建子树 → 编辑态 input 丢焦点（输入一个数字就失焦的根因）。
interface FeatRowProps {
  fid: string; label: string;
  display: React.ReactNode; editor: React.ReactNode;
  editing: string | null; feats: Record<string, unknown>;
  setEditing: (v: string | null) => void;
  setDraftCount: (v: string) => void;
}
function FeatRow(props: FeatRowProps) {
  const { fid, label, display, editor, editing, feats, setEditing, setDraftCount } = props;
  if (editing === fid) {
    return (
      <div style={ST.row()}>
        <span style={ST.muted()}>{label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>{editor}</span>
      </div>
    );
  }
  return (
    <div style={ST.row()}>
      <span style={ST.muted()}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span>{display}</span>
        <button title="编辑" onClick={() => { if (fid === "asr.hotwords.count") setDraftCount(String((feats as { asrHotwordsCount?: number }).asrHotwordsCount ?? 100)); setEditing(fid); }} style={{
          background: "none", border: "none", cursor: "pointer", color: "var(--text-muted,#767676)",
          padding: "1px 4px", fontSize: 12, lineHeight: 1, borderRadius: 4,
        }}>✎</button>
      </span>
    </div>
  );
}

// dock v3：双面 face 参数化（dialogs=float / sidebarExplorerDock=left）——只有激活面渲染/拉数据
export function AsrPanelSlot() { return renderAsrPanel("float"); }
export function AsrDockRight() { return renderAsrPanel("right"); }

// ── 引擎视图类型（GET /asr/config 响应；key 值不回传，只有 configured/tail）──
interface AsrProvField { key: string; label: string; secret?: boolean; placeholder?: string }
interface AsrProvView {
  id: string; label: string;
  capabilities: { stream: boolean; hotwords: boolean; pass2: boolean };
  ready: boolean;
  params: Record<string, { configured: boolean; tail?: string; value?: string }>;
  fields: AsrProvField[];
}
interface AsrCfgView { provider: string; providerReady: boolean; providers: AsrProvView[] }
type AsrTestResult = { ok: boolean; ms?: number; text?: string; error?: string; hint?: string; note?: string } | null;
interface AsrUsageRow { requests: number; seconds: number; errors: number }
interface AsrUsageView {
  ok?: boolean; today?: string;
  todayRows?: Record<string, AsrUsageRow>; totals?: Record<string, AsrUsageRow>;
  price?: Record<string, number>; lastAt?: Record<string, number>; hint?: string;
}

// ① 引擎切换（模块级组件：内联组件每次渲染新类型 → 子树重建 → 输入失焦）
function ProviderCards({ cfg, onPick, busy }: { cfg: AsrCfgView | null; onPick: (id: string) => void; busy?: boolean }) {
  if (!cfg) {
    return (
      <div style={ST.section()}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>识别引擎</div>
        <span style={ST.muted()}>加载中…</span>
      </div>
    );
  }
  const cur = cfg.providers.find((p) => p.id === cfg.provider) || null;
  const caps = cur
    ? ([cur.capabilities.stream ? "真流式" : null, cur.capabilities.hotwords ? "热词" : null, cur.capabilities.pass2 ? "2-pass" : null]
      .filter(Boolean).join(" · ") || "非流式 · 无热词")
    : "";
  return (
    <div style={ST.section()}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>识别引擎</div>
      <select
        value={cfg.provider || ""}
        disabled={busy}
        onChange={(e) => { const v = e.target.value; if (v && v !== cfg.provider) onPick(v); }}
        style={{ ...ST.input(), padding: "5px 8px", fontSize: 12.5 }}
      >
        {cfg.providers.map((p) => (
          <option key={p.id} value={p.id}>{p.label}{p.ready ? "" : "（未配置）"}</option>
        ))}
      </select>
      {cur ? (
        <div style={{ ...ST.muted(), fontSize: 11.5, lineHeight: 1.5 }}>
          {caps} · {cur.ready ? "已配置" : "未配置凭据 → 在下方「引擎配置」里填写"}
        </div>
      ) : null}
    </div>
  );
}

// ②-a 云引擎参数表单（字段由后端 fields 元信息驱动；留空 = 不修改）
function CloudProviderForm(o: {
  prov: AsrProvView; draft: Record<string, string>; setDraft: (k: string, v: string) => void;
  onSave: () => void; onTest: () => void; onRefresh: () => void;
  saving: boolean; testing: boolean; loading?: boolean; test: AsrTestResult;
}) {
  const { prov, draft, setDraft, onSave, onTest, onRefresh, saving, testing, loading, test } = o;
  return (
    <div style={ST.section()}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{prov.label} · 参数</div>
      {prov.fields.length === 0 ? <span style={ST.muted()}>该引擎无需参数</span> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {prov.fields.map((f) => {
            const cur = prov.params[f.key];
            const ph = f.placeholder || (f.secret && cur?.configured ? `已保存（…${cur.tail || ""}）· 留空不改` : "");
            const val = draft[f.key] ?? (f.secret ? "" : (cur?.value ?? ""));
            return (
              <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...ST.muted(), width: 130, flexShrink: 0, fontSize: 12 }}>{f.label}</span>
                <input
                  type={f.secret ? "password" : "text"}
                  value={val}
                  placeholder={ph}
                  spellCheck={false}
                  onChange={(e) => setDraft(f.key, e.target.value)}
                  style={{ ...ST.input(), flex: 1, padding: "5px 8px", fontSize: 12.5 }}
                />
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button disabled={saving} onClick={onSave} style={ST.btn(ST.btnPrimary())}>{saving ? "保存中…" : "保存"}</button>
        <button disabled={testing} onClick={onTest} style={ST.btn()}>{testing ? "测试中…" : "测试连接"}</button>
        <button disabled={loading} onClick={onRefresh} style={ST.btn()} title="刷新整面板（配置/用量）">
          {loading ? "刷新中…" : "⟳ 刷新"}
        </button>
      </div>
      {test ? (
        <div style={{ fontSize: 12, lineHeight: 1.6, color: test.ok ? "var(--accent,#2563eb)" : "var(--color-danger,#dc2626)" }}>
          {test.ok
            ? `连通（${test.ms ?? "?"}ms）${test.text ? ` · 识别到：${test.text}` : ""}${test.note ? ` · ${test.note}` : ""}`
            : `${test.error || "失败"}${test.ms !== undefined ? `（${test.ms}ms）` : ""}${test.hint ? ` · ${test.hint}` : ""}`}
        </div>
      ) : (
        <div style={{ ...ST.muted(), fontSize: 11.5 }}>测试＝服务端发 1s 静音音频走一遍当前引擎，不录音也能验证 key 与网络。</div>
      )}
    </div>
  );
}

// ②-b builtin 引擎卡（8767 状态 / 模型 / 启停）
function BuiltinEngineCard(o: {
  info: Record<string, unknown>; feats: Record<string, unknown>;
  ctlBusy?: boolean; loading?: boolean;
  onControl: (a: "start" | "stop" | "restart") => void; onRefresh: () => void;
  setFeature: (fid: string, enabled?: boolean, value?: string) => void;
}) {
  const { info, feats, ctlBusy, loading, onControl, onRefresh, setFeature } = o;
  const f = feats as { asrModelStream?: string; asrModelOffline?: string };
  const running = info.running === true || info.ok === true;
  return (
    <div style={ST.section()}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>自建服务（127.0.0.1:8767）</div>
      <div style={ST.row()}>
        <span style={ST.muted()}>状态</span>
        <span>{info && Object.keys(info).length === 0 ? "未连接" : running ? ((info.stream_loaded === true && info.quick_loaded !== false) ? "运行中" : "启动中") : "未运行"}</span>
      </div>
      <div style={ST.row()}>
        <span style={ST.muted()}>实时引擎</span>
        <select value={f.asrModelStream || "iic/SenseVoiceSmall"}
          onChange={(e) => setFeature("asr.model.stream", undefined, e.target.value)}
          style={{ ...ST.input(), maxWidth: 230, padding: "3px 8px", fontSize: 12.5 }}>
          <option value="iic/SenseVoiceSmall">SenseVoice-Small（默认·伪实时 VAD 切句秒出）</option>
          <option value="Qwen/Qwen3-ASR-0.6B">Qwen3-ASR-0.6B（直出·0.6B 同款·带热词·停顿 1.4s 出句）</option>
          <option value="paraformer-zh-streaming">paraformer-zh-streaming（老 chunk 流式·质量差）</option>
        </select>
        <span style={{ fontSize: 11, color: "var(--accent,#2563eb)" }}>{f.asrModelStream !== "paraformer-zh-streaming" ? "伪实时" : "WS"}</span>
      </div>
      <div style={ST.row()}>
        <span style={ST.muted()}>当前生效</span>
        <span style={{ fontSize: 11.5, wordBreak: "break-all", textAlign: "right" }}>
          {info.stream_model || f.asrModelStream || "iic/SenseVoiceSmall"}（{info.stream_loaded ? "已加载" : "加载中/待拉"}）
        </span>
      </div>
      <div style={ST.row()}>
        <span style={ST.muted()}>2-pass 精修</span>
        <select value={f.asrModelOffline || "Qwen/Qwen3-ASR-0.6B"}
          onChange={(e) => setFeature("asr.model.offline", undefined, e.target.value)}
          style={{ ...ST.input(), maxWidth: 230, padding: "3px 8px", fontSize: 12.5 }}>
          <option value="Qwen/Qwen3-ASR-0.6B">Qwen3-ASR-0.6B（52语种·context热词）</option>
          <option value="Qwen/Qwen3-ASR-1.7B">Qwen3-ASR-1.7B（更强·同 context 热词）</option>
          <option value="zai-org/GLM-ASR-Nano-2512">GLM-ASR-Nano（1.5B·官方热词句式·中文强）</option>
          <option value="FunAudioLLM/Fun-ASR-Nano-2512">Fun-ASR-Nano（中英日·方言·术语合成好·hotword）</option>
          <option value="openai/whisper-large-v3">Whisper large-v3（99语言·国外兜底·无热词）</option>
          <option value="nvidia/parakeet-tdt-0.6b-v3">parakeet-tdt-0.6b-v3（25欧语·英文极准·中文不行）</option>
          <option value="iic/SenseVoiceSmall">SenseVoice-Small（极速 17x·纯中文快但英文术语差·无热词）</option>
          <option value="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch">seaco paraformer（旧·无标点）</option>
        </select>
        <span style={{ fontSize: 11, color: "var(--accent,#2563eb)" }}>{info.offline_loaded ? "✓" : "…"}</span>
      </div>
      <div style={ST.row()}>
        <span style={ST.muted()}>当前生效</span>
        <span style={{ fontSize: 11.5, wordBreak: "break-all", textAlign: "right" }}>
          {info.offline_model || f.asrModelOffline || "Qwen/Qwen3-ASR-0.6B"}（{info.offline_loaded ? "已加载" : "子进程/待拉"}）
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button disabled={ctlBusy} onClick={() => onControl("start")} style={ST.btn(ST.btnPrimary())}>▶ 启动</button>
        <button disabled={ctlBusy} onClick={() => onControl("stop")} style={ST.btn(ST.btnDanger())}>停止</button>
        <button disabled={ctlBusy} onClick={() => onControl("restart")} style={ST.btn()}>⟳ 重启</button>
        <button disabled={loading} onClick={onRefresh} style={ST.btn()} title="刷新整面板（状态/配置/用量/热词）">
          {loading ? "刷新中…" : "⟳ 刷新"}
        </button>
      </div>
    </div>
  );
}

// ②-c 热词统计（仅自建引擎：模型级偏置；云引擎不生效）
function HotwordsCard(o: {
  feats: Record<string, unknown>; info: Record<string, unknown>;
  eff?: { count: number; words: string[] };
  editing: string | null; setEditing: (v: string | null) => void;
  draftCount: string; setDraftCount: (v: string) => void;
  setFeature: (fid: string, enabled?: boolean, value?: string) => void;
  showEff: boolean; setShowEff: (v: boolean) => void; copyEff: () => void;
  supported: boolean;
}) {
  const { feats, info, eff, editing, setEditing, draftCount, setDraftCount, setFeature, showEff, setShowEff, copyEff, supported } = o;
  const f = feats as { asrHotwordsCount?: number; asrHotwordsIncludeUser?: boolean; asrHotwordsIncludeAi?: boolean };
  return (
    <div style={ST.section()}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>热词（仅自建引擎生效）</div>
      {!supported ? (
        <div style={{ ...ST.muted(), fontSize: 12 }}>当前引擎不支持热词偏置（AI 修复层仍照常工作）</div>
      ) : (
        <>
          <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
            fid="asr.hotwords.count" label="提取数量（每档）"
            display={<>{f.asrHotwordsCount ?? 100} · 4 档 · 去重合并</>}
            editor={<>
              <input type="number" min={0} max={500} value={draftCount} onChange={(e) => setDraftCount(e.target.value)}
                style={{ ...ST.input(), width: 70, padding: "3px 8px", fontSize: 12.5 }} />
              <button onClick={() => setFeature("asr.hotwords.count", undefined, String(Math.max(0, Math.min(500, parseInt(draftCount, 10) || 0))))} style={ST.btn(ST.btnPrimary())}>保存</button>
              <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
            </>}
          />
          <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
            fid="asr.hotwords.includeUser" label="提取包含 · 用户输入"
            display={<>{f.asrHotwordsIncludeUser !== false ? "开" : "关"}</>}
            editor={<>
              <button onClick={() => setFeature("asr.hotwords.includeUser", f.asrHotwordsIncludeUser !== false ? false : true)} style={ST.btn(ST.btnPrimary())}>{f.asrHotwordsIncludeUser !== false ? "关闭" : "开启"}</button>
              <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
            </>}
          />
          <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
            fid="asr.hotwords.includeAi" label="提取包含 · AI 输入"
            display={<>{f.asrHotwordsIncludeAi !== false ? "开" : "关"}</>}
            editor={<>
              <button onClick={() => setFeature("asr.hotwords.includeAi", f.asrHotwordsIncludeAi !== false ? false : true)} style={ST.btn(ST.btnPrimary())}>{f.asrHotwordsIncludeAi !== false ? "关闭" : "开启"}</button>
              <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
            </>}
          />
          <div style={ST.row()}>
            <span style={ST.muted()}>最终生效（当前 workspace，含用户词）</span>
            <span>{eff ? (eff.count > 0 ? `${eff.count} 个` : "0（未推送）") : "—"}</span>
          </div>
          <div style={ST.row()}><span style={ST.muted()}>服务端总计（全部 workspace 之和）</span><span>{Number(info.hotwords ?? 0)} · {Number(info.hotwordWorkspaces ?? 0)} 个 workspace</span></div>
          {eff && eff.count > 0 ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => setShowEff(!showEff)} style={{ ...ST.btn(), padding: "3px 10px", fontSize: 12 }}>{showEff ? "▾ 收起" : "▸ 查看详情"}</button>
              <button onClick={copyEff} style={{ ...ST.btn(), padding: "3px 10px", fontSize: 12 }}>复制</button>
            </div>
          ) : null}
          {showEff && eff ? (
            <div style={{ maxHeight: 150, overflow: "auto", borderRadius: 8, padding: "8px 10px", fontSize: 12, lineHeight: 1.8, color: "var(--text-muted,#767676)", border: "1px solid var(--border,#e0e0e0)", wordBreak: "break-all", background: "var(--bg,#fff)" }}>
              {eff.words.map((w, i) => <span key={i} style={{ marginRight: 6, whiteSpace: "nowrap" }}>{w}</span>)}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ②-d 用户热词（与自动收取词合并，用户词优先）
function UserHotwordsCard(o: {
  words: string; onWords: (v: string) => void; onSave: () => void; onExport: () => void;
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void; supported: boolean;
}) {
  const { words, onWords, onSave, onExport, onImport, supported } = o;
  return (
    <div style={ST.section()}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>用户热词{supported ? "" : "（当前引擎不生效）"}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ ...ST.muted(), fontSize: 12 }}>空格分隔；与自动收取词合并，用户词最优先</div>
        <textarea value={words} onChange={(e) => onWords(e.target.value)}
          placeholder={"例如：aiti-devtools 开放时间 hotword"} spellCheck={false} style={{ ...ST.input(), height: 70, minHeight: 48 }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={onSave} style={ST.btn(ST.btnPrimary())}>保存</button>
          <button onClick={onExport} style={ST.btn()}>导出</button>
          <label style={{ ...ST.btn(), cursor: "pointer" }}>⬆ 导入
            <input type="file" accept=".txt,.json,text/plain,application/json" onChange={onImport} style={{ display: "none" }} />
          </label>
        </div>
      </div>
    </div>
  );
}

// ③ 通用配置（与引擎无关：链路开关 + 环境变量）
function CommonFeatCard(o: {
  feats: Record<string, unknown>;
  editing: string | null; setEditing: (v: string | null) => void; setDraftCount: (v: string) => void;
  setFeature: (fid: string, enabled?: boolean, value?: string) => void;
  onEnv: () => void;
}) {
  const { feats, editing, setEditing, setDraftCount, setFeature, onEnv } = o;
  const [draftNum, setDraftNum] = useState<string>("");   // 数值编辑行草稿（增益/阈值）
  const f = feats as { asrStreaming?: boolean; asrVad?: boolean; asrSplit?: boolean; asrPass2?: boolean };
  return (
    <div style={ST.section()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>通用配置（与引擎无关）</span>
        <button onClick={onEnv} title="ASR 环境变量（config.env：设备/精度/GPU 伪装等；仅自建服务读取）"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted,#767676)", fontSize: 12, lineHeight: 1, padding: "2px 6px" }}>环境变量</button>
      </div>
      <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
        fid="asr.streaming" label="实时流式识别（🎤 主链路）"
        display={<>{f.asrStreaming !== false ? "开" : "关"}</>}
        editor={<>
          <button onClick={() => setFeature("asr.streaming", f.asrStreaming !== false ? false : true)} style={ST.btn(ST.btnPrimary())}>{f.asrStreaming !== false ? "关闭" : "开启"}</button>
          <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
        </>}
      />
      <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
        fid="asr.vad" label="VAD 自动断句（停顿自动切句）"
        display={<>{f.asrVad !== false ? "开" : "关"}</>}
        editor={<>
          <button onClick={() => setFeature("asr.vad", f.asrVad !== false ? false : true)} style={ST.btn(ST.btnPrimary())}>{f.asrVad !== false ? "关闭" : "开启"}</button>
          <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
        </>}
      />
      <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
        fid="asr.split" label="伪实时分句（停顿即出句，逐句上屏）"
        display={<>{f.asrSplit !== false ? "开" : "关"}</>}
        editor={<>
          <button onClick={() => setFeature("asr.split", f.asrSplit !== false ? false : true)} style={ST.btn(ST.btnPrimary())}>{f.asrSplit !== false ? "关闭" : "开启"}</button>
          <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
        </>}
      />
      <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
        fid="asr.inputGain" label="麦克风输入增益（倍）"
        display={<>{String((feats as { asrInputGain?: unknown }).asrInputGain ?? "1")}×</>}
        editor={<>
          <input type="number" min={1} max={8} step={1}
            defaultValue={String((feats as { asrInputGain?: unknown }).asrInputGain ?? "1")}
            onChange={(e) => setDraftNum(e.target.value)}
            style={{ ...ST.input(), width: 70, padding: "3px 8px", fontSize: 12.5 }} />
          <button onClick={() => setFeature("asr.inputGain", undefined, String(Math.min(8, Math.max(1, parseInt(draftNum, 10) || 1))))} style={ST.btn(ST.btnPrimary())}>保存</button>
          <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
        </>}
      />
      <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
        fid="asr.vad.rms" label="静音判定阈值（RMS·越小越灵敏）"
        display={<>{String((feats as { asrVadRms?: unknown }).asrVadRms ?? "0.005")}</>}
        editor={<>
          <input type="number" min={0.0005} max={0.1} step={0.001}
            defaultValue={String((feats as { asrVadRms?: unknown }).asrVadRms ?? "0.005")}
            onChange={(e) => setDraftNum(e.target.value)}
            style={{ ...ST.input(), width: 80, padding: "3px 8px", fontSize: 12.5 }} />
          <button onClick={() => setFeature("asr.vad.rms", undefined, String(Math.min(0.1, Math.max(0.0005, parseFloat(draftNum) || 0.005))))} style={ST.btn(ST.btnPrimary())}>保存</button>
          <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
        </>}
      />
      <FeatRow editing={editing} feats={feats} setEditing={setEditing} setDraftCount={setDraftCount}
        fid="asr.pass2" label="二次识别精修（2-pass，仅支持该能力的引擎生效）"
        display={<>{f.asrPass2 !== false ? "开" : "关"}</>}
        editor={<>
          <button onClick={() => setFeature("asr.pass2", f.asrPass2 !== false ? false : true)} style={ST.btn(ST.btnPrimary())}>{f.asrPass2 !== false ? "关闭" : "开启"}</button>
          <button onClick={() => setEditing(null)} style={ST.btn()}>✕</button>
        </>}
      />
    </div>
  );
}

// ②-e 用量统计（云引擎计费口径：按天 请求数 / 音频时长 / 错误数 + 可选单价估算费用）
function UsageCard(o: {
  usage: AsrUsageView | null; labels: Record<string, string>;
  onReset: () => void; onSetPrice: (provider: string, value: string) => void; onReport: () => void;
}) {
  const { usage, labels, onReset, onSetPrice, onReport } = o;
  const rows = Object.keys(usage?.totals || {});
  const mins = (r?: AsrUsageRow) => ((r?.seconds || 0) / 60);
  const yuan = (r: AsrUsageRow | undefined, price?: number) => (price ? mins(r) * price : undefined);
  const fmt = (v?: number) => (v === undefined ? "—" : `¥${v.toFixed(2)}`);
  return (
    <div style={ST.section()}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>用量统计（云引擎计费口径）</div>
      {rows.length === 0 ? (
        <span style={ST.muted()}>还没有识别请求</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((pid) => {
            const t = usage?.totals?.[pid];
            const d = usage?.todayRows?.[pid];
            const price = usage?.price?.[pid];
            const last = usage?.lastAt?.[pid];
            return (
              <div key={pid} style={{ display: "flex", flexDirection: "column", gap: 3, paddingBottom: 6, borderBottom: "1px dashed var(--border,#e0e0e0)" }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{labels[pid] || pid}</div>
                <div style={{ ...ST.muted(), fontSize: 11.5 }}>
                  今日 {d?.requests ?? 0} 次 · {mins(d).toFixed(1)} 分钟
                  {" ｜ 累计 "}{t?.requests ?? 0} 次 · {mins(t).toFixed(1)} 分钟
                  {" ｜ 错误 "}{t?.errors ?? 0}
                  {last ? ` ｜ 最近 ${new Date(last).toLocaleString()}` : ""}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                  <span style={ST.muted()}>单价 元/分钟</span>
                  <input defaultValue={price ? String(price) : ""} placeholder="0" spellCheck={false}
                    onBlur={(e) => onSetPrice(pid, e.target.value)}
                    style={{ ...ST.input(), width: 70, padding: "2px 6px", fontSize: 11.5 }} />
                  <span style={ST.muted()}>今日 {fmt(yuan(d, price))} · 累计 {fmt(yuan(t, price))}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onReport} style={ST.btn(ST.btnPrimary())}>详细报表</button>
        <button onClick={onReset} style={ST.btn()}>清空用量</button>
        <span style={{ ...ST.muted(), fontSize: 11 }}>时长按 16k/16bit 估算；真流式会话结束计 1 次</span>
      </div>
    </div>
  );
}

function renderAsrPanel(face?: string) {
  const st0 = usePresent(ASR_KEY);
  // 头行按钮状态（内容上报）；hook 必须在早退之前调用（hook 顺序稳定）
  const hs = useDockHeaderStateOf(ASR_KEY);
  // 三面（v4 + 本批 P1）：float=浮窗 / right=右栏 tab / left=左栏区块（sidebar 族任意落位）
  const open = face === "float" ? st0 === "floating"
    : face === "right" ? st0 === "docked:right-panel"
    : isSidebarDockState(st0);
  const floating = face === "float";
  // 只有左栏区块面把刷新上提 dock 头（右栏 tab 无头行 → 内容保留自己的刷新按钮）
  const dockKey: string | undefined = face === "left" ? ASR_KEY : undefined;
  const dockHoist = face === "left";
  const setOpen = (v: boolean) => asrOpenSet(v);
  const [envOpen, setEnvOpen] = useState(false);   // ASR 环境变量子弹窗
  const [st, setSt] = useState<{ feature?: Record<string, unknown>; info?: Record<string, unknown>; cfg?: AsrCfgView; usage?: AsrUsageView; user?: string[]; eff?: { count: number; words: string[] }; ctlBusy?: boolean; loading?: boolean; msg?: string }>({ loading: true });
  const [words, setWords] = useState<string>("");
  const [showEff, setShowEff] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});       // 引擎参数草稿（field key → 值）
  const [cfgBusy, setCfgBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AsrTestResult>(null);
  const wordsDirty = useRef(false);   // 用户已编辑用户词草稿（refresh 不覆盖）
  const refreshSeq = useRef(0);       // 竞态 guard：晚返回的旧响应作废
  const api = (p: string) => { const f = (apiUrl as (s: string) => string); return typeof f === "function" ? f(p) : p; };

  const refresh = async () => {
    const seq = ++refreshSeq.current;
    setSt((s) => ({ ...s, loading: true }));
    try {
      // 当前 workspace cwd（弹窗与语音同源：AC.extra.cwd；无则本行显示 —）
      const cwd = AC.extra && typeof (AC.extra as any).cwd === "string" ? (AC.extra as any).cwd : "";
      const effP = cwd
        ? fetch(api("/api/extensions/aiti-ai-input/asr/effective-hotwords"), { headers: { "x-aiti-cwd": cwd } }).then((r) => r.json().catch(() => null)).catch(() => null)
        : Promise.resolve(null);
      const [f1, f2, f3, f4, f5, f6] = await Promise.all([
        fetch(api("/api/extensions/aiti-ai-input/features")).then((r) => r.json()).catch(() => null),
        fetch(api("/api/extensions/aiti-ai-input/asr/info")).then((r) => r.json().catch(() => null)).catch(() => null),
        fetch(api("/api/extensions/aiti-ai-input/asr/user-hotwords")).then((r) => r.json()).catch(() => null),
        effP,
        fetch(api("/api/extensions/aiti-ai-input/asr/config")).then((r) => r.json().catch(() => null)).catch(() => null),
        fetch(api("/api/extensions/aiti-ai-input/asr/usage")).then((r) => r.json().catch(() => null)).catch(() => null),
      ]);
      if (seq !== refreshSeq.current) return; // 旧响应作废（后发刷新优先）
      const user = Array.isArray(f3?.words) ? f3.words as string[] : [];
      // 草稿保护：用户编辑过则不覆盖 textarea（仅更新计数/状态）
      if (!wordsDirty.current) setWords(user.join(" "));
      infoRef.current = (f2 || null) as Record<string, unknown> | null; // 同步最新 info 供轮询判断
      setSt({ feature: f1 || {}, info: f2 || null, cfg: (f5?.ok ? f5 : null) as AsrCfgView | null, usage: (f6 || null) as AsrUsageView | null, user, eff: f4 && typeof f4.count === "number" ? f4 : undefined, loading: false });
    } catch { if (seq === refreshSeq.current) setSt({ loading: false }); }
  };
  // dock 头工具条 v3：命令实现（刷新）+ 状态上报（loading）
  useDockCommands(dockKey, dockKey ? { refresh: () => { void refresh(); } } : null);
  useDockHeaderState(dockKey, dockKey ? { loading: st.loading === true } : null);

  // 最新 info 的 ref（轮询定时器闭包里读，避免读旧 state）
  const infoRef = useRef<Record<string, unknown> | null>(null);
  useEffect(() => { if (open) void refresh(); }, [open]);

  // ---- 引擎切换 / 参数保存 / 连通测试（POST /asr/config、POST /asr/test）----
  const postCfg = async (body: Record<string, unknown>, okMsg: string) => {
    setCfgBusy(true);
    try {
      const r = await fetch(api("/api/extensions/aiti-ai-input/asr/config"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (!d?.ok) { setSt((x) => ({ ...x, msg: d?.error || "保存失败" })); return false; }
      setSt((x) => ({ ...x, msg: okMsg }));
      window.setTimeout(() => setSt((x) => ({ ...x, msg: undefined })), 2500);
      setDraft({});
      setTest(null);
      void refresh();
      return true;
    } catch { setSt((x) => ({ ...x, msg: "保存失败" })); return false; }
    finally { setCfgBusy(false); }
  };
  const onPickProvider = (id: string) => { void postCfg({ provider: id }, `已切换引擎：${id}（下次按 🎤 生效）`); };
  const onSaveProvider = () => {
    const pid = st.cfg?.provider;
    if (!pid) return;
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft)) if (String(v).trim()) patch[k] = String(v).trim();
    if (!Object.keys(patch).length) { setSt((x) => ({ ...x, msg: "没有要保存的改动" })); window.setTimeout(() => setSt((x) => ({ ...x, msg: undefined })), 2000); return; }
    void postCfg({ providers: { [pid]: patch } }, "已保存 · 即时生效");
  };
  const onTestProvider = async () => {
    setTesting(true);
    try {
      const r = await fetch(api("/api/extensions/aiti-ai-input/asr/test"), { method: "POST" });
      const d = await r.json().catch(() => null);
      setTest(d && typeof d === "object" ? d as AsrTestResult : { ok: false, error: "测试失败" });
    } catch { setTest({ ok: false, error: "测试请求失败" }); }
    finally { setTesting(false); }
  };

  const onUsageReset = async () => {
    const r = await fetch(api("/api/extensions/aiti-ai-input/asr/usage"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reset" }),
    });
    const d = await r.json().catch(() => null);
    setSt((x) => ({ ...x, usage: d || null, msg: "用量已清空" }));
    window.setTimeout(() => setSt((x) => ({ ...x, msg: undefined })), 2000);
  };
  const onUsagePrice = async (provider: string, value: string) => {
    const n = Number(String(value).trim());
    await fetch(api("/api/extensions/aiti-ai-input/asr/usage"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ price: { [provider]: Number.isFinite(n) && n >= 0 ? n : 0 } }),
    }).catch(() => null);
    void refresh();
  };

  const onControl = async (action: "start" | "stop" | "restart") => {
    setSt((s) => ({ ...s, ctlBusy: true }));
    try {
      const r = await fetch(api("/api/extensions/aiti-ai-input/asr/control"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await r.json().catch(() => null);
      setSt((s) => ({ ...s, msg: action === "start" ? `已启动（session ${d?.sessionId || "?"}）` : action === "stop" ? "已停止（下次语音输入可自动拉起）" : `已重启（session ${d?.sessionId || "?"}）`, ctlBusy: false }));
      window.setTimeout(() => setSt((s) => ({ ...s, msg: undefined })), 3000);
      void refresh();
      // 启动/重启后轮询刷新，直到模型加载完成（启动中 → 运行中）；就绪或超时即停
      if (action === "start" || action === "restart") startPolling();
      if (action === "stop") stopPolling();
    } catch { setSt((s) => ({ ...s, msg: "操作失败", ctlBusy: false })); }
  };

  // 轮询刷新：每 2s 拉 /asr/info，直到 stream+quick 就绪（offline 子进程模式除外）或超时 90s
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startPolling = () => {
    stopPolling();
    const startedAt = Date.now();
    pollRef.current = setInterval(() => {
      void refresh();
      // 若已就绪或超时，停止轮询
      if (Date.now() - startedAt > 90000 || modelReadyNow()) stopPolling();
    }, 2000);
  };
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  // 判断当前是否模型全部就绪（读 infoRef 最新值，避免闭包旧 st）
  const modelReadyNow = () => {
    const i = infoRef.current || {};
    // GLM/Whisper 等子进程模型 offline_loaded 恒 false——就绪只看 stream+quick
    return i.stream_loaded === true && i.quick_loaded !== false;
  };
  // 组件卸载/关闭时清理轮询
  useEffect(() => () => stopPolling(), []);

  // ---- feature 行级编辑（默认展示；点 ✎ 切换编辑态）----
  const [editing, setEditing] = useState<string | null>(null);   // 正在编辑的 featureId
  const [draftCount, setDraftCount] = useState<string>("");
  const setFeature = async (featureId: string, enabled?: boolean, value?: string) => {
    try {
      const cwdS = AC.extra && typeof (AC.extra as any).cwd === "string" ? (AC.extra as any).cwd : "";
      const r = await fetch(api("/api/extensions/aiti-ai-input/asr/set-feature"), {
        method: "POST", headers: { "content-type": "application/json", ...(cwdS ? { "x-aiti-cwd": cwdS } : {}) },
        body: JSON.stringify({ featureId, ...(enabled !== undefined ? { enabled } : {}), ...(value !== undefined ? { value } : {}) }),
      });
      const d = await r.json().catch(() => null);
      if (!d?.ok) { setSt((x) => ({ ...x, msg: "设置失败" })); return; }
      setEditing(null);
      setSt((x) => ({ ...x, msg: featureId.startsWith("asr.hotwords.") ? "已保存 · 热词重新提取中…" : "已保存" }));
      window.setTimeout(() => setSt((x) => ({ ...x, msg: undefined })), 2500);
      void refresh();
      // 热词 feature 变更：服务端异步重拉重推（jieba 提取可能数秒）→ 延迟二次刷新让「最终生效」计数更新
      if (featureId.startsWith("asr.hotwords.") || featureId.startsWith("asr.model.")) {
        setTimeout(() => void refresh(), 2500);
      }
    } catch { setSt((x) => ({ ...x, msg: "设置失败" })); }
  };
  // 复制全部生效热词（空格分隔——与详情展示一致；编辑框同样支持空格粘贴）
  const copyEff = async () => {
    if (!st.eff || !st.eff.words.length) return;
    const text = st.eff.words.join(" ");
    try {
      await navigator.clipboard.writeText(text);
      setSt((x) => ({ ...x, msg: `已复制 ${st.eff!.count} 个热词` }));
      window.setTimeout(() => setSt((x) => ({ ...x, msg: undefined })), 2000);
    } catch {
      // 降级：隐藏 textarea 选中复制
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove();
        setSt((x) => ({ ...x, msg: `已复制 ${st.eff!.count} 个热词` }));
        window.setTimeout(() => setSt((x) => ({ ...x, msg: undefined })), 2000);
      } catch { setSt((x) => ({ ...x, msg: "复制失败" })); }
    }
  };

  // 导入：txt（每行一词）/ json（字符串数组）
  const onImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => {
      let parsed: string[] = [];
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j)) parsed = j.map(String);
      } catch { /* 非 JSON → 按行 */ }
      if (!parsed.length) parsed = t.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
      setWords(parsed.join("\n"));
    }).catch(() => {});
    e.target.value = "";
  };
  const onExport = () => {
    const blob = new Blob([words], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "aiti-hotwords.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const onSave = async () => {
    const parsed = words.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean); // 空格/换行/逗号均可分隔
    try {
      const cwdS = AC.extra && typeof (AC.extra as any).cwd === "string" ? (AC.extra as any).cwd : "";
      const r = await fetch(api("/api/extensions/aiti-ai-input/asr/user-hotwords"), {
        method: "PUT", headers: { "content-type": "application/json", ...(cwdS ? { "x-aiti-cwd": cwdS } : {}) },
        body: JSON.stringify({ words: parsed }),
      });
      const d = await r.json();
      wordsDirty.current = false; // 已并轨服务器快照
      setSt((s) => ({ ...s, user: d?.words || parsed, msg: `已保存 ${(d?.count ?? parsed.length)} 个用户热词（与自动收取词合并，用户词优先）` }));
      window.setTimeout(() => setSt((s) => ({ ...s, msg: undefined })), 3000);
    } catch { setSt((s) => ({ ...s, msg: "保存失败" })); }
  };

  if (!open) return null;
  const headEl = (
    <div style={ST.head()}>
      {floating && <b style={{ fontSize: 14 }}>语音识别引擎管理</b>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: floating ? undefined : "auto" }}>
        {floating && (
          <button onClick={() => setOpen(false)} title="关闭"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted,#767676)", fontSize: 15, lineHeight: 1 }}>✕</button>
        )}
      </div>
    </div>
  );
  const feats = (st.feature || {}) as Record<string, unknown>;
  const info: Record<string, unknown> = st.info || {};
  const cfg = st.cfg || null;
  const curProv = cfg?.providers.find((p) => p.id === cfg.provider) || null;
  const builtin = !cfg || cfg.provider === "builtin";
  const hotwordsOn = !!curProv?.capabilities.hotwords;
  const asrContent = (
    <>
      {headEl}
      <div style={ST.body()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* 刷新已下沉到「引擎配置」区块的按钮行（顶部 ⟳ 看着像自建专属，实为整面板刷新） */}
          {st.msg ? <span style={{ fontSize: 12, color: "var(--accent,#2563eb)" }}>{st.msg}</span> : null}
        </div>

        {/* ① 引擎切换 */}
        <ProviderCards cfg={cfg} onPick={onPickProvider} busy={cfgBusy} />

        {/* ② 当前引擎配置 */}
        {builtin ? (
          <>
            <BuiltinEngineCard info={info} feats={feats} ctlBusy={st.ctlBusy} loading={st.loading}
              onControl={(a) => void onControl(a)} onRefresh={() => void refresh()}
              setFeature={(fid, en, v) => void setFeature(fid, en, v)} />
            <HotwordsCard feats={feats} info={info} eff={st.eff} editing={editing} setEditing={setEditing}
              draftCount={draftCount} setDraftCount={setDraftCount}
              setFeature={(fid, en, v) => void setFeature(fid, en, v)}
              showEff={showEff} setShowEff={setShowEff} copyEff={() => void copyEff()} supported={hotwordsOn} />
            <UserHotwordsCard words={words} onWords={(v) => { wordsDirty.current = true; setWords(v); }}
              onSave={() => void onSave()} onExport={onExport} onImport={onImport} supported={hotwordsOn} />
          </>
        ) : curProv ? (
          <CloudProviderForm prov={curProv} draft={draft} setDraft={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
            onSave={onSaveProvider} onTest={() => void onTestProvider()} onRefresh={() => void refresh()}
            saving={cfgBusy} testing={testing} loading={st.loading} test={test} />
        ) : null}

        {/* ②-e 用量统计 */}
        <UsageCard usage={st.usage || null} labels={Object.fromEntries((cfg?.providers || []).map((p) => [p.id, p.label]))}
          onReset={() => void onUsageReset()} onSetPrice={(pid, v) => void onUsagePrice(pid, v)}
          onReport={() => usageOpenSet(true)} />

        {/* ③ 通用配置（与引擎无关） */}
        <CommonFeatCard feats={feats} editing={editing} setEditing={setEditing} setDraftCount={setDraftCount}
          setFeature={(fid, en, v) => void setFeature(fid, en, v)} onEnv={() => setEnvOpen(true)} />
      </div>
      {envOpen ? <AsrEnvSlot onClose={() => setEnvOpen(false)} /> : null}
    </>
  );
  // dock v3 分面：float = 浮窗壳（float 契约）；left = 左栏 DockSection
  if (floating) {
    return (
      <div style={ST.panel({})} data-ext-float="1" data-ext-float-key={ASR_KEY} data-ext-float-dock={`${sidebarZoneOf(ASR_KEY)} right-panel`} data-ext-float-dock-default={sidebarZoneOf(ASR_KEY)} data-ext-float-w="440" data-ext-float-full="1" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="语音识别引擎管理">
        {asrContent}
      </div>
    );
  }
  const asrInner = (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontSize: 13 }}>
      {asrContent}
    </div>
  );
  const asrZones: any[] = [sidebarZoneOf(ASR_KEY), "right-panel"];
  // 右栏 tab face（chrome="tab"：无头行，✕/⇱ 在宿主 TabBar）
  if (face === "right") {
    return (
      <DockBody itemKey={ASR_KEY} zone="right-panel" title="语音识别引擎" chrome="tab"
        zones={asrZones} defaultZone={sidebarZoneOf(ASR_KEY)}>{asrInner}</DockBody>
    );
  }
  // 左栏区块 face：统一头行（标题 + 业务按钮 + ⇱ detach + ⋮）；zone 用规范值 sidebar:<key>
  const actions: DockHeaderAction[] = [
    { id: "refresh", title: "刷新", icon: <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>, disabled: hs.loading === true, visibility: "always", onClick: () => { requestDockCommand(ASR_KEY, "refresh"); } },
  ];
  return (
    <DockBody itemKey={ASR_KEY} title="语音识别引擎" chrome="section" kind="dockable"
      zones={asrZones} defaultZone={sidebarZoneOf(ASR_KEY)}
      headerActions={actions}>
      {asrInner}
    </DockBody>
  );
}

// ==================== ASR 环境变量管理子弹窗（config.env 编辑；aiti-float 契约） ====================
// 预制常用项（默认不选；选中即新增一行，值可改）
const ENV_PRESETS: Array<{ key: string; label: string; value: string }> = [
  { key: "HSA_OVERRIDE_GFX_VERSION", label: "HSA_OVERRIDE_GFX_VERSION（AMD gfx 伪装）", value: "11.0.0" },
  { key: "AITI_ASR_DEVICE", label: "AITI_ASR_DEVICE（推理设备）", value: "cuda:0" },
  { key: "AITI_ASR_COMPUTE_DTYPE", label: "AITI_ASR_COMPUTE_DTYPE（精度）", value: "float16" },
  { key: "HIP_VISIBLE_DEVICES", label: "HIP_VISIBLE_DEVICES（多 GPU 选择）", value: "0" },
  { key: "AITI_ASR_SAVE_RECORDINGS", label: "AITI_ASR_SAVE_RECORDINGS（录音落盘，默认关）", value: "1" },
];

function AsrEnvSlot({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const api = (p: string) => { const f = (apiUrl as (s: string) => string); return typeof f === "function" ? f(p) : p; };

  useEffect(() => {
    fetch(api("/api/extensions/aiti-ai-input/asr/env"))
      .then((r) => r.json().catch(() => null))
      .then((d) => {
        const env = (d && typeof d.env === "object" && d.env) || {};
        setRows(Object.entries(env as Record<string, string>).map(([k, v]) => ({ key: k, value: String(v) })));
        setLoading(false);
      })
      .catch(() => { setLoading(false); setMsg("读取失败"); });
  }, []);

  const onPreset = (key: string) => {
    if (!key) return;
    if (key === "custom") {
      setRows((r) => [...r, { key: "", value: "" }]);
      (document.querySelector("[data-env-preset]") as HTMLSelectElement | null)?.blur();
      return;
    }
    const p = ENV_PRESETS.find((x) => x.key === key);
    if (!p) return;
    // 已存在同键 → 保留原行（值可改）；否则新增（值带预制默认）
    setRows((r) => (r.some((x) => x.key === p.key) ? r.map((x) => x.key === p.key ? { ...x, value: x.value || p.value } : x) : [...r, { key: p.key, value: p.value }]));
  };
  const delRow = (i: number) => setRows((r) => r.filter((_, j) => j !== i));
  const setRow = (i: number, patch: Partial<{ key: string; value: string }>) => setRows((r) => r.map((x, j) => j === i ? { ...x, ...patch } : x));

  const onSave = async () => {
    const env: Record<string, string> = {};
    for (const r of rows) {
      const k = r.key.trim();
      if (!k) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { setMsg(`非法键名: ${k}`); return; }
      env[k] = r.value.trim();
    }
    setSaving(true);
    try {
      const res = await fetch(api("/api/extensions/aiti-ai-input/asr/env"), {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ env }),
      });
      const d = await res.json().catch(() => null);
      if (!d?.ok) { setMsg(d?.error || "保存失败"); setSaving(false); return; }
      setRows(Object.entries((d.env || {}) as Record<string, string>).map(([k, v]) => ({ key: k, value: String(v) })));
      setMsg("已保存 · 重启 ASR 服务后生效");
    } catch { setMsg("保存失败"); }
    setSaving(false);
  };

  return (
    <div style={{ ...ST.panel({}), width: 460 }} data-ext-float="1" data-ext-float-w="460" data-ext-float-full="1" data-ext-float-autoh="1" role="dialog" aria-label="ASR 环境变量" onClick={(e) => e.stopPropagation()}>
      <div style={ST.head()}>
        <b style={{ fontSize: 14 }}>ASR 环境变量</b>
        <button onClick={onClose} title="关闭" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted,#767676)", fontSize: 15, lineHeight: 1 }}>✕</button>
      </div>
      <div style={ST.body()}>
        <div style={{ ...ST.muted(), fontSize: 12, lineHeight: 1.5 }}>
          写入 asr-config.json 的 env 对象 · 服务启动时全部灌入进程环境（config 优先）· 默认为空＝不注入任何变量
        </div>
        <select data-env-preset value="" onChange={(e) => onPreset(e.target.value)} disabled={loading}
          style={{ ...ST.input(), width: "auto", padding: "4px 8px", fontSize: 12 } as Record<string, string>}>
          <option value="">＋ 添加常用变量…</option>
          {ENV_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value="custom">自定义（手动输入键名）</option>
        </select>
        {rows.length === 0 ? (
          <div style={{ ...ST.muted(), fontSize: 12, padding: "12px 0", textAlign: "center" }}>{loading ? "读取中…" : "暂无环境变量 · 上方添加"}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} placeholder="KEY" spellCheck={false}
                  style={{ ...ST.input(), width: "42%", padding: "6px 8px", fontSize: 12.5, fontFamily: "monospace" } as Record<string, string>} />
                <input value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" spellCheck={false}
                  style={{ ...ST.input(), flex: 1, padding: "6px 8px", fontSize: 12.5, fontFamily: "monospace" } as Record<string, string>} />
                <button onClick={() => delRow(i)} title="删除" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted,#767676)", fontSize: 13, padding: "2px 4px", lineHeight: 1 }}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => void onSave()} disabled={saving || loading} style={ST.btn(ST.btnPrimary())}>{saving ? "保存中…" : "保存"}</button>
          {msg ? <span style={{ fontSize: 12, color: msg.includes("失败") || msg.includes("非法") ? "var(--color-danger,#dc2626)" : "var(--accent,#2563eb)" }}>{msg}</span> : null}
        </div>
      </div>
    </div>
  );
}
