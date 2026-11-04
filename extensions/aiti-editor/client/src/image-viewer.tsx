/**
 * aiti-editor · 图片查看器——常规图片预览基本能力：
 * 缩放（按钮/滚轮/Ctrl+滚轮，以光标为中心）、适应窗口、1:1、拖拽平移、
 * 双击切换 适应↔100%、旋转、信息面板（尺寸/大小/格式/时间）、新窗口打开。
 * 零依赖，内联样式，随 src 变化自动复位。
 */
import { useState, useEffect, useRef, useCallback } from "react";
import exifr from "exifr";
import { formatSize, guessImageExt } from "./lib";

const MIN_SCALE = 0.02;
const MAX_SCALE = 40;

function clampScale(s: number) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }

/** EXIF 快门时间格式化：0.004 → 1/250；2 → 2s */
function fmtShutter(t: any): string {
  const n = Number(t);
  if (!isFinite(n) || n <= 0) return "—";
  if (n >= 1) return n.toFixed(n % 1 ? 1 : 0) + "s";
  return "1/" + Math.round(1 / n);
}

/** EXIF 常用项提取 → [label, value] 列表（无则空数组） */
function exifRows(e: Record<string, any>): [string, string][] {
  if (!e) return [];
  const rows: [string, string][] = [];
  const cam = [e.Make, e.Model].filter(Boolean).join(" ").trim();
  if (cam) rows.push(["相机", cam]);
  if (e.LensModel) rows.push(["镜头", String(e.LensModel)]);
  let dt = e.DateTimeOriginal || e.DateTimeDigitized || e.DateTime || e.CreateDate;
  if (dt) {
    try {
      const d = dt instanceof Date ? dt : new Date(dt);
      dt = isNaN(d.getTime()) ? String(dt) : d.toLocaleString("zh-CN", { hour12: false });
    } catch { dt = String(dt); }
    rows.push(["拍摄时间", String(dt)]);
  }
  const params: string[] = [];
  if (e.ISO) params.push("ISO " + e.ISO);
  if (e.FNumber) params.push("f/" + Number(e.FNumber).toFixed(1));
  if (e.ExposureTime) params.push(fmtShutter(e.ExposureTime));
  if (e.FocalLength) params.push(Number(e.FocalLength).toFixed(1).replace(/\.0$/, "") + "mm");
  if (params.length) rows.push(["参数", params.join(" · ")]);
  if (typeof e.Latitude === "number" && typeof e.Longitude === "number"
      && isFinite(e.Latitude) && isFinite(e.Longitude)
      && (e.Latitude !== 0 || e.Longitude !== 0)) {
    rows.push(["GPS", e.Latitude.toFixed(6) + ", " + e.Longitude.toFixed(6) + " ↗" ]);
  }
  return rows;
}

