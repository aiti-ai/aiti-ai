/**
 * controlled-login — 外部 Agent 受控登录标准 · 前端统一弹窗（原生 h() 渲染，零构建步骤）。
 *
 * ⚠ 副本同步（字节级拷贝，改动须同步到全部副本；测试 `_shared/controlled-login.test.mjs` 钉住一致性）。
 * 权威源：pi-web-ext/_shared/controlled-login-dialog.mjs
 * 部署副本（client 侧走部署树内相对导入 —— 零构建 client 无法像 vite 客户端那样在构建期
 * 内联 ../../_shared（资产路由拒绝越目录穿越），与 draft-keeper 的 ./core.mjs 同一惯例）：
 *   pi-web-ext/aiti-{zcode,cursor,qoder,claude-code,codex}-agent/client/controlled-login-dialog.mjs
 *
 * 契约（docs/ext-controlled-login-standard.md §3.5）：
 *   🔗「打开授权页」按钮（target=_blank）+ URL 文本可复制 + 模式说明行
 *   + 状态区（waiting 转圈 / success ✅ 用户名 / failed / timeout / cancelled，均带重试）
 *   + B 模式（paste）专属 code 输入框+提交。
 * 状态刷新：弹窗打开期间每 2s 轮询 GET /login/status，关闭即停
 * （方案 §3.6 已论证并拍板的轮询例外：登录是分钟级一次性交互）。
 *
 * 浮动契约：面板根节点 data-ext-float="1" + data-ext-float-w/-h + data-ext-float-full="1"
 * （aiti-float 接管拖拽/缩放/持久化/小屏全屏；未装时自身 style 居中兜底）。
 *
 * 接入（各扩展 client/controlled-login-client.mjs，两行）：
 *   import { registerControlledLoginClient } from "./controlled-login-dialog.mjs";
 *   export default function register(ctx) { registerControlledLoginClient(ctx, { … }); }
 */

// ---------- 模块内 open 状态（toolbar 入口与 dialogs 条目同模块共享，不落 window 全局） ----------
let moduleSetOpen = null;
// 懒加载（clientImmediately:false）下 toolbar 静态条目点击时弹窗组件可能尚未挂载：
// 记 pending，挂载 effect 消费——避免首点失效。
let pendingOpen = false;

/** 打开本扩展的受控登录弹窗（toolbar 🔑 按钮 / 静态条目 meta.onClick 用）。 */
export function openControlledLogin() {
  if (moduleSetOpen) moduleSetOpen(true);
  else pendingOpen = true;
}

// ---------- 自持样式层（幂等注入；clg- 前缀 + var(--x, 兜底)，零宿主耦合） ----------
const STYLE_ID = "aiti-controlled-login-styles";
const STYLES = `
.clg-mask { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.32); display: flex; align-items: center; justify-content: center; }
.clg-panel { width: 520px; max-width: calc(100vw - 16px); display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg,#fff); color: var(--text,#1a1a1a); border: 1px solid var(--border,#e0e0e0); border-radius: 12px;
  box-shadow: 0 16px 64px rgba(0,0,0,.25); font-size: 13px; line-height: 1.55; }
.clg-head { display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-bottom: 1px solid var(--border,#e0e0e0); flex-shrink: 0; background: var(--bg-subtle,#f7f7f7); }
.clg-title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.clg-x { margin-left: auto; border: none; background: none; cursor: pointer; color: var(--text-muted,#888); font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
.clg-x:hover { background: var(--bg-hover,#eee); color: var(--text,#1a1a1a); }
.clg-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
.clg-intro { color: var(--text-muted,#777); font-size: 12.5px; }
.clg-urlrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.clg-open { display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border: 1px solid var(--accent,#2563eb); border-radius: 8px;
  cursor: pointer; background: var(--accent,#2563eb); color: #fff; font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.clg-open:hover { background: var(--accent-hover,#1d4ed8); }
.clg-url { flex: 1; min-width: 200px; font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-muted,#777);
  word-break: break-all; cursor: pointer; padding: 5px 8px; border: 1px dashed var(--border,#d8d8d8); border-radius: 6px; }
.clg-url:hover { border-color: var(--accent,#2563eb); color: var(--text,#1a1a1a); }
.clg-copied { color: #16a34a; font-size: 11.5px; }
.clg-status { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 8px; font-size: 12.5px; flex-wrap: wrap; }
.clg-status.waiting { background: rgba(37,99,235,.08); color: var(--accent,#2563eb); }
.clg-status.success { background: rgba(34,197,94,.12); color: #16a34a; }
.clg-status.failed, .clg-status.timeout, .clg-status.cancelled { background: rgba(239,68,68,.08); color: #dc2626; }
.clg-spin { width: 14px; height: 14px; flex-shrink: 0; border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor;
  border-radius: 50%; animation: clg-rotate .9s linear infinite; }
@keyframes clg-rotate { to { transform: rotate(360deg); } }
.clg-errline { font-size: 12px; color: #dc2626; word-break: break-all; }
.clg-tail { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-muted,#888); background: var(--bg-subtle,#f5f5f5);
  border: 1px solid var(--border,#e0e0e0); border-radius: 8px; padding: 8px 10px; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.clg-coderow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.clg-input { flex: 1; min-width: 180px; padding: 7px 10px; border: 1px solid var(--border,#d8d8d8); border-radius: 8px;
  background: var(--bg,#fff); color: var(--text,#1a1a1a); font-size: 12.5px; outline: none; }
.clg-input:focus { border-color: var(--accent,#2563eb); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent,#2563eb) 18%, transparent); }
.clg-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 14px; border: 1px solid var(--border,#d8d8d8); border-radius: 7px;
  cursor: pointer; background: var(--bg,#fff); color: var(--text,#1a1a1a); font-size: 12.5px; font-weight: 500; white-space: nowrap; }
.clg-btn:hover { background: var(--bg-hover,#f0f0f0); }
.clg-btn:disabled { opacity: .5; cursor: not-allowed; }
.clg-btn.primary { background: var(--accent,#2563eb); border-color: var(--accent,#2563eb); color: #fff; }
.clg-btn.primary:hover { background: var(--accent-hover,#1d4ed8); }
.clg-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.clg-hint { color: var(--text-dim,#999); font-size: 11.5px; }
`;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  if (typeof document === "undefined") return;
  if (!document.getElementById(STYLE_ID)) {
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = STYLES;
    document.head.appendChild(el);
  }
  stylesInjected = true;
}

