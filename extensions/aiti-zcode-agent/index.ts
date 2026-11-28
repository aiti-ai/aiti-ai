/**
 * aiti-zcode-agent — session backend extension driven by Zhipu ZCode (CLI runtime embedded in the desktop app).
 *
 * Protocol: `node zcode.cjs --json --mode build [--resume sess_xxx] --prompt <text>`
 *   (verified on runtime 0.16.5: --json prints a single pretty JSON object, fully at exit 0)
 *   → { sessionId, traceId, turnId, response, usage{inputTokens,...}, projection{contextWindow} }
 *
 * Process model: one single-shot process per turn (same exec mode as aiti-codex-agent); continuation via --resume.
 * Same lazy persistence as CC print mode: sess_xxx is only known after the first turn, rebind via session_backend_ready.
 *
 * Auth: official env injection channel (ZCODE_MODEL/ZCODE_BASE_URL/ZCODE_API_KEY, no config.json writes);
 *       the key is silently exchanged from the desktop credentials (same path as official login, idempotent); see zcode-core.ts comments.
 *
 * Compliance: coding-plan quota is restricted to the official tool whitelist (Claude Code/Codex/ZCode/...);
 * driving the official CLI itself = compliant plan usage; all HTTP calls are made by the official CLI, no risk-control surface.
 *
 * Research notes: docs/zcode-desktop-cli-agent-analysis.md
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { governanceEnv } from "./external-governance.ts";
import { agentSpawnEnv, spawnEnvFeature, spawnDisplayEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, captureSpawnEnvFeatures, spawnFeatureI18nEn } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
// Queue shared implementation layer (authoritative source pi-web-ext/_shared/backend-queue.ts; copy deployed with the extension — changes must be synced both ways)
import { createBackendQueueSupport, createQueueFilePersistence, migrateQueueSidecar } from "@aiti-ai/ext-shared/backend-queue";

/** Queue crash-recovery sidecar root (captured at startup as <stateDir>; undefined/empty = no persistence). */
let queueStateDir: string | undefined;
/** Task-list snapshot root (<stateDir>/task-lists/<zcodeSid>.json; fallback data source for dormant-session panels, §7.5). */
let taskListDir: string | undefined;
import {
  readExtModelState, readAgentLastUsedModel, renameExtModelState, writeExtModelState,
  withCurrentFirst, type ExtModelEntry,
} from "@aiti-ai/ext-shared/ext-model-state";
import { AppServerSession, type TaskEntry, type TurnOutcome, type TurnUsageSnapshot, type ZcodeAgentStarterLike } from "./zcode-appserver.ts";
import {
  DEFAULT_MODEL_REF, START_PLAN_BASE_URL, ZCODE_CONTEXT_WINDOW, ZCODE_MODES, ZCODE_PLATFORM_BASE_URL,
  baseUrlFor, backendUsageFromQuotaView, buildCliArgs, buildTurnEnv, buildZcodeCatalogRefs, channelFamily, detectPlanProvider, ensureCredential, ensureStartPlanCredential, execZcodeTurn, fetchCodingPlanQuotaLimit, fetchCaptchaConfig,
  extractCliError, isChannelDriveable, parseModelRef, parseTurnOutput, QUOTA_LIMIT_URL, quotaLimitToQuotaView, readProviderConfigApiKey, resolveNodeBin, resolveRuntime,
  isStartPlanChannel, planQuotaView, readPlanStatus, usageToReport, wireProviderId, writeProviderConfigFile, zcodeHome, zcodeLoginDriver, humanizeZcodeError,
} from "./zcode-core.ts";
// Cold-recovery tool-row replay shared helper (authoritative source pi-web-ext/_shared/seed-tool.ts; D18 unified across the four backends)
import { createSeedToolReplay } from "@aiti-ai/ext-shared/seed-tool";

// Controlled-login shared layer (authoritative source pi-web-ext/_shared/controlled-login.mjs; copy deployed with the extension — changes must be synced both ways)
import { createControlledLogin, mountControlledLoginApi } from "@aiti-ai/ext-shared/controlled-login";

// ============================================================================
// Structured contracts (out-of-tree)
// ============================================================================

type Listener = (event: Record<string, unknown>) => void;
interface SessionCapabilitiesLike extends Record<string, boolean> {}

/** Read-only probe of the zcode session store (WAL-safe for concurrent reads; same contract as the session-manager zcode adapter).
 *  Returns the session's time_updated (epoch ms) as the "external write watermark"; missing db / write lock / read failure → null
 *  (the caller skips the sync, keeps the status quo, retries next turn). */
