/**
 * entry.tsx —— 扩展 client 入口模板（JSX 版）。
 *
 * 复制后要改：
 *   1. 把本文件的注册内容换成你的 UI（toolbar/sidebar/dialogs/... 照 index.ts 的 ui 声明）。
 *   2. index.ts 的 client 字段指向构建产物（如 "client/<your-ext>.mjs"）。
 *   3. 组件文件放本目录（client/src/*.tsx），import 进来即可——vite 会全部打包。
 *
 * 注意：
 *   - __setCtx(ctx) 必须在任何 JSX 组件渲染前调用（register 第一件事）。
 *   - JSX 里 map() 列表 / svg path 数组必须给 key（宿主是 React，规则一致）。
 *   - 组件里 import { useState, useEffect } from "react" → vite alias 委托宿主，别引真 React。
 */

import { useEffect, useState } from "react"; // ← 会被 alias 委托到 host-shim（见 vite.config.ts）
import { __setCtx } from "./host-shim";

// 模块级面板开关（toolbar 按钮与 dialogs 面板共享；单入口可不要）
let panelOpen = false;
const panelListeners = new Set<() => void>();
function setPanelOpen(v: boolean) { panelOpen = v; for (const l of panelListeners) l(); }
function usePanelOpen(): boolean {
  const [open, setOpen] = useState(panelOpen);
  useEffect(() => {
    const l = () => setOpen(panelOpen);
    panelListeners.add(l);
    return () => { panelListeners.delete(l); };
  }, []);
  return open;
}

// ---------- 示例组件：一个面板 ----------
export function ExamplePanel({ onClose }: { onClose: () => void }) {
  const [count, setCount] = useState(0);
  const items = ["JSX", "npm 依赖", "vite 构建"];
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>   {/* 遮罩：装了 aiti-float(≥0.4.5) 时自动变透明+点击穿透（非模态浮窗）；豁免见 data-ext-float-keepmask */}
      {/* data-ext-float：aiti-float 扩展自动接管拖拽移动/边缘缩放/位置持久化/双击复位（pi-web-ext/aiti-float）。
          规则：属性加在「面板」上（不是遮罩）；首个子元素=标题栏自动作拖拽把手；
          面板的 width/height 交给接管方，别再自己写（初始尺寸用 data-ext-float-w/-h）。 */}
      <div data-ext-float="1" data-ext-float-w={380}
        style={{ padding: 16, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)" }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>⚛️ 模板示例面板</h3>
          {/* 右上角 ✕ 关闭（全局 UI 契约：aiti-float 的 ⛶ 最大化按钮自动插在它左侧） */}
          <button onClick={onClose} aria-label="关闭" title="关闭" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <ul style={{ margin: "10px 0", paddingLeft: 18, fontSize: 12 }}>
          {items.map((s, i) => <li key={s}>{i + 1}. {s}</li>)}
        </ul>
        <button onClick={() => setCount((n) => n + 1)} style={{ padding: "5px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: "var(--accent)", color: "#fff", border: "none" }}>
          count = {count}
        </button>
        {/* 右上角 ✕ 已承担关闭；此处不再重复底部文字按钮 */}
        </div>
      </div>
    </div>
  );
}

// ---------- 注册入口（宿主动态 import 这个 default export 并调用） ----------
export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx); // 重要：必须在任何 JSX 组件渲染前调用

  // toolbar 按钮（入口）
  function ToolbarButton() {
    return (
      <button type="button" title="打开示例" onClick={() => setPanelOpen(true)}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, padding: 0, background: "none", borderTop: "none", borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>
        ⚛️
      </button>
    );
  }

  // dialogs 面板插槽
  function DialogsSlot() {
    return <ExamplePanel onClose={() => setPanelOpen(false)} />;
  }

  ctx.registerItems?.("toolbar", [{ id: "example", render: ToolbarButton, meta: { label: "示例" } }]);
  ctx.registerItems?.("dialogs", [{ id: "example", render: DialogsSlot, meta: { label: "示例面板" } }]);
}
