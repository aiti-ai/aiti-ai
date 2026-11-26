import type { CSSProperties } from "react";
import { useCallback } from "./host-shim";

// Tap-to-reveal full text for ellipsis-truncated quota rows: on small screens
// the mono value lines (`1w 73% · Dec 1, 07:30 (time:62%)`) get cut mid-text,
// so a tap pops the complete string in a floating layer. The layer is plain
// DOM appended to document.body — immune to overflow:hidden ancestors and to
// transform-containing-block clipping inside host dialogs — and dismissed by
// tapping anywhere (catcher covers the viewport). One instance at a time.

const Z_TIP = 2147483600;

let active: HTMLElement | null = null;

export function closeFullTextTip(): void {
  active?.remove();
  active = null;
}

/** Show `text` near the tapped row (`anchor` = its viewport rect). */
export function showFullTextTip(text: string, anchor: { left: number; top: number; bottom: number }): void {
  closeFullTextTip();
  const layer = document.createElement("div");
  layer.setAttribute("data-provider-usage-tip", "");
  layer.style.cssText = "position:fixed;inset:0;z-index:" + Z_TIP + ";";

  const box = document.createElement("div");
  box.textContent = text;
  const above = anchor.top > window.innerHeight / 2;
  box.style.cssText = [
    "position:absolute;left:8px;right:8px;max-width:560px;margin:0 auto",
    above ? "bottom:" + (window.innerHeight - anchor.top + 10) + "px" : "top:" + (anchor.bottom + 10) + "px",
    "padding:8px 12px;border-radius:8px;cursor:pointer",
    "border:1px solid var(--border,#ccc)",
    "background:var(--bg-panel,#fff)",
    "color:var(--text,#111)",
    "font-family:var(--font-mono,monospace);font-size:12px;line-height:1.7",
    "white-space:pre-wrap;word-break:break-word",
    "box-shadow:0 8px 28px rgba(0,0,0,0.3)",
  ].join(";");
  layer.appendChild(box);
  layer.addEventListener("click", closeFullTextTip, { once: true });
  document.body.appendChild(layer);
  active = layer;
}

/** Mono value span with ellipsis kept as-is; tapping reveals the full text. */
export function TapFullText(props: { text: string; style?: CSSProperties; title?: string }) {
  const onClick = useCallback((e: { stopPropagation(): void; preventDefault(): void; currentTarget: HTMLElement }) => {
    // preventDefault: inside a <summary> this must not toggle the details.
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    showFullTextTip(props.text, { left: r.left, top: r.top, bottom: r.bottom });
  }, [props.text]);
  return <span style={{ ...props.style, cursor: "pointer" }} onClick={onClick}>{props.text}</span>;
}
