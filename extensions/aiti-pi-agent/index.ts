/**
 * aiti-pi-agent — pi fork RPC spawn 后端（拆分后专一 pi；omp 见 aiti-omp-agent）。
 *
 * 每个会话 = 一个独立 `pi --mode rpc` 子进程，pi-web 是纯前端。引擎（线协议宿主 /
 * spec / CLI 解析）来自共享层 fork-rpc/（副本同步自 _shared/pi-fork-rpc）；
 * pi 语义在 pi-handle.ts（PiSpawnHandle）。本文件只做扩展接线：注册 pi 一个 provider。
 *
 *   spawn  order=20  "New pi subprocess (--mode rpc)"  （node 解释包内 SDK / PATH pi）
 *
 * spawn env（agent-spawn-env）/ 治理 env（external-governance）注入子进程——
 * AITI_BRIDGE_URL 自动进子进程，aiti MCP shim 在 pi 内连回本实例桥。
 */

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { PiSpawnHandle, PI_SPEC, type AgentStarterLike, type AttachedChildOptions } from "./pi-handle.ts";
import { capabilitiesFor } from "./fork-rpc/spec.ts";
import { resolveForkCli } from "./fork-rpc/cli-resolve.ts";
import { spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { createSessionRecycleApi } from "@aiti-ai/ext-shared/session-recycle";

interface SessionCapabilitiesLike extends Record<string, boolean> {}

let lastKeys: string[] = [];
/** 会话 recycle（D8，共享层 session-recycle.ts）：存量 PiSpawnHandle 升级到当前扩展代码。 */
let recycleApi: ReturnType<typeof createSessionRecycleApi> | null = null;

// ---- spawn-session marker (session-list "Pi" badge) ----
// Sessions driven by this backend are real pi session files (no agent/extId in the
// header), so the session list cannot tell them apart from host-native in-process
// sessions, while cc/qoder/zcode rows get agent badges from their placeholder files.
// Persist the ids this backend has spawned into stateDir and patch list rows via the
// sessionAnnotations slot with agent:"pi" — session-manager's agentBadge renders a
// "Pi" badge for it; native rows carry no agent field at all and stay unmarked.
interface SpawnIndex {
  version: 1;
  sessions: Record<string, { cwd?: string; startedAt: string }>;
}
let spawnStateDir: string | null = null;
let spawnIndex: SpawnIndex | null = null;

function loadSpawnIndex(): SpawnIndex {
  if (spawnIndex) return spawnIndex;
  let parsed: SpawnIndex | null = null;
  if (spawnStateDir) {
    try {
      parsed = JSON.parse(readFileSync(join(spawnStateDir, "spawn-sessions.json"), "utf8")) as SpawnIndex;
    } catch { /* missing or corrupt → fresh index */ }
  }
  spawnIndex = parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === "object"
    ? parsed
    : { version: 1, sessions: {} };
  return spawnIndex;
}

/** Record a session id this backend spawned (idempotent; best-effort persist). */
function recordSpawnSession(id: string, cwd?: string): void {
  if (!id) return;
  const idx = loadSpawnIndex();
  if (idx.sessions[id]) return;
  idx.sessions[id] = { ...(cwd ? { cwd } : {}), startedAt: new Date().toISOString() };
  if (spawnStateDir) {
    try {
      writeFileSync(join(spawnStateDir, "spawn-sessions.json"), JSON.stringify(idx));
    } catch { /* best-effort; in-memory marking still covers this process */ }
  }
}

/** Track a handle creation so the session list can badge it as pi. */
async function trackSpawnSession(pending: Promise<PiSpawnHandle>): Promise<PiSpawnHandle> {
  const handle = await pending;
  recordSpawnSession(handle.id, handle.cwd);
  return handle;
}

export default {
  id: "aiti-pi-agent",
  name: "Pi Spawn (子进程后端)",
  icon: "🚀",

  features: [spawnEnvFeature("Pi"), spawnCommandFeature("Pi"), spawnArgsPrefixFeature("Pi")],


  ui: {
    // English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
    i18n: {
      "zh-CN": {
        "ext.displayName": "pi 会话后端",
      },
      en: {
        "ext.displayName": "pi Session Backend",
      },
    },
  },

  server: {
    startup(ctx: {
      /** 跨扩展服务 slot（P2 协议委托；缺省=旧宿主降级）。 */
      services?: { provide<T>(key: string, impl: T): () => void };
      /** Persistent data area (state tier); hosts without it degrade to in-memory-only marking. */
      stateDir?: string;
      /** Session annotation slot: merge extension-owned fields into /api/sessions rows. */
      sessionAnnotations?: {
        register(annotator: {
          annotate(rows: Array<{ id: string; path?: string; cwd?: string }>): Promise<Record<string, Record<string, unknown>> | void>;
        }): unknown;
      };
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          order?: number;
          agentKey?: string;
          /** Opt-in: host the agent in a detachable wrapper (survives pi-web restarts). */
          detachable?: boolean;
          maxCapabilities: SessionCapabilitiesLike;
          createSession(options: {
            sessionId?: string;
            cwd?: string;
            model?: { provider: string; id: string };
            env?: Record<string, string>;
            /** Host-injected process strategy (pi-web core agent-starter). */
            agentStarter?: AgentStarterLike;
            /** Host recovery: adopt a live process instead of spawning (detached sessions). */
            attached?: AttachedChildOptions;
          }): Promise<PiSpawnHandle>;
        }): string;
      };
    }) {
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      const spec = PI_SPEC;
      spawnStateDir = ctx.stateDir ?? null;
      // Badge pi-rpc sessions in the session list (see the marker block above):
      // rows whose id was spawned by this backend get agent:"pi". Also overwrites
      // the "spawn" mislabel handle-store derives from source "aiti-pi-agent/spawn"
      // on live transient rows. Stale index entries never match a row and are harmless.
      ctx.sessionAnnotations?.register({
        annotate: async (rows) => {
          const idx = loadSpawnIndex();
          const patch: Record<string, Record<string, unknown>> = {};
          for (const row of rows) {
            if (row.id && idx.sessions[row.id]) patch[row.id] = { agent: "pi" };
          }
          return Object.keys(patch).length > 0 ? patch : undefined;
        },
      });
      lastKeys = [
        ctx.sessionProviders.register({
          type: "spawn",
          label: spec.label,
          order: spec.order,
          agentKey: spec.agentKey,
          // The core may host this backend's process in a detachable wrapper; the
          // handle adopts the live process on reattach (see PiSpawnHandle.attach).
          detachable: true,
          maxCapabilities: capabilitiesFor(spec),
          createSession: (options) =>
            // options.attached = the core reattached to a wrapper-hosted agent after
            // a restart; options.agentStarter = the injected process strategy
            // (Direct today, detachable when enabled). Both are optional so an
            // older host keeps working unchanged.
            options.attached
              ? trackSpawnSession(PiSpawnHandle.attach(options.attached, spec))
              : trackSpawnSession(PiSpawnHandle.start(options, spec)),
        }),
      ];
      // P2 协议委托：launch 服务（pi 单 fork；launch.target 恒忽略为 pi）
      ctx.services?.provide?.("aiti-pi-agent.launch", {
        agentKey: "pi",
        capabilities: capabilitiesFor(spec),
        members: [{ name: spec.id, agentKey: spec.agentKey ?? "pi", label: spec.label }],
        createSessionFromLaunch: (
          launch: LaunchOverride,
          options: { sessionId?: string; cwd?: string; env?: Record<string, string>; agentStarter?: AgentStarterLike },
        ) => {
          return trackSpawnSession(PiSpawnHandle.start({ ...options, launchOverride: launch }, spec));
        },
      });
      // A25-2：agent 账号契约描述符（管理面聚合；docs/pi-web-ext-agent-account-contract.md §1）
      ctx.services?.provide?.("aiti-pi-agent.agent", {
        agent: "pi",
        label: "Pi CLI",
        modes: ["apikey"],
        dependencyHint: "pi CLI（pi 0.84+；models.json 内 API key）",
        auth: [
          { kind: "file", path: [".pi", "agent", "auth.json"], label: "~/.pi/agent/auth.json" },
        ],
        accountSlots: (c: { home: string }) => [
          { key: "pi-auth", label: "pi agent 凭据（OAuth）", path: join(c.home, ".pi", "agent", "auth.json") },
        ],
      });
      recycleApi = createSessionRecycleApi({
        isOwn: (h) => (h as { spec?: { id?: unknown } }).spec?.id === "pi",
        parseId: (id) => ({
          // pi：记档 id 即 pi 会话 id（--session-id 绑定），可直接 resume。
          sessionId: id,
          providerType: "aiti-pi-agent/spawn",
        }),
      });
      const cli = resolveForkCli(spec);
      console.log(`[pi-spawn] registered: ${lastKeys.join(", ")} (${spec.id}: ${cli ? cli.origin : "未找到（createSession 时报安装指引）"})`);
    },

    /** 会话 recycle（/session/recycle）：存量 handle 升级到当前扩展代码（D8）。 */
    async api(req: Request, ctx: { path: string[]; method: string }) {
      return recycleApi ? await recycleApi(req, ctx) : null;
    },
  },
};