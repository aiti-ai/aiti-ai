/**
 * aiti-containers · resource aggregation + action dispatch.
 *
 * Everything here is a pure translation layer: argv construction, whitelist
 * enforcement, and result shaping. The actual probe/exec primitives live in
 * runtime.ts. No shell strings are ever built — only argv arrays.
 */
import {
  detectRuntime,
  explainError,
  mergedOutput,
  parseContainers,
  parseImages,
  parseNetworks,
  parseSystemUsage,
  parseVolumes,
  runCli,
  type RuntimeInfo,
} from "./runtime.ts";

export const MAX_TAIL = 2000;
const DEFAULT_TAIL = 200;

export type ResourceKind = "containers" | "images" | "volumes" | "networks";
export const RESOURCE_KINDS: ResourceKind[] = ["containers", "images", "volumes", "networks"];

export interface ActionRequest {
  kind: string;
  action: string;
  id?: string;
  name?: string;
  project?: string;
  dir?: string;
  reference?: string;
  command?: string;
  shell?: string;
  tail?: number;
  force?: boolean;
  confirm?: boolean;
  /** `images.run`: port mappings / env / --rm (validated by buildRunArgs). */
  ports?: Array<{ host?: number | string; container?: number | string }>;
  env?: string[];
  rm?: boolean;
}

export interface ComposeProject {
  project: string;
  workingDir: string;
  configFiles: string;
  total: number;
  running: number;
  services: string[];
}

/** Actions that require an explicit confirmation handshake. */
export const DANGER: Record<string, string[]> = {
  containers: ["remove", "exec"],
  images: ["remove", "prune"],
  volumes: ["remove", "prune"],
  networks: ["remove", "prune"],
  compose: ["down"],
  system: ["prune"],
};

function tailOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_TAIL) : DEFAULT_TAIL;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

const EXEC_SHELLS = new Set(["sh", "bash", "ash", "zsh"]);

function composeArgs(r: ActionRequest, tail: string[]): string[] | { error: string } {
  const project = str(r.project);
  if (!project) return { error: "缺少 compose 项目名（project）" };
  const args = ["compose"];
  const dir = str(r.dir);
  if (dir) args.push("--project-directory", dir);
  args.push("-p", project, ...tail);
  return args;
}

type Builder = (r: ActionRequest) => string[] | { error: string };

const BUILDERS: Record<string, Record<string, Builder>> = {
  containers: {
    start: (r) => ["start", str(r.id)],
    stop: (r) => ["stop", str(r.id)],
    restart: (r) => ["restart", str(r.id)],
    remove: (r) => ["rm", ...(r.force ? ["-f"] : []), str(r.id)],
    logs: (r) => ["logs", "--tail", String(tailOf(r.tail)), str(r.id)],
    exec: (r) => {
      const shell = str(r.shell) || "sh";
      if (!EXEC_SHELLS.has(shell)) return { error: "不支持的 shell：" + shell + "（可用 sh / bash / ash / zsh）" };
      if (!str(r.command)) return { error: "缺少 command" };
      return ["exec", str(r.id), shell, "-lc", str(r.command)];
    },
  },
  images: {
    run: (r) => {
      const built = buildRunArgs(r as RunRequest, { interactive: false, defaultRm: false });
      return built.ok ? built.argv : { error: built.error };
    },
    pull: (r) => ["pull", str(r.reference) || str(r.id)],
    remove: (r) => ["rmi", ...(r.force ? ["-f"] : []), str(r.id)],
    prune: () => ["image", "prune", "-f"],
  },
  volumes: {
    create: (r) => (str(r.name) ? ["volume", "create", str(r.name)] : { error: "缺少卷名（name）" }),
    remove: (r) => ["volume", "rm", str(r.id) || str(r.name)],
    prune: () => ["volume", "prune", "-f"],
  },
  networks: {
    create: (r) => (str(r.name) ? ["network", "create", str(r.name)] : { error: "缺少网络名（name）" }),
    remove: (r) => ["network", "rm", str(r.id) || str(r.name)],
    prune: () => ["network", "prune", "-f"],
  },
  compose: {
    up: (r) => composeArgs(r, ["up", "-d"]),
    down: (r) => composeArgs(r, ["down"]),
    restart: (r) => composeArgs(r, ["restart"]),
    stop: (r) => composeArgs(r, ["stop"]),
    logs: (r) => composeArgs(r, ["logs", "--tail", String(tailOf(r.tail))]),
  },
  system: {
    prune: () => ["system", "prune", "-f"],
  },
};

function requiresId(kind: string): boolean {
  return kind === "containers";
}

