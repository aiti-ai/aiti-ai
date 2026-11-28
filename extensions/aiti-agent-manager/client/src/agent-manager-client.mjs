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

/** Auto insurance-tier alias → display entry key (resolved via t(); used inside the register scope). */
const AUTO_LABEL = {
  "_auto-before-switch": "am.autoSwitch",
  "_auto-before-login": "am.autoLogin",
  "_auto-before-logout": "am.autoLogout",
};

/** 过期时间戳（ms）→ 本地短日期（YYYY-MM-DD）。 */
function fmtDate(ms) {
  try { return new Date(ms).toLocaleDateString(); } catch { return String(ms); }
}

/** 数字千分位（最多 2 位小数）。 */
function fmtNum(n) {
  try { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); } catch { return String(n); }
}

/** Quota chip label (display first; otherwise remaining/total normalized). t is injected by the caller (register scope). */
function quotaText(t, q) {
  if (typeof q.display === "string" && q.display.trim()) return q.display.trim();
  const unit = q.unit ?? "";
  if (q.remaining !== undefined && q.total !== undefined) return t("am.quota.remainingOf", { remaining: fmtNum(q.remaining), total: fmtNum(q.total), unit }).trim();
  if (q.remaining !== undefined) return t("am.quota.remaining", { remaining: fmtNum(q.remaining), unit }).trim();
  if (q.usedPercent !== undefined) return t("am.quota.usedPercent", { pct: fmtNum(100 - q.usedPercent) });
  return t("am.quota");
}

/** Quota tooltip (per-package breakdown + updated at). t is injected by the caller. */
function quotaTitle(t, q) {
  const pkgs = (q.packages ?? []).map((p, i) => {
    const raw = p.name ?? t("am.quota.pkgN", { n: i + 1 });
    // Package names are stable backend keys (qoder user_quota…, zcode five_hour…) — translate via i18n, fall back to the raw name.
    const nameKey = `am.quota.pkg.${raw}`;
    const translated = t(nameKey);
    const name = !translated || translated === nameKey ? raw : translated;
    if (p.remaining !== undefined && p.total !== undefined) return t("am.quota.pkgRemainingOf", { name, remaining: fmtNum(p.remaining), total: fmtNum(p.total), unit: p.unit ?? q.unit ?? "" }).trim();
    if (p.usedPercent !== undefined) return t("am.quota.pkgUsed", { name, pct: fmtNum(p.usedPercent) });
    if (p.remaining !== undefined) return t("am.quota.pkgRemaining", { name, remaining: fmtNum(p.remaining), unit: p.unit ?? q.unit ?? "" }).trim();
    return p.note ? t("am.quota.pkgNote", { name, note: p.note }) : name;
  }).join("\n");
  const extra = q.note ? `\n${q.note}` : "";
  return t("am.quota.title", { pkgs, extra, time: new Date(q.fetchedAt).toLocaleTimeString() });
}

