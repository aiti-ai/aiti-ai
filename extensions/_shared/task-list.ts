/**
 * task-list — shared derivation layer for the read-only mirror of a session's task list (TodoWrite
 * working plan).
 *
 * ⚠ Authoritative source: this file (pi-web-ext/_shared/task-list.ts). Extensions import via
 *   `@aiti-ai/ext-shared/task-list` (extman reconcile installs it into the shared root) — **adding or
 *   renaming an export requires publishing a new ext-shared version and reconciling, or the runtime
 *   gets undefined** (same lesson as the jiti cache on the backend-queue side).
 *
 * Origin: desktop-app reverse engineering of aiti-zcode-agent (docs/aiti-zcode-agent-task-list-plan.md
 * §1) — the protocol has no dedicated todo event; the task list is a read-only mirror derived from the
 * input/output of TodoWrite-family tool calls. The CC family (claude/qoder/codebuddy...) shares zcode's
 * wire shape, so all of them use this:
 *  - parse semantics = the ZCode desktop's own (objects take content/step/title/text/activeForm +
 *    status normalization; pure-string entries make the first in_progress and the rest pending;
 *    collection keys todos|plan|steps|items, all-or-nothing);
 *  - update semantics = full replacement + JSON-compare dedupe (prevents replays/duplicate frames from
 *    pushing the same list to the front end over and over).
 */

/** Task entry (same wire shape as the session/resume snapshot `todos`; priority comes from the tool input and may be absent). */
export interface TaskEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: string;
}

/** TodoWrite-family tool names (the desktop's own regex: built-in TodoWrite/TodoRead + MCP update_plan variants). */
export const TODO_PLAN_TOOL_RE = /(?:^|[_\s-])(?:todo[_\s-]*(?:read|write)|update[_\s-]*plan)(?:$|[_\s-])/i;

export function normalizeTaskStatus(v: unknown): TaskEntry["status"] | null {
  const s = typeof v === "string" ? v.replace(/-/g, "_").toLowerCase() : "";
  return s === "pending" || s === "in_progress" || s === "completed" ? s : null;
}

/**
 * Parse one task entry (same as the desktop's _Cn): objects take content/step/title/text/activeForm +
 * status normalization (invalid entries are dropped whole); pure-string entries default to the first
 * in_progress and the rest pending.
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
 * Extract the task collection (same as the desktop's kPt/yCn): the first todos|plan|steps|items array
 * under the object (strings JSON.parse first) takes effect only when every entry parses
 * (all-or-nothing); empty arrays / parse failures return null (keep the current state, no update).
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

/** Task-list mirror (persists across turns; onChange receives a full copy only when the content really changed). */
export interface TaskListMirror {
  /** The current list (internal reference, read-only for callers). */
  current(): TaskEntry[];
  /** Full replacement (JSON-compare dedupe; calls back with a copy on change). */
  apply(todos: TaskEntry[]): void;
  /** Tool-event derivation: non-TodoWrite-family tool names or all candidate values failing to parse -> keep the current state. */
  fromToolEvent(toolName: string, ...values: unknown[]): void;
  /** Snapshot seed (resume/restart recovery; same wire shape as the `todos` array, defensively parsed per entry). */
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
