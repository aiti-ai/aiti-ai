// aiti-crash-fatal client — toolbar 按钮（reload 旁）：
// 💥 崩页面（/corrupt 破坏 app/page.tsx → global-error 急救页，/restore 还原）
// 🧱 崩编译（/corrupt-build 注入不存在导出 → Build Error overlay → /rescue.html，/restore-build 还原）
// 🧨 崩扩展 startup（/crash-ext 标志 → ⚠ 指示器，/restore-ext 清标志）。GET /status 查态。
// dev 隔离专用，不进 prod。
//
// 提示改用自定义弹窗（原生 confirm/alert 无法复制）：可选中文本 + 复制按钮，
// 方便把「如何还原」等提示消息复制出去（发 AI / 记录）。createElement 构建，无 innerHTML。
export default function register(ctx) {
  const { h, apiUrl } = ctx;

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
    copyBtn.textContent = "复制";
    copyBtn.style.cssText = "padding:4px 10px;font-size:12px;background:#333;color:#e8e8e8;border:1px solid #444;border-radius:6px;cursor:pointer;margin-right:6px;";
    copyBtn.onclick = async () => {
      const t = `${title}\n\n${body}`;
      try { await navigator.clipboard.writeText(t); } catch {
        const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} document.body.removeChild(ta);
      }
      copyBtn.textContent = "已复制 ✓";
      setTimeout(() => { copyBtn.textContent = "复制"; }, 1600);
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
          { label: "取消" },
        ];
        if (buildCorrupted) {
          buttons.push({
            label: "立即恢复编译（restore-build）", primary: true,
            onClick: async (close) => {
              try {
                await fetch(apiUrl("/api/extensions/aiti-crash-fatal/restore-build"), { method: "POST" });
              } finally {
                close();
                showPopup({ title: "已还原 AppShell.tsx", body: "等 HMR 自动恢复（或刷新页面）→ Build Error 消失。若页面已全屏 overlay，从 /dev/rescue.html 发指令让 AI 跑 restore-build。", buttons: [{ label: "关闭" }] });
              }
            },
          });
        }
        if (extCrashed) {
          buttons.push({
            label: "立即恢复扩展", primary: true,
            onClick: async (close) => {
              try { await restoreExt(); } finally { close(); }
              showPopup({ title: "已恢复", body: "startup 崩溃标志已清除并 reload。左下角 ⚠ 应已消失（若还在，刷新页面）。", buttons: [{ label: "关闭" }] });
            },
          });
        }
        buttons.push(
          {
            label: "崩扩展 startup",
            ...(extCrashed ? {} : { primary: true }),
            onClick: async (close) => {
              let timer = null;
              const doRestore = async () => {
                if (timer) { clearTimeout(timer); timer = null; }
                try { await restoreExt(); } finally {
                  showPopup({ title: "扩展已恢复", body: "startup 崩溃标志已清除并 reload，左下角 ⚠ 应已消失。", buttons: [{ label: "关闭" }] });
                }
              };
              try {
                const r = await fetch(apiUrl("/api/extensions/aiti-crash-fatal/crash-ext"), { method: "POST" });
                const d = await r.json();
                if (!d.ok) {
                  showPopup({ title: "失败", body: String(d.error || r.status), buttons: [{ label: "关闭" }] });
                  return;
                }
                // 宿主 reload → startup throw → manifest failed → ⚠ 指示器出现
                await ctx.reloadExtensions?.();
                close();
                // 60s 自动恢复（页面刷新则定时器丢失，可重开本弹窗手动恢复）
                timer = setTimeout(() => { void doRestore(); }, 60000);
                showPopup({
                  title: "扩展 startup 已崩（部分崩）",
                  body: "startup 入口已崩，页面 / API / 本扩展按钮全部存活（部分崩）。\n\n· 左下角出现黄色 ⚠ 按钮，点开见「aiti-crash-fatal · 启动失败」完整消息（含恢复提示）\n· 点 ⚠ 弹层里的 🚑 也可叫急救 AI\n· 60s 后自动恢复；或点下方按钮立即恢复",
                  buttons: [
                    { label: "立即恢复", primary: true, onClick: (c) => { void doRestore().then(() => c()); } },
                    { label: "关闭" },
                  ],
                });
              } catch (e) {
                showPopup({ title: "网络错误", body: String(e), buttons: [{ label: "关闭" }] });
              }
            },
          },
          {
            label: "崩编译（Build Error）",
            onClick: async (close) => {
              try {
                const r = await fetch(apiUrl("/api/extensions/aiti-crash-fatal/corrupt-build"), { method: "POST" });
                const d = await r.json();
                close();
                showPopup({
                  title: d.ok ? "已注入编译错误（AppShell.tsx）" : "失败",
                  body: d.ok
                    ? "已向 components/AppShell.tsx 顶部注入不存在导出的 import（备份在 " + (d.bak || "") + "）。\n\n等 HMR / 刷新页面 → 全屏 Build Error overlay（global-error 接不住编译错）→ rescue-hook 🚑 横幅 → 自动引导进 /rescue.html 静态急救页（不进编译图，模块图坏时依然可达）。\n\n还原：本弹窗重开点「立即恢复编译」，或访问 /api/extensions/aiti-crash-fatal/restore-build，或在急救页发指令让 AI 跑。"
                    : ("失败：" + (d.error || r.status)),
                  buttons: [{ label: "关闭" }],
                });
              } catch (e) {
                showPopup({ title: "网络错误", body: String(e), buttons: [{ label: "关闭" }] });
              }
            },
          },
          {
            label: "崩页面",
            onClick: async (close) => {
              try {
                const r = await fetch(apiUrl("/api/extensions/aiti-crash-fatal/corrupt"), { method: "POST" });
                const d = await r.json();
                close();
                showPopup({
                  title: d.ok ? "已破坏 app/page.tsx" : "失败",
                  body: d.ok
                    ? "已破坏 app/page.tsx（备份在 " + (d.bak || "") + "）。\n\n现在刷新页面（Cmd/Ctrl+R）→ 页面崩到 🚑 急救页（chat UI 进不去）。\n\n在急救页发指令测试急救 AI，或直接访问 /api/extensions/aiti-crash-fatal/restore（GET）还原。"
                    : ("失败：" + (d.error || r.status)),
                  buttons: [{ label: "关闭" }],
                });
              } catch (e) {
                showPopup({ title: "网络错误", body: String(e), buttons: [{ label: "关闭" }] });
              }
            },
          },
        );
        showPopup({
          title: "Fatal 崩溃测试",
          body: "选择崩溃模式（均有备份 / 可恢复）：\n\n🧨 崩扩展 startup（部分崩）— 本扩展 startup 入口崩：页面 / API / client 全活着，左下角出现 ⚠「启动失败」指示器，可看加载失败消息。60s 自动恢复。\n\n💥 崩页面 — 破坏 app/page.tsx：刷新后整页崩到 🚑 global-error 急救页（chat UI 进不去）。\n\n🧱 崩编译 — 注入不存在导出：Build Error overlay 全屏接管（编译错 global-error 接不住）→ rescue-hook 🚑 横幅自动引导进 /rescue.html 静态急救页。\n" + (extCrashed ? "\n⚠ 当前正处于 startup 崩溃态，可点「立即恢复扩展」。" : "") + (buildCorrupted ? "\n🧱 当前正处于编译错误态，可点「立即恢复编译」。" : ""),
          buttons,
        });
      },
      title: "Fatal 崩溃测试：崩页面（global-error 急救页）/ 崩扩展 startup（⚠ 启动失败指示器）",
      style: {
        fontSize: 11, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
        background: "#dc2626", color: "#fff", border: "none", fontWeight: 600,
        marginLeft: 4,
      },
    }, "Fatal"),
  }]);
}