export function registerAgentManagerClient(ctx, config) {
  ensureStyles(); // 自持样式层（am-* 类）：register 即注入，先于任何 UI 渲染
  const h = (...a) => ctx.h(...a);
  const useState = (v) => ctx.useState(v);
  const useEffect = (fn, deps) => ctx.useEffect(fn, deps);
  const api = (p, init) => fetch(ctx.apiUrl("/api/extensions/" + config.extId + p), { cache: "no-store", ...init });
  const jsonInit = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // i18n: host ctx.t (index.ts ui.i18n entries, zh/en tables); falls back to the bare key on old hosts without it
  const t = (k, p2) => { const fn = ctx.t; return typeof fn === "function" ? fn(k, p2) : k; };
  // Agent descriptors are provided by other extensions: their display fields may be
  // plain strings or { en, zh } pairs. Resolve with the live host locale.
  const locale = () => {
    try {
      const raw = typeof ctx.getLocale === "function" ? ctx.getLocale() : globalThis.localStorage?.getItem("pi-locale");
      return String(raw || "");
    } catch { return ""; }
  };
  const locText = (v) => {
    if (v && typeof v === "object") {
      const zh = locale().startsWith("zh");
      return String((zh ? v.zh ?? v.en : v.en ?? v.zh) ?? "");
    }
    return typeof v === "string" ? v : "";
  };

  ctx.registerItems("toolbar", [{
    id: `${config.extId}-panel`,
    meta: {
      label: "i18n:it.panel.label",
      title: "i18n:it.panel.title",
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
        t("am.accounts.title"),
        h("span", { className: "am-acc-chip" }, t("am.accounts.count", { n: accounts.length })),
      ),
      h("div", { className: "am-hint" },
        t("am.accounts.hint")),
      accounts.length === 0
        ? h("div", { className: "am-empty" }, t("am.accounts.empty"))
        : h("div", { className: "am-acc-list" }, ...accounts.map((acc) => h(AccountRow, { key: acc.alias, acc, agent, busy, actAccounts, setNotice, confirmDel, setConfirmDel }))),
    );
  }

  /** 账号档行：别名/账号信息（user+uin+有效期）/凭据数/保存日 + 切换/删除（删除二次确认）。 */
  function AccountRow({ acc, agent, busy, actAccounts, setNotice, confirmDel, setConfirmDel }) {
    const label = acc.alias.startsWith("_auto-") && AUTO_LABEL[acc.alias] ? t(AUTO_LABEL[acc.alias]) : acc.alias;
    const delPending = confirmDel && confirmDel.agent === agent && confirmDel.alias === acc.alias;
    const name = acc.user ?? acc.note;
    const who = name ? t("am.acc.who", { name, uin: acc.uin ? t("am.acc.uin", { uin: acc.uin }) : "" }) : null;
    const expiry = typeof acc.expiresAt === "number" ? t("am.acc.expiry", { date: fmtDate(acc.expiresAt) }) : null;
    const meta = [who, expiry, t("am.acc.slots", { n: acc.slotCount }), t("am.acc.savedAt", { date: fmtDate(acc.savedAt) })].filter(Boolean).join(" · ");
    return h("div", { className: "am-acc-item" + (acc.current ? " is-current" : "") },
      h("span", { className: "am-acc-label" + (acc.auto ? " is-auto" : "") }, label),
      acc.current && h("span", { className: "am-acc-chip is-current" }, t("am.acc.current")),
      h("span", { className: "am-acc-meta", title: meta }, meta),
      h("div", { className: "am-acc-actions" },
        !acc.current && h("button", {
          className: "am-btn is-sm",
          disabled: busy === `${agent}:accounts-switch`,
          title: t("am.acc.switchTip"),
          onClick: async () => {
            const d = await actAccounts(agent, "switch", { alias: acc.alias }, t("am.acc.switched", { label }));
            if (d?.autoSaved) setNotice({ ok: true, text: t("am.acc.switchedAuto", { label }) });
          },
        }, busy === `${agent}:accounts-switch` ? t("am.switching") : t("am.switch")),
        h("button", {
          className: "am-btn is-sm" + (delPending ? " is-danger" : ""),
          disabled: busy === `${agent}:accounts-remove`,
          onClick: () => {
            if (delPending) {
              setConfirmDel(null);
              void actAccounts(agent, "remove", { alias: acc.alias }, t("am.deleted", { label }));
            } else {
              setConfirmDel({ agent, alias: acc.alias });
              setTimeout(() => setConfirmDel((cur) => (cur && cur.agent === agent && cur.alias === acc.alias ? null : cur)), 2500);
            }
          },
        }, delPending ? t("am.confirmDelete") : t("am.delete")),
      ),
    );
  }

  /** CodeBuddy API Key 表单（内部 useState 自持；组件身份稳定 → 输入不被打断）。 */
  function KeyForm({ agent, onDone, call: callFn }) {
    const [apiKey, setApiKey] = useState("");
    const [authToken, setAuthToken] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    return h("div", { className: "am-subpanel" },
      h("input", { className: "am-input", placeholder: t("am.keyPh.apiKey"), value: apiKey, onInput: (e) => setApiKey(e?.target?.value ?? "") }),
      h("input", { className: "am-input", placeholder: t("am.keyPh.authToken"), value: authToken, onInput: (e) => setAuthToken(e?.target?.value ?? "") }),
      h("input", { className: "am-input", placeholder: t("am.keyPh.baseUrl"), value: baseUrl, onInput: (e) => setBaseUrl(e?.target?.value ?? "") }),
      h("div", { className: "am-actions is-end" },
        h("button", { className: "am-btn", onClick: onDone }, t("am.collapse")),
        h("button", {
          className: "am-btn is-primary",
          disabled: !apiKey.trim() && !authToken.trim() && !baseUrl.trim(),
          onClick: async () => { await callFn(`${agent}:set-key`, `/ctl/${agent}/set-key`, jsonInit({ apiKey, authToken, baseUrl })); onDone(); },
        }, t("am.keySave")),
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
      else if (d?.error) setNotice({ ok: false, text: t("am.actionFailed", { action, error: d.error }) });
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
      void actAccounts(agent, "logout", {}, t("am.loggedOut"));
    }

    if (!open) return null;
    const agents = data?.agents ?? [];

    return h(
      "div",
      { className: "am-panel", "data-ext-float": "1", "data-ext-float-w": "560", "data-ext-float-h": "460" },
      h("div", { className: "am-head" },
        h("b", { className: "am-title" }, t("am.title")),
        h("span", { className: "am-head-sub" }, t("am.subtitle")),
        h("span", { className: "am-spacer" }),
        h("button", { className: "am-btn is-ghost is-sm", onClick: () => setOpen(false), title: t("am.close") }, "✕"),
      ),
      h("div", { className: "am-body" },
        reqError && h("div", { className: "am-error" }, reqError),
        notice && h("div", { className: "am-notice" }, notice.text),
        !agents.length && h("div", { className: "am-empty" }, t("am.loading")),
        ...agents.map((a) => hAgentRow(a)),
        hPiHost(data?.piHost),
        h("div", { className: "am-foot" },
          t("am.foot")),
      ),
      // 保存账号档弹窗（命名后提交；紧跟「当前登录」的保存入口）
      saveForm && h("div", { className: "am-modal-mask", onClick: () => setSaveForm(null) },
        h("div", { className: "am-modal", onClick: (e) => e.stopPropagation() },
          h("div", { className: "am-accounts-title" }, t("am.saveAs")),
          h("div", { className: "am-hint" }, t("am.saveAsHint", { agent: saveForm.agent })),
          h("input", {
            className: "am-input", autoFocus: true, placeholder: t("am.aliasPh"),
            value: saveForm.alias,
            onInput: (e) => setSaveForm((f) => (f ? { ...f, alias: e?.target?.value ?? "" } : f)),
            onKeyDown: (e) => {
              if (e?.key === "Enter") void saveNow();
              else if (e?.key === "Escape") setSaveForm(null);
            },
          }),
          h("div", { className: "am-actions is-end" },
            h("button", { className: "am-btn", onClick: () => setSaveForm(null) }, t("am.cancel")),
            h("button", {
              className: "am-btn is-primary",
              disabled: !saveForm.alias.trim() || busy === `${saveForm.agent}:accounts-save`,
              onClick: () => void saveNow(),
            }, busy === `${saveForm.agent}:accounts-save` ? t("am.saving") : t("am.save")),
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
        h("div", { className: "am-meta", style: { marginBottom: 4 } }, t("am.piHost")),
        ...piHost.map((p) => h("div", { key: p.provider, className: "am-acc-item" },
          h("b", { className: "am-acc-label" }, p.provider),
          p.user && h("span", { className: "am-acc-meta" }, p.user),
          h("span", { className: "am-spacer" }),
          p.expired === true
            ? h("span", { className: "am-acc-chip", style: { color: "#d97706", borderColor: "rgba(217,119,6,.4)" } }, t("am.tokenExpired"))
            : h("span", { className: "am-acc-chip is-current" }, t("am.authorized")),
        )),
      );
    }

    function badge(authState, flowState) {
      if (flowState === "logging-in") return h("span", { className: "am-badge is-logging" }, t("am.badgeLogging"));
      if (authState === "ready") return h("span", { className: "am-badge is-ready" }, t("am.badgeReady"));
      if (authState === "missing") return h("span", { className: "am-badge is-missing" }, t("am.badgeMissing"));
      return h("span", { className: "am-badge is-unknown" }, t("am.badgeUnknown"));
    }

    // 保存账号档弹窗的提交
    async function saveNow() {
      const f = saveForm;
      const alias = (f?.alias ?? "").trim();
      if (!f || !alias) return;
      const d = await actAccounts(f.agent, "save", { alias }, t("am.saved", { alias }));
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
          h("span", { className: "am-name" }, locText(a.label)),
          badge(a.authState, a.flowState),
          a.authSource === "fs" && h("span", { className: "am-flag" }, t("am.flagProbe")),
          h("span", { className: "am-spacer" }),
          !a.installed && h("span", { className: "am-flag" }, t("am.flagNotDeployed")),
        ),
        h("div", { className: "am-meta" },
          t("am.modes", { modes: (a.modes ?? []).map((m) => ({ url: t("am.mode.url"), paste: t("am.mode.paste"), apikey: t("am.mode.apikey"), tui: t("am.mode.tui") }[m] ?? m)).join(" / ") })
          + (a.dependencyHint ? t("am.dependency", { hint: locText(a.dependencyHint) }) : "")),
        // 当前登录：展示账号/过期 + 保存入口紧贴（新增档从这里存，账号档卡片只列已存的）
        (ext?.account?.user || hasContent) && h("div", { className: "am-acct-line " + (ext?.account?.expired ? "is-warn" : "is-ok") },
          ext?.account?.user
            ? t("am.cliAccount", { user: ext.account.user, uin: ext.account.uin ? t("am.acc.uin", { uin: ext.account.uin }) : "", tail: ext.account.expired ? t("am.expiredCli") : ext.account.expiresAt ? t("am.validUntil", { date: fmtDate(ext.account.expiresAt) }) : "" })
            : t("am.detectedCreds"),
          hasContent && h("button", {
            className: "am-btn is-sm", style: { marginLeft: 8 },
            title: t("am.saveAsTip"),
            onClick: () => setSaveForm({ agent: key, alias: "" }),
          }, t("am.saveAsBtn")),
          // 官方账号额度（descriptor.accountQuota；点击强制刷新）
          a.quota?.available === true && h("button", {
            className: "am-btn is-ghost is-sm", style: { marginLeft: 8 },
            title: quotaTitle(t, a.quota),
            onClick: async () => {
              const r = await fetch(ctx.apiUrl(`/api/extensions/${config.extId}/quota/${key}?force=1`), { cache: "no-store" });
              const d = await r.json().catch(() => null);
              if (d && d.error) setNotice({ ok: false, text: d.error });
              refresh();
            },
          }, quotaText(t, a.quota)),
          a.quota?.available === false && a.quota.reason === "fetch-failed" && h("span", {
            className: "am-flag", style: { marginLeft: 8 },
            title: t("am.quotaFailTip", { error: a.quota.error ?? "" }),
          }, t("am.quotaFail")),
        ),
        // ── 操作条 1：登录 / 授权 ──
        h("div", { className: "am-actions" },
          !isCb && (a.modes ?? []).includes("url") && h("button",
            { className: "am-btn", disabled: busy === `${key}:start`, onClick: () => ctl(key, "start") },
            busy === `${key}:start` ? t("am.starting") : t("am.login")),
          !isCb && (a.modes ?? []).includes("paste") && h("button",
            { className: "am-btn", disabled: busy === `${key}:start`, onClick: () => ctl(key, "start") },
            busy === `${key}:start` ? t("am.starting") : t("am.login")),
          !isCb && h("button", { className: "am-btn", disabled: busy === `${key}:cancel`, onClick: () => ctl(key, "cancel") }, t("am.cancel")),
          !isCb && (a.modes ?? []).includes("paste") && h("span", { className: "am-inline" },
            h("input", {
              className: "am-input", placeholder: t("am.codePh"),
              value: pasteCode[key] ?? "",
              onInput: (e) => setPasteCode({ ...pasteCode, [key]: e?.target?.value ?? "" }),
            }),
            h("button", {
              className: "am-btn is-primary",
              disabled: !(pasteCode[key] ?? "").trim() || busy === `${key}:submit`,
              onClick: () => ctl(key, "submit", { code: pasteCode[key] }),
            }, t("am.submit")),
          ),
          isCb && h("button", { className: "am-btn" + (keyForm === key ? " is-primary" : ""), onClick: () => setKeyForm(keyForm === key ? null : key) }, "API Key…"),
          isCb && h("button", {
            className: "am-btn",
            disabled: busy === `${key}:tui-start`,
            title: t("am.oauthStartTip"),
            onClick: async () => {
              const d = await ctl(key, "tui-start");
              if (d && !d.error) {
                setNotice({ ok: true, text: d.backupDir ? t("am.oauthStartedBackup") : t("am.oauthStarted") });
                // 直接打开 aiti-cmd 终端面板（浏览器 OAuth 的交互面在该面板里）
                if (d.sid) { const okOpen = await openCmdTerminal(d.sid, "cbc-login"); if (!okOpen) setNotice({ ok: false, text: t("am.oauthNoCmd") }); }
              }
            },
          }, busy === `${key}:tui-start` ? t("am.starting") : t("am.oauthBtn")),
          isCb && h("button", {
            className: "am-btn",
            disabled: busy === `${key}:tui-cancel` || !tuiActive,
            title: tuiActive ? t("am.oauthCancelTip") : t("am.noOauth"),
            onClick: async () => {
              const d = await ctl(key, "tui-cancel");
              if (d && !d.error) { setNotice({ ok: true, text: t("am.oauthCancelled") }); refresh(); }
            },
          }, t("am.cancelOauth")),
        ),
        // ── 操作条 2：账号档 / 登出（右对齐） ──
        a.installed && h("div", { className: "am-actions is-end" },
          h("button", {
            className: "am-btn" + (accOpen === key ? " is-primary" : ""),
            onClick: () => setAccOpen(accOpen === key ? null : key),
            title: t("am.accountsTip"),
          }, accOpen === key ? t("am.accountsCollapse") : t("am.accountsBtn", { tail: accounts.length ? t("am.accountsBtnTail", { n: accounts.length }) : "…" })),
          h("button", {
            className: "am-btn" + (confirmLogout === key ? " is-danger" : ""),
            disabled: busy === `${key}:accounts-logout` || !hasContent,
            title: hasContent ? t("am.logoutTip") : t("am.nothingToLogout"),
            onClick: () => handleLogout(key),
          }, confirmLogout === key ? t("am.confirmLogout") : t("am.logout")),
        ),
        // 流程错误（失败/超时）透传展示——等价退役的扩展内登录弹窗 error 行
        ext?.error && h("div", { className: "am-error" }, String(ext.error)),
        // URL 展示（A url-only 模式：ext.url 由聚合透传）
        ext?.url && h("div", { className: "am-url-line" },
          h("a", { className: "am-url", href: ext.url, target: "_blank", rel: "noreferrer" }, ext.url.slice(0, 90) + (ext.url.length > 90 ? "…" : "")),
          h("button", { className: "am-btn is-ghost is-sm", onClick: () => { try { navigator.clipboard?.writeText(ext.url); } catch { /* no clipboard permission */ } } }, t("am.copy")),
        ),
        // codebuddy TUI OAuth 状态行
        isCb && a.tui?.tuiSid && h("div", { className: "am-tui-line" },
          t("am.tuiLine", { state: a.tui.tuiState ?? "waiting", sid: a.tui.tuiSid }),
          h("button", {
            className: "am-btn is-sm",
            style: { marginLeft: 6 },
            title: t("am.openCmdTip"),
            onClick: async () => {
              const okOpen = await openCmdTerminal(a.tui.tuiSid, "cbc-login");
              if (!okOpen) setNotice({ ok: false, text: t("am.noCmdPanel") });
            },
          }, t("am.openTerminal")),
          a.tui.tuiUrl && h("a", { href: a.tui.tuiUrl, target: "_blank", rel: "noreferrer" }, t("am.openAuthPage")),
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
