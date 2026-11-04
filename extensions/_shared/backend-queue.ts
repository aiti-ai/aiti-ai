/**
 * backend-queue — 后端会话队列共享实现层（docs/backend-queue-manager-plan.md §3）。
 *
 * 把 aiti-zcode-agent handle 里验证过的「本地 followUp 队列 + steer 镜像 + queueManage
 * 全 action + settle 自动续轮 + user 气泡 + steer 失败降级」抽成组合式 helper：
 * 各后端 handle 以 ≤15 行接入（组合，不改 pi-web core）。
 *
 * ⚠ 权威源：本文件（pi-web-ext/_shared/backend-queue.ts）。部署时复制进各扩展目录
 *   （同 external-cli-governance 先例）——改动须同步全部副本，头部保留本注释。
 *
 * 语义要点：
 *  - 分流（routePrompt）：running + streamingBehavior==="followUp" → 本地队列（可撤回）；
 *    running + steer 注入可用 → steer()（协议相关，可缺省）；steer 失败 → 降级入本地队列
 *    （R9 泛化：消息不丢、不打断原轮、不产生双 settled）；空闲 → dispatch（由 handle 提供，
 *    support 只管队列，发送永远由 handle 执行）。
 *  - 队列条目带图片（{text, images}，闭环 zcode R4）；queue_update wire 仍只传文本
 *    （前端面板无需感知图片）；recall/remove 的 entry/removed 带 hasImages/images 供取回还原。
 *  - settled 轮账本无关：scheduleDrain 由 handle 在 settle/finally 后调用，幂等
 *    （running 中 no-op）——与各后端 settle 时序差异解耦（plan G2）。
 *  - rev 单调版本号（2026-09-18）：queue_update 事件与 queueManage 全结果携带同一
 *    数轴，前端据此丢弃迟到的旧 get_state 快照（竞态覆盖根修，见 BackendQueueManageResult.rev）。
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** 最小图片结构（plan G5：共享层只定义最小形状，handle 侧适配自有 TurnImage）。 */
export interface QueueTurnImageLike {
  data: string;
  mimeType: string;
  filename?: string;
}

/** 本地 followUp 队列条目（R4 闭环：带图片）。 */
export interface BackendQueueEntry {
  text: string;
  images?: QueueTurnImageLike[];
  queuedAt: number;
}

export interface BackendQueueOpts {
  /** 运行中判定（handle 的 running + alive 组合；drain 幂等与分流都依赖它）。 */
  isRunning(): boolean;
  /** 存活判定（可选，缺省恒 true）：dispose 后 drain/dispatch 不再启动。 */
  alive?(): boolean;
  /** 真正的发送（handle.runTurn / prompt 全簿记）——空闲分流与续轮都走这里。 */
  dispatch(text: string, images?: QueueTurnImageLike[]): Promise<void> | void;
  /** wire 事件出口（queue_update 广播 / user 气泡 message_end）。 */
  onEvent(ev: Record<string, unknown>): void;
  /**
   * 运行中注入（协议相关，可选）。缺省 = 不支持 steer：运行中发送一律本地排队
   * （降级语义收敛到面板，而不是静默丢消息——plan §1.3）。
   * 服务端 steer 镜像由 handle 在协议事件回调里调 registerSteer/drainSteer 喂入。
   */
  steer?(text: string, images?: QueueTurnImageLike[]): Promise<void> | void;
  /** 降级/异常提示（可缺省）。 */
  log?(msg: string): void;
  /**
   * 崩溃恢复 sidecar（可选，docs/aiti-remote-queue-and-sidecar-plan.md §3）：挂上后
   * pending 队列跨进程重启可恢复（恢复项 settle 后照常自动续轮发出——排队=要发的意图）；
   * dispose = 会话正常关闭 → remove() 丢弃。用 createQueueFilePersistence() 构建文件实现。
   */
  persistence?: BackendQueuePersistence;
}

/** 队列持久化口（save/load/remove 全同步小文件写；实现须原子写——tmp+rename，Windows 兼容 §0）。 */
export interface BackendQueuePersistence {
  save(entries: BackendQueueEntry[]): void;
  load(): BackendQueueEntry[];
  remove(): void;
}

