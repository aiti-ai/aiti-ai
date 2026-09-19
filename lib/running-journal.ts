/**
 * Running journal — the single on-disk record of "which sessions were running before the restart"
 * (app restart-recovery P0).
 *
 * Background: local sessions are in-process runtimes; the running state is purely in memory
 * (three-way merge at /api/agent/running) and lost whenever the app restarts. The queue already
 * has a sidecar (queue-store.ts) but its recovery is lazy+manual — leftover queued messages stay
 * invisible until the user happens to open the session. This module supplies the missing half:
 * mirror the running set to disk; after a restart (bootId changed) the old entries become the
 * "interrupted set", which restart-recovery.ts turns into a recovery list.
 *
 * File: `${dataRoot()}/pi-web-core/running-journal.json` (dev/prod instances are naturally
 * isolated via webRoot).
 *
 * Structure:
 *   entries     — running-set snapshot of the current boot (rewritten in full via notifyRunningChange)
 *   interrupted — interrupted sessions left over from historical boots (migrated from entries at
 *                 boot; state controls list visibility)
 *
 * Write strategy: a single module-level writer (globalThis cache + write-through atomic writes);
 * write failures only console.error — a missing/corrupt journal = silent degradation back to the
 * status quo of "open the session manually to recover"; never blocks the main path.
 */
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { dataRoot } from "./ext/data-dir.ts";

export type JournalSessionKind = "local" | "external";

/** Snapshot of one "running" session (produced via the notifyRunningChange funnel). */
export interface JournalEntry {
  /** Session id (local = session uuid; external = handle id) */
  id: string;
  /** Absolute path of the session file (always present for local; may be empty for external) */
  sessionFile: string;
  cwd: string;
  kind: JournalSessionKind;
  /** Last time this entry was confirmed still running */
  updatedAt: number;
}

/** Interrupted-set entry = journal entry + disposition state. */
export interface InterruptedEntry extends JournalEntry {
  /** When the boot scan detected it */
  detectedAt: number;
  /** pending = awaiting user action; dismissed = explicitly ignored by the user (no longer surfaced, recoverable in settings) */
  state: "pending" | "dismissed";
}

interface RunningJournalFile {
  version: 1;
  /** Boot generation of the current process; differing from the old bootId in the file = leftover from an interrupted previous process */
  bootId: string;
  bootStartedAt: number;
  /** pid of the writing process: used for cross-instance mutual exclusion (other instances liveness-check before resume; leftovers from dead processes do not count as "running") */
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

// Held on globalThis: next dev HMR module swaps keep the cache/pending timer (same pattern as handle-store)
interface JournalStore {
  file: RunningJournalFile | null;
  /** Pending delayed write of the empty set (shutdown evidence window, see recordRunningEntries) */
  pendingEmpty: ReturnType<typeof setTimeout> | null;
}
const g = globalThis as { __piRunningJournal?: JournalStore };
const store: JournalStore = (g.__piRunningJournal ??= { file: null, pendingEmpty: null });

/**
 * Instance isolation key: the journal is per-process-generation data and must be isolated per
 * app instance.
 * ⚠️ dataRoot may be explicitly shared by multiple instances (e.g. the local dev service and prod
 * both pointing at ~/.pi/web/data); with a shared file, instance A's bootRoll would misjudge
 * instance B's running sessions as interrupted, or even double-open runtimes writing the same
 * session file. A same-named process keeps its port across restarts → the previous generation's
 * file is visible ✓; double-opening the same port is impossible (port conflict) ✓.
 */
function instanceKey(): string {
  return process.env.PI_WEB_INSTANCE || process.env.PORT || "local";
}

/** This instance's isolation key (used by restart-recovery to skip itself during cross-instance checks). */
export function selfInstanceKey(): string {
  return instanceKey();
}

export function runningJournalPath(): string {
  return join(dataRoot(), "pi-web-core", "cache", `running-journal-${instanceKey()}.json`);
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
 * Enumerate the journals of all instances under the data root (including our own) for
 * cross-instance mutual-exclusion checks: "is the same session file currently being run by
 * another live instance". File naming convention: running-journal-<key>.json; corrupt/unparseable
 * files are skipped (atomic writes + fault tolerance; the read side never throws).
 */
export function listInstanceJournals(): InstanceJournal[] {
  const dir = join(dataRoot(), "pi-web-core", "cache");
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
    } catch { /* a single corrupt file must not break the listing */ }
  }
  return out;
}

