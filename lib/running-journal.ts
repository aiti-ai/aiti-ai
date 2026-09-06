/**
 * 运行 journal — 「重启前哪些会话正在运行」的唯一落盘（pi-web 重启恢复 P0）。
 *
 * 背景：本地会话是进程内 runtime，running 状态纯内存（/api/agent/running 三路合并），
 * pi-web 重启即丢。queue 已有 sidecar（queue-store.ts）但恢复是惰性+手动的——用户不
 * 打开会话就永远不知道有排队消息残留。本模块补上缺失的一半：把运行集镜像到磁盘，
 * 重启后（bootId 变化）旧 entries 就是「中断集」，配合 restart-recovery.ts 产出恢复清单。
 *
 * 文件：`${dataRoot()}/pi-web-core/running-journal.json`（dev/prod 实例经 webRoot 天然隔离）。
 *
 * 结构：
 *   entries     — 当前 boot 的运行集快照（notifyRunningChange 收口全量重写）
 *   interrupted — 历史 boot 遗留的中断会话（boot 时 entries 迁入；state 控制清单显隐）
 *
 * 写入策略：模块级单写者（globalThis 缓存 + write-through 原子写）；写失败只
 * console.error——journal 缺失/损坏 = 静默降级回「手动打开会话恢复」的现状，绝不影响主链路。
 */
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { dataRoot } from "./ext/data-dir.ts";

export type JournalSessionKind = "local" | "external";

/** 一条「正在运行」的会话快照（由 notifyRunningChange 收口产出）。 */
export interface JournalEntry {
  /** 会话 id（本地 = session uuid；外部 = handle id） */
  id: string;
  /** session 文件绝对路径（本地必有；外部可能为空） */
  sessionFile: string;
  cwd: string;
  kind: JournalSessionKind;
  /** 本条最近一次被确认仍在运行的时间 */
  updatedAt: number;
}

/** 中断集条目 = journal entry + 处置状态。 */
export interface InterruptedEntry extends JournalEntry {
  /** boot 扫描发现的时间 */
  detectedAt: number;
  /** pending = 待用户处理；dismissed = 用户明确忽略（不再提示，可在设置找回） */
  state: "pending" | "dismissed";
}

interface RunningJournalFile {
  version: 1;
  /** 本次 pi-web 进程的启动代际；与文件里旧 bootId 不同 = 上次进程中断遗留 */
  bootId: string;
  bootStartedAt: number;
  /** 写入进程 pid：跨实例互斥用（其他实例 resume 前判活，死进程残留不算「运行中」） */
  pid: number;
  updatedAt: number;
  entries: JournalEntry[];
  interrupted: InterruptedEntry[];
}

const EMPTY: () => RunningJournalFile = () => ({
  version: 1,
  bootId: randomUUID(),
  bootStartedAt: Date.now(),
  pid: process.pid,
  updatedAt: Date.now(),
  entries: [],
  interrupted: [],
});

// globalThis 承载：next dev HMR 换模块实例不丢缓存（同 handle-store 模式）
interface JournalStore {
  file: RunningJournalFile | null;
}
const g = globalThis as { __piRunningJournal?: JournalStore };
const store: JournalStore = (g.__piRunningJournal ??= { file: null });

/**
 * 实例隔离键：journal 是「进程代际」数据，必须按 pi-web 实例隔离。
 * ⚠️ dataRoot 可能被多个实例显式共享（如本机 dev service 与生产同指 ~/.pi/web/data），
 * 若共用同名文件，A 实例 bootRoll 会把 B 实例正在运行的会话误判为中断，甚至双开
 * runtime 写同一 session 文件。同名进程重启端口不变 → 上一代文件可见 ✓；双开同端口
 * 不可能（端口冲突）✓。
 */
function instanceKey(): string {
  return process.env.PI_WEB_INSTANCE || process.env.PORT || "local";
}

/** 本实例隔离键（restart-recovery 跨实例检查跳过自己用）。 */
export function selfInstanceKey(): string {
  return instanceKey();
}

export function runningJournalPath(): string {
  return join(dataRoot(), "pi-web-core", `running-journal-${instanceKey()}.json`);
}

export interface InstanceJournal {
  key: string;
  pid: number;
  entries: JournalEntry[];
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 枚举 data root 下全部实例的 journal（含自己的），供跨实例互斥检查：
 * 「同一 session 文件是否正被另一个活实例运行」。文件名约定 running-journal-<key>.json；
 * 损坏/无法解析的文件跳过（原子写 + 容错，读侧永不抛）。
 */
export function listInstanceJournals(): InstanceJournal[] {
  const dir = join(dataRoot(), "pi-web-core");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^running-journal-.+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: InstanceJournal[] = [];
  for (const name of names) {
    const key = name.slice("running-journal-".length, -".json".length);
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<RunningJournalFile>;
      if (!parsed || !Array.isArray(parsed.entries)) continue;
      out.push({
        key,
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
        entries: parsed.entries.filter((e): e is JournalEntry => Boolean(e && typeof e.sessionFile === "string")),
      });
    } catch { /* 单文件损坏不拖累清单 */ }
  }
  return out;
}

