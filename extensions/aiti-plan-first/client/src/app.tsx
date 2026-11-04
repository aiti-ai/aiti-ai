/**
 * aiti-plan-first · client 主组件（JSX + host-shim 渲染）
 *
 * 结构（对齐 git-trace「哑按钮 + dialogs slot」模式）：
 *   - PlanToolbarButton：宿主顶栏标准按钮（36×36 + borderRight + hover 变色），
 *     图标 = 注册的 icon.svg 经 CSS mask（extIconSpan 同款，颜色跟随 currentColor）——不自绘 svg。
 *     职责纯触发：算锚点 → dispatch `aiti-plan-first-dropdown` 事件。
 *   - PlanDropdownSlot（dialogs slot，常驻）：监听事件打开锚定下拉（⋯ 菜单里点击也能弹出，
 *     不随菜单关闭卸载）；持有 status/SSE/视图/动作全部状态。
 */
import { useState, useEffect, useRef, apiUrl, t, getHostCtx, extSvc } from "./host-shim";
import { dedupeFetch } from "../../../_shared/dedupe-fetch";
import { readPendingPlan, writePendingPlan, type PendingPlan } from "./pending-plan";

// ---------- 会话/工具 ----------

const EXT_API = "/api/extensions/aiti-plan-first";
const DROPDOWN_EVENT = "aiti-plan-first-dropdown";
const REFRESH_EVENT = "aiti-plan-first-refresh";
// 终态方案状态 tag（与服务端 plan-core PLAN_FINAL_PHASES 同源）：已实施/已过时不再跟催
const FINAL_PLAN_PHASES = ["方案/已实施", "方案/已过时"];
const isFinalPlanPhase = (phase?: string | null): boolean => !!phase && FINAL_PLAN_PHASES.includes(phase);

// 下拉面板宽度（加宽以容纳更长的方案文档路径；锚点计算统一依赖此常量）
const DD_WIDTH = 560;

// ── 统一会话状态服务（pi-web.session，方案 docs/pi-web-session-state-and-perf-plan.md §4）──
// 唯一「会话已确立」事实源：仅在 phase=active 时使用 canonical sessionId 发会话请求；
// **禁止 URL ?session= 未验证兜底**（会话已删除时打出幻影请求——实测 status?session=死id）。
// 消费范式：判空降级 + onExtServiceChange 等待（旧宿主/懒加载时序防御）。
let SVC_SESSION: { id: string; cwd: string } | null = null;
let sessionSvcInstalled = false;

function applySessionSnapshot(snap: any): void {
  const next = snap && snap.phase === "active" && snap.sessionId
    ? { id: String(snap.sessionId), cwd: String(snap.session?.cwd ?? "") }
    : null;
  const changed = (SVC_SESSION?.id ?? "") !== (next?.id ?? "");
  SVC_SESSION = next;
  // active 确立/切换/失效 → 让各消费面（工具条/下拉）重拉状态
  if (changed) {
    try { (window as any).dispatchEvent(new Event(REFRESH_EVENT)); } catch { /* ignore */ }
  }
}

/** 挂载统一会话服务订阅（entry.tsx 调用一次；服务缺席时静默降级到 props 通道）。 */
export function installSessionService(ctx: Record<string, any>): void {
  if (sessionSvcInstalled) return;
  sessionSvcInstalled = true;
  const attach = (): boolean => {
    const svc = ctx.getExtService?.("pi-web.session");
    if (!svc?.subscribe) return false;
    svc.subscribe(applySessionSnapshot);
    return true;
  };
  if (!attach()) {
    ctx.onExtServiceChange?.((key: string, phase: string) => {
      if (key === "pi-web.session" && phase === "up") attach();
    });
  }
}

let CURRENT_SESSION: { id?: string; cwd?: string; name?: string } | null = null;
function bindSession(props?: any): void {
  const cs = props?.currentSession;
  if (cs && (cs.id || cs.cwd || cs.name)) CURRENT_SESSION = { id: cs.id, cwd: cs.cwd, name: cs.name };
}

// ── 新建会话 cwd（宿主 toolbar/dialogs 插槽下发 newSessionCwd；旧宿主缺席 → 空串降级）──
// 用途：新会话（尚无 canonical sessionId）时提供「先选方案，创建后自动绑定」能力——
//   选择器列文件需要 cwd、pending 按 cwd 分桶存 localStorage（对齐 session-manager §3.4 pending tags）。
let NEW_SESSION_CWD = "";
function bindNewSessionCwd(props?: any): void {
  const c = typeof props?.newSessionCwd === "string" ? props.newSessionCwd : "";
  if (c === NEW_SESSION_CWD) return;
  NEW_SESSION_CWD = c;
  refreshView(); // 模块级变量无 React 依赖：广播让按钮/下拉同步重渲染
}
function getNewSessionCwd(): string { return NEW_SESSION_CWD; }
/** 新会话判定：无 canonical session 且有宿主下发的新会话 cwd（旧宿主拿不到 → 不启用待绑定视图，保持原未绑定视图）。 */
function isNewSessionNow(): boolean { return !getSessionId() && !!getNewSessionCwd(); }
function getSessionId(): string {
  // 1) 统一服务（active canonical，唯一权威）
  if (SVC_SESSION?.id) return SVC_SESSION.id;
  // 2) 插槽 props（宿主列表下发的已解析 id——行内标等场景）
  if (CURRENT_SESSION?.id) return String(CURRENT_SESSION.id);
  // 3) 不做 URL ?session= 兜底（未验证 id 不得发会话请求）
  return "";
}
function getCwd(): string {
  return String(SVC_SESSION?.cwd || CURRENT_SESSION?.cwd || "");
}
/** 会话展示名：优先 name，其次 firstMessage（首条用户输入），再次 id 前 12 位
 *  对齐宿主列表通用契约（AgentSessionPanel.tsx sessionTitle：name || firstMessage || id.slice(0,12)）——之前的 cwd 兜底会导致多个会话显示相同目录名而彼此难辨。
 *  不在 JS 里裁切：返回全量字符串，交给 CSS（flex 1 + overflow:hidden + ellipsis）随面板尺寸自动适应；
 *  aiti-float 让用户可缩放面板 → label 区域实际可用宽度可变，JS 预设上限会过早截断。换行/多空白归一便于阅读。 */
