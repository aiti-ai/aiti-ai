/**
 * agent-manager-client — 统一 Agent 管理面板（零构建原生 h()；docs/aiti-codebuddy-agent-plan.md §9）。
 *
 * 列表 = 服务端 GET /agents 聚合（authState/flowState/modes/installed/accounts）；
 * 行操作经 /ctl/{agent}/{action} 代理到各扩展既有 /login/*（本面板不实现任何登录协议）；
 * 账号档（备份/切换/登出）走本扩展 /accounts/{agent}/{action}——单文件存储，服务端实现，
 * 登录/切换/登出前的当前状态由服务端自动存 _auto-* 保险档。
 * 样式：自持样式层 agent-manager-styles.mjs（am-* 类，config-button 设计语言 + 主题 var 跟随）。
 * 打开期间 3s 轮询（§3.6 拍板例外：弹窗打开期间的登录状态轮询）；操作后立即刷新（refreshNonce）。
 *
 * export default function register(ctx) { registerAgentManagerClient(ctx, { extId: "aiti-agent-manager" }); }
 */

import { ensureStyles } from "./agent-manager-styles.mjs";

/** 自动保险档别名 → 展示名（服务端在各覆盖性操作前自动生成）。 */
const AUTO_LABEL = {
  "_auto-before-switch": "自动·切换前",
  "_auto-before-login": "自动·登录前",
  "_auto-before-logout": "自动·登出前",
};

/** 过期时间戳（ms）→ 本地短日期（YYYY-MM-DD）。 */
function fmtDate(ms) {
  try { return new Date(ms).toLocaleDateString(); } catch { return String(ms); }
}

/** 数字千分位（最多 2 位小数）。 */
function fmtNum(n) {
  try { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); } catch { return String(n); }
}

/** 额度 chip 文案（display 优先；否则 剩余/总量 归一）。 */
function quotaText(q) {
  if (typeof q.display === "string" && q.display.trim()) return q.display.trim();
  const unit = q.unit ?? "";
  if (q.remaining !== undefined && q.total !== undefined) return `额度 ${fmtNum(q.remaining)} / ${fmtNum(q.total)} ${unit}`.trim();
  if (q.remaining !== undefined) return `额度 剩余 ${fmtNum(q.remaining)} ${unit}`.trim();
  if (q.usedPercent !== undefined) return `额度 剩余 ${fmtNum(100 - q.usedPercent)}%`;
  return "额度";
}

/** 额度 tooltip（分包明细 + 更新时间）。 */
function quotaTitle(q) {
  const pkgs = (q.packages ?? []).map((p, i) => {
    const name = p.name ?? `包${i + 1}`;
    if (p.remaining !== undefined && p.total !== undefined) return `${name}：${fmtNum(p.remaining)} / ${fmtNum(p.total)} ${p.unit ?? q.unit ?? ""}`.trim();
    if (p.usedPercent !== undefined) return `${name}：已用 ${fmtNum(p.usedPercent)}%`;
    if (p.remaining !== undefined) return `${name}：剩余 ${fmtNum(p.remaining)} ${p.unit ?? q.unit ?? ""}`.trim();
    return p.note ? `${name}：${p.note}` : name;
  }).join("\n");
  const extra = q.note ? `\n${q.note}` : "";
  return `额度（点击刷新）${pkgs ? "\n" + pkgs : ""}${extra}\n更新于 ${new Date(q.fetchedAt).toLocaleTimeString()}`;
}

