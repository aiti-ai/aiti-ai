import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WidgetWindowOptions {
  bin?: string
  width?: number;
  height?: number;
  title?: string
  /** Extra CLI args appended after the defaults. */
  args?: string[];
}

/** Resolve the shell binary without assuming a package-manager layout. */
export function resolveWidgetBinary(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.AITI_DESKTOP_WIDGET_BIN,
    join(homedir(), ".pi", "bin", process.platform === "win32" ? "aiti-desktop-widget.exe" : "aiti-desktop-widget"),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try { if (candidate && existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  // Let the OS resolve PATH for callers that install a shim elsewhere.
  return candidates.length ? candidates[0] : null;
}

/**
 * Keeps one aiti-desktop-widget window alive for interaction pages.
 *
 * The shell owns the window; the broker owns pending state. `open()` navigates an
 * existing window or spawns a new one. A closed window is recreated on the next call.
 */
export class InteractionWidgetWindow {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly options: Required<Pick<WidgetWindowOptions, "width" | "height" | "title">> & WidgetWindowOptions;
  private lastUrl = "";

  constructor(options: WidgetWindowOptions = {}) {
    this.options = {
      ...options,
      width: Math.max(240, Math.round(Number(options.width) || 560)),
      height: Math.max(120, Math.round(Number(options.height) || 260)),
      title: String(options.title || "aiti interaction"),
    };
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  async open(url: string): Promise<boolean> {
    this.lastUrl = url;
    if (this.running) {
      // The shell accepts JSONL on stdin; navigate keeps the same process/window.
      try {
        this.child!.stdin.write(`${JSON.stringify({ cmd: "navigate", url })}\n`);
        return true;
      } catch {
        this.child = null;
      }
    }
    const bin = resolveWidgetBinary(this.options.bin);
    if (!bin) return false;
    const args = [
      "--url", url,
      "--width", String(this.options.width),
      "--height", String(this.options.height),
      "--title", this.options.title,
      "--always-on-top", "true",
      "--focusable", "true",
      "--click-through", "false",
      "--skip-taskbar", "true",
      "--all-workspaces", "true",
      "--resizable", "true",
      ...(this.options.args || []),
    ];
    try {
      const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      this.child = child;
      child.once("exit", () => { if (this.child === child) this.child = null; });
      child.once("error", () => { if (this.child === child) this.child = null; });
      // Do not wait for `ready`: the shell emits it on stdout, which this adapter
      // intentionally ignores; the page can connect while it is still mounting.
      return true;
    } catch {
      this.child = null;
      return false;
    }
  }

  /** Re-open the most recent URL (used after the user closed the window). */
  async reopen(): Promise<boolean> {
    return this.lastUrl ? this.open(this.lastUrl) : false;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.write(`${JSON.stringify({ cmd: "close" })}\n`); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve();
      }, 800);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