function sessionLabel(cs?: any): string {
  const name = cs?.name;
  if (name) return String(name);
  const fm = cs?.firstMessage;
  if (fm) {
    const s = String(fm).replace(/\s+/g, " ").trim();
    if (s && s !== "(no messages)") return s;
  }
  const id = cs?.id;
  return id ? String(id).slice(0, 12) : "";
}
/** 会话完整 tooltip：名称 + 首条输入 + cwd + id（换行）；firstMessage 全量展示便于识别缩写来源 */
function sessionTooltip(cs?: any): string {
  const parts: string[] = [];
  if (cs?.name) parts.push(String(cs.name));
  if (cs?.firstMessage) {
    const fm = String(cs.firstMessage).replace(/\s+/g, " ").trim();
    if (fm && fm !== "(no messages)") parts.push(fm);
  }
  if (cs?.cwd) parts.push(String(cs.cwd));
  if (cs?.id) parts.push("session: " + String(cs.id));
  return parts.join("\n");
}
async function apiGet(path: string): Promise<any> {
  // cache no-store：status/bindings 是状态型查询，浏览器 HTTP 缓存会让面板拿到旧状态（
  // 实测：unbind 后 refresh 仍渲染已绑定 —— 2026-09 弹窗引导优化中顺手修复）
  // status 读法走 dedupeFetch（重复请求分析 §3.4）：工具条按钮/下拉 slot/行 meta 多消费面
  // 在秒级窗口内同参重拉合一（1.5s 微缓存 + in-flight 单飞）；其余 GET 保持直连。
  if (path.startsWith("/status")) {
    return dedupeFetch(apiUrl(EXT_API + path), { headers: { accept: "application/json" }, cache: "no-store", ttlMs: 1500 }).then((r) => r.json());
  }
  const r = await fetch(apiUrl(EXT_API + path), { headers: { accept: "application/json" }, cache: "no-store" });
  return r.json();
}
async function apiPost(path: string, body: any): Promise<any> {
  const r = await fetch(apiUrl(EXT_API + path), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}

// ---------- bindings 缓存（绑定会话清单 + 各自方案 front-matter tags；GET bindings 一次拉全量，事件失效） ----------
type Bindings = Record<string, { planRel?: string; tags?: string[] }>;
let bindingsCache: Bindings | null = null;
const bindingsListeners = new Set<() => void>();
let bindingsLoading = false;
async function loadBindings(): Promise<void> {
  if (bindingsLoading) return;
  bindingsLoading = true;
  try {
    const r = await fetch(apiUrl(EXT_API + "/bindings"), { headers: { accept: "application/json" }, cache: "no-store" });
    const j = await r.json();
    if (j?.ok) { bindingsCache = j.bindings ?? {}; bindingsListeners.forEach((l) => l()); }
  } catch { /* 网络失败保留旧值 */ }
  bindingsLoading = false;
}
function useBindings(): Bindings {
  const [v, setV] = useState<Bindings | null>(bindingsCache);
  useEffect(() => {
    if (bindingsCache === null) loadBindings();
    const l = () => setV(bindingsCache);
    bindingsListeners.add(l);
    return () => { bindingsListeners.delete(l); };
  }, []);
  return v ?? {};
}

// ---------- 「方案先行」prompt（多语多条，存 aiti-prompts；名字即契约） ----------

const PLAN_PROMPT_DEFAULTS = [
  {
    locale: "zh", name: "方案先行",
    text: "请先设计方案再动手，并把方案落盘到 .md 方案文档（不要只输出消息、不落盘）：1) 先给出设计方案（目标、改动点、影响面、风险），经我确认后写入方案文档再开始实施；2) 执行过程中每完成一步，简短更新进度（可同步方案文档）；3) 全部完成后写一份总结（改动清单、验证结果、遗留事项与后续建议）。方案文档头部请用 front-matter 维护 tags（如 tags: [方案, 主题]，标签可自荐；方案文档必须带状态 tag：方案/评审中、方案/已实施、方案/已过时 之一）。",
  },
  {
    locale: "en", name: "Plan First",
    text: "Plan first, then code — and persist the plan to a .md plan doc (don't just output it as messages): 1) Present a design first (goal, changes, impact, risks), and after my confirmation write it into the plan doc before implementing; 2) Post a short progress update after each step (feel free to sync the plan doc); 3) When done, write a summary (change list, verification, leftovers, follow-ups). Maintain front-matter tags in the plan doc (e.g. tags: [plan, topic]; new tags welcome; plan docs also need exactly one status tag: in-review / implemented / outdated).",
  },
];
function currentLocale(): "zh" | "en" {
  try {
    const v = localStorage.getItem("pi-locale") || navigator.language || "en";
    return String(v).toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch { return "en"; }
}
/** 确保 aiti-prompts 里有各语言的「方案先行」条目（同名不建）；返回条目清单（id=已入库）。
 *  aiti-prompts 缺席 → 返回内置默认文本（id 空）。 */
async function ensurePlanPrompts(): Promise<{ locale: string; name: string; text: string; id?: string }[]> {
  const PAPI = "/api/extensions/aiti-prompts";
  let list: any[] | null = null;
  try {
    const r = await fetch(apiUrl(PAPI + "/prompts"), { headers: { accept: "application/json" } });
    if (r.ok) list = (await r.json())?.prompts ?? [];
  } catch { /* 缺席/网络失败 */ }
  const out: { locale: string; name: string; text: string; id?: string }[] = [];
  for (const def of PLAN_PROMPT_DEFAULTS) {
    const hit = Array.isArray(list) ? list.find((p: any) => p?.name === def.name) : null;
    if (hit) { out.push({ locale: def.locale, name: def.name, text: String(hit.text || def.text), id: hit.id }); continue; }
    if (Array.isArray(list)) {
      try {
        const r = await fetch(apiUrl(PAPI + "/prompts"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: def.name, text: def.text, tags: ["plan-first"], source: "manual" }),
        });
        const j = await r.json();
        if (j?.ok && j.prompt) { out.push({ locale: def.locale, name: def.name, text: String(j.prompt.text || def.text), id: j.prompt.id }); continue; }
      } catch { /* 创建失败 → 内置兜底 */ }
    }
    out.push({ locale: def.locale, name: def.name, text: def.text });
  }
  return out;
}

// ---------- 样式 ----------

// 宿主顶栏按钮标准（git-review/ai-schedule/ai-usage 同款）：36×36 + 右分隔线 + hover 变色
const toolbarBtnStyle: any = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 36, height: 36, padding: 0,
  background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
  color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
  transition: "color 0.12s",
};
const menuBtnStyle: any = { ...toolbarBtnStyle, borderRight: "none", width: 30 };

/** 扩展注册图标（icon.svg）CSS-mask 渲染（extIconSpan 同款：颜色跟随 currentColor）——不自绘 svg */
function ExtIcon({ size = 16 }: { size?: number }): any {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block", width: size, height: size, flexShrink: 0, verticalAlign: "middle",
        background: "currentColor",
        maskImage: `url(${apiUrl("/api/extensions/aiti-plan-first/assets/icon.svg")})`,
        WebkitMaskImage: `url(${apiUrl("/api/extensions/aiti-plan-first/assets/icon.svg")})`,
        maskRepeat: "no-repeat", maskPosition: "center", maskSize: "contain",
      }}
    />
  );
}

