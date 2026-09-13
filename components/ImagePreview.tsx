"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useOpenImagePanel } from "./image-panel-context";

interface ImagePreviewProps {
  src: string;
  alt?: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function ImagePreview({ src, alt = "", children, className, style }: ImagePreviewProps) {
  const { t } = useI18n();
  // 宿主接了「右栏图片预览」（AppShell）时点击开文件面板 tab（可多开、不遮挡消息）；
  // 无宿主（独立页面等）回退全屏 lightbox dialog。
  const openInPanel = useOpenImagePanel();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const openPreview = () => {
    if (openInPanel) {
      openInPanel(src, { alt });
      return;
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = triggerRef.current;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeButtonRef.current?.focus({ preventScroll: true });

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [open]);

  const closePreview = () => {
    if (dialogRef.current?.open) dialogRef.current.close();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        style={{
          display: "block",
          padding: 0,
          border: "none",
          background: "none",
          color: "inherit",
          cursor: "zoom-in",
          ...style,
        }}
        onClick={openPreview}
        aria-label={openInPanel ? t("chat.openImagePanel") : t("chat.previewImage")}
        aria-haspopup={openInPanel ? undefined : "dialog"}
        aria-expanded={openInPanel ? undefined : open}
        title={openInPanel ? t("chat.openImagePanel") : t("chat.previewImage")}
      >
        {children}
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className="image-preview-dialog"
          aria-label={t("chat.previewImage")}
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            closePreview();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closePreview();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closePreview();
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="image-preview-image" src={src} alt={alt} />
          <button
            ref={closeButtonRef}
            type="button"
            className="image-preview-close"
            onClick={closePreview}
            aria-label={t("chat.close")}
            title={t("chat.close")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </dialog>
      )}
    </>
  );
}