/** Whether this session file is currently being run by another live instance (liveness judged by pid; leftovers from dead processes ignored). */
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
    // corrupt = treat as fresh (losing the interrupted set is acceptable; never block startup)
    return EMPTY();
  }
}

function writeToDisk(): void {
  const file = store.file;
  if (!file) return;
  file.updatedAt = Date.now();
  // Always overwrite pid with the current process: field-upgrade compatibility (older cached objects may lack the field) + defensive correction
  file.pid = process.pid;
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
 * Boot scan (called once from instrumentation.register): migrate the old boot's entries into
 * interrupted (dedupe/merge by sessionFile, keep existing state) and roll bootId to start a new
 * generation. Returns the number of interrupted entries produced by this migration (for logging).
 */
export function bootRollRunningJournal(): number {
  const file = load();
  const stale = file.entries;
  if (stale.length > 0) {
    const byFile = new Map(file.interrupted.map((e) => [e.sessionFile, e]));
    for (const e of stale) {
      const existing = byFile.get(e.sessionFile);
      if (existing) {
        // Existing interrupted record for the same session: refresh timestamps, keep the user's earlier dismiss decision
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
  file.pid = process.pid; // new generation = new process; a stale pid would skew cross-instance liveness checks
  writeToDisk();
  return stale.length;
}

/**
 * Funnel for running-set changes (called by rpc-manager notifyRunningChange): rewrite the current
 * boot's entries in full. Callers guarantee this is only invoked when the running set actually
 * changed (snapshot dedupe upstream).
 *
 * Empty sets are written to disk after a 2s delay (shutdown evidence window): the SIGTERM
 * shutdown path disposes the wrapper → agent_end → the running set empties — writing to disk
 * immediately would leave the boot roll seeing no interruptions at all. With the delayed write
 * (unref, does not block exit): a normal finish persists the empty set after 2s; on shutdown/crash
 * the process dies first, so the disk keeps the last non-empty snapshot = the interrupted set.
 * Independent of signal-handler timing; SIGKILL is covered too.
 */
export function recordRunningEntries(entries: JournalEntry[]): void {
  const file = load();
  file.entries = entries;
  if (entries.length > 0) {
    if (store.pendingEmpty) { clearTimeout(store.pendingEmpty); store.pendingEmpty = null; }
    writeToDisk();
    return;
  }
  if (store.pendingEmpty) clearTimeout(store.pendingEmpty);
  store.pendingEmpty = setTimeout(() => {
    store.pendingEmpty = null;
    writeToDisk();
  }, 2_000);
  store.pendingEmpty.unref();
}

/** Current interrupted set (for the GET listing). */
export function listInterrupted(): InterruptedEntry[] {
  return load().interrupted;
}

/** Update the disposition state of one interrupted record (used by the resolve API). */
export function setInterruptedState(sessionFile: string, state: InterruptedEntry["state"]): boolean {
  const file = load();
  const entry = file.interrupted.find((e) => e.sessionFile === sessionFile);
  if (!entry) return false;
  entry.state = state;
  writeToDisk();
  return true;
}

/** Interrupted record fully handled (recovered, or the file is gone); remove it from the list. */
export function removeInterrupted(sessionFile: string): void {
  const file = load();
  const next = file.interrupted.filter((e) => e.sessionFile !== sessionFile);
  if (next.length === file.interrupted.length) return;
  file.interrupted = next;
  writeToDisk();
}
