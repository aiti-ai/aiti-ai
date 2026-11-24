"use client";

import { Component, type ReactNode } from "react";

/**
 * Error boundary for the lazy debug panel.
 *
 * Lives apart from DebugPanel.tsx so AppShell can wrap the lazy panel without
 * pulling the panel's module family (debug state, SessionTree, MCP config
 * helpers…) into the first-load bundle — the boundary must be on screen the
 * moment the user opens the debug panel, even while the panel chunk is still
 * loading.
 */
export class DebugPanelBoundary extends Component<{ fallback: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Debug panel failed:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="status"
        style={{ padding: "10px 16px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12 }}
      >
        {this.props.fallback}
      </div>
    );
  }
}
