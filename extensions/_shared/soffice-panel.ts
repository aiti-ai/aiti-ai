/**
 * soffice-panel — the degradation explainer panel shown when soffice is missing (shared client
 * module, inlined at build time).
 *
 * Scenario: legacy-format conversion (.doc -> .docx/.pdf, .xls/.ods -> .xlsx) depends on server-side
 * LibreOffice; when it is not installed/configured, instead of throwing one error line the panel gives:
 *   - why it is needed (one sentence)
 *   - per-platform install commands
 *   - configuration guidance (extman -> aiti-editor -> Features -> soffice path)
 *   - alternative actions: ⬇ download and edit locally; 🖥 open in the virtual environment (remote
 *     viewing, requires aiti-ui-env)
 *
 * Pure DOM (no JSX / no framework deps), shared by the aiti-editor and aiti-sheet-univer bundles.
 *
 * i18n (2026-11-17 ext-i18n convention): copy uses Chinese raw text as t() keys; the consumer
 * injects its own ctx.t via opts.t (per-extension ui.i18n table carries the zh-CN identity + en
 * translation entries). Absent opts.t -> raw text (current behavior). The tr("...") key strings below
 * must stay in Chinese — they are lookup keys matched by the consumers' i18n tables.
 */

/** Consumer-injected translate fn (host ctx.t shape; params interpolation {name}). */
export type SofficePanelT = (key: string, params?: Record<string, unknown>) => string;

export interface SofficeStatus {
  available?: boolean;
  path?: string | null;
  source?: string | null;
  version?: string | null;
  installHints?: Partial<Record<"linux" | "macos" | "windows" | "feature", string>>;
}

/** GET /soffice-status (aiti-editor and aiti-sheet-univer both expose the same-shaped endpoint) */
export async function fetchSofficeStatus(apiUrl: (p: string) => string, extId = "aiti-editor"): Promise<SofficeStatus | null> {
  try {
    const r = await fetch(apiUrl(`/api/extensions/${extId}/soffice-status`), { cache: "no-store" });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.ok ? d : null;
  } catch {
    return null;
  }
}

export interface SofficePanelOpts {
  /** basePath-aware URL builder */
  apiUrl: (p: string) => string;
  /** Source file absolute path (used by download / virtual-environment open) */
  filePath: string;
  /** Conversion target description (e.g. ".xlsx" / ".docx / PDF"), display only */
  targetLabel?: string;
  /** Close callback (when the panel's ✕ is clicked); when omitted no ✕ is shown */
  onClose?: () => void;
  /** Conversion retry: when provided, shows a "retry conversion" button at the panel's bottom */
  onRetry?: () => void;
  /** i18n translate (consumer's ctx.t); absent → raw text fallback */
  t?: SofficePanelT;
}