function fmtTime(ms: any): string {
  if (!ms) return "—";
  try {
    const d = new Date(typeof ms === "number" ? ms : Number(ms));
    if (isNaN(d.getTime())) return String(ms);
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch { return String(ms); }
}

export function ImageViewer(props: {
  src: string;
  /** 磁盘文件路径（文件场景）；消息/输入框图片无路径 → 缺省 */
  filePath?: string;
  /** 展示名（信息面板/alt；缺省取 filePath 末段，再兜底 "image"） */
  displayName?: string;
  /** 提供时工具条显示下载按钮（消息图片「保存到本地」；文件场景下载在 FileToolbar，不重复） */
  downloadName?: string;
  /** 字节大小（文件场景来自 meta；消息场景可由调用方按 data URL 估算） */
  fileSize?: number;
  mtimeMs?: number;
  /** 加载失败回调（票据过期等）——调用方可换票换 src 自愈；返回 truthy 表示已接手，不进失败态 */
  onSrcError?: () => boolean | void }) {
  const { src, filePath, displayName, downloadName, fileSize, mtimeMs, onSrcError } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // 视图状态：mode="fit"（适应窗口）或 free（自由倍率）；x/y 为平移偏移；rot 旋转角度（度）
  const [mode, setMode] = useState<"fit" | "free">("fit");
  const [freeScale, setFreeScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [rot, setRot] = useState(0);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  // 复制图片到剪贴板：瞬时反馈文案
  const [copyFb, setCopyFb] = useState<string | null>(null);
  const copyTimerRef = useRef<any>(null);
  // ── 指针手势（触屏 pinch / double-tap）：pointers 集合跟踪活跃指针；≥2 指进入捏合 ──
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist0: number; scale0: number; pos0: { x: number; y: number }; cx0: number; cy0: number; centerX: number; centerY: number } | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  // ── EXIF 懒解析：首次展开信息面板才拉取解析（不拖累普通预览）──
  const [exifData, setExifData] = useState<Record<string, any> | null>(null);
  const [exifState, setExifState] = useState<"idle" | "loading" | "done">("idle");
  useEffect(() => { setExifData(null); setExifState("idle"); }, [src]);
  useEffect(() => {
    if (!showInfo || exifState !== "idle") return;
    let cancelled = false;
    setExifState("loading");
    fetch(src).then((r) => r.blob())
      .then((b) => exifr.parse(b))
      .then((d: any) => {
        if (!cancelled) { setExifData(d && Object.keys(d).length ? d : null); setExifState("done"); }
      })
      .catch(() => { if (!cancelled) setExifState("done"); }); // 不支持/无 EXIF 同样按完成处理
    return () => { cancelled = true; };
  }, [showInfo, src, exifState]);

  const scale = mode === "fit" ? fitScale : freeScale;
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const modeRef = useRef(mode); modeRef.current = mode;
  const posRef = useRef(pos); posRef.current = pos;
  const rotRef = useRef(rot); rotRef.current = rot;

  // 计算适应窗口倍率（只缩小不放大：cap 到 1）
  const computeFit = useCallback(() => {
    const el = wrapRef.current, img = imgRef.current;
    if (!el || !img || !img.naturalWidth) return;
    const pad = 24;
    const cw = Math.max(el.clientWidth - pad, 10), ch = Math.max(el.clientHeight - pad, 10);
    const s = Math.min(cw / img.naturalWidth, ch / img.naturalHeight, 1);
    setFitScale(s);
    return s;
  }, []);

  // src 变化 → 全部复位（含手势残留状态）
  useEffect(() => {
    setLoaded(false); setLoadErr(false); setDims(null);
    setMode("fit"); setFreeScale(1); setPos({ x: 0, y: 0 }); setRot(0); setShowInfo(false);
    pointersRef.current.clear(); pinchRef.current = null; lastTapRef.current = null;
  }, [src]);

  // 容器尺寸变化 → fit 模式下重新适配并居中
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (modeRef.current === "fit") { computeFit(); setPos({ x: 0, y: 0 }); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [computeFit]);

  const onLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    setDims({ w: img.naturalWidth, h: img.naturalHeight });
    setLoaded(true);
    // 等布局稳定后再算 fit（transform 不影响容器尺寸，同步即可）
    computeFit();
  };

  // 已完成图的加载兜底：data:/内存缓存图在 src 置上时可能已解码完成且不再派发 load
  // 事件（Chrome 实测消息 data 图首开：complete=true、window 层 load 计数=0 → loaded
  // 恒 false → opacity:0 全空白，关掉重开才恢复）。src 变化后补一次 complete 探测，
  // 与 onLoad/onError 事件互为双保险（事件正常派发时此处按同态幂等，无副作用）。
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth) onLoad();
    else if (!onSrcError || !onSrcError()) setLoadErr(true);
  }, [src]);

  // ── 缩放（可选锚点：以某屏幕点为中心保持不动；缺省以视图中心）──
  const zoomAt = useCallback((nextRaw: number, anchor?: { px: number; py: number }) => {
    const el = wrapRef.current;
    if (!el) return;
    const cur = scaleRef.current;
    const next = clampScale(nextRaw);
    if (Math.abs(next - cur) < 1e-6) return;
    // 贴近适应倍率时吸附回 fit 模式
    if (Math.abs(next - fitScale) / Math.max(fitScale, 1e-6) < 0.04) {
      setMode("fit"); setPos({ x: 0, y: 0 });
      return;
    }
    let dx = 0, dy = 0;
    if (anchor) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      // 锚点相对视图中心；保持该内容点在缩放前后位置不变
      const p = posRef.current;
      const ax = anchor.px - cx - p.x, ay = anchor.py - cy - p.y;
      dx = ax - ax * (next / cur);
      dy = ay - ay * (next / cur);
    }
    setMode("free");
    setFreeScale(next);
    setPos((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  }, [fitScale]);

  const zoomStep = useCallback((factor: number) => zoomAt(clampScale(scaleRef.current * factor)), [zoomAt]);

  // 适应/1:1 切换（双击、触屏 double-tap 共用）
  const toggleFitOneToOne = useCallback(() => {
    if (modeRef.current !== "fit") { setMode("fit"); setPos({ x: 0, y: 0 }); }
    else zoomAt(1);
  }, [zoomAt]);

  // 滚轮缩放（以光标为锚点）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAt(clampScale(scaleRef.current * factor), { px: e.clientX, py: e.clientY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ── 指针手势：单指拖拽平移；双指捏合缩放（以两指中点为锚，同时跟随中点位移）──
  // 触屏没有滚轮/快捷键 → pinch 是小屏放大看图的主通道（v1 只支持单指拖拽，小屏无法缩放）。
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const ptDist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const firstTwo = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
    const pts = [...pointersRef.current.values()];
    return pts.length >= 2 ? [pts[0], pts[1]] : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch" && e.button !== 0) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* 指针可能已释放：忽略 */ }
    const pair = firstTwo();
    if (pair) {
      // 双指：结束单指拖拽，记录捏合基准（起始倍率/位移/中点/容器中心）
      dragRef.current = null;
      setGrabbing(false);
      const rect = wrapRef.current?.getBoundingClientRect();
      pinchRef.current = {
        dist0: Math.max(ptDist(pair[0], pair[1]), 1),
        scale0: scaleRef.current,
        pos0: { ...posRef.current },
        cx0: (pair[0].x + pair[1].x) / 2,
        cy0: (pair[0].y + pair[1].y) / 2,
        centerX: rect ? rect.left + rect.width / 2 : e.clientX,
        centerY: rect ? rect.top + rect.height / 2 : e.clientY,
      };
      return;
    }
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: posRef.current.x, oy: posRef.current.y, moved: false };
    setGrabbing(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return; // 非本容器起始的指针（如工具条内部）
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = pinchRef.current;
    if (pinch) {
      const pair = firstTwo();
      if (!pair) return;
      const dist = Math.max(ptDist(pair[0], pair[1]), 1);
      const cx = (pair[0].x + pair[1].x) / 2, cy = (pair[0].y + pair[1].y) / 2;
      // 由「起始状态 × 累计倍率」直接求解（不逐帧累加，避免漂移）：
      // 缩放锚点 = 起始中点处的内容点，保持其在当前中点不动；中点位移即平移。
      const nextScale = clampScale(pinch.scale0 * (dist / pinch.dist0));
      const k = nextScale / pinch.scale0;
      const ax = pinch.cx0 - pinch.centerX - pinch.pos0.x;
      const ay = pinch.cy0 - pinch.centerY - pinch.pos0.y;
      setMode("free");
      setFreeScale(nextScale);
      setPos({ x: cx - pinch.centerX - ax * k, y: cy - pinch.centerY - ay * k });
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.sx) > 4 || Math.abs(e.clientY - d.sy) > 4) d.moved = true;
    setPos({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
  };

  const endPointer = (e: React.PointerEvent) => {
    if (!pointersRef.current.delete(e.pointerId)) return;
    if (pointersRef.current.size === 1) {
      // 双指 → 单指：以剩余指针重置拖拽基准（避免余指移动跳变）
      pinchRef.current = null;
      const [p] = [...pointersRef.current.values()];
      dragRef.current = { sx: p.x, sy: p.y, ox: posRef.current.x, oy: posRef.current.y, moved: true };
      return;
    }
    if (pointersRef.current.size >= 2) return; // >2 指：保持捏合
    const wasPinching = !!pinchRef.current;
    pinchRef.current = null;
    const d = dragRef.current;
    dragRef.current = null;
    setGrabbing(false);
    // 捏合结束后倍率贴近适应倍率 → 吸附回 fit（与滚轮一致；捏合过程中不吸附避免跳变）
    if (wasPinching) {
      const s = scaleRef.current;
      if (Math.abs(s - fitScale) / Math.max(fitScale, 1e-6) < 0.04) { setMode("fit"); setPos({ x: 0, y: 0 }); }
      return;
    }
    // 触屏 double-tap → 适应/100% 切换（触屏浏览器多数不发 dblclick；手动检测）
    if (e.pointerType === "touch" && d && !d.moved) {
      const now = Date.now();
      const last = lastTapRef.current;
      if (last && now - last.t < 350 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 32) {
        lastTapRef.current = null;
        toggleFitOneToOne();
      } else {
        lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  };
  // 复制图片：当前帧绘制到 canvas → PNG blob → ClipboardItem（SVG/跨域污染/不支持时降级提示）
  const copyImage = () => {
    const img = imgRef.current;
    const doFb = (t: string) => {
      setCopyFb(t);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => { copyTimerRef.current = null; setCopyFb(null); }, 1600);
    };
    if (!img || !img.naturalWidth) { doFb("未加载"); return; }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const c2d = canvas.getContext("2d");
      if (!c2d) { doFb("复制失败"); return; }
      c2d.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob || !(navigator.clipboard as any) || typeof (window as any).ClipboardItem === "undefined") { doFb("浏览器不支持"); return; }
        navigator.clipboard.write([new (window as any).ClipboardItem({ "image/png": blob })])
          .then(() => doFb("已复制"))
          .catch(() => doFb("复制失败"));
      }, "image/png");
    } catch { doFb("该格式无法复制"); }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    toggleFitOneToOne();
  };

  // 键盘快捷键：+/-/0/1/r
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target && (e.target as HTMLElement).tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "+" || e.key === "=") zoomStep(1.25);
      else if (e.key === "-" || e.key === "_") zoomStep(1 / 1.25);
      else if (e.key === "0") { setMode("fit"); setPos({ x: 0, y: 0 }); }
      else if (e.key === "1") zoomAt(1);
      else if (e.key.toLowerCase() === "r") setRot((r) => (r + 90) % 360);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomAt, zoomStep]);

  const name = (displayName || "").trim() || (filePath ? filePath.split("/").pop() || filePath : "") || "image";
  const ext = (name.includes(".") ? (name.split(".").pop() || "") : guessImageExt(src)).toUpperCase() || "—";
  const isDataUrl = src.startsWith("data:");
  const pct = Math.round(scale * 100);
  const isDark = (() => { try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; } })();
  const uiBg = isDark ? "rgba(30,30,34,0.92)" : "rgba(255,255,255,0.94)";
  const uiFg = isDark ? "#ddd" : "#333";
  const uiBorder = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)";

  const tbtn = (label: string, title: string, onClick: () => void, extra?: Record<string, any>) => (
    <button type="button" title={title} onClick={onClick}
      style={{ border: "none", background: "transparent", color: uiFg, cursor: "pointer", fontSize: 13,
        padding: "3px 7px", borderRadius: 6, lineHeight: 1, fontFamily: "inherit",
        display: "inline-flex", alignItems: "center", ...extra }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.07)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >{label}</button>
  );

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, overflow: "hidden",
        background: "repeating-conic-gradient(var(--bg, #26262b) 0% 25%, var(--bg-panel, #2e2e33) 0% 50%) 50% / 22px 22px",
        cursor: grabbing ? "grabbing" : "grab", userSelect: "none", touchAction: "none" }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer}
      onDoubleClick={onDoubleClick}
    >
      {/* 图片本体 */}
      {!loadErr && (
        <img ref={imgRef} src={src} alt={name} draggable={false}
          onLoad={onLoad}
          onError={() => { if (!onSrcError || !onSrcError()) setLoadErr(true); }}
          style={{ position: "absolute", left: "50%", top: "50%", maxWidth: "none", maxHeight: "none",
            opacity: loaded ? 1 : 0, transition: "opacity 0.15s",
            transform: `translate(-50%,-50%) translate(${pos.x}px,${pos.y}px) rotate(${rot}deg) scale(${scale})`,
            transformOrigin: "center center", imageRendering: scale >= 3 ? "pixelated" : "auto" }} />
      )}
      {loadErr && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            color: "#f87171", fontSize: 13 }}>图片加载失败</div>
      )}

      {/* 底部工具条（小屏：maxWidth + 换行 + 安全区，缩放按钮不再被裁出屏幕） */}
      <div style={{ position: "absolute", bottom: "max(14px, env(safe-area-inset-bottom, 0px) + 8px)", left: "50%", transform: "translateX(-50%)",
          display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 2,
          padding: "4px 8px", borderRadius: 20, maxWidth: "calc(100% - 16px)", boxSizing: "border-box",
          background: uiBg, backdropFilter: "blur(6px)", border: `1px solid ${uiBorder}`,
          boxShadow: "0 4px 14px rgba(0,0,0,0.25)", zIndex: 5,
          cursor: "default", pointerEvents: "auto" }}
        onPointerDown={(e) => e.stopPropagation()} onPointerMove={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      >
        {tbtn("−", "缩小（-）", () => zoomStep(1 / 1.25))}
        <span title={"当前缩放 " + pct + "%\n点击回到 100%"}
          onClick={() => zoomAt(1)}
          style={{ minWidth: 52, textAlign: "center", fontSize: 12, fontFamily: "var(--font-mono, ui-monospace, monospace)",
            color: uiFg, cursor: "pointer", padding: "3px 4px", borderRadius: 6,
            background: mode === "free" ? "transparent" : (isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") }}>
          {pct + "%" + (mode === "fit" ? " 适" : "")}
        </span>
        {tbtn("+", "放大（+）", () => zoomStep(1.25))}
        <div style={{ width: 1, height: 16, background: uiBorder, margin: "0 4px" }} />
        {tbtn("⛶", "适应窗口（0）", () => { setMode("fit"); setPos({ x: 0, y: 0 }); })}
        {tbtn("1:1", "实际大小（1）", () => zoomAt(1))}
        {tbtn("⟳", "旋转 90°（R）", () => setRot((r) => (r + 90) % 360))}
        <div style={{ width: 1, height: 16, background: uiBorder, margin: "0 4px" }} />
        {tbtn(copyFb || "⧉", copyFb ? copyFb : "复制图片到剪贴板（PNG）", copyImage,
          copyFb ? { color: "#4ade80", minWidth: 28, justifyContent: "center" } : undefined)}
        {downloadName ? (
          <a href={src} download={downloadName} title="下载原图（保存到本地）" aria-label="下载原图"
            style={{ border: "none", background: "transparent", color: uiFg, cursor: "pointer", fontSize: 13,
              padding: "3px 7px", borderRadius: 6, lineHeight: 1, fontFamily: "inherit",
              display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.07)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >⬇</a>
        ) : null}
        <div style={{ width: 1, height: 16, background: uiBorder, margin: "0 4px" }} />
        {tbtn("ⓘ", "图片信息", () => setShowInfo((v) => !v), showInfo ? { background: isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.09)" } : undefined)}
        {!isDataUrl ? tbtn("↗", "新窗口打开原图", () => window.open(src, "_blank")) : null}
      </div>

      {/* 信息面板 */}
      {showInfo && (
        <div style={{ position: "absolute", top: 12, left: 12, minWidth: 200, maxWidth: "70%",
            padding: "10px 14px", borderRadius: 10, background: uiBg, backdropFilter: "blur(6px)",
            border: `1px solid ${uiBorder}`, boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
            fontSize: 12, color: uiFg, lineHeight: 1.7, zIndex: 5, cursor: "default",
            pointerEvents: "auto", wordBreak: "break-all" }}
          onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12.5 }}>{name}</div>
          {[
            ["格式", ext],
            ["尺寸", dims ? (dims.w + " × " + dims.h + " px") : "—"],
            ["大小", typeof fileSize === "number" && fileSize > 0 ? formatSize(fileSize) : "—"],
            ["修改时间", fmtTime(mtimeMs)],
            ["缩放", pct + "%" + (mode === "fit" ? "（适应窗口）" : "")],
            ["旋转", rot === 0 ? "—" : (rot + "°")],
          ].map(([k, v]) => (
            <div key={k as string} style={{ display: "flex", gap: 10 }}>
              <span style={{ flex: "0 0 auto", opacity: 0.6 }}>{k}</span>
              <span style={{ fontFamily: k === "尺寸" || k === "缩放" || k === "旋转" ? "var(--font-mono, ui-monospace, monospace)" : undefined }}>{v as string}</span>
            </div>
          ))}
          {/* EXIF 区块：懒解析，点开 ⓘ 才拉取 */}
          {(() => {
            const rows = exifRows(exifData);
            return (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${uiBorder}` }}>
                <div style={{ fontWeight: 600, marginBottom: 2, fontSize: 11.5, opacity: 0.75 }}>EXIF</div>
                {exifState === "loading" && <div style={{ opacity: 0.6, fontSize: 11.5 }}>解析中…</div>}
                {exifState === "done" && rows.length === 0 && <div style={{ opacity: 0.6, fontSize: 11.5 }}>无 EXIF 信息</div>}
                {rows.map(([k, v]) => (
                  k === "GPS" ? (
                    <div key={k} style={{ display: "flex", gap: 10 }}>
                      <span style={{ flex: "0 0 auto", opacity: 0.6 }}>{k}</span>
                      <a href={`https://www.openstreetmap.org/?mlat=${exifData!.Latitude}&mlon=${exifData!.Longitude}#map=16/${exifData!.Latitude}/${exifData!.Longitude}`}
                        target="_blank" rel="noreferrer" style={{ color: "#4f8ef7", textDecoration: "none" }}
                        onPointerDown={(e) => e.stopPropagation()}>{v.replace(" ↗", "")} ↗</a>
                    </div>
                  ) : (
                    <div key={k} style={{ display: "flex", gap: 10 }}>
                      <span style={{ flex: "0 0 auto", opacity: 0.6 }}>{k}</span>
                      <span>{v}</span>
                    </div>
                  )
                ))}
              </div>
            );
          })()}
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${uiBorder}`, opacity: 0.55, fontSize: 11 }}>
            {"拖拽平移 · 滚轮缩放 · 双击 适应/100%"}
          </div>
        </div>
      )}

      {/* 快捷键提示（首次加载后短暂显示可省略；此处仅放 title 提示在工具条上） */}
    </div>
  );
}
