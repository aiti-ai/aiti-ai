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
import { PiSpawnHandle, PI_SPEC } from "./pi-handle.ts";
import { capabilitiesFor } from "./fork-rpc/spec.ts";
import { resolveForkCli } from "./fork-rpc/cli-resolve.ts";
import { spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { createSessionRecycleApi } from "@aiti-ai/ext-shared/session-recycle";

interface SessionCapabilitiesLike extends Record<string, boolean> {}

let lastKeys: string[] = [];
/** 会话 recycle（D8，共享层 session-recycle.ts）：存量 PiSpawnHandle 升级到当前扩展代码。 */
let recycleApi: ReturnType<typeof createSessionRecycleApi> | null = null;

export default {
  id: "aiti-pi-agent",
  name: "Pi Spawn (子进程后端)",
  version: "0.2.0",
  icon: "🚀",

  features: [spawnEnvFeature("Pi"), spawnCommandFeature("Pi"), spawnArgsPrefixFeature("Pi")],

  server: {
    startup(ctx: {
      /** 跨扩展服务 slot（P2 协议委托；缺省=旧宿主降级）。 */
      services?: { provide<T>(key: string, impl: T): () => void };
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          order?: number;
          agentKey?: string;
          maxCapabilities: SessionCapabilitiesLike;
          createSession(options: {
            sessionId?: string;
            cwd?: string;
            model?: { provider: string; id: string };
            env?: Record<string, string>;
          }): Promise<PiSpawnHandle>;
        }): string;
      };
    }) {
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      const spec = PI_SPEC;
      lastKeys = [
        ctx.sessionProviders.register({
          type: "spawn",
          label: spec.label,
          order: spec.order,
          agentKey: spec.agentKey,
          maxCapabilities: capabilitiesFor(spec),
          createSession: (options) => PiSpawnHandle.start(options, spec),
        }),
      ];
      // P2 协议委托：launch 服务（pi 单 fork；launch.target 恒忽略为 pi）
      ctx.services?.provide?.("aiti-pi-agent.launch", {
        agentKey: "pi",
        capabilities: capabilitiesFor(spec),
        members: [{ name: spec.id, agentKey: spec.agentKey ?? "pi", label: spec.label }],
        createSessionFromLaunch: (launch: LaunchOverride, options: { sessionId?: string; cwd?: string; env?: Record<string, string> }) => {
          return PiSpawnHandle.start({ ...options, launchOverride: launch }, spec);
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