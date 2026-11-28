/**
 * remote-queue — 远端 pi 协议队列的 queueManage 适配层（共享层，副本随扩展部署——改动须双向同步；
 * docs/aiti-remote-queue-and-sidecar-plan.md §2）。
 *
 * 适用形态：pi RPC 子进程（aiti-pi-agent）与其超集 fork omp（aiti-omp-agent）——队列由
 * 子进程持有，协议原生支持 clear_queue（返回清空前文本，与 pi-web core clearQueue 同契约）
 * 与 steer/follow_up 重注入；子进程经 RPC 流转发 queue_update 帧（含完整文本数组）。
 *
 * Mirror freshness: the mirror is fed only by queue_update frames (observeFrame). A
 * reattach starts empty, and the wrapper journal is a 4 MB ring — a long session's last
 * queue frame is already dropped on replay. adopt() therefore calls hydrate() once: when
 * the child still reports pending messages and no frame was observed yet, the mirror is
 * rebuilt through one clear_queue + re-inject round-trip (the protocol has no list-queue
 * command; get_state carries pendingMessageCount only). Text survives the round-trip,
 * queued images do not — pi's queue text channel never carried them (same semantics as
 * move/remove/convert).
 *
 * 变更类操作语义（与 pi-web core rpc-manager move_queue 同款）：镜像算出新序 →
 * clear_queue 全量清空 → 按新序重注入。运行中 steer 重注入可能被立即消费的竞态
 * 为该策略既有语义（clear+re-enqueue 在单请求内原子性足够）。
 */

export interface RemoteQueueManageReq {
  action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
  kind?: "steer" | "followUp";
  from?: number;
  to?: number;
  index?: number;
  targetKind?: "steer" | "followUp";
  text?: string;
}

export interface RemoteQueueManageResult {
  steering: string[];
  followUp: string[];
  entry?: { text: string };
  /** remove 时返回（对齐 backend-queue / pi-web core QueueTrashItem 的文本字段）。 */
  removed?: { text: string };
}

export interface RemotePiQueue {
  /** handle.onFrame 里喂入子进程帧；只消费 queue_update（镜像维护，不重复广播——原帧由 handle 照常 emit）。 */
  observeFrame(msg: Record<string, unknown>): void;
  /** True while no queue_update was ever observed: the mirror has not been synced with the child yet. */
  needsHydrate(): boolean;
  /** Rebuild the mirror from the child after a reattach (no-op once a queue_update was observed). */
  hydrate(): Promise<void>;
  /** SessionHandle.queueManage 直转发。 */
  queueManage(req: RemoteQueueManageReq): Promise<RemoteQueueManageResult>;
  /** 当前镜像快照（steer/followUp 两组文本）。 */
  snapshot(): { steering: string[]; followUp: string[] };
}

