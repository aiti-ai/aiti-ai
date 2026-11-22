import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Rect, clampRect } from "./placement.ts";
import { resolveWidgetBinary } from "./widget-window.ts";

export type CoverPattern = "solid" | "grid" | "stripes";

export interface CoverOptions {
  /** Screen-space (absolute) rectangle to cover. Use `monitorRect` for monitor-local areas. */
  rect: Rect;
  /** CSS color, e.g. `#101216` or `rgba(8,10,14,.9)`. */
  color?: string;
  /** 0..1, applied as CSS opacity on top of `color`. */
  opacity?: number;
  pattern?: CoverPattern;
  /** Optional monitor bounds; the rect is clamped into them. */
  monitor?: Rect;
  title?: string;
  bin?: string;
  /** Path to the cover page; defaults to the packaged `page/cover.html`. */
  pageFile?: string;
  /** Extra widget CLI args appended after the defaults. */
  args?: string[];
}

const DEFAULT_PAGE = fileURLToPath(new URL("../page/cover.html", import.meta.url));
const DEFAULT_TITLE = "aiti cover";

/** Build the widget URL for a cover page (query carries the visual style). */
export function coverPageUrl(options: CoverOptions): string {
  const pageFile = options.pageFile || DEFAULT_PAGE;
  const params = new URLSearchParams();
  if (options.color) params.set("color", options.color);
  if (options.opacity !== undefined && Number.isFinite(Number(options.opacity))) params.set("opacity", String(options.opacity));
  params.set("pattern", options.pattern || "solid");
  return `${pageFile}?${params.toString()}`;
}

function coverRect(options: CoverOptions): Rect {
  return options.monitor ? clampRect(options.rect, options.monitor) : options.rect;
}

/** CLI args for a cover window. Exported for tests; `DesktopCover` uses it directly. */
export function coverArgs(options: CoverOptions): string[] {
  const rect = coverRect(options);
  return [
    "--html", coverPageUrl(options),
    "--width", String(Math.max(1, Math.round(rect.width))),
    "--height", String(Math.max(1, Math.round(rect.height))),
    "--x", String(Math.round(rect.x)),
    "--y", String(Math.round(rect.y)),
    "--title", options.title || DEFAULT_TITLE,
    "--decorations", "false",
    "--transparent", "true",
    "--always-on-top", "true",
    "--skip-taskbar", "true",
    "--focusable", "false",
    "--click-through", "true",
    "--resizable", "false",
    "--all-workspaces", "true",
    ...(options.args || []),
  ];
}

/**
 * A click-through always-on-top cover window.
 *
 * v1 of the "desktop redact" feature: it hides whatever is behind it from a recording
 * (the window is part of the captured pixels). Real-time mosaic needs screen capture and
 * is out of scope; use this when pixels must not be shown at all.
 *
 *   const cover = new DesktopCover({ rect: { x: 100, y: 80, width: 800, height: 600 } });
 *   await cover.open();                       // spawns the widget
 *   await cover.update({ color: "#000", opacity: 0.7 });
 *   cover.move({ x: 320, y: 200 });           // follow the target window
 *   await cover.close();
 */
export class DesktopCover {
  private child: ChildProcessWithoutNullStreams | null = null;
  private options: CoverOptions;

  constructor(options: CoverOptions) {
    this.options = { ...options };
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** Spawn the cover window. Returns false when the widget binary cannot be found. */
  async open(): Promise<boolean> {
    if (this.running) return true;
    const bin = resolveWidgetBinary(this.options.bin);
    if (!bin) return false;
    try {
      const child = spawn(bin, coverArgs(this.options), { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      this.child = child;
      child.once("exit", () => {
        if (this.child === child) this.child = null;
      });
      child.once("error", () => {
        if (this.child === child) this.child = null;
      });
      return true;
    } catch {
      this.child = null;
      return false;
    }
  }

  /** Update the covered rectangle and/or the visual style. */
  async update(patch: Partial<Omit<CoverOptions, "bin" | "args" | "monitor">> & { monitor?: Rect }): Promise<boolean> {
    this.options = { ...this.options, ...patch };
    if (!this.running) return false;
    const rect = coverRect(this.options);
    try {
      // Style lives in the page URL; geometry uses the stdin control channel.
      this.child!.stdin.write(`${JSON.stringify({ cmd: "navigate", url: coverPageUrl(this.options) })}\n`);
      this.child!.stdin.write(`${JSON.stringify({ cmd: "resize", width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) })}\n`);
      this.child!.stdin.write(`${JSON.stringify({ cmd: "move", x: Math.round(rect.x), y: Math.round(rect.y) })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Move the cover without touching the style (cheap follow for scroll/drag). */
  move(position: Partial<Rect>): boolean {
    if (!this.running) return false;
    const rect = { ...this.options.rect, ...position };
    this.options = { ...this.options, rect };
    const clamped = coverRect(this.options);
    try {
      this.child!.stdin.write(`${JSON.stringify({ cmd: "move", x: Math.round(clamped.x), y: Math.round(clamped.y) })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ cmd: "close" })}\n`);
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 800);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
