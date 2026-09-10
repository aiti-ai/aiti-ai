// 文件 watch 注册表（页面事件唯一 SSE 收敛的服务端半边）。
//
// 与 aiti-editor 的 ed-watch 同构范式，标准化进 core 供 FileViewer 等宿主组件
// 走总线（editor 的实现保留——两套 id 空间互不相干；后续可合并）：
//   客户端 POST /api/files/ticket { path, type: "watch", wantWatch: true }
//     → 票据响应内联带 watchId，服务端即刻启动 fs.watch（300ms 防抖）
//   变化经 publishPageEvent("file-watch", { id, evt: "change"|"gone", size, mtimeMs })
//   客户端订阅总线 type "file-watch" 按 id 过滤（N 个文件 0 条专用连接）
//   POST /api/files/watch-stop { watchId } / 30min 无事件自动停（防泄漏）
// 总线白名单过滤在 SSE 转发层：无人订阅 "file-watch" 时帧不出连接，发布零开销。
import { watch, type FSWatcher } from "fs";
import { statSync } from "fs";
import { basename, dirname } from "path";
import { publishPageEventToBus } from "./agent-page-events";

interface WatchRecord {
  target: string;
  watcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setInterval> | null;
  lastFire: number;
}

const IDLE_STOP_MS = 30 * 60_000;
const IDLE_SCAN_MS = 60_000;
const DEBOUNCE_MS = 300;

const watches = new Map<string, WatchRecord>();

function publishFileWatch(id: string, data: Record<string, unknown>): void {
  publishPageEventToBus("file-watch", { id, ...data });
}

/** 票据签发后调用：目标路径注册 watch（幂等，同 watchId 重复调用无副作用） */
export function startFileWatch(id: string, target: string): void {
  if (watches.has(id)) return;
  const rec: WatchRecord = { target, watcher: null, debounceTimer: null, idleTimer: null, lastFire: Date.now() };
  const fire = () => {
    if (rec.debounceTimer) return;
    rec.debounceTimer = setTimeout(() => { // 300ms 防抖：流式写入连发事件合并
      rec.debounceTimer = null;
      rec.lastFire = Date.now();
      try {
        const s = statSync(target);
        publishFileWatch(id, { evt: "change", size: s.size, mtimeMs: Math.floor(s.mtimeMs) });
      } catch {
        publishFileWatch(id, { evt: "gone" });
      }
    }, DEBOUNCE_MS);
  };
  try {
    rec.watcher = watch(target, fire);
  } catch {
    try {
      rec.watcher = watch(dirname(target), (_e, name) => {
        if (!name || String(name) === basename(target)) fire();
      });
    } catch {
      return; // 无法监听：客户端保持静态视图（连接帧也不发——订阅方以无 change 处理）
    }
  }
  // 30min 无事件自动停（防客户端遗忘 stop 造成泄漏）；重开由客户端带 wantWatch 的票据签发驱动
  rec.idleTimer = setInterval(() => {
    if (Date.now() - rec.lastFire > IDLE_STOP_MS) stopFileWatch(id);
  }, IDLE_SCAN_MS);
  rec.idleTimer.unref?.();
  watches.set(id, rec);
}

export function stopFileWatch(id: string): void {
  const rec = watches.get(id);
  if (!rec) return;
  watches.delete(id);
  try { rec.watcher?.close(); } catch { /* noop */ }
  if (rec.debounceTimer) clearTimeout(rec.debounceTimer);
  if (rec.idleTimer) clearInterval(rec.idleTimer);
}