function readZcodeSessionUpdatedMs(sid: string): number | null {
  try {
    const dbPath = join(zcodeHome(), "cli", "db", "db.sqlite");
    if (!existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const row = db.prepare("SELECT time_updated FROM session WHERE id = ?").get(sid) as { time_updated?: number } | undefined;
      return typeof row?.time_updated === "number" && row.time_updated > 0 ? row.time_updated : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Model catalog (shared by registration-level static listing and handle instances): the CLI only accepts refs from its own
 * provider table, not pi's catalog. Dynamic discovery (nothing hard-coded): channels/models come from the desktop
 * v2/config.json registry + coding-plan-cache.json available entries (buildZcodeCatalogRefs; static seed is a fallback only).
 * Channel-level availability is decided in buildZcodeCatalogRefs (isChannelDriveable, 2026-09-15: plan channels must be
 * available themselves); here we additionally filter by the authenticated plan family (detectPlanProvider; all listed when
 * apiKeyOverride exists or detection fails) — preventing users from switching to models on credential-less channels
 * (observed: picking zai/Flash while zai is logged out → per-turn human-readable credential errors).
 * The start-plan (ZCode plan) channel is no longer excluded from the catalog: listed as usual with an "unsupported yet" hint
 * (buildZcodeCatalogRefs label), intercepted with plain-language messages at select/create/send (captcha can only be produced
 * by the desktop GUI; pi-web cannot drive it; see START_PLAN_UNSUPPORTED).
 * The currently selected model is kept even across channels (the selector must show the actual state).
 */
function zcodeCatalog(current?: { id: string; provider: string }): ExtModelEntry[] {
  const planFamily = detectPlanProvider();
  const override = featureApiKeyOverride();
  let builtin: ExtModelEntry[] = buildZcodeCatalogRefs().map((m) => ({ id: m.id, label: m.label, provider: "zcode", source: "ext" as const }));
  if (!override && planFamily) {
    builtin = builtin.filter((m) => channelFamily(m.id.split("/")[0]) === planFamily);
  }
  // Hit in the catalog → move to front and keep the catalog label; not in the catalog (old plan refs, restored start-plan
  // sessions, etc.) → synthesized entry also carries a readable label (`modelId (channel)`, same format as the catalog)
  // plus an "unsupported yet" hint — avoiding bare-ref rows in the selector (2026-09-14).
  const cur = current?.id
    ? {
        ...current,
        label: refDisplayLabel(current.id) + (isStartPlanChannel(current.id.split("/")[0]) ? " · 暂不支持" : ""),
      }
    : undefined;
  return withCurrentFirst(builtin, cur);
}

/** ref → display label (`channel/modelId` → `modelId (channel)`, same format as the catalog; returned as-is when there is no slash). */
function refDisplayLabel(ref: string): string {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return ref;
  return `${ref.slice(i + 1)} (${ref.slice(0, i)})`;
}

/**
 * This agent's last-used model (the selected entry with the newest mtime in state files; with channel validity checks) —
 * the default source when a new session doesn't specify a model (per-agent last used, aligned with pi's defaultModel semantics).
 * Same validation as createSession (channelUsable): start-plan never drives + plan channels must be available themselves
 * (2026-09-15 channel-level tightening) + no cross into unauthenticated families — a previously used dead channel is no longer the default.
 */
async function lastUsedModelRef(): Promise<{ id: string; provider: string } | undefined> {
  const last = await readAgentLastUsedModel("zcode");
  if (!last?.id || !parseModelRef(last.id)) return undefined;
  if (!channelUsable(last.id.split("/")[0])) return undefined;
  return { id: last.id, provider: "zcode" };
}

/** Abort watchdog: grace period before force-kill when session/stop was sent but the turn hasn't settled (zcode-side stop is a no-op on a hung turn).
 *  Counted from the abort() entry (no longer stacking the session/stop RPC wait) — total settling bound = this duration. */
const ZCODE_ABORT_WATCHDOG_MS = 6_000;

const ZCODE_CAPABILITIES_BASE: SessionCapabilitiesLike = {
  // Native steer (same as desktop): while running, v4/command sendText{requestedDelivery:"guide"} injects into the current turn,
  // the runtime drains it at the next model/tool gap (dequeued via turn.steerDrained) + the model answers within the same turn (verified on a real device 2026-09-10).
  // ⚠ Must go through the v4 gateway — v1 session/send on the running path was observed to only enter the deferred queue and never deliver (black hole, see analysis §7.6).
  // The oneshot channel has no v4 surface → failed injection automatically degrades to the local followUp queue (R9).
  steer: true,
  followUp: true, // one new process per turn + --resume, naturally sequential semantics
  contextUsage: true, // real usage from turn.completed (totalTokens/input first) + ZCODE_CONTEXT_WINDOW (1M); estimated tokenCount is a fallback only
  setModel: true, // app-server: session/setModel takes effect immediately; oneshot: ZCODE_MODEL of the next spawned turn
  setThinkingLevel: false,
  renameSession: false,
  compact: false,
  executeBash: false,
  listTools: false, // built-in tool set is fixed
  setActiveTools: false,
  navigateTree: false, // zcode has no session tree — "edit from here" uses fork semantics (see zcodeCapabilities fork note)
  deleteSession: false,
  getCommands: false, // readable via `zcode.cjs commands list`, P2
  respondPermission: false, // app-server reverse requests are auto-approved (backend semantics); bidirectional permission UI bridging is future work
  getUsage: true,
  listModels: true,
  fileAttachments: true, // images → v4 attachment begin/chunk/commit upload + session/send attachments (same as the desktop app-server, 2026-09-17)
  getMessages: true,
  setPermissionMode: true, // app-server: session/setMode takes effect immediately (same as desktop); oneshot: --mode of the next spawned turn
  queueManage: true, // queue keeper adapter: full CRUD on the local followUp queue + read-only steer mirror (see queueManage)
  respondInteraction: true, // interaction primitive bridging: zcode ExitPlanMode/AskUserQuestion reverse requests → frontend approval/question cards (the oneshot channel has no reverse-request surface; degrades at runtime)
  respondProviderHeaders: true, // start-plan captcha bridge: provider_runtime_headers_request → frontend AliyunCaptcha SDK → respond_provider_headers
};

/**
 * Fork capability is decided per channel: the session/fork protocol surface is only available on the long-lived app-server
 * connection (oneshot spawns a single-shot process per turn; forked child sessions can't continue). fork=true lights up two
 * frontend features at once — the message "branch" button (fork a new session without rebinding) and "edit from here"
 * (fork + handle rebind, continue in place, reset semantics).
 * The server-side restriction "no fork while running" is surfaced as-is as a message (capability kept, timing limited), never silent.
 */
function zcodeCapabilities(): SessionCapabilitiesLike {
  return featureTransport() === "app-server" ? { ...ZCODE_CAPABILITIES_BASE, fork: true } : ZCODE_CAPABILITIES_BASE;
}

// ============================================================================
// feature reads (extman feature management) — DI plan P1: ctx.features first, direct __piWebExt access as fallback
// ============================================================================

let hostFeatures: any = null; // ctx.features captured at startup
let hostSvc: any = null; // ctx.services captured at startup (consumed for session-manager.sessions)
type FeatureRegistry = { featureValue?: (extId: string, fid: string) => boolean | string };
function featureRegistry(): FeatureRegistry | undefined {
  return (globalThis as Record<string, unknown>).__piWebExt as FeatureRegistry | undefined;
}
function featureString(fid: string): string {
  const v = hostFeatures?.get?.("aiti-zcode-agent", fid);
  if (typeof v === "string") return v;
  const reg = featureRegistry();
  const v2 = reg?.featureValue ? reg.featureValue("aiti-zcode-agent", fid) : "";
  return typeof v2 === "string" ? v2 : "";
}
function featureBool(fid: string, fallback: boolean): boolean {
  const v0 = hostFeatures?.get?.("aiti-zcode-agent", fid);
  if (typeof v0 === "boolean") return v0;
  if (v0 === "true") return true;
  if (v0 === "false") return false;
  const reg = featureRegistry();
  const v = reg?.featureValue ? reg.featureValue("aiti-zcode-agent", fid) : fallback;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function featureRuntimePath(): string | undefined {
  const v = featureString("zcode.runtimePath").trim();
  return v || undefined;
}
function featureAutoDownload(): boolean {
  return featureBool("zcode.autoDownload", true);
}
function featureMode(): string | undefined {
  const v = featureString("zcode.mode").trim();
  return v || undefined;
}
function featureApiKeyOverride(): string | undefined {
  const v = featureString("zcode.apiKeyOverride").trim();
  return v || undefined;
}

/** Plain-language message for the undrivable start-plan (ZCode plan) channel (shared by the select/create/send intercepts). */
const START_PLAN_UNSUPPORTED =
  "ZCode 套餐通道（start-plan）需要阿里云验证码验证，验证码只能由 ZCode 桌面端产生，pi-web 暂不支持。请改用 bigmodel/zai 通道模型（如 GLM-5.3），或到 ZCode 桌面端继续使用该套餐。";

/** Intercept message for known start-plan sessions (revived via All Sessions / pre-existing sessions) — explicitly tells the user the session was loaded via start-plan. */
const START_PLAN_UNSUPPORTED_KNOWN =
  "该会话是由 start-plan（ZCode 套餐）通道加载的已知会话：套餐通道需要阿里云验证码验证，验证码只能由 ZCode 桌面端产生，pi-web 暂不支持驱动。请先在模型选择器中切换到 bigmodel/zai 通道模型（如 GLM-5.3）后继续，或到 ZCode 桌面端使用该套餐。";

/**
 * Channel drivability check (shared by createSession seeding/restoration and lastUsedModelRef):
 * start-plan never drives; apiKeyOverride passes through; the rest use the channel-level verdict from the plan cache
 * (isChannelDriveable: plan channels must be available themselves — tightened 2026-09-15; family-level blanket approval
 * would seed dead channels that 429/1113 on every turn once selected); falls back to the old family match when detection has no data.
 */
function channelUsable(providerId: string): boolean {
  if (isStartPlanChannel(providerId)) return false;
  if (featureApiKeyOverride()) return true;
  const driveable = isChannelDriveable(providerId);
  if (driveable !== null) return driveable;
  const plan = detectPlanProvider();
  return plan === null || channelFamily(providerId) === plan;
}

/** Transport channel: app-server (default, long-lived streaming same as desktop) | oneshot (single-shot process per turn, fallback). */
function featureTransport(): "app-server" | "oneshot" {
  const v = featureString("zcode.transport").trim();
  return v === "oneshot" ? "oneshot" : "app-server";
}

/**
 * Spawn env (shared mechanism, _shared/agent-spawn-env.ts): governance whitelist + automatic AITI_BRIDGE_URL
 * (the pi-web's own instance, inherited by zcode's MCP shim subprocess → automatically connects to the bridge of
 * the instance that spawned it) + the extman spawn.env user list (KEY=VALUE / -NAME exclusion / $VAR reference, can override automatic values).
 */
function zcodeSpawnEnv(): Record<string, string> {
	return agentSpawnEnv({
		cli: "zcode",
		governance: governanceEnv,
		extId: "aiti-zcode-agent",
		envList: featureString("spawn.env"),
		warn: (m) => console.log(`[aiti-zcode-agent] ${m}`),
	});
}

/** Default model ref for new sessions: explicit feature config > plan channel detection (coding-plan-cache, lightweight plaintext) > bigmodel default. */
function seedModelRef(): string {
  const configured = featureString("zcode.model").trim();
  if (configured && parseModelRef(configured)) return configured;
  const plan = detectPlanProvider();
  const providerId = plan ?? DEFAULT_MODEL_REF.split("/")[0];
  const modelId = DEFAULT_MODEL_REF.split("/")[1];
  return `${providerId}/${modelId}`;
}

// ============================================================================
// Task-list snapshots (dormant-session fallback: get_state only has tasks for live handles; when a
// historical session is opened after the handle was GC'd while idle / after a process restart, the
// core state router reads here via the sessionDormantState service.
// docs/aiti-zcode-agent-task-list-plan.md §7.5)
// ============================================================================

/** zcode session id whitelist (anti path traversal: file names allow only sess_ + safe characters). */
const TASK_SNAPSHOT_SID_RE = /^sess_[A-Za-z0-9._-]+$/;

function taskSnapshotPath(sid: string): string | undefined {
  if (!taskListDir || !TASK_SNAPSHOT_SID_RE.test(sid)) return undefined;
  return join(taskListDir, `${sid}.json`);
}

/** Task-list snapshot persistence (full overwrite on every task_update; atomic write = tmp + rename, Windows compat §0). */
function persistTaskSnapshot(sid: string, todos: TaskEntry[]): void {
  const fp = taskSnapshotPath(sid);
  if (!fp) return;
  try {
    mkdirSync(taskListDir!, { recursive: true });
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sid, todos, updatedAt: Date.now() }));
    renameSync(tmp, fp);
  } catch (e) {
    console.warn("[aiti-zcode-agent] 任务快照落盘失败（不影响实时链路）:", e instanceof Error ? e.message : e);
  }
}

/** Composite session id → zcode sid (accepts only the zcode: prefix / bare sess_; returns null for new-* not yet persisted). */
function zcodeSidOf(compositeId: string): string | null {
  if (typeof compositeId !== "string") return null;
  const raw = compositeId.startsWith("zcode:") ? compositeId.slice("zcode:".length) : compositeId;
  return TASK_SNAPSHOT_SID_RE.test(raw) ? raw : null;
}

/**
 * sessionDormantState service implementation (consumed by the core state router's dormant branch): latest task snapshot of a dormant session.
 * The reply field matches AgentStateResponse.wire = `{tasks}` (distinct from the handle contract taskList()'s `{todos}`);
 * no data / not this extension's session → null (the core keeps scanning the next provider).
 */
async function readTaskSnapshot(compositeId: string): Promise<{ tasks: TaskEntry[] } | null> {
  const todos = await readTaskSnapshotTodos(compositeId);
  return todos ? { tasks: todos } : null;
}

/** Snapshot read (id accepts composite/bare sid; missing file / corrupted → null). */
async function readTaskSnapshotTodos(compositeId: string): Promise<TaskEntry[] | null> {
  const sid = zcodeSidOf(compositeId);
  const fp = sid ? taskSnapshotPath(sid) : undefined;
  if (!fp || !existsSync(fp)) return null;
  try {
    const data = JSON.parse(readFileSync(fp, "utf8")) as { todos?: TaskEntry[] };
    return Array.isArray(data.todos) ? data.todos : null;
  } catch {
    return null;
  }
}

// ============================================================================
// ZcodeHandle — single-shot process × turn model
// ============================================================================

interface TurnImage { data: string; mimeType: string; filename?: string }

class ZcodeHandle {
  readonly source = "aiti-zcode-agent/zcode";
  /** Fork decided per channel (getter: feature reads are only available after startup capture, and read live each time). */
  get capabilities(): SessionCapabilitiesLike {
    return zcodeCapabilities();
  }
  /** Session working directory; the All Sessions revival path aligns it with the directory in the zcode session store (upsert/resume workspace consistency depends on this value). */
  cwd: string;
  id: string;

  private listeners = new Set<Listener>();
  private aliveFlag = true;
  private running = false;
  /** Real zcode session id (sess_xxx; known only after the first turn → rebind). */
  private sessId: string | undefined;
  private lastUsage: Record<string, unknown> | undefined;
  private lastContextTokens: number | null = null;
  /** Current model (public: assigned externally by createSession seeding/state restoration; id = "bigmodel/GLM-5.3" ref). */
  model: { id: string; provider: string } | undefined;
  /** Current turn's child process (used by abort). */
  private child: ChildProcess | null = null;
  /** Current turn's cancellation source (abort during runtime resolution/download; recreated each turn). */
  private turnAbort = new AbortController();
  /**
   * Queue support (shared layer docs/backend-queue-manager-plan.md §3): local followUp queue (with images,
   * R4 closed loop) + steer mirror + all queueManage actions + automatic next-turn after settle + steer failure degradation (R9).
   * The dispatch closure calls back into prompt() with full bookkeeping (liveHistory/running/runTurn/scheduleDrain);
   * the steer closure injects through the v4 gateway, same as desktop (throws on failure → the shared layer degrades to queueing);
   * oneshot has no steer → everything queues while running (visible and recallable in the panel). */
  private q = createBackendQueueSupport({
    isRunning: () => this.isRunning() || !this.aliveFlag,
    alive: () => this.aliveFlag,
    dispatch: (text, images) => this.prompt(text, { images }),
    steer: (text) => this.steerViaAppServer(text),
    onEvent: (ev) => this.emit(ev),
    log: (m) => console.warn(m),
    // Queue crash-recovery sidecar (docs/aiti-remote-queue-and-sidecar-plan.md §3)
    persistence: createQueueFilePersistence(() => (queueStateDir ? join(queueStateDir, "queues", `${this.id}.json`) : undefined), (m) => console.warn(m)),
  });
  /** Steer mirror id tracking (used to diff the onSteerQueue full snapshot for dequeue; the input itself lives in the shared-layer mirror). */
  private lastSteerIds: string[] = [];
  /** Desired mode for setPermissionMode (--mode of each spawned turn; takes effect next turn). */
  private desiredMode: string | undefined;

  private liveHistory: unknown[] = [];
  /** Last "source backfill" watermark of liveHistory (zcode session.time_updated; 0 = not anchored).
   *  When the watermark advances due to external writes (zcode desktop/CLI writing the same session from another process), getMessages re-reads and rebuilds from the source first. */
  private historySeedRevMs = 0;
  /** External-sync single-flight lock (concurrent getMessages don't parse repeatedly). */
  private historySyncInflight: Promise<void> | null = null;
  /** Last activity timestamp (epoch ms): /api/sessions uses it to fix the frozen modified of sidebar placeholder rows. */
  private lastActivityTs: number | null = null;

  private configDir: string;
  /** Long-lived app-server session (lazily created when feature zcode.transport=app-server; reused across turns). */
  private as: AppServerSession | null = null;
  /** Detachable-hosting strategy injected by the host (agent-starter wrapper; absent = plain spawn). */
  private agentStarter: ZcodeAgentStarterLike | undefined;
  /** Live process handed over by the core recovery path (wrapper-hosted, reattached after a pi-web restart); absent = not adopted. */
  private attachedChild: ChildProcess | undefined;
  /** Journal replay bytes of the adopted process (SocketChild.replayBytes; 0 = no replay). */
  private attachedReplayBytes = 0;
  /** P2 protocol delegation: member-level launch wrapper (custom-agent path), takes precedence over extman spawn.* features. */
  launchOverride: LaunchOverride | undefined;
  /** Mirror of steer inputs already handed to the zcode server (read-only: the protocol has no recall entry; steerQueued in / steerDrained out). */
  private steerMirror: Array<{ pendingInputId: string; input: string }> = [];
  /** Task-list snapshot (maintained by the onTaskList callback; used by the taskList() contract outlet. ⚠ Deliberately named taskListMirror to avoid clobbering the same-named method). */
  private taskListMirror: TaskEntry[] = [];
  /** start-plan captcha: reverse requests pending frontend solving (requestId → resolver; the appserver layer also has a 180s timeout fallback). */
  private providerHeadersPending = new Map<string, (answer: { ok: true; captchaVerifyParam: string; region?: string } | { ok: false; errorMessage: string }) => void>();
  /** captchaVerifyParam cache (providerId → param; TTL 5min — a subsequent 3007 triggers captcha-retry to rerun the SDK). */
  private providerHeadersCache = new Map<string, { param: string; region?: string; at: number }>();
  /** Captcha SDK triple cache (fetched from client/configs; TTL 1h). */
  private captchaConfigCache: { config: { sceneId: string; prefix: string; region: string }; at: number } | null = null;
  /** Abort settling watchdog timer (app-server channel; force-kills as a fallback when session/stop doesn't settle within the time limit). */
  private abortWatchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, cwd: string, configDir: string) {
    this.id = id;
    this.cwd = cwd;
    this.configDir = configDir;
  }

  /** Test/recovery path: set the real sess id directly (All Sessions history-row revival). */
  setKnownSessionId(sid: string): void {
    this.sessId = sid;
  }

  /** Detachable hosting: host-injected wrapper strategy (passed through from createSession options.agentStarter). */
  setAgentStarter(starter: ZcodeAgentStarterLike | undefined): void {
    this.agentStarter = starter;
  }

  /** Adopt path: register the live process + journal replay budget handed over by the core (consumed by ensureAppServer). */
  setAttachedProcess(child: ChildProcess, replayBytes: number): void {
    this.attachedChild = child;
    this.attachedReplayBytes = replayBytes;
  }

  /** Adoption warm-up: wire the live process + consume the journal replay right away (running state/settling must not wait for the user to open the session). */
  async reattachNow(): Promise<void> {
    await this.ensureAppServer();
  }

  /**
   * Anchor the external-sync watermark at seed time (adopt/restore paths).
   * Without this the first idle getMessages anchors at the CURRENT rev — which is
   * already past the events suppressed by the adopt replay gate — and the window
   * between the db seed and the replay boundary would never reconcile into
   * liveHistory. Anchoring at seed time makes the next idle sync see rev > anchor
   * and rebuild from the store (the authoritative zcode db), healing that window.
   */
  anchorHistoryAtSourceRev(): void {
    if (!this.sessId) return;
    const rev = readZcodeSessionUpdatedMs(this.sessId);
    if (rev !== null) this.historySeedRevMs = rev;
  }

  /**
   * History backfill (landing point read by the All Sessions service outlet): IndexedMessage[] → liveHistory shape.
   * Structured tool rows (IndexedMessage.tool, carried by the opencode family) → native pi shape:
   *   assistant.toolCall blocks + toolResult messages (paired by toolCallId) — the frontend MessageView /
   *   ToolCallBlock renders them as pi's own tool cards (tool name/input preview/collapsed output), no longer degrading to 🛠 {json} text;
   *   parse failures fall back to 🛠 text lines (context handoff fallback, consistent with session-manager import semantics).
   * images → content image blocks (rendered natively by the frontend MessageView);
   * assistant messages carry model/provider — modelID/providerID passed through verbatim from the source store (no normalization, no rewriting);
   * model label rendering on messages depends on these two fields.
   */
  seedHistory(messages: Array<{ role?: unknown; text?: unknown; model?: unknown; provider?: unknown; images?: Array<{ mime?: unknown; dataUrl?: unknown }> | unknown[]; tool?: unknown }>): void {
    const replay = createSeedToolReplay("zcode-tool");
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      // Structured tool rows take priority (a stable id is synthesized when callID is absent, only for frontend result pairing)
      const tool = role === "assistant"
        ? replay.entries(m.tool, {
          model: typeof m.model === "string" && m.model ? m.model : undefined,
          provider: typeof m.provider === "string" && m.provider ? m.provider : undefined,
        })
        : null;
      if (tool) {
        this.liveHistory.push(...tool);
        continue;
      }
      const text = typeof m.text === "string" ? m.text : "";
      const images = Array.isArray(m.images) ? m.images : [];
      if (!text.trim() && images.length === 0) continue;
      const content: Array<Record<string, unknown>> = [];
      if (text.trim()) content.push({ type: "text", text });
      for (const img of images) {
        const dataUrl = typeof img.dataUrl === "string" ? img.dataUrl : "";
        const mMatch = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
        if (!mMatch) continue;
        content.push({ type: "image", source: { type: "base64", media_type: mMatch[1], data: mMatch[2] } });
      }
      // Message-level model label (assistant only; model/provider passed through verbatim from the source store fields, no normalization or rewriting)
      const model = role === "assistant" && typeof m.model === "string" ? m.model : undefined;
      const provider = role === "assistant" && typeof m.provider === "string" ? m.provider : undefined;
      this.liveHistory.push({
        role,
        content,
        ...(model ? { model, ...(provider ? { provider } : {}) } : {}),
      });
    }
  }

  private emit(event: Record<string, unknown>): void {
    // User-visible activity (message finalized/delta/turn settled) → record activity time; control events (queue_update etc.) don't update it.
    if (event.type === "message_end" || event.type === "message_update" || event.type === "agent_end" || event.type === "agent_settled") {
      this.lastActivityTs = Date.now();
    }
    // Turn settled → clear pending captcha requests (the expire frame lets all clients clear their cards; the appserver layer's 180s timeout resolves as a fallback)
    if (event.type === "agent_settled" && this.providerHeadersPending.size > 0) {
      for (const [requestId, resolve] of this.providerHeadersPending) {
        resolve({ ok: false, errorMessage: "轮次已收口，验证码请求失效" });
        this.emit({ type: "provider_headers_expired", requestId });
      }
      this.providerHeadersPending.clear();
    }
    // Adopted session: a settled turn advances the source db past the seed watermark —
    // reconcile now so the replay-suppressed window between the db seed and the replay
    // boundary lands in liveHistory (otherwise it waits for an unrelated external write).
    if (event.type === "agent_settled" && this.attachedChild) {
      void this.syncExternalHistoryIfChanged().catch(() => { /* fail-silent */ });
    }
    // Per-listener isolation (hardening A3): one subscriber throwing must not drop frames nor propagate raw exceptions along the stream
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[aiti-zcode-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Run one turn (dual-channel dispatch, see file header): emits agent_start upon acceptance (the frontend spinner "waiting for model" appears immediately).
   */
  private async runTurn(promptText: string, images?: TurnImage[]): Promise<string> {
    this.emit({ type: "agent_start" });
    // Contract aligned with pi: prompt_done is emitted as soon as the prompt instruction is accepted (the frontend clears
    // the pending flag; the spinner finishes on agent_settled). Without it the frontend rpcPromptPending stays true →
    // settled is skipped by the guard → the spinner hangs forever after the run ends (proven in the 2026-09-10 small-screen S6 acceptance test).
    this.emit({ type: "prompt_done" });
    // User bubble finalized (pi-style message_end{role:"user"}): automatic follow-up turns have no optimistic bubble,
    // manually sent optimistic bubbles are deduplicated by the frontend userMessageKey (same text replaces, not duplicates)
    this.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [
          ...(promptText ? [{ type: "text", text: promptText }] : []),
          ...(images ?? []).map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mimeType, data: img.data },
          })),
        ],
        timestamp: Date.now(),
      },
    });
    // start-plan (ZCode plan) intercept: captcha can only be produced by the desktop app; pi-web cannot drive it. When the
    // current model is start-plan, fail immediately with a plain-language message (including restored known start-plan sessions),
    // without entering the app-server captcha 180s black hole / the oneshot channel.
    // Having a sessId = known/pre-existing session (revived via restore, or rebound after the first turn) → use the
    // "known session loaded via start-plan" dedicated copy.
    const gateRef = this.model?.id && parseModelRef(this.model.id) ? this.model.id : DEFAULT_MODEL_REF;
    if (isStartPlanChannel(gateRef.split("/")[0])) {
      this.turnFailed(this.sessId ? START_PLAN_UNSUPPORTED_KNOWN : START_PLAN_UNSUPPORTED);
      return "error";
    }
    if (featureTransport() === "app-server") {
      try {
        // Image turns also go through app-server (v4 attachment begin→chunk→commit + session/send attachments,
        // same as desktop; since 2026-09-17 the oneshot --attach split path is retired — the oneshot surface ignores
        // the session model set via setModel, an opening for default-model drift / leaking paid quota during nightly free windows).
        return await this.runTurnAppServer(promptText, images);
      } catch (e) {
        // Transport-layer failure (spawn/rpc/process exit): aborts caused by abort() are classified as aborted, everything else goes through the error frame
        if (this.turnAbort.signal.aborted) {
          this.emit({ type: "agent_end" });
          this.emit({ type: "agent_settled", stopReason: "aborted" });
          return "aborted";
        }
        this.turnFailed(e instanceof Error ? e.message : String(e));
        return "error";
      }
    }
    return this.runTurnOneshot(promptText, images);
  }

  /** Runtime + credentials (shared by both channels; each has its own cache; throws a human-readable error on failure). */
  private async resolveTurnRuntime(providerId: string): Promise<{
    runtime: Awaited<ReturnType<typeof resolveRuntime>>;
    cred: Awaited<ReturnType<typeof ensureCredential>>;
  }> {
    const log = (msg: string) => console.log(msg);
    let runtime, cred;
    try {
      runtime = await resolveRuntime({
        featurePath: featureRuntimePath(),
        configDir: this.configDir,
        autoDownload: featureAutoDownload(),
        signal: this.turnAbort.signal,
        log,
      });
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
    try {
      cred = isStartPlanChannel(providerId)
        // Same as desktop: plan channels don't exchange keys, they use the zcodejwttoken from the credential store directly (analysis §9.1)
        ? await ensureStartPlanCredential({ log })
        : await ensureCredential({
          providerId,
          configDir: this.configDir,
          override: featureApiKeyOverride(),
          log,
        });
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
    return { runtime, cred };
  }

  /** Attachments (images → temp files; used by the oneshot --attach channel).
   *  Returns cleanup: the caller invokes it after this turn settles (hardening: previously used Date.now dir names without cleanup — leak + same-millisecond collision). */
  private async writeAttachments(images: TurnImage[]): Promise<{ paths: string[]; cleanup: () => void }> {
    const { randomUUID } = await import("node:crypto");
    const { rmSync } = await import("node:fs") as typeof import("node:fs");
    const dir = join(tmpdir(), `zcode-att-${randomUUID()}`);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const attachPaths: string[] = [];
    let i = 0;
    for (const img of images) {
      const ext = img.mimeType.split("/")[1] || "png";
      const p = join(dir, `att-${++i}.${ext}`);
      await writeFile(p, Buffer.from(img.data, "base64"));
      attachPaths.push(p);
    }
    return {
      paths: attachPaths,
      cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup failure is not fatal */ } },
    };
  }

  /** Real session id captured → rebind (session_backend_ready, same as the CC lazy-persistence pattern; shared by both channels). */
  private rebindSessionId(sid: string): void {
    if (this.sessId === sid) return;
    const oldId = this.id;
    this.sessId = sid;
    this.id = `zcode:${sid}`;
    this.emit({ type: "session_backend_ready", oldId, id: this.id });
    void renameExtModelState("zcode", oldId, this.id).then(() => this.persistModelState());
    // Queue sidecar rebinds with the id (placeholder ids are random; without migration, entries queued before the rebind become unrecoverable after a crash)
    migrateQueueSidecar(queueStateDir, oldId, this.id, (m) => console.warn(m));
  }

  /** app-server event outlet: liveHistory bookkeeping + pass-through to the frontend. */
  private onAppServerEvent(ev: Record<string, unknown>): void {
    // D4: interaction primitive requests (plan approval/question cards) are written into the session message stream (replayable after refresh; decisions recorded in respondInteraction)
    if (ev.type === "interaction_request") {
      this.recordInteractionCustom(ev, "pending");
    }
    if (ev.type === "message_end" && ev.message && typeof ev.message === "object") {
      const msg = ev.message as { role?: string; stopReason?: string; content?: unknown; model?: string; errorMessage?: string };
      if (msg.role === "assistant") {
        // Error frames must keep stopReason/errorMessage — the frontend getAssistantErrorMessage relies on these two fields
        // to render the red error bar; without them it shows "empty reply with no indication" (fixed 2026-09-14 after user testing).
        const errText = typeof msg.errorMessage === "string" && msg.errorMessage.trim()
          ? humanizeZcodeError(msg.errorMessage)
          : "";
        this.liveHistory.push({
          role: "assistant",
          content: msg.content ?? [],
          ...(msg.stopReason ? { stopReason: msg.stopReason } : {}),
          ...(errText ? { errorMessage: errText } : {}),
          ...(msg.model ?? this.model?.id ? { model: msg.model ?? this.model?.id } : {}),
          provider: "zcode",
        });
      } else if (msg.role === "toolResult") {
        this.liveHistory.push(ev.message);
      }
    }
    this.emit(ev);
  }

  /** turn.completed → usage. Real provider usage first (input/output/cache/total);
   *  when usage is absent, fall back to totalTokens=tokenCount (engine projection; a 2026-09-07 probe showed new sessions ≈ the real value). */
  private usageFromTurnOutcome(outcome: TurnOutcome, modelRef: string): Record<string, unknown> {
    const out: Record<string, unknown> = { provider: "zcode", ...(modelRef ? { model: modelRef } : {}) };
    const u = outcome.usage;
    if (u) {
      if (u.inputTokens !== undefined) out.inputTokens = u.inputTokens;
      if (u.outputTokens !== undefined) out.outputTokens = u.outputTokens;
      if (u.cacheReadTokens !== undefined) out.cacheReadTokens = u.cacheReadTokens;
      if (u.cacheWriteTokens !== undefined) out.cacheWriteTokens = u.cacheWriteTokens;
      if (u.totalTokens !== undefined) out.totalTokens = u.totalTokens;
    } else {
      const total = outcome.tokenCount ?? undefined;
      if (total !== undefined) out.totalTokens = total;
      if (outcome.cacheReadTokens != null) out.cacheReadTokens = outcome.cacheReadTokens;
    }
    return Object.keys(out).length > (modelRef ? 2 : 1) ? out : {};
  }

  /** Context usage source (getContextUsage data source): usage.totalTokens (=input+output, same
   *  measure as the engine's contextUsed) → usage.inputTokens(+output) → tokenCount fallback.
   *  ⚠ tokenCount is a chars/4 estimate when the engine lacks a usage baseline (base64 images/large text
   *  all count; content-heavy sessions can reach millions) — it was once used directly for the percentage,
   *  making large sessions wrongly show 100% (observed by a user 2026-09-20). */
  private contextTokensFromOutcome(outcome: TurnOutcome): number | null {
    const u = outcome.usage;
    if (u?.totalTokens !== undefined) return u.totalTokens;
    if (u?.inputTokens !== undefined) return u.inputTokens + (u.outputTokens ?? 0);
    return outcome.tokenCount ?? null;
  }

  /** Session cumulative usage (getUsageTotals data source; accumulated per turn while the handle lives, resets on restart). */
  private usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };

  /** Per-turn settling accumulation (real usage first; oneshot passes a loose Record, sanitized field by field, missing/invalid counted as 0). */
  private accumulateUsage(u: TurnUsageSnapshot | Record<string, unknown> | undefined): void {
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    this.usageTotals.inputTokens += n(u?.inputTokens);
    this.usageTotals.outputTokens += n(u?.outputTokens);
    this.usageTotals.cacheReadTokens += n(u?.cacheReadTokens);
    this.usageTotals.cacheWriteTokens += n(u?.cacheWriteTokens);
    this.usageTotals.turns += 1;
  }

  /** Ensure the long-lived app-server channel is ready (spawn on demand + runtime/credential resolution; shared by runTurn and fork). */
  /**
   * Single-flight: reattachNow (eager adoption) and the first prompt can race into the
   * builder — two concurrent constructions would wire TWO connections over the SAME
   * facade child (double data listeners, double dispatch). Memoize the in-flight
   * promise so the loser awaits the winner's session.
   */
  private asBuilding: Promise<AppServerSession> | null = null;

  private ensureAppServer(): Promise<AppServerSession> {
    if (this.as) return Promise.resolve(this.as);
    if (this.asBuilding) return this.asBuilding;
    this.asBuilding = this.buildAppServer()
      .then((as) => { this.as = as; return as; })
      .finally(() => { this.asBuilding = null; });
    return this.asBuilding;
  }

  private async buildAppServer(): Promise<AppServerSession> {
    const modelRef = this.model?.id && parseModelRef(this.model.id) ? this.model.id : DEFAULT_MODEL_REF;
    const { providerId } = parseModelRef(modelRef)!;
    const { runtime, cred } = await this.resolveTurnRuntime(providerId);
    // Same as desktop: ZCODE_BASE_URL=platform root → the engine pulls configs and reads proxyEndpoint.mapping,
    // dynamically routing provider requests to the ultra gateway + handshake signing on the provider domain (fully identical to desktop).
    // [Off by default since 3.17.2] under an independent spawn, the ultra gateway keeps a server_error retry loop
    // for api-key-type personal registry providers (verified on a real device 2026-11-07; direct connection to open.bigmodel.cn works end to end).
    // feature zcode.ultraGateway=true manually returns to gateway mode (ZCODE_BASE_URL=platform root, with mapping).
    const gateway = featureBool("zcode.ultraGateway", false);
    const protoModels = buildZcodeCatalogRefs()
      .filter((m) => m.id.split("/")[0] === providerId)
      .map((m) => ({ modelId: m.id.split("/")[1], label: m.label, contextWindow: ZCODE_CONTEXT_WINDOW }));
    // 3.17+ registry model registration: self-built personal provider config (merged with the desktop config; providerId in wire form
    // — model.providerId in app-server setModel is wireProviderId (start-plan carries the builtin: prefix))
    const wireId = wireProviderId(providerId);
    const providerCfgFile = writeProviderConfigFile({
      cacheDir: join(dirname(this.configDir), "cache"),
      providerId: wireId,
      baseURL: gateway ? ZCODE_PLATFORM_BASE_URL : (baseUrlFor(providerId) ?? START_PLAN_BASE_URL),
      apiKey: cred.apiKey,
      models: protoModels,
      defaultModelRef: modelRef,
    });
    const env = buildTurnEnv({
      modelRef,
      providerId,
      apiKey: cred.apiKey,
      appVersion: runtime.appVersion,
      passthroughEnv: zcodeSpawnEnv(),
      runtimeCjsPath: runtime.cjsPath,
      personalProviderConfigFile: providerCfgFile,
      ...(gateway ? { baseURL: ZCODE_PLATFORM_BASE_URL } : {}),
    });
    const as = new AppServerSession({
      connection: new (await import("./zcode-appserver.ts")).ZcodeAppServerConnection({
        nodeBin: resolveNodeBin(),
        runtimePath: runtime.cjsPath,
        cwd: this.cwd,
        env,
        launchOverride: this.launchOverride,
        // Detachable hosting: wrapper strategy + registry key (new sessions use the composite
        // provisional id until the native sid lands; the core's watchBackendRebind migrates
        // the registry entry once session_backend_ready rebinds)
        ...(this.agentStarter ? { agentStarter: this.agentStarter, registryKey: this.sessId ?? this.id } : {}),
        // Adopt path (pi-web restart recovery): live process + journal replay budget — the connection wires, never spawns
        ...(this.attachedChild ? { attachedChild: this.attachedChild, replayByteBudget: this.attachedReplayBytes } : {}),
        log: (m) => console.log(m),
      }),
      cwd: this.cwd,
      mode: this.desiredMode ?? featureMode(),
      // The start-plan protocol ref carries the builtin: prefix (triggers the runtime-headers reverse request; catalog/state files still use the bare id)
      modelRef: `${wireProviderId(providerId)}/${modelRef.split("/")[1] ?? ""}`,
      sessId: this.sessId,
      provider: {
        providerId: wireProviderId(providerId),
        baseURL: baseUrlFor(providerId) ?? (isStartPlanChannel(providerId) ? START_PLAN_BASE_URL : ""),
        apiKey: cred.apiKey,
        models: protoModels.length > 0 ? protoModels : [{ modelId: modelRef.split("/")[1], contextWindow: ZCODE_CONTEXT_WINDOW }],
      },
      onProviderHeadersRequest: (req) => this.solveProviderHeaders(req),
      log: (m) => console.log(m),
      onEvent: (ev) => this.onAppServerEvent(ev),
      onSessionId: (sid) => this.rebindSessionId(sid),
      onSteerQueue: (items) => {
        // New entries → drop a user bubble into the chat stream (steer doesn't go through runTurn; users need the assurance that it was "sent and shown")
        // Except during the adopt replay segment: the journal's steer text is already persisted
        // with the turn in the store — re-emitting the bubble would duplicate. Mirror registration
        // stays (idempotent); only post-endReplay live steers emit bubbles.
        // Use the local `as` reference (this.as is only assigned after the builder resolves —
        // the replay gate is live during construction)
        const replaying = as.replayActive() === true;
        const prevIds = new Set(this.lastSteerIds);
        for (const item of items) {
          if (!prevIds.has(item.pendingInputId)) {
            if (!replaying) {
              this.emit({
                type: "message_end",
                message: { role: "user", content: [{ type: "text", text: item.input }], timestamp: Date.now() },
              });
            }
          }
          this.q.registerSteer(item.pendingInputId, item.input); // shared-layer mirror (idempotent, skips known ids)
        }
        this.lastSteerIds = items.map((s) => s.pendingInputId);
        // Full-snapshot diff: entries consumed/dropped by the server are dequeued from the mirror
        this.q.drainSteer([...prevIds].filter((id) => !items.some((s) => s.pendingInputId === id)));
      },
      onTaskList: (todos) => {
        // The appserver layer already does change detection (JSON comparison); here we only pass through and broadcast
        this.taskListMirror = todos;
        this.emit({ type: "task_update", todos });
        // Dormant-fallback snapshot (full overwrite on every update; skipped while sessId is unset — a later update writes it)
        if (this.sessId) persistTaskSnapshot(this.sessId, todos);
      },
    });
    // Adopt path: wire + consume the journal replay right away (not at the first prompt —
    // deferring would delay the running turn's agent_start(resumed) until the user opens
    // the session, leaving running state and settling late).
    if (this.attachedChild) {
      await as.beginAdopted().catch((e) =>
        console.warn("[aiti-zcode-agent] adopt wiring failed (retried via ensureReady on the next prompt):", e instanceof Error ? e.message : String(e)));
    }
    return as;
  }

  /** app-server channel: long-lived session (reused across turns; after a process exit the next turn automatically respawns + resumes). */
  private async runTurnAppServer(promptText: string, images?: TurnImage[]): Promise<string> {
    const modelRef = this.model?.id && parseModelRef(this.model.id) ? this.model.id : DEFAULT_MODEL_REF;
    const as = await this.ensureAppServer();
    // Post-spawn checkpoint: runtime/credential resolution (possibly including a 300MB download) + aborted during spawn → settle quietly
    // (process started but no prompt sent: idle reuse is harmless; the watchdog force-kill path / next prompt covers it)
    if (this.turnAbort.signal.aborted) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    // All turns (including image turns) use long-lived streaming: images are uploaded via v4 attachment and sent with session/send attachments
    // (same as desktop; never reached while running — prompt() already routes to v4 steer / the local queue)
    const outcome = await as.prompt(promptText, images);
    this.lastUsage = this.usageFromTurnOutcome(outcome, modelRef);
    this.lastContextTokens = this.contextTokensFromOutcome(outcome);
    if (!outcome.errorMessage && !outcome.cancelled) this.accumulateUsage(outcome.usage);
    if (outcome.errorMessage) return "error";
    if (outcome.cancelled) return "aborted";
    return "end_turn";
  }

  /** oneshot channel: single-shot process per turn (original path, fallback). */
  private async runTurnOneshot(promptText: string, images?: TurnImage[]): Promise<string> {
    const modelRef = this.model?.id && parseModelRef(this.model.id) ? this.model.id : DEFAULT_MODEL_REF;
    const { providerId } = parseModelRef(modelRef)!;
    if (isStartPlanChannel(providerId)) {
      // oneshot has no reverse-request surface (analysis §9.2: 3007 fails directly) — plan channels are only drivable via the app-server transport
      this.turnFailed("ZCode 套餐通道（start-plan）仅支持 app-server 传输通道（oneshot 无验证码反向请求面）。请在 扩展管理器 → aiti-zcode-agent → 功能管理 将 zcode.transport 设为 app-server（缺省即 app-server）。");
      return "error";
    }
    const { runtime, cred } = await this.resolveTurnRuntime(providerId);
    // Pre-spawn checkpoint: aborted during the runtime/credential phase (possibly including a 300MB download) → settle quietly
    if (this.turnAbort.signal.aborted) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    const attach = images?.length ? await this.writeAttachments(images) : { paths: [], cleanup: () => {} };
    const attachPaths = attach.paths;

    const cliArgs = buildCliArgs({ mode: this.desiredMode ?? featureMode(), sessId: this.sessId, prompt: promptText, attachPaths });
    const oneshotModels = buildZcodeCatalogRefs()
      .filter((m) => m.id.split("/")[0] === providerId)
      .map((m) => ({ modelId: m.id.split("/")[1], contextWindow: ZCODE_CONTEXT_WINDOW }));
    const providerCfgFile = writeProviderConfigFile({
      cacheDir: join(dirname(this.configDir), "cache"),
      providerId: wireProviderId(providerId),
      baseURL: baseUrlFor(providerId) ?? START_PLAN_BASE_URL,
      apiKey: cred.apiKey,
      models: oneshotModels,
      defaultModelRef: modelRef,
    });
    const env = buildTurnEnv({
      modelRef,
      providerId,
      apiKey: cred.apiKey,
      appVersion: runtime.appVersion,
      passthroughEnv: zcodeSpawnEnv(),
      runtimeCjsPath: runtime.cjsPath,
      personalProviderConfigFile: providerCfgFile,
    });

    try {
    const outcome = await execZcodeTurn({
      nodeBin: resolveNodeBin(),
      runtimePath: runtime.cjsPath,
      cliArgs,
      cwd: this.cwd,
      env,
      launchOverride: this.launchOverride,
      onChild: (c) => { this.child = c; },
    });
    this.child = null;

    // User-initiated abort (SIGTERM): no error frame, settle quietly
    if (outcome.killed) {
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return "aborted";
    }

    const parsed = parseTurnOutput(outcome.stdout);
    const ok = outcome.exitCode === 0 && parsed?.response !== undefined;
    if (!ok) {
      if (process.env.AITI_ZCODE_DEBUG_STDERR) console.error("[aiti-zcode-agent][stderr]", outcome.stderrTail);
      const detail = extractCliError(
        outcome.stderrTail,
        `zcode CLI 异常退出（code=${outcome.exitCode}${outcome.signal ? ` signal=${outcome.signal}` : ""}）`,
      );
      this.turnFailed(detail);
      return "error";
    }

    // Real session id: captured on the first turn → rebind (session_backend_ready, same as the CC lazy-persistence pattern)
    if (parsed?.sessionId) this.rebindSessionId(parsed.sessionId);

    // usage / context
    this.lastUsage = usageToReport(parsed?.usage, modelRef);
    const total = parsed?.usage && typeof parsed.usage.totalTokens === "number" ? parsed.usage.totalTokens : undefined;
    this.lastContextTokens = typeof total === "number" ? total : null;
    this.accumulateUsage(parsed?.usage);

    // Answer (one-shot; --json has no incremental stream)
    const text = parsed?.response ?? "";
    if (text) {
      this.liveHistory.push({ role: "assistant", content: [{ type: "text", text }] });
      this.emit({ type: "message_update", delta: text });
    }
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled", stopReason: "end_turn" });
    return "end_turn";
    } finally {
      attach.cleanup();
    }
  }

  /** Errors are delivered to the frontend as a pi-vocabulary assistant message (stopReason:"error", MessageView red alert) and pushed into liveHistory. */
  private turnFailed(errMsg: string): void {
    const humanized = humanizeZcodeError(errMsg);
    const errorMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: humanized,
      ...(this.model?.id ? { model: this.model.id } : {}),
      provider: "zcode",
    };
    this.liveHistory.push(errorMessage);
    this.emit({ type: "message_end", message: errorMessage });
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled_error", error: errMsg });
    this.emit({ type: "agent_settled", stopReason: "error", error: errMsg });
  }

  async prompt(text: string, options?: {
    images?: TurnImage[];
    files?: Array<{ data: string; mimeType: string; filename?: string }>;
    /** Queueing semantics while running (passed through by core): steer=inject into the current turn (native steer); followUp=held locally for the next turn after settle. Default=steer (same as desktop). */
    streamingBehavior?: "steer" | "followUp";
  }): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-zcode-agent] session disposed");
    if (this.isRunning()) {
      // Routing belongs to the shared layer: followUp → local queue (with images, recallable); steer/default → native app-server injection
      // (degrades to queueing on failure); oneshot has no steer → always queues. While running, routePrompt never dispatches.
      // An adopted unsettled turn (as.turnActive) routes the same way — steer into the
      // running turn instead of opening a new one.
      await this.q.routePrompt(text, { images: options?.images, streamingBehavior: options?.streamingBehavior });
      return;
    }
    this.running = true;
    this.liveHistory.push({
      role: "user",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...(options?.images ?? []).map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: img.data },
        })),
      ],
    });
    this.turnAbort = new AbortController();
    try {
      await this.runTurn(text, options?.images);
    } catch (e) {
      // runtime/credential/download-layer failure: aborts caused by abort() are classified as aborted, everything else goes through the error frame (visible to the frontend, never silent)
      if (this.turnAbort.signal.aborted) {
        this.emit({ type: "agent_end" });
        this.emit({ type: "agent_settled", stopReason: "aborted" });
      } else {
        this.turnFailed(e instanceof Error ? e.message : String(e));
      }
    } finally {
      this.running = false;
      this.disarmAbortWatchdog();
    }
    // Queued follow-up turn: a microtask lets agent_settled reach the frontend first (streaming state resets) before the next turn starts (shared-layer idempotent)
    this.q.scheduleDrain();
  }

  /** Native app-server steer (shared-layer steer closure): while running, injects into the current turn via the v4 gateway
   *  (desktop-style sendText{requestedDelivery:"guide"}, drained at the next model/tool gap). Throws on failure → the shared
   *  layer degrades into the local followUp queue (R9: message not lost, original turn not interrupted, no double settled). */
  private async steerViaAppServer(text: string): Promise<void> {
    if (!(featureTransport() === "app-server" && this.as && this.isRunning())) {
      throw new Error("steer unavailable (idle or oneshot transport)");
    }
    this.liveHistory.push({ role: "user", content: text });
    await this.as.steerViaCommand(text);
  }

  /** @capability steer — inject into the current turn while running (v4 native steer, same as desktop); when idle, same as a normal prompt.
   *  Routing belongs to the shared layer: oneshot/idle goes through dispatch (=prompt), failed injection degrades into the local queue. */
  async steer(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-zcode-agent] session disposed");
    await this.q.routePrompt(text);
  }

  /** @capability followUp — enter the local queue while running (automatic next turn after settle, recallable); when idle, same as a normal prompt. */
  async followUp(text: string): Promise<void> {
    if (!this.aliveFlag) throw new Error("[aiti-zcode-agent] session disposed");
    await this.q.routePrompt(text, { streamingBehavior: "followUp" });
  }

  /**
   * @capability queueManage — queue keeper queue-operation primitives (the adapter's queue command family forwards here).
   * Full CRUD belongs to the shared layer: followUp group (held locally, with images) move/convert/remove/recall/requeue/clear;
   * steering group (already handed to the v4 gateway, waiting for a gap to drain): read-only mirror — there is no mapping yet
   * between v4 queue item ids and steerQueued pendingInputId, so recall/reorder are not supported yet (stop cancels the turn and clears them).
   */
  queueManage = (req: {
    action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
    kind?: "steer" | "followUp";
    from?: number;
    to?: number;
    index?: number;
    targetKind?: "steer" | "followUp";
    text?: string;
  }) => this.q.queueManage(req);

  /**
   * Task-list snapshot (read-only mirror of the TodoWrite working plan; docs/aiti-zcode-agent-task-list-plan.md).
   * Real data source for get_state (the handle-adapter probes by method existence, same pattern as queueManage);
   * the protocol has no todo write method → read-only, no operation primitives.
   * Cold-handle fallback: when revived without a prompt yet (mirror not seeded), reads the persisted snapshot — opening a dormant session shows the list.
   */
  taskList = async (): Promise<{ todos: TaskEntry[] }> => {
    if (this.taskListMirror.length > 0) return { todos: this.taskListMirror.map((t) => ({ ...t })) };
    const todos = this.sessId ? await readTaskSnapshotTodos(this.sessId) : null;
    return { todos: todos ?? [] };
  };

  /**
   * @capability respondInteraction — interaction primitive answer backfill (zcode ExitPlanMode approval / AskUserQuestion questions).
   * Addresses the requestId in interaction_request events; the oneshot channel has no reverse-request surface (fail-loud).
   */
  /**
   * start-plan captcha solving slot (data source for the appserver's `interaction/requestProviderRuntimeHeaders`):
   * a cache hit (TTL 5min) returns the param directly; otherwise emit `provider_runtime_headers_request` to the frontend
   * (captcha card: invisible verification first, slider fallback) and wait for `respondProviderHeaders` to answer. Frontend
   * not implemented (pre-P2) → the appserver layer's 180s timeout → {headersApplied:false} → the turn fails with a plain-language message.
   */
  private async solveProviderHeaders(req: { requestId: string; providerId: string; modelRef: string; reason: string }): Promise<
    { ok: true; captchaVerifyParam: string; region?: string } | { ok: false; errorMessage: string }
  > {
    const cached = this.providerHeadersCache.get(req.providerId);
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      return { ok: true, captchaVerifyParam: cached.param, ...(cached.region ? { region: cached.region } : {}) };
    }
    // SDK init triple (server client/configs, 1h cache) — used by the frontend captcha card init; failing to fetch fails immediately with a plain-language message
    let captchaConfig: { sceneId: string; prefix: string; region: string } | null = null;
    if (this.captchaConfigCache && Date.now() - this.captchaConfigCache.at < 3600_000) {
      captchaConfig = this.captchaConfigCache.config;
    } else {
      try {
        const cred = await ensureStartPlanCredential({ log: (m) => console.log(m) });
        const cfg = await fetchCaptchaConfig(cred.apiKey);
        if (cfg) {
          captchaConfig = cfg;
          this.captchaConfigCache = { config: cfg, at: Date.now() };
        }
      } catch (e) {
        console.warn("[aiti-zcode-agent] 验证码配置拉取失败:", e instanceof Error ? e.message : e);
      }
    }
    if (!captchaConfig) {
      return { ok: false, errorMessage: "验证码桥未就绪：服务端 captcha 配置（sceneId/prefix/region）不可用" };
    }
    this.emit({
      type: "provider_runtime_headers_request",
      requestId: req.requestId,
      providerId: req.providerId,
      modelRef: req.modelRef,
      reason: req.reason,
      captchaConfig,
    });
    const answer = await new Promise<{ ok: true; captchaVerifyParam: string; region?: string } | { ok: false; errorMessage: string }>((resolve) => {
      this.providerHeadersPending.set(req.requestId, resolve);
    });
    this.providerHeadersPending.delete(req.requestId);
    if (answer.ok) {
      this.providerHeadersCache.set(req.providerId, { param: answer.captchaVerifyParam, ...(answer.region ? { region: answer.region } : {}), at: Date.now() });
    }
    return answer;
  }

  /** Captcha card answer entry (@capability respondProviderHeaders; timeout/cancellation pass {error} or {cancel:true}). */
  async respondProviderHeaders(requestId: string, answer: { captchaVerifyParam?: string; region?: string; error?: string; cancel?: boolean }): Promise<boolean> {
    const resolve = this.providerHeadersPending.get(requestId);
    if (!resolve) return false;
    const param = typeof answer.captchaVerifyParam === "string" ? answer.captchaVerifyParam.trim() : "";
    // Defensive: an all-empty payload (no cancel/error/valid param) most likely means the frontend SDK callback failed to read values (e.g. signature mismatch),
    // and must not be interpreted as a user cancellation — reject the command, keep it pending (180s/settle fallback), log for troubleshooting.
    if (!answer.cancel && !answer.error && !param) {
      console.warn(`[aiti-zcode-agent] respond_provider_headers 收到空 payload（requestId=${requestId}）：验证参数缺失，保持挂起等超时/收口`);
      return false;
    }
    if (answer.cancel || (!param && !answer.error)) {
      resolve({ ok: false, errorMessage: answer.error || "用户取消了验证码" });
    } else if (answer.error) {
      resolve({ ok: false, errorMessage: answer.error });
    } else {
      resolve({ ok: true, captchaVerifyParam: param, ...(answer.region ? { region: answer.region } : {}) });
    }
    return true;
  }

  async respondInteraction(requestId: string, answer: {
    action: "accept" | "decline";
    answers?: Record<string, string | string[]>;
    message?: string;
  }): Promise<boolean> {
    if (featureTransport() !== "app-server" || !this.as) {
      throw new Error("[aiti-zcode-agent] 交互回填仅 app-server 通道可用（oneshot 无反向请求面）");
    }
    const ok = await this.as.respondInteraction(requestId, answer);
    // D4: decisions are written into the session message stream (accept/decline + answer summary)
    const pending = this.pendingInteractionMeta.get(requestId);
    this.recordInteractionCustom(
      { requestId, ...(pending ?? {}) },
      answer.action === "accept" ? "accept" : "decline",
      answer,
    );
    this.pendingInteractionMeta.delete(requestId);
    return ok;
  }

  /** Pending interaction metadata (interaction_request → brief), used for decision records (D4). */
  private pendingInteractionMeta = new Map<string, { kind?: string; toolName?: string; prompt?: string }>();

  /** Interaction requests/decisions written into the session message stream (custom messages; spec §6 pattern / ACP template). */
  private recordInteractionCustom(ev: Record<string, unknown>, decision: "pending" | "accept" | "decline", answer?: { answers?: Record<string, string | string[]>; message?: string }): void {
    const kind = String(ev.kind ?? "generic");
    const toolName = typeof ev.toolName === "string" ? ev.toolName : "";
    const title = kind === "plan_approval" ? "方案审批" : kind === "ask_user" ? "提问" : `交互请求${toolName ? `（${toolName}）` : ""}`;
    const label = decision === "pending" ? "等待处理"
      : decision === "accept" ? `已同意${answer?.message ? `（${answer.message}）` : ""}`
        : `⛔ 已拒绝${answer?.message ? `（${answer.message}）` : ""}`;
    const answers = answer?.answers && Object.keys(answer.answers).length
      ? `\n回答: ${JSON.stringify(answer.answers).slice(0, 200)}`
      : "";
    const requestId = String(ev.requestId ?? "");
    let brief = typeof ev.prompt === "string" && ev.prompt ? ` — ${ev.prompt.slice(0, 120)}` : "";
    if (decision === "pending" && requestId) {
      this.pendingInteractionMeta.set(requestId, {
        kind,
        ...(toolName ? { toolName } : {}),
        ...(brief ? { prompt: brief.slice(3) } : {}),
      });
    } else if (decision !== "pending" && !brief) {
      const p = this.pendingInteractionMeta.get(requestId);
      brief = p?.prompt ? ` — ${p.prompt}` : "";
    }
    const message = {
      role: "custom",
      customType: title,
      content: `${title}${brief}\n\n${label}${answers}`,
      display: true,
      details: { requestId, kind, toolName, decision, ...(answer ?? {}) },
      timestamp: Date.now(),
    };
    this.liveHistory.push(message);
    this.emit({ type: "message_end", message });
  }

  async abort(): Promise<void> {
    if (!this.isRunning()) {
      // Desync fallback: when the frontend running state desyncs from the handle state (e.g. the settled frame of an error turn lost in a race),
      // returning silently would leave the stop button hanging forever (observed: UI stuck on "stop" after a -32031 error turn from a delisted model).
      // Emit an extra aborted frame to settle and let the frontend reset; idempotent, harmless when truly idle.
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    console.warn("[aiti-zcode-agent] abort: cancelling current turn");
    // Set the manual-abort flag first: subsequent waiter rejects / runTurn throws caused by the watchdog force-kill are classified as aborted (not the error frame)
    try { this.turnAbort.abort(); } catch { /* already aborted */ }
    // app-server: session/stop (same as desktop; the turn settles as cancelled).
    // Watchdog first + fire-and-forget stop: abort() returns immediately, the frontend stop no longer waits on the RPC
    // (previously a hung session/stop meant up to 15s timeout + 8s watchdog = 23s, the main source of the perceived slowness);
    // settling relies on turn.completed(cancelled) arriving naturally (seconds) or the watchdog's timed force-kill fallback.
    if (featureTransport() === "app-server" && this.as) {
      // Settling watchdog: when the zcode-side turn hangs, the protocol layer's hadActivePrompt desyncs and session/stop is a no-op
      // (observed 2026-09-09: after the turn loop deadlocked, three consecutive stops all failed; the user could only restart the whole pi-web) —
      // if not settled within the limit, force-kill the app-server: process exits → onExit → failWaiters → this turn settles as aborted;
      // the next prompt automatically respawns + session/resume (the store is WAL-persisted immediately, lossless).
      this.armAbortWatchdog();
      void this.as.stop(); // stop() catches and logs internally; no error swallowing here
      return;
    }
    // oneshot: phase two, SIGTERM kills this turn's child process
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch { /* already dead */ }
    }
  }

  /** Abort settling watchdog (app-server channel): session/stop not settled within the time limit → force-kill the connection process as a fallback. */
  private armAbortWatchdog(): void {
    this.disarmAbortWatchdog();
    this.abortWatchdog = setTimeout(() => {
      this.abortWatchdog = null;
      if (!this.isRunning()) return; // already settled naturally
      console.warn(`[aiti-zcode-agent] abort 看门狗：session/stop 后 ${ZCODE_ABORT_WATCHDOG_MS / 1000}s 未收口（zcode 端 turn 挂死/失步），强杀 app-server 兜底`);
      try { this.as?.kill(); } catch { /* already dead */ }
      // Adopted turn (no local waiter waiting for the runTurn rejection to settle): the exit
      // callback never sends a settled frame — emit one directly.
      if (!this.running) {
        this.emit({ type: "agent_end" });
        this.emit({ type: "agent_settled", stopReason: "aborted" });
      }
    }, ZCODE_ABORT_WATCHDOG_MS);
  }

  private disarmAbortWatchdog(): void {
    if (this.abortWatchdog) {
      clearTimeout(this.abortWatchdog);
      this.abortWatchdog = null;
    }
  }

  /**
   * session/fork wiring (SessionHandle.fork contract; only called when capability fork=true).
   *
   * entryId = the position id of the branch-point message in the UI message list ("ext-N", in strict 1:1 correspondence
   * with liveHistory: get_messages → normalizeHandleMessages pass-through + buildExternalPagedContext absolute indexing);
   * the branch point = the assistant message preceding the edited/branched message. "" (or an unparseable user prefix) = root rebuild
   * (editing the first message).
   *
   * Two semantics (distinguished by opts.reset, passed through by the pi-web handle-adapter):
   *  - reset ("edit from here"): after forking the child session, the handle rebinds to it (rebindSessionId →
   *    session_backend_ready, host registry/placeholder/queue sidecar all rebind across the chain) and continues in place —
   *    equivalent to pi's navigate_tree rollback. zcode has no truncate, so fork-at-turn is the only protocol surface;
   *    forking at the first message would carry the original message along, hence "discard the current app-server + fresh create next turn".
   *  - non-reset (message "branch" button): pure fork; the current session is untouched, and the child session's composite id
   *    is returned for the frontend to jump to.
   *
   * fork-at-turn target resolution (zcode e8i): turnIndex counts by user message order, target = that turn's assistant
   * reply; the child session's history includes that reply but nothing after it. Known limitation: if a steer-injected user
   * bubble was not persisted by the server as a separate user row, the turnIndex count shifts (e8i parse failure raises
   * explicitly, never silently misaligns).
   * File rollback: fork carries zcode checkpoint semantics (snapshot rollback after the branch point), no git-trace gate needed.
   */
  async fork(entryId: string, opts?: { reset?: boolean }): Promise<{ cancelled: boolean; newSessionFile?: string }> {
    if (featureTransport() !== "app-server") throw new Error("当前通道不支持分叉/编辑从此处（仅 app-server 常驻传输）");
    if (this.running) throw new Error("运行中不允许分叉（zcode 限制）：请先停止当前轮");
    const reset = opts?.reset === true;

    // Root rebuild only accepts an explicitly empty branch point (editing the first message; MessageView has no preceding assistant → leafId=null).
    // Non-empty entryId that fails to parse / is out of bounds → raise explicitly, never silently degrade to a root rebuild (that would discard the entire history in the current view).
    if (reset && entryId === "") {
      await this.resetToForkPoint();
      return { cancelled: false };
    }
    const turnIndex = this.turnIndexForBranchPoint(entryId);
    if (!this.sessId || !this.sessId.startsWith("sess_")) {
      throw new Error("会话尚未建立（真实会话 id 未知），无法分叉");
    }
    if (turnIndex === null) {
      throw new Error(`无法解析分支点位置（entryId=${entryId || "空"}）：消息列表可能已变化，请刷新后重试`);
    }

    const as = await this.ensureAppServer();
    const forkedSid = await as.forkFromTurn(turnIndex);
    if (reset) {
      // Edit from here: rebind to the child session + rebuild history as the branch-point prefix (after fork-at-turn the child session is exactly that prefix)
      await this.resetToForkPoint(forkedSid);
      return { cancelled: false, newSessionFile: this.id };
    }
    // Branch button: the current session stays untouched; the child session is handed to the frontend to open by composite id (cold resume recovery path)
    return { cancelled: false, newSessionFile: `zcode:${forkedSid}` };
  }

  /**
   * Switch in place to the branch-point state: drop the current app-server channel (the old session in the old process is
   * already persisted, the process is not worth keeping) → the next prompt resumes with the new sid / creates fresh. History
   * rebuilt in sync: with forkedSid given = replay the child session from the source store (full branch-point prefix); without
   * = clear (root rebuild, waiting for the next create).
   * Note this must not go through syncExternalHistoryIfChanged — after the anchor is cleared to 0 it only anchors on the first run without replaying.
   */
  private async resetToForkPoint(forkedSid?: string): Promise<void> {
    if (this.as) {
      try { this.as.kill(); } catch { /* already dead */ }
      this.as = null;
    }
    if (forkedSid) {
      this.rebindSessionId(forkedSid);
    } else {
      // Root rebuild: clear the real sid — the next prompt goes through session/create to build a brand-new session (rather than resuming the old one);
      // when create returns the new id, onSessionId → rebindSessionId completes the rebind.
      this.sessId = undefined;
    }
    this.liveHistory = [];
    this.historySeedRevMs = 0;
    if (forkedSid) {
      try {
        const parsed = await this.parseSessionSvc();
        if (parsed?.messages?.length) {
          this.seedHistory(parsed.messages as never[]);
        }
        const rev = readZcodeSessionUpdatedMs(this.sessId!);
        if (rev !== null) this.historySeedRevMs = rev; // anchor the current watermark (later external writes are still detectable)
      } catch { /* replay failure does not block the fork (fail-silent; sync retries on getMessages) */ }
    }
  }

  /**
   * UI position id ("ext-N") → zcode turnIndex: count the user messages in liveHistory[0..=N] as K,
   * branch-point turn number = K-1 (the branch point is some turn's assistant reply; that turn's user message counts into the prefix).
   * Hard contract with pi-web EXTERNAL_ENTRY_ID_PREFIX ("ext-"); parse failure / out of bounds returns null.
   */
  private turnIndexForBranchPoint(entryId: string): number | null {
    if (typeof entryId !== "string" || !entryId.startsWith("ext-")) return null;
    const idx = Number(entryId.slice(4));
    if (!Number.isInteger(idx) || idx < 0) return null;
    if (idx >= this.liveHistory.length) return null; // out of bounds (UI snapshot newer than the handle rebuild) → raise explicitly rather than silently misaligning
    let users = 0;
    for (let i = 0; i <= idx; i++) {
      const m = this.liveHistory[i] as { role?: unknown } | undefined;
      if (m?.role === "user") users++;
    }
    return users > 0 ? users - 1 : null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): Promise<void> {
    this.aliveFlag = false;
    this.disarmAbortWatchdog();
    this.q.dispose();
    this.listeners.clear();
    // Wrapper-hosted process (SocketChild facade): disconnect only, never kill — across a
    // pi-web restart/upgrade, extension reload or recycle re-handle, the agent and its
    // running turn survive untouched; the next open re-adopts via the registry (killing is
    // the core's explicit decision — idle governor, hosting switch, session deletion — not ours).
    const facade = this.as?.detachedChild();
    if (facade?.detachable === true && typeof facade.release === "function") {
      this.as?.detachDispose();
      try { facade.release(); } catch { /* already gone */ }
      this.as = null;
      return Promise.resolve();
    }
    void this.as?.dispose().catch(() => {});
    this.as = null;
    return Promise.resolve();
  }

  alive(): boolean {
    return this.aliveFlag;
  }

  isRunning(): boolean {
    // Adopt path: a turn that was running at the pi-web restart keeps going after adoption
    // (as.turnActive) until the live turn.completed arrives (finishTurn settles it).
    return this.running || this.as?.turnActive === true;
  }

  getModel(): { id: string; provider: string } | undefined {
    return this.model;
  }

  /** Switch model: app-server takes effect immediately (session/setModel, same as desktop); oneshot takes effect on the next spawned turn. id must be a "provider/model" ref. */
  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    const parsed = parseModelRef(model.id);
    if (!parsed) {
      throw new Error(`[aiti-zcode-agent] 非法模型 ref "${model.id}"（需为 bigmodel/<model> 或 zai/<model>）`);
    }
    // Switching to start-plan → reject with a plain-language message (captcha only from the desktop app; pi-web cannot drive it); switching away from start-plan is not intercepted.
    if (isStartPlanChannel(parsed.providerId)) {
      throw new Error(START_PLAN_UNSUPPORTED);
    }
    const prev = this.model;
    this.model = { id: model.id, provider: "zcode" };
    this.emit({ type: "model_select", model: this.model, ...(prev ? { previousModel: prev } : {}), source: "set" });
    this.persistModelState();
    if (this.as) {
      const parsed = parseModelRef(model.id);
      await this.as.setModel(`${wireProviderId(parsed?.providerId ?? "")}/${parsed?.modelId ?? ""}`).catch((e) =>
        console.warn("[aiti-zcode-agent] setModel 即时生效失败（不阻塞切换，下轮重试）:", e instanceof Error ? e.message : e));
    }
    return true;
  }

  /**
   * Switch permission mode: app-server takes effect immediately (session/setMode, same as desktop); oneshot stores desiredMode and takes effect on the next spawned turn.
   * UI standard five levels → zcode mode mapping: default→build, acceptEdits→edit, bypassPermissions→yolo; dontAsk has no counterpart and fails loud.
   */
  async setPermissionMode(mode: string): Promise<boolean> {
    const MODE_MAP: Record<string, typeof ZCODE_MODES[number]> = {
      default: "build",
      acceptEdits: "edit",
      plan: "plan",
      bypassPermissions: "yolo",
    };
    const zcodeMode = MODE_MAP[mode];
    if (!zcodeMode) {
      throw new Error(`[aiti-zcode-agent] 非法权限模式 "${mode}"（可选：${Object.keys(MODE_MAP).join("/")}；dontAsk 无对应档）`);
    }
    this.desiredMode = zcodeMode;
    if (this.as) {
      await this.as.setMode(zcodeMode).catch((e) =>
        console.warn("[aiti-zcode-agent] setMode 即时生效失败（不阻塞切换，下轮重试）:", e instanceof Error ? e.message : e));
    }
    return true;
  }

  async getAvailableModels(): Promise<ExtModelEntry[]> {
    return zcodeCatalog(this.model);
  }

  /** Temporary model state file (written on start/switch/rebind: selected + catalog snapshot). */
  persistModelState(): void {
    void this.getAvailableModels().then((models) =>
      writeExtModelState({
        agentKey: "zcode",
        sessionId: this.id,
        ...(this.model ? { selected: this.model } : {}),
        models,
        updatedAt: "",
      }));
  }

  /** @capability getUsage — latest-run tokens + account quota (get_usage protocol → stats-row chip /
   *  session-info quota block / badge popup QuotaRow). Quota rides the shared cached chain;
   *  tokens-only when the quota view carries no numbers (fetch failed / status-only fallback). */
  async getUsage() {
    const base = this.lastUsage;
    let merged: Record<string, unknown> | null = null;
    try {
      merged = backendUsageFromQuotaView(await accountQuotaView(false), base ?? null);
    } catch { /* quota fetch failed → tokens-only snapshot */ }
    return (merged ?? base) as never;
  }

  getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } | undefined {
    if (!this.lastUsage) return undefined;
    const tokens = this.lastContextTokens;
    return {
      // Missing/zero value → percent null (frontend shows an empty "?" track) — never fabricate 100% from missing data
      percent: tokens !== null && tokens > 0 ? Math.min(100, (tokens / ZCODE_CONTEXT_WINDOW) * 100) : null,
      contextWindow: ZCODE_CONTEXT_WINDOW,
      tokens,
    };
  }

  /** @capability getUsageTotals — session cumulative usage (the real measure for the host's get_session_stats).
   *  Previously unimplemented: the stats panel Token area always showed 0/0/0 (host fallback), contradicting the context row. */
  getUsageTotals() {
    return { ...this.usageTotals };
  }

  /** All Sessions service outlet read (the single authoritative implementation = session-manager AgentAdapter live parse).
   *  Shares the same outlet as the createZcodeSession revival replay; fails silently when absent. */
  private parseSessionSvc(): Promise<{ meta?: Record<string, unknown>; messages?: unknown[] } | null> {
    if (!this.sessId) return Promise.resolve(null);
    const reg = (globalThis as any).__piWebExt;
    const svc = hostSvc?.get?.("session-manager.sessions") ?? reg?.byId?.("session-manager")?.ext?.services?.sessions;
    return typeof svc?.parseSession === "function" ? svc.parseSession(`zcode:${this.sessId}`) : Promise.resolve(null);
  }

  /** Pre-getMessages "external write awareness" (2026-09-15 user report: "clicking a session doesn't load the latest content").
   *
   * Root cause: openExternalSession reuses a live handle as-is (no rebuild), so get_messages returns the handle's
   * in-memory liveHistory — it only holds the source snapshot from when the handle was created + the turns this handle
   * drove itself; new messages the zcode desktop/CLI writes into the same session while the handle lives are never pushed
   * to this handle (different app-server processes, no shared subscription), so on reuse-open messages stay at the old position (while the list is live).
   *
   * Fix: when the handle is idle, probe the source db session's time_updated (one lightweight WAL read-only SELECT);
   * if the watermark passed the last backfill anchor → re-read the full history from the source via the session-manager
   * service outlet and rebuild liveHistory. Skipped while running (the live stream is pushing; a rebuild would break
   * streaming); zero cost when the watermark is unchanged; fail-silent on read failure. */
  private async syncExternalHistoryIfChanged(): Promise<void> {
    // Skip while running (live stream is pushing; a rebuild would break streaming; an adopted
    // unsettled turn counts as running too)
    if (this.isRunning() || !this.sessId || !this.sessId.startsWith("sess_")) return;
    if (this.historySyncInflight) { await this.historySyncInflight; return; }
    const task = (async () => {
      try {
        const rev = readZcodeSessionUpdatedMs(this.sessId!);
        if (rev === null) return; // db unreadable (missing store / write-lock moment) → skip, retry next turn
        if (this.historySeedRevMs === 0) { this.historySeedRevMs = rev; return; } // anchor on the first run (the seed taken at handle creation was the latest then)
        if (rev <= this.historySeedRevMs) return; // no external advancement
        const parsed = await this.parseSessionSvc();
        if (parsed?.messages?.length) {
          this.liveHistory = [];
          this.seedHistory(parsed.messages as never[]);
        }
        this.historySeedRevMs = rev;
      } catch { /* fail-silent: on read failure leave liveHistory untouched */ }
    })();
    this.historySyncInflight = task;
    try { await task; } finally { if (this.historySyncInflight === task) this.historySyncInflight = null; }
  }

  /** In-memory conversation log (all turns within this handle's lifetime; before returning, first catch up on external
   *  writes via syncExternalHistoryIfChanged — ensuring "clicking a session" reads the source store's latest, not the handle's stale snapshot). */
  async getMessages(): Promise<unknown[]> {
    await this.syncExternalHistoryIfChanged();
    return [...this.liveHistory];
  }

  /** Last activity time (epoch ms; returns undefined when there was no activity). Used by /api/sessions to fix placeholder-row modified. */
  getLastActivity(): number | undefined {
    return this.lastActivityTs ?? undefined;
  }
}