// 下拉容器：分区结构（头部条 / 正文 / slogan 脚注），圆角裁切
const dropdownStyle = (a: { left: number; top: number }, tall?: boolean): any => ({
  position: "fixed", left: a.left, top: a.top, zIndex: 10060,
  width: DD_WIDTH, maxWidth: "94vw",
  // tall（选择方案文档视图）：吃满视口剩余高度（上限 680），列表区域内部滚动
  maxHeight: tall ? Math.max(320, Math.min((typeof window !== "undefined" ? window.innerHeight : 800) - a.top - 12, 680)) : 320,
  display: "flex", flexDirection: "column",
  background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)",
  borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,.4)", overflow: "hidden",
  fontSize: 12.5, lineHeight: 1.5,
});
const ddHeader: any = {
  display: "flex", alignItems: "center", gap: 8, padding: "9px 14px",
  borderBottom: "1px solid var(--border)", background: "var(--bg)", fontWeight: 600, fontSize: 12.5,
};
const ddBody: any = { padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", minHeight: 0 };
const ddFooter: any = {
  padding: "7px 14px", borderTop: "1px solid var(--border)", display: "flex",
  alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: 11,
};
const rowStyle: any = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" };
const mdRowStyle: any = { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6 };
const mdPathStyle: any = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" };
const tagChipStyle: any = {
  display: "inline-flex", alignItems: "center", gap: 3, background: "var(--bg)",
  border: "1px solid var(--border)", borderRadius: 999, padding: "1px 8px", fontSize: 11,
};
const tagXStyle: any = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  color: "var(--text-dim)", fontSize: 10, lineHeight: 1,
};
const tagInputStyle: any = {
  width: 76, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 999,
  padding: "1px 8px", fontSize: 11, color: "inherit", outline: "none",
};
const searchInputStyle: any = {
  width: "100%", boxSizing: "border-box", background: "var(--bg)", border: "1px solid var(--border)",
  borderRadius: 8, padding: "5px 10px", fontSize: 12, color: "inherit", outline: "none", marginBottom: 6,
};
const docLinkStyle: any = {
  background: "none", border: "none", padding: 0,
  color: "var(--accent, #4c7dd0)", font: "inherit", fontSize: 12.5, cursor: "pointer",
  textDecoration: "underline", textUnderlineOffset: 3,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320,
  textAlign: "left",
};
const atBtnStyle: any = {
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
  padding: "1px 7px", fontSize: 12, cursor: "pointer", color: "inherit", fontWeight: 600,
};
const iconBtnStyle: any = {
  background: "none", border: "none", padding: "0 2px", cursor: "pointer",
  color: "var(--text-dim)", display: "inline-flex", alignItems: "center",
};
const warnStyle: any = { color: "#d29922" };
const dimStyle: any = { color: "var(--text-dim)", fontSize: 11 };
const bannerChildStyle: any = { fontSize: 11.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function refreshView(): void {
  // 渲染期间调用（bindNewSessionCwd 在 PlanToolbarButton/PlanDropdownSlot 的 render 里）会同步
  // dispatch REFRESH_EVENT，订阅者（onRefresh → setTick/setStatus）在另一个组件的渲染栈里 setState，
  // 触发 React「Cannot update a component while rendering a different component」告警。
  // 微任务派发让广播落在本轮渲染提交之后——订阅者只重渲染 module 级缓存，语义不变。
  const fire = () => { try { (window as any).dispatchEvent(new Event(REFRESH_EVENT)); } catch { /* ignore */ } };
  try {
    if (typeof queueMicrotask === "function") queueMicrotask(fire);
    else setTimeout(fire, 0);
  } catch { /* ignore */ }
}

/** 下拉内统一按钮：pri=主操作（accent 实底）/ sec=次操作（描边）/ ghost=弱操作（无框变暗）；small=紧凑档（文件列表行内） */
function Btn(props: { kind?: "pri" | "sec" | "ghost"; small?: boolean; title?: string; onClick: () => void; children: any }): any {
  const [hov, setHov] = useState(false);
  const kind = props.kind ?? "sec";
  const small = !!props.small;
  const base: any = {
    cursor: "pointer", borderRadius: small ? 6 : 8, padding: small ? "3px 10px" : "5px 12px", fontSize: small ? 11.5 : 12,
    fontWeight: kind === "pri" ? 500 : 400, whiteSpace: "nowrap", transition: "all 0.12s",
  };
  let st: any;
  if (kind === "pri") {
    st = { ...base, background: "var(--accent, #4c7dd0)", color: "#fff", border: "1px solid transparent", opacity: hov ? 0.88 : 1 };
  } else if (kind === "ghost") {
    st = { ...base, background: hov ? "var(--bg-hover)" : "transparent", color: hov ? "var(--text)" : "var(--text-dim)", border: "1px solid transparent" };
  } else {
    st = { ...base, background: hov ? "var(--bg-hover)" : "var(--bg)", color: "inherit", border: "1px solid var(--border)" };
  }
  return (
    <button title={props.title} onClick={props.onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} style={st}>
      {props.children}
    </button>
  );
}

// ---------- 提醒强调带（左色条 + 淡底 + 加粗标题；children 为副行） ----------
// 色调语义：info 蓝=进行中确认（suggest-md/未绑定）/ warn 琥珀=需要注意（lead/stale）/ err 红=异常（方案文件消失）
const BANNER_TONES: Record<string, { color: string; bg: string }> = {
  info: { color: "#4c7dd0", bg: "rgba(76,125,208,0.10)" },
  warn: { color: "#d29922", bg: "rgba(210,153,34,0.10)" },
  err: { color: "#f85149", bg: "rgba(248,81,73,0.10)" },
};
function RemindBanner(props: { tone?: "info" | "warn" | "err"; icon: string; title: string; children?: any }): any {
  const tone = BANNER_TONES[props.tone ?? "warn"] ?? BANNER_TONES.warn;
  return (
    <div style={{
      borderLeft: `3px solid ${tone.color}`, background: tone.bg, borderRadius: 6,
      padding: "7px 10px", display: "flex", flexDirection: "column", gap: 2,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 12.5, color: tone.color }}>
        <span aria-hidden>{props.icon}</span>
        <span>{props.title}</span>
      </div>
      {props.children}
    </div>
  );
}

/** footer slogan 行动条：⚡ + slogan 主文案 + 「点击填入提示词 →」行动说明（描边按钮，hover 高亮）；
 *  旁侧铅笔 = Prompt 收藏编辑（语义不变，仅样式从 dim 点线小字升级为可辨识的按钮）。 */
function SloganBar(props: { onSlogan: () => void; onEditPrompt: () => void }): any {
  const [hov, setHov] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
      <button
        onClick={props.onSlogan}
        title={t("pf.sloganTip")}
        aria-label={t("pf.sloganTip")}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0,
          background: hov ? "var(--bg-hover)" : "var(--bg)",
          border: `1px solid ${hov ? "var(--accent, #4c7dd0)" : "var(--border)"}`,
          borderRadius: 8, padding: "3px 10px", fontSize: 11.5, cursor: "pointer", color: "inherit",
        }}
      >
        <span aria-hidden>⚡</span>
        <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t("pf.slogan")}</span>
        <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>{t("pf.sloganAction")}</span>
      </button>
      <button
        onClick={props.onEditPrompt}
        title={t("pf.editPrompt")}
        aria-label={t("pf.editPrompt")}
        style={{ background: "none", border: "none", padding: "0 2px", cursor: "pointer", color: "inherit", display: "inline-flex", alignItems: "center" }}
      >
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </button>
    </div>
  );
}

// ---------- 顶栏按钮（哑触发：状态色 + 算锚点 + dispatch 事件） ----------

export function PlanToolbarButton(props?: any): any {
  bindSession(props);
  bindNewSessionCwd(props); // 新会话 cwd 模块级缓存（dropdown 同 bundle 共享）
  const [status, setStatus] = useState<any>(null);
  const [, tick] = useState(0); // REFRESH_EVENT 驱动（模块级 pending/cwd 变化无 props 通道）
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const refresh = () => { apiGet("/status?session=" + encodeURIComponent(getSessionId())).then(setStatus).catch(() => { }); };
  useEffect(() => {
    refresh();
    const onRefresh = () => { refresh(); tick((n) => n + 1); };
    (window as any).addEventListener(REFRESH_EVENT, onRefresh);
    return () => (window as any).removeEventListener(REFRESH_EVENT, onRefresh);
  }, []);

  const bound = !!status?.bound;
  // 新会话已选方案（待绑定）——按 cwd 读 pending；按钮蓝点提示（★ 不把它当已绑定绿）
  const pendingPlan = getNewSessionCwd() ? readPendingPlan(getNewSessionCwd()) : null;
  // 状态用图标颜色表达（mask 图标 background:currentColor 天然跟随）：琥珀=提醒中/静音，绿=已绑定，蓝=已选待绑定，默认灰
  const stateColor = status?.muted ? "#d29922" : bound ? "#3fb950" : pendingPlan ? "#4c7dd0" : "var(--text-muted)";
  const title = pendingPlan
    ? t("pf.pendingTitle", { plan: pendingPlan.rel || pendingPlan.path })
    : !status?.traceOk
    ? t("pf.traceOff")
    : status?.muted
      ? t("pf.muted")
      : bound
        ? t("pf.bound", { plan: status?.planRel || "" })
        : t("pf.unbound");

  const open = (e: any) => {
    if (status?.muted) apiPost("/mute", { session: getSessionId(), muted: false }).then(refresh).catch(() => { });
    openPlanDropdownFromEvent(e, btnRef.current);
  };
  return (
    <button
      ref={btnRef}
      data-pf-trigger="1"
      style={{ ...toolbarBtnStyle, color: stateColor }}
      title={title}
      aria-label={t("pf.title")}
      onMouseEnter={(e: any) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.color = stateColor; }}
      onClick={open}
    >
      <ExtIcon size={16} />
    </button>
  );
}

