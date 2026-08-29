/**
 * piweb-job-provider —— pi-web 启动类后端作为子代理执行器（external-job provider）。
 *
 * 把 pi-web 的全部启动类 agent（pi RPC / claude-code ACP / qoder ACP / …）暴露给
 * fork（@aiti-ai/pi-subagents）的 Agent 工具：agent md 声明
 *   runner: { type: external-job, provider: pi-web-rpc, options: { backend: <agentKey> } }
 * 委派即经本 provider 启动一个真正的 pi-web 会话——落盘、进会话列表、前端可打开
 * attach、可 steer/abort（会话级），完成后 fork 拿回最终输出。
 *
 * 统一执行路径：SessionHandle（prompt/abort/subscribe + isRunning 边沿判完成，
 * 无轮询）。backend=pi 走本地 rpc 会话（fork 空 session + startRpcSession，与
 * lib/subagent.ts createSubagentSession 同款落盘语义）；其余 backend 经 session
 * provider 注册表（findProvidersForAgent）路由到对应 ACP/桥后端。
 *
 * 边界（MVP）：
 *   - agent md 的 systemPrompt 等指令由 fork 组装进 prompt 全文（external-job 契约）；
 *   - fork 侧对 external-job 无 stop 通道——中止经前端打开会话后 abort；
 *   - followUp：steer capability 优先，缺省退化为排队 prompt。
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  findProvidersForAgent,
  createLocalHandle,
  createSessionHandle,
  type SessionHandle,
} from "@/lib/session";

/** provider 名（agent md runner.provider 必须与此一致）。 */
export const PIWEB_JOB_PROVIDER_NAME = "pi-web-rpc";

interface PiWebJob {
  id: string;
  backend: string;
  state: "queued" | "running" | "completed" | "failed" | "stopped";
  started: boolean;
  done: boolean;
  output?: string;
  error?: string;
  /** pi 后端：落盘会话文件（前端打开/attach 用）。 */
  sessionFile?: string;
  handle?: SessionHandle;
  created: number;
}

const jobs = new Map<string, PiWebJob>();
const MAX_JOBS = 200;

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const entries = [...jobs.entries()].sort((a, b) => a[1].created - b[1].created);
  while (entries.length > MAX_JOBS) {
    const [id] = entries.shift()!;
    if (jobs.get(id)?.done) jobs.delete(id);
  }
}

/** 最后一条 assistant 文本（getMessages capability 缺省时返回 undefined）。 */
async function lastAssistantText(handle: SessionHandle): Promise<string | undefined> {
  try {
    if (!handle.getMessages) return undefined;
    const messages = (await handle.getMessages()) as Array<Record<string, unknown>>;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      const content = m.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content
          .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : ""))
          .join("");
        if (text) return text;
      }
    }
  } catch { /* capability 不可用 → undefined */ }
  return undefined;
}

/** pi 后端：fork 空 session + rpc 会话 + local handle。 */
async function startPiBackend(cwd: string, parentSessionFile?: string): Promise<{ handle: SessionHandle; sessionFile: string }> {
  const sm = SessionManager.create(cwd, undefined, { id: randomUUID() });
  sm.newSession(parentSessionFile ? { parentSession: parentSessionFile } : undefined);
  try {
    (sm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
    (sm as unknown as { flushed?: boolean }).flushed = true;
  } catch { /* 惰性落盘也可 */ }
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) throw new Error("pi 后端启动失败：未生成 session 文件");
  const { startRpcSession } = await import("@/lib/rpc-manager");
  const { session: wrapper } = await startRpcSession(`__subagent__${randomUUID()}`, sessionFile, cwd, {});
  return { handle: createLocalHandle(wrapper), sessionFile };
}

/** 父 pi 会话 id（fork ExternalJobStartInput.sessionId）→ 会话文件路径（pi 后端
 *  parentSession 标记——Fleet 树把子代理归到父会话下）。反查失败返回空（无标记）。
 *  仅命中 rpc registry 的 live 会话；历史父会话走 resolveSessionPath。 */
async function parentFileOf(parentSessionId: string | undefined): Promise<string | undefined> {
  if (!parentSessionId) return undefined;
  try {
    const { getRpcSession } = await import("@/lib/rpc-manager");
    const wrapper = getRpcSession(parentSessionId);
    if (wrapper?.sessionFile) return wrapper.sessionFile;
  } catch { /* rpc 层不可用 */ }
  try {
    const { resolveSessionPath } = await import("@/lib/session-reader");
    return (await resolveSessionPath(parentSessionId)) ?? undefined;
  } catch { /* 无法反查 */ }
  return undefined;
}

/** agentKey → provider type（createSessionHandle 需要 providerType）。 */
function providerTypeFor(backend: string): string {
  const provider = findProvidersForAgent(backend)[0];
  if (!provider) throw new Error(`没有注册 backend="${backend}" 的 session provider（检查对应扩展是否安装/CLI 是否在 PATH）`);
  return provider.type;
}

