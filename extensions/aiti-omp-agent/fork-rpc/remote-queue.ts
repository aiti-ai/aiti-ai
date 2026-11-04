/**
 * remote-queue — 远端 pi 协议队列的 queueManage 适配层（共享层，副本随扩展部署——改动须双向同步；
 * docs/aiti-remote-queue-and-sidecar-plan.md §2）。
 *
 * 适用形态：pi RPC 子进程（aiti-pi-agent）与其超集 fork omp（aiti-omp-agent）——队列由
 * 子进程持有，协议原生支持 clear_queue（返回清空前文本，与 pi-web core clearQueue 同契约）
 * 与 steer/follow_up 重注入；子进程经 RPC 流转发 queue_update 帧（含完整文本数组）。
 *
 * 镜像正确性：handle 生命周期 == 子进程生命周期，双方同起点（皆空），无重连缺口——
 * 镜像只从 observeFrame 喂入的 queue_update 帧维护。get_state 仅有 pendingMessageCount
 * （无文本），不存在「拉全量」原语，重连场景不在本层适配范围。
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

  const snapshot = () => ({ steering: [...mirror.steering], followUp: [...mirror.followUp] });

  const observeFrame = (msg: Record<string, unknown>): void => {
    if (msg.type !== "queue_update") return;
    mirror = {
      steering: Array.isArray(msg.steering) ? (msg.steering as string[]).map(String) : [],
      followUp: Array.isArray(msg.followUp) ? (msg.followUp as string[]).map(String) : [],
    };
  };

  /** 变更类共用骨架：对镜像副本计算新序 → 远端全量清空 → 按新序重注入 → 镜像落为新序。 */
  const mutate = async (
    plan: (cur: { steering: string[]; followUp: string[] }) => { steering: string[]; followUp: string[] },
  ): Promise<void> => {
    const next = plan(snapshot());
    await opts.clearRemote();
    for (const text of next.steering) await opts.reinject(text, "steer");
    for (const text of next.followUp) await opts.reinject(text, "followUp");
    mirror = { steering: [...next.steering], followUp: [...next.followUp] };
  };

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
        const cleared = await opts.clearRemote();
        mirror = { steering: [], followUp: [] };
        return { steering: (cleared.steering ?? []).map(String), followUp: (cleared.followUp ?? []).map(String) };
      }
      case "remove":
      case "recall": {
        const cur = snapshot();
        const group = req.kind === "steer" ? cur.steering : cur.followUp;
        const [picked] = group.splice(at(group, req.index), 1);
        await mutate(() => cur);
        return {
          steering: cur.steering,
          followUp: cur.followUp,
          entry: { text: picked },
          ...(req.action === "remove" ? { removed: { text: picked } } : {}),
        };
      }
      case "move": {
        const cur = snapshot();
        const group = req.kind === "steer" ? cur.steering : cur.followUp;
        // 两个索引都在删除前对原长度校验（pi-web core move_queue 同款语义）
        const from = at(group, req.from);
        const to = at(group, req.to);
        const [moved] = group.splice(from, 1);
        group.splice(to, 0, moved);
        await mutate(() => cur);
        return { steering: cur.steering, followUp: cur.followUp };
      }
      case "requeue": {
        const cur = snapshot();
        const group = req.kind === "steer" ? cur.steering : cur.followUp;
        const i = Number(req.index);
        const text = String(req.text ?? "");
        if (!Number.isInteger(i) || i < 0 || i > group.length) throw new Error("队列索引越界");
        if (!text.trim()) throw new Error("requeue 需要非空文本");
        group.splice(i, 0, text);
        await mutate(() => cur);
        return { steering: cur.steering, followUp: cur.followUp };
      }
      case "convert": {
        const target = req.targetKind === "followUp" ? "followUp" : "steer";
        const kind = req.kind === "steer" ? "steer" : "followUp";
        if (target === kind) throw new Error("convert 需要不同于当前的 targetKind");
        const cur = snapshot();
        const [picked] = (kind === "steer" ? cur.steering : cur.followUp).splice(at(kind === "steer" ? cur.steering : cur.followUp, req.index), 1);
        (target === "steer" ? cur.steering : cur.followUp).push(picked);
        await mutate(() => cur);
        return { steering: cur.steering, followUp: cur.followUp, entry: { text: picked } };
      }
      default:
        throw new Error(`queueManage: 未知 action "${String(req.action)}"`);
    }
  };

  return { observeFrame, queueManage, snapshot };
}
