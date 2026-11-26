/**
 * open-in-file-manager.ts — raise the OS file manager on a directory (self-contained, testable).
 *
 * Only the machine running pi-web can open that window: the browser has no API for it, and the
 * host's own /api/open-in-explorer answers 403 "remote" for every request whose Host is not
 * loopback — which covers every request arriving through the reverse proxy, i.e. the usual way
 * this UI is reached. So the extension raises the window itself, with the same detached recipe
 * as /open-terminal (stdio ignore + unref: the window outlives the request and the server).
 *
 * Windows selects the entry (/select,), macOS reveals it (-R); Linux has no select verb, so an
 * entry reveals its containing folder. Inside WSL the Windows Explorer answers through interop,
 * which means the distro path has to be spelled the Windows way first.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

export interface FileManagerCommand {
  command: string;
  args: string[];
}

/** The distro name WSL puts in the environment of every process it starts; "" off WSL. */
export function wslDistroName(env: NodeJS.ProcessEnv = process.env): string {
  return env.WSL_DISTRO_NAME?.trim() ?? "";
}

/** The Windows spelling of a WSL path: /mnt/c/dev → C:\dev, the rest via \\wsl$\<distro>. */
export function windowsPathForWsl(posixPath: string, distro: string): string {
  const trimmed = posixPath.replace(/\/+$/, "") || "/";
  const mount = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(trimmed);
  if (mount) return `${mount[1].toUpperCase()}:\\${(mount[2] ?? "").replaceAll("/", "\\")}`;
  return `\\\\wsl$\\${distro}${trimmed === "/" ? "\\" : trimmed.replaceAll("/", "\\")}`;
}

/**
 * The command that opens `target` in the OS file manager.
 * @param platform A Node `process.platform` value
 * @param target The absolute path to reveal
 * @param isDir Whether `target` is a directory (open it) or an entry (reveal it in its folder)
 * @returns The command and its arguments, or null on a platform without a file manager
 */
export function fileManagerCommand(
  platform: NodeJS.Platform,
  target: string,
  isDir: boolean,
): FileManagerCommand | null {
  if (platform === "win32") {
    return { command: "explorer.exe", args: isDir ? [target] : ["/select," + target] };
  }
  if (platform === "darwin") {
    return { command: "open", args: isDir ? [target] : ["-R", target] };
  }
  if (platform === "linux") {
    return { command: "xdg-open", args: [isDir ? target : dirname(target)] };
  }
  return null;
}

/**
 * The session variables a systemd-started server lacks and `xdg-open` needs: without DISPLAY /
 * WAYLAND_DISPLAY / XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS it cannot reach the compositor and
 * fails silently. The running session is probed instead (/tmp/.X11-unix, /run/user/<uid>), so a
 * service-started pi-web can still raise windows; the map stays empty on a headless box.
 */
export function desktopEnv(platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== "linux") return {};
  const out: Record<string, string> = {};
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    try {
      const sockets = readdirSync("/tmp/.X11-unix")
        .filter((f) => /^X\d+$/.test(f))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      if (sockets.length) out.DISPLAY = ":" + sockets[0].slice(1);
    } catch { /* no X socket — no X session */ }
  }
  if (uid == null) return out;
  if (!process.env.XAUTHORITY) {
    for (const candidate of [`/run/user/${uid}/gdm/Xauthority`, `${process.env.HOME || ""}/.Xauthority`]) {
      if (candidate && existsSync(candidate)) {
        out.XAUTHORITY = candidate;
        break;
      }
    }
  }
  if (!process.env.XDG_RUNTIME_DIR && existsSync(`/run/user/${uid}/bus`)) {
    out.XDG_RUNTIME_DIR = `/run/user/${uid}`;
    out.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
  }
  if (!process.env.WAYLAND_DISPLAY) {
    try {
      const runtimeDir = out.XDG_RUNTIME_DIR || process.env.XDG_RUNTIME_DIR || "";
      const sockets = runtimeDir
        ? readdirSync(runtimeDir).filter((f) => /^wayland-\d+$/.test(f)).sort()
        : [];
      if (sockets.length) out.WAYLAND_DISPLAY = sockets[0];
    } catch { /* no wayland socket */ }
  }
  return out;
}

/**
 * Raises the file manager for `target` and resolves once it has started.
 * @param target The absolute path to reveal
 * @param isDir Whether `target` is a directory (open it) or an entry (reveal it in its folder)
 * @param opts Platform and environment overrides (tests)
 */
export function launchFileManager(
  target: string,
  isDir: boolean,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const distro = platform === "linux" ? wslDistroName(env) : "";
  const spec = distro
    ? fileManagerCommand("win32", windowsPathForWsl(target, distro), isDir)
    : fileManagerCommand(platform, target, isDir);
  if (!spec) return Promise.reject(new Error(`no file manager on platform ${platform}`));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env, ...desktopEnv(platform) },
    });
    child.once("error", reject);
    // explorer.exe exits with code 1 even when it succeeded, so only a failed spawn counts.
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
