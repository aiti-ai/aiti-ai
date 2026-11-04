/**
 * store.ts —— 持久化（方案 §3/§4.1）
 *
 * 布局（configDir，可用 AITI_AI_SCHEDULE_DATA_DIR 覆盖）：
 *   plans.json   计划全量快照（原子写：tmp + rename）
 *   state.json   水位表 { [taskId]: { nextRunAt, lastRunAt, runCount } }（重启补跑依据）
 *   runs.jsonl   运行历史（append-only；启动时截断保留最近 RUNS_KEEP 条）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, statSync, openSync, readSync, closeSync, unlinkSync } from "node:fs";
import { join as pathJoin } from "node:path";

export const RUNS_KEEP = 500;

// ---- Plan（AI 计划，方案 §3）----

export interface Plan {
  id: string;
  name: string;
  schedule: any;                 // ScheduleSpec 输入形态（cron/interval/once）或数组（多调度：每元素一个时点）
  prompt: string;                // 目标 + 执行提示词
  cwd?: string;
  model?: string;                // "provider/modelId" 或 modelId
  mode: "session" | "invokeAI" | "auto";
  enabled: boolean;
  autoApprove: boolean;          // agent 创建默认 false → 待确认
  maxRuns?: number;
  dailyCap?: number;             // 每日自动执行上限（预算，方案 §10）
  timezone?: string;             // IANA 时区（cron 按此墙钟计算；缺省本机）
  notify: boolean;
  /** 结果送达：cc-connect 通道（null=不发；集成方案 §4.2） */
  cc?: { project: string; sessionKey: string } | null;
  /** 结果送达：邮箱（逗号分隔可多个；null=不发） */
  mailTo?: string | null;
  /** 发送条件："all"=成功失败都发（默认）| "ok"=仅成功 | "error"=仅失败 */
  sendOn?: "ok" | "error" | "all";
  createdAt: string;
  createdBy: "user" | "agent" | string;
  // 运行时字段（随 plans.json 持久化）
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  runCount?: number;
  lastStatus?: string;
  lastError?: string | null;
}

// ---- RunRecord（追加写 JSONL）----

export interface RunRecord {
  id: string;
  targetId: string;              // planId 或 hook 任务 id（extId:schedId）
  kind: "ai" | "hook";
  name: string;
  at: string;
  mode?: string;
  status: "ok" | "error" | "missed" | "skipped";
  ms?: number;
  text?: string;
  error?: string;
  sessionId?: string | null;
  model?: string | null;
  /** 送达备注（集成方案 §4.4/§4.5）："ok" | "error: …"；不新增记录行，outbound 完成后就地补记 */
  ccSent?: string;
  mailSent?: string;
}

export class Store {
  dir: string;
  plans: Plan[] = [];
  state: Record<string, { nextRunAt: number; lastRunAt: number | null }> = {};

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.plans = this.readJson<Plan[]>("plans.json", []);
    if (!Array.isArray(this.plans)) this.plans = [];
    this.state = this.readJson("state.json", {}) || {};
    this.truncateRuns();
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      const p = pathJoin(this.dir, file);
      if (!existsSync(p)) return fallback;
      return JSON.parse(readFileSync(p, "utf8"));
    } catch { return fallback; }
  }

  private writeJsonAtomic(file: string, data: unknown) {
    const p = pathJoin(this.dir, file);
    const tmp = p + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, p);
  }

  savePlans() { this.writeJsonAtomic("plans.json", this.plans); }
  saveState() { this.writeJsonAtomic("state.json", this.state); }

  getPlan(id: string): Plan | undefined { return this.plans.find((p) => p.id === id); }

  watermark(taskId: string): { nextRunAt: number; lastRunAt: number | null } {
    return this.state[taskId] || (this.state[taskId] = { nextRunAt: 0, lastRunAt: null });
  }
  setWatermark(taskId: string, w: { nextRunAt: number; lastRunAt: number | null }) {
    this.state[taskId] = w;
    this.saveState();
  }

  appendRun(r: RunRecord) {
    try {
      appendFileSync(pathJoin(this.dir, "runs.jsonl"), JSON.stringify(r) + "\n");
    } catch {}
  }

  recentRuns(limit = 50): RunRecord[] {
    try {
      const lines = readFileSync(pathJoin(this.dir, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      const out: RunRecord[] = [];
      for (const l of lines.slice(-limit)) { try { out.push(JSON.parse(l)); } catch {} }
      return out.reverse();
    } catch { return []; }
  }

  /**
   * 就地补记一条已有 run 的字段（送达备注 ccSent/mailSent，集成方案 §4.4——不新增记录行）。
   * runs.jsonl 被 truncateRuns 控制在 256KB 内，全文件重写成本可忽略；仅配置了送达的计划才会触发。
   */
  patchRun(id: string, patch: Partial<RunRecord>): boolean {
    try {
      const p = pathJoin(this.dir, "runs.jsonl");
      if (!existsSync(p)) return false;
      const lines = readFileSync(p, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try {
          const r = JSON.parse(lines[i]);
          if (r && r.id === id) {
            lines[i] = JSON.stringify({ ...r, ...patch });
            const tmp = p + ".tmp." + process.pid;
            writeFileSync(tmp, lines.join("\n"));
            renameSync(tmp, p);
            return true;
          }
        } catch { continue; }
      }
      return false;
    } catch { return false; }
  }

  /** 启动时截断历史：只保留最近 RUNS_KEEP 行。 */
  private truncateRuns() {
    try {
      const p = pathJoin(this.dir, "runs.jsonl");
      if (!existsSync(p)) return;
      const size = statSync(p).size;
      if (size < 256 * 1024) return;
      // 从文件尾部读出最后 RUNS_KEEP 行重写
      const fd = openSync(p, "r");
      const tailLen = Math.min(size, 1024 * 1024);
      const buf = Buffer.alloc(tailLen);
      readSync(fd, buf, 0, tailLen, size - tailLen);
      closeSync(fd);
      const lines = buf.toString("utf8").trim().split("\n").filter(Boolean).slice(-RUNS_KEEP);
      const tmp = p + ".tmp";
      writeFileSync(tmp, lines.join("\n") + "\n");
      renameSync(tmp, p);
    } catch {}
  }
}
