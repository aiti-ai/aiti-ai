/**
 * task-list — 会话任务列表（TodoWrite working plan）只读镜像的共享派生层。
 *
 * ⚠ 权威源：本文件（pi-web-ext/_shared/task-list.ts）。扩展经
 *   `@aiti-ai/ext-shared/task-list` 导入（extman reconcile 装进共享根）——**新增/改名
 *   导出必须发布新版 ext-shared 并 reconcile，否则运行期拿到 undefined**（同
 *   backend-queue 侧的 jiti 缓存教训）。
 *
 * 出处：aiti-zcode-agent 的桌面端逆向（docs/aiti-zcode-agent-task-list-plan.md §1）——
 * 协议里没有专门的 todo 事件，任务列表是从 TodoWrite 族工具调用的 input/output 派生的
 * 只读镜像。CC 族（claude/qoder/codebuddy…）与 zcode 的 wire 形状一致，故各家共用：
 *  - 解析语义 = ZCode 桌面端同款（对象取 content/step/title/text/activeForm + status 归一；
 *    纯字符串条目首项 in_progress 其余 pending；集合键 todos|plan|steps|items，all-or-nothing）；
 *  - 更新语义 = 全量替换 + JSON 对比去重（防重放/重复帧把同一份列表反复推给前端）。
 */

/** 任务条目（session/resume 快照 `todos` wire 同构；priority 来自工具 input，可缺）。 */
export interface TaskEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: string;
}

/** TodoWrite 族工具名（桌面端同款正则：内置 TodoWrite/TodoRead + MCP update_plan 变体）。 */
export const TODO_PLAN_TOOL_RE = /(?:^|[_\s-])(?:todo[_\s-]*(?:read|write)|update[_\s-]*plan)(?:$|[_\s-])/i;

export function normalizeTaskStatus(v: unknown): TaskEntry["status"] | null {
  const s = typeof v === "string" ? v.replace(/-/g, "_").toLowerCase() : "";
  return s === "pending" || s === "in_progress" || s === "completed" ? s : null;
}

/**
 * 单条任务解析（桌面 _Cn 同款）：对象取 content/step/title/text/activeForm + status 归一
 * （非法整条弃）；纯字符串条目缺省首项 in_progress 其余 pending。
 */
export function parseTaskEntry(raw: unknown, index: number): TaskEntry | null {
  if (typeof raw === "string") {
    const content = raw.trim();
    return content ? { content, status: index === 0 ? "in_progress" : "pending" } : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const content = [o.content, o.step, o.title, o.text, o.activeForm]
    .find((v): v is string => typeof v === "string" && v.length > 0);
  const status = normalizeTaskStatus(o.status);
  if (!content || !status) return null;
  const priority = typeof o.priority === "string" && o.priority ? o.priority : undefined;
  return { content, status, ...(priority ? { priority } : {}) };
}

/**
 * 任务集合提取（桌面 kPt/yCn 同款）：对象（字符串先 JSON.parse）下首个 todos|plan|steps|items
 * 数组，全部条目可解析才生效（all-or-nothing）；空数组/解析失败返回 null（保持现状不更新）。
 */
export function extractTaskList(value: unknown): TaskEntry[] | null {
  let obj = value;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  for (const key of ["todos", "plan", "steps", "items"]) {
    const arr = (obj as Record<string, unknown>)[key];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const entries: TaskEntry[] = [];
    let ok = true;
    for (let i = 0; i < arr.length; i++) {
      const entry = parseTaskEntry(arr[i], i);
      if (!entry) { ok = false; break; }
      entries.push(entry);
    }
    if (ok) return entries;
  }
  return null;
}

/** 任务列表镜像（跨轮持续；onChange 只在内容真变化时收到全量副本）。 */
export interface TaskListMirror {
  /** 当前列表（内部引用，调用方只读）。 */
  current(): TaskEntry[];
  /** 全量替换（JSON 对比去重；变化时回调副本）。 */
  apply(todos: TaskEntry[]): void;
  /** 工具事件派生：非 TodoWrite 族工具名或全部候选值解析失败 → 保持现状。 */
  fromToolEvent(toolName: string, ...values: unknown[]): void;
  /** 快照种子（resume/重启恢复；`todos` 数组 wire 同构，防御式逐条解析）。 */
  seed(rawArray: unknown): void;
}

export function createTaskListMirror(onChange?: (todos: TaskEntry[]) => void): TaskListMirror {
  let list: TaskEntry[] = [];
  const apply = (todos: TaskEntry[]): void => {
    if (JSON.stringify(todos) === JSON.stringify(list)) return;
    list = todos;
    onChange?.(todos.map((t) => ({ ...t })));
  };
  return {
    current: () => list,
    apply,
    fromToolEvent: (toolName, ...values) => {
      if (!toolName || !TODO_PLAN_TOOL_RE.test(toolName)) return;
      for (const value of values) {
        const todos = extractTaskList(value);
        if (todos) {
          apply(todos);
          return;
        }
      }
    },
    seed: (rawArray) => {
      if (!Array.isArray(rawArray) || rawArray.length === 0) return;
      const todos: TaskEntry[] = [];
      for (const item of rawArray) {
        const entry = parseTaskEntry(item, todos.length);
        if (entry) todos.push(entry);
      }
      apply(todos);
    },
  };
}
