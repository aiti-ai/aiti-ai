/**
 * aiti-containers · live container stats.
 *
 * Data source is `docker stats --format '{{json .}}'`: the CLI itself streams one
 * JSON line per sample (~1s). We never poll — we parse the stream and forward a
 * throttled aggregate snapshot to the existing page event bus
 * (`aiti-event-bus`, topic `containers-stats`). No dedicated SSE endpoint.
 *
 * Lifecycle: reference-counted leases from explicit "watching" clients
 * (panel toggles live mode / page unload sends a stop). The child process only
 * exists while at least one viewer is attached; an idle timeout protects against
 * pages that crashed without releasing the lease.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export const STATS_TOPIC = "containers-stats";
/** Minimum spacing between published aggregates (the CLI emits one line per container per tick). */
const FLUSH_MS = 300;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

export interface StatsSample {
  id: string;
  name: string;
  cpu: string;
  mem: string;
  memPerc: string;
  net: string;
  block: string;
  pids: string;
}

/** `docker stats` prefixes the first line of each tick with ANSI cursor-clear codes. */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Parse one `docker stats --format '{{json .}}'` line. Returns null for non-JSON/noise. */
export function parseStatsLine(line: string): StatsSample | null {
  const t = String(line || "").replace(ANSI_RE, "").trim();
  if (!t || t[0] !== "{") return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = String(v.Name ?? v.name ?? "").trim();
  if (!name) return null;
  return {
    id: String(v.ID ?? v.Container ?? "").trim(),
    name,
    cpu: String(v.CPUPerc ?? "").trim(),
    mem: String(v.MemUsage ?? "").trim(),
    memPerc: String(v.MemPerc ?? "").trim(),
    net: String(v.NetIO ?? "").trim(),
    block: String(v.BlockIO ?? "").trim(),
    pids: String(v.PIDs ?? "").trim(),
  };
}

/** Aggregate raw CLI lines into `{ [name]: sample }` (last write wins per name). */
export function collectSamples(lines: string[]): Record<string, StatsSample> {
  const out: Record<string, StatsSample> = {};
  for (const line of lines) {
    const s = parseStatsLine(line);
    if (s) out[s.name] = s;
  }
  return out;
}

export interface StatsStatus {
  running: boolean;
  clients: number;
  samples: number;
  startedAt: number;
  error: string;
}

export interface StatsHubOptions {
  /** Executable to use (empty string = runtime unknown yet → start refused). */
  bin: () => string;
  /** Forward one aggregate frame to the page event bus. */
  publish: (type: string, data: Record<string, unknown>) => void;
  idleMs?: number;
  onLog?: (msg: string) => void;
}

export interface StatsHub {
  acquire(clientId: string): StatsStatus;
  release(clientId: string): StatsStatus;
  stop(reason?: string): void;
  status(): StatsStatus;
}

export function createStatsHub(opts: StatsHubOptions): StatsHub {
  const log = opts.onLog ?? (() => undefined);
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const clients = new Set<string>();
  const pending = new Map<string, StatsSample>();
  let proc: ChildProcessWithoutNullStreams | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  let sampleCount = 0;
  let lastError = "";

  function clearTimers(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (flushTimer) clearTimeout(flushTimer);
    idleTimer = null;
    flushTimer = null;
  }

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log("stats idle timeout — stopping docker stats");
      stop("idle");
    }, idleMs);
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  function flush(): void {
    flushTimer = null;
    if (!pending.size) return;
    const samples: Record<string, StatsSample> = {};
    for (const [name, s] of pending) samples[name] = s;
    pending.clear();
    try {
      opts.publish(STATS_TOPIC, { ts: Date.now(), samples });
    } catch (e) {
      log("publish failed: " + String(e));
    }
  }

  function onLine(line: string): void {
    const s = parseStatsLine(line);
    if (!s) return;
    pending.set(s.name, s);
    sampleCount += 1;
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
      (flushTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  function stop(reason = "stop"): void {
    clearTimers();
    pending.clear();
    if (!proc) return;
    const p = proc;
    proc = null;
    try {
      p.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    log("docker stats stopped (" + reason + ")");
  }

  function ensure(): void {
    if (proc) return;
    const bin = opts.bin();
    if (!bin) {
      lastError = "容器 CLI 不可用（runtime 未就绪）";
      return;
    }
    lastError = "";
    try {
      proc = spawn(bin, ["stats", "--format", "{{json .}}", "--no-trunc"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      lastError = String((e as Error)?.message || e);
      proc = null;
      return;
    }
    startedAt = Date.now();
    const p = proc;
    log("docker stats started (bin=" + bin + ")");
    const rl = createInterface({ input: p.stdout });
    rl.on("line", onLine);
    let stderr = "";
    p.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    p.on("error", (e) => {
      lastError = String(e?.message || e);
      proc = null;
      clearTimers();
    });
    p.on("exit", (code) => {
      if (proc === p) proc = null;
      clearTimers();
      if (code !== 0 && code !== null) {
        lastError = (stderr || "").trim() || "docker stats exited with code " + code;
        log("docker stats exited: " + lastError.slice(0, 200));
      }
    });
  }

  return {
    acquire(clientId: string): StatsStatus {
      clients.add(clientId || "anonymous");
      armIdle();
      ensure();
      return this.status();
    },
    release(clientId: string): StatsStatus {
      clients.delete(clientId || "anonymous");
      if (!clients.size) stop("no viewers");
      return this.status();
    },
    stop(reason?: string): void {
      clients.clear();
      stop(reason);
    },
    status(): StatsStatus {
      return { running: !!proc, clients: clients.size, samples: sampleCount, startedAt, error: lastError };
    },
  };
}