/** 该 session 文件是否正被另一个活实例运行（entries 判活以 pid 为准；死进程残留忽略）。 */
export function findOtherInstanceRunner(sessionFile: string): string | null {
  if (!sessionFile) return null;
  const self = instanceKey();
  for (const j of listInstanceJournals()) {
    if (j.key === self) continue;
    if (!isPidAlive(j.pid)) continue;
    if (j.entries.some((e) => e.sessionFile === sessionFile)) return j.key;
  }
  return null;
}

function readFromDisk(): RunningJournalFile {
  const path = runningJournalPath();
  if (!existsSync(path)) return EMPTY();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunningJournalFile>;
    if (!parsed || !Array.isArray(parsed.entries) || !Array.isArray(parsed.interrupted)) return EMPTY();
    return {
      version: 1,
      bootId: typeof parsed.bootId === "string" ? parsed.bootId : randomUUID(),
      bootStartedAt: typeof parsed.bootStartedAt === "number" ? parsed.bootStartedAt : Date.now(),
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      entries: parsed.entries.filter((e): e is JournalEntry => Boolean(e && typeof e.id === "string")),
      interrupted: parsed.interrupted.filter((e): e is InterruptedEntry =>
        Boolean(e && typeof e.id === "string" && (e.state === "pending" || e.state === "dismissed"))),
    };
  } catch {
    // 损坏 = 视作全新（中断集丢失可接受，绝不阻塞启动）
    return EMPTY();
  }
}

function writeToDisk(): void {
  const file = store.file;
  if (!file) return;
  file.updatedAt = Date.now();
  const path = runningJournalPath();
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(tmp, JSON.stringify(file), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    console.error(
      "[pi-web] running journal write failed (recovery degrades to manual):",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function load(): RunningJournalFile {
  if (!store.file) store.file = readFromDisk();
  return store.file;
}

/**
 * 启动扫描（instrumentation.register 调一次）：旧 boot 的 entries 迁入 interrupted
 * （按 sessionFile 去重合并，保留已有 state），并滚动 bootId 开启新代际。
 * 返回本次迁移产生的中断条数（打日志用）。
 */
export function bootRollRunningJournal(): number {
  const file = load();
  const stale = file.entries;
  if (stale.length > 0) {
    const byFile = new Map(file.interrupted.map((e) => [e.sessionFile, e]));
    for (const e of stale) {
      const existing = byFile.get(e.sessionFile);
      if (existing) {
        // 已有同会话中断记录：刷新时间戳，保留用户此前的 dismiss 决定
        existing.updatedAt = Math.max(existing.updatedAt, e.updatedAt);
        existing.detectedAt = Date.now();
      } else {
        const entry: InterruptedEntry = { ...e, detectedAt: Date.now(), state: "pending" };
        file.interrupted.push(entry);
        byFile.set(e.sessionFile, entry);
      }
    }
  }
  file.entries = [];
  file.bootId = randomUUID();
  file.bootStartedAt = Date.now();
  file.pid = process.pid; // 新代际 = 新进程；旧 pid 残留会让跨实例判活误判
  writeToDisk();
  return stale.length;
}

/**
 * 运行集变化收口（rpc-manager notifyRunningChange 调）：全量重写当前 boot 的
 * entries。调用方保证仅在运行集真正变化时调用（有 snapshot 去重）。
 */
export function recordRunningEntries(entries: JournalEntry[]): void {
  const file = load();
  file.entries = entries;
  writeToDisk();
}

/** 当前中断集（GET 清单用）。 */
export function listInterrupted(): InterruptedEntry[] {
  return load().interrupted;
}

/** 更新一条中断记录的处置状态（resolve API 用）。 */
export function setInterruptedState(sessionFile: string, state: InterruptedEntry["state"]): boolean {
  const file = load();
  const entry = file.interrupted.find((e) => e.sessionFile === sessionFile);
  if (!entry) return false;
  entry.state = state;
  writeToDisk();
  return true;
}

/** 中断记录已处理完（恢复成功或文件已消失），从清单移除。 */
export function removeInterrupted(sessionFile: string): void {
  const file = load();
  const next = file.interrupted.filter((e) => e.sessionFile !== sessionFile);
  if (next.length === file.interrupted.length) return;
  file.interrupted = next;
  writeToDisk();
}
