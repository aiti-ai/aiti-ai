/**
 * aiti-plan-first · 核心逻辑（纯 ESM，index.ts 与 node:test 直接可导入）
 *
 * 职责（docs/aiti-plan-first-plan.md §4/§5）：
 *   - 决策引擎 evalTurn：本轮 op 事件 buffer → suggest-md / stale / followed（纯函数）
 *   - md 识别 + 忽略名单（内置 glob + 追加）+ 多仓路径归一化
 *   - plans.json 状态仓（tmp+rename 原子写 + 坏文件容错 + 30 天未活跃修剪）
 *
 * 红线：不读其他扩展 configDir——op 数据一律来自 aiti-git-trace services.trace 事件/出口；
 * 本文件 fs 仅限本扩展 configDir/plans.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve } from "node:path";

// ---------- 类型 ----------

/** 台账行 plan-first 关心的子集（aiti-git-trace LedgerRow 同构，字段容忍缺失） */
export interface OpRowLite {
  op: number;
  tool?: string;
  /** A01 方向1：共享 worktree 并行污染疑似行（git-trace 打标）——绑定向导 md 检测过滤之 */
  suspect?: boolean;
  stores?: { root: string; files?: { M?: number; A?: number; D?: number }; paths?: string[] }[];
}

export interface PlanState {
  plan: string | null; // 绑定方案文档绝对路径；未绑定 = null
  planRel: string | null; // cwd 相对路径（@file 插入用；cwd 外则存绝对路径文本）
  repoRoot: string | null; // 绑定时所在仓根（多仓归一化用）
  boundAt: number;
  cursor: number; // 已消费的台账 op 编号（增量游标）
  muted: boolean; // 「不再提醒」；点工具条按钮解除
  suggestedMd: string[]; // 已 suggest 过的 md 绝对路径（同一文件不重复问）
  lastSuggest?: { abs: string; rel: string; root: string }[]; // 最近一次绑定向导候选（≤5；/status 未绑定时下发——事件只弹一次，之后用户手动打开下拉仍可见可一键绑定）
  seenMd: string[]; // 历史触达 md 绝对路径（md 选择器记忆，上限 SEEN_MD_CAP，LRU）
  cooldownUntil: number; // suggest 类提醒冷却（被拒后 30min 内不问同类）
  leadCooldownUntil: number; // 领先提醒冷却（独立于 suggest——避免压住用户刚开写的 md 绑定向导）
  staleCooldownUntil: number; // 失联提醒冷却（防频繁重复弹：触发后 10min 内不再弹）
  touchedAt: number; // 最近活跃（修剪用）
}

export interface EvalCfg {
  bigFiles: number; // 单轮文件数阈值
  bigOps: number; // 单轮 op 数阈值
  mdIgnores: string[]; // 追加 md 忽略（gitignore 式 glob，一行一条）
  suggestMd: boolean; // 规则 A 开关
  leadRemind: boolean; // 规则 A′ 开关（领先提醒）
  staleRemind: boolean; // 规则 B 开关
}

export type PlanEvent =
  | { kind: "suggest-md"; sessionId: string; mdPaths: { abs: string; rel: string; root: string }[] }
  | { kind: "lead"; sessionId: string; mdPaths?: { abs: string; rel: string; root: string }[] }
  | { kind: "stale"; sessionId: string; files: number; ops: number; sample: string[]; plan: string; planRel: string | null }
  | { kind: "followed"; sessionId: string };

export interface PlansFile {
  version: number;
  sessions: Record<string, PlanState>;
}

/** 方案文档终态 status tag（front-matter `方案/*`）：方案已实施/已过时 = 已完结、
 *  代码再大改也无需再跟催文档（用户诉求：完成了的方案不要再提醒）。 */
export const PLAN_FINAL_PHASES: readonly string[] = ["方案/已实施", "方案/已过时"];

export function isPlanFinalPhase(phase: string | null | undefined): boolean {
  return !!phase && PLAN_FINAL_PHASES.includes(phase);
}

