/**
 * aiti-model-wizard · client 入口（D1 拆包薄壳版，docs/aiti-ext-lazy-loading-plan.md D1）
 *
 * register(ctx) 装配（薄壳 ~15K，启动物理）：
 *   - toolbar 🧙 按钮（新模型徽标 = fetchNewModelsOnce 轻量 API + new-models-changed 事件）
 *   - 点击 → 按需 import 重 chunk（wizard-app ~480K）→ initHeavySlots 自注册
 *     pages×2 / banners / sessionStats + cleanupEdit service → 薄壳打开请求经
 *     shellPendingOpen 桥在 WizardDialog 挂载时消费。
 *
 * 降级说明：无模型 Banner / 新模型 Toast 重 ITS 首载后才可能出现（触发数据在重 chunk 侧；
 * new-models-changed 事件会预热重 chunk 使 Toast 跟上）。
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （拷主 bundle + 全部 hash 分块）
 */
import { useState, useEffect } from "react";
import { __setCtx, getCtx } from "./host-shim";
import { fetchNewModelsOnce, api } from "./wizard-lib";

let heavyPromise: Promise<any> | null = null;
function loadHeavy(): Promise<any> {
  if (!heavyPromise) {
    heavyPromise = import("./wizard-app").then((m: any) => {
      const c = getCtx();
      if (c) m.initHeavySlots(c); // 幂等自注册：pages×2 / banners / sessionStats + cleanupEdit service + 样式
      return m;
    });
  }
  return heavyPromise;
}

/** [会话信息 · 壳条目] 聚合 / 多key 运行状态（D1 薄壳侧直连版）
 *
 * 背景（docs/aiti-ext-lazy-loading-plan.md D1）：sessionStats 完整版条目注册点在重 chunk
 * （wizard-app initHeavySlots），而重 chunk 只随 🧙 点击 / new-models 事件加载——没点过 🧙
 * 的会话里「会话信息」面板永远没有聚合 / 多key 状态。
 *
 * 本壳条目由薄壳启动即注册（零重 chunk 依赖），打开会话信息立即显示服务端 /proxy-status
 * 真实状态（数据源在 pi-models-combo 引擎，不在向导重 chunk）；挂载同时 loadHeavy() 预热
 * 重 chunk → initHeavySlots 注册完整版（同 id 幂等覆盖升级：每槽位统计 / 冷却 / 联动 / 详情弹窗）。
 * 覆盖 = 注册点懒加载已确保成功；重 chunk 加载失败时壳条目自身仍展示汇总，不白屏。 */
function SessionStatsShell(_props: Record<string, unknown>) {
  const [d, setD] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // 注册点懒加载保证：壳挂载（会话信息打开）→ 立即预热重 chunk，让完整版条目尽快覆盖升级
    loadHeavy().catch(() => {});
    let dead = false;
    api("/proxy-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => { if (dead) return; if (x && x.ok) setD(x); else setFailed(true); })
      .catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; };
  }, []);
  const base: any = { fontSize: 11, color: "var(--text-dim,#6b7280)", lineHeight: 1.5 };
  if (failed) return <div style={{ ...base, color: "#dc2626" }}>聚合 / 多 key 运行状态：读取失败（引擎可能未运行）</div>;
  if (!d) return <div style={base}>聚合 / 多 key 运行状态 …</div>;
  // 汇总（简版；完整版覆盖后展示每槽位详情）
  let slots = 0, cooling = 0, fail = 0, sat = 0;
  for (const p of d.status || []) {
    for (const e of p.entries || []) {
      slots++;
      if (e.cooldown) cooling++;
      const st = e.stats || {};
      if ((st.ok || 0) === 0 && (st.err429 || 0) > 0) fail++;
      else if (st.lastStatus === 429 && (st.err429 || 0) > (st.ok || 0) * 3) fail++;
    }
    sat += (p.saturation || []).length;
  }
  const chips: string[] = [];
  if (sat > 0) chips.push(`⛔ 全池限流 ${sat}`);
  if (cooling > 0) chips.push(`🧊 冷却 ${cooling}`);
  if (fail > 0) chips.push(`⛔ 全部429 ${fail}`);
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text,#1a1a1a)", marginBottom: 3 }}>聚合 / 多 key 运行状态</div>
      {d.status.length === 0 ? (
        <div style={base}>
          {d.loaded
            ? "引擎已就绪，当前无多 key / 聚合 provider（给 provider 配 ≥2 个 key 或建聚合组后自动出现）"
            : d.present
              ? "引擎已运行但为旧版本代码——重启 pi-web（或新建会话）后即显示实时状态"
              : "引擎未加载（尚无 agent 会话启动过 pi-models-combo——开始一次对话后自动就绪）"}
        </div>
      ) : (
        <div style={base}>{d.status.length} 代理 · {slots} 槽位{chips.length ? " · " + chips.join(" · ") : ""}</div>
      )}
    </div>
  );
}