/** ⋯ 菜单声明式触发（register meta.onClick → 宿主菜单图标槽，2026-08 契约）：
 *  锚位优先取事件行元素，否则 fallback 右上角；状态 unmute 等只在工具条本体按钮 open 里做。 */
export function openPlanDropdownFromEvent(e?: any, preferEl?: HTMLElement | null, opts?: { forceOpen?: boolean }): void {
  const r = ((preferEl || e?.currentTarget) as HTMLElement | undefined)?.getBoundingClientRect?.();
  const anchor = r
    ? { left: Math.max(8, Math.min(r.right - DD_WIDTH, window.innerWidth - DD_WIDTH - 8)), top: r.bottom + 6 }
    : { left: Math.max(8, window.innerWidth - DD_WIDTH - 8), top: 48 };
  try { (window as any).dispatchEvent(new CustomEvent(DROPDOWN_EVENT, { detail: { anchor, ...(opts || {}) } })); } catch { }
  refreshView();
}

// ---------- 行内 meta 标（sessionRowMeta slot；绑定方案的会话在「xxx 条消息」后显示 📋 + front-matter tags） ----------

/** 行内展示：最多取 2 个 tag（方案状态 tag 优先）；空 tag 只显 📋。
 *  点击 📋/方案 tag → 打开该会话的方案先行下拉（openPlanDropdownFromEvent 同 bundle 直调；
 *  不 stopPropagation：冒泡到行 onClick 选中该会话 → PlanDropdownSlot 因 curSid 变化
 *  refresh，下拉最终展示点击行的方案状态）。 */
export function PlanRowMeta(props?: any): any {
  const sid = String(props?.currentSession?.id || "");
  const bindings = useBindings();
  const hit = bindings[sid];
  if (!hit) return null;
  const raw = hit.tags || [];
  const tags = raw.slice(0, 2);
  const title = t("pf.bound", { plan: hit.planRel || "" }) + (raw.length ? "\n🏷 " + raw.join(", ") : "");
  return (
    <span
      title={title}
      aria-label={t("pf.title")}
      onClick={(e: any) => openPlanDropdownFromEvent(e, null, { forceOpen: true })}
      // flexShrink 1：窄侧栏空间不足时 tags 区先收缩截断，保时间/消息数完整
      style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 1, minWidth: 0, overflow: "hidden", cursor: "pointer" }}
    >
      <span
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, width: 13, height: 13, fontSize: 8, color: "#3fb950",
          border: "1px solid #3fb95055", borderRadius: 4,
        }}
      >📋</span>
      {tags.map((tg: string) => (
        <span
          key={tg}
          title={t("pf.title")}
          style={{
            flexShrink: 0, fontSize: 9.5, lineHeight: 1.6, whiteSpace: "nowrap",
            color: "#3fb950", background: "rgba(63,185,80,0.08)",
            border: "1px solid #3fb95033", borderRadius: 999, padding: "0 5px",
          }}
        >{tg}</span>
      ))}
    </span>
  );
}

// ---------- 下拉 slot（dialogs 常驻；持有全部状态；⋯ 菜单触发也不随菜单卸载） ----------

