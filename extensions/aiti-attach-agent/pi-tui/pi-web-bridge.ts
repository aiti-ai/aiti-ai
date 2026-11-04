/**
 * pi-web-bridge — pi TUI 扩展：/web 命令把当前会话桥接到浏览器。
 *
 * 这是多 agent 前端链路的 TUI 侧端点（与 pi-web-ext/aiti-attach-agent 配对）：
 *
 *   /web 命令
 *     1. 创建 Unix Socket JSONL 服务（协议 = aiti-attach-agent 所说）
 *        命令：prompt/steer/follow_up/abort/get_state/get_messages/
 *              set_model/set_thinking_level/compact/set_session_name/get_commands
 *        get_state 额外携带 steering/followUp 排队文本（镜像）；
 *        排队回显：queue_update 不进扩展事件通道（pi 上游限制），桥镜像合成广播
 *        （入队=本桥 prompt/steer/follow_up 忙时，出队=message_start(user)，见 broadcastQueueUpdate）
 *     2. 转发全部 agent 事件（message_* / tool_* / agent_* / turn_* / model_select…）
 *     3. detached spawn pi-web（PI_WEB_SOCKET=sockPath），pi 退出它不死
 *        （不启动：最后一页选「不启动」或 CLI --no-spawn，复用已运行实例）
 *     4. 提示用户打开浏览器 URL
 *
 * 会话所有权：唯一写入者仍是 pi 进程（本扩展只读 ctx/pi API，不碰文件），
 * 无 session 争抢。pi 退出 → socket 断开 → pi-web 端显示已断开。
 *
 * 自动桥（env PI_WEB_BRIDGE_AUTO=1，session_start 自动执行，免 /web 命令）：
 *   - CLI 全自动：普通终端 pi 会话（无 pi-web 宿主标记）起动即自动 attach 桥，
 *     dev/prod 任一 pi-web 实例都能打开该会话（All Sessions 带 tui-bridge 标），
 *     实时查看 + 双向 IO。可选 PI_WEB_BRIDGE_BASE 指向已运行 pi-web（aiti_* 工具
 *     路由 / URL 推导用；attach 本身走 bridge-registry.json，不依赖该地址）。
 *   - 子代理自动（§5.4）：pi-web 宿主 spawn 注入 + PI_SUBAGENT_CHILD=1，同款行为。
 *   - pi-web 内嵌进程（PI_WEB_CHILD_MARKER）：永不自动桥/注册 /web（已在 web 里）。
 *
 * 安装：cp 本文件 ~/.pi/agent/extensions/pi-web-bridge.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, type Server, type Socket } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
// 共享桥注册表（同包 ../bridge-registry.ts；安装为目录扩展时随目录部署）
import { registerBridge, unregisterBridge, bridgeSocketName } from "../bridge-registry";

// ── 协议常量（与 aiti-attach-agent 对齐）────────────────────────────────
const FORWARDED_EVENTS = [
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "agent_start", "agent_end", "agent_settled",
  "turn_start", "turn_end",
  "model_select", "thinking_level_select",
  "session_info_changed",
];

// 桥注册表共享模块（同包 ../bridge-registry.ts）：TUI 写 / Web 读，格式单一所有

// ── 文案 i18n（pi 扩展层无 i18n 机制，自建最小字符串表）────────────────
// 语言：env PI_WEB_BRIDGE_LANG=z h|en 显式指定 > LC_ALL/LANG/LANGUAGE 以
// "zh" 开头 → 中文；否则英文。进程启动时确定，运行期不变。
type BridgeLang = "zh" | "en";
function detectBridgeLang(): BridgeLang {
  const explicit = (process.env.PI_WEB_BRIDGE_LANG || "").trim().toLowerCase();
  if (explicit === "en" || explicit === "zh") return explicit;
  const lc = process.env.LC_ALL || process.env.LANG || process.env.LANGUAGE || "";
  return /^zh/i.test(lc.trim()) ? "zh" : "en";
}
const ZH_M = {
  customArgsTitle: "自定义参数（可留空直接回车；示例：--base https://pi.example.com:8443/dev ｜ --domain pi.example.com --scheme https）",
  modeTitle: "启动方式",
  modeTakeover: "接管（不起桥：pi-web 内部跑 pi SDK 接手本会话，TUI 不再输入）",
  modeAttach: "attach（起 rpc 桥：pi-web 经 attach 连本会话，IO 转发一起工作）",
  finalTitle: "pi-web 服务（最后一步）",
  finalSpawnOpen: "启动并打开浏览器",
  finalSpawnNoOpen: "只启动，不打开浏览器",
  finalNoSpawn: "不启动（连接已在运行的 pi-web）",
  addrInput: "已有 pi-web 地址（留空回车 = 按 --port/env 推导 http://127.0.0.1:<port>）",
  stopped: "pi-web bridge stopped（pi-web 与 rpc 已关闭）",
  notRunning: "pi-web bridge not running",
  runningTitle: (u: string) => `pi-web bridge 已运行 → ${u}`,
  openBrowser: "打开浏览器",
  noOpenBrowser: "不打开浏览器",
  showInfo: "显示连接信息（URL + 执行的参数）",
  stop: "停止（关闭 pi-web 与 rpc）",
  stillRunning: (u: string) => `桥仍运行中：${u}`,
  infoMsg: (u: string, c: string) => `pi-web bridge: ${u}\n执行的参数：${c}`,
  alreadyRunning: (p: string) => `pi-web bridge already running: ${p}`,
  noSession: "no persisted session to bridge (send a message first)",
  attached: (u: string) => `pi-web attached → ${u}（IO 沿桥转发，一起工作）`,
  takeoverDone: (u: string) => `pi-web 接管 → ${u}（本会话已移交浏览器操作；TUI 请退出本会话避免双写）`,
  lastCommandLabel: "\n执行的参数：",
  idleShutdown: (min: string) => `自动桥空闲超时（${min} 分钟无活动），退出本会话——PI_WEB_IDLE_TIMEOUT_MS 可调，0 禁用`,
};
const EN_M: typeof ZH_M = {
  customArgsTitle: "Custom args (Enter to skip; e.g. --base https://pi.example.com:8443/dev | --domain pi.example.com --scheme https)",
  modeTitle: "Start mode",
  modeTakeover: "Takeover (no bridge: pi-web runs pi SDK in-process; TUI stops accepting input)",
  modeAttach: "Attach (rpc bridge: pi-web attaches to this session; IO forwarded, work together)",
  finalTitle: "pi-web server (final step)",
  finalSpawnOpen: "Spawn new + open browser",
  finalSpawnNoOpen: "Spawn new, don't open browser",
  finalNoSpawn: "Don't spawn (connect to an already-running pi-web)",
  addrInput: "Existing pi-web URL (empty Enter = derive from --port/env as http://127.0.0.1:<port>)",
  stopped: "pi-web bridge stopped (pi-web & rpc closed)",
  notRunning: "pi-web bridge not running",
  runningTitle: (u: string) => `pi-web bridge already running → ${u}`,
  openBrowser: "Open browser",
  noOpenBrowser: "Don't open browser",
  showInfo: "Show connection info (URL + executed args)",
  stop: "Stop (close pi-web & rpc)",
  stillRunning: (u: string) => `Bridge still running: ${u}`,
  infoMsg: (u: string, c: string) => `pi-web bridge: ${u}\nExecuted as: ${c}`,
  alreadyRunning: (p: string) => `pi-web bridge already running: ${p}`,
  noSession: "no persisted session to bridge (send a message first)",
  attached: (u: string) => `pi-web attached → ${u} (IO forwarded over the bridge, work together)`,
  takeoverDone: (u: string) => `pi-web takeover → ${u} (session handed to the browser; exit this TUI session to avoid double writes)`,
  lastCommandLabel: "\nExecuted as: ",
  idleShutdown: (min: string) => `Auto-bridge idle timeout (${min} min), exiting this session — set PI_WEB_IDLE_TIMEOUT_MS to adjust, 0 to disable`,
};
const S = ({ zh: ZH_M, en: EN_M })[detectBridgeLang()];

/** 解析 /web 参数：--port 30146 / --no-open / --open / --no-spawn / --spawn */
function parseWebArgs(raw: string): {
  hasArgs: boolean;
  open?: boolean;
  spawn?: boolean;
  port?: string;
  basePath?: string;
  base?: string;
  scheme?: string;
  domain?: string;
  webport?: string;
  takeover?: boolean;
} {
  const out: ReturnType<typeof parseWebArgs> = { hasArgs: false };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return out;
  out.hasArgs = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => {
      const v = tokens[i + 1];
      if (v && !v.startsWith("--")) { i++; return v; }
      return undefined;
    };
    if (t === "--port") { const v = next(); if (v) out.port = v; }
    else if (t === "--base") { const v = next(); if (v) out.base = v; }
    else if (t === "--basepath" || t === "--url") { const v = next(); if (v) out.basePath = v; }
    else if (t === "--scheme") { const v = next(); if (v) out.scheme = v; }
    else if (t === "--domain" || t === "--host") { const v = next(); if (v) out.domain = v; }
    else if (t === "--webport") { const v = next(); if (v) out.webport = v; }
    else if (t === "--takeover") out.takeover = true;
    else if (t === "--attach") out.takeover = false;
    else if (t === "--no-open") out.open = false;
    else if (t === "--open") out.open = true;
    else if (t === "--no-spawn") out.spawn = false;
    else if (t === "--spawn") out.spawn = true;
    // 未知 token 忽略（宽容处理，不炸用户输入）
  }
  return out;
}

