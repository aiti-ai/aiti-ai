"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { openAitiCmdShell, type TerminalTab } from "./terminal-tab-state";

interface Props {
  tab: TerminalTab;
  active: boolean;
  /** 页签关闭收尾（本地移除即可——shell 生命周期归 aiti-cmd，core 无 PTY 可关） */
  onClosed: () => void;
}

/**
 * [aiti] 工作区终端页签接管桥（上游 v0.9 整合 T2）：
 * TabBar 的 terminal 页签保留（sessionStorage 会话记忆语义不变），页签内容不再渲染
 * 原版 TerminalPanel/PTY（原版实现隐藏，core 无 /api/terminal 依赖）——shell 由
 * aiti-cmd 承载（沙箱/审计/虚拟键盘/24h 会话），此处仅做唤起引导：
 *  - 首次激活自动唤起一次（restored 恢复页签除外——对齐原版「恢复不静默起 shell」语义）；
 *  - 「打开终端」按钮手动唤起 / aiti-cmd 缺席提示。
 */
export function TerminalPanelBridge({ tab, active, onClosed }: Props) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [missing, setMissing] = useState(false);
  const autoRef = useRef(false);

  useEffect(() => {
    if (tab.closing) onClosed();
  }, [tab.closing, onClosed]);

  const open = useCallback(() => {
    const ok = openAitiCmdShell(tab.cwd);
    setMissing(!ok);
    if (ok) setOpened(true);
  }, [tab.cwd]);

  useEffect(() => {
    if (!active || tab.restored || autoRef.current) return;
    autoRef.current = true;
    open();
  }, [active, tab.restored, open]);

  return (
    <section
      className="terminal-panel"
      aria-label={t("terminal.title")}
      style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, color: "var(--text-dim)", fontSize: 12 }}
    >
      <div className="terminal-panel-path" title={tab.cwd} style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: "100%", overflow: "hidden" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tab.cwd}</span>
      </div>
      <span style={{ textAlign: "center", lineHeight: 1.6, maxWidth: 420 }}>{t("terminal.managedBy")}</span>
      {!opened && (
        <button
          type="button"
          onClick={open}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 14px",
            background: "var(--bg-hover)", border: "1px solid var(--border)",
            borderRadius: 6, color: "var(--accent)", cursor: "pointer",
            fontSize: 12, fontWeight: 600,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          {t("terminal.open")}
        </button>
      )}
      {opened && <span role="status" style={{ color: "var(--text-muted)" }}>{t("terminal.title")} · aiti-cmd</span>}
      {missing && <span role="alert" style={{ color: "#ef4444" }}>{t("terminal.needAitiCmd")}</span>}
    </section>
  );
}