const shellQuote = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function buildSofficeMissingPanel(opts: SofficePanelOpts): HTMLElement {
  const { apiUrl, filePath } = opts;
  const tr: SofficePanelT = opts.t || ((k) => k);
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0;overflow:auto;padding:22px 26px;background:var(--bg,#fff);font-size:13px;line-height:1.55;color:var(--text,#1a1a1a);z-index:10;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:700;font-size:15px;margin-bottom:6px;";
  title.textContent = tr("转换该文件需要 LibreOffice (soffice)");
  el.appendChild(title);

  const why = document.createElement("div");
  why.style.cssText = "margin-bottom:12px;";
  why.innerHTML = tr("服务器端未检测到 LibreOffice，因此无法把老格式{target}。两个解决方向：在<b>服务器</b>安装并配置 LibreOffice（推荐，装完即可在线转换）；或把文件下载到<b>你本地</b>用 Office 编辑。",
    { target: opts.targetLabel ? tr("转换成 {label}", { label: opts.targetLabel }) : "" });
  el.appendChild(why);

  // Install guidance
  const btnStyle = "display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:12px;font-weight:600;border:1px solid var(--border,#d0d0d0);border-radius:8px;background:var(--bg-selected,#eef2ff);color:var(--text,#1a1a1a);cursor:pointer;font-family:inherit;";
  const box = (label: string) => {
    const d = document.createElement("div");
    d.style.cssText = "font-weight:600;font-size:12px;color:var(--text-dim,#888);margin:12px 0 4px;";
    d.textContent = label;
    el.appendChild(d);
    return d;
  };
  box(tr("服务器安装 LibreOffice（任选其一）"));
  const cmds: Array<[string, string]> = [
    ["Linux (Debian/Ubuntu)", "sudo apt install libreoffice fonts-noto-cjk"],
    ["macOS", "brew install --cask libreoffice"],
    ["Windows", "winget install --id TheDocumentFoundation.LibreOffice -e"],
  ];
  for (const [plat, cmd] of cmds) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin:2px 0;";
    const tag = document.createElement("span");
    tag.style.cssText = "flex-shrink:0;width:150px;font-size:11px;color:var(--text-dim,#888);";
    tag.textContent = plat;
    const code = document.createElement("code");
    code.style.cssText = "font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;background:var(--bg-selected,#f1f3f7);padding:2px 8px;border-radius:5px;word-break:break-all;flex:1 1 auto;";
    code.textContent = cmd;
    row.append(tag, code);
    el.appendChild(row);
  }

  // One-click AI install (aiti-helper help point install-soffice: click -> opens the helper dialog ->
  // auto-selects that help point -> prefills and auto-sends; the AI detects the platform / installs /
  // verifies end to end). window.__aitiHelperInvoke is the stable entry registered by aiti-helper's thin
  // entry (accepted even during the stub phase, replayed once the heavy UI loads on demand); degrades to
  // manual-guidance copy when not deployed.
  const aiRow = document.createElement("div");
  aiRow.style.cssText = "margin-top:8px;display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--border,#e4e7ef);border-radius:8px;background:var(--bg-selected,#f6f8ff);flex-wrap:wrap;";
  const aiBtn = document.createElement("button");
  aiBtn.type = "button";
  aiBtn.style.cssText = btnStyle + "background:var(--bg-selected,#e8edff);border-color:var(--accent,#7c8cf8);";
  aiBtn.innerHTML = tr("AI 帮我安装（推荐）");
  aiBtn.title = tr("调起 aiti-helper 并自动选中「AI 帮我在服务器安装 LibreOffice」帮助点，AI 自动检测平台（Linux/Windows/macOS）、安装并验证");
  const aiTipText = document.createElement("span");
  aiTipText.style.cssText = "flex:1 1 200px;font-size:11px;color:var(--text-dim,#888);";
  aiTipText.textContent = tr("不想手动装？点按钮唤起 AI 助手自动完成检测、安装、验证；也可点弹窗右上角 🤖 手动选帮助点。");
  aiBtn.onclick = () => {
    const w = window as any;
    if (typeof w.__aitiHelperInvoke !== "function") {
      aiTipText.textContent = tr("aiti-helper 未就绪（未部署或未加载）：刷新页面后重试，或按上方命令手动安装。");
      return;
    }
    w.__aitiHelperInvoke({
      helperId: "install-soffice",
      message: "打开老格式文件时提示缺少 LibreOffice (soffice)，请按 install-soffice 手册在本机安装并验证（完成后用 soffice-status?refresh=1 确认可用）。",
      autoSend: true,
      contextLabel: "soffice 缺失面板 · 一键 AI 安装",
      extId: "aiti-editor",
      extName: "aiti-editor",
    });
    aiTipText.textContent = tr("已唤起 AI 助手并自动发起安装任务——切到 AI 助手弹窗查看进度；装完回本页点「重试转换」。");
  };
  aiRow.append(aiBtn, aiTipText);
  el.appendChild(aiRow);

  // Configuration guidance
  box(tr("已安装但不在 PATH？配置路径"));
  const cfg = document.createElement("div");
  cfg.style.cssText = "font-size:12px;";
  cfg.textContent = tr("扩展管理器 → aiti-editor → 功能 → 「soffice 路径（LibreOffice）」填入绝对路径（如 /opt/libreoffice/program/soffice），保存后刷新页面重试。");
  el.appendChild(cfg);

  // Separator
  const sep = document.createElement("div");
  sep.style.cssText = "height:1px;background:var(--border,#eee);margin:14px 0;";
  el.appendChild(sep);
  box(tr("替代方案"));

  const btns = document.createElement("div");
  btns.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";

  // (1) Download and edit locally
  const dl = document.createElement("button");
  dl.type = "button";
  dl.style.cssText = btnStyle;
  dl.innerHTML = tr("下载到本机编辑");
  dl.title = tr("下载原文件，在你本地用 Office/WPS 编辑");
  dl.onclick = async () => {
    dl.disabled = true;
    try {
      const base = apiUrl("/api/extensions/aiti-editor");
      const t = await fetch(base + "/ticket", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ filePath }),
      }).then((r) => r.json());
      if (!t.ticket) throw new Error(t.error || tr("票据签发失败"));
      const a = document.createElement("a");
      a.href = base + "/t/" + t.ticket + "/file";
      a.download = filePath.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      dl.title = String((e as Error).message || e);
    } finally {
      dl.disabled = false;
    }
  };
  btns.appendChild(dl);

  // (2) Open in the virtual environment (remote viewing, requires aiti-ui-env)
  const venv = document.createElement("button");
  venv.type = "button";
  venv.style.cssText = btnStyle;
  venv.innerHTML = tr("虚拟环境打开（远程查看）");
  venv.title = tr("在服务器的虚拟桌面用 LibreOffice 打开本文件，经浏览器 VNC 远程查看/编辑（需 aiti-ui-env 扩展）");
  venv.onclick = async () => {
    venv.disabled = true;
    venv.textContent = tr("虚拟环境准备中…");
    const progress = (m: string) => { venv.textContent = m; };
    try {
      const ui = apiUrl("/api/extensions/aiti-ui-env");
      // 1) Virtual display ready
      const hd = await fetch(ui + "/headless", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) }).then((r) => r.json());
      if (!hd.ok) throw new Error(tr("虚拟屏启动失败：{msg}", { msg: hd.error || tr("未知") }));
      // 2) Open the file with LibreOffice inside the virtual desktop
      const run = await fetch(ui + "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "soffice --norestore " + shellQuote(filePath), prefer: "headless" }) }).then((r) => r.json());
      if (!run.ok) throw new Error(tr("LibreOffice 启动失败：{msg}", { msg: run.error || tr("未知") }));
      // 3) Bridge VNC
      const vnc = await fetch(ui + "/vnc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) }).then((r) => r.json());
      if (!vnc.ok) throw new Error(tr("VNC 启动失败：{msg}", { msg: vnc.error || tr("未知") }));
      // 4) Session cookie + viewer page path
      const sess = await fetch(ui + "/vnc-session", { method: "POST" }).then((r) => r.json());
      if (!sess.ok || !sess.path) throw new Error(tr("VNC 会话获取失败"));
      progress(tr("已在虚拟环境打开，正在跳转远程查看…"));
      window.open(apiUrl(sess.path), "_blank");
      venv.textContent = tr("虚拟环境打开（远程查看）");
      venv.disabled = false;
    } catch (e) {
      const msg = String((e as Error).message || e);
      venv.textContent = msg.includes("404") || msg.includes("Failed to fetch")
        ? tr("虚拟环境打开（需 aiti-ui-env 扩展）")
        : tr("虚拟环境打开（重试）");
      venv.title = msg;
      venv.disabled = false;
    }
  };
  btns.appendChild(venv);
  el.appendChild(btns);

  const note = document.createElement("div");
  note.style.cssText = "margin-top:10px;font-size:11px;color:var(--text-dim,#888);";
  note.textContent = tr("「虚拟环境打开」在服务器的虚拟桌面上运行 LibreOffice 并经浏览器 VNC 远程查看——适合不想在本地装 Office、且服务器已配置虚拟屏（aiti-ui-env）的场景。");
  el.appendChild(note);

  // Retry / close
  if (opts.onRetry || opts.onClose) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
    if (opts.onRetry) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = tr("重试转换");
      retry.style.cssText = btnStyle;
      retry.onclick = () => opts.onRetry!();
      row.appendChild(retry);
    }
    if (opts.onClose) {
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = tr("关闭");
      x.style.cssText = btnStyle + "background:transparent;";
      x.onclick = () => opts.onClose!();
      row.appendChild(x);
    }
    el.appendChild(row);
  }
  return el;
}