/**
 * 解析对外 URL 前缀，优先级：
 *   1) --base / --url / 含 "://" 的 --basepath / env PI_WEB_BASE_PATH（整前缀）
 *   2) --domain（+ --scheme / --webport / --basepath 路径）组合
 *   3) 空 → 调用方回退本地 http://127.0.0.1:<port>/
 */
function resolveBridgeBase(flags: { base?: string; url?: string; basePath?: string; scheme?: string; domain?: string; webport?: string }): string {
  const whole = flags.base || flags.url
    || (flags.basePath && flags.basePath.includes("://") ? flags.basePath : undefined)
    || process.env.PI_WEB_BASE_PATH;
  if (whole) return whole.replace(/\/+$/, "");
  const scheme = flags.scheme || "http";
  if (flags.domain) {
    const host = flags.domain.includes(":") ? flags.domain : flags.domain + (flags.webport ? `:${flags.webport}` : "");
    const path = flags.basePath ? "/" + flags.basePath.replace(/^\/+|\/+$/g, "") : "";
    return `${scheme}://${host}${path}`;
  }
  return "";
}

/**
 * 把 URL 前缀配置贯通到 spawn 的 pi-web 进程：
 *   - PI_WEB_BASE_DOMAIN / PI_WEB_ALLOWED_HOSTS ← 对外域名（防 DNS rebinding 403）
 *   - PI_WEB_BASE_PATH ← 子路径（next dev / PI_WEB_BUILD_BASEPATH 构建时生效）
 * 仅配置 URL 文本时并不生效，缺这层浏览器经反代访问会被拒。
 */
function applyBridgeDomainEnv(flags: { base?: string; url?: string; basePath?: string; domain?: string }, env: Record<string, string>): void {
  try {
    const whole = flags.base || flags.url
      || (flags.basePath && flags.basePath.includes("://") ? flags.basePath : undefined);
    const u = whole ? new URL(whole) : flags.domain ? new URL(`http://${flags.domain}`) : null;
    if (u) {
      const host = u.host;
      const hostOnly = host.split(":")[0];
      env.PI_WEB_BASE_DOMAIN = host;
      // 反代 Host 头可能带端口也可能不带，两个都放行（防 DNS rebinding 误杀）
      env.PI_WEB_ALLOWED_HOSTS = host === hostOnly ? host : `${host},${hostOnly}`;
      if (u.pathname && u.pathname !== "/") env.PI_WEB_BASE_PATH = u.pathname.replace(/\/+$/, "");
    }
  } catch {
    /* 解析失败忽略：URL 文本仍按 resolveBridgeBase 原逻辑生成 */
  }
}

