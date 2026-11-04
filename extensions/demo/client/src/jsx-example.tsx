/**
 * jsx-example —— demo 扩展的「JSX 示例面板」。
 *
 * 这是整个仓库的 **JSX 可用性示范**：扩展 client 不只能用手写 h()（demo-client.mjs），
 * 还可以用 JSX + TypeScript + npm 依赖，只要走一遍 esbuild 构建（tools/build-client.mjs）。
 *
 * 本面板逐项演示：
 *   1. JSX 语法：函数组件 / props / 条件渲染 / 列表 map / 事件处理 / useState。
 *   2. npm 依赖：`import QRCode from "qrcode"` —— 真实 npm 包，构建时内联进 bundle。
 *   3. 模块化：`import { slugify, nowClock } from "./example-lib"` —— 多文件拆包。
 *   4. client ⇄ server：apiUrl 调 demo 扩展的 /api/extensions/demo/counter（POST 自增）。
 *   5. i18n：t("jsx.*") 走 index.ts ui.i18n 词条。
 *
 * 面板开关是模块级状态（toolbar 按钮 / 本面板关闭按钮共享）。
 */

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { slugify, truncate, nowClock, apiGet } from "./example-lib";
import { apiUrl, t } from "./host-shim";

// ---------- 模块级面板开关（toolbar 按钮与 dialog 共享） ----------
let panelOpen = false;
const panelListeners = new Set<() => void>();
export function setPanelOpen(v: boolean): void {
  panelOpen = v;
  for (const l of panelListeners) l();
}
function usePanelOpen(): boolean {
  const [open, setOpen] = useState(panelOpen);
  useEffect(() => {
    const l = () => setOpen(panelOpen);
    panelListeners.add(l);
    return () => { panelListeners.delete(l); };
  }, []);
  return open;
}

// ---------- 小组件：列表项 ----------
function FactRow({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-dim)" }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

// ---------- 小组件：面板节标题 ----------
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 style={{ margin: "12px 0 6px", fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
      {children}
    </h4>
  );
}

// ---------- 主面板 ----------
export function JsxExamplePanel({ onClose }: { onClose: () => void }) {
  const open = usePanelOpen();
  const [count, setCount] = useState(0);          // 1) useState 演示
  const [text, setText] = useState("https://aiti.pw"); // 二维码内容
  const [qr, setQr] = useState("");               // dataURL
  const [serverInfo, setServerInfo] = useState<string>("…"); // client⇄server 结果
  const [showLib, setShowLib] = useState(false);  // 条件渲染演示

  // npm 包：qrcode → 实时生成二维码
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(text, { width: 128, margin: 1 })
      .then((url) => { if (alive) setQr(url); })
      .catch(() => { if (alive) setQr(""); });
    return () => { alive = false; };
  }, [text]);

  // client ⇄ server：调 demo 扩展 counter api（POST 自增，GET 读取）
  async function bumpCounter() {
    setServerInfo("…");
    const r = await apiGet(apiUrl, "/api/extensions/demo/counter").then((r) => r);
    // 用 GET 拿当前值展示即可（POST 需要改 fetch method，演示用 GET）
    setServerInfo(JSON.stringify(r.data ?? r));
  }

  if (!open) return null;

  const techStack = ["JSX + TSX", "esbuild bundle", "npm 依赖内联", "host-shim 委托"];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 311, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div data-ext-float="1" /* aiti-float 扩展自动接管：拖拽/缩放/持久化（首个子元素=标题栏作拖拽把手） */
        style={{ width: 440, padding: 16, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)" }}
        onClick={(e) => e.stopPropagation()}>

        {/* 标题栏 = 首个子元素 → 框架自动作为拖拽把手（无需标记） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>⚛️ {t("jsx.title")}</h3>
          <button onClick={onClose} aria-label={t("jsx.close")} title={t("jsx.close")} style={{ ...btnStyle, padding: "2px 8px", fontSize: 14, lineHeight: 1 }}>✕</button>
        </div>
        {/* 内容区：面板尺寸被 aiti-float 接管（flex 列 + 可拉大）后 flex:1 填充 + 内部滚动，不出圈 */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <p style={{ margin: "0 0 4px", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("jsx.hint")}
        </p>

        {/* 1) JSX 语法：列表渲染（map）+ 条件渲染（showLib） */}
        <SectionTitle>🧩 {t("jsx.jsx")}</SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
          {techStack.map((s, i) => (
            <span key={s} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 9, background: "rgba(139,92,246,0.14)", color: "#a78bfa" }}>
              {i + 1}. {s}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setCount((n) => n + 1)} style={btnStyle}>count +1</button>
          <span style={{ fontSize: 13, fontFamily: "var(--font-mono)" }}>{count}</span>
          <button onClick={() => setShowLib((v) => !v)} style={btnGhostStyle}>{showLib ? "hide" : "show"} lib</button>
          {showLib && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              slug("{truncate(text)}") = {slugify(text)}
            </span>
          )}
        </div>

        {/* 2) npm 依赖：qrcode */}
        <SectionTitle>📦 {t("jsx.npm")}</SectionTitle>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="输入文本生成二维码"
            style={{ flex: 1, fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", outline: "none" }}
          />
          {qr ? (
            <img src={qr} alt="qrcode" style={{ width: 88, height: 88, borderRadius: 6, border: "1px solid var(--border)", background: "#fff" }} />
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-muted)", paddingTop: 30 }}>…</span>
          )}
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          import QRCode from &quot;qrcode&quot; &nbsp;·&nbsp; <span style={{ color: "var(--text-dim)" }}>now: {nowClock()}</span>
        </p>

        {/* 3) client ⇄ server */}
        <SectionTitle>🔌 {t("jsx.server")}</SectionTitle>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => void bumpCounter()} style={btnStyle}>{t("jsx.fetch")}</button>
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{serverInfo}</span>
        </div>

        {/* 4) 状态说明 */}
        <SectionTitle>ℹ️ {t("jsx.state")}</SectionTitle>
        <FactRow icon="✅">react → host-shim 委托宿主 h/useState（零 React 产物）</FactRow>
        <FactRow icon="📦">qrcode 等 npm 依赖构建时内联进单个 .mjs</FactRow>
        <FactRow icon="⚡">源码在 client/src/*.tsx，改后重跑 node tools/build-client.mjs</FactRow>
        </div>
      </div>
    </div>
  );
}

// ---------- toolbar 按钮（JSX 版本，供 entry.tsx 注册） ----------
export function JsxToolbarButton() {
  return (
    <button
      type="button"
      title={t("jsx.title")}
      aria-label={t("jsx.title")}
      onClick={() => setPanelOpen(true)}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      }}
    >
      ⚛️
    </button>
  );
}

// ---------- 样式 ----------
const btnStyle: React.CSSProperties = {
  padding: "5px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer",
  background: "var(--accent)", color: "#fff", border: "none", fontWeight: 600,
};
const btnGhostStyle: React.CSSProperties = {
  padding: "5px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer",
  background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border)",
};