export function registerAgentManagerClient(ctx, config) {
  ensureStyles(); // 自持样式层（am-* 类）：register 即注入，先于任何 UI 渲染
  const h = (...a) => ctx.h(...a);
  const useState = (v) => ctx.useState(v);
  const useEffect = (fn, deps) => ctx.useEffect(fn, deps);
  const api = (p, init) => fetch(ctx.apiUrl("/api/extensions/" + config.extId + p), { cache: "no-store", ...init });
  const jsonInit = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  ctx.registerItems("toolbar", [{
    id: `${config.extId}-panel`,
    meta: {
      label: "Agent 管理",
      title: "Agent 管理（统一登录态）",
      icon: "icons/bot.svg",
      onClick: () => requestOpen(),
    },
  }]);
  ctx.registerItems("dialogs", [{
    id: `${config.extId}-panel-dialog`,
    render: () => h(AgentManagerPanel),
  }]);

  let moduleSetOpen = null;
  // 懒加载（clientImmediately:false）下 toolbar 静态条目点击时面板组件可能尚未挂载：
  // 记 pending，挂载 effect 消费——避免首点失效。
  let pendingOpen = false;
  function requestOpen() {
    if (moduleSetOpen) moduleSetOpen(true);
    else pendingOpen = true;
  }

  // ── 稳定子组件（定义提升到 register 作用域，⚠ 勿移回 AgentManagerPanel 内！）──
  // 2026-09-13 焦点窃取事故：子组件内联定义在父组件函数体内时，父组件每次渲染都会生成
  // 新的函数身份，React diff 视为「不同组件类型」→ 整个子树卸载重建——账号档输入框在
  // 3s 轮询 setData / 每次按键 setState / 宿主重渲染时被反复销毁重建（focusout + DOM removed），
  // 焦点不断被“窃取”、无法连续输入。提升到此处（register 仅执行一次 → 身份跨渲染稳定），
  // 状态与回调经 props 传入。

  /** 账号档面板：只列已保存的档（切换·删除）；新增保存入口在「当前登录」行。 */
  function AccountPanel({ agent, accounts, busy, actAccounts, setNotice, confirmDel, setConfirmDel }) {
    return h("div", { className: "am-accounts" },
      h("div", { className: "am-accounts-title" },
        "账号档",
        h("span", { className: "am-acc-chip" }, `${accounts.length} 个`),
      ),
      h("div", { className: "am-hint" },
        "这里只列已保存的账号档（供切换 / 删除）；新增保存用上方「当前登录」旁的「保存为账号档…」；登录 / 切换前旧状态自动存 _auto-before-* 保险档。"),
      accounts.length === 0
        ? h("div", { className: "am-empty" }, "暂无账号档——先保存当前登录，或直接登录新账号")
        : h("div", { className: "am-acc-list" }, ...accounts.map((acc) => h(AccountRow, { key: acc.alias, acc, agent, busy, actAccounts, setNotice, confirmDel, setConfirmDel }))),
    );
  }

  /** 账号档行：别名/账号信息（user+uin+有效期）/凭据数/保存日 + 切换/删除（删除二次确认）。 */
  function AccountRow({ acc, agent, busy, actAccounts, setNotice, confirmDel, setConfirmDel }) {
    const label = AUTO_LABEL[acc.alias] ?? acc.alias;
    const delPending = confirmDel && confirmDel.agent === agent && confirmDel.alias === acc.alias;
    const name = acc.user ?? acc.note;
    const who = name ? `账号 ${name}${acc.uin ? `（uin ${acc.uin}）` : ""}` : null;
    const expiry = typeof acc.expiresAt === "number" ? `有效期至 ${fmtDate(acc.expiresAt)}` : null;
    const meta = [who, expiry, `${acc.slotCount} 项凭据`, `保存于 ${fmtDate(acc.savedAt)}`].filter(Boolean).join(" · ");
    return h("div", { className: "am-acc-item" + (acc.current ? " is-current" : "") },
      h("span", { className: "am-acc-label" + (acc.auto ? " is-auto" : "") }, label),
      acc.current && h("span", { className: "am-acc-chip is-current" }, "当前"),
      h("span", { className: "am-acc-meta", title: meta }, meta),
      h("div", { className: "am-acc-actions" },
        !acc.current && h("button", {
          className: "am-btn is-sm",
          disabled: busy === `${agent}:accounts-switch`,
          title: "恢复该账号档到本机登录位置（当前状态若未存档会先自动存 _auto-before-switch）",
          onClick: async () => {
            const d = await actAccounts(agent, "switch", { alias: acc.alias }, `已切换到「${label}」：新会话生效（旧会话保持原账号）`);
            if (d?.autoSaved) setNotice({ ok: true, text: `已切换到「${label}」；切换前状态已自动存为「${AUTO_LABEL["_auto-before-switch"]}」` });
          },
        }, busy === `${agent}:accounts-switch` ? "切换中…" : "切换"),
        h("button", {
          className: "am-btn is-sm" + (delPending ? " is-danger" : ""),
          disabled: busy === `${agent}:accounts-remove`,
          onClick: () => {
            if (delPending) {
              setConfirmDel(null);
              void actAccounts(agent, "remove", { alias: acc.alias }, `已删除账号档「${label}」`);
            } else {
              setConfirmDel({ agent, alias: acc.alias });
              setTimeout(() => setConfirmDel((cur) => (cur && cur.agent === agent && cur.alias === acc.alias ? null : cur)), 2500);
            }
          },
        }, delPending ? "确认删除？" : "删除"),
      ),
    );
  }

  /** CodeBuddy API Key 表单（内部 useState 自持；组件身份稳定 → 输入不被打断）。 */
  function KeyForm({ agent, onDone, call: callFn }) {
    const [apiKey, setApiKey] = useState("");
    const [authToken, setAuthToken] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    return h("div", { className: "am-subpanel" },
      h("input", { className: "am-input", placeholder: "CODEBUDDY_API_KEY（平台个人 key）", value: apiKey, onInput: (e) => setApiKey(e?.target?.value ?? "") }),
      h("input", { className: "am-input", placeholder: "CODEBUDDY_AUTH_TOKEN（可选，优先级更高）", value: authToken, onInput: (e) => setAuthToken(e?.target?.value ?? "") }),
      h("input", { className: "am-input", placeholder: "CODEBUDDY_BASE_URL（可选，第三方网关）", value: baseUrl, onInput: (e) => setBaseUrl(e?.target?.value ?? "") }),
      h("div", { className: "am-actions is-end" },
        h("button", { className: "am-btn", onClick: onDone }, "收起"),
        h("button", {
          className: "am-btn is-primary",
          disabled: !apiKey.trim() && !authToken.trim() && !baseUrl.trim(),
          onClick: async () => { await callFn(`${agent}:set-key`, `/ctl/${agent}/set-key`, jsonInit({ apiKey, authToken, baseUrl })); onDone(); },
        }, "保存（空串=清除该字段）"),
      ),
    );
  }

  function AgentManagerPanel() {
    const [open, setOpen] = useState(false);
    const [data, setData] = useState(null);       // /agents 响应
    const [reqError, setReqError] = useState(null);
    const [notice, setNotice] = useState(null);   // 操作结果反馈 {ok, text}
    const [busy, setBusy] = useState(null);        // 进行中动作 key（`${agent}:${action}`）
    const [keyForm, setKeyForm] = useState(null);  // codebuddy apikey 表单 {agent} | null
    const [accOpen, setAccOpen] = useState(null);  // 展开账号档的 agent
    const [saveForm, setSaveForm] = useState(null); // {agent, alias} 保存账号档弹窗
    const [pasteCode, setPasteCode] = useState({}); // {agent: code}
    const [refreshNonce, setRefreshNonce] = useState(0);
    const [confirmDel, setConfirmDel] = useState(null);      // {agent, alias} 删除账号档二次确认
    const [confirmLogout, setConfirmLogout] = useState(null); // agent 登出二次确认

    useEffect(() => {
      moduleSetOpen = setOpen;
      if (pendingOpen) { pendingOpen = false; setOpen(true); }
      return () => { if (moduleSetOpen === setOpen) moduleSetOpen = null; };
    }, []);

    // 打开期间 3s 轮询聚合状态（弹窗期例外）；关闭即停；refreshNonce 变化 = 操作后立即刷新
    useEffect(() => {
      if (!open) return;
      let stopped = false;
      let timer = null;
      const tick = async () => {
        try {
          const r = await api("/agents");
          const d = await r.json();
          if (!stopped && d?.agents) { setData(d); setReqError(null); }
        } catch { /* 网络抖动忽略 */ }
        if (!stopped) timer = setTimeout(tick, 3000);
      };
      tick();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [open, refreshNonce]);

    const refresh = () => setRefreshNonce((n) => n + 1);

    async function call(actionKey, p, init) {
      setBusy(actionKey);
      setReqError(null);
      let d = null;
      try {
        const r = await api(p, init);
        d = await r.json();
        if (d && d.error) setReqError(`${actionKey}: ${d.error}`);
      } catch (e) {
        setReqError(`${actionKey}: ${e?.message || e}`);
      }
      setBusy(null);
      return d;
    }
    const ctl = (agent, action, body) => call(`${agent}:${action}`, `/ctl/${agent}/${action}`, jsonInit(body ?? {}));

    /** 直接打开 aiti-cmd 终端面板渲染指定会话（svc 优先；懒加载时先物化；兼容旧全局兑底）。 */
    async function openCmdTerminal(sid, title) {
      const key = "aiti-cmd.open-session";
      let svc = ctx.getExtService?.(key);
      if (typeof svc !== "function" && typeof ctx.ensureMaterialized === "function") {
        try { await ctx.ensureMaterialized("aiti-cmd"); } catch { /* 未部署等 */ }
        svc = ctx.getExtService?.(key);
      }
      if (typeof svc === "function") { try { svc(sid, title); return true; } catch { /* 下落 */ } }
      const legacy = typeof window !== "undefined" ? window.__aitiCmd?.openSession : null;
      if (typeof legacy === "function") { legacy(sid, title); return true; }
      return false;
    }

    /** 账号档动作（本扩展 /accounts/*）：成功 → 绿色反馈 + 立即刷新。 */
    async function actAccounts(agent, action, body, okText) {
      const d = await call(`${agent}:accounts-${action}`, `/accounts/${agent}/${action}`, jsonInit(body ?? {}));
      if (d && !d.error) { setNotice({ ok: true, text: okText }); refresh(); }
      else if (d?.error) setNotice({ ok: false, text: `${action} 失败：${d.error}` });
      return d;
    }

    /** 登出（二次确认；服务端先自动存 _auto-before-logout 保险档再清凭据）。 */
    function handleLogout(agent) {
      if (confirmLogout !== agent) {
        setConfirmLogout(agent);
        setTimeout(() => setConfirmLogout((cur) => (cur === agent ? null : cur)), 2500);
        return;
      }
      setConfirmLogout(null);
      void actAccounts(agent, "logout", {}, "已登出：本机凭据已清（保险档保留在账号档列表）");
    }

    if (!open) return null;
    const agents = data?.agents ?? [];

    return h(
      "div",
      { className: "am-panel", "data-ext-float": "1", "data-ext-float-w": "560", "data-ext-float-h": "460" },
      h("div", { className: "am-head" },
        h("b", { className: "am-title" }, "Agent 管理"),
        h("span", { className: "am-head-sub" }, "统一登录态 · 账号档"),
        h("span", { className: "am-spacer" }),
        h("button", { className: "am-btn is-ghost is-sm", onClick: () => setOpen(false), title: "关闭" }, "✕"),
      ),
      h("div", { className: "am-body" },
        reqError && h("div", { className: "am-error" }, reqError),
        notice && h("div", { className: "am-notice" }, notice.text),
        !agents.length && h("div", { className: "am-empty" }, "加载中…"),
        ...agents.map((a) => hAgentRow(a)),
        hPiHost(data?.piHost),
        h("div", { className: "am-foot" },
          "登录操作代理到各扩展既有 /login/* 端点；账号档存于 configDir/agent-accounts.json（备份加密）。CodeBuddy 浏览器 OAuth 的终端渲染在 aiti-cmd 面板（sid 共享，可一键打开）。"),
      ),
      // 保存账号档弹窗（命名后提交；紧跟「当前登录」的保存入口）
      saveForm && h("div", { className: "am-modal-mask", onClick: () => setSaveForm(null) },
        h("div", { className: "am-modal", onClick: (e) => e.stopPropagation() },
          h("div", { className: "am-accounts-title" }, "保存为账号档"),
          h("div", { className: "am-hint" }, `把「${saveForm.agent}」当前登录保存为账号档，起个别名便于日后切换与识别。`),
          h("input", {
            className: "am-input", autoFocus: true, placeholder: "别名（如 主账号 / 团队号 / 客户A）",
            value: saveForm.alias,
            onInput: (e) => setSaveForm((f) => (f ? { ...f, alias: e?.target?.value ?? "" } : f)),
            onKeyDown: (e) => {
              if (e?.key === "Enter") void saveNow();
              else if (e?.key === "Escape") setSaveForm(null);
            },
          }),
          h("div", { className: "am-actions is-end" },
            h("button", { className: "am-btn", onClick: () => setSaveForm(null) }, "取消"),
            h("button", {
              className: "am-btn is-primary",
              disabled: !saveForm.alias.trim() || busy === `${saveForm.agent}:accounts-save`,
              onClick: () => void saveNow(),
            }, busy === `${saveForm.agent}:accounts-save` ? "保存中…" : "保存"),
          ),
        ),
      ),
    );

    // §9.5 步 5：pi 宿主订阅 provider（auth.json 只读，无 provider 时整组隐藏）
    function hPiHost(piHost) {
      if (!Array.isArray(piHost) || piHost.length === 0) return null;
      return h(
        "div",
        { className: "am-row" },
        h("div", { className: "am-meta", style: { marginBottom: 4 } }, "pi 宿主订阅（模型向导 OAuth，只读展示）"),
        ...piHost.map((p) => h("div", { key: p.provider, className: "am-acc-item" },
          h("b", { className: "am-acc-label" }, p.provider),
          p.user && h("span", { className: "am-acc-meta" }, p.user),
          h("span", { className: "am-spacer" }),
          p.expired === true
            ? h("span", { className: "am-acc-chip", style: { color: "#d97706", borderColor: "rgba(217,119,6,.4)" } }, "token 已过期，重新登录可续期")
            : h("span", { className: "am-acc-chip is-current" }, "已授权"),
        )),
      );
    }

    function badge(authState, flowState) {
      if (flowState === "logging-in") return h("span", { className: "am-badge is-logging" }, "登录中");
      if (authState === "ready") return h("span", { className: "am-badge is-ready" }, "已登录");
      if (authState === "missing") return h("span", { className: "am-badge is-missing" }, "未登录");
      return h("span", { className: "am-badge is-unknown" }, "未知");
    }

    // 保存账号档弹窗的提交
    async function saveNow() {
      const f = saveForm;
      const alias = (f?.alias ?? "").trim();
      if (!f || !alias) return;
      const d = await actAccounts(f.agent, "save", { alias }, `已保存账号档「${alias}」`);
      if (d && !d.error) setSaveForm(null);
    }

    function hAgentRow(a) {
      const key = a.agent;
      const isCb = a.agent === "codebuddy";
      const ext = a.ext ?? {};
      const accounts = a.accounts ?? [];
      const hasContent = a.hasContent === true;
      const tuiActive = Boolean(a.tui?.tuiSid);
      return h(
        "div",
        { key, className: "am-row" },
        h("div", { className: "am-row-head" },
          h("span", { className: "am-name" }, a.label),
          badge(a.authState, a.flowState),
          a.authSource === "fs" && h("span", { className: "am-flag" }, "（探测）"),
          h("span", { className: "am-spacer" }),
          !a.installed && h("span", { className: "am-flag" }, "扩展未部署"),
        ),
        h("div", { className: "am-meta" },
          "登录形态：" + (a.modes ?? []).map((m) => ({ url: "授权链接", paste: "粘贴 code", apikey: "API Key", tui: "浏览器 OAuth" }[m] ?? m)).join(" / ")
          + (a.dependencyHint ? ` · 依赖：${a.dependencyHint}` : "")),
        // 当前登录：展示账号/过期 + 保存入口紧贴（新增档从这里存，账号档卡片只列已存的）
        (ext?.account?.user || hasContent) && h("div", { className: "am-acct-line " + (ext?.account?.expired ? "is-warn" : "is-ok") },
          ext?.account?.user
            ? `CLI 登录账号：${ext.account.user}${ext.account.uin ? `（uin ${ext.account.uin}）` : ""}`
              + (ext.account.expired
                ? " · 已过期，请在 CLI 内重新登录"
                : ext.account.expiresAt ? ` · 有效期至 ${fmtDate(ext.account.expiresAt)}` : "")
            : "当前登录：已检测到本机凭据",
          hasContent && h("button", {
            className: "am-btn is-sm", style: { marginLeft: 8 },
            title: "把当前本机登录保存为账号档（起别名）",
            onClick: () => setSaveForm({ agent: key, alias: "" }),
          }, "保存为账号档…"),
          // 官方账号额度（descriptor.accountQuota；点击强制刷新）
          a.quota?.available === true && h("button", {
            className: "am-btn is-ghost is-sm", style: { marginLeft: 8 },
            title: quotaTitle(a.quota),
            onClick: async () => {
              const r = await fetch(ctx.apiUrl(`/api/extensions/${config.extId}/quota/${key}?force=1`), { cache: "no-store" });
              const d = await r.json().catch(() => null);
              if (d && d.error) setNotice({ ok: false, text: d.error });
              refresh();
            },
          }, quotaText(a.quota)),
          a.quota?.available === false && a.quota.reason === "fetch-failed" && h("span", {
            className: "am-flag", style: { marginLeft: 8 },
            title: `额度查询失败：${a.quota.error ?? ""}`,
          }, "额度查询失败"),
        ),
        // ── 操作条 1：登录 / 授权 ──
        h("div", { className: "am-actions" },
          !isCb && (a.modes ?? []).includes("url") && h("button",
            { className: "am-btn", disabled: busy === `${key}:start`, onClick: () => ctl(key, "start") },
            busy === `${key}:start` ? "发起中…" : "登录"),
          !isCb && (a.modes ?? []).includes("paste") && h("button",
            { className: "am-btn", disabled: busy === `${key}:start`, onClick: () => ctl(key, "start") },
            busy === `${key}:start` ? "发起中…" : "登录"),
          !isCb && h("button", { className: "am-btn", disabled: busy === `${key}:cancel`, onClick: () => ctl(key, "cancel") }, "取消"),
          !isCb && (a.modes ?? []).includes("paste") && h("span", { className: "am-inline" },
            h("input", {
              className: "am-input", placeholder: "粘贴授权完成页 code（或回调链接）",
              value: pasteCode[key] ?? "",
              onInput: (e) => setPasteCode({ ...pasteCode, [key]: e?.target?.value ?? "" }),
            }),
            h("button", {
              className: "am-btn is-primary",
              disabled: !(pasteCode[key] ?? "").trim() || busy === `${key}:submit`,
              onClick: () => ctl(key, "submit", { code: pasteCode[key] }),
            }, "提交"),
          ),
          isCb && h("button", { className: "am-btn" + (keyForm === key ? " is-primary" : ""), onClick: () => setKeyForm(keyForm === key ? null : key) }, "API Key…"),
          isCb && h("button", {
            className: "am-btn",
            disabled: busy === `${key}:tui-start`,
            title: "发起新的浏览器 OAuth 登录（会覆盖 CLI 当前登录；覆盖前自动存 _auto-before-login 保险档）",
            onClick: async () => {
              const d = await ctl(key, "tui-start");
              if (d && !d.error) {
                setNotice({ ok: true, text: d.backupDir ? "OAuth 已发起：旧登录已备份并暂离（随时可从「账号档」切回）；完成后把新账号存档起别名" : "OAuth 已发起：完成登录后到「账号档」把新账号存档并起别名" });
                // 直接打开 aiti-cmd 终端面板（浏览器 OAuth 的交互面在该面板里）
                if (d.sid) { const okOpen = await openCmdTerminal(d.sid, "cbc-login"); if (!okOpen) setNotice({ ok: false, text: "OAuth 已发起，但未能打开 aiti-cmd 终端面板（未部署/未加载）" }); }
              }
            },
          }, busy === `${key}:tui-start` ? "发起中…" : "浏览器 OAuth"),
          isCb && h("button", {
            className: "am-btn",
            disabled: busy === `${key}:tui-cancel` || !tuiActive,
            title: tuiActive ? "终止进行中的 OAuth 登录会话" : "当前无进行中的 OAuth 登录",
            onClick: async () => {
              const d = await ctl(key, "tui-cancel");
              if (d && !d.error) { setNotice({ ok: true, text: "已取消 OAuth 登录会话" }); refresh(); }
            },
          }, "取消 OAuth"),
        ),
        // ── 操作条 2：账号档 / 登出（右对齐） ──
        a.installed && h("div", { className: "am-actions is-end" },
          h("button", {
            className: "am-btn" + (accOpen === key ? " is-primary" : ""),
            onClick: () => setAccOpen(accOpen === key ? null : key),
            title: "多账号备份 / 切换",
          }, accOpen === key ? "收起账号档" : `账号档${accounts.length ? `（${accounts.length}）` : "…"}`),
          h("button", {
            className: "am-btn" + (confirmLogout === key ? " is-danger" : ""),
            disabled: busy === `${key}:accounts-logout` || !hasContent,
            title: hasContent
              ? "清空本机当前登录凭据（自动先存 _auto-before-logout 保险档）"
              : "当前无登录态可登出",
            onClick: () => handleLogout(key),
          }, confirmLogout === key ? "确认登出？" : "登出"),
        ),
        // 流程错误（失败/超时）透传展示——等价退役的扩展内登录弹窗 error 行
        ext?.error && h("div", { className: "am-error" }, String(ext.error)),
        // URL 展示（A url-only 模式：ext.url 由聚合透传）
        ext?.url && h("div", { className: "am-url-line" },
          h("a", { className: "am-url", href: ext.url, target: "_blank", rel: "noreferrer" }, ext.url.slice(0, 90) + (ext.url.length > 90 ? "…" : "")),
          h("button", { className: "am-btn is-ghost is-sm", onClick: () => { try { navigator.clipboard?.writeText(ext.url); } catch { /* 无剪贴板权限 */ } } }, "复制"),
        ),
        // codebuddy TUI OAuth 状态行
        isCb && a.tui?.tuiSid && h("div", { className: "am-tui-line" },
          `OAuth ${a.tui.tuiState ?? "waiting"} · 终端会话 ${a.tui.tuiSid}`,
          h("button", {
            className: "am-btn is-sm",
            style: { marginLeft: 6 },
            title: "在 aiti-cmd 终端面板中打开该会话（共享 sid）",
            onClick: async () => {
              const okOpen = await openCmdTerminal(a.tui.tuiSid, "cbc-login");
              if (!okOpen) setNotice({ ok: false, text: "未能打开 aiti-cmd 终端面板（未部署/未加载）" });
            },
          }, "打开终端"),
          a.tui.tuiUrl && h("a", { href: a.tui.tuiUrl, target: "_blank", rel: "noreferrer" }, "打开授权页"),
        ),
        // codebuddy apikey 表单
        isCb && keyForm === key && h(KeyForm, { agent: key, onDone: () => setKeyForm(null), call }),
        // 账号档面板（所有 agent 一致）
        accOpen === key && h(AccountPanel, {
          agent: key, accounts,
          busy, actAccounts, setNotice, confirmDel, setConfirmDel,
        }),
      );
    }

  }
}

export default function register(ctx) {
  registerAgentManagerClient(ctx, { extId: "aiti-agent-manager" });
}