export const BUILTIN_MD_IGNORES = ["README*", "CHANGELOG*", "LICENSE*", "node_modules/**", ".aiti-trace/**", "**/*.d.md"];
/** agent 指令/上下文 md 裸文件名（小写存入，匹配时大小写不敏感）——AGENTS.md 为开放标准
 *  （https://agents.md，Codex/Cursor/Amp/Jules/Kiro/OpenCode/Copilot CLI/Warp 等通用），
 *  其余为各家工具原生约定：CLAUDE.md（Claude Code，含 .local）、GEMINI.md（Gemini CLI）、
 *  QWEN.md（Qwen Code）、IFLOW.md（iFlow CLI）、WARP.md（Warp）、CODEX.md（Codex CLI 旧名）、
 *  AGENT.md+BTT.md（h@llo.ai）、CONVENTIONS.md（aider）。大小写不敏感：Win/macOS 盘上
 *  Agents.md 也生效，逐变体枚举兜不全 */
const AGENT_INSTRUCTION_MDS = [
  "agents.md", "agents.local.md", "agent.md", "btt.md",
  "claude.md", "claude.local.md", "gemini.md", "qwen.md", "iflow.md",
  "warp.md", "codex.md", "conventions.md",
];

/** 明显非方案的 md 裸文件名（小写；agent 指令 + 社区样板） */
const NON_PLAN_BASENAMES = [
  ...AGENT_INSTRUCTION_MDS,
  // 社区样板/元信息（永不承载方案）
  "contributing.md", "security.md", "code_of_conduct.md", "support.md",
  "authors.md", "contributors.md", "maintainers.md", "governance.md", "adopters.md",
  // 本仓约定：追加系统提示词（aiti-append-system）
  "append_system.md",
];
const NON_PLAN_BASENAME_SET = new Set(NON_PLAN_BASENAMES);

/** 明显不是方案文档的 md——目录/结构式 glob（大小写敏感 Linux 语义）：
 *  扩展 skills（SKILL.md 帮助点）+ agent 自用命令/prompt 模板 + 各家目录式 rules 约定 +
 *  GitHub 模板目录。与裸名集合合用见 isNonPlanMd */
export const NON_PLAN_MD_PATTERNS = [
  "**/skills/**", "**/SKILL.md",
  "**/.github/copilot-instructions.md", "**/.github/instructions/**",
  "**/.cursor/rules/**", "**/.windsurf/rules/**", "**/.clinerules/**", "**/.roo/rules/**",
  "**/.kiro/steering/**", "**/.junie/**", "**/.qoder/rules/**", "**/.trae/rules/**",
  "**/.idx/airules.md", "**/.goose/**",
  "**/.claude/commands/**", "**/.codex/prompts/**",
  "**/.github/ISSUE_TEMPLATE/**", "**/.github/PULL_REQUEST_TEMPLATE.md",
];

/** 规则 A 检测：明显非方案 = 目录式 glob 命中 ‖ 裸文件名命中（大小写不敏感，任意深度）；
 *  不影响 lead 计数（写这些仍算「在改代码」→ 领先提醒照常）与选择器清单（事实列表） */
