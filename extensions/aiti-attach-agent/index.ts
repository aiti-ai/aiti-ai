/**
 * aiti-attach-agent — 会话后端扩展：连接已运行的 agent 进程（socket 附着）。
 *
 * 这是「一切后端皆扩展」原则下的第一个真实后端（从 pi-web 核心 lib/session/attach.ts
 * 迁出）。核心只剩抽象层；本扩展经 ctx.sessionProviders.register() 注册 "attach"
 * 后端，pi TUI 侧的桥扩展 /web 命令 spawn pi-web 时传 --socket <path> 即接入。
 *
 * 使用场景：
 *   - 用户在终端跑 pi TUI，输入 /web；桥扩展 spawn pi-web (detached) 并开 socket；
 *   - 本扩展的 handle 连上 socket：prompt/abort/events 全走线，session 只有一个写者（pi）；
 *   - socket 断开（pi 退出）→ handle 发 session_backend_dead 事件并标记死亡，
 *     Phase 1 显式失败（fail loud）；自动降级为本地接管留给后续版本。
 *
 * 线协议（与 pi rpc-mode 同款 JSONL 帧）：
 *   → {"id":"1","type":"prompt","text":"..."}
 *   ← {"id":"1","type":"response","success":true,"data":...}
 *   ← {"type":"message_update",...}                      （事件帧无 id）
 *
 * 能力面刻意收窄：fork/navigateTree/deleteSession/setActiveTools 需要本地文件操作
 * 或进程内 SDK 对象，跨 socket 不支持（false + 方法内 guard 抛错）。
 */

// ============================================================================
// 结构化契约（镜像宿主 lib/ext/types.ts 与 lib/session/types.ts，out-of-tree 无导入）
// ============================================================================

type Listener = (event: Record<string, unknown>) => void;

interface SessionCapabilitiesLike extends Record<string, boolean> {}

import { findLiveBridgeEntry, readBridgeRegistry } from "./bridge-registry.ts";
import { createSessionRecycleApi } from "@aiti-ai/ext-shared/session-recycle";
import { hostToolAllowed, hostToolsAllowFeature, parseHostToolsAllow, readHostToolsAllow } from "@aiti-ai/ext-shared/host-tools-allow";

interface Socket {
  write(payload: string): boolean;
  once(ev: string, cb: (...args: never[]) => void): void;
  off(ev: string, cb: (...args: never[]) => void): void;
  on(ev: string, cb: (...args: never[]) => void): void;
  destroy(): void;
  destroyed: boolean;
}

function connectSocket(path: string): Promise<Socket> {
  // 动态引 node:net，保持扩展文件顶层零宿主依赖
  return import("node:net").then(
    ({ connect }) =>
      new Promise<Socket>((resolve, reject) => {
        const s = connect(path);
        s.once("error", (err: Error) => {
          s.destroy();
          reject(err);
        });
        s.once("connect", () => resolve(s as unknown as Socket));
      }),
  );
}

// ============================================================================

/** 导出仅供单测直接驱动（宿主 loader 只消费 default 导出）。 */
export class AttachSessionHandle {
  readonly source = "aiti-attach-agent/attach";
  readonly capabilities: SessionCapabilitiesLike;
  readonly id: string;

  private socketPath: string;
  private socket: Socket | null = null;
  private detachReader: (() => void) | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private aliveFlag = false;
  private running = false;
  private model: { id: string; provider: string } | undefined;

  readonly cwd: string;

  constructor(id: string, socketPath: string, cwd = "") {
    this.id = id;
    this.socketPath = socketPath;
    this.cwd = cwd;
    this.capabilities = {
      steer: true,
      followUp: true,
      getMessages: true,
      contextUsage: false, // 桥 get_state 未含 usage
      setModel: true,
      setThinkingLevel: true,
      renameSession: true,
      compact: true,
      executeBash: false,  // TUI 扩展未实现 bash 转发（ExtensionAPI 无对应能力）
      listTools: true,  // attach socket 协议与 pi rpc 同款：无 get_tools（官方 rpc 命令集亦无）；工具列表留在 pi 侧
      getCommands: true,
      fork: false,
      setActiveTools: false,
      navigateTree: false,
      deleteSession: false,
    };
  }