/** 安装 provider（instrumentation 启动时调用；幂等）。 */
export function installPiWebJobProvider(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__piWebJobProviderInstalled) return;
  g.__piWebJobProviderInstalled = true;

  void (async () => {
    try {
      // jiti 直载 fork 包源码模块（Symbol.for 注册表跨模块副本共享——与 fork 扩展同store）
      const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
      const modPath = path.join(agentDir, "npm", "node_modules", "@aiti-ai", "pi-subagents", "src", "api", "external-job-provider.ts");
      if (!fs.existsSync(modPath)) {
        console.warn(`[piweb-job-provider] fork external-job-provider 不存在，跳过注册: ${modPath}`);
        return;
      }
      const { createJiti } = await import("jiti");
      const jiti = createJiti(import.meta.url);
      const mod = (await jiti.import(modPath)) as {
        registerExternalJobProvider: (provider: unknown) => unknown;
      };
      mod.registerExternalJobProvider({
        name: PIWEB_JOB_PROVIDER_NAME,

        start(input: { prompt: string; cwd: string; options?: { backend?: string }; sessionId?: string }) {
          const backend = String(input.options?.backend || "pi").trim() || "pi";
          const id = `pwj_${randomUUID()}`;
          const job: PiWebJob = { id, backend, state: "queued", started: false, done: false, created: Date.now() };
          jobs.set(id, job);
          pruneJobs();

          void (async () => {
            try {
              let handle: SessionHandle;
              if (backend === "pi") {
                const started = await startPiBackend(input.cwd || process.cwd(), await parentFileOf(input.sessionId));
                handle = started.handle;
                job.sessionFile = started.sessionFile; // 修复：此前从未赋值 → conversationUrl 死逻辑
              } else {
                handle = await createSessionHandle({
                  providerType: providerTypeFor(backend),
                  cwd: input.cwd || process.cwd(),
                });
              }
              job.handle = handle;
              // 非 pi 后端 handle 经统一包装入库（putHandle + session_backend_ready
              // 换绑监听——cursor/claude 的 chatId 在 init 帧才到手，换绑后
              // ?session=cursor:<chatId> 才能跨重启恢复）。
              // 完成判定：事件驱动的 isRunning 边沿（无轮询）
              handle.subscribe(() => {
                if (job.done || !job.started) return;
                if (!handle.isRunning()) void finalize(job, handle);
              });
              job.state = "running";
              job.started = true;
              await handle.prompt(input.prompt);
            } catch (e) {
              job.state = "failed";
              job.done = true;
              job.error = e instanceof Error ? e.message : String(e);
            }
          })();

          return { providerJobId: id, state: "queued" as const };
        },

        followUp(input: { parentProviderJobId: string; prompt?: string; requestId?: string }) {
          const job = jobs.get(input.parentProviderJobId);
          if (!job?.handle) return { providerJobId: input.parentProviderJobId, state: job?.state ?? "failed", failureCode: "unknown-job" };
          void (async () => {
            try {
              if (job.handle!.steer) await job.handle!.steer(input.prompt ?? "");
              else await job.handle!.prompt(input.prompt ?? "");
            } catch (e) {
              job.error = e instanceof Error ? e.message : String(e);
            }
          })();
          return { providerJobId: input.parentProviderJobId, state: job.done ? "completed" : "running" };
        },

        status: (providerJobId: string) => statusJob(providerJobId),

        result(providerJobId: string) {
          const job = jobs.get(providerJobId);
          if (!job) return { providerJobId, state: "failed" as const, failureCode: "unknown-job" };
          return {
            providerJobId,
            state: job.state,
            ...(job.output ? { output: job.output } : {}),
            ...(job.error ? { failureMessage: job.error } : {}),
            ...(job.sessionFile ? { conversationUrl: `pi-web-session:${job.sessionFile}` } : {}),
          };
        },

        reattach: (providerJobId: string) => statusJob(providerJobId),
      });
      console.log(`[piweb-job-provider] registered "${PIWEB_JOB_PROVIDER_NAME}" — pi-web backends available as subagent executors`);
    } catch (e) {
      console.warn("[piweb-job-provider] 注册失败（fork 未安装或加载错误）:", e instanceof Error ? e.message : e);
    }

  function statusJob(providerJobId: string) {
    const job = jobs.get(providerJobId);
    if (!job) return { providerJobId, state: "failed" as const, failureCode: "unknown-job", failureMessage: "job 不存在（进程重启后历史 job 不可查）" };
    if (!job.done && job.started && job.handle && !job.handle.isRunning()) {
      void finalize(job, job.handle); // 事件缺失时的保守收敛（fork 主动查询驱动，非轮询）
    }
    const state = job.done ? job.state : job.state === "queued" ? ("queued" as const) : ("running" as const);
    return { providerJobId, state, ...(job.error ? { failureMessage: job.error } : {}) };
  }
  })();
}

/** 完成：抓最后 assistant 输出 + 标记状态。 */
async function finalize(job: PiWebJob, handle: SessionHandle): Promise<void> {
  if (job.done) return;
  job.done = true;
  try {
    job.output = (await lastAssistantText(handle)) ?? "";
    job.state = "completed";
  } catch (e) {
    job.state = "failed";
    job.error = e instanceof Error ? e.message : String(e);
  }
}