const QUEUE_SIDECAR_VERSION = 1;
/** sidecar 残留清理阈值：崩溃恢复窗口 7 天（同 pi-web agent sessions 清理 TTL）。 */
const QUEUE_SIDECAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * sidecar 文件名：Windows 上冒号是 NTFS ADS 流分隔符——`claude:new-1.json` 会写成
 * 基名 `claude` + 匿名流（rename/existsSync 语义全乱，教训见 backend-queue.test）。
 * win32 把 id 中的冒号替换为 `_`；调用方（createQueueFilePersistence 的 getFile）
 * 必须用同一函数，否则迁移/恢复互不认识。
 */
export function sidecarFileName(id: string): string {
  const safe = process.platform === "win32" ? id.replace(/:/g, "_") : id;
  return `${safe}.json`;
}

/**
 * 文件版队列持久化（<stateDir>/queues/<sessionId>.json）。getFile 惰性求值——
 * 扩展 handle 以 field 初始化器构建 support、文件路径在 ctor body 才能确定，
 * 惰性闭包同时规避 init 顺序问题与「未传路径 = 不持久化」的缺省语义。
 */
export function createQueueFilePersistence(
  getFile: () => string | undefined,
  log?: (msg: string) => void,
): BackendQueuePersistence {
  const read = (): BackendQueueEntry[] => {
    const file = getFile();
    if (!file || !existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: number; entries?: BackendQueueEntry[] };
      if (raw.version !== QUEUE_SIDECAR_VERSION || !Array.isArray(raw.entries)) return [];
      return raw.entries.filter((e) => e && typeof e.text === "string" && typeof e.queuedAt === "number");
    } catch (e) {
      log?.(`[backend-queue] sidecar 读取失败（忽略恢复）: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };
  /** 事件驱动的残留清理（非轮询）：只在 save 时顺手扫一次同目录，删 >7 天的旧 sidecar。 */
  const prune = (dir: string): void => {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const p = join(dir, name);
        try {
          if (Date.now() - statSync(p).mtimeMs > QUEUE_SIDECAR_TTL_MS) rmSync(p, { force: true });
        } catch { /* 单文件失败不影响其余 */ }
      }
    } catch { /* 目录不存在等 */ }
  };
  return {
    save(entries) {
      const file = getFile();
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: QUEUE_SIDECAR_VERSION, entries }) + "\n");
        renameSync(tmp, file);
        prune(dirname(file));
      } catch (e) {
        log?.(`[backend-queue] sidecar 写入失败（队列照常，仅崩溃恢复受损）: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    load: read,
    remove() {
      const file = getFile();
      if (!file) return;
      try { rmSync(file, { force: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * id 换绑时迁移队列 sidecar（占位 id → 真实 id）：各 handle 走「懒持久化」模式——真实
 * 会话 id 在首个后端帧才出现（claude system/init、zcode/codebuddy rebindSessionId、
 * codex thread.started、cursor extractChatId），此前排队的条目落在随机占位 id 文件里，
 * 不迁移则崩溃恢复永远找不到（只能等 7 天 prune）。与 renameExtModelState 状态文件
 * 换绑同构，在各 handle 真实 id 捕获点调用。acp 无此窗口（id 在宿主拿到 handle 前
 * 同步赋真实值）。
 */
export function migrateQueueSidecar(
  dir: string | undefined,
  fromId: string,
  toId: string,
  log?: (msg: string) => void,
): void {
  if (!dir || !fromId || !toId || fromId === toId) return;
  try {
    const from = join(dir, "queues", sidecarFileName(fromId));
    if (!existsSync(from)) return;
    const to = join(dir, "queues", sidecarFileName(toId));
    // Windows renameSync 不覆盖已有目标：先删（迁移内容 ⊆ 内存 pending，最终以内存 save 为准）
    if (existsSync(to)) rmSync(to, { force: true });
    renameSync(from, to);
    log?.(`[backend-queue] sidecar 随 id 换绑迁移: ${fromId} → ${toId}`);
  } catch (e) {
    log?.(`[backend-queue] sidecar 迁移失败（忽略，崩溃恢复降级）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface BackendQueueRouteOpts {
  images?: QueueTurnImageLike[];
  streamingBehavior?: "steer" | "followUp";
}

export interface BackendQueueManageReq {
  action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
  kind?: "steer" | "followUp";
  from?: number;
  to?: number;
  index?: number;
  targetKind?: "steer" | "followUp";
  text?: string;
}

export interface BackendQueueManageResult {
  steering: string[];
  followUp: string[];
  /**
   * 队列内容单调版本号（跨仓契约，pi-web useAgentSession 消费）：任意一次内容变化后
   * 递增，queue_update 事件与 queueManage/get_state 快照同源携带同一数轴。前端据此
   * 丢弃乱序/迟到的旧快照（异步 get_state 响应与实时 queue_update 竞态覆盖——
   * 2026-09-18 「队列条目不显示直到手动刷新」根因修复）。
   */
  rev: number;
  entry?: { text: string; images?: QueueTurnImageLike[] };
  /** remove 的 QueueTrashItem 形状（pi-web core SessionHandle.queueManage 契约）。 */
  removed?: { id: string; kind: string; text: string; hasImages: boolean; queuedAt: number };
}

export interface BackendQueue {
  /** prompt 入口分流（handle 仅在 running 时调用；空闲分支供 steer/followUp 能力方法直达 dispatch）。 */
  routePrompt(text: string, opts?: BackendQueueRouteOpts): Promise<"dispatched" | "queued" | "steered">;
  /** 运行中入本地队列（settle 后自动续轮，可撤回）；空闲等同 dispatch。 */
  enqueueFollowUp(text: string, images?: QueueTurnImageLike[]): void;
  /** @capability queueManage（SessionHandle.queueManage 直接转发至此）。 */
  queueManage(req: BackendQueueManageReq): Promise<BackendQueueManageResult>;
  /** 服务端 steer 镜像喂入（zcode：steerQueued/steerDrained/steerDiscarded 事件；其他后端可缺省不喂）。 */
  registerSteer(pendingInputId: string, input: string): void;
  drainSteer(pendingInputIds: string[]): void;
  clearSteerMirror(): void;
  /** settle 后由 handle 调（finally / agent_settled）——幂等，running 中 no-op。 */
  scheduleDrain(): void;
  /** 向前端同步排队区（queue_update 契约：steering/followUp 两组文本）。 */
  emitUpdate(): void;
  /** user 气泡（message_end role=user，blocks content——adapter string 防御已兼容）。 */
  userBubble(text: string): void;
  snapshot(): { steering: string[]; followUp: string[] };
  /** 清 pending + 镜像 + 停止未决续轮。 */
  dispose(): void;
}

export function createBackendQueueSupport(opts: BackendQueueOpts): BackendQueue {
  const alive = () => (opts.alive ? opts.alive() : true);
  /** 本地 followUp 队列（带图片，R4 闭环）。 */
  let pending: BackendQueueEntry[] = [];
  /** 服务端 steer 队列镜像（已交给后端、尚未 drain 的输入；全量快照，只读展示）。 */
  let steerMirror: Array<{ pendingInputId: string; input: string }> = [];
  /** 队列内容版本号（emitUpdate 即变化出口，每次递增；快照读取不递增）。 */
  let rev = 0;
  let disposed = false;
  /** sidecar 恢复懒加载标记（ensureRestored 幂等；规避 field 初始化早于 ctor 的顺序问题）。 */
  let restored = false;
  const persist = (): void => { try { opts.persistence?.save(pending); } catch { /* 持久化不阻塞队列 */ } };
  /** 恢复：崩溃前排队的条目回到队首（当前进程内尚未入队任何条目，实际即整队还原）。 */
  const ensureRestored = (): void => {
    if (restored || disposed) return;
    restored = true;
    try {
      const saved = opts.persistence?.load() ?? [];
      if (saved.length > 0) {
        pending = [...saved.filter((e) => !pending.some((p) => p.queuedAt === e.queuedAt && p.text === e.text)), ...pending];
        opts.log?.(`[backend-queue] sidecar 恢复 ${saved.length} 条排队消息`);
        emitUpdate();
      }
    } catch { /* 恢复失败不阻塞队列 */ }
  };

  const snapshot = () => ({
    steering: steerMirror.map((s) => s.input),
    followUp: pending.map((e) => e.text),
  });

  const emitUpdate = (): void => {
    rev += 1;
    opts.onEvent({ type: "queue_update", rev, ...snapshot() });
  };

  const enqueueFollowUp = (text: string, images?: QueueTurnImageLike[]): void => {
    ensureRestored();
    pending.push({ text, ...(images && images.length ? { images } : {}), queuedAt: Date.now() });
    persist();
    emitUpdate();
  };

  /** steer 失败降级（R9 泛化）：转回本地 followUp 队列——消息不丢、不打断原轮。 */
  const degradeToQueue = (text: string, images?: QueueTurnImageLike[], reason?: unknown): void => {
    opts.log?.(`[backend-queue] steer 发送失败，转本地队列待续轮: ${reason instanceof Error ? reason.message : String(reason ?? "")}`);
    enqueueFollowUp(text, images);
  };

  const routePrompt = async (
    text: string,
    routeOpts?: BackendQueueRouteOpts,
  ): Promise<"dispatched" | "queued" | "steered"> => {
    if (opts.isRunning()) {
      // followUp：本地持有（queue keeper 可撤回/排序），settle 后自动续轮
      if (routeOpts?.streamingBehavior === "followUp") {
        enqueueFollowUp(text, routeOpts?.images);
        return "queued";
      }
      // steer / 缺省：运行中注入可用则注入（镜像由 handle 经协议事件喂入）；失败降级本地队列
      if (opts.steer) {
        try {
          await opts.steer(text, routeOpts?.images);
          return "steered";
        } catch (e) {
          degradeToQueue(text, routeOpts?.images, e);
          return "queued";
        }
      }
      enqueueFollowUp(text, routeOpts?.images);
      return "queued";
    }
    // 空闲：直接开新轮（dispatch 闭包 = handle 的完整簿记入口，如 prompt()）
    await opts.dispatch(text, routeOpts?.images);
    return "dispatched";
  };

  const at = (i: number | undefined): number => {
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n >= pending.length) throw new Error("队列索引越界");
    return n;
  };

  const queueManage = async (req: BackendQueueManageReq): Promise<BackendQueueManageResult> => {
    ensureRestored();
    if (req.action === "list") return { ...snapshot(), rev };
    const kind = req.kind ?? "followUp";
    if (kind === "steer") {
      throw new Error("该条目已注入后端服务端 steer 队列（当前轮工具间隙自动消费），协议不支持撤回/移动；如需取消请停止本轮（stop）");
    }
    let entry: BackendQueueEntry | undefined;
    /** clear 前暂存被清空的 followUp 文本——pi clearQueue() 契约返回「被清掉的内容」，
     * 前端「全部编辑」（recallAll）靠它回填输入框；漏存会静默丢消息（2026-09-16 实测）。 */
    let clearedFollowUp: string[] | undefined;
    switch (req.action) {
      case "clear": {
        clearedFollowUp = pending.map((e) => e.text);
        pending = [];
        break;
      }
      case "move": {
        const from = at(req.from);
        const to = at(req.to);
        const [moved] = pending.splice(from, 1);
        pending.splice(to, 0, moved);
        break;
      }
      case "remove":
      case "recall": {
        const i = at(req.index);
        entry = pending.splice(i, 1)[0];
        break;
      }
      case "requeue": {
        const i = Number(req.index);
        const text = String(req.text ?? "");
        if (!Number.isInteger(i) || i < 0 || i > pending.length) throw new Error("队列索引越界");
        if (!text.trim()) throw new Error("requeue 需要非空文本");
        pending.splice(i, 0, { text, queuedAt: Date.now() });
        break;
      }
      case "convert": {
        const i = at(req.index);
        const target = req.targetKind ?? "steer";
        if (target === "followUp") break; // 已在 followUp 组，no-op
        if (opts.isRunning() && opts.steer) {
          // 原生 steer 可用：取出并立即注入
          const picked = pending.splice(i, 1)[0];
          try {
            await opts.steer(picked.text, picked.images);
          } catch (e) {
            degradeToQueue(picked.text, picked.images, e);
          }
        } else if (opts.isRunning()) {
          // 无原生 steer：插队 = 移到队首（settle 后 scheduleDrain 优先续轮发出）。
          // zcode 3.11.2 协议 steer 实测不投递（2026-09-10 探针，见 handle steer:false 注释），
          // 本地队首是协议下唯一能兑现的插队语义。
          const [picked] = pending.splice(i, 1);
          pending.unshift(picked);
        } else {
          // 空闲：开新轮
          const picked = pending.splice(i, 1)[0];
          await opts.dispatch(picked.text, picked.images);
        }
        break;
      }
      default:
        throw new Error(`queueManage: 未知 action "${req.action}"`);
    }
    persist();
    emitUpdate();
    // 空闲且有排队的边角（convert/clear 后 settle 已过）：不动——空闲入队由调用方的 scheduleDrain 负责
    return {
      ...snapshot(),
      // 变更类 action 的 rev 在 emitUpdate 里已递增——此处读取即变更后版本，与刚发的
      // queue_update 同值；前端据此判定 RPC 结果与事件流的先后。
      rev,
      // clear：followUp 报「清空前」的内容（snapshot 已空）——对齐 pi clearQueue 返回约定
      ...(clearedFollowUp ? { followUp: clearedFollowUp } : {}),
      ...(entry
        ? {
            entry: { text: entry.text, ...(entry.images ? { images: entry.images } : {}) },
            // remove → QueueTrashItem（pi-web core 契约；recall 只有 entry）
            ...(req.action === "remove"
              ? {
                  removed: {
                    id: `fu-${entry.queuedAt}`,
                    kind: "followUp",
                    text: entry.text,
                    hasImages: !!(entry.images && entry.images.length),
                    queuedAt: entry.queuedAt,
                  },
                }
              : {}),
          }
        : {}),
    };
  };

  const registerSteer = (pendingInputId: string, input: string): void => {
    if (pendingInputId && input && !steerMirror.some((s) => s.pendingInputId === pendingInputId)) {
      steerMirror.push({ pendingInputId, input });
      emitUpdate();
    }
  };

  const drainSteer = (pendingInputIds: string[]): void => {
    const before = steerMirror.length;
    steerMirror = steerMirror.filter((s) => !pendingInputIds.includes(s.pendingInputId));
    if (steerMirror.length !== before) emitUpdate();
  };

  const clearSteerMirror = (): void => {
    if (steerMirror.length) {
      steerMirror = [];
      emitUpdate();
    }
  };

  /** settle 后自动续轮（followUp 队列排空；幂等——running 中直接返回）。
   *  微任务让 agent_settled 先到达前端（流式状态复位）再开新一轮（zcode 实测模式）。 */
  const scheduleDrain = (): void => {
    if (disposed || !alive() || opts.isRunning()) return;
    ensureRestored();
    const next = pending.shift();
    persist();
    emitUpdate();
    if (next) {
      queueMicrotask(() => {
        if (disposed || !alive()) return;
        void Promise.resolve(opts.dispatch(next.text, next.images)).catch((e) => {
          opts.log?.(`[backend-queue] 续轮 dispatch 失败: ${e instanceof Error ? e.message : String(e)}`);
        });
      });
    }
  };

  const userBubble = (text: string): void => {
    opts.onEvent({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    });
  };

  const dispose = (): void => {
    disposed = true;
    pending = [];
    steerMirror = [];
    // 会话正常关闭：崩溃恢复 sidecar 一并丢弃（崩溃时未走到这里 → sidecar 留待恢复）
    try { opts.persistence?.remove(); } catch { /* best effort */ }
  };

  return {
    routePrompt,
    enqueueFollowUp,
    queueManage,
    registerSteer,
    drainSteer,
    clearSteerMirror,
    scheduleDrain,
    emitUpdate,
    userBubble,
    snapshot,
    dispose,
  };
}
