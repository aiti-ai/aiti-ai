/**
 * aiti-containers — container management for the pi-web AI window.
 *
 * A deliberately small port of the VS Code Container Tools explorer:
 *  - runtime probe (docker / podman / nerdctl, compose subcommand)
 *  - resource aggregation (containers / images / volumes / networks / system df)
 *  - whitelisted actions with a danger-confirmation handshake
 *  - agent tools so the AI can inspect and drive the same resources
 *
 * Server only uses node builtins; the client bundle is plain DOM-ish hyperscript
 * with zero runtime dependencies (see client/src/entry.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MAX_TAIL,
  collectState,
  collectUsage,
  fetchInspect,
  fetchLogs,
  isKnownAction,
  needsConfirm,
  publicRuntime,
  runAction,
  type ActionRequest,
} from "./server/ops.ts";
import { detectRuntime, type RuntimeInfo } from "./server/runtime.ts";
import { createStatsHub, type StatsHub } from "./server/stats.ts";
import { aggregatePorts } from "./server/ports.ts";
import { buildRunArgs, type RunRequest } from "./server/ops.ts";
import { listEnrolled, setPortEnrollment, startExecSession, startRunSession, tunnelApi } from "./server/integrations.ts";
import { I18N } from "./server/i18n.ts";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const RUNTIME_TTL_MS = 120_000;
/** Live stats hub (docker stats stream forwarded to the page event bus). */
let statsHub: StatsHub | null = null;
let runtimeCache: { info: RuntimeInfo; at: number } | null = null;
/** Last server context (features getter); refreshed on every startup/reload. */
let liveCtx: { features?: { get?: (id: string) => unknown } } | null = null;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function featureString(ctx: { features?: { get?: (id: string) => unknown } } | null, id: string, fallback: string): string {
  try {
    const v = ctx?.features?.get?.(id);
    return v === undefined || v === null || v === "" ? fallback : String(v);
  } catch {
    return fallback;
  }
}

function featureBool(ctx: { features?: { get?: (id: string) => unknown } } | null, id: string, fallback: boolean): boolean {
  try {
    const v = ctx?.features?.get?.(id);
    return typeof v === "boolean" ? v : fallback;
  } catch {
    return fallback;
  }
}

async function getRuntime(ctx: typeof liveCtx, force = false): Promise<RuntimeInfo> {
  const pref = featureString(ctx, "cli", "auto");
  const at = Date.now();
  if (!force && runtimeCache && runtimeCache.info.preference === pref && at - runtimeCache.at < RUNTIME_TTL_MS) {
    return runtimeCache.info;
  }
  const info = await detectRuntime(pref);
  runtimeCache = { info, at };
  return info;
}