export function PlanDropdownSlot(props?: any): any {
  bindSession(props); // 宿主每次渲染下发 currentSession——会话切换实时跟随（remind 过滤/status 查询用）
  bindNewSessionCwd(props); // 新会话 cwd：待绑定 pending 分桶 + pick 列文件用（旧宿主缺席 → 降级）
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "pick">("main");
  const [remind, setRemind] = useState<any>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [tick, setTick] = useState(0); // REFRESH_EVENT 驱动：模块级会话/pending/cwd 变化无 props 通道，靠它重渲染
  const [pending, setPending] = useState<PendingPlan | null>(() => readPendingPlan(getNewSessionCwd()));

  const refresh = () => { apiGet("/status?session=" + encodeURIComponent(getSessionId())).then(setStatus).catch(() => { }); };

  // ── 新会话「先选方案，创建后自动绑定」pending（对齐 session-manager §3.4 pending tags）──
  // 切换新建会话 cwd（未重挂载）→ 从存储重载该 cwd 的 pending。
  const pendingKeyRef = useRef<string>(getNewSessionCwd());
  useEffect(() => {
    const key = getNewSessionCwd();
    if (key === pendingKeyRef.current) return;
    pendingKeyRef.current = key;
    setPending(key ? readPendingPlan(key) : null);
  }, [tick]);

  // 合并：会话真正创建（canonical session 出现）且该 cwd 有 pending → 自动 POST /bind 并清存储。
  // mergedSidRef 保证同一会话只尝试一次；失败保留 pending（不轮询；下次会话出现可再试）。
  const mergedSidRef = useRef<string>("");
  useEffect(() => {
    const sid = getSessionId();
    const cwd = getCwd();
    if (!sid || !cwd || mergedSidRef.current === sid) return;
    mergedSidRef.current = sid;
    const p = readPendingPlan(cwd);
    if (!p) return;
    apiPost("/bind", { session: sid, path: p.path, cwd })
      .then((r: any) => {
        if (r && r.ok) {
          writePendingPlan(cwd, null);
          setPending((cur) => (cur && cur.path === p.path ? null : cur));
          setRemind(null);
          refresh(); loadBindings(); refreshView();
        }
      })
      .catch(() => { });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, props?.currentSession?.id, props?.currentSession?.cwd]);

  // 会话切换/进入（含带 ?session= 加载后的首次下发）：清旧会话提醒 + 重拉状态 + 进入会话检查。
  // prevSid 防「宿主 currentSession 抖动」（短暂 undefined 后恢复同值）被误判为切换——那会误清
  // 刚弹出的提醒（实证：stale 弹出后被抖动重跑清 remind，面板残留打开渲染成绑定态，用户看不出为何弹）。
  // 真切换时：提醒态（remind 非空）面板随之收起（提醒不跨会话残留）；手动浏览态保持打开，内容 refresh 更新。
  // （深审 2026-09：修复后用页面探针 window.__pfFrames 可取证帧与弹出瞬间面板快照）
  const curSid = props?.currentSession?.id || "";
  const prevSidRef = useRef<string>("");
  const remindRef = useRef<any>(remind);
  remindRef.current = remind;
  const applyRemind = (ev: any) => {
    setRemind(ev);
    refresh();
    setAnchor({ left: Math.max(8, window.innerWidth - DD_WIDTH - 8), top: 48 });
    setView("main");
    setOpen(true);
  };
  useEffect(() => {
    if (!curSid) return; // 宿主尚未下发 currentSession（挂载早期/抖动空值）——不动任何状态，等真值重跑
    if (prevSidRef.current === curSid) return; // 同值恢复（抖动回归）：非真切换，保留刚弹出的提醒
    const hadRemind = remindRef.current != null;
    prevSidRef.current = curSid;
    setRemind(null);
    setView("main");
    if (hadRemind) setOpen(false); // 提醒态跨会话不残留；手动浏览态保持开（下方 refresh 更新内容）
    refresh();
    apiPost("/check", { session: curSid, cwd: getCwd() })
      .then((r: any) => { if (r?.ok && r.event && getSessionId() === curSid) applyRemind(r.event); }) // 响应回来时若已切走则不弹
      .catch(() => { });
    refreshView(); // 让工具条按钮的状态色也跟随当前会话刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSid]);

  useEffect(() => {
    refresh();
    // remind 推送：pi-web 页面事件流（agent/running/events 统一帧，type=pf:remind；
    // 无独立连接——与侧栏运行状态共享同一条 SSE）。客户端缺席（core 过旧）→ 仅跳过订阅，
    // 手动入口（工具条按钮/侧栏行内标/点外部关闭）照常注册。
    // 事件总线 topics 唯一（2026-09-09 拍板）：白名单 pf:remind；禁止任何兑底（全帧/core route 均已删）。
    // topics 服务缺席（event-bus 未启用）→ 不订阅，提醒功能降级不可用（不崩）。
    const topicsSvc = extSvc<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
    let unsub: any = null;
    if (topicsSvc) {
      const onFrame = (frame: any) => {
        if (!frame || frame.type !== "pf:remind") return;
        const ev = frame;
        if (ev.sessionId !== getSessionId()) return;
        if (ev.kind === "followed") { refresh(); return; }
        applyRemind(ev);
      };
      unsub = topicsSvc(onFrame, ["pf:remind"]).off;
    }
    const onDropdown = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.anchor) setAnchor(d.anchor);
      setView("main");
      setRemind(null); // 手动打开：清掉旧提醒，默认加载当前 chat session 的方案状态
      refresh(); // 手动打开：拉取当前 chat session（bindSession 已更新 CURRENT_SESSION）的方案信息
      // forceOpen（侧栏行内标）：已开也保持开（点另一行标 = 切到该行会话而非关闭）；
      // 工具条按钮保持 toggle 语义：二次点击 = 切换关闭（点外部关闭已由 mousedown 处理）
      if (d.forceOpen) setOpen(true);
      else setOpen((o: boolean) => !o);
    };
    // 点外部关闭（ModelSelector 同款：目标不在面板也不在触发按钮内 → 收起）
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if ((target as Element)?.closest?.("[data-pf-trigger]")) return;
      setOpen(false);
    };
    const onRefresh = () => { refresh(); setTick((n: number) => n + 1); };
    (window as any).addEventListener(DROPDOWN_EVENT, onDropdown);
    (window as any).addEventListener(REFRESH_EVENT, onRefresh);
    document.addEventListener("mousedown", onOutside);
    return () => {
      if (unsub) unsub();

      (window as any).removeEventListener(DROPDOWN_EVENT, onDropdown);
      (window as any).removeEventListener(REFRESH_EVENT, onRefresh);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [curSid]);

  // 自动收起策略（按类型区分；时长服务端 feature 下发 status.autoClose，0 = 常驻）：
  //   手动打开（无 remind）/ md 选择器视图 → 常驻，用户操作后才收起；
  //   suggest-md（疑似方案询问）→ 缺省 0=常驻，经 plan.autoCloseSuggestSec 可配；
  //   stale（大改未跟）→ 缺省 30s；lead（领先提醒）→ 缺省 10s；hover 暂停计时（正在读不被收走）。
  useEffect(() => {
    if (!open || hovering) return;
    let ms = 0;
    if (view === "main" && remind) {
      if (remind.kind === "suggest-md") ms = status?.autoClose?.suggestMs ?? 0;
      else if (remind.kind === "stale") ms = status?.autoClose?.staleMs ?? 30000;
      else if (remind.kind === "lead") ms = status?.autoClose?.leadMs ?? 10000;
    }
    if (!ms) return; // 0 = 常驻
    const timer = setTimeout(() => setOpen(false), ms);
    return () => clearTimeout(timer);
  }, [open, hovering, view, remind, status]);

  const close = () => setOpen(false);
  const doBind = (abs: string, rel?: string) => {
    if (!abs) return;
    const sid = getSessionId();
    // 新会话（无 canonical sessionId）：不提示绑定失败——先暂存 pending，会话创建后自动绑定
    if (!sid) {
      const key = getNewSessionCwd();
      if (!key) return; // 旧宿主拿不到新会话 cwd（UI 也不会进入待绑定视图）
      const p: PendingPlan = { path: abs, rel: rel || abs, at: Date.now() };
      writePendingPlan(key, p);
      setPending(p);
      setView("main"); // 选完回主视图展示「⌛ 待绑定」
      return;
    }
    apiPost("/bind", { session: sid, path: abs, cwd: getCwd() || getNewSessionCwd() })
      .then(() => { setRemind(null); refresh(); loadBindings(); setTimeout(() => setOpen(false), 2000); })
      .catch(() => { });
  };
  // 取消待选（清当前 cwd 的 pending + 本地态）
  const doPendingClear = () => {
    const key = getNewSessionCwd();
    if (key) writePendingPlan(key, null);
    setPending(null);
  };
  const doMute = () => { apiPost("/mute", { session: getSessionId(), muted: true }).then(refresh).catch(() => { }); close(); };
  const doUnbind = () => { apiPost("/unbind", { session: getSessionId() }).then(() => { setRemind(null); refresh(); loadBindings(); close(); }).catch(() => { }); };
  const doUpdate = () => {
    const rel = remind?.planRel || status?.planRel || "";
    const c = getHostCtx();
    if (rel && typeof c?.appendText === "function") c.appendText("更新方案文档：@" + rel + " （若已实施/已过时，请同步更新 front-matter 里的 方案/* 状态 tag） ");
    close();
  };
  // [P1-4 接线] chips 增删真实写回方案文档 front-matter（POST /doctags → applyFmTags），
  // 返回全量 tags 即时刷新本地 status（不等下一轮 /status 拉取）。未绑定/失败静默。
  const doTagAdd = (t2: string) => {
    const tag = String(t2 || "").trim();
    if (!tag) return;
    apiPost("/doctags", { session: getSessionId(), add: [tag], remove: [] })
      .then((r) => {
        if (r && r.ok) setStatus((s: any) => ({ ...(s || {}), planTags: r.tags }));
        refresh();
      })
      .catch(() => { });
  };
  const doTagRemove = (t2: string) => {
    const tag = String(t2 || "").trim();
    if (!tag) return;
    apiPost("/doctags", { session: getSessionId(), remove: [tag], add: [] })
      .then((r) => {
        if (r && r.ok) setStatus((s: any) => ({ ...(s || {}), planTags: r.tags }));
        refresh();
      })
      .catch(() => { });
  };
  const doAddTags = () => {
    const rel = remind?.planRel || status?.planRel || "";
    const c = getHostCtx();
    if (!rel || typeof c?.appendText !== "function") { close(); return; }
    apiGet("/tag-vocab").then((v) => {
      const vocab = String(v?.tags || "");
      c.appendText("为 @" + rel + " 写 tags 到 front-matter（无 front-matter 则文首新增 --- 块）：内容 tag 2-5 个、从现有词表选：" + vocab + "；若 @" + rel + " 是方案文档，必须带且仅带一个状态 tag：方案/评审中、方案/已实施、方案/已过时 ");
    }).catch(() => {
      c.appendText("为 @" + rel + " 写 tags 到 front-matter；若是方案文档必须带且仅带一个状态 tag：方案/评审中、方案/已实施、方案/已过时 ");
    });
    close();
  };
  const openPicker = () => {
    setView("pick"); // 文件清单由 PickView 自拉（含搜索/tag 过滤）
  };
  const doOpenPlan = () => {
    const abs = status?.plan;
    if (!abs) return;
    const c = getHostCtx();
    if (typeof c?.openFile === "function") c.openFile(abs, (status?.planRel || "").split("/").pop() || abs);
  };
  const doAt = () => {
    const rel = status?.planRel || "";
    const c = getHostCtx();
    if (rel && typeof c?.appendText === "function") c.appendText("@" + rel + " ");
    close();
  };
  // 选择器行动作（PickView）：点击文件名 = 打开文件标签页（不关下拉，便于继续选择）；@ = 插入 @rel 后收起（同 doAt 语义）
  const doOpenFile = (f: any) => {
    if (!f?.abs) return;
    const c = getHostCtx();
    if (typeof c?.openFile === "function") c.openFile(f.abs, String(f.rel || f.abs).split("/").pop() || f.abs);
  };
  const doAtFile = (f: any) => {
    const rel = f?.rel || "";
    const c = getHostCtx();
    if (rel && typeof c?.appendText === "function") c.appendText("@" + rel + " ");
    close();
  };
  const onEditPrompt = async () => {
    const ps = await ensurePlanPrompts();
    const hit = ps.find((p) => p.locale === currentLocale()) ?? ps[0];
    if (!hit?.id) return; // aiti-prompts 缺席（无 id）
    try {
      (window as any).dispatchEvent(new CustomEvent("aiti-prompts-open", { detail: { edit: true, prompt: { id: hit.id, name: hit.name, text: hit.text, groupId: null, tags: ["plan-first"] } } }));
    } catch { }
    close();
  };
  const onSlogan = async () => {
    const ps = await ensurePlanPrompts();
    const hit = ps.find((p) => p.locale === currentLocale()) ?? ps[0];
    const c = getHostCtx();
    if (hit && typeof c?.appendText === "function") c.appendText(hit.text);
    if (hit?.id) { try { fetch(apiUrl("/api/extensions/aiti-prompts/prompts/" + hit.id + "/touch"), { method: "POST" }); } catch { } }
    close();
  };

  if (!open || !anchor) return null;
  return (
    // aiti-float 契约（docs/aiti-web-ext-float-dialogs.md）：
    //   -pos="asis"：初始位置保持锚定位（工具条按钮下方/右上角）——float 缺省会拽去屏幕居中；
    //   -autoh="1"：高度随内容自适应（status 异步/remind 类型/视图切换高度全程动态，
    //    固定高度会被锁死出滚动条或留大块空白；React 的 maxHeight 继续生效）；
    //   -persist="0"：不记忆位置——下拉每次打开回锚定位（拖动/缩放仅本次有效，关掉即忘），
    //    根治「宽屏存的位置在窄屏恢复 → clamp 只留 80px → 弹窗大半出屏」的盖半屏问题；
    //   -max="0"：下拉不需要最大化按钮（小屏也不全屏，锚定浮窗按 React maxWidth 94vw 缩宽）。
    <div ref={panelRef} style={dropdownStyle(anchor, view === "pick")} data-ext-float="1"
      data-ext-float-pos="asis" data-ext-float-autoh="1" data-ext-float-persist="0" data-ext-float-max="0"
      onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <div style={ddHeader}>
        <span>📋 {t("pf.title")}</span>
        <StateChip status={status} pending={pending} isNew={isNewSessionNow()} />
        {props?.currentSession ? (
          <span
            title={sessionTooltip(props.currentSession)}
            style={{ color: "var(--text-dim)", fontWeight: 400, fontSize: 11, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >· {sessionLabel(props.currentSession)}</span>
        ) : null}
        {status && !status.traceOk ? <span style={{ color: "var(--text-dim)", fontWeight: 400, flexShrink: 0 }}> · {t("pf.traceOff")}</span> : null}
        <button onClick={close} aria-label="close"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 12, lineHeight: 1, padding: "0 2px", marginLeft: "auto" }}
          onMouseEnter={(e: any) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e: any) => { e.currentTarget.style.color = "var(--text-dim)"; }}>×</button>
      </div>
      {/* main 自含 ddBody/ddFooter（去旧外层包壳的双层 padding）；pick 自含弹性布局占满面板剩余高度 */}
      {view === "main" ? (
        <MainView status={status} remind={remind} onBind={doBind} onPick={openPicker} onUnbind={doUnbind}
          isNew={isNewSessionNow()} pending={pending} onPendingClear={doPendingClear}
          onMute={doMute} onUpdate={doUpdate} onDismiss={() => { setRemind(null); close(); }}
          onSlogan={onSlogan} onEditPrompt={onEditPrompt} onOpenPlan={doOpenPlan} onOpenMd={doOpenFile} onAt={doAt} onAddTags={doAddTags}
          onTagAdd={doTagAdd} onTagRemove={doTagRemove} onClose={close} />
      ) : (
        <PickView onBind={doBind} onBack={() => setView("main")} onOpen={doOpenFile} onAt={doAtFile} />
      )}
    </div>
  );
}

