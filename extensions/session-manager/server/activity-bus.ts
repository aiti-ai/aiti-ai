/**
 * 会话活动「数据帧」广播（2026-09-15 升级：信号帧 → 携带行数据的数据帧）。
 *
 * 首版（2026-09-14）为信号帧：agent message_end 落盘后广播 sm:session-activity
 * {sessionId}，客户端收到后必须再拉一次 /sessions 增量（since=rev patch）才能更新
 * 行数据（消息数/modified/预览）——「广播了还要刷新」：AI 会话进行中实测每 3-15s
 * 一对请求（sessions + running）× 每个客户端，多端叠加放大后端负载。
 *
 * 本版把行数据随帧下发：服务端持有「列表组装出口登记的行缓存」（noteAssembledRows），
 * message_end 时用事件消息增量更新对应行（口径对齐 core session-reader 与本扩展
 * session-file parser），随帧广播 {sessionId, row}；客户端直接 patch store，零请求。
 *
 * 口径（与列表组装对齐——不一致会让行数字在下次全量刷新时「跳变」）：
 *   - messageCount：所有消息（user/assistant/toolResult）都 +1（扫描口径 = jsonl 中
 *     type:message 行数；三条消息类型均以 message 落盘）；
 *   - lastRole：所有消息都跟随（索引 lastMeta = messages 表最后一行，含 toolResult）；
 *   - modified/lastMessage：仅 user/assistant（core 与本扩展 parser 的活动时间与预览口径，
 *     toolResult 不推进）；lastMessage 空文本不覆盖（同 parser 语义）；
 *   - model：assistant 且 msg.model 为字符串时以原始值覆盖（索引口径，不带 provider 前缀）。
 *
 * 节流：同会话 3s（保持首版节奏）。信号帧时代窗口内事件可丢（客户端拉到的永远是最新）；
 * 数据帧自携数据，窗口内最后一个事件不能丢——到点 trailing 补发缓存当前行。
 *
 * 兼容：
 *   - 旧客户端收到带 row 的帧：忽略 row 字段走原增量刷新（多一次请求，正确性不变）；
 *   - 新客户端收到不带 row 的帧（服务端行缓存未命中/旧服务端）：回退增量刷新；
 *   - 总线缺席（服务端服务未提供）：静默，仅维护缓存。
 *
 * 行缓存生命周期：/sessions 组装出口（memo miss 时）全量登记；扩展 reload/进程重启
 * 清空，首个 /sessions 请求后恢复覆盖；未命中期间 activity 帧降级为信号帧（客户端
 * 增量刷新一次即重建缓存，自愈）。
 */

/** 列表组装出口登记的标准行（id → 行；Map 插入序近似 LRU，超限淘汰最旧）。 */
const rowCache = new Map<string, Record<string, unknown>>();
const ROW_CACHE_LIMIT = 5000;

/** 行缓存登记（/sessions 组装出口每次调用）。引用去重：同一份组装（memo 命中）
 *  只登记一次；扩展 reload 后模块缓存清空而宿主 memo（globalThis）存活——同引用
 *  重入时此处仍会登记（lastLive 已随模块重置为 undefined），不会出现「memo 命中但
 *  行缓存空」的空窗。行对象只读（广播时浅拷贝更新，不改原对象）。 */
let lastLiveRef: unknown;
let lastArchRef: unknown;
export function noteAssembledRows(live: unknown, archived?: unknown): void {
  if (live === lastLiveRef && archived === lastArchRef) return; // 同引用：已登记，O(1)
  lastLiveRef = live;
  lastArchRef = archived;
  const rows: unknown[] = [
    ...(Array.isArray(live) ? live : []),
    ...(Array.isArray(archived) ? archived : []),
  ];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const id = String((r as { id?: unknown }).id ?? "");
    if (!id) continue;
    rowCache.delete(id); // 重插：Map 插入序 = 新鲜度（淘汰时先掉最旧的）
    rowCache.set(id, r as Record<string, unknown>);
  }
  while (rowCache.size > ROW_CACHE_LIMIT) {
    const oldest = rowCache.keys().next().value;
    if (oldest === undefined) break;
    rowCache.delete(oldest);
  }
}

/* ── 发布口（index.ts startup 注入；总线缺席 = null → 静默）──────────────────── */
type Publisher = (type: string, data: Record<string, unknown>) => void;
let publishFn: Publisher | null = null;

export function bindActivityPublisher(fn: Publisher | null): void {
  publishFn = fn;
}

/** shutdown/reload 清理：清缓存与计时器（发布口由下次 startup 重新注入）。 */
export function resetActivityBusState(): void {
  rowCache.clear();
  lastLiveRef = undefined;
  lastArchRef = undefined;
  lastSentAt.clear();
  for (const t of trailingTimers.values()) clearTimeout(t);
  trailingTimers.clear();
  minIntervalMs = ACTIVITY_MIN_MS;
}