  async connect(): Promise<void> {
    if (this.aliveFlag) return;
    this.socket = await connectSocket(this.socketPath);
    this.aliveFlag = true;
    this.detachReader = this.attachReader(this.socket);
    // 注册推送（合二为一数据流）：attach 建立即把本进程桥上的页面快照推给 pi，
    // pi 据此记录「这些 pageId 的 host=本条 rpc」，后续模型命令按 pageId 路由转发。
    // 无桥/空列表也推（空=告知 pi 本条 rpc 无可转发页面）。
    this.pushPageRegistry();
    this.socket.on("close", (() => this.markDead("socket closed")) as () => void);
    this.socket.on("error", ((err: Error) => this.markDead(`socket error: ${err.message}`)) as () => void);
    // 连接时快照当前模型：pi 已运行中不会再发 model_select，不拉则 handle.model
    // 恒 undefined（底栏显示 "Select model"）。model_select 事件仍负责后续动态更新。
    await this.refreshModelSnapshot();
  }

  private async refreshModelSnapshot(): Promise<void> {
    try {
      const st = await this.request<{ model?: { id: string; provider: string }; isStreaming?: unknown }>({ type: "get_state" });
      if (st?.model) this.model = st.model;
      // 连接播种运行态（2026-09-14 修复）：pi 侧正在跑时，新 handle 此前只靠后续
      // agent_start/end 事件维护 running——连接后到下个 agent_start 之前恒 false。
      // 侧栏桥 watcher（lib/session/bridge-running.ts）连接时会用 get_state.isStreaming
      // 播种，而 handle 不播种 → 同一会话「左侧运行中、右侧打开消息窗显示空闲」
      // （fork 子代理/外部 worker 长工具执行期间必现）。此处与桥 watcher 同口径播种。
      if (st?.isStreaming === true) this.running = true;
    } catch {
      // 快照失败忽略（model_select 事件仍会更新）
    }
  }

