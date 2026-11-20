/**
 * Path crumbs — split an absolute path into clickable segments (Windows Explorer style).
 *
 * Pure, platform-agnostic: the path string decides the platform (POSIX `/a/b`, Windows
 * drive `C:\a\b`, UNC `\\server\share\a`), never the caller's OS — the picker shows paths
 * produced by the server, which may run on another platform.
 *
 * Consumers: extensions/_shared/path-breadcrumb.tsx (directory pickers that want a
 * breadcrumb bar with an in-place edit mode).
 */

export interface PathCrumb {
  /** Text shown on the segment (a single folder name, the drive, the UNC root or "/"). */
  label: string;
  /** Full path up to and including this segment (what clicking it navigates to). */
  path: string;
}

export interface PathSplit {
  /** Separator the path itself uses, for rendering between segments. */
  sep: string;
  /** Root segment ("/" on POSIX, "C:" on Windows, "\\\\server\\share" on UNC); null for a relative path. */
  root: PathCrumb | null;
  /** Segments below the root, in path order. */
  segments: PathCrumb[];
}

const DRIVE_RE = /^[a-zA-Z]:/;

function isWindowsPath(value: string): boolean {
  if (value.startsWith("\\\\")) return true; // UNC
  if (DRIVE_RE.test(value)) return true; // C:\…, C:/…, bare C:
  // A backslash-only path that does not look like POSIX.
  return !value.startsWith("/") && value.includes("\\") && !value.includes("/");
}

function splitPosix(value: string): PathSplit {
  const absolute = value.startsWith("/");
  const parts = value.split("/").filter(Boolean);
  let acc = "";
  const segments: PathCrumb[] = [];
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : absolute ? `/${part}` : part;
    segments.push({ label: part, path: acc });
  }
  // The root is a segment of its own only for absolute paths (and never duplicated by
  // an empty first part: filter(Boolean) above already dropped it).
  return { sep: "/", root: absolute ? { label: "/", path: "/" } : null, segments };
}

function splitWindows(value: string): PathSplit {
  // Keep the UNC prefix intact: collapsing separators first would turn \\server into \server.
  const unc = value.startsWith("\\\\");
  const normalized = unc
    ? "\\\\" + value.slice(2).replace(/[\\/]+/g, "\\")
    : value.replace(/[\\/]+/g, "\\");
  let root: PathCrumb | null = null;
  let acc = "";
  let rest = normalized;
  if (unc) {
    // UNC: \\server\share is the root ("This PC" > server > share collapses to one crumb).
    const parts = normalized.slice(2).split("\\").filter(Boolean);
    const server = parts.shift() ?? "";
    const share = parts.shift() ?? "";
    const rootPath = share ? `\\\\${server}\\${share}` : server ? `\\\\${server}` : "\\\\";
    root = { label: rootPath, path: rootPath };
    acc = rootPath;
    rest = parts.length > 0 ? "\\" + parts.join("\\") : "";
  } else {
    const drive = DRIVE_RE.exec(normalized)?.[0] ?? null;
    if (drive) {
      const rootPath = `${drive}\\`;
      root = { label: drive, path: rootPath };
      acc = drive;
      rest = normalized.slice(drive.length);
    }
  }
  const parts = rest.split("\\").filter(Boolean);
  const segments: PathCrumb[] = [];
  for (const part of parts) {
    acc = acc ? `${acc}\\${part}` : part;
    segments.push({ label: part, path: acc });
  }
  return { sep: "\\", root, segments };
}

/** Split a path into breadcrumb segments (root + folder segments). */
export function splitPathSegments(input: string): PathSplit {
  const value = typeof input === "string" ? input : "";
  if (!value) return { sep: "/", root: null, segments: [] };
  return isWindowsPath(value) ? splitWindows(value) : splitPosix(value);
}

/** The parent folder the "up" button navigates to (null at a filesystem root). */
export function parentOfPath(input: string): string | null {
  const value = typeof input === "string" ? input : "";
  if (!value) return null;
  const { sep, root, segments } = splitPathSegments(value);
  if (segments.length === 0) return null;
  if (segments.length === 1) return root ? root.path : null;
  return segments[segments.length - 2].path;
}
