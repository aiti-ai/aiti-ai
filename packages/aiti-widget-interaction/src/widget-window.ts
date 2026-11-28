import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WidgetWindowOptions {
  bin?: string
  width?: number;
  height?: number;
  title?: string
  /** Absolute screen X (use `placeOutside`/`placeOnMonitor` to compute it). */
  x?: number;
  /** Absolute screen Y. */
  y?: number;
  /** Monitor index, name or "primary"; x/y become monitor-local offsets. */
  display?: string | number;
  /** Center on the selected monitor, overriding x/y. */
  center?: boolean;
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
/**
 * Append the broker coordinates to a host-provided custom page.
 *
 * A custom page is served from its own loopback origin, so it needs to know where the
 * interaction broker lives (`base`, used for `/interaction-client.js` and the API) and
 * which token to send. The built-in page does not need this (it is served by the broker).
 */
export function withInteractionParams(pageUrl: string, baseUrl: string, token = ""): string {
  const url = new URL(pageUrl);
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  url.searchParams.set("base", base);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export class InteractionWidgetWindow {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly options: Required<Pick<WidgetWindowOptions, "width" | "height" | "title">> & WidgetWindowOptions;
  private lastUrl = "";
  private diagnostics = "";

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

  /**
   * Last stderr lines from the shell (up to 4 kB). The window can look alive while the
   * page failed to load, so hosts should surface this when an interaction times out.
   * Set `AITI_WIDGET_DEBUG=1` to also stream the shell's stderr to the parent process.
   */
  get stderr(): string {
    return this.diagnostics;
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
      ...(this.options.x !== undefined ? ["--x", String(Math.round(this.options.x))] : []),
      ...(this.options.y !== undefined ? ["--y", String(Math.round(this.options.y))] : []),
      ...(this.options.display !== undefined ? ["--display", String(this.options.display)] : []),
      ...(this.options.center ? ["--center", "true"] : []),
      "--always-on-top", "true",
      "--focusable", "true",
      "--click-through", "false",
      "--skip-taskbar", "true",
      "--all-workspaces", "true",
      "--resizable", "true",
      ...(this.options.args || []),
    ];
    try {
      const debug = !!process.env.AITI_WIDGET_DEBUG;
      const child = spawn(bin, args, { stdio: ["pipe", "ignore", debug ? "inherit" : "pipe"], windowsHide: true });
      this.child = child;
      this.diagnostics = "";
      child.stderr?.on("data", (data) => {
        this.diagnostics = (this.diagnostics + data.toString()).slice(-4096);
      });
      child.once("exit", (code) => {
        if (this.child === child) this.child = null;
        if (code) this.diagnostics = `${this.diagnostics}\n[widget exited with code ${code}]`.slice(-4096);
      });
      child.once("error", (error) => {
        if (this.child === child) this.child = null;
        this.diagnostics = `${this.diagnostics}\n[widget spawn error: ${error.message}]`.slice(-4096);
      });
      // Do not wait for `ready`: the shell emits it on stdout, which this adapter
      // intentionally ignores; the page can connect while it is still mounting.
      return true;
    } catch {
      this.child = null;
      return false;
    }
  }

  /** Move the running window (absolute screen coordinates). */
  move(x: number, y: number): boolean {
    if (!this.running) return false;
    try {
      this.child!.stdin.write(`${JSON.stringify({ cmd: "move", x: Math.round(x), y: Math.round(y) })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Resize the running window; the shell re-locks min=max when not user-resizable. */
  resize(width: number, height: number): boolean {
    if (!this.running) return false;
    try {
      this.child!.stdin.write(`${JSON.stringify({ cmd: "resize", width: Math.round(width), height: Math.round(height) })}\n`);
      return true;
    } catch {
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
