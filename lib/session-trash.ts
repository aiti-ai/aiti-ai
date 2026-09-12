/**
 * 删除会话文件走桌面回收站（XDG Trash），不再直接 unlink。
 *
 * 「彻底删除」是 pi-web（内置 DELETE /api/sessions/<id>）与 session-manager
 * 面板删除共用的落点；直接 unlink 手滑即永久丢失。改为移动到标准回收站：
 * $XDG_DATA_HOME/Trash（默认 ~/.local/share/Trash）+ .trashinfo 记录——
 * 文件管理器里可见、可还原、可清空，与其他桌面应用语义一致。
 *
 * 覆盖项：
 *   - PI_WEB_TRASH_DIR：显式指定 Trash 根（测试/特殊部署；内建 files/ + info/）
 *   - XDG_DATA_HOME：标准 XDG 布局，Trash 位于 $XDG_DATA_HOME/Trash
 *
 * 跨文件系统（EXDEV）退化为复制 + 删除源文件（FreeDesktop 规范允许）。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Trash 根目录解析：PI_WEB_TRASH_DIR → $XDG_DATA_HOME/Trash → ~/.local/share/Trash。 */
export function trashRootDir(): string {
  const override = process.env.PI_WEB_TRASH_DIR;
  if (override) return resolve(override);
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "Trash");
}

/** FreeDesktop .trashinfo 内容：原始路径（百分号编码）+ 删除时间（本地时区）。 */
function trashInfoContents(originalPath: string, deletedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${deletedAt.getFullYear()}-${pad(deletedAt.getMonth() + 1)}-${pad(deletedAt.getDate())}`
    + `T${pad(deletedAt.getHours())}:${pad(deletedAt.getMinutes())}:${pad(deletedAt.getSeconds())}`;
  return `[Trash Info]\nPath=${encodeURI(originalPath)}\nDeletionDate=${stamp}\n`;
}

/** 名称冲突时按 FreeDesktop 习惯追加 .1/.2/… 直到 files/ 与 info/ 均无占用。 */
function uniqueTrashName(filesDir: string, infoDir: string, name: string): string {
  let candidate = name;
  for (let n = 1; existsSync(join(filesDir, candidate)) || existsSync(join(infoDir, `${candidate}.trashinfo`)); n += 1) {
    candidate = `${name}.${n}`;
  }
  return candidate;
}

/**
 * 把 sourcePath 移入回收站。返回回收站内的目标路径；
 * 源文件不存在（含检查后被并发删除的竞态）返回 null，不抛错。
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