// ---------- 主视图（分区：头部状态徽标 / 提醒正文 / 文档行 / tags 行 / slogan 脚注） ----------

// 候选文档列表（suggest-md 事件与未绑定默认视图共用）：每行 = 文件名（点击 openFile 核实）+ 一键绑定；
// 首行为方案命名优先项（服务端已排序）文字亮一档。items ≤5（服务端已截断）。
function CandidateList(props: { items: any[]; onBind: (abs: string, rel?: string) => void; onOpen: (f: any) => void }): any {
  const { items, onBind, onOpen } = props;
  if (!items?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, margin: "2px 0" }}>
      {items.slice(0, 5).map((f: any, i: number) => (
        <div key={f?.abs || i} style={mdRowStyle}
          onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e: any) => { e.currentTarget.style.background = "transparent"; }}>
          <button
            onClick={() => onOpen(f)}
            title={(f?.rel || f?.abs || "") + (f?.abs ? "\n" + f.abs : "") + "\n" + t("pf.openFileTip")}
            style={{ ...mdPathStyle, background: "none", border: "none", padding: 0, font: "inherit", fontSize: 12, cursor: "pointer", color: i === 0 ? "var(--text)" : "var(--text-dim)", textDecoration: "underline dotted", textUnderlineOffset: 3 }}
          >{f?.rel || f?.abs || ""}</button>
          <Btn small onClick={() => onBind(f?.abs, f?.rel)}>{t("pf.bind")}</Btn>
        </div>
      ))}
    </div>
  );
}