/** Public runtime snapshot (safe to hand to the client / tools). */
export function publicRuntime(rt: RuntimeInfo): Record<string, unknown> {
  return {
    ok: rt.ok,
    kind: rt.kind,
    version: rt.version,
    bin: rt.bin,
    compose: rt.compose,
    composeVersion: rt.composeVersion,
    error: rt.error,
    preference: rt.preference,
    probedAt: rt.probedAt,
  };
}

function errEntry(kind: string, r: { code: number; stderr: string; timedOut: boolean }) {
  return {
    kind,
    code: r.code,
    timedOut: r.timedOut,
    error: r.timedOut ? "命令超时（20s）" : explainError(r.stderr, r.code),
  };
}

/** Is this (kind, action) pair allowed at all? */
export function isKnownAction(kind: string, action: string): boolean {
  return !!(BUILDERS[kind] && BUILDERS[kind][action]);
}

export function needsConfirm(kind: string, action: string): boolean {
  return (DANGER[kind] || []).includes(action);
}

/** `docker system df` walks the whole build cache (seconds on busy daemons) — cache it. */
const USAGE_TTL_MS = 60_000;
let usageCache: { at: number; bin: string; rows: unknown[] } | null = null;

export interface StatePayload {
  ok: boolean;
  runtime: Record<string, unknown>;
  containers: unknown[];
  images: unknown[];
  volumes: unknown[];
  networks: unknown[];
  usage: unknown[];
  composeProjects: ComposeProject[];
  errors: Array<Record<string, unknown>>;
  ts: number;
}

/**
 * Collect the requested resources concurrently. One failing command degrades only
 * that resource (partial results + an error entry) instead of failing the whole call.
 */
export async function collectState(rt: RuntimeInfo, kind: string, opts: { usage?: boolean } = {}): Promise<StatePayload> {
  const want = (k: ResourceKind) => kind === "all" || kind === k;
  const base: StatePayload = {
    ok: rt.ok,
    runtime: publicRuntime(rt),
    containers: [],
    images: [],
    volumes: [],
    networks: [],
    usage: [],
    composeProjects: [],
    errors: [],
    ts: Date.now(),
  };
  if (!rt.ok) {
    base.errors.push({ kind: "runtime", error: rt.error });
    return base;
  }

  const usageFresh = usageCache && usageCache.bin === rt.bin && Date.now() - usageCache.at < USAGE_TTL_MS;
  const wantUsage = opts.usage === true;
  const psArgs = (json: boolean) => ["ps", "-a", "--no-trunc", "--format", json ? "json" : "{{json .}}"];
  const [ps0, imgs, vols, nets, df] = await Promise.all([
    want("containers") ? runCli(rt.bin, psArgs(rt.psJson)) : null,
    want("images") ? runCli(rt.bin, ["images", "--format", "{{json .}}"]) : null,
    want("volumes") ? runCli(rt.bin, ["volume", "ls", "--format", "{{json .}}"]) : null,
    want("networks") ? runCli(rt.bin, ["network", "ls", "--format", "{{json .}}"]) : null,
    wantUsage && !usageFresh ? runCli(rt.bin, ["system", "df", "--format", "{{json .}}"]) : null,
  ]);

  let ps = ps0;
  if (ps && ps.code !== 0 && rt.psJson) {
    // Non-docker runtimes may reject the `json` shorthand: remember and retry once.
    rt.psJson = false;
    ps = await runCli(rt.bin, psArgs(false));
  }
  if (ps) {
    if (ps.code === 0) base.containers = parseContainers(ps.stdout);
    else base.errors.push(errEntry("containers", ps));
  }
  if (imgs) {
    if (imgs.code === 0) base.images = parseImages(imgs.stdout);
    else base.errors.push(errEntry("images", imgs));
  }
  if (vols) {
    if (vols.code === 0) base.volumes = parseVolumes(vols.stdout);
    else base.errors.push(errEntry("volumes", vols));
  }
  if (nets) {
    if (nets.code === 0) base.networks = parseNetworks(nets.stdout);
    else base.errors.push(errEntry("networks", nets));
  }
  if (wantUsage) {
    if (df && df.code === 0) {
      base.usage = parseSystemUsage(df.stdout);
      usageCache = { at: Date.now(), bin: rt.bin, rows: base.usage };
    } else if (usageCache && usageCache.bin === rt.bin) {
      base.usage = usageCache.rows;
    }
  }

  base.composeProjects = deriveComposeProjects(base.containers as Array<Record<string, any>>);
  return base;
}

/** Group containers by compose project label (used by the UI and by agent tools). */
export function deriveComposeProjects(containers: Array<Record<string, any>>): ComposeProject[] {
  const map = new Map<string, ComposeProject>();
  for (const c of containers) {
    const ref = c && c.compose;
    if (!ref || !ref.project) continue;
    let p = map.get(ref.project);
    if (!p) {
      p = {
        project: ref.project,
        workingDir: ref.workingDir || "",
        configFiles: ref.configFiles || "",
        total: 0,
        running: 0,
        services: [],
      };
      map.set(ref.project, p);
    }
    p.total += 1;
    if (c.running) p.running += 1;
    if (ref.service && !p.services.includes(ref.service)) p.services.push(ref.service);
  }
  return Array.from(map.values()).sort((a, b) => a.project.localeCompare(b.project));
}

