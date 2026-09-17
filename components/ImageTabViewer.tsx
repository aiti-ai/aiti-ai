"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ExtItemBoundary, ensureExtSlotMaterialized } from "./ExtSlots";
import { getExtUiItems, hasExtRender, subscribeExtUi, type ExtUiItemRegistered } from "@/lib/ext-ui-store";

/**
 * 右栏图片预览 tab 内容（Tab.kind:"image"）。消息里的图片（用户发送图 base64、
 * 会话工具结果图 API URL 等）没有磁盘路径，走不了 FileViewer 的票据/watch 链路。
 *
 * 渲染分两层（fileViewer 同款接管跳板范式）：
 *  - imageViewer slot 扩展项（aiti-editor）meta.match(src) 命中 → 交给扩展的全功能
 *    查看器（缩放/平移/旋转/信息面板等，与磁盘图片共用同一套查看器 UI）——图片预览合一；
 *  - 无命中（未注册/未物化）→ 核心简版兜底：棋盘格透明底 + 自然尺寸 + 下载，行为零回归。
 */

/** imageViewer 接管槽稳定空快照（SSR/未接管时不接管，避免 useSyncExternalStore 重渲染循环）。 */
const IMAGE_VIEWER_NO_ITEMS: ExtUiItemRegistered[] = [];

function guessExtension(src: string): string {
  if (src.startsWith("data:")) {
    const mime = src.slice(5, src.indexOf(";") > 0 ? src.indexOf(";") : undefined);
    const ext = mime.split("/")[1];
    return ext && ext !== "*" ? ext.replace("+xml", "") : "png";
  }
  const path = src.split(/[?#]/)[0];
  const last = path.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "png";
}

export function ImageTabViewer({ src, alt }: { src: string; alt?: string }) {
  const { t } = useI18n();
  // —— 扩展接管跳板（aiti-editor）：imageViewer slot 项的 meta.match(src, {alt}) 命中 →
  //    交给扩展渲染（与文件图片共用同一查看器）；无命中 → 核心简版兜底。
  const takeoverItems = useSyncExternalStore(
    subscribeExtUi,
    () => getExtUiItems("imageViewer"),
    () => IMAGE_VIEWER_NO_ITEMS, // 服务端稳定空快照（SSR 不接管；hydration 后接管项生效）
  );
  // [懒加载 v2] 接管跳板补触发：消息图片 tab 打开 = 用户可感知的交互时刻——声明
  // imageViewer 的懒扩展（aiti-editor）在首次接管判定前一次性物化；未到位时核心简版
  // 兜底，物化完成 store bump → 重渲染 → 下一次渲染接管生效。
  useEffect(() => {
    void ensureExtSlotMaterialized("imageViewer");
  }, []);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  // 空 src（正常入口已拦截；防御恢复链异常态）：核心空态提示，不派发接管判定
  if (!src) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
        {t("files.imageTabEmpty")}
      </div>
    );
  }

  const takeover = takeoverItems.find((item) => {
    if (!hasExtRender(item)) return false;
    const match = item.meta?.match;
    return typeof match === "function" && match(src, { alt });
  });

  if (takeover && hasExtRender(takeover)) {
    // 容器给 position:relative（接管查看器为 absolute inset:0 自占满）
    return (
      <div style={{ height: "100%", position: "relative", overflow: "hidden" }}>
        <ExtItemBoundary extId={takeover.extId} slot="imageViewer" itemId={takeover.id}>
          <takeover.render src={src} alt={alt} />
        </ExtItemBoundary>
      </div>
    );
  }

  const ext = guessExtension(src);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={alt || undefined}>
          {alt || t("files.imageTab")}
        </span>
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>{ext}</span>
        {naturalSize && <span style={{ flexShrink: 0 }}>{naturalSize.w} × {naturalSize.h}</span>}
        <a
          href={src}
          download={alt?.includes(".") ? alt : `image.${ext}`}
          title={t("files.download")}
          aria-label={t("files.download")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, flexShrink: 0,
            color: "var(--text-dim)", cursor: "pointer", transition: "color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          // 用 backgroundColor longhand，避免与下方 backgroundImage/backgroundSize
          // longhand 混用触发 React shorthand 冲突告警
          backgroundColor: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {failed ? (
          <div style={{ color: "#f87171", fontSize: 13 }}>{t("files.imageTabError")}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt || "image"}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setFailed(true)}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}
