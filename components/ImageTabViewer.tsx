"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * 右栏图片预览 tab 内容（Tab.kind:"image"）。消息里的图片（用户发送图 base64、
 * 会话工具结果图 API URL 等）没有磁盘路径，走不了 FileViewer 的票据/watch 链路，
 * 这里直接渲染传入的 src：棋盘格透明底 + 自然尺寸 + 下载。磁盘图片文件仍走
 * FileViewer 的 ImageViewer（LocalImage 点击 → openFile），两者互不替代。
 */

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
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  if (!src) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
        {t("files.imageTabEmpty")}
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
