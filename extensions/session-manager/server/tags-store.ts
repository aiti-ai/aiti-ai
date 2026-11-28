/**
 * session-manager — session-tags.json storage (atomic writes).
 * Data dir: ~/.pi/web/data/session-manager/config/ (framework convention).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyTagData, validateTagData, type TagData } from "../lib/session-tags.ts";

const FILE_NAME = "session-tags.json";

// mtime 缓存：session-tags.json 只有 4.6KB，同步读+parse <1ms；但高负载/编译风暴时
// 事件循环争用会让每次 GET 都卡 0.3-0.4s（实测）。文件 mtime 未变则直接返回缓存，
// 减少高频轮询（TopbarTags 每 5s）对事件循环的占用。写路径（writeTagData）主动失效。
const tagCache = new Map<string, { mtimeMs: number; data: TagData }>();

export function invalidateTagCache(configDir: string): void {
  tagCache.delete(configDir);
}

export function tagsFilePath(configDir: string): string {
  return path.join(configDir, FILE_NAME);
}

export function readTagData(configDir: string): TagData {
  try {
    const p = tagsFilePath(configDir);
    const st = fs.statSync(p);
    const cached = tagCache.get(configDir);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    const data = validateTagData(raw) ?? emptyTagData();
    tagCache.set(configDir, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch {
    return emptyTagData();
  }
}

export function writeTagData(configDir: string, data: TagData): void {
  const p = tagsFilePath(configDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
  invalidateTagCache(configDir);
}