  private attachReader(socket: Socket): () => void {
    // 字节累积、按 \n 切 Buffer 后整行 utf8 解码（加固 A1）——逐 chunk toString 会把
    // 跨 chunk 的多字节字符（中文）解码成 U+FFFD。
    let buffer: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer | string) => {
      const c = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = buffer.length === 0 ? c : Buffer.concat([buffer, c]);
      for (;;) {
        const idx = buffer.indexOf(0x0a);
        if (idx === -1) return;
        const line = buffer.subarray(0, idx).toString("utf8");
        buffer = buffer.subarray(idx + 1);
        this.onLine(line);
      }
    };
    socket.on("data", onData as (c: Buffer | string) => void);
    return () => socket.off("data", onData as (c: Buffer | string) => void);
  }

  private markDead(reason: string): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.detachReader?.();
    this.detachReader = null;
    // 显式销毁：只置 null 会让 fd 在本进程残留 → 对端(TUI)仍视为活连接（僵尸），
    // 转发帧写进无人读取的连接 → 120s 静默超时（实机复现）
    try { this.socket?.destroy(); } catch { /* 已死 */ }
    this.socket = null;
    for (const p of this.pending.values()) p.reject(new Error(`[attach] backend dead: ${reason}`));
    this.pending.clear();
    this.emit({ type: "session_backend_dead", reason });
  }

  private onLine(line: string): void {
    if (process.env.AITI_ATTACH_DEBUG) console.log("[aiti-attach-agent] onLine ←", line.slice(0, 120));
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    // 反向 RPC（合二为一架构）：TUI 侧 aiti_* 工具调用经本 socket 转发到
    // pi-web 进程内的桥核心执行——不经 HTTP/鉴权/端口连通性，复用已有 attach 连接。
    // 帧：{id,type:"aiti_bridge_req",tool,args} → 回 {id,type:"response",success,data|error}
    if (msg.type === "aiti_bridge_req" && typeof msg.id === "string") {
      void this.handleAitiBridgeReq(msg);
      return;
    }
    // 页面注册表推送/查询：{type:"aiti_pages"} 无 id = pi 主动请求刷新（预留）；
    // 帧体由本端组装：{type:"aiti_pages", via, pages:[{pageId,title,url}]}
    if (msg.type === "aiti_pages_req") {
      this.pushPageRegistry();
      return;
    }
    if (typeof msg.id === "string" && msg.type === "response") {
      const pending = this.pending.get(msg.id);
      if (!pending) return; // 迟到/已取消的响应 → 静默丢弃（不误派发为事件）
      this.pending.delete(msg.id);
      if (msg.success === true) pending.resolve(msg.data);
      else pending.reject(new Error(String(msg.error ?? "request failed")));
      return;
    }
    if (typeof msg.type === "string") {
      if (msg.type === "agent_start" || msg.type === "turn_start") this.running = true;
      if (msg.type === "agent_settled" || msg.type === "agent_end") this.running = false;
      if (msg.type === "model_select" && msg.model) this.model = msg.model as { id: string; provider: string };
      this.emit(msg);
    }
  }

  /**
   * 处理 TUI 转发的桥工具调用：驱动本进程内桥核心单例执行并原路回包。
   * 桥实例 = globalThis.__aitiBridges 单例表（aiti-devtools 扩展按 dataDir 分 key；
   * 部署形态为单桥，取首个可用即可）。
   */
  private async handleAitiBridgeReq(msg: Record<string, unknown>): Promise<void> {
    const id = String(msg.id);
    const reply = (success: boolean, payload?: unknown) => {
      if (!this.socket || this.socket.destroyed) return;
      this.socket.write(JSON.stringify(
        success ? { id, type: "response", success: true, data: payload }
                : { id, type: "response", success: false, error: String(payload) },
      ) + "\n");
    };
    try {
      // G1 白名单（docs/pi-web-ext-host-tools-gate-plan.md §G1）：缺省只读子集；feature `hostToolsAllow`=* 恢复全量
      const allow = parseHostToolsAllow(readHostToolsAllow("aiti-attach-agent"));
      const toolName = String(msg.tool ?? "");
      if (!hostToolAllowed(toolName, allow)) throw new Error(`host tool not allowed by G1 whitelist: ${toolName}（配置 aiti-attach-agent.hostToolsAllow=* 可恢复全量）`);
      const g = globalThis as { __aitiBridges?: Record<string, { callTool(n: string, a: Record<string, unknown>, s?: unknown, sig?: AbortSignal): Promise<unknown> }> };
      const bridges = g.__aitiBridges ?? {};
      const keys = Object.keys(bridges);
      const bridge = bridges[keys[0]];
      console.log(`[aiti-attach-agent] relay ← ${String(msg.tool)} | 桥实例数=${keys.length} 选=${keys[0]?.slice(-28)} | args=${JSON.stringify((msg.args as Record<string, unknown>) || {})}`);
      if (!bridge || typeof bridge.callTool !== "function") throw new Error("no in-process aiti bridge (aiti-devtools ext not loaded?)");
      const agentKey = String((msg as { agentKey?: unknown }).agentKey ?? "tui-relay");
      const session = () => ({ agentId: agentKey, agentKey, id: this.id, source: "extension" });
      const r = await bridge.callTool(String(msg.tool), ((msg.args as Record<string, unknown>) || {}), session(), undefined) as { content?: Array<{ text?: string }>; isError?: boolean } | null;
      try { console.log(`[aiti-attach-agent] relay → 成功 | ${JSON.stringify(r).slice(0, 220)}`); } catch {}
      // 信封与 HTTP 端点 /bridge/agent/tools/call 完全同形（{ok, result: 文本, isError}），
      // 连接器侧 wrapToolResult 无需感知传输差异；__pages 携带注册表刷新
      const text = (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r);
      reply(true, {
        ok: !(r && r.isError), agentKey,
        result: text, isError: !!(r && r.isError),
        __pages: { via: this.id, pages: this.collectPages() },
      });
    } catch (e) {
      // 传输层成功、工具失败：同样用 ok:false 信封（与 HTTP 语义一致）
      reply(true, { ok: false, error: String(e instanceof Error ? e.message : e), __pages: { via: this.id, pages: this.collectPages() } });
    }
  }

  /**
   * 收集本进程桥单例上的页面快照（bridge_status 同源数据）：
   * globalThis.__aitiBridges 按 dataDir 分 key，部署形态为单桥，取首个可用。
   */
  private collectPages(): Array<{ pageId: string; title?: string; url?: string }> {
    try {
      const g = globalThis as { __aitiBridges?: Record<string, { sessions?(): Array<Record<string, unknown>> }> };
      const bridges = g.__aitiBridges ?? {};
      const bridge = bridges[Object.keys(bridges)[0]];
      if (!bridge || typeof bridge.sessions !== "function") return [];
      return (bridge.sessions() as Array<Record<string, unknown>>).map((s) => ({
        pageId: String(s.pageId ?? ""),
        ...(s.title != null ? { title: String(s.title) } : {}),
        ...(s.url != null ? { url: String(s.url) } : {}),
      })).filter((p) => p.pageId);
    } catch { return []; }
  }

  /** 把本进程桥的页面注册表推给 pi（标记来源 = 本 handle id，供 pi 路由与展示） */
  private pushPageRegistry(): void {
    const pages = this.collectPages();
    console.log(`[aiti-attach-agent] pushPageRegistry: ${pages.length} 页 → ${this.socket ? "socket" : "no-socket"} (via=${this.id})`);
    if (!this.socket || this.socket.destroyed) return;
    const frame = { type: "aiti_pages", via: this.id, pages };
    try { this.socket.write(JSON.stringify(frame) + "\n"); } catch { /* 连接已死 */ }
  }

  private emit(event: Record<string, unknown>): void {
    // 逐监听器隔离（加固 A3）：一个订阅者抛错不得漏帧、不得沿 socket 回调裸抛
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[aiti-attach-agent] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private request<T = unknown>(command: Record<string, unknown>): Promise<T> {
    if (!this.aliveFlag || !this.socket) return Promise.reject(new Error("[attach] not connected"));
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<T>((resolve, reject) => {
      // 应答超时：桥对某命令不应答时请求方不能永久挂起
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`[attach] bridge did not respond to "${command.type}" within 15s`));
        }
      }, 15_000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket!.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  // ---- SessionHandle mandatory core ----------------------------------------
  /** 原始命令通道（raw）：把命令经 socket 帧发给桥，等待 response 数据。 */
  async send(command: Record<string, unknown>): Promise<unknown> {
    return this.request(command);
  }


  async prompt(text: string, options?: { images?: unknown[]; streamingBehavior?: string }): Promise<void> {
    await this.request({
      type: "prompt",
      text,
      ...(options?.images ? { images: options.images } : {}),
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.markDead("disposed");
  }

  alive(): boolean {
    return this.aliveFlag;
  }

  isRunning(): boolean {
    return this.running;
  }

  getModel(): { id: string; provider: string } | undefined {
    return this.model;
  }

  // ---- capability-gated ------------------------------------------------------

  async steer(text: string): Promise<void> {
    await this.request({ type: "steer", text });
  }

  async followUp(text: string): Promise<void> {
    await this.request({ type: "follow_up", text });
  }

  async getMessages(): Promise<unknown[]> {
    const data = (await this.request({ type: "get_messages" })) as { messages?: unknown[] };
    return data.messages ?? [];
  }

  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    await this.request({ type: "set_model", provider: model.provider, modelId: model.id });
    this.model = model;
    return true;
  }

  setThinkingLevel(level: string): void {
    void this.request({ type: "set_thinking_level", level }).catch(() => {});
  }

  async setSessionName(name: string): Promise<void> {
    await this.request({ type: "set_session_name", name });
  }

  async compact(customInstructions?: string): Promise<unknown> {
    return this.request({ type: "compact", customInstructions });
  }

  executeBash(): never {
    throw new Error('Capability "executeBash" is not supported by session backend "aiti-attach-agent/attach"');
  }

  async getAllTools(): Promise<Array<{ name: string; description: string }>> {
    const d = (await this.request({ type: "get_tools" })) as { tools?: Array<{ name: string; description: string }> };
    return d.tools ?? [];
  }

  async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
    const d = (await this.request({ type: "get_commands" })) as { commands?: Array<{ name: string; description?: string; source: string }> };
    return d.commands ?? [];
  }

  /**
   * 队列只读适配（queue keeper）：TUI 桥 get_state 现携带 steering/followUp 排队文本
   * （桥侧镜像合成，queue_update 不进 pi 扩展事件通道）。仅 list —— 桥协议无队列变更
   * 原语（pi 扩展 API 无队列写口），变更动作 fail-loud。方法存在性（非 capability flag）
   * 即接入：handle-adapter get_state.queuedMessages / queue 命令族按 h.queueManage 分流。
   */
  async queueManage(req: { action: string }): Promise<{ steering: string[]; followUp: string[] }> {
    if (req.action !== "list") {
      throw new Error('bridge protocol: queue list only（TUI 队列暂不支持从网页变更）');
    }
    // best-effort：list 失败（TUI 卡死/桥抖动）只降级为空面板，不连坐整个 get_state
    // （否则模型/计时器/用量同步一起丢）；面板靠下一次 queue_update 广播自愈
    try {
      const st = await this.request<{ steering?: unknown; followUp?: unknown }>({ type: "get_state" });
      return {
        steering: Array.isArray(st?.steering) ? (st.steering as string[]) : [],
        followUp: Array.isArray(st?.followUp) ? (st.followUp as string[]) : [],
      };
    } catch {
      return { steering: [], followUp: [] };
    }
  }

  // fail-loud stubs（capabilities 里为 false）
  fork(): never {
    throw new Error('Capability "fork" is not supported by session backend "attach"');
  }
  setActiveTools(): never {
    throw new Error('Capability "setActiveTools" is not supported by session backend "attach"');
  }
  navigateTree(): never {
    throw new Error('Capability "navigateTree" is not supported by session backend "attach"');
  }
  deleteSession(): never {
    throw new Error('Capability "deleteSession" is not supported by session backend "attach"');
  }
}

