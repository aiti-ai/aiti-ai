// aiti-crash-fatal client — toolbar 按钮（reload 旁）：
// 💥 崩页面（/corrupt 破坏 app/page.tsx → global-error 急救页，/restore 还原）
// 🧱 崩编译（/corrupt-build 注入不存在导出 → Build Error overlay → /rescue.html，/restore-build 还原）
// 🧨 崩扩展 startup（/crash-ext 标志 → ⚠ 指示器，/restore-ext 清标志）。GET /status 查态。
// dev 隔离专用，不进 prod。
//
// 提示改用自定义弹窗（原生 confirm/alert 无法复制）：可选中文本 + 复制按钮，
// 方便把「如何还原」等提示消息复制出去（发 AI / 记录）。createElement 构建，无 innerHTML。
// 文案统一走 ctx.t（manifest ui.i18n 的 zh-CN/en 表）——静态 i18n: 前缀只用于宿主渲染的
// 静态 items，普通 DOM 文本必须先 t() 解析，否则会把键名原样显示出来。
export default function register(ctx) {
  const { h, apiUrl } = ctx;
  const t = (key, params) => (typeof ctx.t === "function" ? ctx.t(key, params) : key);

  /** 可复制确认/结果弹窗。title 标题、body 正文（可选中+复制）、buttons 底部按钮。
   *  按钮 onClick 收到 close()，primary 高亮。返回 close。 */
  function showPopup({ title, body, buttons = [] }) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483640;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;";
    const panel = document.createElement("div");
    panel.style.cssText = "max-width:560px;max-height:80vh;overflow:auto;background:#1a1a1a;color:#e8e8e8;border:1px solid var(--warn, #f59e0b);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,0.5);padding:16px;font:13px system-ui,sans-serif;";
    const titleEl = document.createElement("div");
    titleEl.style.cssText = "font-weight:700;font-size:14px;margin-bottom:8px;color:var(--warn, #f59e0b);user-select:text;";
    titleEl.textContent = title;
    const bodyEl = document.createElement("div");
    bodyEl.style.cssText = "white-space:pre-wrap;word-break:break-word;user-select:text;line-height:1.5;margin-bottom:12px;color:#e8e8e8;";
    bodyEl.textContent = body;
    const copyBtn = document.createElement("button");
    copyBtn.textContent = t("it.copy.label");
    copyBtn.style.cssText = "padding:4px 10px;font-size:12px;background:#333;color:#e8e8e8;border:1px solid #444;border-radius:6px;cursor:pointer;margin-right:6px;";
    copyBtn.onclick = async () => {
      const text = `${title}\n\n${body}`;
      try { await navigator.clipboard.writeText(text); } catch {
        const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} document.body.removeChild(ta);
      }
      copyBtn.textContent = t("it.copied.label");
      setTimeout(() => { copyBtn.textContent = t("it.copy.label"); }, 1600);
    };
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;align-items:center;";
    const close = () => { overlay.remove(); };
    for (const b of buttons) {
      const el = document.createElement("button");
      el.textContent = b.label;
      el.style.cssText = "padding:6px 14px;font-size:12px;border-radius:6px;cursor:pointer;font-weight:600;" + (b.primary ? "background:var(--warn, #f59e0b);color:#1a1a1a;border:none;" : "background:#333;color:#e8e8e8;border:1px solid #444;");
      el.onclick = async () => { if (b.onClick) await b.onClick(close); else close(); };
      btnRow.appendChild(el);
    }
    panel.appendChild(titleEl); panel.appendChild(bodyEl); panel.appendChild(copyBtn); panel.appendChild(btnRow);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    return close;
  }

  ctx.registerItems("toolbar", [{
    id: "crash-fatal-btn",
    meta: { label: "Fatal" },
    render: () => h("button", {
      onClick: async () => {
        // 先查态：startup 崩溃态时提供「立即恢复」入口（页面刷新丢自动恢复定时器的兑底）；
        // build 编译错态同样提供「立即恢复」（页面已 Build Error 时本按钮可能点不了，兑底走急救页）
        let extCrashed = false;
        let buildCorrupted = false;
        try {
          const s = await fetch(apiUrl("/api/extensions/aiti-crash-fatal/status"));
          const d = await s.json();
          extCrashed = !!d.extCrashed;
          buildCorrupted = !!d.buildCorrupted;
        } catch { /* status 拿不到按未崩处理 */ }
        /** 恢复 startup 崩溃：清标志 → 宿主 reload → ⚠ 消失。 */
        const restoreExt = async () => {
          await fetch(apiUrl("/api/extensions/aiti-crash-fatal/restore-ext"), { method: "POST" });
          await ctx.reloadExtensions?.();
        };
        const buttons = [
          { label: t("it.cancel.label") },
        ];
        if (buildCorrupted) {
          buttons.push({
            label: t("it.restore-build.label"), primary: true,
            onClick: async (close) => {
              try {
                await fetch(apiUrl("/api/extensions/aiti-crash-fatal/restore-build"), { method: "POST" });
              } finally {
                close();
                showPopup({ title: t("it.restore-build.done.title"), body: t("it.restore-build.done.body"), buttons: [{ label: t("it.close.label") }] });
              }
            },
          });
        }
        if (extCrashed) {
          buttons.push({
            label: t("it.restore-ext.label"), primary: true,
            onClick: async (close) => {
              try { await restoreExt(); } finally { close(); }
              showPopup({ title: t("it.restore-ext.done.title"), body: t("it.restore-ext.done.body"), buttons: [{ label: t("it.close.label") }] });
            },
          });
        }
        buttons.push(
          {
            label: t("it.crash-ext.label"),
            ...(extCrashed ? {} : { primary: true }),
            onClick: async (close) => {
              let timer = null;
              const doRestore = async () => {
                if (timer) { clearTimeout(timer); timer = null; }
                try { await restoreExt(); } finally {
                  showPopup({ title: t("it.crash-ext.done.title"), body: t("it.crash-ext.done.body"), buttons: [{ label: t("it.close.label") }] });
                }
              };
              try {
                const r = await fetch(apiUrl("/api/extensions/aiti-crash-fatal/crash-ext"), { method: "POST" });
                const d = await r.json();
                if (!d.ok) {
                  showPopup({ title: t("it.fail.title"), body: t("it.fail.body", { error: String(d.error || r.status) }), buttons: [{ label: t("it.close.label") }] });
                  return;
                }
                // 宿主 reload → startup throw → manifest failed → ⚠ 指示器出现
                await ctx.reloadExtensions?.();
                close();
                // 60s 自动恢复（页面刷新则定时器丢失，可重开本弹窗手动恢复）
                timer = setTimeout(() => { void doRestore(); }, 60000);
                showPopup({
                  title: t("it.crash-ext.crashed.title"),
                  body: t("it.crash-ext.crashed.body"),
                  buttons: [
                    { label: t("it.restore-now.label"), primary: true, onClick: (c) => { void doRestore().then(() => c()); } },
                    { label: t("it.close.label") },
                  ],
                });
              } catch (e) {
                showPopup({ title: t("it.network-error.title"), body: String(e), buttons: [{ label: t("it.close.label") }] });
              }
            },
          },
          {
            label: t("it.crash-build.label"),
            onClick: async (close) => {
              try {
                const r = await fetch(apiUrl("/api/extensions/aiti-crash-fatal/corrupt-build"), { method: "POST" });
                const d = await r.json();
                close();
                showPopup({
                  title: d.ok ? t("it.crash-build.done.title") : t("it.fail.title"),
                  body: d.ok
                    ? t("it.crash-build.done.body", { bak: d.bak || "" })
                    : t("it.fail.body", { error: String(d.error || r.status) }),
                  buttons: [{ label: t("it.close.label") }],
                });
              } catch (e) {
                showPopup({ title: t("it.network-error.title"), body: String(e), buttons: [{ label: t("it.close.label") }] });
              }
            },
          },
          {
            label: t("it.crash-page.label"),
            onClick: async (close) => {
              try {
                const r = await fetch(apiUrl("/api/extensions/aiti-crash-fatal/corrupt"), { method: "POST" });
                const d = await r.json();
                close();
                showPopup({
                  title: d.ok ? t("it.crash-page.done.title") : t("it.fail.title"),
                  body: d.ok
                    ? t("it.crash-page.done.body", { bak: d.bak || "" })
                    : t("it.fail.body", { error: String(d.error || r.status) }),
                  buttons: [{ label: t("it.close.label") }],
                });
              } catch (e) {
                showPopup({ title: t("it.network-error.title"), body: String(e), buttons: [{ label: t("it.close.label") }] });
              }
            },
          },
        );
        showPopup({
          title: t("it.fatal.title"),
          body: t("it.fatal.body") + (extCrashed ? t("it.fatal.ext-crashed") : "") + (buildCorrupted ? t("it.fatal.build-broken") : ""),
          buttons,
        });
      },
      title: t("it.fatal.title.2"),
      style: {
        fontSize: 11, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
        background: "#dc2626", color: "#fff", border: "none", fontWeight: 600,
        marginLeft: 4,
      },
    }, "Fatal"),
  }]);
}