export interface LogsPayload {
  ok: boolean;
  text: string;
  tail: number;
  truncated: boolean;
  error?: string;
}

export async function fetchLogs(rt: RuntimeInfo, req: ActionRequest & { kind?: string }): Promise<LogsPayload> {
  const tail = tailOf(req.tail);
  if (!rt.ok) return { ok: false, text: "", tail, truncated: false, error: rt.error };

  let args: string[];
  if (req.kind === "compose") {
    const c = composeArgs(req, ["logs", "--tail", String(tail)]);
    if ("error" in c) return { ok: false, text: "", tail, truncated: false, error: String(c.error) };
    args = c;
  } else {
    const id = str(req.id);
    if (!id) return { ok: false, text: "", tail, truncated: false, error: "缺少容器 id" };
    args = ["logs", "--tail", String(tail), id];
  }

  const r = await runCli(rt.bin, args, { timeout: 30000 });
  if (r.code !== 0) {
    return { ok: false, text: mergedOutput(r), tail, truncated: false, error: explainError(r.stderr, r.code) };
  }
  const text = mergedOutput(r);
  const MAX_CHARS = 256 * 1024;
  const truncated = text.length > MAX_CHARS;
  return { ok: true, text: truncated ? text.slice(-MAX_CHARS) : text, tail, truncated };
}

export interface ActionResult {
  ok: boolean;
  sent?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  needConfirm?: boolean;
  danger?: string;
  ts: number;
}