function defaultTail(ctx: typeof liveCtx): number {
  const n = Number(featureString(ctx, "logTail", "200"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_TAIL) : 200;
}

/** Publish one frame to the shared page event bus (publish-local: high-frequency frames stay off the core route). */
function publishToBus(type: string, data: Record<string, unknown>): void {
  try {
    const services = (liveCtx as { services?: { get?: (name: string) => { publish?: (t: string, d: Record<string, unknown>) => void } } } | null)?.services;
    const svc = services?.get?.("aiti-event-bus.publish-local") ?? services?.get?.("aiti-event-bus.publish");
    svc?.publish?.(type, data);
  } catch {
    /* event bus absent: live stats simply have no consumers */
  }
}

function ensureStatsHub(): StatsHub {
  if (!statsHub) {
    statsHub = createStatsHub({
      bin: () => (runtimeCache?.info?.ok ? runtimeCache.info.bin : ""),
      publish: publishToBus,
      onLog: (m) => console.log("[aiti-containers] " + m),
    });
  }
  return statsHub;
}

/** Run-form memory (ports/env/name/rm) — persistent but non-critical: stateDir. */
interface RunDefaults {
  name: string;
  ports: Array<{ host: number; container: number }>;
  env: string[];
  rm: boolean;
}

function runDefaultsFile(ctx: { stateDir?: string; configDir?: string }): string {
  const base = ctx?.stateDir || ctx?.configDir || process.cwd();
  return join(base, "run-defaults.json");
}

function readRunDefaults(ctx: { stateDir?: string; configDir?: string }): RunDefaults | null {
  try {
    const raw = JSON.parse(readFileSync(runDefaultsFile(ctx), "utf8")) as Partial<RunDefaults>;
    return {
      name: String(raw.name ?? "").slice(0, 64),
      ports: Array.isArray(raw.ports) ? raw.ports.filter((p) => p && Number(p.host) > 0 && Number(p.container) > 0).slice(0, 20) : [],
      env: Array.isArray(raw.env) ? raw.env.map((e) => String(e)).slice(0, 50) : [],
      rm: raw.rm === true,
    };
  } catch {
    return null;
  }
}

function writeRunDefaults(ctx: { stateDir?: string; configDir?: string }, body: Partial<RunDefaults>): RunDefaults {
  const clean: RunDefaults = {
    name: String(body.name ?? "").slice(0, 64),
    ports: Array.isArray(body.ports) ? body.ports.filter((p) => p && Number(p.host) > 0 && Number(p.container) > 0).slice(0, 20) : [],
    env: Array.isArray(body.env) ? body.env.map((e) => String(e)).slice(0, 50) : [],
    rm: body.rm === true,
  };
  const file = runDefaultsFile(ctx);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

function dangerLabel(kind: string, action: string, body: ActionRequest): string {
  const target = body.id || body.name || body.project || "";
  return (kind + "." + action + (target ? " " + target : "")).trim();
}

/** Map a raw action request to a validated result (used by API and tools). */
async function performAction(ctx: typeof liveCtx, body: ActionRequest): Promise<{ status: number; payload: Record<string, unknown> }> {
  const kind = String(body.kind || "").trim();
  const action = String(body.action || "").trim();
  if (!isKnownAction(kind, action)) {
    return { status: 400, payload: { ok: false, error: "不支持的动作：" + (kind || "?") + "." + (action || "?") } };
  }
  const confirmRequired = needsConfirm(kind, action) && featureBool(ctx, "confirmDanger", true);
  if (confirmRequired && body.confirm !== true) {
    return {
      status: 428,
      payload: {
        ok: false,
        needConfirm: true,
        danger: dangerLabel(kind, action, body),
        error: "危险操作需要确认：把动作原文展示给用户，获得明确同意后以 confirm:true 重试。",
      },
    };
  }
  const rt = await getRuntime(ctx);
  const result = await runAction(rt, body);
  return { status: 200, payload: result as unknown as Record<string, unknown> };
}

export default {
  id: "aiti-containers",
  name: "容器管理（Docker / Podman / nerdctl）",
  icon: "icon.svg",
  client: "dist/aiti-containers-client.mjs",

  ai: {
    manage: true,
    intro:
      "AI 能在面板里查看容器/镜像/卷/网络/compose 项目，并在用户同意后执行启停、删除、清理、日志查看与容器内命令（aiti_containers_* 工具）。",
    skills: "skills",
  },

  features: [
    {
      id: "cli",
      type: "string",
      label: "容器 CLI",
      value: "auto",
      placeholder: "auto",
      group: "运行时",
      description:
        "auto = 自动探测 docker → podman → nerdctl；也可填 docker / podman / nerdctl 或可执行文件绝对路径。改后首次请求自动重探（无需重启）。",
    },
    {
      id: "showStopped",
      type: "boolean",
      label: "显示已停止容器",
      default: true,
      group: "面板",
      description: "容器列表是否显示已停止/已退出的容器（docker ps -a）。",
    },
    {
      id: "logTail",
      type: "string",
      label: "默认日志行数",
      value: "200",
      group: "面板",
      description: "日志查看器默认 tail 行数（上限 2000）。",
    },
    {
      id: "confirmDanger",
      type: "boolean",
      label: "危险操作二次确认",
      default: true,
      group: "安全",
      description:
        "删除/清理/compose down/容器内执行等危险动作需要二次确认（UI 二次点击、AI 工具 confirm:true）。关闭后 AI 可直接执行，不推荐。",
    },
  ],

  ui: {
    toolbar: [
      { id: "containers-open", label: "i18n:ac.toolbar.label", title: "i18n:ac.toolbar.title", icon: "icon.svg" },
    ],
    dialogs: [{ id: "containers-dialog", label: "i18n:ac.dialog.label" }],
    commands: [{ id: "containers-command", label: "i18n:ac.command.label" }],
    i18n: I18N,
  },

  server: {
    async startup(ctx: { dir: string; features?: { get?: (id: string) => unknown } }) {
      liveCtx = ctx;
      ensureStatsHub();
      const info = await getRuntime(ctx, true);
      if (info.ok) {
        console.log(
          "[aiti-containers] runtime=" + info.kind + " " + (info.version || "?") +
            " bin=" + info.bin + " compose=" + (info.compose ? info.composeVersion || "yes" : "no"),
        );
      } else {
        console.warn("[aiti-containers] 未找到容器 CLI：" + info.error.slice(0, 200));
      }
    },
    async shutdown() {
      try {
        statsHub?.stop("extension shutdown");
      } catch {
        /* noop */
      }
      statsHub = null;
      runtimeCache = null;
    },

    // /api/extensions/aiti-containers/<path>
    async api(req: Request, ctx: any) {
      const p: string[] = ctx.path || [];
      const q: URLSearchParams = ctx.searchParams;
      liveCtx = ctx;
      try {
        if (req.method === "GET" && (p.length === 0 || p[0] === "state")) {
          const rt = await getRuntime(ctx, q.get("refresh") === "1");
          const state = await collectState(rt, q.get("kind") || "all");
          return json({ ...state, defaultTail: defaultTail(ctx), showStopped: featureBool(ctx, "showStopped", true) });
        }
        if (req.method === "GET" && p[0] === "runtime") {
          const rt = await getRuntime(ctx, q.get("refresh") === "1");
          return json({ ok: rt.ok, runtime: publicRuntime(rt) });
        }
        if (req.method === "GET" && p[0] === "usage") {
          const rt = await getRuntime(ctx);
          return json({ ...(await collectUsage(rt)), ts: Date.now() });
        }
        if (req.method === "GET" && p[0] === "logs") {
          const rt = await getRuntime(ctx);
          const out = await fetchLogs(rt, {
            kind: q.get("kind") || "containers",
            action: "logs",
            id: q.get("id") || "",
            project: q.get("project") || "",
            dir: q.get("dir") || "",
            tail: Number(q.get("tail") || 0) || defaultTail(ctx),
          });
          return json(out);
        }
        if (req.method === "GET" && p[0] === "inspect") {
          const rt = await getRuntime(ctx);
          return json(await fetchInspect(rt, q.get("kind") || "containers", q.get("id") || ""));
        }
        // Live stats leases: the panel acquires on toggle, releases on close/unload.
        // The docker stats child process streams samples; frames go through aiti-event-bus.
        if (req.method === "POST" && p[0] === "stats" && p[1] === "start") {
          const body = (await req.json().catch(() => ({}))) as { clientId?: string };
          return json({ ok: true, ...ensureStatsHub().acquire(String(body.clientId || "")) });
        }
        if (req.method === "POST" && p[0] === "stats" && p[1] === "stop") {
          const body = (await req.json().catch(() => ({}))) as { clientId?: string };
          return json({ ok: true, ...ensureStatsHub().release(String(body.clientId || "")) });
        }
        if (req.method === "GET" && p[0] === "stats" && p[1] === "status") {
          return json({ ok: true, ...ensureStatsHub().status() });
        }
        // ---- phase 2: ports + enrollment ----
        if (req.method === "GET" && p[0] === "ports") {
          const rt = await getRuntime(ctx);
          const state = await collectState(rt, "containers");
          const ports = aggregatePorts(state.containers as Array<Record<string, any>>);
          const enrolled = listEnrolled(ctx);
          const byPort = new Map(enrolled.map((e) => [e.port, e]));
          return json({
            ok: true,
            tunnelsAvailable: !!tunnelApi(ctx),
            ports: ports.map((x) => ({ ...x, enrolled: byPort.has(x.port), basePath: byPort.get(x.port)?.basePath ?? "" })),
            enrolled,
            ts: Date.now(),
          });
        }
        // Enrollment only: going public is a human decision inside the tunnel panel.
        if (req.method === "POST" && p[0] === "expose") {
          const body = (await req.json().catch(() => ({}))) as { port?: number | string; mode?: string };
          const mode = body.mode === "unenroll" ? "unenroll" : "enroll";
          return json(setPortEnrollment(ctx, Number(body.port), mode));
        }
        // Path C: interactive shell inside a running container (aiti-cmd PTY).
        if (req.method === "POST" && p[0] === "exec-session") {
          const body = (await req.json().catch(() => ({}))) as { id?: string; shell?: string; name?: string };
          return json(await startExecSession(ctx, { id: String(body.id || ""), shell: String(body.shell || "sh"), name: String(body.name || "") }));
        }
        // Path B: `docker run -it` in a PTY (interactive image run).
        if (req.method === "POST" && p[0] === "image-session") {
          const body = (await req.json().catch(() => ({}))) as RunRequest;
          const built = buildRunArgs(body, { interactive: true, defaultRm: true });
          if (!built.ok) return json({ ok: false, error: built.error }, 400);
          return json(await startRunSession(ctx, built.argv, String(body.reference || "")));
        }
        // Run-form memory (ports/env/name/rm): loaded when the form opens, saved after a successful run.
        if (req.method === "GET" && p[0] === "run-defaults") {
          return json({ ok: true, defaults: readRunDefaults(ctx) });
        }
        if (req.method === "POST" && p[0] === "run-defaults") {
          const body = (await req.json().catch(() => ({}))) as Partial<RunDefaults>;
          try {
            return json({ ok: true, defaults: writeRunDefaults(ctx, body) });
          } catch (e) {
            return json({ ok: false, error: msg(e) }, 500);
          }
        }
        if (req.method === "POST" && p[0] === "action") {
          const body = (await req.json().catch(() => ({}))) as ActionRequest;
          const r = await performAction(ctx, body);
          return json(r.payload, r.status);
        }
        return json({ ok: false, error: "not found: " + p.join("/") }, 404);
      } catch (e) {
        return json({ ok: false, error: msg(e) }, 500);
      }
    },
    agent: {
      /** Tools injected into every agent session (pi SDK ToolDefinition shape). */
      agentTools() {
        const ok = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
        const fail = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], isError: true });

        return [
          {
            name: "aiti_containers_state",
            label: "aiti_containers_state",
            description:
              "列出本机容器、镜像、卷、网络（含 compose 项目分组、运行态、端口、占用概览 system df）。" +
              "kind=all（默认）| containers | images | volumes | networks。排查容器问题先调它定位目标，再拿 id 做后续操作。",
            parameters: {
              type: "object",
              properties: {
                kind: { type: "string", description: "all | containers | images | volumes | networks（默认 all）" },
              },
            },
            async execute(_id: unknown, params: Record<string, unknown>) {
              try {
                const rt = await getRuntime(liveCtx);
                const state = await collectState(rt, String(params?.kind || "all"), { usage: true });
                return ok(state);
              } catch (e) {
                return fail({ ok: false, error: msg(e) });
              }
            },
          },
          {
            name: "aiti_containers_logs",
            label: "aiti_containers_logs",
            description:
              "读取容器日志（docker logs --tail）。id = 容器 id/名称；compose=1 时按 project+dir 读整组日志。tail 默认 200，上限 2000。",
            parameters: {
              type: "object",
              properties: {
                id: { type: "string", description: "容器 id 或名称（compose 模式下可省略）" },
                tail: { type: "number", description: "末尾行数（默认 200，上限 2000）" },
                compose: { type: "boolean", description: "true = 按 compose 项目读日志（需 project；dir 可选）" },
                project: { type: "string", description: "compose 项目名（compose=true 时必填）" },
                dir: { type: "string", description: "compose 项目工作目录（可选）" },
              },
            },
            async execute(_id: unknown, params: Record<string, unknown>) {
              const rt = await getRuntime(liveCtx);
              const compose = params?.compose === true;
              const out = await fetchLogs(rt, {
                kind: compose ? "compose" : "containers",
                action: "logs",
                id: String(params?.id || ""),
                project: String(params?.project || ""),
                dir: String(params?.dir || ""),
                tail: Number(params?.tail || 0) || defaultTail(liveCtx),
              });
              return out.ok ? ok(out) : fail(out);
            },
          },
          {
            name: "aiti_containers_action",
            label: "aiti_containers_action",
            description:
              "对容器资源执行白名单动作。kind=containers|images|volumes|networks|compose|system；" +
              "action：containers=start|stop|restart|remove；images=pull|remove|prune；volumes=create|remove|prune；" +
              "networks=create|remove|prune；compose=up|down|restart|stop；system=prune。" +
              "危险动作（remove/prune/compose down/system prune）必须先向用户展示动作原文并获得明确同意，再以 confirm:true 重调。",
            parameters: {
              type: "object",
              properties: {
                kind: { type: "string", description: "containers | images | volumes | networks | compose | system" },
                action: { type: "string", description: "动作名（见工具描述）" },
                id: { type: "string", description: "目标 id/名称（containers 必填；images 删除用镜像 id）" },
                name: { type: "string", description: "create 时的卷/网络名" },
                project: { type: "string", description: "compose 项目名（compose 动作必填）" },
                dir: { type: "string", description: "compose 项目工作目录（可选）" },
                reference: { type: "string", description: "镜像 pull 的 reference（如 nginx:alpine）" },
                force: { type: "boolean", description: "remove 时强制（-f）" },
                confirm: { type: "boolean", description: "危险动作确认：仅在用户明确同意后置 true" },
              },
              required: ["kind", "action"],
            },
            async execute(_id: unknown, params: Record<string, unknown>) {
              const r = await performAction(liveCtx, params as ActionRequest);
              return r.payload.ok ? ok(r.payload) : fail(r.payload);
            },
          },
          {
            name: "aiti_containers_exec",
            label: "aiti_containers_exec",
            description:
              "在运行中的容器内执行一条命令（docker exec <id> <shell> -lc <cmd>）。危险动作：必须先向用户展示命令原文并获得明确同意，" +
              "再以 confirm:true 重调。适合只读排查（ps/ls/cat/env/curl）；不要执行破坏性命令。",
            parameters: {
              type: "object",
              properties: {
                id: { type: "string", description: "容器 id 或名称" },
                command: { type: "string", description: "要执行的命令（单条 shell 字符串）" },
                shell: { type: "string", description: "sh（默认）| bash | ash | zsh" },
                confirm: { type: "boolean", description: "危险动作确认：仅在用户明确同意后置 true" },
              },
              required: ["id", "command"],
            },
            async execute(_id: unknown, params: Record<string, unknown>) {
              const r = await performAction(liveCtx, {
                kind: "containers",
                action: "exec",
                id: String(params?.id || ""),
                command: String(params?.command || ""),
                shell: String(params?.shell || "sh"),
                confirm: params?.confirm === true,
              });
              return r.payload.ok ? ok(r.payload) : fail(r.payload);
            },
          },
        ];
      },
    },
  },
};
