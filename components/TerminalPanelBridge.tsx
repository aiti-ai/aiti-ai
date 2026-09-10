"use client";

import { useEffect } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useExtSlotItems, ExtItemBoundary, useExtSlotSettled } from "./ExtSlots";
import { hasExtRender } from "@/lib/ext-ui-store";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalTab } from "./terminal-tab-state";

interface Props {
  tab: TerminalTab;
  active: boolean;
  /** 页签关闭收尾（接管态 = 本地移除即可——shell 生命周期归 aiti-cmd；原生兜底态由
   *  TerminalPanel 等创建与在途输入收尾完成后再回调，重启/失败语义见 docs/terminal.md）。 */
  onClosed: () => void;
  /** 原生兜底层专用：重启/关闭失败经宿主页签状态机（接管态由扩展自行处置）。 */
  onRestart?: () => void;
  onCloseError?: () => void;
  /** 透传 terminalDock.openShellTab：扩展「＋ 新建」→ 同 cwd 强制新开 shell 页签 */
  onOpenShellTab?: (cwd: string) => void;
}

/**
 * [aiti] 工作区终端页签接管桥（上游 v0.9 整合 T2 → dock 真接管 + 原生 PTY 兜底）：
 *
 * - aiti-cmd 注册 `terminalDock` 插槽（真接管）：页签内**直接渲染**扩展终端视图
 *   （xterm），不再是「引导唤起弹窗」的间接形态。渲染归属（页签 ⇄ 弹窗）由扩展侧
 *   单实例状态机保证二选一：dock 态时弹窗内显示占位，⇲ 拉回窗口后弹窗恢复。
 * - manifest 就绪且无人声明接管（未装/禁用 aiti-cmd）→ 回落**原生 PTY 面板**
 *   （lib/terminal-manager + /api/terminal 全套，见 docs/terminal.md：幂等创建/
 *   120s 租约/断点续传/有界回放）。manifest 未决（启动拉取中）期间渲染空壳占位——
 *   声明了接管的扩展物化到位前抢先建原生 PTY 就是双开，声明与否以 manifest 快照
 *   一次定案（useExtSlotSettled）。
 * - sessionStorage 会话记忆语义不变（restored 恢复页签不静默起 shell：原生层 GET
 *   探测、接管层由扩展出「接管到页签」按钮）。
 */
export function TerminalPanelBridge({ tab, active, onClosed, onRestart, onCloseError, onOpenShellTab }: Props) {
  const { t } = useI18n();
  const takeover = useExtSlotItems("terminalDock").find(hasExtRender);
  const settled = useExtSlotSettled("terminalDock");
  // 页签关闭收尾分流：接管态立即本地移除；原生态由 TerminalPanel 的 closing effect
  // 走完整收尾（等创建/在途输入 → DELETE → 回调；失败 onCloseError 留页签可重试）。
  // 必须在 takeover early-return 之前调 hooks（Rules of Hooks）。
  useEffect(() => {
    if (tab.closing && takeover) onClosed();
  }, [tab.closing, takeover, onClosed]);
  if (takeover) {
    return (
      <section
        className="terminal-panel"
        aria-label={t("terminal.title")}
        style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <ExtItemBoundary extId={takeover.extId} slot="terminalDock" itemId={takeover.id}>
          <takeover.render
            currentSession={null}
            cwd={tab.cwd}
            tabId={tab.id}
            active={active}
            restored={Boolean(tab.restored)}
            onClosed={onClosed}
            openShellTab={onOpenShellTab}
          />
        </ExtItemBoundary>
      </section>
    );
  }
  if (!settled) {
    // manifest 未决：既不能渲染接管层也不能预判缺席（防接管迟到双开），先给空壳
    // 占位（manifest 拉取 <1s，正常情况下可见时间可忽略）。
    return <section className="terminal-panel" aria-label={t("terminal.title")} />;
  }
  return (
    <TerminalPanel
      tab={tab}
      active={active}
      onRestart={onRestart ?? (() => {})}
      onClosed={onClosed}
      onCloseError={onCloseError ?? (() => {})}
    />
  );
}