function openBrowser(url: string): void {
  if (platform() === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else if (platform() === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export default function (pi: ExtensionAPI) {
  // ── 自动桥模式（aiti fork，§5.4 + CLI 全自动）────────────────────────
  // 开关 = PI_WEB_BRIDGE_AUTO=1，按进程身位分两种自动：
  // ① HEADLESS_AUTO（子代理）：pi-web 宿主注入（instrumentation.ts，spawn env 透传）
  //    + PI_SUBAGENT_CHILD=1（上游 pi-args 给每个子代理进程打的标记）。
  //    须越过守卫——子代理 spawn env 带 PI_WEB_SOCKET 等宿主标记。
  // ② CLI_AUTO（CLI 全自动）：用户 shell profile 导出 PI_WEB_BRIDGE_AUTO=1，
  //    普通终端 pi 会话（含 -c/--resume）起动即自动起桥。判别关键 =
  //    PI_WEB_CHILD_MARKER（pi-web instrumentation 给自身+所有子进程打的戳）：
  //    CLI 会话绝无此戳，pi-web 内嵌/其子进程必有。
  // 自动行为 = 等价「/web --attach --no-spawn --no-open」：无向导、无浏览器，
  // 起桥写 bridge-registry → pi-web 打开该 session 即 attach（不独占、双向 IO）。
  const AUTO_ENV = process.env.PI_WEB_BRIDGE_AUTO === "1";
  const SUBAGENT_CHILD = process.env.PI_SUBAGENT_CHILD === "1";
  const IN_PI_WEB_HOST = process.env.PI_WEB_CHILD_MARKER !== undefined;
  const HEADLESS_AUTO = AUTO_ENV && SUBAGENT_CHILD;                    // ① 子代理
  const CLI_AUTO = AUTO_ENV && !SUBAGENT_CHILD && !IN_PI_WEB_HOST;     // ② CLI 全自动
  const AUTO_BRIDGE = HEADLESS_AUTO || CLI_AUTO;
  // pi-web 内嵌 agent（方案 M / spawn 后端）也会从 ~/.pi/agent/extensions 加载本扩展——
  // 但那里没有 TUI，/web 会泄漏进 pi-web AI 页面输入的命令列表（dev/prod 实测可见）。
  // 宿主判定 = PI_WEB_CHILD_MARKER 或其余 PI_WEB_* env。⚠ PI_WEB_BRIDGE_* 与
  // PI_WEB_IDLE_TIMEOUT_MS 是本扩展的用户配置命名空间（shell 里合法导出），不算宿主标记
  // ——否则 CLI_AUTO 自我排除（PI_WEB_IDLE_TIMEOUT_MS 实锤踩过：设了它自动桥直接不注册）。
  const HOST_ENV = Object.keys(process.env).some(
    (k) => k.startsWith("PI_WEB_")
      && k !== "PI_WEB_BRIDGE_AUTO" && k !== "PI_WEB_BRIDGE_BASE"
      && k !== "PI_WEB_BRIDGE_PORT" && k !== "PI_WEB_BRIDGE_LANG"
      && k !== "PI_WEB_IDLE_TIMEOUT_MS",
  );
  if (!HEADLESS_AUTO && (IN_PI_WEB_HOST || HOST_ENV)) {
    console.log("[pi-web-bridge] 跳过 /web 注册（pi-web 内嵌进程——本扩展仅在 TUI 会话注册）");
    return;
  }
  let server: Server | null = null;
  let child: ChildProcess | null = null;
  let sockPath: string | null = null;
  let webPort: string | null = null;
  let bridgeUrl: string | null = null;   // 记住桥地址（幂等展示 / /web off 后清空）
  let registeredFile: string | null = null; // registry 当前登记 key（进程内 /new、/resume 切会话时跟随重登记）
  let lastCommand: string | null = null;  // 记住「执行的参数」（下次直接 /web <参数> 免向导）
  let lastTools: Array<{ name: string; description: string; active: boolean; parameters?: Record<string, unknown> }> = [];  // 模型请求快照的工具列表（get_tools 数据源）
  const clients = new Set<Socket>();
  // 页面注册表（合二为一数据流）：每条 attach 连接推送自家桥的 pageId 集合，
  // 转发按 args.pageId 路由到注册了它的那条 rpc；未注册的旧实例（如生产）自然不参与。
  const relayPages = new Map<Socket, Set<string>>();
  let latestCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | null = null;
  // 反向 RPC 门面（/web 激活时发布到 globalThis.__aitiTuiRelay，供连接器 bundle 跨模块握手）
  let installTuiRelay: { active(): boolean; call(tool: string, args: Record<string, unknown>): Promise<unknown> } | null = null;

  // ── 自动桥空闲超时退出（仅 CLI_AUTO）──────────────────────────────────────
  // 时间控制与 pi-web inprocess（rpc 会话）空闲关闭一致：同一 env PI_WEB_IDLE_TIMEOUT_MS
  // （默认 10 分钟、0=禁用、非法值回退默认+警告；解析规则对齐 pi-web lib/rpc-manager.ts）。
  // 目的：shell profile 全自动桥（PI_WEB_BRIDGE_AUTO=1）挂着的 TUI 长期无人使用时不残留
  // （进程 + 桥 socket + 连接器对桥的持续注册重试）。到点仍活动（pi 干活中/有页面 attach）
  // → 续期重排；真正空闲才 ctx.shutdown()（Interactive 模式自带「忙则延后到空闲」语义）。
  // 手动 /web（用户显式操作）与 HEADLESS_AUTO（子代理由父流程管理）不自动退。
  const IDLE_TIMEOUT_MS = (() => {
    const raw = process.env.PI_WEB_IDLE_TIMEOUT_MS;
    if (raw !== undefined && String(raw).trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
      console.warn(`[pi-web-bridge] invalid PI_WEB_IDLE_TIMEOUT_MS "${raw}", falling back to 10 minutes`);
    }
    return 10 * 60 * 1000;
  })();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  function onIdleTimeout(): void {
    idleTimer = null;
    // 到点软检查（rpc-manager 同款续期语义）：有页面 attach / pi 在跑 → 重排不关
    if (clients.size > 0) return idleArm();
    if (latestCtx && !latestCtx.isIdle()) return idleArm();
    try { latestCtx?.ui.notify(S.idleShutdown(String(Math.round(IDLE_TIMEOUT_MS / 60000))), "info"); } catch { /* notify 不可用不阻断 */ }
    try { latestCtx?.shutdown(); } catch { /* shutdown 失败则下次启动再清 */ }
  }
  const idleArm = () => {
    if (!CLI_AUTO || IDLE_TIMEOUT_MS === 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS);
  };
  const idlePoke = () => { if (CLI_AUTO && IDLE_TIMEOUT_MS !== 0) idleArm(); };

  // ── 排队镜像（queue_update 合成回显）──────────────────────────────────────
  // pi 的 queue_update 不进扩展事件通道（上游 _emitExtensionEvent 只转发 8 类事件，
  // pi.on("queue_update") 永远不触发）——TUI 流式中收到的 followUp/steer 在 pi-web 端
  // 完全不可见（排队面板空、聊天流无气泡；限流重试时排队可达数分钟），即
  // 「从 pi-web 发 followUp 无回显」。桥自己维护文本镜像并广播合成 queue_update：
  //   入队 = 本桥执行的 prompt/steer/follow_up 在 TUI 忙时（!ctx.isIdle()）→ 文本入镜像；
  //   出队 = 转发的 message_start(role=user) 按 pi 同序（先 steering 后 followUp）弹匹配文本；
  //   自愈 = get_state 发现 pendingMessageCount=0 而镜像非空（TUI 本地清队）→ 清空重播。
  // 载荷 {type:"queue_update",steering:[],followUp:[]} 与 pi 原生同形（无 rev，前端按
  // 本地会话语义处理）。入队两个来源都覆盖：桥命令（prompt/steer/follow_up 忙时）+
  // 终端本地入队（input 事件 source==="interactive" 且 streamingBehavior 非空，见
  // registerEventListeners）。
  const queueMirror: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  const broadcastQueueUpdate = () => {
    broadcast({ type: "queue_update", steering: [...queueMirror.steering], followUp: [...queueMirror.followUp] });
  };
  const queueMirrorPush = (kind: "steering" | "followUp", text: string) => {
    queueMirror[kind].push(text);
    broadcastQueueUpdate();
  };
  const queueMirrorPopDelivered = (message: unknown): void => {
    const msg = message as { role?: unknown; content?: unknown } | undefined;
    if (!msg || msg.role !== "user") return;
    // 文本提取与 pi contentText(content, "") 同语义：type==="text" 的 block 拼接
    const text = Array.isArray(msg.content)
      ? (msg.content as Array<{ type?: unknown; text?: unknown }>)
          .filter((c) => c && c.type === "text")
          .map((c) => String(c.text ?? ""))
          .join("")
      : "";
    if (!text) return;
    let popped = false;
    const si = queueMirror.steering.indexOf(text);
    if (si !== -1) { queueMirror.steering.splice(si, 1); popped = true; }
    else {
      const fi = queueMirror.followUp.indexOf(text);
      if (fi !== -1) { queueMirror.followUp.splice(fi, 1); popped = true; }
    }
    if (popped) broadcastQueueUpdate();
  };
  const queueMirrorHeal = (ctx: NonNullable<typeof latestCtx>): void => {
    if (!ctx.hasPendingMessages() && (queueMirror.steering.length > 0 || queueMirror.followUp.length > 0)) {
      queueMirror.steering = [];
      queueMirror.followUp = [];
      broadcastQueueUpdate();
    }
  };
  // pi-web 发来的图片附件（validateAgentImages 同形 {type:"image",data,mimeType}）——
  // 逐项严格校验后透传给 sendUserMessage（此前被丢弃：排队/插队消息带图静默丢附件）。
  // 镜像仍只记文本（queue_update 载荷本就 text-only）。
  const parseImages = (raw: unknown): Array<{ type: "image"; data: string; mimeType: string }> => {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const im of raw) {
      if (typeof im !== "object" || im === null) continue;
      const o = im as Record<string, unknown>;
      if (o.type !== "image" || typeof o.data !== "string" || typeof o.mimeType !== "string") continue;
      out.push({ type: "image", data: o.data, mimeType: o.mimeType });
    }
    return out;
  };

  const broadcast = (event: Record<string, unknown>) => {
    // 瘦身（O(n²) 序列化风暴修复）：message_update 事件自带 message 字段及
    // assistantMessageEvent.partial（均为不断增长的完整消息全文）；流式回复
    // 每 chunk 都触发 message_update，若不剥除，每次 broadcast 都在 re-stringify
    // 累积全文 → O(n²) 风暴（实测占 CPU 40-90%、长回复阻塞超 3s 疑似假死）。
    // 消费端（pi-web agent-event-wire.toClientAgentEvent / handle-adapter）只消费
    // delta 增量且官方实现同样剥 partial，完整消息由低频 message_end 下发，
    // 故这里剥掉全文只播增量，零协议损失。
    // 短路：未执行 /web（clients 空）时连 stringify 都跳过——本扩展会被
    // pi-web 内嵌 agent 无条件加载并注册事件监听，若每次事件都 stringify 再
    // 写 0 个客户端，等于给空气烧 CPU（实测占主线程 40-90%）。
    if (clients.size === 0) return;
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (typeof ae === "object" && ae !== null && !Array.isArray(ae)) {
        const { partial: _partial, ...delta } = ae;
        void _partial;
        let next: Record<string, unknown> = delta;
        // 与官方 toJsonAssistantMessageEvent 对齐：toolcall_start 的 id/toolName 只在
        // partial.content[contentIndex]，剥 partial 前必须先提取——否则消费端 streaming
        // reducer 因缺 toolName 丢弃 toolcall_start，工具调用块要等 toolcall_end 才上屏。
        if (ae.type === "toolcall_start") {
          const p = (ae as { partial?: unknown }).partial;
          const content = (typeof p === "object" && p !== null ? (p as { content?: unknown }).content : undefined);
          const idx = typeof ae.contentIndex === "number" ? ae.contentIndex : -1;
          const block = (Array.isArray(content) ? content[idx] : undefined) as Record<string, unknown> | undefined;
          if (block && block.type === "toolCall") {
            next = { ...delta, id: block.id, toolName: block.name };
          }
        }
        event = { type: "message_update", assistantMessageEvent: next };
      }
    }
    const data = JSON.stringify(event) + "\n";
    for (const c of clients) { try { c.write(data); } catch { clients.delete(c); } } // EPIPE 客户端直接逐出，不炸进程
  };

  // ── ctx 捕获（abort/state 需要）＋事件转发 ──
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    // 自动起桥（headless 子代理 / CLI 全自动）：等价 /web --attach --no-spawn --no-open
    //（幂等：server 在跑即跳过起桥流程；off 后同进程内起新会话会重新自动起桥——off 只关当下）
    if (AUTO_BRIDGE && !server) {
      try {
        const base = process.env.PI_WEB_BRIDGE_BASE || "";
        await runWeb(`--attach --no-spawn --no-open${base ? ` --base ${base}` : ""}`, ctx);
        console.log(`[pi-web-bridge] 自动起桥完成（${HEADLESS_AUTO ? "headless 子代理" : "CLI"} 模式，registry 已登记）`);
        idleArm(); // 空闲计时从起桥完成开始（仅 CLI_AUTO；0 禁用/非自动桥时 no-op）
      } catch (e) {
        console.error("[pi-web-bridge] 自动起桥失败:", e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // 进程内切会话（/new、/resume 触发 session_start reason=new|resume）：registry 跟随当前
    // 会话文件重登记（socket 复用——事件广播本就是进程级）。不重登记的话 registry 仍指
    // 旧文件，web 打开新会话会走本地打开 = 双写者风险（registry 存在的意义就是防它）。
    if (AUTO_BRIDGE && server) {
      try {
        const file = ctx.sessionManager.getSessionFile() ?? "";
        if (file && file !== registeredFile) {
          if (registeredFile) await unregisterBridge(registeredFile);
          await registerBridge(file);
          registeredFile = file;
          console.log("[pi-web-bridge] 会话切换 → registry 重登记（socket 复用）");
        }
        idlePoke(); // 会话切换（/new、/resume）= 活动信号
      } catch (e) {
        console.error("[pi-web-bridge] 切换会话重登记失败:", e instanceof Error ? e.message : String(e));
      }
    }
  });
  // 事件转发监听不再顶层无条件注册（pi.on 不可注销，宿主进程级存活）：
  // pi-web 内嵌 agent 也会加载本扩展，若未执行 /web 就注册，每次流式事件会
  // 白白调用 broadcast（即使短路，仍多一次派发）。改为 /web 激活时才注册
  // （见 registerEventListeners），未桥接时事件根本不进本扩展。
  let eventsRegistered = false;
  const registerEventListeners = () => {
    if (eventsRegistered) return;
    for (const evt of FORWARDED_EVENTS) {
      // 各事件 payload 形状不同但都展开转发；用 unknown 中转绕过逐事件重载
      const handler = (event: unknown) => {
        // 队列出队：user 消息开始投递 = pi 已把它移出自家队列（_handleAgentEvent 同款时序，
        // queue_update 先于 message_start 到达消费端）
        if (evt === "message_start") queueMirrorPopDelivered((event as { message?: unknown }).message);
        broadcast({ type: evt, ...(event as Record<string, unknown>) }); idlePoke();
      };
      (pi.on as (e: string, h: (x: unknown) => void) => void)(evt, handler);
    }
    // 终端入队感知（盲区修补 2026-10-17）：TUI 终端流式中回车 = prompt({streamingBehavior:
    // "steer"})、Alt+Enter = "followUp"，pi 在排队判定前发 input 扩展事件（独立直发通道，
    // 不走 _emitExtensionEvent 白名单，pi.on("input") 能收到），载荷
    // {text, source, streamingBehavior}——非空 = 将排队。只认 source==="interactive"
    // （桥自己经手的命令 source==="extension"，已在命令入口 push 过，不重复）；
    // undefined = 空闲提交（立即开跑，气泡走 message_end，不进镜像）。若 push 后实际
    // 未排队（emitInput await 间隙 run 结束的竞态），该文本随新 run 首条用户消息的
    // message_start/end 到来被正常 pop —— 镜像自洽。
    (pi.on as (e: string, h: (x: unknown) => void) => void)("input", (raw: unknown) => {
      const ev = raw as { source?: unknown; text?: unknown; streamingBehavior?: unknown };
      if (ev.source !== "interactive") return;
      if (ev.streamingBehavior !== "steer" && ev.streamingBehavior !== "followUp") return;
      const text = String(ev.text ?? "");
      if (!text) return;
      queueMirrorPush(ev.streamingBehavior === "followUp" ? "followUp" : "steering", text);
    });
    // 工具快照：before_provider_request 的 payload = 模型请求体（含 tools 数组），
    // get_tools 的真实数据源（扩展 API 无 tools 读口；不监听则拿不到）。
    (pi.on as (e: string, h: (x: unknown) => void) => void)("before_provider_request", (raw: unknown) => {
      idlePoke(); // 模型请求发出 = 活动信号
      const payload = (raw as { payload?: { tools?: unknown } } | undefined)?.payload;
      const list = payload?.tools;
      if (!Array.isArray(list)) return;
      lastTools = (list as Array<Record<string, unknown>>).map((t) => {
        const fn = (typeof t.function === "object" && t.function !== null ? t.function : t) as {
          name?: unknown; description?: unknown; parameters?: Record<string, unknown>;
        };
        return {
          name: String(fn.name ?? t.name ?? ""),
          description: String(fn.description ?? t.description ?? ""),
          active: true,
          ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
        };
      });
    });
    eventsRegistered = true;
  };

  const reply = (socket: Socket, id: string, success: boolean, data?: unknown, error?: string) => {
    // EPIPE（对端已关）不能成为未捕获异常——那会炸掉整个 TUI 进程（实锤 06:58:38）
    try {
      socket.write(JSON.stringify({ id, type: "response", success, ...(success ? { data } : { error }) }) + "\n");
    } catch { try { clients.delete(socket); } catch { /* ignore */ } }
  };

  const handleCommand = async (socket: Socket, cmd: Record<string, unknown>) => {
    const id = String(cmd.id ?? "");
    const type = String(cmd.type ?? "");
    const ctx = latestCtx;
    try {
      switch (type) {
        case "prompt": {
          const text = String(cmd.text ?? "");
          const images = parseImages(cmd.images);
          const content = images.length ? [{ type: "text" as const, text }, ...images] : text;
          // TUI 忙 → pi 将把消息排队（prompt() 的 streamingBehavior 分支）→ 入镜像合成回显；
          // 空闲 → 立即开跑，user 气泡由 message_start/end 事件自然回显，不进镜像。
          // 镜像只记文本：投递出队按 contentText（type==="text" block）匹配，带图不受影响
          if (ctx && !ctx.isIdle()) queueMirrorPush(cmd.streamingBehavior === "followUp" ? "followUp" : "steering", text);
          pi.sendUserMessage(content, { deliverAs: cmd.streamingBehavior === "followUp" ? "followUp" : "steer" });
          idlePoke(); // 页面驱动交互 = 活动信号
          return reply(socket, id, true);
        }
        case "steer": {
          const text = String(cmd.text ?? "");
          const images = parseImages(cmd.images);
          if (ctx && !ctx.isIdle()) queueMirrorPush("steering", text);
          pi.sendUserMessage(images.length ? [{ type: "text" as const, text }, ...images] : text, { deliverAs: "steer" });
          idlePoke();
          return reply(socket, id, true);
        }
        case "follow_up": {
          const text = String(cmd.text ?? "");
          const images = parseImages(cmd.images);
          if (ctx && !ctx.isIdle()) queueMirrorPush("followUp", text);
          pi.sendUserMessage(images.length ? [{ type: "text" as const, text }, ...images] : text, { deliverAs: "followUp" });
          idlePoke();
          return reply(socket, id, true);
        }
        case "abort":
          if (!ctx) throw new Error("no active context");
          ctx.abort();
          return reply(socket, id, true);
        case "get_state": {
          if (!ctx) throw new Error("no active context");
          queueMirrorHeal(ctx); // TUI 本地清队后镜像自愈（pendingMessageCount=0 而镜像非空 → 清空重播）
          return reply(socket, id, true, {
            sessionId: ctx.sessionManager.getSessionId?.() ?? "",
            isStreaming: !ctx.isIdle(),
            model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined,
            thinkingLevel: ctx.thinkingLevel,
            pendingMessageCount: ctx.hasPendingMessages() ? 1 : 0,
            // 排队文本（镜像）：pi-web attach 后端 queueManage(list) 的数据源——
            // 页面刷新/重连后排队面板靠它恢复（此前不带 → 刷新即丢显示）
            steering: [...queueMirror.steering],
            followUp: [...queueMirror.followUp],
          });
        }
        case "get_messages": {
          // 展平为 AgentMessage 形状（entries 是 {type,message,...} 包装）
          const entries = (ctx as NonNullable<typeof ctx>).sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
          const messages = entries
            .filter((e) => e.type === "message")
            .map((e) => (e.message ?? e) as Record<string, unknown>);
          return reply(socket, id, true, { messages });
        }
        case "get_commands": {
          const commands = pi.getCommands().map((c) => ({ name: c.name, description: c.description, source: c.source }));
          return reply(socket, id, true, { commands });
        }
        case "set_model": {
          if (!ctx) throw new Error("no active context");
          const registry = ctx.modelRegistry as unknown as {
            getAvailableSnapshot?: () => Array<{ provider: string; id: string }>;
            getAvailable?: () => Array<{ provider: string; id: string }>;
          };
          const list = registry.getAvailableSnapshot?.() ?? registry.getAvailable?.() ?? [];
          const found = list.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
          if (!found) throw new Error(`model not found: ${cmd.provider}/${cmd.modelId}`);
          const ok = await pi.setModel(found as never);
          return ok ? reply(socket, id, true) : reply(socket, id, false, undefined, "no api key");
        }
        case "set_thinking_level":
          pi.setThinkingLevel((cmd.level ?? "off") as never);
          return reply(socket, id, true);
        case "compact":
          if (!ctx) throw new Error("no active context");
          ctx.compact({ customInstructions: typeof cmd.customInstructions === "string" ? cmd.customInstructions : undefined });
          return reply(socket, id, true);
        case "set_session_name":
          pi.setSessionName(String(cmd.name ?? ""));
          return reply(socket, id, true);
        case "get_tools": {
          // 数据源 = before_provider_request 捕获的模型请求 tools 快照（真实工具列表）；
          // 尚未捕获时为空数组（前端正常空态）。
          return reply(socket, id, true, lastTools);
        }
        default:
          return reply(socket, id, false, undefined, `unsupported command: ${type}`);
      }
    } catch (e) {
      return reply(socket, id, false, undefined, e instanceof Error ? e.message : String(e));
    }
  };

  // 关闭桥：断 clients + 关 server + 清 URL/执行参数 + 退出占用登记 + **杀掉 spawn 的
  // pi-web（手动 /web off 或管理界面「停止」= 全关；session_shutdown 不杀 child——detached 留给用户）
  const stopBridge = (ctx: { ui: { notify: (m: string, k?: string) => void } }) => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } // 手动停桥后不再自动退（用户显式操作接管）
    for (const c of clients) c.destroy();
    clients.clear();
    server?.close();
    server = null;
    bridgeUrl = null;
    (globalThis as Record<string, unknown>).__aitiTuiRelay = null; // /web 关闭 → 反向 RPC 下线，连接器回退直连桥
    lastCommand = null;
    if (child && child.exitCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch { /* 已退出 */ } }
    }
    child = null;
    if (latestCtx) void unregisterBridge(registeredFile ?? latestCtx.sessionManager.getSessionFile() ?? "");
    registeredFile = null;
    notifySafe(S.stopped, "info");
  };

  /** 生成「执行的参数」：把本次选择拼成可直接复用的 /web 命令行（免 TUI 向导直达）。 */
  function buildCommandArgs(flags: { port?: string; takeover?: boolean; base?: string; url?: string; basePath?: string; scheme?: string; domain?: string; webport?: string }, o: { open: boolean; spawn: boolean }): string {
    const parts: string[] = [flags.takeover ? "--takeover" : "--attach"];
    if (flags.port) parts.push(`--port ${flags.port}`);
    const base = resolveBridgeBase(flags);
    if (base) parts.push(`--base ${base}`);
    parts.push(o.open ? "--open" : "--no-open");
    if (!o.spawn) parts.push("--no-spawn");
    return `/web ${parts.join(" ")}`;
  }

  // 命令执行体（TUI /web 与自动桥共用）：rawArgs 为空时走交互向导（TUI 专属），
  // 带参数时直达。自动桥（AUTO_BRIDGE）下统一 console.log 免 UI 噪音——
  // 依赖调用方保证参数直达 + base 已就绪（env PI_WEB_BRIDGE_BASE），交互分支内已加守卫。
  const runWeb = async (rawArgs: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext): Promise<void> => {
    const notifySafe = (msg: string, level: "info" | "error") => {
      if (AUTO_BRIDGE) { console.log(`[pi-web-bridge] ${msg}`); return; }
      try { ctx.ui.notify(msg, level); } catch { /* 无头 ctx 兕底 */ }
    };
      // /web off：关闭桥（server + clients + 注册表；事件监听因 pi.on 不可注销
      // 仍挂着，但 broadcast 已短路 clients 空 → 零成本，再次 /web 即恢复转发）
      const arg = typeof rawArgs === "string" ? rawArgs.trim().toLowerCase() : "";
      // 参数解析前置：管理分支（server 已运行）也要读 flags.takeover 等，避免 TDZ
      const flags = parseWebArgs(typeof rawArgs === "string" ? rawArgs : String(rawArgs ?? ""));
      if (arg === "off" || arg === "stop" || arg === "close" || arg === "--off") {
        if (!server) {
          notifySafe("pi-web bridge not running", "info");
          return;
        }
        stopBridge(ctx);
        return;
      }
      if (server) {
        // 幂等：已运行直接进「管理已启动的桥」四选项（CLI_AUTO 有 TUI，照常进菜单；
        // 仅无头子代理 console 短路）
        if (bridgeUrl) {
          if (HEADLESS_AUTO) { console.log(`[pi-web-bridge] 已运行: ${bridgeUrl}`); return; }
          const act = await ctx.ui.select(S.runningTitle(bridgeUrl), [
            S.openBrowser,
            S.noOpenBrowser,
            S.showInfo,
            S.stop,
          ]);
          if (act === undefined) return; // 用户取消
          if (act.startsWith(S.openBrowser)) openBrowser(bridgeUrl);
          else if (act.startsWith(S.noOpenBrowser)) notifySafe(S.stillRunning(bridgeUrl), "info");
          else if (act.startsWith(S.showInfo)) ctx.ui.notify(S.infoMsg(bridgeUrl, lastCommand ?? buildCommandArgs({ takeover: flags.takeover === true }, { open: true, spawn: true })), "info");
          else if (act.startsWith(S.stop)) stopBridge(ctx);
          return;
        }
        // 老进程无 URL 记录：仅回显 socket 路径
        notifySafe(S.alreadyRunning(sockPath ?? ""), "info");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      // 空会话（文件惰性未落盘）允许桥接：打开会话时 pi-web 按 id 反查注册表
      // 优先走 socket attach（读文件仅为历史回放）——无需文件存在，只需有 session id
      if (!sessionFile && !ctx.sessionManager.getSessionId()) throw new Error(S.noSession);

      // ── 模式决定：带参数直接用，无参数弹选择框 ──
      let openBrowser_ = true;
      let doSpawn = true;
      if (flags.hasArgs) {
        if (flags.open !== undefined) openBrowser_ = flags.open;
        if (flags.spawn !== undefined) doSpawn = flags.spawn;
      } else {
        // 两段式向导：① 自定义参数（可选，可留空）→ ② 模式（接管/桥接）→ ③ 服务×浏览器三选项
        const custom = await ctx.ui.input(
          S.customArgsTitle,
          `--port ${process.env.PI_WEB_BRIDGE_PORT || "3002"}`,
        );
        if (custom === undefined) return; // 用户取消
        if (custom.trim() !== "") {
          const extra = parseWebArgs(custom);
          for (const k of Object.keys(extra) as Array<keyof typeof extra>) {
            if (extra[k] !== undefined) (flags as Record<string, unknown>)[k] = extra[k];
          }
        }
        // 两种模式都 spawn 新 pi-web；区别在机制（见下面 if (!takeover) 桥段）：
        //   接管 = 不起 rpc 桥，pi-web 打开文件后进程内跑 pi SDK 接手本会话（TUI 不再输入）
        //   attach = 起 rpc 桥，pi-web 经 attach 连本会话，IO 沿桥转发广播，一起工作
        const mode = await ctx.ui.select(S.modeTitle, [S.modeTakeover, S.modeAttach]);
        if (mode === undefined) return; // 用户取消
        flags.takeover = mode.startsWith(S.modeTakeover);
        // ③ 最后一页：「spawn × 浏览器」合成三选项——常驻 dev/prod 已在跑时
        // 不必每次都 spawn 新实例（第二份构建 + 端口漂移），选「不启动」复用即可；
        // 等价 CLI 参数：--no-spawn（地址用 --base/--url 或留空端口推导）。
        const br = await ctx.ui.select(S.finalTitle, [
          S.finalSpawnOpen,
          S.finalSpawnNoOpen,
          S.finalNoSpawn,
        ]);
        if (br === undefined) return; // 用户取消
        if (br.startsWith(S.finalNoSpawn)) {
          doSpawn = false;
          // 已有实例地址：CLI --base/--url/--domain、env PI_WEB_BASE_PATH 优先；
          // 都没有才问一次（可留空 → 沿用按端口推导的回退 URL）
          if (!resolveBridgeBase(flags)) {
            if (HEADLESS_AUTO) throw new Error("headless 自动桥需要 PI_WEB_BRIDGE_BASE 指向已运行的 pi-web");
            const addr = await ctx.ui.input(S.addrInput, "");
            if (addr === undefined) return; // 用户取消
            if (addr.trim() !== "") flags.base = addr.trim();
          }
        } else {
          openBrowser_ = br.startsWith(S.finalSpawnOpen);
        }
      }

      const port = flags.port || process.env.PI_WEB_BRIDGE_PORT || "3002";

      // 1. socket 服务（attach 模式专属：rpc 接口 + 事件广播；takeover 不起桥）
      const takeover = flags.takeover === true;
      if (!takeover) {
      sockPath = bridgeSocketName(process.pid);
      // 反向 RPC 响应路由：aiti_* 工具经本 socket 转发到 pi-web 进程内桥执行
      //（合二为一：不经 HTTP/鉴权/端口连通，复用已有 attach 连接；帧协议见
      // aiti-attach-agent/index.ts handleAitiBridgeReq）。响应帧 id 前缀 "rr"。
      let relaySeq = 0;
      const relayPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      installTuiRelay = {
        active: () => {
          if (server === null) return false;
          // 只要推送过注册帧（即使当时 pages=0，页面 claims 可能晚于 attach）即为可转发 peer
          return relayPages.size > 0;
        },
        call: (tool: string, args: Record<string, unknown>): Promise<unknown> =>
          new Promise((resolve, reject) => {
            const pid = typeof args.pageId === "string" ? args.pageId : null;
            // 自愈路由：持有 pageId 的 peer 优先，逐个尝试（20s/个），静默 peer 逐出；
            // 全部失败才抛错 → 连接器回退直连桥。僵尸连接不再阻塞 120s。
            const matched: Array<{ sock: Socket; ids: Set<string> }> = [];
            const others: Array<{ sock: Socket; ids: Set<string> }> = [];
            for (const [c, ids] of relayPages) {
              if (pid && ids.has(pid)) matched.push({ sock: c, ids });
              else others.push({ sock: c, ids });
            }
            const candidates = [...matched, ...others];
            console.log(`[pi-web-bridge] relay → ${tool} | clients=${clients.size} 候选=匹配${matched.length}+其他${others.length} | pageId=${pid ?? "-"}`);
            if (candidates.length === 0) return reject(new Error("relay: no rpc peer has registered pages"));
            const attempt = (idx: number): Promise<unknown> => {
              if (idx >= candidates.length) return Promise.reject(new Error("relay: 所有候选 peer 均未应答"));
              const { sock, ids } = candidates[idx];
              const id = "rr" + ++relaySeq;
              return new Promise((resolve2, reject2) => {
                const timer = setTimeout(() => {
                  if (relayPending.delete(id)) {
                    relayPages.delete(sock); // 静默 peer 逐出（半开/僵尸连接）
                    reject2(new Error(`relay timeout (20s): ${tool} @peer${idx}`));
                  }
                }, 20_000);
                relayPending.set(id, { resolve: resolve2, reject: reject2, timer });
                try {
                  sock.write(JSON.stringify({ id, type: "aiti_bridge_req", tool, args }) + "\n");
                } catch (e) {
                  clearTimeout(timer);
                  relayPending.delete(id);
                  relayPages.delete(sock);
                  reject2(new Error("relay write EPIPE: " + (e instanceof Error ? e.message : String(e))));
                }
              });
            };
            return attempt(0).catch(() => attempt(1).catch(() => (candidates.length > 2 ? attempt(2) : Promise.reject(new Error("relay: all peers failed")))));
          }),
      };
      (globalThis as Record<string, unknown>).__aitiTuiRelay = installTuiRelay;
      await new Promise<void>(async (resolve, reject) => {
        server = createServer((socket) => {
          clients.add(socket);
          idlePoke(); // 页面 attach 连接 = 活动信号（重置空闲计时）
          // EPIPE/ECONNRESET 等写错误不能再埘成未捕获异常炸掉整个 TUI 进程
          // （实锤：reply() 对已关闭 client 写响应 → EPIPE → 进程退出 → relay/注册全丢）
          socket.on("error", () => { try { clients.delete(socket); relayPages.delete(socket); } catch { /* ignore */ } });
          let buf = Buffer.alloc(0);
          socket.on("data", (chunk: Buffer | string) => {
            // 字节累积、按 \n 切 Buffer 后整行 utf8 解码（加固 A1 同款）——逐 chunk toString
            // 会把跨 chunk 的多字节字符切碎，JSON.parse 失败 → 帧静默丢失（relay 假超时）
            const c = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            buf = buf.length === 0 ? c : Buffer.concat([buf, c]);
            let i: number;
            while ((i = buf.indexOf(0x0a)) !== -1) {
              const line = buf.subarray(0, i).toString("utf8");
              buf = buf.subarray(i + 1);
              try {
                const cmd = JSON.parse(line) as Record<string, unknown>;
                // ① 页面注册表推送（pi-web → pi）：更新该连接的可路由 pageId 集合；
                //    未推送过的旧实例（如生产）永远不会成为转发目标
                if (cmd.type === "aiti_pages") {
                  const pages = Array.isArray(cmd.pages) ? cmd.pages : [];
                  relayPages.set(socket, new Set(pages.map((p) => String((p as { pageId?: unknown }).pageId ?? "")).filter(Boolean)));
                  console.log(`[pi-web-bridge] aiti_pages ← via=${String(cmd.via ?? "?")} pages=${pages.length}`);
                  continue;
                }
                // ② 反向 RPC 响应（id=rr*）→ 路由给 relayPending；其余为正向命令帧
                if (cmd.type === "response" && typeof cmd.id === "string" && cmd.id.startsWith("rr")) {
                  const p = relayPending.get(cmd.id);
                  if (!p) continue;
                  clearTimeout(p.timer);
                  relayPending.delete(cmd.id);
                  if (cmd.success === true) {
                    // 消费搭载的页面注册表刷新（对端每次转发响应都同步最新 pageId 集合，
                    // 弥补「注册只在连接时推一次」的滞后：新建/关闭页面后下一跳即生效）
                    const d = cmd.data as { __pages?: { pages?: Array<{ pageId?: unknown }> } } | undefined;
                    if (d && d.__pages && Array.isArray(d.__pages.pages)) {
                      relayPages.set(socket, new Set(d.__pages.pages.map((q) => String((q as { pageId?: unknown }).pageId ?? "")).filter(Boolean)));
                    }
                    p.resolve(cmd.data);
                  } else p.reject(new Error(String(cmd.error ?? "relay failed")));
                } else {
                  void handleCommand(socket, cmd);
                }
              } catch { /* ignore */ }
            }
          });
          socket.on("close", () => { clients.delete(socket); relayPages.delete(socket); });
        });
        server.once("error", (err: Error) => { server = null; reject(err); });
        if (platform() !== "win32") {
          // 清理崩溃残留的 stale socket 文件（Windows 命名管道自动管理，无需此步）。
          // ⚠ await 必须前置在 listen 之前：否则异步 import 可能在 listen 成功
          // resolve 后执行 unlinkSync，误删刚创建的 socket 文件（实测 E2E 踩到）。
          await import("node:fs").then((fs) => { try { if (sockPath) fs.unlinkSync(sockPath); } catch { /* 不存在 */ } });
        }
        // Unix socket 权限收紧到仅属主（默认 0775，同机其他用户可连可驱动会话）。
        // Windows 命名管道 ACL 自带隔离，无需此步。
        server.listen(sockPath, () => {
          if (platform() !== "win32" && sockPath) {
            void import("node:fs").then((fs) => { try { fs.chmodSync(sockPath!, 0o600); } catch { /* ignore */ } });
          }
          resolve();
        });
      });

      // 1.5 激活桥后才注册事件转发（未 /web 时零监听、零派发）
      registerEventListeners();
      }

      // 2. detached spawn pi-web（env 注入 socket；pi 退出它不死）
      //    仅桥接模式（doSpawn=false）跳过——用户已有 pi-web 在跑
      webPort = port;
      if (doSpawn) {
        const entry = process.env.PI_WEB_BRIDGE_ENTRY || "pi-web";
        const childEnv: Record<string, string> = {
          ...process.env,
          PI_WEB_ATTACH_CWD: ctx.cwd,
          PORT: port,
        };
        if (!takeover) childEnv.PI_WEB_SOCKET = sockPath ?? "";
        applyBridgeDomainEnv(flags, childEnv);
        child = spawn(entry, [], {
          detached: true,
          stdio: "ignore",
          env: childEnv,
        });
        child.unref();
      }

      // 3. 注册表登记（attach 模式专属：pi-web 打开文件时识别占用并附着）
      if (!takeover && sessionFile) {
        await registerBridge(sessionFile);
        registeredFile = sessionFile;
      }

      const basePath = resolveBridgeBase(flags);
      // session 参数用 session id（uuid），不用路径——AppShell getInitialNavigation
      // 按 id 匹配会话（?session= 与 ?cwd= 二选一，cwd 优先）
      const sessionParam = ctx.sessionManager.getSessionId() || sessionFile;
      const url = basePath
        ? `${basePath}/?session=${encodeURIComponent(sessionParam)}`
        : `http://127.0.0.1:${port}/?session=${encodeURIComponent(sessionParam)}`;
      bridgeUrl = url;

      // 合并桥（合二为一）：本会话若装了 aiti_* 连接器，工具应与本次打开的 pi-web 页面
      // 连同一个桥（页面注入的 launcher 同源连 <web>/api/extensions/aiti-devtools/mcp）。
      // ⚠ 仅在有真实 base（用户显式指向某个 pi-web）时才合并——CLI 自动桥没设
      // PI_WEB_BRIDGE_BASE 时按默认端口推导的地址是猜的，写入只会把连接器的
      // 探测/重连带偏（去连一个不存在的端口）；此时保留连接器自有引导（独立桥）。
      if (!process.env.AITI_BRIDGE_URL && basePath) {
        const webBase = (basePath || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
        process.env.AITI_BRIDGE_URL = webBase + "/api/extensions/aiti-devtools/mcp";
      }

      // 4. 浏览器按模式开关
      if (openBrowser_) openBrowser(url);

      lastCommand = buildCommandArgs(flags, { open: openBrowser_, spawn: doSpawn });
      notifySafe(
        (takeover ? S.takeoverDone(url) : S.attached(url)) + S.lastCommandLabel + lastCommand,
        "info",
      );
  };

  pi.registerCommand("web", {
    description: "Bridge this session to the browser (pi-web)",
    handler: (rawArgs, ctx) => runWeb(typeof rawArgs === "string" ? rawArgs : String(rawArgs ?? ""), ctx),
  });

  pi.on("session_shutdown", () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    for (const c of clients) c.destroy();
    clients.clear();
    server?.close();
    server = null;
    bridgeUrl = null;
    installTuiRelay = null;
    (globalThis as Record<string, unknown>).__aitiTuiRelay = null;
    if (latestCtx) void unregisterBridge(registeredFile ?? latestCtx.sessionManager.getSessionFile() ?? "");
    registeredFile = null;
    if (child && child.exitCode === null) {
      // 桥断开即可——pi-web 自身继续跑（detached），由用户决定去留
      child.unref();
    }
  });
}