// ============================================================================
// Extension entry
// ============================================================================

let counter = 0;
let lastKey: string | null = null;

/** 会话 recycle（D8，共享层 session-recycle.ts）：存量 AttachSessionHandle 重连到当前扩展代码。 */
const recycleApi = createSessionRecycleApi({
  isOwn: (h) => typeof (h as { socketPath?: unknown }).socketPath === "string",
  parseId: (id) => {
    if (id.startsWith("__attach__")) return { sessionId: "", providerType: "aiti-attach-agent/attach" };
    // 真实会话 id：createSession 以 sessionId 在桥注册表查活 socket 重连
    return { sessionId: id, providerType: "aiti-attach-agent/attach" };
  },
});

export default {
  id: "aiti-attach-agent",
  name: "Session Attach (socket 附着后端)",
  version: "0.1.0",
  icon: "🔌",

  // G1：aiti_bridge_req 转发的桥工具白名单（缺省只读子集；* = 全量）
  features: [hostToolsAllowFeature()],

  server: {
    startup(ctx: {
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          maxCapabilities: SessionCapabilitiesLike;
          ownsFile?(sessionFile: string): Promise<boolean> | boolean;
          createSession(options: { sessionId?: string; sessionFile?: string; cwd?: string; socketPath?: string }): Promise<AttachSessionHandle>;
        }): string;
      };
      sessionAnnotations: {
        register(annotator: {
          annotate(rows: Array<{ id: string; path?: string; cwd?: string }>): Promise<Record<string, Record<string, unknown>> | void>;
        }): void;
      };
    }) {
      lastKey = ctx.sessionProviders.register({
        type: "attach",
        label: "Attached agent (socket)",
        maxCapabilities: new AttachSessionHandle("cap-probe", "/nonexistent").capabilities,
        // 占用判定：查自家桥注册表（TUI 扩展写入；格式归本扩展所有）
        // 占用判定：查自家桥注册表（TUI 扩展写入；格式归本扩展所有）
        // ⚠️ 必须 await：findLiveBridgeEntry 返回 Promise，不 await 则
        // 「Promise !== undefined」恒真 → 认领一切文件（单写者红线误伤全部 DELETE）
        ownsFile: async (sessionFile) => (await findLiveBridgeEntry(sessionFile)) !== undefined,
        async createSession(options) {
          // socket 解析优先级：显式参数 > 环境变量（PI_WEB_SOCKET）> 桥注册表
          // ⚠ registry key 是 sessionFile 路径（非 uuid）——用 sessionFile 查，
          //   sessionId（uuid）只作 handle.id。核心 attachIfBridged 两者都传。
          let socketPath = options.socketPath ?? process.env.PI_WEB_SOCKET ?? "";
          const registryLookup = options.sessionFile ?? options.sessionId;
          if (!socketPath && registryLookup) {
            socketPath = (await findLiveBridgeEntry(registryLookup))?.socket ?? "";
          }
          if (!socketPath) throw new Error("attach: no bridge socket for this session");
          const id = options.sessionId ?? options.sessionFile ?? `__attach__${++counter}`;
          const handle = new AttachSessionHandle(id, socketPath, options.cwd ?? "");
          await handle.connect();
          if ((options as { model?: { id: string; provider: string } }).model) {
            await handle.setModel((options as { model: { id: string; provider: string } }).model);
          }
          return handle;
        },
      });

      // 会话标注：被 TUI 桥占用的会话行打 tui-bridge 标（数据来自自家注册表）
      ctx.sessionAnnotations.register({
        async annotate(rows) {
          const out: Record<string, Record<string, unknown>> = {};
          if (!rows.length) return out;
          // 先单次读注册表筛出候选（原逐行 findLiveBridgeEntry = N 次 readFile+parse，
          // /api/sessions 千余行时每请求秒级）；候选命中（通常 0～几个）才走完整语义
          //（二次 socket 探活 + 死条目自清）。
          const reg = await readBridgeRegistry();
          const candidates = rows.filter((r) => r.path && reg[r.path]);
          for (const row of candidates) {
            if (await findLiveBridgeEntry(row.path!)) {
              out[row.path!] = { agent: "tui-bridge" };
            }
          }
          return out;
        },
      });

      console.log(`[aiti-attach-agent] registered: ${lastKey}`);
    },

    /** 会话 recycle（/session/recycle）：dispose 旧 socket handle → loopback 重建（查桥注册表重连，D8）。 */
    async api(req: Request, ctx: { path: string[]; method: string }) {
      return recycleApi(req, ctx);
    },
  },
};