/* ── 行增量更新（纯函数；口径见文件头）────────────────────────────────────── */

/** 与 core session-reader 的 extractTextContent / 本扩展 session-file.ts 的 extractText
 *  同款：text 块 join " "；无 text 块时 toolCall 伪文本（🛠 name args…）——纯工具回合
 *  的预览不落空。 */
function extractText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => ((b as { text?: unknown }).text ?? "") as string);
  if (texts.join("").trim()) return texts.join(" ");
  const calls = content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "toolCall")
    .map((b) => {
      const t = b as { name?: unknown; arguments?: unknown };
      const args = typeof t.arguments === "string" ? t.arguments : t.arguments ? JSON.stringify(t.arguments) : "";
      return `🛠 ${t.name ?? "tool"}${args ? " " + args.slice(0, 400) : ""}`;
    });
  return calls.join("\n");
}

const PREVIEW_LEN = 60; // 与列表出口 truncate 一致（客户端只展示前 60 字符）
function truncate(t: string): string {
  return t.length > PREVIEW_LEN ? t.slice(0, PREVIEW_LEN) + "…" : t;
}

/**
 * 事件消息 → 行增量更新（纯函数，返回新对象；message 非法时原样返回）。
 * 详见文件头口径说明。
 */
export function applyMessageToRow(
  row: Record<string, unknown>,
  message: unknown,
  now: number = Date.now(),
): Record<string, unknown> {
  if (!message || typeof message !== "object") return row;
  const msg = message as { role?: unknown; content?: unknown; timestamp?: unknown; model?: unknown };
  const role = typeof msg.role === "string" ? msg.role : "";
  const next = { ...row };
  // 计数递增仅在基数可信时：非数字（外部行/待富化行）时不猜测——
  // 从 0 起会把行上的日计数倒退回 1（比不更新更糟），留给下次列表刷新补齐。
  if (typeof next.messageCount === "number" && Number.isFinite(next.messageCount)) next.messageCount += 1;
  if (role) next.lastRole = role;
  if (role === "user" || role === "assistant") {
    const ts = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : now;
    next.modified = new Date(ts).toISOString();
    const text = extractText(msg);
    if (text) next.lastMessage = truncate(text);
    if (role === "assistant" && typeof msg.model === "string" && msg.model) next.model = msg.model;
  }
  return next;
}

/* ── 广播（节流 + trailing）───────────────────────────────────────────────── */

const ACTIVITY_MIN_MS = 3000;
let minIntervalMs = ACTIVITY_MIN_MS; // 测试可注入

const lastSentAt = new Map<string, number>();
const trailingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 测试用：注入节流间隔（用完由 resetActivityBusState 复位）。 */
export function __setActivityMinIntervalForTest(ms: number): void {
  minIntervalMs = ms;
}

/** 测试用：直接读行缓存（断言用）。 */
export function __peekRowCache(id: string): Record<string, unknown> | undefined {
  return rowCache.get(id);
}

/**
 * 会话活动事件入口（agent onAgentSession 的 message_end 回调）。
 * 1) 缓存行增量更新（缓存缺席 → 帧不带 row，客户端回退增量刷新）；
 * 2) 同会话 3s 节流：窗口内事件由 trailing 计时器在窗口尾补发缓存当前行（不丢最后一个）。
 */
export function publishSessionActivity(sessionId: string, message?: unknown): void {
  const id = String(sessionId ?? "");
  if (!id) return;
  const cached = rowCache.get(id);
  if (cached) {
    const updated = applyMessageToRow(cached, message);
    rowCache.delete(id);
    rowCache.set(id, updated);
  }
  const now = Date.now();
  const last = lastSentAt.get(id) ?? 0;
  const due = last + minIntervalMs - now;
  if (due <= 0) {
    lastSentAt.set(id, now);
    send(id);
    return;
  }
  if (trailingTimers.has(id)) return; // 已有补发排在窗口尾（帧取缓存当前值，天然合并）
  const timer = setTimeout(() => {
    trailingTimers.delete(id);
    lastSentAt.set(id, Date.now());
    send(id);
  }, due);
  (timer as { unref?: () => void }).unref?.();
  trailingTimers.set(id, timer);
}

/** 发帧：行数据取缓存当前值（trailing 到点时含窗口内全部增量）。 */
function send(sessionId: string): void {
  if (!publishFn) return;
  const row = rowCache.get(sessionId);
  const payload: Record<string, unknown> = { sessionId };
  if (row) payload.row = row;
  try {
    publishFn("sm:session-activity", payload);
  } catch { /* 总线异常静默（与首版 stance 一致） */ }
}
