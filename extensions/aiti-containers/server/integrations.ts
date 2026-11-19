/**
 * aiti-containers · soft integrations with sibling extensions.
 *
 * Two neighbours are consumed through the host service bus, never by importing
 * their modules:
 *   - aiti-cmd        → `aiti-cmd.runner` (PTY sessions) for docker exec / docker run -it
 *   - service-tunnels → `service-tunnels.api` (library singleton) for port enrollment
 *
 * Every entry point degrades gracefully: missing/older extensions return a
 * descriptive error instead of throwing, so the container panel keeps working.
 */

export interface ServiceBus {
  get?: (name: string) => unknown;
}

export interface ExtLikeCtx {
  services?: ServiceBus;
}

function service(ctx: ExtLikeCtx | null | undefined, name: string): any {
  try {
    const get = ctx?.services?.get;
    return typeof get === "function" ? get(name) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// aiti-cmd runner
// ---------------------------------------------------------------------------

export interface CmdRunner {
  run?: (opts: Record<string, unknown>) => unknown;
}

export function cmdRunner(ctx: ExtLikeCtx | null | undefined): CmdRunner | null {
  const svc = service(ctx, "aiti-cmd.runner") as CmdRunner | null;
  return svc && typeof svc.run === "function" ? svc : null;
}

/** Quote one argv fragment for the PTY command string (the runner takes a shell string). */
export function quoteArg(value: string): string {
  const s = String(value ?? "");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface SessionResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

async function runPty(ctx: ExtLikeCtx | null | undefined, command: string, name: string): Promise<SessionResult> {
  const runner = cmdRunner(ctx);
  if (!runner?.run) return { ok: false, error: "aiti-cmd 未安装或版本过旧（缺 runner 服务）" };
  try {
    const r: any = await runner.run({
      command,
      name,
      source: "service",
      // The panel-created sessions are short-lived interactive shells; keep the
      // runner default TTL but make the origin auditable.
    });
    if (!r || r.ok !== true || !r.sessionId) {
      return { ok: false, error: String((r && r.error) || "aiti-cmd 拒绝执行") };
    }
    return { ok: true, sessionId: String(r.sessionId) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

const EXEC_SHELLS = new Set(["sh", "bash", "ash", "zsh"]);

/** Path C: interactive shell inside a running container. */
export async function startExecSession(
  ctx: ExtLikeCtx | null | undefined,
  opts: { id: string; shell?: string; name?: string },
): Promise<SessionResult> {
  const id = String(opts.id || "").trim();
  if (!id) return { ok: false, error: "缺少容器 id" };
  const shell = String(opts.shell || "sh").trim();
  if (!EXEC_SHELLS.has(shell)) return { ok: false, error: "不支持的 shell：" + shell };
  const name = opts.name ? "容器 " + opts.name : "容器 " + id.slice(0, 12);
  return runPty(ctx, "docker exec -it " + quoteArg(id) + " " + shell, name);
}

/** Path B: `docker run -it` inside a PTY (foreground/interactive). */
export async function startRunSession(
  ctx: ExtLikeCtx | null | undefined,
  argv: string[],
  reference: string,
): Promise<SessionResult> {
  if (!Array.isArray(argv) || argv.length < 3) return { ok: false, error: "运行参数不完整" };
  const name = "镜像 " + String(reference || argv[argv.length - 1]);
  // argv already starts with "run" (buildRunArgs) — do not prepend it twice.
  return runPty(ctx, "docker " + argv.map(quoteArg).join(" "), name);
}

// ---------------------------------------------------------------------------
// service-tunnels
// ---------------------------------------------------------------------------

export interface TunnelApi {
  proxy?: {
    enroll?: (port: number, opts?: { serviceBasePath?: string }) => unknown;
    unenroll?: (port: number) => unknown;
    enrolled?: () => Array<{ port: number; serviceBasePath?: string }>;
  };
}

export function tunnelApi(ctx: ExtLikeCtx | null | undefined): TunnelApi | null {
  const svc = service(ctx, "service-tunnels.api") as TunnelApi | null;
  return svc && svc.proxy && typeof svc.proxy.enroll === "function" ? svc : null;
}

export interface EnrolledPort {
  port: number;
  basePath: string;
}

export function listEnrolled(ctx: ExtLikeCtx | null | undefined): EnrolledPort[] {
  const api = tunnelApi(ctx);
  if (!api?.proxy || typeof api.proxy.enrolled !== "function") return [];
  try {
    return api.proxy.enrolled().map((e) => ({ port: Number(e.port), basePath: String(e.serviceBasePath ?? "") }));
  } catch {
    return [];
  }
}

export type ExposeMode = "enroll" | "unenroll";

export interface ExposeResult {
  ok: boolean;
  ports?: EnrolledPort[];
  error?: string;
}

/** Only enrollment is automated; going public always goes through the tunnels UI (human picks provider). */
export function setPortEnrollment(ctx: ExtLikeCtx | null | undefined, port: number, mode: ExposeMode): ExposeResult {
  const api = tunnelApi(ctx);
  if (!api?.proxy) return { ok: false, error: "service-tunnels 未安装（缺 service-tunnels.api 服务）" };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: "端口非法（1-65535）" };
  try {
    if (mode === "enroll") {
      if (typeof api.proxy.enroll !== "function") return { ok: false, error: "service-tunnels 版本过旧（缺 enroll）" };
      api.proxy.enroll(p);
    } else {
      if (typeof api.proxy.unenroll !== "function") return { ok: false, error: "service-tunnels 版本过旧（缺 unenroll）" };
      api.proxy.unenroll(p);
    }
    return { ok: true, ports: listEnrolled(ctx) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}