function StateChip(props: { status: any; pending?: PendingPlan | null; isNew?: boolean }): any {
  const st = props.status;
  // 新会话已选方案（待绑定）：蓝标，区别于已绑定/未绑定
  if (props.pending) return <span style={{ ...{ fontSize: 10.5, padding: "1px 8px", borderRadius: 999, border: "1px solid #4c7dd055", color: "#4c7dd0" } }}>{t("pf.pendingChip")}</span>;
  // 新会话（尚未创建）：不展示「未绑定」绑定提示，显中性新会话标
  if (props.isNew) return <span style={{ ...{ fontSize: 10.5, padding: "1px 8px", borderRadius: 999, border: "1px solid #4c7dd044", color: "var(--text-dim)" } }}>{t("pf.newSessionChip")}</span>;
  if (st?.muted) return <span style={{ ...{ fontSize: 10.5, padding: "1px 8px", borderRadius: 999, border: "1px solid #d2992255", color: "#d29922" } }}>已静音</span>;
  if (st?.bound) return <span style={{ ...{ fontSize: 10.5, padding: "1px 8px", borderRadius: 999, border: "1px solid #3fb95055", color: "#3fb950" } }}>已绑定</span>;
  return <span style={{ ...{ fontSize: 10.5, padding: "1px 8px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-dim)" } }}>未绑定</span>;
}

