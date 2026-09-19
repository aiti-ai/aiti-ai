"use client";

import { ensureExtMaterialized } from "./ExtSlots";

/**
 * Host bridge from message/composer/markdown images to the file-editor
 * extension's unified viewer (floating window).
 *
 * Image preview no longer has a host container (the image-tab mechanism was
 * removed): the extension exposes openImagePreview(src, {alt}) on __aitiEditor —
 * same convention as hasFileFace/openFileFace ("host may call optionally,
 * everything degrades gracefully when the extension is absent"). Before calling,
 * materialize the file-editor extension idempotently (it is a lazy extension;
 * an image click is an interaction moment, so the first click completes the load
 * incidentally, with a 1.5s timeout as the fallback).
 *
 * Returns false (not installed / not materialized / timeout / exception /
 * extension did not implement it) → caller falls back to upstream behavior
 * (ImagePreview's native lightbox dialog; markdown images stay inert).
 */
export async function openImageInEditorViewer(
  src: string,
  options?: { alt?: string },
): Promise<boolean> {
  if (!src) return false;
  try {
    await Promise.race([
      ensureExtMaterialized("aiti-editor"),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    const ed = (window as unknown as {
      __aitiEditor?: { openImagePreview?: (src: string, options?: { alt?: string }) => boolean };
    }).__aitiEditor;
    if (typeof ed?.openImagePreview === "function") {
      return ed.openImagePreview(src, options) !== false;
    }
  } catch { /* extension unavailable → caller falls back */ }
  return false;
}