// ============================================================================
// Extension entry
// ============================================================================

let counter = 0;
/** Controlled-login API (mounted in startup; returns a Response when /login/* matches, null otherwise to pass through). */
let loginApi: ((req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) => Promise<Response | null>) | null = null;
/** Controlled-login controller reference (terminates an in-flight login process at shutdown). */
let loginCtl: { dispose(): void } | null = null;

/**
 * Session recycle API (2026-09-10): upgrades existing handles to the current extension code without restarting the pi-web process.
 *
 * Background: extension hot-reload only swaps modules; handle instances already in the core handle store
 * (globalThis.__sessionHandles) keep running the old code — after deploying new logic, old sessions don't pick it up
 * (bit us in practice during the steer v4 migration).
 *
 *   GET  /session/recycle               → list of existing zcode sessions (id/running/alive)
 *   POST /session/recycle {id, force?}  → idle check (running sessions need force:true, which interrupts the current turn)
 *       → dispose the old handle → self-fetch POST /api/session-backends (loopback always passes the gate)
 *       → the core revival branch builds a new handle (current code) → putHandle overwrite + watcher/placeholder full wiring.
 *   new- placeholder sessions (no real sid) are only disposed — the frontend rebuilds a fresh session on demand at next access.
 */
type RecycleHandleLike = { id: string; isRunning(): boolean; alive(): boolean; dispose(): unknown; cwd?: string };