function MainView(props: { status: any; remind: any; onBind: (abs: string, rel?: string) => void; onPick: () => void; onUnbind: () => void; onMute: () => void; onUpdate: () => void; onDismiss: () => void; onSlogan: () => void; onEditPrompt: () => void; onOpenPlan: () => void; onOpenMd: (f: any) => void; onAt: () => void; onAddTags: () => void; onTagAdd: (t: string) => void; onTagRemove: (t: string) => void; onClose: () => void; isNew?: boolean; pending?: PendingPlan | null; onPendingClear: () => void }): any {
  const { status, remind, onBind, onPick, onUnbind, onMute, onUpdate, onDismiss, onSlogan, onEditPrompt, onOpenPlan, onOpenMd, onAt, onAddTags, onTagAdd, onTagRemove, onClose, isNew, pending, onPendingClear } = props;
  const ev = remind;
  return (
    <>
      <div style={ddBody}>
        {ev?.kind === "lead" ? (
          <>
            <RemindBanner tone="warn" icon="⚠" title={t("pf.leadTitle")} />
            <div style={dimStyle}>{t("pf.leadHow")}</div>
            <div style={rowStyle}>
              <Btn kind="pri" onClick={onSlogan} title={t("pf.sloganTip")}>{t("pf.leadPrompt")}</Btn>
              <Btn onClick={onPick}>{t("pf.choose")}</Btn>
            </div>
            <div style={rowStyle}>
              <Btn kind="ghost" onClick={onDismiss}>{t("pf.got")}</Btn>
              <Btn kind="ghost" onClick={onMute}>{t("pf.mute")}</Btn>
            </div>
          </>
        ) : ev?.kind === "suggest-md" ? (
          <>
            <RemindBanner tone="info" icon="💡" title={t("pf.suggestTitle")} />
            <div style={dimStyle}>{t("pf.bindHint")}</div>
            {/* 识别到的全部候选（≤5，方案命名优先在首行）逐行列出，每行一键绑定；文件名可点开核实 */}
            <CandidateList items={ev.mdPaths} onBind={onBind} onOpen={onOpenMd} />
            <div style={rowStyle}>
              <Btn onClick={onPick}>{t("pf.moreDocs")}</Btn>
              <Btn kind="ghost" onClick={onDismiss}>{t("pf.later")}</Btn>
            </div>
            <div style={dimStyle}>💡 {t("pf.tagHint")}</div>
          </>
        ) : ev?.kind === "stale" ? (
          <>
            <RemindBanner tone={ev.planMissing ? "err" : "warn"} icon={ev.planMissing ? "❌" : "📋"} title={ev.planMissing ? t("pf.missingTitle") : t("pf.staleTitle")}>
              {!ev.planMissing ? (
                <span style={bannerChildStyle} title={ev.sample?.join(", ") || ""}>
                  {t("pf.stale", { n: ev.files ?? 0 })}{ev.sample?.length ? " · " + ev.sample.join(", ") + "…" : ""}
                </span>
              ) : null}
            </RemindBanner>
            {ev.planMissing
              ? <div style={warnStyle}>{t("pf.rebind")}</div>
              : <div style={dimStyle}>{t("pf.staleHow", { plan: ev.planRel || "" })}</div>}
            <div style={rowStyle}>
              {ev.planMissing ? (
                <Btn kind="pri" onClick={onPick}>{t("pf.rebindBtn")}</Btn>
              ) : (
                <>
                  <Btn kind="pri" onClick={onUpdate} title={t("pf.updateTip")}>{t("pf.update")}</Btn>
                  <Btn onClick={onAddTags} title="插入「为方案文档添加 tags（含状态规则）」提示词">{t("pf.addTags")}</Btn>
                </>
              )}
              <Btn kind="ghost" onClick={onDismiss}>{t("pf.got")}</Btn>
              <Btn kind="ghost" onClick={onMute}>{t("pf.mute")}</Btn>
            </div>
          </>
        ) : isNew ? (
          <>
            <RemindBanner tone="info" icon="🧭" title={t("pf.newTitle")} />
            <div style={dimStyle}>{t("pf.newHint")}</div>
            {pending ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span
                  title={pending.path}
                  style={{ ...tagChipStyle, borderColor: "#4c7dd066", color: "var(--accent, #4c7dd0)", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >{"⌛ " + (pending.rel || pending.path)}</span>
                <Btn small onClick={onPick}>{t("pf.pendingChange")}</Btn>
                <Btn small kind="ghost" onClick={onPendingClear}>{t("pf.pendingClear")}</Btn>
              </div>
            ) : (
              <div style={rowStyle}>
                <Btn kind="pri" onClick={onPick}>{t("pf.newPick")}</Btn>
              </div>
            )}
            {pending ? <div style={dimStyle}>💡 {t("pf.pendingAuto")}</div> : null}
          </>
        ) : status?.bound ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <button onClick={onOpenPlan} title={(status?.plan || status?.planRel || "") + (status?.plan ? "\n" + t("pf.openFileTip") : t("pf.openFileTip"))} style={docLinkStyle}>{status?.planRel || ""}</button>
              <button onClick={onAt} title={t("pf.atTip")} aria-label={t("pf.atTip")} style={atBtnStyle}>@</button>
              <button onClick={onAddTags} title="插入「添加 tags（含方案状态规则）」提示词" style={atBtnStyle}>🏷</button>
              <Btn onClick={onPick}>{t("pf.choose")}</Btn>
              <Btn kind="ghost" onClick={onUnbind}>{t("pf.unbind")}</Btn>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>🏷</span>
              {(status?.planTags || []).map((tg: string) => (
                <span key={tg} style={tagChipStyle}>
                  {tg}
                  <button onClick={() => onTagRemove(tg)} title={t("pf.tagRemove")} style={tagXStyle}>×</button>
                </span>
              ))}
              <input
                placeholder="+ tag"
                title={t("pf.tagAdd")}
                style={tagInputStyle}
                onKeyDown={(e: any) => { if (e.key === "Enter" && e.currentTarget.value.trim()) { onTagAdd(e.currentTarget.value); e.currentTarget.value = ""; } }}
              />
            </div>
            {/* [P1-5 客户端联动] 状态 tag 违约警示：方案/* 有且仅有一个的机器可读校验
                （server /status statusCheck 字段）。>1 时提示并附一键"保留最后一个"修复——
                直接走 POST /doctags remove 其余，与 doc-center 详情修复按钮同源语义。 */}
            {(() => {
              const sc = status?.statusCheck;
              if (!sc || sc.ok || !sc.all || sc.all.length <= 1) return null;
              const st = sc.all;
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", marginBottom: 6, border: "1px solid rgba(245,158,11,.4)", background: "rgba(245,158,11,.08)", borderRadius: 6, fontSize: 11 }}>
                  <span style={{ color: "#f59e09", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>⚠ {st.length} 个 方案/* 状态 tag（{st.join("、")}）</span>
                  <button
                    title={"保留「" + st[st.length - 1] + "」，移除 " + st.slice(0, -1).join("、") + "（POST /doctags 写回 front-matter）"}
                    onClick={() => {
                      apiPost("/doctags", { session: getSessionId(), remove: st.slice(0, -1), add: [] })
                        .then((r) => { if (r && r.ok) refresh(); })
                        .catch(() => { });
                    }}
                    style={{ marginLeft: "auto", flexShrink: 0, padding: "2px 8px", borderRadius: 6, fontSize: 10.5, fontWeight: 700, cursor: "pointer", border: "1px solid rgba(245,158,11,.5)", background: "transparent", color: "#f59e09" }}
                  >修复</button>
                </div>
              );
            })()}
            <div style={{ color: "#3fb950", fontSize: 11 }}>
              {isFinalPlanPhase(status?.statusCheck?.phase)
                ? t("pf.boundDoneHint", { phase: status?.statusCheck?.phase })
                : t("pf.boundHint")}
            </div>
            {status?.muted ? <div style={warnStyle}>{t("pf.muted")}</div> : null}
          </>
        ) : (
          <>
            <RemindBanner tone="info" icon="◇" title={t("pf.unboundTitle")} />
            <div style={dimStyle}>{t("pf.unboundHint")}</div>
            {/* 体验优化：未绑定异步展示识别到的候选文档（/status candidates，来自最近向导识别），
                每行一键绑定；无候选时主按钮即「绑定文档…」→ 更多文档选择器 */}
            {status?.candidates?.length ? (
              <>
                <div style={{ ...dimStyle, marginTop: 2 }}>{t("pf.candidatesCap")}</div>
                <CandidateList items={status.candidates} onBind={onBind} onOpen={onOpenMd} />
              </>
            ) : null}
            <div style={rowStyle}>
              <Btn kind="pri" onClick={onPick}>{status?.candidates?.length ? t("pf.moreDocs") : t("pf.bindAction")}</Btn>
              {status?.muted ? <span style={warnStyle}>{t("pf.muted")}</span> : null}
            </div>
          </>
        )}
      </div>
      <div style={ddFooter}>
        <SloganBar onSlogan={onSlogan} onEditPrompt={onEditPrompt} />
        <span style={{ flex: 1 }} />
      </div>
    </>
  );
}

// ---------- md 选择器视图（自拉取：搜索 + tag 过滤；结合 aiti-doc-center tags/全文检索） ----------
// 行动作：文件名可点（openFile 打开标签页）、@ 可点（appendText 插入 @rel）、「设为方案」绑定。

function PickView(props: { onBind: (abs: string, rel?: string) => void; onBack: () => void; onOpen: (f: any) => void; onAt: (f: any) => void }): any {
  const { onBind, onBack, onOpen, onAt } = props;
  const [files, setFiles] = useState<any[]>([]);
  const [tagList, setTagList] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<any>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = (qq: string, tt: string) => {
    setLoading(true);
    // cwd：新会话（尚无 canonical sessionId）用宿主下发的新会话 cwd —— 否则列不出项目 md
    apiPost("/md-files", { session: getSessionId(), cwd: getCwd() || getNewSessionCwd(), q: qq, tag: tt })
      .then((r) => setFiles(r?.files ?? []))
      .catch(() => setFiles([]))
      .then(() => setLoading(false));
  };

  useEffect(() => {
    // 打开即拉全量 + 可用 tag 词表（doc-center）+ 聚焦搜索框（选文档即搜）
    load("", "");
    apiGet("/md-tags").then((r) => setTagList(r?.tags ?? [])).catch(() => setTagList([]));
    try { inputRef.current?.focus(); } catch { }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInput = (e: any) => {
    const v = e.currentTarget?.value ?? "";
    setQ(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => load(v, tag), 250);
  };
  const onTag = (k: string) => {
    const next = k === tag ? "" : k;
    setTag(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => load(q, next), 120);
  };

  return (
    // 弹性布局：搜索行 + tag 行固定高，列表吃满面板剩余高度（面板 tall maxHeight 见 dropdownStyle）
    <div style={{ padding: "8px 12px 10px", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 6, boxSizing: "border-box" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
        <button
          onClick={onBack}
          title={t("pf.back")}
          aria-label={t("pf.back")}
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", color: "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap" }}
        >← {t("pf.back")}</button>
        <span style={{ fontSize: 11.5, color: "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap" }}>{t("pf.pick")}</span>
        <input
          ref={inputRef}
          value={q}
          onChange={onInput}
          placeholder={t("pf.searchPh")}
          style={{ ...searchInputStyle, marginBottom: 0, flex: 1, minWidth: 0 }}
        />
      </div>
      {tagList.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, flexShrink: 0 }}>
          {tagList.slice(0, 30).map((tg: any) => (
            <button
              key={tg.key}
              onClick={() => onTag(tg.key)}
              title={(tg.display || tg.key) + (tg.count ? `（${tg.count}）` : "")}
              style={{
                ...tagChipStyle,
                cursor: "pointer", borderColor: tag === tg.key ? "var(--accent, #4c7dd0)" : "var(--border)",
                color: tag === tg.key ? "var(--accent, #4c7dd0)" : "inherit", fontWeight: tag === tg.key ? 600 : 400,
              }}
            >{tg.display || tg.key}</button>
          ))}
        </div>
      ) : null}
      {loading ? <div style={{ ...dimStyle, flexShrink: 0 }}>{t("pf.searching")}</div> : null}
      {!loading && files.length === 0 ? <div style={{ ...dimStyle, padding: "6px 2px" }}>{t("pf.noMatch")}</div> : null}
      <div style={{ flex: "1 1 auto", minHeight: 140, overflowY: "auto" }}>
        {files.map((f: any, i: number) => (
          <div
            key={f.abs || i}
            style={{ ...mdRowStyle, flexWrap: "wrap" }}
            onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.background = "transparent"; }}
          >
            {f.session ? (
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#3fb950" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                <title>{t("pf.sessionTouched")}</title>
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            ) : null}
            <button
              onClick={() => onOpen(f)}
              title={(f.session ? t("pf.sessionTouched") + " · " : "") + f.rel + (f.abs ? "\n" + f.abs : "") + "\n" + t("pf.openFileTip")}
              style={{ ...mdPathStyle, background: "none", border: "none", padding: 0, font: "inherit", fontSize: 12, cursor: "pointer", color: f.session ? "var(--text)" : "var(--text-dim)", textDecoration: "underline dotted", textUnderlineOffset: 3 }}
            >{f.rel}</button>
            {(f.tags || []).map((tg2: string) => (
              <span key={tg2} style={{ ...tagChipStyle, fontSize: 10, padding: "0 6px", background: "var(--bg)", color: "var(--text-dim)" }}>#{tg2}</span>
            ))}
            <button
              onClick={() => onAt(f)}
              title={t("pf.atTip")}
              aria-label={t("pf.atTip")}
              style={{ ...atBtnStyle, flexShrink: 0, fontSize: 11, padding: "0 6px" }}
            >@</button>
            <Btn small onClick={() => onBind(f.abs, f.rel)}>{t("pf.bind")}</Btn>
          </div>
        ))}
      </div>
    </div>
  );
}