export function isNonPlanMd(rel: string, extraIgnores: string[] = []): boolean {
  const p = rel.replace(/^\.\//, "");
  const segs = p.split("/");
  if (NON_PLAN_BASENAME_SET.has((segs[segs.length - 1] || p).toLowerCase())) return true;
  return isIgnoredMd(p, [...NON_PLAN_MD_PATTERNS, ...extraIgnores]);
}

/** 方案命名识别（大小写不敏感；中文无大小写直接匹配路径）——命名带方案味的 md 优先建议 */
export function isPlanLikeMd(rel: string): boolean {
  if (/方案|计划|设计/.test(rel)) return true;
  const lower = rel.toLowerCase();
  return /(^|[^a-z])(design|plan|spec|rfc)([^a-z]|$)/.test(lower);
}
export const SEEN_MD_CAP = 50;
export const BUFFER_CAP = 500; // 单会话事件 buffer 上限（§3.4）
export const SUGGEST_COOLDOWN_MS = 30 * 60 * 1000;
export const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天未活跃修剪

export function emptyState(now = Date.now()): PlanState {
  return {
    plan: null, planRel: null, repoRoot: null, boundAt: 0,
    cursor: 0, muted: false, suggestedMd: [], seenMd: [], cooldownUntil: 0, leadCooldownUntil: 0, staleCooldownUntil: 0, touchedAt: now,
  };
}

// ---------- md 忽略（简化 glob：** 跨段 / * 单段 / ? 单字符 / 结尾 / = 目录前缀） ----------

/** 单条 gitignore 式 glob → 正则（分段构建保证段边界，不会误吞 skillsfoo 这类近名文件）；
 *  无斜杠 = 任意深度；尾斜杠 = 仅目录（内容一并忽略）；大小写敏感（Linux 语义） */
function escSeg(seg: string): string {
  let r = "";
  for (const ch of seg) {
    if (ch === "*") r += "[^/]*";
    else if (ch === "?") r += "[^/]";
    else r += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return r;
}

/** 单条 gitignore 式 glob → 正则（分段构建保证段边界，不会误吞 skillsfoo 这类近名文件）；
 *  无斜杠 = 任意深度；尾斜杠 = 仅目录（内容一并忽略）；大小写敏感（Linux 语义） */
export function compileIgnoreGlob(glob: string): RegExp {
  let body = glob;
  let pre = "";
  let tail = "(?:/.*)?";
  if (body === "**") return /^.*$/;
  const anchored = body.includes("/");
  if (body.endsWith("/**")) { body = body.slice(0, -3); tail = "/.*"; }
  else if (body.endsWith("/")) { body = body.slice(0, -1); tail = "/.*"; }
  if (!anchored) pre += "(?:[^/]+/)*"; // 无斜杠 → 任意深度
  if (body.startsWith("**/")) { pre += "(?:.*/)?"; body = body.slice(3); }
  else if (body.startsWith("**")) { pre += ".*"; body = body.slice(2); }
  if (!body) return new RegExp("^" + pre + (tail === "/.*" ? "/.*" : "") + "$");
  if (body.startsWith("/")) body = body.slice(1); // 锚定：去根斜杠（/sub/x.md → sub/x.md）
  const parts: string[] = [];
  const segs = body.split("/**/");
  for (let i = 0; i < segs.length; i++) {
    if (i > 0) parts.push("(?:.*/)?");
    parts.push(escSeg(segs[i]));
  }
  return new RegExp("^" + pre + parts.join("/") + tail + "$");
}

export function isIgnoredMd(rel: string, extraPatterns: string[] = []): boolean {
  const p = rel.replace(/^\.\//, "");
  for (const g of [...BUILTIN_MD_IGNORES, ...extraPatterns]) {
    if (!g) continue;
    try { if (compileIgnoreGlob(g).test(p)) return true; } catch { /* 坏 pattern 跳过 */ }
  }
  return false;
}

// ---------- op 行工具（多仓归一化 + 计数） ----------

export function normRoot(root: string | undefined | null): string {
  return pathResolve(String(root || "."));
}

/** 本轮触达的全部 (root, rel) 路径对（跨 store 摊平） */
export function pathsOf(ops: OpRowLite[]): { root: string; rel: string }[] {
  const out: { root: string; rel: string }[] = [];
  for (const op of ops) for (const st of op.stores ?? []) {
    const root = normRoot(st.root);
    for (const p of st.paths ?? []) out.push({ root, rel: String(p).replace(/^\.\//, "") });
  }
  return out;
}

/** 本轮 md 路径（识别 + 忽略名单过滤；abs 归一化去重） */
export function mdPathsOf(ops: OpRowLite[], extraIgnores: string[] = []): { abs: string; rel: string; root: string }[] {
  const out: { abs: string; rel: string; root: string }[] = [];
  const seen = new Set<string>();
  // A01：suspect 行（非核心写工具 op——共享 worktree 下可能是并行他 session 的写入）不进
  // 绑定向导候选，避免「发现疑似方案文档」误报；数据仍在台账（回滚安全）。
  const trusted = ops.filter((op) => !op.suspect);
  for (const { root, rel } of pathsOf(trusted)) {
    if (!/\.md$/i.test(rel)) continue;
    if (isIgnoredMd(rel, extraIgnores)) continue;
    const abs = pathResolve(root, rel);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ abs, rel, root });
  }
  return out;
}

/** files 计数口径（§5）：Σ stores[].files 的 M+A+D（diffstat 权威，不受 paths 截断影响） */
export function countFiles(ops: OpRowLite[]): number {
  let n = 0;
  for (const op of ops) for (const st of op.stores ?? []) {
    const f = st.files ?? {};
    n += (Number(f.M) || 0) + (Number(f.A) || 0) + (Number(f.D) || 0);
  }
  return n;
}

/** 绑定方案是否在本轮被触达（绝对路径归一化比对，跨 store） */
export function planTouched(ops: OpRowLite[], planAbs: string | null | undefined): boolean {
  if (!planAbs) return false;
  const want = pathResolve(planAbs);
  return pathsOf(ops).some(({ root, rel }) => pathResolve(root, rel) === want);
}

/** 事件 buffer 排序去重（幂等；op 编号为准） */
export function dedupeOps(ops: OpRowLite[]): OpRowLite[] {
  const seen = new Set<number>();
  const out: OpRowLite[] = [];
  for (const o of [...ops].sort((a, b) => (Number(a.op) || 0) - (Number(b.op) || 0))) {
    const k = Number(o.op) || 0;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

// ---------- 决策引擎（§5 规则表；纯函数） ----------

export interface EvalInput {
  sessionId: string;
  newOps: OpRowLite[]; // 本轮事件 buffer（跳号时调用方已用 readOps 回填；排序去重在此兜底）
  state: PlanState;
  cfg: EvalCfg;
  now?: number;
  hasClients?: boolean; // SSE 无客户端 → 照常推进游标但不产生事件
  /** 绑定方案的状态 tag（front-matter `方案/*`，调用方解析后传入；终态 → 不再 stale 跟催） */
  planPhase?: string | null;
  /** turn=轮次评估（缺省：冷启动种子 + lead/stale）；enter=进入会话检查（评估历史台账、只做绑定向导） */
  mode?: "turn" | "enter";
}
export interface EvalResult { next: PlanState; event: PlanEvent | null }

export function evalTurn(input: EvalInput): EvalResult {
  const { sessionId, cfg } = input;
  const now = input.now ?? Date.now();
  const hasClients = input.hasClients !== false;
  const safeStaleCd = Number((input.state as any)?.staleCooldownUntil) || 0;
  const state: PlanState = { ...input.state, suggestedMd: [...input.state.suggestedMd], seenMd: [...input.state.seenMd], staleCooldownUntil: safeStaleCd };
  const ops = dedupeOps(input.newOps);
  if (!ops.length) return { next: state, event: null };

  const lastOp = Number(ops[ops.length - 1].op) || 0;
  // 台账收缩（清理/换仓）：最新 op < 游标 → 重置游标，本轮静默（§4）
  if (lastOp < state.cursor) return { next: { ...state, cursor: lastOp }, event: null };
  // 游标过滤：≤ cursor 的已消费 op 不再评估（进入检查与轮次冲刷双通道共用后的幂等保障；
  // 也防事件重发/重复投递导致重弹）。ops 按 op 升序，过滤只去头部，lastOp 不变。
  const pending = ops.filter((o) => (Number(o.op) || 0) > state.cursor);
  if (!pending.length) return { next: state, event: null };
  // 冷启动种子：无基线（cursor=0）且首行 op>1 → 历史不吞为本轮（§3.4）。
  // enter 模式不种子——进入会话检查恰是要把「事件从未到达」的历史纳入评估（终端桥接/页面不在场/装扩展前）。
  if (input.mode !== "enter" && state.cursor === 0 && (Number(pending[0].op) || 0) > 1) state.cursor = (Number(pending[0].op) || 1) - 1;

  const finish = (event: PlanEvent | null): EvalResult => ({ next: { ...state, cursor: Math.max(state.cursor, lastOp) }, event });
  const md = mdPathsOf(pending, cfg.mdIgnores);
  for (const p of md) state.seenMd = [p.abs, ...state.seenMd.filter((x) => x !== p.abs)].slice(0, SEEN_MD_CAP);

  if (!hasClients || state.muted) return finish(null);

  if (!state.plan) {
    // 规则 A：绑定向导（未绑定 + 新 md）。方案命名的 md 优先——绕过冷却，新生成即问；
    // 同轮其余 md 排后（一并记入 suggestedMd，可见于同一次弹窗）
    const fresh = md.filter((p) => !state.suggestedMd.includes(p.abs) && !isNonPlanMd(p.rel, cfg.mdIgnores));
    const planLike = fresh.filter((p) => isPlanLikeMd(p.rel));
    const others = fresh.filter((p) => !isPlanLikeMd(p.rel));
    if (cfg.suggestMd && planLike.length) {
      const candidates = [...planLike, ...others].slice(0, 5);
      state.lastSuggest = candidates; // 候选留档：/status 未绑定时下发（下拉里持续可见、一键绑定）
      state.suggestedMd = [...state.suggestedMd, ...fresh.map((p) => p.abs)];
      state.cooldownUntil = now + SUGGEST_COOLDOWN_MS;
      return finish({ kind: "suggest-md", sessionId, mdPaths: candidates });
    }
    if (cfg.suggestMd && now >= state.cooldownUntil && others.length) {
      const candidates = others.slice(0, 5);
      state.lastSuggest = candidates;
      state.suggestedMd = [...state.suggestedMd, ...others.map((p) => p.abs)];
      state.cooldownUntil = now + SUGGEST_COOLDOWN_MS;
      return finish({ kind: "suggest-md", sessionId, mdPaths: candidates });
    }
    if (input.mode === "enter") return finish(null); // 进入检查只做绑定向导：lead 是「正在干活」的轮次语义
    // 规则 A′：领先提醒（未绑定 + 改了代码或任何非忽略文件 ≥ 1；忽略文件不计——CHANGELOG 等不触发）
    // 冷却独立于 suggest：领先提醒 fired 后 30min 内不重复，但用户开写 md 时绑定向导不被压住
    if (cfg.leadRemind && now >= (Number(state.leadCooldownUntil) || 0)) {
      const touched = new Set<string>();
      for (const row of pending) {
        for (const st of row.stores ?? []) {
          const root = normRoot(st.root);
          for (const p of st.paths ?? []) {
            const rel0 = String(p).replace(/^\.\//, "");
            if (isIgnoredMd(rel0, cfg.mdIgnores)) continue; // 忽略文件不计
            touched.add(pathResolve(root, rel0));
          }
        }
      }
      // 实际有修改才算“开始改代码”（调研/查询修改 0 文件不触发 lead）
      if (touched.size >= 1 && countFiles(pending) > 0) {
        state.leadCooldownUntil = now + SUGGEST_COOLDOWN_MS;
        // Lead events carry candidates: likely plan docs touched this turn are listed for
        // one-click binding — when suggest-md is suppressed (suggestedMd memory after "not
        // now", or its cooldown), lead is the only channel that shows them. Scope = md
        // (already ignore-filtered) minus isNonPlanMd (agent-instruction/boilerplate files
        // must not mislead); suggestedMd is NOT filtered (dismissed files get a second
        // chance; lead's own 30min cooldown prevents nagging); plan-like names first, cap 5.
        // Syncs state.lastSuggest (/status candidates coupling: still visible in the
        // dropdown after the popup closes); does NOT write suggestedMd — showing here is
        // not "asked", later turns keep their suggest-md asking rights.
        const leadCands = md.filter((p) => !isNonPlanMd(p.rel, cfg.mdIgnores));
        leadCands.sort((a, b) => Number(isPlanLikeMd(b.rel)) - Number(isPlanLikeMd(a.rel)));
        const candidates = leadCands.slice(0, 5);
        if (candidates.length) state.lastSuggest = candidates;
        return finish({ kind: "lead", sessionId, mdPaths: candidates });
      }
    }
    return finish(null);
  }

  const planWasTouched = planTouched(pending, state.plan);
  if (input.mode === "enter") {
    // 绑定态进入：stale 是合法事件（终端桥接等事件不可达场景的唯一自动提醒通道——
    // 台账持续增长而 cursor 冻结，进入时一次性拉增量评估，§5.1 用户动作触发非轮询）；
    // followed 吞为 null：从 /check 返回会被客户端 applyRemind 弹出「绑定态空壳」
    // （kind 无匹配分支）——深审 2026-09 实证过这种空壳形态，勿回退。
    if (planWasTouched) return finish(null);
  }
  // 跟上豁免：绑定方案 ∈ 本轮 paths（绝对路径归一化比对）
  if (planWasTouched) return finish({ kind: "followed", sessionId });
  // 规则 B：失联提醒（大改动 && 方案未跟）；触发后 10min 冷却防频繁重复弹
  if (!cfg.staleRemind) return finish(null);
  // 终态方案（方案/已实施、方案/已过时）不再跟催：方案已完结，代码演进无需再同步该文档
  if (isPlanFinalPhase(input.planPhase)) return finish(null);
  if (now < (Number(state.staleCooldownUntil) || 0)) return finish(null);  // 冷却中不再弹
  const files = countFiles(pending);
  if (files < cfg.bigFiles && pending.length < cfg.bigOps) return finish(null);
  const staleTriggered = files > 0 && (files >= cfg.bigFiles || pending.length >= cfg.bigOps);
  if (staleTriggered) state.staleCooldownUntil = now + 10 * 60 * 1000; // 10 分钟冷却
  const sample: string[] = [];
  for (const op of pending) {
    for (const st of op.stores ?? []) for (const p of (st.paths ?? []).slice(0, 2)) {
      if (sample.length >= 3) break;
      sample.push(String(p));
    }
    if (sample.length >= 3) break;
  }
  if (!staleTriggered) return finish(null);
  return finish({ kind: "stale", sessionId, files, ops: pending.length, sample, plan: state.plan, planRel: state.planRel });
}

// ---------- front-matter tags 读写（方案文档闭环；与 doc-center 子集兼容） ----------

/** 读 front-matter tags（flow 列表 / 块列表 / 裸值）；无 fm → [] */
export function parseFmTags(text: string): string[] {
  const lines = String(text || "").split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return [];
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") { end = i; break; }
  }
  if (end < 0) return [];
  const tags: string[] = [];
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(lines[i]);
    if (!m || m[1].toLowerCase() !== "tags") continue;
    const val = m[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      for (const part of val.slice(1, -1).split(",")) {
        const v = part.trim().replace(/^["']|["']$/g, "");
        if (v) tags.push(v);
      }
    } else if (val === "") {
      for (let j = i + 1; j < end; j++) {
        const bm = /^\s+-\s+(.*)$/.exec(lines[j]);
        if (!bm) break;
        const v = bm[1].trim().replace(/^["']|["']$/g, "");
        if (v) tags.push(v);
      }
    } else if (val) tags.push(val);
  }
  return tags;
}

/** tags 写回（纯字符串变换）：无 fm → 文首新建块；有 → tags 行改写为 flow 列表；CRLF 保持；归一去重 */
export function applyFmTags(text: string, add: string[] = [], remove: string[] = []): { text: string; tags: string[] } {
  const norm = (t: string) => t.trim();
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const hasFm = lines.length > 0 && lines[0].trim() === "---";
  let closeIdx = -1;
  if (hasFm) for (let i = 1; i < lines.length; i++) { const t = lines[i].trim(); if (t === "---" || t === "...") { closeIdx = i; break; } }
  let existing: string[] = [];
  let tagsIdx = -1;
  let tagsBlockEnd = -1; // tags 行后连续块列表行（含）——改写时折叠，防孤行/丢 tag
  if (hasFm && closeIdx > 0) {
    for (let i = 1; i < closeIdx; i++) {
      const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(lines[i]);
      if (!m || m[1].toLowerCase() !== "tags") continue;
      tagsIdx = i;
      existing = [];
      tagsBlockEnd = -1;
      const val = m[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        for (const part of val.slice(1, -1).split(",")) { const v = norm(part); if (v) existing.push(v); }
      } else if (val === "") {
        for (let j = i + 1; j < closeIdx; j++) {
          const bm = /^\s+-\s+(.*)$/.exec(lines[j]);
          if (!bm) break;
          const v = norm(bm[1].replace(/^["']|["']$/g, ""));
          if (v) existing.push(v);
          tagsBlockEnd = j;
        }
      } else if (val) existing.push(norm(val));
    }
  }
  const rm = new Set(remove.map(norm).filter(Boolean));
  const merged: string[] = [];
  for (const t of [...existing, ...add.map(norm)]) {
    const v = norm(t);
    if (!v || rm.has(v) || merged.includes(v)) continue;
    merged.push(v);
  }
  const flow = "tags: [" + merged.join(", ") + "]";
  let out: string[];
  if (hasFm && closeIdx > 0) {
    out = [...lines];
    if (tagsIdx >= 0) {
      out[tagsIdx] = flow;
      if (tagsBlockEnd >= tagsIdx) out.splice(tagsIdx + 1, tagsBlockEnd - tagsIdx); // 折叠旧块列表行
    } else {
      out.splice(closeIdx, 0, flow);
    }
  } else {
    out = ["---", flow, "---", "", ...lines];
  }
  return { text: out.join(nl), tags: merged };
}

// ---------- plans.json 状态仓（原子写 + 容错 + 修剪） ----------

export function plansFile(configDir: string): string {
  return pathJoin(configDir, "plans.json");
}

export function loadPlans(configDir: string): PlansFile {
  try {
    const j = JSON.parse(readFileSync(plansFile(configDir), "utf8"));
    if (j && typeof j === "object" && j.sessions && typeof j.sessions === "object") {
      return { version: 1, sessions: j.sessions as Record<string, PlanState> };
    }
  } catch { /* 缺失/坏文件 → 新建 */ }
  return { version: 1, sessions: {} };
}

export function savePlans(configDir: string, plans: PlansFile): void {
  const f = plansFile(configDir);
  mkdirSync(configDir, { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(plans), "utf8");
  renameSync(tmp, f);
}

// ---------- 跨实例新鲜度（共享 configDir：dev 与生产 PI_WEB_DATA_DIR 同盘） ----------
// plans 是进程内存快照；另一实例（或 watchdog）写入后本进程不重读 → 已绑定的会话在
// 另一实例打开时 st.plan 为空 → 进入检查/settle 用过期状态重弹「疑似方案」。
// 解法：mtime 感知的惰性重读——仅在事件/API 调用时刻校验 mtime（无定时器，零轮询），
// 变了才重读盘；写方原子 rename 保证 mtime 变化可靠。

/** mtime 缓存容器（进程级持有） */
export interface PlansCache { mtime: number; plans: PlansFile }

/** plans.json 当前 mtime；缺失/不可达 → -1 */
export function plansMtime(configDir: string): number {
  try { return statSync(plansFile(configDir)).mtimeMs; } catch { return -1; }
}

/** 惰性新鲜读：cache.mtime 与盘上不一致（含首次）才重读，返回最新 plans（可能重新赋值 cache.plans） */
export function freshPlans(cache: PlansCache, configDir: string): PlansFile {
  const m = plansMtime(configDir);
  if (m !== cache.mtime) {
    cache.mtime = m;
    cache.plans = loadPlans(configDir);
  }
  return cache.plans;
}

/** 30 天未活跃的 session 条目清除（§4；绑定/mute 状态也照删——过期即忘） */
export function prunePlans(plans: PlansFile, now = Date.now(), maxAgeMs = PRUNE_AGE_MS): PlansFile {
  const sessions: Record<string, PlanState> = {};
  for (const [sid, st] of Object.entries(plans.sessions)) {
    if ((Number(st?.touchedAt) || 0) >= now - maxAgeMs) sessions[sid] = st;
  }
  return { version: plans.version, sessions };
}

/** stateOf + 保存的便捷封装（index.ts 用） */
export function stateOf(plans: PlansFile, sessionId: string, now = Date.now()): PlanState {
  return plans.sessions[sessionId] ?? emptyState(now);
}

// ---------- ignore 文件（.gitignore / .aitiignore——选择器清单过滤用；简化 gitignore 语义） ----------

export interface IgnorePattern { re: RegExp; negate: boolean }
/** base = 相对走查根的 posix 目录（"" = 根；"sub/" 带尾斜杠）——该集合只作用于 base 之下的路径 */
export interface IgnoreSet { base: string; patterns: IgnorePattern[] }

/** 解析 ignore 文本：# 注释、! 否定（后命中优先）、尾 / 仅目录、含 / 锚定、** 跨段、* ? 单层 */
export function compileIgnoreLines(text: string): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (let raw of String(text || "").split("\n")) {
    raw = raw.replace(/\r$/, "");
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    let negate = false;
    if (raw.startsWith("!")) { negate = true; raw = raw.slice(1); }
    if (raw.endsWith("/")) raw = raw.slice(0, -1); // 目录语义：目录与其内容经前缀匹配一并忽略
    try { out.push({ re: compileIgnoreGlob(raw), negate }); } catch { /* 坏 pattern 跳过 */ }
  }
  return out;
}

/** 依集合顺序逐个匹配（集合内按行序），最后一次命中决定忽略与否（! 否定） */
export function isIgnoredBy(rel: string, sets: IgnoreSet[]): boolean {
  let ignored = false;
  for (const set of sets) {
    if (set.base && !(rel + "/").startsWith(set.base)) continue;
    const sub = set.base ? rel.slice(set.base.length) : rel;
    for (const p of set.patterns) if (p.re.test(sub)) ignored = !p.negate;
  }
  return ignored;
}
