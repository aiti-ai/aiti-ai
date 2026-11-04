/**
 * soffice-panel —— soffice 缺失时的降级说明面板（共享客户端模块，构建期内联）。
 *
 * 场景：老格式转换（.doc→.docx/.pdf、.xls/.ods→.xlsx）依赖服务器端 LibreOffice；
 * 未安装/未配置时，不甩一句报错，而是给出：
 *   - 为什么需要它（一句话）
 *   - 各平台安装命令
 *   - 配置指引（extman → aiti-editor → 功能 → soffice 路径）
 *   - 替代动作：⬇ 下载到本机编辑；🖥 虚拟环境打开（远程查看，需 aiti-ui-env）
 *
 * 纯 DOM（无 JSX/无框架依赖），aiti-editor 与 aiti-sheet-univer bundle 共用。
 */

export interface SofficeStatus {
  available?: boolean;
  path?: string | null;
  source?: string | null;
  version?: string | null;
  installHints?: Partial<Record<"linux" | "macos" | "windows" | "feature", string>>;
}

/** GET /soffice-status（aiti-editor 或 aiti-sheet-univer 均提供同构端点） */
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
  /** basePath 感知地址构造 */
  apiUrl: (p: string) => string;
  /** 源文件绝对路径（下载 / 虚拟环境打开用） */
  filePath: string;
  /** 转换目标描述（如 ".xlsx" / ".docx / PDF"），仅展示 */
  targetLabel?: string;
  /** 关闭回调（面板内 ✕ 时）；不传则不显示 ✕ */
  onClose?: () => void;
  /** 转换重试：提供则在面板底部显示「重试转换」按钮 */
  onRetry?: () => void;
}

