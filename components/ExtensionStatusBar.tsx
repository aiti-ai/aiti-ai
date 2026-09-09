"use client";

import { useEffect, useRef, useState } from "react";
import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
}) {
  if (statuses.length === 0 && widgets.length === 0) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`}
    >
      {widgets.length > 0 && <ExtensionWidgets widgets={widgets} />}
      {statuses.length > 0 && (
        <div
          role="status"
          className="extension-status-line"
          aria-label={plainStatusLine}
          title={plainStatusLine}
        >
          <span className="extension-status-text">
            <AnsiText text={statusLine} />
          </span>
        </div>
      )}
    </div>
  );
}

/** 小屏状态架替代（docs/pi-web-mobile-input-wechat-plan.md §六）：状态架不常驻，
 *  合并文本变化时弹 3s 胶囊提示（详情在 ⓘ sheet 查看）。流式高频更新按 1s 合并——
 *  合并窗口内的连续变化只弹一次；提示只报「有更新」，不内联状态全文。 */
export function ExtensionStatusToast({ statuses }: { statuses: ExtensionStatusItem[] }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const prevLineRef = useRef<string | null>(null);
  const coalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const line = formatExtensionStatusLine(statuses);

  useEffect(() => {
    const prev = prevLineRef.current;
    prevLineRef.current = line;
    // 首次渲染/空行/内容未变：不弹
    if (prev === null || !line || line === prev) return;
    if (coalesceTimerRef.current) clearTimeout(coalesceTimerRef.current);
    coalesceTimerRef.current = setTimeout(() => {
      coalesceTimerRef.current = null;
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setVisible(false), 3000);
    }, 1000);
  }, [line]);

  useEffect(() => () => {
    if (coalesceTimerRef.current) clearTimeout(coalesceTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  if (!visible) return null;
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "2px 0 6px" }} role="status">
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          maxWidth: "100%",
          padding: "4px 12px",
          borderRadius: 999,
          background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
          border: "1px solid var(--border)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.10)",
          fontSize: 11.5,
          color: "var(--text-muted)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {t("chat.extStatusToast")}
      </span>
    </div>
  );
}