/** 薄壳工具条按钮：魔杖 svg + 新模型徽标（数据 = fetchNewModelsOnce 轻量 API + 事件刷新） */
function WizardButtonShell() {
  const [newTotal, setNewTotal] = useState(0);
  useEffect(() => {
    let dead = false;
    const apply = (d: any) => { if (!dead && d && d.ok) setNewTotal(d.total || 0); };
    fetchNewModelsOnce().then(apply);
    const onChanged = () => {
      fetchNewModelsOnce().then(apply);
      loadHeavy().catch(() => {}); // 新模型出现 → 预热重 chunk，让 Toast 跟上
    };
    window.addEventListener("aiti-model-wizard:new-models-changed", onChanged);
    return () => { dead = true; window.removeEventListener("aiti-model-wizard:new-models-changed", onChanged); };
  }, []);
  const open = () => {
    loadHeavy()
      .then((m: any) => m.openWizardFromShell(newTotal ? "status" : undefined))
      .catch(() => {});
  };
  return (
    <button
      title={newTotal ? "aiti-model-wizard：发现 " + newTotal + " 个新模型，点击查看" : "aiti-model-wizard：添加 AI 提供商/模型"}
      onClick={open}
      onMouseEnter={(e: any) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", position: "relative",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      }}
    >
      {/* lucide wand-sparkles：添加向导（魔杖+星星）——与系统内建线条图标同风格 */}
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path key="p1" d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
        <path key="p2" d="m14 7 3 3" />
        <path key="p3" d="M5 6v4" />
        <path key="p4" d="M19 14v4" />
        <path key="p5" d="M10 2v2" />
        <path key="p6" d="M7 8H3" />
        <path key="p7" d="M21 16h-4" />
        <path key="p8" d="M11 3H9" />
      </svg>
      {newTotal > 0 ? (
        <span key="badge" style={{
          position: "absolute", top: 3, right: 4, minWidth: 14, height: 14, padding: "0 3px",
          borderRadius: 999, background: "#dc2626", color: "#fff", fontSize: 9, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none",
          boxShadow: "0 0 0 2px var(--bg,#fff)",
        }}>{newTotal > 99 ? "99+" : String(newTotal)}</span>
      ) : null}
    </button>
  );
}

/** 薄壳「管理模型」行：模型选择器下拉底部动作区（modelSelectorFooter 插槽，薄壳启动即注册）。
 *
 * 范式 = workspacePickerActions（宿主只渲染插槽，管理 UI 全在扩展侧；未注册零渲染零回归）。
 * 宿主 ModelSelector 全部实例（工具条 / ⓘ sheet / AgentsConfig field）一致带此入口，未点过
 * 🧙 也能直达向导。点击 → onClose 收下拉（契约：打开自有浮层前先收）+ 按需加载重 chunk →
 * openWizardFromShell()（与 🧙 工具条按钮同一打开通路，无参 = 默认页）。 */
function ManageModelsRow({ onClose }: { onClose?: () => void }) {
  const open = () => {
    onClose?.();
    loadHeavy().then((m: any) => m.openWizardFromShell()).catch(() => {});
  };
  return (
    <button
      type="button"
      title="aiti-model-wizard：打开模型向导（添加 AI 提供商/模型、聚合与多 key 管理）"
      onClick={open}
      onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", gap: 7, width: "100%", flexShrink: 0,
        padding: "8px 12px", background: "none", border: "none",
        borderTop: "1px solid var(--border)", color: "var(--text-muted)",
        cursor: "pointer", fontSize: 12, textAlign: "left", transition: "background 0.12s, color 0.12s",
      }}
    >
      {/* lucide sliders-horizontal：管理（与刷新行/选项行同风格线图） */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <line x1="21" y1="4" x2="14" y2="4" /><line x1="10" y1="4" x2="3" y2="4" />
        <line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" />
        <line x1="21" y1="20" x2="16" y2="20" /><line x1="12" y1="20" x2="3" y2="20" />
        <line x1="14" y1="2" x2="14" y2="6" /><line x1="8" y1="10" x2="8" y2="14" />
        <line x1="16" y1="18" x2="16" y2="22" />
      </svg>
      管理模型
    </button>
  );
}

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx；重 chunk 经 getCtx 读取）
  __setCtx(ctx);

  ctx.registerItems?.("toolbar", [{ id: "aiti-model-wizard-open", render: WizardButtonShell, meta: { label: "模型向导", icon: "icons/sparkles.svg" } }]);
  // 模型选择器下拉底部动作区：「管理模型」入口（薄壳启动即注册——不依赖重 chunk，
  // 没点过 🧙 的会话也能从任何模型下拉直达向导）。
  ctx.registerItems?.("modelSelectorFooter", [{ id: "aiti-model-wizard-manage", render: ManageModelsRow, meta: { label: "管理模型" } }]);
  // 会话信息插槽条目：薄壳直连版（重 chunk initHeavySlots 注册同 id 完整版幂等覆盖升级）——
  // 没点过 🧙 的会话打开「会话信息」也能看到聚合 / 多key 运行状态。
  ctx.registerItems?.("sessionStats", [{ id: "aiti-model-wizard-multikey-status", render: SessionStatsShell, meta: { label: "聚合 / 多key运行状态" } }]);
  try { console.log("[aiti-model-wizard] 薄壳已挂载（🧙 按钮 + 徽标 + 会话信息聚合/多key状态；向导重 chunk 首次交互按需加载）"); } catch {}
}