const shellQuote = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function buildSofficeMissingPanel(opts: SofficePanelOpts): HTMLElement {
  const { apiUrl, filePath } = opts;
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0;overflow:auto;padding:22px 26px;background:var(--bg,#fff);font-size:13px;line-height:1.55;color:var(--text,#1a1a1a);z-index:10;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:700;font-size:15px;margin-bottom:6px;";
  title.textContent = "转换该文件需要 LibreOffice (soffice)";
  el.appendChild(title);

  const why = document.createElement("div");
  why.style.cssText = "margin-bottom:12px;";
  why.innerHTML = "服务器端未检测到 LibreOffice，因此无法把老格式"
    + (opts.targetLabel ? "转换成 " + opts.targetLabel : "")
    + "。两个解决方向：在<b>服务器</b>安装并配置 LibreOffice（推荐，装完即可在线转换）；或把文件下载到<b>你本地</b>用 Office 编辑。";
  el.appendChild(why);

  // 安装指引
  const btnStyle = "display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:12px;font-weight:600;border:1px solid var(--border,#d0d0d0);border-radius:8px;background:var(--bg-selected,#eef2ff);color:var(--text,#1a1a1a);cursor:pointer;font-family:inherit;";
  const box = (label: string) => {
    const d = document.createElement("div");
    d.style.cssText = "font-weight:600;font-size:12px;color:var(--text-dim,#888);margin:12px 0 4px;";
    d.textContent = label;
    el.appendChild(d);
    return d;
  };
  box("服务器安装 LibreOffice（任选其一）");
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

  // AI 一键安装（aiti-helper 帮助点 install-soffice：点击 → 打开 helper 弹窗 → 自动选中该帮助点 →
  // 预填并自动发送，AI 全程检测平台/安装/验证）。window.__aitiHelperInvoke 是 aiti-helper 薄 entry
  // 注册的稳定入口（stub 期即受理，重 UI 按需加载后重放）；未部署时降级为手动指引文案。
  const aiRow = document.createElement("div");
  aiRow.style.cssText = "margin-top:8px;display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--border,#e4e7ef);border-radius:8px;background:var(--bg-selected,#f6f8ff);flex-wrap:wrap;";
  const aiBtn = document.createElement("button");
  aiBtn.type = "button";
  aiBtn.style.cssText = btnStyle + "background:var(--bg-selected,#e8edff);border-color:var(--accent,#7c8cf8);";
  aiBtn.innerHTML = "🤖 AI 帮我安装（推荐）";
  aiBtn.title = "调起 aiti-helper 并自动选中「AI 帮我在服务器安装 LibreOffice」帮助点，AI 自动检测平台（Linux/Windows/macOS）、安装并验证";
  const aiTipText = document.createElement("span");
  aiTipText.style.cssText = "flex:1 1 200px;font-size:11px;color:var(--text-dim,#888);";
  aiTipText.textContent = "不想手动装？点按钮唤起 AI 助手自动完成检测、安装、验证；也可点弹窗右上角 🤖 手动选帮助点。";
  aiBtn.onclick = () => {
    const w = window as any;
    if (typeof w.__aitiHelperInvoke !== "function") {
      aiTipText.textContent = "aiti-helper 未就绪（未部署或未加载）：刷新页面后重试，或按上方命令手动安装。";
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
    aiTipText.textContent = "✓ 已唤起 AI 助手并自动发起安装任务——切到 AI 助手弹窗查看进度；装完回本页点「重试转换」。";
  };
  aiRow.append(aiBtn, aiTipText);
  el.appendChild(aiRow);

  // 配置指引
  box("已安装但不在 PATH？配置路径");
  const cfg = document.createElement("div");
  cfg.style.cssText = "font-size:12px;";
  cfg.textContent = "扩展管理器 → aiti-editor → 功能 → 「soffice 路径（LibreOffice）」填入绝对路径（如 /opt/libreoffice/program/soffice），保存后刷新页面重试。";
  el.appendChild(cfg);

  // 分隔
  const sep = document.createElement("div");
  sep.style.cssText = "height:1px;background:var(--border,#eee);margin:14px 0;";
  el.appendChild(sep);
  box("替代方案");

  const btns = document.createElement("div");
  btns.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";

  // ① 下载到本机编辑
  const dl = document.createElement("button");
  dl.type = "button";
  dl.style.cssText = btnStyle;
  dl.innerHTML = "⬇ 下载到本机编辑";
  dl.title = "下载原文件，在你本地用 Office/WPS 编辑";
  dl.onclick = async () => {
    dl.disabled = true;
    try {
      const base = apiUrl("/api/extensions/aiti-editor");
      const t = await fetch(base + "/ticket", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ filePath }),
      }).then((r) => r.json());
      if (!t.ticket) throw new Error(t.error || "票据签发失败");
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

  // ② 虚拟环境打开（远程查看，需 aiti-ui-env）
  const venv = document.createElement("button");
  venv.type = "button";
  venv.style.cssText = btnStyle;
  venv.innerHTML = "🖥 虚拟环境打开（远程查看）";
  venv.title = "在服务器的虚拟桌面用 LibreOffice 打开本文件，经浏览器 VNC 远程查看/编辑（需 aiti-ui-env 扩展）";
  venv.onclick = async () => {
    venv.disabled = true;
    venv.textContent = "虚拟环境准备中…";
    const progress = (m: string) => { venv.textContent = m; };
    try {
      const ui = apiUrl("/api/extensions/aiti-ui-env");
      // 1) 虚拟屏就绪
      const hd = await fetch(ui + "/headless", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) }).then((r) => r.json());
      if (!hd.ok) throw new Error("虚拟屏启动失败：" + (hd.error || "未知"));
      // 2) 虚拟桌面里用 LibreOffice 打开文件
      const run = await fetch(ui + "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "soffice --norestore " + shellQuote(filePath), prefer: "headless" }) }).then((r) => r.json());
      if (!run.ok) throw new Error("LibreOffice 启动失败：" + (run.error || "未知"));
      // 3) VNC 起桥
      const vnc = await fetch(ui + "/vnc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) }).then((r) => r.json());
      if (!vnc.ok) throw new Error("VNC 启动失败：" + (vnc.error || "未知"));
      // 4) 会话 cookie + 查看页路径
      const sess = await fetch(ui + "/vnc-session", { method: "POST" }).then((r) => r.json());
      if (!sess.ok || !sess.path) throw new Error("VNC 会话获取失败");
      progress("✓ 已在虚拟环境打开，正在跳转远程查看…");
      window.open(apiUrl(sess.path), "_blank");
      venv.textContent = "🖥 虚拟环境打开（远程查看）";
      venv.disabled = false;
    } catch (e) {
      const msg = String((e as Error).message || e);
      venv.textContent = msg.includes("404") || msg.includes("Failed to fetch")
        ? "🖥 虚拟环境打开（需 aiti-ui-env 扩展）"
        : "🖥 虚拟环境打开（重试）";
      venv.title = msg;
      venv.disabled = false;
    }
  };
  btns.appendChild(venv);
  el.appendChild(btns);

  const note = document.createElement("div");
  note.style.cssText = "margin-top:10px;font-size:11px;color:var(--text-dim,#888);";
  note.textContent = "「虚拟环境打开」在服务器的虚拟桌面上运行 LibreOffice 并经浏览器 VNC 远程查看——适合不想在本地装 Office、且服务器已配置虚拟屏（aiti-ui-env）的场景。";
  el.appendChild(note);

  // 重试 / 关闭
  if (opts.onRetry || opts.onClose) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
    if (opts.onRetry) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重试转换";
      retry.style.cssText = btnStyle;
      retry.onclick = () => opts.onRetry!();
      row.appendChild(retry);
    }
    if (opts.onClose) {
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "关闭";
      x.style.cssText = btnStyle + "background:transparent;";
      x.onclick = () => opts.onClose!();
      row.appendChild(x);
    }
    el.appendChild(row);
  }
  return el;
}
