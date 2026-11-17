/**
 * ExtItemIcon — shared renderer for declarative extension item icons
 * (ExtUiItem.icon: {svg} markup / ".svg" asset path / emoji-text fallback).
 *
 * Extracted from AppShell (was module-private renderExtItemIcon) so TabBar can
 * render the same contract for dock tabs without importing AppShell (which
 * imports TabBar — a cycle). Dock tabs read the registering entry's meta.icon
 * (same serializable data the toolbar consumes); the generic four-cell grid
 * glyph stays as the fallback when an entry declares no icon.
 */
import type { ReactNode } from "react";
import { apiUrl } from "@/lib/base-path";
import type { ExtUiItemIcon } from "@/lib/ext/types";

export function renderExtItemIcon(icon: ExtUiItemIcon | null | undefined, extId?: string, size = 16): ReactNode {
  if (icon == null) return null;
  if (typeof icon === "object" && "svg" in icon) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: icon.svg }}
      />
    );
  }
  if (typeof icon === "string" && icon.endsWith(".svg")) {
    const url = apiUrl(`/api/extensions/${extId ?? ""}/assets/${icon}`);
    return (
      <span
        aria-hidden
        style={{
          display: "inline-block", width: size, height: size, flexShrink: 0, verticalAlign: "middle",
          background: "currentColor",
          WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")`,
          WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
          WebkitMaskPosition: "center", maskPosition: "center",
          WebkitMaskSize: "contain", maskSize: "contain",
        }}
      />
    );
  }
  return <span style={{ fontSize: size + 2, lineHeight: 1 }}>{String(icon)}</span>;
}
