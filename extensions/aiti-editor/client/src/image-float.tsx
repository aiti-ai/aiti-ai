/**
 * aiti-editor · 图片预览（消息/输入框/markdown 图片，无磁盘路径）。
 *
 * 宿主入口（ImagePreview / MarkdownBody）经 window.__aitiEditor.openImagePreview(src, {alt})
 * 调用——宿主侧不再有 image tab 容器，图片预览统一由本扩展承载：
 *  - 单例（同一时刻一张图；后开替换内容）；
 *  - 形态状态机（_shared/ext-float-dock present，与文件三面同款）：默认浮窗；
 *    docked 态再开图 = 原位激活换图（不拽回浮窗）；浮窗面板声明 data-ext-float-dock
 *    → aiti-float 自动注入 ⇱ 位置菜单（停靠右栏）；任何路径关闭清形态偏好（关闭即忘）；
 *  - data-ext-float 契约（aiti-float 接管拖拽/边缘缩放/位置持久化/双击复位；
 *    小屏 data-ext-float-full 自动全屏；未装 aiti-float 时自身 fixed 样式兜底）；
 *  - 关闭 = ✕ / 点遮罩 / ESC。遮罩必须保留：aiti-float 默认把祖先链半透明遮罩中和成
 *    点击穿透（遮罩点击关闭随之失效），面板加 data-ext-float-keepmask="1" 豁免——
 *    查看器要的正是「遮罩压暗 + 点外关闭」的模态体验；ESC 走 window capture 监听兜底；
 *  - 内容 = 统一 ImageViewer（与磁盘图片同一查看器：缩放/平移/旋转/信息面板/复制/下载）。
 *
 * 渲染挂载：浮窗 = dialogs 插槽 item（宿主 AppShell <ExtSlot name="dialogs" /> 常挂；
 * item render 内 gate 判浮窗态，closed → null）；右栏停靠 = rightFileDock 插槽 item
 * （DockBody chrome="tab"，页签 ⇱/✕ 由宿主 TabBar 承担）。
 */
import { useEffect, useState } from "react";
import {
  DockBody, present, presentState, useGate, clearDockPref, declareDockZones,
} from "../../../_shared/ext-float-dock";
import { ImageViewer } from "./image-viewer";
import { estimateDataUrlBytes, guessImageExt } from "./lib";

const FLOAT_KEY = "aiti-editor:image-preview";

/** 可停靠位声明（右栏；aiti-float ⇱ 菜单 + 降级层注册表共用数据源）。 */
try { declareDockZones(FLOAT_KEY, ["right-panel"], "right-panel"); } catch { /* ignore */ }

type CurrentImage = { src: string; alt?: string };
let current: CurrentImage | null = null;
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) { try { l(); } catch { /* 单个订阅异常不影响其它 */ } }
}

/** 打开（单例：后开替换内容）。返回 true = 已接管（宿主桥据此判断；false 时宿主回退 lightbox）。
 *  落位：docked 态原位激活换图；其余默认浮窗（present "float" 记偏好，不占用 "open" 的
 *  停靠优先语义——降级层 "open" 直达停靠，会违背「默认浮窗」）。 */
export function openImagePreview(src: string, options?: { alt?: string }): boolean {
  if (!src) return false;
  current = { src, alt: options?.alt };
  emit();
  try {
    if (presentState(FLOAT_KEY).startsWith("docked:")) present(FLOAT_KEY, "open");
    else present(FLOAT_KEY, "float");
  } catch { /* 状态机异常不阻塞（当前图已入 state，gate 恢复即渲染） */ }
  return true;
}

export function closeImagePreview(): void {
  try { present(FLOAT_KEY, "close"); } catch { /* ignore */ }
}

/* ── 关闭即忘：任何路径关闭（✕/遮罩/宿主 TabBar ✕/⋮）→ 清形态偏好，下次默认浮窗 ── */
if (typeof window !== "undefined") {
  try {
    window.addEventListener("piwe-float-present-change", ((e: CustomEvent<{ key?: string; state?: string }>) => {
      const d = (e as CustomEvent<{ key?: string; state?: string }>).detail;
      if (!d || d.state !== "closed" || d.key !== FLOAT_KEY) return;
      clearDockPref(FLOAT_KEY);
    }) as EventListener);
  } catch { /* ignore */ }
}

/** 当前图订阅（浮窗/停靠两面共用单例 current）。 */
function useCurrentImage(): CurrentImage | null {
  const [img, setImg] = useState<CurrentImage | null>(current);
  useEffect(() => {
    const l = () => setImg(current);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return img;
}

/** 统一查看器（两面共用内容；容器由调用方给 flex 高度）。 */
function CurrentViewer({ img }: { img: CurrentImage }) {
  const altText = (img.alt || "").trim() || "image";
  const ext = guessImageExt(img.src) || "png";
  // 下载名：alt 本身像文件名（含扩展名）则沿用；否则按 src 类型补 image.<ext>
  const downloadName = altText.includes(".") ? altText : "image." + ext;
  return (
    <ImageViewer
      src={img.src}
      displayName={altText}
      downloadName={downloadName}
      fileSize={estimateDataUrlBytes(img.src)}
    />
  );
}

function titleOf(img: CurrentImage): string {
  return (img.alt || "").trim() || "图片预览";
}

/** 浮窗面（dialogs 插槽 item；gate = floating）。 */
export function ImageFloatFace() {
  const open = useGate(FLOAT_KEY, "float");
  const img = useCurrentImage();
  // ESC 关闭（capture：仅浮窗打开期间吃掉 ESC，不落入宿主全局快捷键）
  useEffect(() => {
    if (!open || !img) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeImagePreview();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, img]);
  if (!open || !img) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 311, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={closeImagePreview}
    >
      <div
        data-ext-float="1"
        data-ext-float-key={FLOAT_KEY}
        data-ext-float-full="1"
        data-ext-float-keepmask="1"
        data-ext-float-dock="right-panel"
        data-ext-float-dock-default="right-panel"
        style={{
          position: "fixed", width: "min(1100px, 94vw)", height: "min(760px, 88vh)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          background: "var(--bg-panel, #1a1a1a)", border: "1px solid var(--border, #444)",
          borderRadius: 12, boxShadow: "0 18px 60px rgba(0,0,0,0.4)", color: "var(--text, #ddd)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 6px", flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={titleOf(img)}>
            {titleOf(img)}
          </h3>
          <button
            type="button" aria-label="关闭" title="关闭" onClick={closeImagePreview}
            style={{ background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer", fontSize: 14, padding: "2px 8px", fontFamily: "inherit" }}
          >✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <CurrentViewer img={img} />
        </div>
      </div>
    </div>
  );
}

/** 右栏停靠面（rightFileDock 插槽 item；gate = docked:right-panel）。
 *  chrome="tab"：无头行——页签 ⇱（位置菜单）/✕ 由宿主 TabBar 承担（文件 face 同款）。 */
export function ImageDockRightFace() {
  const open = useGate(FLOAT_KEY, { dock: "right-panel" });
  const img = useCurrentImage();
  if (!open || !img) return null;
  return (
    <DockBody
      itemKey={FLOAT_KEY}
      chrome="tab"
      kind="dockable"
      zones={["right-panel"]}
      defaultZone="right-panel"
      title={titleOf(img)}
      onClose={closeImagePreview}
    >
      <div style={{ position: "absolute", inset: 0 }}>
        <CurrentViewer img={img} />
      </div>
    </DockBody>
  );
}