/** Execute one whitelisted action. Callers must already have validated confirmation. */
export async function runAction(rt: RuntimeInfo, req: ActionRequest): Promise<ActionResult> {
  const kind = str(req.kind);
  const action = str(req.action);
  const ts = Date.now();

  if (!isKnownAction(kind, action)) {
    return { ok: false, ts, error: "不支持的动作：" + kind + "." + action };
  }
  if (!rt.ok) return { ok: false, ts, error: rt.error };
  if (requiresId(kind) && !str(req.id)) return { ok: false, ts, error: "缺少容器 id" };
  if (kind === "images" && (action === "remove" || action === "pull") && !str(req.id) && !str(req.reference)) {
    return { ok: false, ts, error: "缺少镜像 id 或 reference" };
  }

  const built = BUILDERS[kind][action](req);
  if (!Array.isArray(built)) return { ok: false, ts, error: String((built as { error: string }).error) };

  const timeout =
    (kind === "images" && (action === "pull" || action === "run")) || (kind === "compose" && action === "up") ? 180000 : 60000;
  const r = await runCli(rt.bin, built, { timeout });
  // Quote argv items that contain whitespace/shell-ish characters so the echoed
  // command reads unambiguously (it is still an argv array, never a shell string).
  const sent = [rt.bin, ...built].map((a) => (/[\s;'"$`]/.test(a) ? JSON.stringify(a) : a)).join(" ");
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();

  if (r.code !== 0) {
    return { ok: false, ts, sent, code: r.code, stdout: out.slice(0, 8000), stderr: err.slice(0, 8000), error: explainError(err, r.code) };
  }
  return { ok: true, ts, sent, code: 0, stdout: out.slice(0, 8000), stderr: err.slice(0, 8000) };
}

/** System usage (`docker system df`) is slow on busy daemons — served separately + cached. */
export async function collectUsage(rt: RuntimeInfo): Promise<{ ok: boolean; usage: unknown[]; error?: string }> {
  if (!rt.ok) return { ok: false, usage: [], error: rt.error };
  if (usageCache && usageCache.bin === rt.bin && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return { ok: true, usage: usageCache.rows };
  }
  const r = await runCli(rt.bin, ["system", "df", "--format", "{{json .}}"]);
  if (r.code !== 0) return { ok: false, usage: (usageCache && usageCache.bin === rt.bin ? usageCache.rows : []) as unknown[], error: explainError(r.stderr, r.code) };
  const rows = parseSystemUsage(r.stdout);
  usageCache = { at: Date.now(), bin: rt.bin, rows };
  return { ok: true, usage: rows };
}

// ---------------------------------------------------------------------------
// `docker run` (background) — validated argv builder shared with the PTY path
// ---------------------------------------------------------------------------

export interface RunRequest {
  reference?: string;
  name?: string;
  ports?: Array<{ host?: number | string; container?: number | string }>;
  env?: string[];
  command?: string;
  rm?: boolean;
}

export type RunArgs =
  | { ok: true; argv: string[] }
  | { ok: false; error: string };

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,200}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=.{0,500}$/;

function portNumber(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0;
}

/**
 * Build the argv for `docker run [-d | -it] ...`. Validation is strict and
 * rejects rather than sanitizing: a wrong image ref must not silently become a
 * different container. `interactive` selects the PTY variant.
 */
export function buildRunArgs(req: RunRequest, opts: { interactive?: boolean; defaultRm?: boolean } = {}): RunArgs {
  const reference = String(req.reference ?? "").trim();
  if (!REF_RE.test(reference)) return { ok: false, error: "镜像 reference 非法（允许字母数字与 . _ / : @ -）" };

  const argv: string[] = ["run"];
  argv.push(opts.interactive ? "-it" : "-d");

  const rm = req.rm === undefined ? opts.defaultRm === true : req.rm === true;
  if (rm) argv.push("--rm");

  const name = String(req.name ?? "").trim();
  if (name) {
    if (!NAME_RE.test(name)) return { ok: false, error: "容器名非法（字母数字开头，允许 . _ -，≤64）" };
    argv.push("--name", name);
  }

  const ports = Array.isArray(req.ports) ? req.ports : [];
  if (ports.length > 20) return { ok: false, error: "端口映射最多 20 条" };
  for (const p of ports) {
    const host = portNumber(p?.host);
    const container = portNumber(p?.container);
    if (!host || !container) return { ok: false, error: "端口映射非法（host/container 均需 1-65535）" };
    argv.push("-p", host + ":" + container);
  }

  const env = Array.isArray(req.env) ? req.env : [];
  if (env.length > 50) return { ok: false, error: "环境变量最多 50 条" };
  for (const e of env) {
    const line = String(e ?? "").trim();
    if (!line) continue;
    if (!ENV_RE.test(line)) return { ok: false, error: "环境变量格式非法（KEY=VALUE）：" + line.slice(0, 40) };
    argv.push("-e", line);
  }

  // Image ref comes before the command override: `docker run ... <ref> [cmd...]`.
  argv.push(reference);
  const command = String(req.command ?? "").trim();
  if (command) {
    if (command.length > 500) return { ok: false, error: "命令过长（≤500）" };
    // Simple whitespace split; quoting is explicitly unsupported (documented in the form).
    for (const part of command.split(/\s+/)) if (part) argv.push(part);
  }
  return { ok: true, argv };
}

/** Path A: detached `docker run`. */
export async function runImageDetached(rt: RuntimeInfo, req: RunRequest): Promise<ActionResult> {
  const ts = Date.now();
  if (!rt.ok) return { ok: false, ts, error: rt.error };
  const built = buildRunArgs(req, { interactive: false, defaultRm: false });
  if (!built.ok) return { ok: false, ts, error: built.error };
  const r = await runCli(rt.bin, built.argv, { timeout: 180000 });
  const sent = [rt.bin, ...built.argv].map((a) => (/[\s;'"$`]/.test(a) ? JSON.stringify(a) : a)).join(" ");
  if (r.code !== 0) {
    return { ok: false, ts, sent, code: r.code, stdout: (r.stdout || "").trim().slice(0, 4000), stderr: (r.stderr || "").trim().slice(0, 8000), error: explainError(r.stderr, r.code) };
  }
  return { ok: true, ts, sent, code: 0, stdout: (r.stdout || "").trim().slice(0, 4000), stderr: (r.stderr || "").trim().slice(0, 4000) };
}

export interface InspectPayload {
  ok: boolean;
  id: string;
  kind: string;
  text: string;
  error?: string;
}

export async function fetchInspect(rt: RuntimeInfo, kind: string, id: string): Promise<InspectPayload> {
  const k = str(kind) || "containers";
  const target = str(id);
  if (!rt.ok) return { ok: false, id: target, kind: k, text: "", error: rt.error };
  if (!target) return { ok: false, id: target, kind: k, text: "", error: "缺少 id" };
  // `docker inspect container X` is not valid; containers use plain `inspect`,
  // the other kinds use their object-scoped subcommand.
  const args = k === "images" ? ["image", "inspect", target] : k === "volumes" ? ["volume", "inspect", target] : k === "networks" ? ["network", "inspect", target] : ["inspect", target];
  const r = await runCli(rt.bin, args, { timeout: 30000 });
  if (r.code !== 0) return { ok: false, id: target, kind: k, text: r.stderr, error: explainError(r.stderr, r.code) };
  const MAX = 200 * 1024;
  const text = r.stdout.length > MAX ? r.stdout.slice(0, MAX) + "\n…(inspect 输出已截断)" : r.stdout;
  return { ok: true, id: target, kind: k, text };
}

export { detectRuntime };
