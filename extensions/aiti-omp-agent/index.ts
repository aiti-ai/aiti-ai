/**
 * aiti-omp-agent — omp（oh-my-pi）fork RPC spawn 后端（拆分自 aiti-pi-agent，专一 omp）。
 *
 * 每个会话 = 一个独立 `omp --mode rpc` 子进程（bun 解释）。omp 是 pi 的超集 fork：
 * ready 握手 / get_state（contextUsage·dumpTools·sessionId·sessionFile）/ get_messages /
 * branch / host tools（set_host_tools·host_tool_call）/ login（get_login_providers·login）。
 * 引擎（线协议宿主 / spec / CLI 解析）来自共享层 fork-rpc/；omp 语义在 omp-handle.ts。
 *
 *   omp-spawn  order=30  "Oh My Pi (omp.sh)"  （bun 解释 omp，未装时注册照常、
 *                                             createSession 报清晰安装指引）
 */

import { join } from "node:path";
import { OmpSpawnHandle, OMP_SPEC } from "./omp-handle.ts";
import { capabilitiesFor } from "./fork-rpc/spec.ts";
import { resolveForkCli } from "./fork-rpc/cli-resolve.ts";
import { spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import { hostToolsAllowFeature } from "@aiti-ai/ext-shared/host-tools-allow";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { createSessionRecycleApi } from "@aiti-ai/ext-shared/session-recycle";
import { wireBridgeHostTools } from "./host-tools-bridge.ts";

interface SessionCapabilitiesLike extends Record<string, boolean> {}

/** 会话 recycle（D8）：存量 OmpSpawnHandle 升级到当前扩展代码。
 *  ⚠ omp 无 --session-id，重建即新会话（记档 id 保留；仅 dispose 语义）。 */
let recycleApi: ReturnType<typeof createSessionRecycleApi> | null = null;
/** Provider object captured at startup — rescanBackends flips the availability
 *  snapshot in place (same identity keeps the wireB4Rebind/withHostTools closures)
 *  and re-registers it. */
let ompProviderRef: Record<string, unknown> | null = null;

export default {
  id: "aiti-omp-agent",
  name: "Oh My Pi (omp 子进程后端)",
  icon: "🦉",

  features: [spawnEnvFeature("Omp"), spawnCommandFeature("Omp"), spawnArgsPrefixFeature("Omp"), hostToolsAllowFeature("Omp")],

  server: {
    startup(ctx: {
      /** 跨扩展服务 slot（P2 协议委托；缺省=旧宿主降级）。 */
      services?: { provide<T>(key: string, impl: T): () => void };
      /** A03/B4：宿主 core（rebindSessionBackend 换绑通道；旧宿主缺席降级）。 */
      core?: { rebindSessionBackend?: (oldId: string, newId: string) => boolean };
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          order?: number;
          agentKey?: string;
          maxCapabilities: SessionCapabilitiesLike;
          available?: boolean;
          installHint?: string;
          createSession(options: {
            sessionId?: string;
            cwd?: string;
            model?: { provider: string; id: string };
            env?: Record<string, string>;
          }): Promise<OmpSpawnHandle>;
        }): string;
      };
    }) {
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获
      const spec = OMP_SPEC;
      // Availability probe (dropdown grey-out): snapshot flips on rescanBackends.
      const ompCli = resolveForkCli(spec);
      const ompReady = Boolean(ompCli);
      // P2 host tools：omp 会话 ready 后把桥的 aiti_* 工具注册为宿主工具（失败静默降级）。
      const withHostTools = (h: OmpSpawnHandle): OmpSpawnHandle => {
        if (h.spec.commands.hasHostTools) {
          void h.whenReady.then(() => wireBridgeHostTools(h)).catch(() => {});
        }
        return h;
      };
      // B4 换绑（docs/aiti-omp-agent-id-rebind-design.md）：omp 进程生成真实落盘 id，
      // get_state 读回（rpcSessionId）后为 handle 增挂别名键——recycle/resume 用真 id。
      // 时序约束：prompt 受理前的就绪窗口内完成；未读回/宿主不支持 → 维持占位语义（现状）。
      const wireB4Rebind = (
        hPromise: Promise<OmpSpawnHandle>,
        options: { sessionId?: string },
      ): Promise<OmpSpawnHandle> => {
        void (async () => {
          try {
            const handle = await hPromise;
            if (!ctx.core?.rebindSessionBackend) {
              console.log("[aiti-omp-agent] B4 rebind skipped：宿主 core 无 rebindSessionBackend（旧宿主）");
              return;
            }
            for (let i = 0; i < 40 && !handle.rpcSessionId; i++) {
              await new Promise((r) => setTimeout(r, 500));
            }
            const recordId = (options.sessionId ?? "").trim() || handle.id; // 宿主未下传时 = 适配器自生成的记档 id
            const realId = handle.rpcSessionId;
            if (!recordId || !realId || realId === recordId) {
              console.log(`[aiti-omp-agent] B4 rebind skip：record=${recordId ? "有" : "无"} real=${realId ? "有" : "无"}`);
              return;
            }
            const ok = ctx.core.rebindSessionBackend(recordId, realId);
            console.log(`[aiti-omp-agent] B4 rebind ${recordId.slice(0, 8)}… → ${realId.slice(0, 8)}…: ${ok}`);
            if (ok) {
              try { (globalThis as any).__piPageEvents?.publish("aiti-omp-agent:rebind", { from: recordId, to: realId }); } catch { /* 总线缺席：draft 行自然过期 */ }
            }
          } catch (e: any) {
            console.log("[aiti-omp-agent] B4 rebind error:", String(e?.message ?? e).slice(0, 120));
          }
        })();
        return hPromise;
      };
      // provider 对象存模块级 ref：rescanBackends 原地翻转 available 快照后重新 register
      //（同对象身份 → wireB4Rebind/withHostTools 闭包保持）
      const ompProvider = {
        type: `${spec.id}-spawn`,
        label: spec.label,
        order: spec.order,
        agentKey: spec.agentKey,
        maxCapabilities: capabilitiesFor(spec),
        // Availability snapshot: false = CLI missing → dropdown entry greyed out
        ...(ompReady ? {} : { available: false as const, installHint: "bun install -g @oh-my-pi/pi-coding-agent (bun ≥ 1.3.14, or OMP_CLI env)" }),
        createSession: (options) => wireB4Rebind(OmpSpawnHandle.start(options, spec).then(withHostTools), options),
      };
      ompProviderRef = ompProvider;
      ctx.sessionProviders.register(ompProvider);
      // P2 协议委托：launch 服务（omp 单 fork）。
      ctx.services?.provide?.("aiti-omp-agent.launch", {
        agentKey: "omp",
        capabilities: capabilitiesFor(spec),
        members: [{ name: spec.id, label: spec.label }],
        createSessionFromLaunch: (launch: LaunchOverride, options: { sessionId?: string; cwd?: string; env?: Record<string, string> }) => {
          return wireB4Rebind(OmpSpawnHandle.start({ ...options, launchOverride: launch }, spec).then(withHostTools), options);
        },
      });
      const cli = resolveForkCli(spec);
      console.log(`[omp-spawn] registered: ${spec.id}-spawn (${spec.id}: ${cli ? cli.origin : "未找到——条目灰显 + 安装提示，rescan 可重查"})`);
    },

    /** Backend rescan (POST /api/session-backends/rescan): re-run the availability
     *  probe — a CLI installed after host boot lights up without a restart; missing
     *  stays greyed out with the install hint. Flips the snapshot on the startup
     *  provider object (same closures) and re-registers it. */
    rescanBackends(ctx: { sessionProviders: { register(provider: unknown): string } }) {
      if (!ompProviderRef) return;
      const cli = resolveForkCli(OMP_SPEC);
      const ready = Boolean(cli);
      const p = ompProviderRef as { available?: boolean; installHint?: string };
      if (ready) {
        delete p.available;
        delete p.installHint;
      } else {
        p.available = false;
        p.installHint = "bun install -g @oh-my-pi/pi-coding-agent (bun ≥ 1.3.14, or OMP_CLI env)";
      }
      const key = (ctx.sessionProviders as { register(provider: unknown): string }).register(ompProviderRef);
      console.log(`[omp-spawn] rescan: ${ready ? "available" : "not installed"} (${key})`);
      return ready ? { registered: [key] } : { unavailable: [key] };
    },

    /** 会话 recycle（/session/recycle）：存量 handle 升级到当前扩展代码（D8）。 */
    async api(req: Request, ctx: { path: string[]; method: string }) {
      return recycleApi ? await recycleApi(req, ctx) : null;
    },
  },
};