function recycleSelfBase(req: Request): string {
  // The server binds 127.0.0.1 (unit ExecStart --hostname 127.0.0.1); the port is in argv (--port),
  // not in env. When the request itself comes from loopback, use its origin directly; requests arriving via an nginx domain fall back to argv parsing.
  try {
    const u = new URL(req.url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      return u.origin;
    }
  } catch { /* fallthrough */ }
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return `http://127.0.0.1:${Number.isFinite(port) ? port : 3000}`;
}

async function recycleApi(req: Request, ctx: { path: string[]; method: string }): Promise<Response | null> {
  if (ctx.path[0] !== "session" || ctx.path[1] !== "recycle") return null;
  const store = (globalThis as { __sessionHandles?: Map<string, RecycleHandleLike> }).__sessionHandles;
  if (ctx.method === "GET") {
    const sessions = [...(store?.values() ?? [])]
      .filter((h) => h.id.startsWith("zcode:"))
      .map((h) => ({ id: h.id, running: h.isRunning(), alive: h.alive() }));
    return Response.json({ sessions });
  }
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  let body: { id?: unknown; force?: unknown } = {};
  try { body = await req.json() as typeof body; } catch { /* empty body treated as defaults */ }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id.startsWith("zcode:")) return Response.json({ error: "id 必须是 zcode: 复合 id" }, { status: 400 });
  const old = store?.get(id);
  if (!old) return Response.json({ error: `无存活的 handle：${id}` }, { status: 404 });
  if (old.isRunning() && !body.force) {
    return Response.json(
      { error: "会话正在运行中——等本轮收口后重试；确认要打断请带 force:true（当前轮作废，已排队 steer/队列随之清空）", running: true },
      { status: 409 },
    );
  }
  const realSid = id.startsWith("zcode:sess_") ? id.slice("zcode:".length) : "";
  const cwd = typeof (old as { cwd?: string }).cwd === "string" ? (old as { cwd?: string }).cwd : "";
  try { await old.dispose(); } catch { /* tolerate already-dead */ }
  if (!realSid) {
    return Response.json({ recycled: true, recreated: false, id, note: "占位会话已释放（未发过消息的空会话），前端下次访问按需重建" });
  }
  const base = recycleSelfBase(req);
  try {
    const res = await fetch(`${base}/api/session-backends`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerType: "aiti-zcode-agent/zcode", sessionId: realSid, ...(cwd ? { cwd } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return Response.json({
        recycled: true, recreated: false, id,
        error: `重建请求 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
        note: "旧 handle 已释放——前端刷新该会话即走复活路径用当前代码重建",
      });
    }
    return Response.json({ recycled: true, recreated: true, id, session: data });
  } catch (e) {
    return Response.json({
      recycled: true, recreated: false, id,
      error: `重建请求失败: ${e instanceof Error ? e.message : String(e)}`,
      note: "旧 handle 已释放——前端刷新该会话即走复活路径用当前代码重建",
    });
  }
}

/** Plan status cache (60s; force=1 bypasses; local file read, 10s backoff on failure). */
let quotaCache: { at: number; ttl: number; value: Record<string, unknown> } | null = null;
const QUOTA_TTL_MS = 60_000;
const QUOTA_ERROR_TTL_MS = 10_000;
/** Extension cache root (captured in setup): read root for provider-config/<channel>.json coding-plan API keys. */
let quotaCacheDir: string | undefined;

/** GET /login/quota[?force=1] → unified quota view: live coding-plan numbers (quota/limit) first, plan-status fallback. */
async function quotaView(force: boolean): Promise<Response> {
  return Response.json(await accountQuotaView(force));
}

/** Numeric quota chain (uncached): try each available coding-plan channel (provider-config apiKey); fall back to planQuotaView on failure. */
async function accountQuotaViewUncached(): Promise<Record<string, unknown>> {
  let lastError = "";
  const channels = readPlanStatus().filter((s) => s.status === "available" && !isStartPlanChannel(s.channel));
  for (const ch of channels) {
    const family = channelFamily(ch.channel);
    if (!quotaCacheDir || !QUOTA_LIMIT_URL[family]) continue;
    const apiKey = readProviderConfigApiKey(quotaCacheDir, ch.channel);
    if (!apiKey) continue;
    try {
      const view = quotaLimitToQuotaView(await fetchCodingPlanQuotaLimit(apiKey, family));
      if (view.available === true) return view;
      lastError = String((view as { note?: unknown }).note ?? "响应无数据");
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  const fallback = planQuotaView(readPlanStatus());
  if (lastError) {
    fallback.note = `${typeof fallback.note === "string" && fallback.note ? fallback.note + " · " : ""}数值额度获取失败：${lastError}`;
  }
  return fallback;
}

/** Cached account quota (60s ok / 10s error): shared by /login/quota route + the getUsage capability (on-demand only, no polling). */
async function accountQuotaView(force: boolean): Promise<Record<string, unknown>> {
  if (!force && quotaCache && Date.now() - quotaCache.at < quotaCache.ttl) return quotaCache.value;
  const v = await accountQuotaViewUncached();
  quotaCache = { at: Date.now(), ttl: v.available === true ? QUOTA_TTL_MS : QUOTA_ERROR_TTL_MS, value: v };
  return v;
}

export default {
  id: "aiti-zcode-agent",
  name: "ZCode CLI",
  icon: "icons/cpu.svg",
  // Controlled-login unified dialog (zero-build native h() client; the two files under client/ are copied at deploy)
  // Static insertion point declarations (one-to-one with the client registerItems ids)
  // Login UI was unified into aiti-agent-manager (the controlled-login dialog retired, 2026-09-13): ui is no longer declared —
  // the server /login/* routes and the .agent descriptor remain (consumed by the manager proxy).
  // client (since 2026-09-16): the provider_headers captcha card of the sessionRequestCard slot —
  // "agent extensions carry their own capability UI" (de-core plan docs/pi-web-agent-capability-ui-ext-plan.md §3.2).
  client: "dist/aiti-zcode-cards.mjs",

  features: [
    {
      id: "zcode.transport",
      type: "string" as const,
      label: "传输通道",
      group: "ZCode CLI",
      description: "app-server = 长驻 ZCode Protocol（桌面端同款：流式打字机/工具卡/原生 steer/热切模型，省每轮 ~5-6s 冷启动）；oneshot = 每轮单发进程（旧路径兜底）。留空默认 app-server。",
      value: "app-server",
      placeholder: "app-server | oneshot",
    },
    {
      id: "zcode.runtimePath",
      type: "string" as const,
      label: "Runtime 路径",
      group: "ZCode CLI",
      description: "指定 ZCode runtime：zcode.cjs 文件、解压目录、或 ZCode-*.AppImage 本体。留空则自动探测（Windows 安装目录 / 挂载实例 / ~/.zcode）→ 自动下载。",
      placeholder: "/home/me/.zcode/ZCode-3.11.2-linux-x64.AppImage",
    },
    {
      id: "zcode.autoDownload",
      type: "boolean" as const,
      label: "自动下载 AppImage",
      group: "ZCode CLI",
      description: "探测不到 runtime 时从官网自动下载（约 300MB，缓存在扩展数据目录；Windows 已装则直接用安装目录）。",
      default: true,
    },
    {
      id: "zcode.mode",
      type: "string" as const,
      label: "权限模式",
      group: "ZCode CLI",
      description: "每轮 spawn 的 --mode：build（工具调用询问）/ edit（自动允许文件编辑）/ plan（只读规划）/ yolo（跳过全部权限询问，最大权限）。默认 yolo（2026-09-06 应用户要求由 build 改）。",
      value: "yolo",
      placeholder: "yolo",
    },
    {
      id: "zcode.model",
      type: "string" as const,
      label: "默认模型 ref",
      group: "ZCode CLI",
      description: "新会话默认模型（provider/model，如 bigmodel/GLM-5.3）。留空自动跟随已认证的套餐通道（bigmodel/zai）。",
      value: "",
      placeholder: "留空自动跟随套餐通道",
    },
    {
      id: "zcode.apiKeyOverride",
      type: "string" as const,
      label: "API Key 手动覆盖",
      group: "ZCode CLI",
      description: "手动提供编程套餐 API Key（跳过桌面端凭据 OAuth 链路）。一般留空。",
      value: "",
      placeholder: "留空使用桌面端登录凭据",
    },
    {
      id: "zcode.ultraGateway",
      type: "boolean" as const,
      label: "Ultra 网关路由",
      group: "ZCode CLI",
      description: "app-server 走 zcode.z.ai 平台根动态路由（桌面端同款）。注意：宿主对未声明布尔 feature 默认 true——本项必须显式声明才可控。3.17.2 独立 spawn 下网关持续 server_error（2026-11-07 实测），默认直连 open.bigmodel.cn。",
      default: false,
    },
    spawnEnvFeature("ZCode CLI"),
    spawnDisplayEnvFeature("ZCode CLI"),
    spawnCommandFeature("ZCode CLI"),
    spawnArgsPrefixFeature("ZCode CLI"),
  ],


  ui: {
    // English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
    i18n: {
      "zh-CN": {
        "ext.displayName": "ZCode 会话后端",
      },
      en: {
        ...spawnFeatureI18nEn(),
        "feat.zcode.transport.desc": "app-server = long-lived ZCode Protocol (same as desktop: streaming typewriter/tool cards/native steer/hot model switch, saves ~5-6s cold start per turn); oneshot = single-shot process per turn (legacy fallback). Empty defaults to app-server",
        "feat.zcode.runtimePath.desc": "ZCode runtime: zcode.cjs file, extracted dir, or executable; auto-probed when empty",
        "feat.zcode.autoDownload.desc": "Auto-downloads from the official site when the runtime isn't found (~30MB, cached)",
        "feat.zcode.mode.desc": "--mode for each spawn: build (asks on tool calls) / edit / plan",
        "feat.zcode.model.desc": "Default model for new sessions (provider/model, e.g. bigmodel/GLM-5.3)",
        "feat.zcode.apiKeyOverride.desc": "Manually provides the coding-plan API key (skips desktop keychain reuse)",
        "feat.zcode.ultraGateway.desc": "app-server routes dynamically via the zcode.z.ai platform root (desktop-linked accounts)",
        "ext.displayName": "ZCode Session Backend",
        "feat.zcode.transport.desc": "app-server = long-lived ZCode Protocol (same as desktop: streaming typewriter/tool cards/native steer/hot model switch, saves ~5-6s cold start per turn); oneshot = single-shot process per turn (legacy fallback). Empty defaults to app-server.",
        "feat.zcode.transport": "Transport channel",
        "feat.zcode.runtimePath": "Runtime path",
        "feat.zcode.autoDownload": "Auto-download AppImage",
        "feat.zcode.mode": "Permission mode",
        "feat.zcode.model": "Default model ref",
        "feat.zcode.apiKeyOverride": "API key manual override",
        "feat.zcode.ultraGateway": "Ultra gateway routing",
      },
    },
  },

  server: {
    startup(ctx: {
      configDir: string;
      features?: { get(extIdOrFid?: string, fid?: string): boolean | string | undefined };
      services?: { get(key: string): unknown; provide<T>(key: string, impl: T): () => void };
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          agentKey?: string;
          priority?: number;
          maxCapabilities: SessionCapabilitiesLike;
          listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          createSession(options: {
            sessionId?: string;
            cwd?: string;
            model?: { provider: string; id: string };
          }): Promise<ZcodeHandle>;
        }): string;
      };
    }) {
      hostFeatures = (ctx as any)?.features ?? null;
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1: capture the spawn.env feature (otherwise spawnEnvList stays empty)
      hostSvc = (ctx as any)?.services ?? null; // DI plan P1
      try { mkdirSync(ctx.configDir, { recursive: true }); } catch { /* exists */ }
      const configDir = ctx.configDir;
      // Queue crash-recovery sidecar root (<stateDir>/queues/<sessionId>.json; docs/aiti-remote-queue-and-sidecar-plan.md §3)
      queueStateDir = (ctx as { stateDir?: string }).stateDir ?? join(configDir, "state");
      try { mkdirSync(join(queueStateDir, "queues"), { recursive: true }); } catch { /* exists */ }
      // Task-list snapshot root + dormant fallback service (consumed by the core state router's dormant-branch generic scan; service registration failure does not block startup)
      taskListDir = join(queueStateDir, "task-lists");
      try { mkdirSync(taskListDir, { recursive: true }); } catch { /* exists */ }
      try {
        (ctx as { services?: { provide?: (key: string, impl: unknown) => unknown } }).services?.provide?.(
          "aiti-zcode-agent.sessionDormantState",
          readTaskSnapshot,
        );
      } catch { /* service surface absent (e.g. unit-test stubs) → dormant fallback degrades to no data */ }
      // lazy migrate (data-layering double insurance): old root-level runtime/apps/ (AppImage and extracted runtime, re-downloadable) → cache/
      // Three-dir symmetry: configDir = <extRoot>/config; old root-level/cache both live under <extRoot> = dirname(configDir)
      const extRoot = dirname(configDir);
      quotaCacheDir = join(extRoot, "cache");
      for (const rel of ["runtime", "apps"]) {
        const from = join(extRoot, rel), to = join(extRoot, "cache", rel);
        try { if (existsSync(from) && !existsSync(to)) { mkdirSync(join(to, ".."), { recursive: true }); renameSync(from, to); } } catch { /* retry next time */ }
      }
      // Controlled login (toolbar 🔑): spawns the official `login --no-browser --json`, hands the URL to the frontend;
      // credential persistence/key exchange are all official; on success, warms up ensureCredential (login only lands the z.ai channel token)
      const login = createControlledLogin({
        driver: zcodeLoginDriver,
        configDir,
        resolveRuntime: async () => {
          const runtime = await resolveRuntime({
            featurePath: featureRuntimePath(),
            configDir,
            autoDownload: featureAutoDownload(),
            log: (m) => console.log(m),
          });
          return runtime.cjsPath;
        },
        onSuccess: () => {
          void ensureCredential({ providerId: "zai", configDir, override: featureApiKeyOverride(), log: (m) => console.log(m) })
            .catch((e) => console.warn("[aiti-zcode-agent] 登录成功但换 key 预热失败（下轮 ensureCredential 会重试）:", e instanceof Error ? e.message : e));
        },
        log: (m) => console.log(`[aiti-zcode-agent] ${m}`),
      });
      loginApi = mountControlledLoginApi(login);
      loginCtl = login;
      // createSession body (shared by the provider and the P2 launch service: revival/seed model/state file identical across the chain)
      // detachable: options.agentStarter (wrapper spawn) and options.attached (adopt the live process after restart)
      // are injected by the host's withAgentStarter/attachDetachedSession and passed through verbatim to the handle.
      const createZcodeSession = async (
        options: {
          sessionId?: string;
          cwd?: string;
          model?: { provider: string; id: string };
          /** Host-injected process strategy (detachable hosting); absent = plain spawn. */
          agentStarter?: ZcodeAgentStarterLike;
          /** Core recovery: adopt this live wrapper-hosted process instead of spawning. */
          attached?: { child: import("node:child_process").ChildProcess; sessionId: string; agentKey?: string; cwd?: string };
        },
        launchOverride?: LaunchOverride,
      ): Promise<ZcodeHandle> => {
          const rawSid = options.sessionId ?? "";
          // All Sessions history-row revival: composite id "zcode:sess_xxx" → sid is the real zcode session id
          const isRealSid = rawSid.startsWith("sess_");
          const id = rawSid ? `zcode:${rawSid}` : `zcode:new-${++counter}-${Date.now()}`;

          // ★ The revival path reads the zcode session store first: cwd must follow the session's original directory —
          //   an upsert/resume workspace differing from the session's original workspace causes
          //   provider injection to be ineffective + restoreWarning(-32031) refusing sends (observed).
          //   The URL ?session= recovery path often has an empty options.cwd → must not fall back to process.cwd().
          let restoredParsed: { meta?: { cwd?: string; model?: string }; messages?: unknown[] } | null = null;
          const parseSessionSvc = (): Promise<{ meta?: { cwd?: string; model?: string }; messages?: unknown[] } | null> => {
            const reg = (globalThis as any).__piWebExt;
            const svc = hostSvc?.get?.("session-manager.sessions") ?? reg?.byId?.("session-manager")?.ext?.services?.sessions;
            return typeof svc?.parseSession === "function" ? svc.parseSession(`zcode:${rawSid}`) : Promise.resolve(null);
          };
          if (isRealSid) {
            try {
              restoredParsed = await parseSessionSvc();
            } catch { /* replay failure does not block adoption (fail-silent) */ }
          }
          const restoredCwd = typeof restoredParsed?.meta?.cwd === "string" && restoredParsed.meta.cwd.trim() ? restoredParsed.meta.cwd : "";
          const handle = new ZcodeHandle(id, restoredCwd || options.cwd || options.attached?.cwd || process.cwd(), configDir);
          handle.launchOverride = launchOverride;
          // Detachable-hosting wiring: the wrapper strategy rides with the handle (used by
          // the lazy spawn at the first prompt); the adopt path additionally carries the live
          // process + journal replay budget (SocketChild.replayBytes, byte-gated history/live boundary).
          handle.setAgentStarter(options.agentStarter);
          if (options.attached) {
            const facade = options.attached.child as unknown as { replayBytes?: unknown } | null;
            handle.setAttachedProcess(
              options.attached.child,
              typeof facade?.replayBytes === "number" ? facade.replayBytes : 0,
            );
          }

          // Seed model: explicit > same-session state restore (the user last switched within this session, with channel validation) > real model from session replay
          // > this agent's last used (per-agent last used) > feature/plan-channel default (priority descending)
          const planChannel = detectPlanProvider(); // null = undetectable (for log display only; validation always goes through the module-level channelUsable)
          if (typeof options.model?.id === "string" && options.model.id && parseModelRef(options.model.id)) {
            // Explicitly selecting start-plan → reject with a plain-language message (captcha only from the desktop app; pi-web cannot drive it);
            // no silent fallback — the user should be told at click time, not have the model swapped invisibly.
            if (isStartPlanChannel(options.model.id.split("/")[0])) {
              throw new Error(START_PLAN_UNSUPPORTED);
            }
            handle.model = { id: options.model.id, provider: "zcode" };
          } else if (options.sessionId) {
            const restored = await readExtModelState("zcode", `zcode:${options.sessionId}`);
            if (restored?.selected?.id && parseModelRef(restored.selected.id)) {
              const pid = restored.selected.id.split("/")[0];
              if (channelUsable(pid)) {
                handle.model = { id: restored.selected.id, provider: "zcode" };
              } else {
                console.log(`[aiti-zcode-agent] 状态文件模型 ${restored.selected.id} 通道不可用/无凭据，回落默认（已认证通道: ${planChannel ?? "未知"}）`);
              }
            }
          }
          if (isRealSid) {
            handle.setKnownSessionId(rawSid);
            // History replay (cwd was read above)
            if (restoredParsed) {
              if (restoredParsed.messages?.length) handle.seedHistory(restoredParsed.messages as never[]);
              // Anchor the watermark at seed time (adopt paths rely on it: see anchorHistoryAtSourceRev)
              handle.anchorHistoryAtSourceRev();
              // Real session model restore (CC-style restore semantics: no broadcast at init, the selector shows it directly):
              // the provider/model ref of the latest assistant message; only applied when no higher-priority source exists.
              // start-plan sessions restore their original model as usual (the user sees them as "known sessions loaded via start",
              // intercepted with a plain-language message on send); other dead channels (expired coding-plan etc.) go through the
              // channelUsable channel-level check and fall back to last-used/default, avoiding seeding 429/1113 dead models (tightened 2026-09-15).
              if (!handle.model && typeof restoredParsed.meta?.model === "string" && parseModelRef(restoredParsed.meta.model)) {
                const pid = restoredParsed.meta.model.split("/")[0];
                if (isStartPlanChannel(pid) || channelUsable(pid)) {
                  handle.model = { id: restoredParsed.meta.model, provider: "zcode" };
                }
              }
            }
          }
          if (!handle.model) {
            const lastUsed = await lastUsedModelRef();
            if (lastUsed) handle.model = lastUsed;
          }
          if (!handle.model) handle.model = { id: seedModelRef(), provider: "zcode" };
          handle.persistModelState();
          // Adopt path: wire the live process + consume the journal replay right away
          // (fail-soft — a runtime/credential resolution failure must not block opening;
          // the next prompt's ensureAppServer/ensureReady retries).
          if (options.attached) {
            void handle.reattachNow().catch((e) =>
              console.warn("[aiti-zcode-agent] adopt warm-up failed (retried on prompt):", e instanceof Error ? e.message : String(e)));
          }
          return handle;
      };
      const lastKey = ctx.sessionProviders.register({
        type: "zcode",
        label: "ZCode CLI (智谱)",
        agentKey: "zcode",
        maxCapabilities: zcodeCapabilities(),
        // Detachable-hosting opt-in (getter: follows the transport — only the long-lived
        // app-server channel can cross restarts; oneshot spawns a fresh process per turn so
        // there is nothing to keep, and the host reads this field dynamically).
        // Effect: the badge's survives-restart option + default nextStartMode, host-side
        // withAgentStarter injection, and post-restart attachDetachedSession finding this
        // provider by agentKey.
        get detachable() { return featureTransport() === "app-server"; },
        // Static catalog (feeds the selector when picking a backend on the new-session page; available without any session) —
        // last-used model first; the frontend selects it by default (first list item), so new sessions default to this agent's last-used model.
        listModels: async () => zcodeCatalog(await lastUsedModelRef()),
        createSession: (options) => createZcodeSession(options as Parameters<typeof createZcodeSession>[0]),
      });
      // Agent descriptor: for dynamic discovery by the agent management surface (aiti-agent-manager) — the manager hard-codes no backend
      ctx.services?.provide?.("aiti-zcode-agent.agent", {
        agent: "zcode",
        label: "ZCode CLI (智谱)",
        modes: ["url"],
        accountQuota: true, // account quota (GET /login/quota; live coding-plan numbers first, plan-status fallback)
        dependencyHint: "ZCode 桌面端 / zcode.cjs runtime",
        auth: [
          { kind: "file", path: [".zcode", "v2", "credentials.json"], label: "~/.zcode/v2/credentials.json" },
          { kind: "env", path: ["ZCODE_API_KEY"], label: "env ZCODE_API_KEY" },
        ],
        accountSlots: (c: { home: string }) => [
          { key: "zcode-credentials", label: "桌面端凭据（加密）", path: join(c.home, ".zcode", "v2", "credentials.json") },
        ],
      });
      // P2 protocol delegation: launch service (same chain as the provider: revival/seed model/state file)
      ctx.services?.provide?.("aiti-zcode-agent.launch", {
        agentKey: "zcode",
        capabilities: zcodeCapabilities(),
        createSessionFromLaunch: (launch: LaunchOverride, options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } }) =>
          createZcodeSession(options, launch),
      });
      console.log(`[aiti-zcode-agent] registered: ${lastKey} (configDir: ${configDir})`);
    },

    /** Controlled-login API (/login/*) + session recycle (/session/recycle, upgrades existing handles to the current code). */
    async api(req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) {
      const recycled = await recycleApi(req, ctx);
      if (recycled) return recycled;
      // Account quota view (live coding-plan numbers first, plan-status fallback)
      // Note: must come before the controlled-login layer — controlled-login swallows the route by returning a 404 Response for unknown /login/* paths
      if (ctx.path[0] === "login" && ctx.path[1] === "quota" && ctx.method === "GET") {
        return quotaView(ctx.searchParams?.get("force") === "1");
      }
      const loginRes = loginApi ? await loginApi(req, ctx) : null;
      if (loginRes) return loginRes;
      return null;
    },

    /** Extension unload/reload: terminates an in-flight login process (the state file is kept; the next status reconcile marks it failed). */
    shutdown() {
      loginCtl?.dispose();
      loginCtl = null;
      loginApi = null;
    },
  },
};
