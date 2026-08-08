/**
 * Extension directory conventions.
 *
 * Code:  ~/.pi/web/extensions/<id>/   (PI_WEB_EXTENSIONS_DIR overrides)
 * Data:  ~/.pi/web/data/<id>/         (PI_WEB_DATA_DIR overrides)
 *
 * Code/data separation keeps updates from clobbering runtime state.
 */
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export function extensionsRoot(): string {
  return process.env.PI_WEB_EXTENSIONS_DIR || join(homedir(), ".pi", "web", "extensions");
}

export function dataRoot(): string {
  return process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web", "data");
}

/** Resolve (and create) the data directory for one extension. */
export function extensionDataDir(id: string): string {
  const dir = join(dataRoot(), id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