/**
 * 统一弹窗注册（每扩展 client 的薄壳调用一次）。
 *
 * @param {*} ctx 宿主 client 上下文（h/useState/useEffect/apiUrl/registerItems）
 * @param {object} config
 * @param {string} config.extId        扩展 id（API 前缀 / toolbar item id 用）
 * @param {string} config.toolbarLabel 工具条按钮 title/label（如 "登录 ZCode"）
 * @param {string} config.title        弹窗标题
 * @param {string} [config.urlHint]    A url-only 模式说明行
 * @param {string} [config.pasteHint]  B paste-relay 模式说明行
 * @param {string} [config.successHint] 成功后的补充说明（如凭据换 key 提示）
 */
export function registerControlledLoginClient(ctx, config) {
  ensureStyles();
  const h = (...a) => ctx.h(...a);
  const useState = (v) => ctx.useState(v);
  const useEffect = (fn, deps) => ctx.useEffect(fn, deps);
  const api = (p, init) => fetch(ctx.apiUrl("/api/extensions/" + config.extId + p), { cache: "no-store", ...init });
  const jsonInit = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // ---- 工具条入口：声明式图标按钮（meta.icon + meta.onClick、无 render —— 宿主统一渲染 36×36 线图按钮，禁 emoji） ----
  ctx.registerItems("toolbar", [{
    id: `${config.extId}-controlled-login`,
    meta: {
      label: config.toolbarLabel,
      title: config.toolbarLabel,
      icon: "icons/key-round.svg",
      onClick: () => openControlledLogin(),
    },
  }]);
  // ---- 弹窗条目（dialogs slot；宿主包 display:contents 壳，float 持久化键认它） ----
  ctx.registerItems("dialogs", [{
    id: `${config.extId}-controlled-login-dialog`,
    render: () => h(ControlledLoginDialog),
  }]);

  function ControlledLoginDialog() {
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState(null);   // /login/status 响应（{state,...}）
    const [busy, setBusy] = useState(false);
    const [reqError, setReqError] = useState(null); // 请求层错误（网络/400）
    const [code, setCode] = useState("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
      moduleSetOpen = setOpen;
      if (pendingOpen) { pendingOpen = false; setOpen(true); }
      return () => { if (moduleSetOpen === setOpen) moduleSetOpen = null; };
    }, []);

    // 打开期间 2s 轮询 /login/status（§3.6 拍板例外）；关闭即停
    useEffect(() => {
      if (!open) return;
      let stopped = false;
      let timer = null;
      const tick = async () => {
        try {
          const r = await api("/login/status");
          const d = await r.json();
          if (!stopped) { setStatus(d); setReqError(null); }
        } catch { /* 网络抖动忽略，下轮再试 */ }
        if (!stopped) timer = setTimeout(tick, 2000);
      };
      tick();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [open]);

    if (!open) return null;

    const st = status?.state ?? "idle";
    const mode = status?.mode ?? "url";
    const pasteMode = mode === "paste";

    async function call(p, init) {
      setBusy(true); setReqError(null);
      try {
        const r = await api(p, init);
        const d = await r.json();
        if (d && d.error) setReqError(d.error);
        if (d) setStatus(d);
      } catch (e) {
        setReqError(e?.message || String(e));
      }
      setBusy(false);
    }
    const startLogin = () => call("/login/start", jsonInit({}));
    const cancelLogin = () => call("/login/cancel", jsonInit({}));
    const submitCode = () => { if (code.trim()) call("/login/submit", jsonInit({ code })); };

    async function copyUrl() {
      const url = status?.url || "";
      if (!url) return;
      try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* 剪贴板不可用：URL 文本本身可选中复制 */ }
    }

    // ---- 状态区 ----
    let statusLine = null;
    if (st === "idle") {
      statusLine = h("div", { className: "clg-status waiting" }, "尚未发起登录");
    } else if (st === "waiting") {
      statusLine = h("div", { className: "clg-status waiting" },
        h("span", { className: "clg-spin" }),
        status?.url ? "等待你在浏览器完成授权…（本页自动感知，约 2s 内）" : "正在启动官方登录进程，等待授权链接…",
        h("button", { className: "clg-btn", disabled: busy, style: { marginLeft: "auto" }, onClick: cancelLogin }, "取消"),
      );
    } else if (st === "success") {
      statusLine = h("div", { className: "clg-status success" },
        "登录成功", status?.user ? h("span", { style: { fontWeight: 700 } }, status.user) : null,
        config.successHint ? h("span", { className: "clg-hint", style: { color: "inherit" } }, config.successHint) : null,
      );
    } else if (st === "failed" || st === "timeout" || st === "cancelled") {
      const label = st === "failed" ? "登录失败" : st === "timeout" ? "登录超时" : "已取消";
      statusLine = h("div", { className: "clg-status " + st },
        h("span", null, (st === "timeout" ? "⏱ " : st === "cancelled" ? "⚪ " : "❌ ") + label),
        status?.error ? h("span", { className: "clg-errline" }, status.error) : null,
      );
    }

    return h("div", { className: "clg-mask", onClick: () => setOpen(false) },
      h("div", {
        className: "clg-panel",
        "data-ext-float": "1", "data-ext-float-w": 520, "data-ext-float-h": 380, "data-ext-float-full": "1",
        onClick: (e) => e.stopPropagation(),
      },
        // ── 标题栏（首个子元素 = float 拖拽把手）──
        h("div", { className: "clg-head" },
          h("span", { className: "clg-title" }, "🔑 " + config.title),
          h("button", { className: "clg-x", title: "关闭", onClick: () => setOpen(false) }, "✕"),
        ),
        h("div", { className: "clg-body" },
          config.urlHint && !pasteMode ? h("div", { className: "clg-intro" }, config.urlHint) : null,
          pasteMode && config.pasteHint ? h("div", { className: "clg-intro" }, config.pasteHint) : null,

          // ── URL 区（waiting 且已抓到链接）──
          st === "waiting" && status?.url
            ? h("div", { className: "clg-urlrow" },
                h("a", { className: "clg-open", href: status.url, target: "_blank", rel: "noopener noreferrer" }, "打开授权页"),
                h("span", { className: "clg-url", title: "点击复制链接", onClick: copyUrl }, status.url),
                copied ? h("span", { className: "clg-copied" }, "已复制") : null,
              )
            : null,

          // ── B 模式 code 输入（paste 且 waiting）──
          pasteMode && st === "waiting"
            ? h("div", { className: "clg-coderow" },
                h("input", {
                  className: "clg-input",
                  placeholder: "粘贴授权完成页显示的 code（或完整回调链接）",
                  value: code,
                  onChange: (e) => setCode(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") submitCode(); },
                }),
                h("button", { className: "clg-btn primary", disabled: busy || !code.trim(), onClick: submitCode }, busy ? "…" : "提交 code"),
              )
            : null,

          statusLine,
          reqError ? h("div", { className: "clg-errline" }, reqError) : null,

          // CLI 升级改输出格式导致 URL 抓取失败时：原文透出（人工可读可复制，方案 §7）
          (st === "failed" || st === "timeout") && status?.outputTail
            ? h("div", { className: "clg-tail" }, status.outputTail)
            : null,

          // ── 底部动作：idle/终态带（重）试 ──
          h("div", { className: "clg-foot" },
            st === "idle" || st === "failed" || st === "timeout" || st === "cancelled" || st === "success"
              ? h("button", { className: "clg-btn primary", disabled: busy, onClick: startLogin }, busy ? "…" : st === "idle" ? "发起登录" : "重试")
              : null,
            h("span", { className: "clg-hint" }, "授权在浏览器完成，凭据由官方 CLI 落盘；本页关闭不影响进行中的登录。"),
          ),
        ),
      ),
    );
  }
}
