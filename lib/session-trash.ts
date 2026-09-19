/**
 * Deleted session files go to the desktop trash (XDG Trash) instead of a direct unlink.
 *
 * "Permanently delete" is the shared landing point of pi-web's built-in
 * DELETE /api/sessions/<id> and the session-manager panel's delete; one stray unlink and
 * the file is gone forever. Instead, files are moved to the standard trash:
 * $XDG_DATA_HOME/Trash (default ~/.local/share/Trash) plus a .trashinfo record --
 * visible, restorable, and emptyable from the file manager, consistent with other
 * desktop apps.
 *
 * Overrides:
 *   - PI_WEB_TRASH_DIR: explicit Trash root (tests / special deployments; built-in files/ + info/)
 *   - XDG_DATA_HOME: standard XDG layout, Trash at $XDG_DATA_HOME/Trash
 *
 * Cross-filesystem moves (EXDEV) degrade to copy + delete of the source (allowed by the
 * FreeDesktop spec).
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Trash root resolution: PI_WEB_TRASH_DIR -> $XDG_DATA_HOME/Trash -> ~/.local/share/Trash. */
export function trashRootDir(): string {
  const override = process.env.PI_WEB_TRASH_DIR;
  if (override) return resolve(override);
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "Trash");
}

/** FreeDesktop .trashinfo contents: original path (percent-encoded) + deletion time (local timezone). */
function trashInfoContents(originalPath: string, deletedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${deletedAt.getFullYear()}-${pad(deletedAt.getMonth() + 1)}-${pad(deletedAt.getDate())}`
    + `T${pad(deletedAt.getHours())}:${pad(deletedAt.getMinutes())}:${pad(deletedAt.getSeconds())}`;
  return `[Trash Info]\nPath=${encodeURI(originalPath)}\nDeletionDate=${stamp}\n`;
}

/** On name conflicts append .1/.2/... per FreeDesktop convention until neither files/ nor info/ is occupied. */
function uniqueTrashName(filesDir: string, infoDir: string, name: string): string {
  let candidate = name;
  for (let n = 1; existsSync(join(filesDir, candidate)) || existsSync(join(infoDir, `${candidate}.trashinfo`)); n += 1) {
    candidate = `${name}.${n}`;
  }
  return candidate;
}

/**
 * Moves sourcePath into the trash. Returns the destination path inside the trash;
 * returns null (no throw) when the source file does not exist, including the race where
 * it is deleted concurrently after the existence check.
 */
export function trashFileSync(sourcePath: string): string | null {
  const source = resolve(sourcePath);
  if (!existsSync(source)) return null;

  const root = trashRootDir();
  const filesDir = join(root, "files");
  const infoDir = join(root, "info");
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(infoDir, { recursive: true });

  const name = uniqueTrashName(filesDir, infoDir, basename(source));
  const destination = join(filesDir, name);
  try {
    renameSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code !== "EXDEV") throw error;
    copyFileSync(source, destination);
    try {
      unlinkSync(source);
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code !== "ENOENT") throw copyError;
    }
  }
  writeFileSync(join(infoDir, `${name}.trashinfo`), trashInfoContents(source, new Date()), "utf8");
  return destination;
}