export function createRemotePiQueueSupport(opts: {
  /** 子进程 clear_queue 请求（返回清空前文本；上游不支持时 fail-loud 由调用方人话化）。 */
  clearRemote(): Promise<{ steering?: string[]; followUp?: string[] }>;
  /** 重注入单条（kind=steer → steer 命令；followUp → follow_up 命令）。 */
  reinject(text: string, kind: "steer" | "followUp"): Promise<void>;
}): RemotePiQueue {
  let mirror: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  /** Observed queue_update frames: after a re-inject loop the child's own frames
   *  are the authoritative state (they also carry entries enqueued meanwhile). */
  let frameSeq = 0;
  /** A hydrate() already rebuilt the mirror (covers backends whose clear/re-inject emits no
   *  queue_update at all — frameSeq stays 0 there and must not trigger a second round-trip). */
  let hydrated = false;
  /** Mutation chain: every mutation is clear-all + re-inject, so two of them
   *  interleaved would each wipe the other's entries (and the mirror). */
  let mutationChain: Promise<unknown> = Promise.resolve();

  const snapshot = () => ({ steering: [...mirror.steering], followUp: [...mirror.followUp] });

  /** True while the mirror has never been synchronized with the child (no queue_update observed). */
  const needsHydrate = (): boolean => frameSeq === 0 && !hydrated;

  const observeFrame = (msg: Record<string, unknown>): void => {
    if (msg.type !== "queue_update") return;
    frameSeq += 1;
    mirror = {
      steering: Array.isArray(msg.steering) ? (msg.steering as string[]).map(String) : [],
      followUp: Array.isArray(msg.followUp) ? (msg.followUp as string[]).map(String) : [],
    };
  };

  /** Multiset difference (a − b): entries of `a` not accounted for by `b` (pi queues are
   *  plain text arrays; the same text may legitimately appear twice). */
  const minus = (a: string[], b: string[]): string[] => {
    const left = new Map<string, number>();
    for (const text of b) left.set(text, (left.get(text) ?? 0) + 1);
    const out: string[] = [];
    for (const text of a) {
      const n = left.get(text) ?? 0;
      if (n > 0) left.set(text, n - 1);
      else out.push(text);
    }
    return out;
  };

  /** Run one mutation at a time; a failed turn must not break the chain. */
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const result = mutationChain.then(run, run);
    mutationChain = result.catch(() => undefined);
    return result;
  };

  /**
   * One-shot mirror rebuild after a reattach (pi-web restart / detached-wrapper recovery).
   *
   * A reattached handle starts with an empty mirror and is only fed by queue_update
   * frames. The wrapper journal replays recent frames, but it is a 4 MB ring: on a
   * long-running session the frame that last reported the queue has long been dropped,
   * so the restored handle reports an empty queue until the user queues something new
   * (that frame then carries the full arrays). The RPC protocol has no "list queue"
   * command (get_state carries pendingMessageCount only), so the only way to recover
   * the remaining text is the same clear + re-inject round-trip the mutation actions
   * use. Images do not survive this (pi's queue text channel never carried them —
   * move/remove/convert already share that semantics); callers run it only when the
   * child still reports pending messages AND the mirror was never synced.
   */
  const hydrate = (): Promise<void> => serialized(async () => {
    // A replayed or live frame already synced the mirror while this call was queued.
    if (frameSeq > 0 || hydrated) return;
    const base = snapshot();
    const framesBefore = frameSeq;
    const cleared = await opts.clearRemote();
    const clearedSteering = (cleared.steering ?? []).map(String);
    const clearedFollowUp = (cleared.followUp ?? []).map(String);
    const extras = {
      steering: minus(clearedSteering, base.steering),
      followUp: minus(clearedFollowUp, base.followUp),
    };
    for (const text of extras.steering) await opts.reinject(text, "steer");
    for (const text of extras.followUp) await opts.reinject(text, "followUp");
    // Frames emitted by the clear/re-inject are authoritative; only fall back to the
    // cleared snapshot when this backend emits no queue_update at all.
    if (frameSeq === framesBefore) {
      mirror = { steering: [...extras.steering], followUp: [...extras.followUp] };
    }
    hydrated = true;
  });

  /**
   * Shared skeleton for mutating actions: plan the new order from the mirror,
   * clear the child's queue, then re-inject in that order.
   *
   * The plan runs INSIDE the mutation chain, so it reads the mirror as it is when
   * this mutation actually starts (never a snapshot taken while it was queued).
   *
   * The clear also wipes entries enqueued after the plan's base but before the
   * clear itself (typical: the queue panel's steer-send prompt racing the remove
   * that follows it). They are not in the plan, but clearRemote returns what it
   * really removed — those entries must be re-injected, or the clear silently
   * drops a message.
   *
   * The mirror is not overwritten with the plan at the end: the child emits
   * queue_update on every clear/re-inject, and those frames are authoritative
   * (they also carry entries enqueued while the re-inject loop ran).
   */
  const mutate = <T>(
    plan: (cur: { steering: string[]; followUp: string[] }) => { next: { steering: string[]; followUp: string[] }; result: T },
  ): Promise<T> => serialized(async () => {
    const base = snapshot();
    const { next, result } = plan({ steering: [...base.steering], followUp: [...base.followUp] });
    const framesBefore = frameSeq;
    const cleared = await opts.clearRemote();
    const clearedSteering = (cleared.steering ?? []).map(String);
    const clearedFollowUp = (cleared.followUp ?? []).map(String);
    const extras = {
      steering: minus(clearedSteering, base.steering),
      followUp: minus(clearedFollowUp, base.followUp),
    };
    for (const text of next.steering) await opts.reinject(text, "steer");
    for (const text of extras.steering) await opts.reinject(text, "steer");
    for (const text of next.followUp) await opts.reinject(text, "followUp");
    for (const text of extras.followUp) await opts.reinject(text, "followUp");
    // Fallback for a backend whose clear/re-inject emits no queue_update at all:
    // with frames observed the mirror is already authoritative (do not clobber it).
    if (frameSeq === framesBefore) {
      mirror = {
        steering: [...next.steering, ...extras.steering],
        followUp: [...next.followUp, ...extras.followUp],
      };
    }
    return result;
  });

  const at = (arr: string[], i: number | undefined): number => {
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n >= arr.length) throw new Error("队列索引越界");
    return n;
  };

  const queueManage = async (req: RemoteQueueManageReq): Promise<RemoteQueueManageResult> => {
    if (req.action === "list") return { ...snapshot() };
    switch (req.action) {
      case "clear": {
        // 远端权威清空：返回值 = 清空前文本（即「清掉了什么」，snapshot 语义不适用）
        return await serialized(async () => {
          const framesBefore = frameSeq;
          const cleared = await opts.clearRemote();
          if (frameSeq === framesBefore) mirror = { steering: [], followUp: [] };
          return { steering: (cleared.steering ?? []).map(String), followUp: (cleared.followUp ?? []).map(String) };
        });
      }
      case "remove":
      case "recall": {
        const kind: "steer" | "followUp" = req.kind === "steer" ? "steer" : "followUp";
        const picked = await mutate((cur) => {
          const group = kind === "steer" ? cur.steering : cur.followUp;
          const [removed] = group.splice(at(group, req.index), 1);
          return { next: cur, result: removed };
        });
        const state = snapshot();
        return {
          steering: state.steering,
          followUp: state.followUp,
          entry: { text: picked },
          ...(req.action === "remove" ? { removed: { text: picked } } : {}),
        };
      }
      case "move": {
        await mutate((cur) => {
          const group = req.kind === "steer" ? cur.steering : cur.followUp;
          // Validate both indexes against the pre-move length (pi-web core move_queue semantics)
          const from = at(group, req.from);
          const to = at(group, req.to);
          const [moved] = group.splice(from, 1);
          group.splice(to, 0, moved);
          return { next: cur, result: undefined };
        });
        return snapshot();
      }
      case "requeue": {
        await mutate((cur) => {
          const group = req.kind === "steer" ? cur.steering : cur.followUp;
          const i = Number(req.index);
          const text = String(req.text ?? "");
          if (!Number.isInteger(i) || i < 0 || i > group.length) throw new Error("队列索引越界");
          if (!text.trim()) throw new Error("requeue 需要非空文本");
          group.splice(i, 0, text);
          return { next: cur, result: undefined };
        });
        return snapshot();
      }
      case "convert": {
        const target = req.targetKind === "followUp" ? "followUp" : "steer";
        const kind: "steer" | "followUp" = req.kind === "steer" ? "steer" : "followUp";
        if (target === kind) throw new Error("convert 需要不同于当前的 targetKind");
        const picked = await mutate((cur) => {
          const [moved] = (kind === "steer" ? cur.steering : cur.followUp).splice(at(kind === "steer" ? cur.steering : cur.followUp, req.index), 1);
          (target === "steer" ? cur.steering : cur.followUp).push(moved);
          return { next: cur, result: moved };
        });
        const state = snapshot();
        return { steering: state.steering, followUp: state.followUp, entry: { text: picked } };
      }
      default:
        throw new Error(`queueManage: 未知 action "${String(req.action)}"`);
    }
  };

  return { observeFrame, needsHydrate, hydrate, queueManage, snapshot };
}
