/**
 * aiti-plan-first · 核心测试（node --test；fake 事件流直接调 evalTurn，无需真 git-trace）
 *
 * 覆盖（方案 §10）：阈值边界、md 识别+忽略名单、游标推进/收缩重置/冷启动种子、
 * mute 跳过但游标推进、suggestedMd 去重+冷却、绑定命中（多仓归一化）、
 * plans.json 原子写/坏文件容错/修剪、buffer 去重。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evalTurn, emptyState, loadPlans, savePlans, prunePlans, dedupeOps,
  plansMtime, freshPlans,
  mdPathsOf, countFiles, planTouched, isIgnoredMd, SEEN_MD_CAP, BUFFER_CAP,
  compileIgnoreLines, isIgnoredBy, isNonPlanMd, isPlanLikeMd,
  parseFmTags, applyFmTags, isPlanFinalPhase, PLAN_FINAL_PHASES,
} from "./plan-core.ts";

const CFG = { bigFiles: 8, bigOps: 12, mdIgnores: [], suggestMd: true, staleRemind: true };
const NOW = 1726000000000;
const op = (n, root, paths, files) => ({ op: n, tool: "edit", stores: [{ root, paths, files }] });
const MD = "/repo";

// Windows 归一：产品用 path.resolve 拼绝对路径（win 产出盘符形态 D:\repo\x），
// 断言统一按 "/repo/x" 形态比较（产品语义正确，测试不钉平台路径形态）
const N = (v) => String(v).replace(/\\/g, "/").replace(/^[a-z]:\//i, "/");
const hasPath = (arr, p) => (arr || []).map(N).includes(p);
const normMd = (m) => ({ abs: N(m.abs), rel: m.rel, root: N(m.root) });

function base(over = {}) { return { ...emptyState(NOW), ...over }; }

test("规则边界：空 buffer / 无客户端 / muted → 无事件但游标推进", () => {
  assert.equal(evalTurn({ sessionId: "s", newOps: [], state: base(), cfg: CFG, now: NOW }).event, null);
  const r1 = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["a.ts"])], state: base(), cfg: CFG, now: NOW, hasClients: false });
  assert.equal(r1.event, null);
  assert.equal(r1.next.cursor, 1); // 游标照推
  const r2 = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/a.md"])], state: base({ muted: true }), cfg: CFG, now: NOW });
  assert.equal(r2.event, null);
  assert.equal(r2.next.cursor, 1);
  assert.ok(hasPath(r2.next.seenMd, "/repo/docs/a.md")); // seenMd 仍维护
});

test("冷启动种子：cursor=0 且首行 op>1 → 种子不吞历史，buffer 内 op 正常评估", () => {
  const r = evalTurn({ sessionId: "s", newOps: [op(7, MD, ["docs/new.md"])], state: base(), cfg: CFG, now: NOW });
  assert.equal(r.next.cursor, 7);
  assert.equal(r.event.kind, "suggest-md"); // 监听期间的新变更照常评估
  // 全新会话 op 从 1 起：无种子，正常
  const r2 = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/new.md"])], state: base(), cfg: CFG, now: NOW });
  assert.equal(r2.event.kind, "suggest-md");
  assert.equal(r2.next.cursor, 1);
});

test("进入会话检查（mode=enter）：历史台账不种子，方案命名 md → suggest-md；游标/suggestedMd 推进", () => {
  // 终端桥接/页面不在场场景：事件从未到达，历史台账首行 op=5（cursor=0）；turn 模式会种子吞掉，enter 模式要评
  const ops = [
    op(5, MD, ["src/a.ts"], { M: 2 }),
    op(6, MD, ["docs/new-design.md"], { A: 1 }),
  ];
  const r = evalTurn({ sessionId: "s", newOps: ops, state: base(), cfg: CFG, now: NOW, mode: "enter" });
  assert.equal(r.event.kind, "suggest-md");
  assert.equal(r.event.mdPaths[0].rel, "docs/new-design.md");
  assert.equal(r.next.cursor, 6); // 历史全部消费，settle 不会重弹
  assert.ok(hasPath(r.next.suggestedMd, "/repo/docs/new-design.md"));
  // 候选留档：lastSuggest 与事件一致（/status 未绑定时下发——下拉里持续可见、一键绑定）
  assert.deepEqual(r.next.lastSuggest, r.event.mdPaths);
  // 同批再进（重复 /check）→ 不重弹
  const r2 = evalTurn({ sessionId: "s", newOps: ops, state: r.next, cfg: CFG, now: NOW + 1, mode: "enter" });
  assert.equal(r2.event, null);
});

test("进入会话检查（enter）：未绑定不弹 lead；绑定态大改未跟 → stale（终端桥接唯一通道）；跟进 → 吞 null", () => {
  const codeOnly = [op(1, MD, ["src/a.ts", "src/b.ts", "src/c.ts"], { M: 3 })];
  assert.equal(evalTurn({ sessionId: "s", newOps: codeOnly, state: base(), cfg: CFG, now: NOW, mode: "enter" }).event, null);
  const bound = base({ plan: "/repo/docs/p.md", planRel: "docs/p.md", repoRoot: MD });
  // 绑定态大改未跟 → stale（2026-09：enter 评 stale，终端桥接会话事件级 settle 永远无评估的唯一自动提醒通道）
  const bigOps = [op(1, MD, ["src/x.ts", "src/y.ts", "src/z.ts"], { M: 8 })]; // CFG 阈值 8/12：8 文件 = 边界触发
  const r = evalTurn({ sessionId: "s", newOps: bigOps, state: bound, cfg: CFG, now: NOW, mode: "enter" });
  assert.equal(r.event.kind, "stale");
  assert.ok(r.next.staleCooldownUntil > NOW, "enter stale 也设 10min 冷却");
  // 冷却内重复进入不重弹
  assert.equal(evalTurn({ sessionId: "s", newOps: bigOps, state: r.next, cfg: CFG, now: NOW + 1, mode: "enter" }).event, null);
  // 已绑定 + 本轮跟进了方案 → 吞 null（followed 不从 /check 返回：客户端 applyRemind 会弹出「绑定态空壳」）
  const follow = [op(2, MD, ["docs/p.md"], { M: 1 })];
  assert.equal(evalTurn({ sessionId: "s", newOps: follow, state: bound, cfg: CFG, now: NOW, mode: "enter" }).event, null);
});

test("规则 A：md 变更弹绑定向导；同一文件不重复问；冷却期内新 md 也不问", () => {
  const st = base();
  const r = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/todo.md", "src/x.ts"])], state: st, cfg: CFG, now: NOW });
  assert.equal(r.event.kind, "suggest-md");
  assert.deepEqual(r.event.mdPaths.map(normMd), [{ abs: "/repo/docs/todo.md", rel: "docs/todo.md", root: "/repo" }]);
  assert.ok(hasPath(r.next.suggestedMd, "/repo/docs/todo.md"));
  assert.equal(r.next.cooldownUntil, NOW + 30 * 60 * 1000);
  // 同文件再来 → 不重复
  const r2 = evalTurn({ sessionId: "s", newOps: [op(2, MD, ["docs/todo.md"])], state: r.next, cfg: CFG, now: NOW + 1 });
  assert.equal(r2.event, null);
  // 冷却期内新 md → 不问（同类冷却）
  const r3 = evalTurn({ sessionId: "s", newOps: [op(3, MD, ["docs/other.md"])], state: r.next, cfg: CFG, now: NOW + 2 });
  assert.equal(r3.event, null);
  // 冷却过后新 md → 再问
  const r4 = evalTurn({ sessionId: "s", newOps: [op(4, MD, ["docs/other.md"])], state: r.next, cfg: CFG, now: NOW + 31 * 60 * 1000 });
  assert.equal(r4.event.kind, "suggest-md");
});

test("md 忽略名单：内置 + 追加 pattern 生效", () => {
  const md = mdPathsOf([op(1, MD, ["README.md", "CHANGELOG.md", "node_modules/x/y.md", "docs/plan.md", "x.d.md", ".aiti-trace/a.md"])]);
  assert.deepEqual(md.map((m) => m.rel), ["docs/plan.md"]); // 内置名单全滤掉
  const md2 = mdPathsOf([op(1, MD, ["notes/internal.md", "docs/keep.md"])], ["notes/**"]);
  assert.deepEqual(md2.map((m) => m.rel), ["docs/keep.md"]);
  assert.equal(isIgnoredMd("node_modules/a/b.md"), true);
});

test("明显非方案排除：skills/SKILL.md（ai-helper 帮助点）不触发绑定向导", () => {
  const CFG2 = { ...CFG, leadRemind: true };
  // 只改 skills 下的 SKILL.md → 不弹 suggest-md（排除生效），落 lead（写 skills 仍算在改代码）
  const r = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["skills/doc-search/SKILL.md"], { A: 1 })], state: base(), cfg: CFG2, now: NOW });
  assert.equal(r.event.kind, "lead");
  assert.ok(!isIgnoredMd("skills/doc-search/SKILL.md")); // 未进内置 md 忽略名单（lead 计数不受影响）
  assert.ok(isNonPlanMd("skills/doc-search/SKILL.md")); // 规则 A 检测时排除
  // 普通 docs md 照常建议
  const r2 = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/plan.md"])], state: base(), cfg: CFG2, now: NOW });
  assert.equal(r2.event.kind, "suggest-md");
});

test("明显非方案排除：agent 指令文件与社区样板 md 不触发绑定向导", () => {
  const CFG2 = { ...CFG, leadRemind: true };
  // 裸文件名（任意大小写/嵌套）+ 各家目录式 rules + 社区样板，均命中排除
  for (const rel of [
    "AGENTS.md", "agents.md", "Agents.md", "docs/AGENTS.md", "AGENTS.local.md", "AGENT.md",
    "CLAUDE.md", "claude.md", "docs/CLAUDE.local.md", "GEMINI.md", "gemini.md",
    "QWEN.md", "IFLOW.md", "iflow.md", "WARP.md", "CODEX.md", "BTT.md", "CONVENTIONS.md",
    "Contributing.md", "CODE_OF_CONDUCT.md", "code_of_conduct.md", "SECURITY.md", "MAINTAINERS.md",
    ".github/copilot-instructions.md", ".github/instructions/ts.instructions.md",
    ".cursor/rules/style.md", ".windsurf/rules/main.md", ".clinerules/go.md",
    ".roo/rules/base.md", ".kiro/steering/product.md", ".junie/guidelines.md",
    ".qoder/rules/x.md", ".trae/rules/project_rules.md", ".idx/airules.md",
    ".claude/commands/fix-issue.md", ".codex/prompts/review.md",
    ".pi/APPEND_SYSTEM.md", "sub/.pi/append_system.md",
    ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/bug.md",
  ]) assert.ok(isNonPlanMd(rel), rel);
  // 同名 subdir 近名不误吞（分段边界）：skillsfoo.md / .juniefoo/x.md / agents-guide.md 不排除
  assert.ok(!isNonPlanMd("skillsfoo.md"));
  assert.ok(!isNonPlanMd(".juniefoo/x.md"));
  assert.ok(!isNonPlanMd("docs/conventions-guide.md"));
  assert.ok(!isNonPlanMd("docs/agents-handbook.md"));
  // 只改 AGENTS.md → 不弹 suggest-md，落 lead（写 agent 文件仍算「在改代码」）
  const r = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["AGENTS.md"], { M: 1 })], state: base(), cfg: CFG2, now: NOW });
  assert.equal(r.event.kind, "lead");
  // 计划/设计命名不受新名单影响（design/方案 docs 照常是疑似方案）
  assert.ok(!isNonPlanMd("docs/design.md"));
  assert.ok(!isNonPlanMd("docs/方案.md"));
  assert.ok(isPlanLikeMd("docs/design.md")); // 互不干扰
});

test("跨实例新鲜度：plansMtime/freshPlans 感知外部写入（共享 configDir）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-fresh-"));
  try {
    assert.equal(plansMtime(dir), -1); // 缺文件
    const cache = { mtime: -2, plans: { version: 1, sessions: {} } };
    let p = freshPlans(cache, dir); // 首次：mtime -1 ≠ -2 → 读盘（缺文件→空）
    assert.equal(Object.keys(p.sessions).length, 0);
    assert.equal(cache.mtime, -1);
    // 本实例 bind：写盘 + 同步 mtime（persistPlans 等价）
    const mine = { version: 1, sessions: { a: { ...emptyState(1), plan: "/x/方案.md" } } };
    savePlans(dir, mine);
    cache.mtime = plansMtime(dir);
    // 另一实例写盘（bind 新会话）→ 本进程内存快照已过期
    const other = JSON.parse(JSON.stringify(mine));
    other.sessions.b = { ...emptyState(2), plan: "/y/plan.md" };
    savePlans(dir, other);
    p = freshPlans(cache, dir);
    assert.ok(p.sessions.b, "外部写入后 freshPlans 感知新会话（修复重弹根因）");
    assert.equal(cache.mtime, plansMtime(dir));
    // 盘没变 → 返回同一引用（未重读，无多余 IO）
    assert.equal(freshPlans(cache, dir), p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("front-matter tags 读写（parseFmTags/applyFmTags）", () => {
  assert.deepEqual(parseFmTags("---\ntags: [方案, 性能]\n---\n# T\n"), ["方案", "性能"]);
  assert.deepEqual(parseFmTags("---\ntags:\n  - a\n  - b\n---\nx"), ["a", "b"]);
  assert.deepEqual(parseFmTags("# 无 fm"), []);
  const w = applyFmTags("# 标题\n正文", ["方案", "性能"]);
  assert.ok(w.text.startsWith("---\ntags: [方案, 性能]\n---"));
  assert.deepEqual(w.tags, ["方案", "性能"]);
  const w2 = applyFmTags("---\ntags: [方案, 旧]\n---\nbody", ["新"], ["旧"]);
  assert.ok(w2.text.includes("tags: [方案, 新]"));
  assert.ok(!w2.tags.includes("旧"));
  const w3 = applyFmTags("---\r\ntags: [a]\r\n---\r\nb", ["b"]);
  assert.ok(w3.text.includes("\r\n"));
});

test("规则 A′：未绑定 + 已改文件 + 无非忽略 md → lead；冷却期内不再弹；绑定后不弹", () => {
  const CFG2 = { ...CFG, leadRemind: true };
  // 首轮改 1 个 ts 文件 → lead
  const r = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["src/a.ts"], { M: 1 })], state: base(), cfg: CFG2, now: NOW });
  assert.equal(r.event.kind, "lead");
  assert.equal(r.next.leadCooldownUntil, NOW + 30 * 60 * 1000);
  // 冷却期内再改 → 不弹
  const r2 = evalTurn({ sessionId: "s", newOps: [op(2, MD, ["src/b.ts"], { M: 1 })], state: r.next, cfg: CFG2, now: NOW + 1 });
  assert.equal(r2.event, null);
  // 冷却过后再改 → 再弹一次
  const r3 = evalTurn({ sessionId: "s", newOps: [op(3, MD, ["src/c.ts"], { M: 1 })], state: r.next, cfg: CFG2, now: NOW + 31 * 60 * 1000 });
  assert.equal(r3.event.kind, "lead");
  // 绑定后 → 不走 lead（走 stale/followed 分支）
  const st = base({ plan: "/repo/p.md", boundAt: NOW, leadCooldownUntil: 0 });
  const r4 = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["src/a.ts"], { M: 1 })], state: st, cfg: CFG2, now: NOW });
  assert.notEqual(r4.event?.kind, "lead");
  // 改的是 md（非忽略）→ suggest 优先于 lead
  const r5 = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/new.md"])], state: base(), cfg: CFG2, now: NOW });
  assert.equal(r5.event.kind, "suggest-md");
  // 重触已建议过的 md → 属非忽略文件改动 → 弹 lead
  // 种子由产品自己产出（suggestedMd 存的是 resolve 后的平台形态，测试不得钉 POSIX 串）
  const pre = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/old.md"])], state: base(), cfg: CFG2, now: NOW });
  const st6 = base({ suggestedMd: pre.next.suggestedMd });
  const r6 = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/old.md"], { M: 1 })], state: st6, cfg: CFG2, now: NOW });
  assert.equal(r6.event.kind, "lead");
  // 只改忽略文件（CHANGELOG）→ 不计 → 不弹
  const r7 = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["CHANGELOG.md"], { M: 1 })], state: base(), cfg: CFG2, now: NOW });
  assert.equal(r7.event, null);
});

test("方案命名优先：design/plan/方案 绕过冷却与去重，新生成即弹；同文件不重复问", () => {
  const st = base({ cooldownUntil: NOW + 30 * 60 * 1000, suggestedMd: ["/repo/docs/old.md"] }); // 冷却中
  // 新生成方案命名 md → 绕过冷却即弹，且排在最前
  const r = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/design.md"]), op(2, MD, ["notes.md"])], state: st, cfg: CFG, now: NOW });
  assert.equal(r.event.kind, "suggest-md");
  assert.equal(r.event.mdPaths[0].rel, "docs/design.md");
  assert.ok(hasPath(r.next.suggestedMd, "/repo/notes.md")); // 同轮其余一并记入
  // 同文件再改 → 不重复问（冷却照常约束其他文件）
  const r2 = evalTurn({ sessionId: "s", newOps: [op(3, MD, ["docs/design.md"])], state: r.next, cfg: CFG, now: NOW + 1 });
  assert.equal(r2.event, null);
  // 冷却后普通 md → 正常弹
  const r3 = evalTurn({ sessionId: "s", newOps: [op(4, MD, ["docs/other.md"])], state: r.next, cfg: CFG, now: NOW + 31 * 60 * 1000 });
  assert.equal(r3.event.kind, "suggest-md");
});

test("isPlanLikeMd：design/plan/方案/计划/设计/spec 命名识别", () => {
  assert.equal(isPlanLikeMd("docs/design.md"), true);
  assert.equal(isPlanLikeMd("docs/plan-v2.md"), true);
  assert.equal(isPlanLikeMd("方案.md"), true);
  assert.equal(isPlanLikeMd("docs/计划/x.md"), true);
  assert.equal(isPlanLikeMd("api-spec.md"), true);
  assert.equal(isPlanLikeMd("设计说明.md"), true);
  assert.equal(isPlanLikeMd("notes.md"), false);
  assert.equal(isPlanLikeMd("README.md"), false);
});

test("规则 B：大改动且方案未跟 → stale；阈值边界 =8 触发；小改动不触发", () => {
  const st = base({ plan: "/repo/docs/plan.md", planRel: "docs/plan.md", repoRoot: "/repo", boundAt: NOW });
  const big = Array.from({ length: 8 }, (_, i) => op(i + 1, MD, [`src/f${i}.ts`], { M: 1 }));
  const r = evalTurn({ sessionId: "s", newOps: big, state: st, cfg: CFG, now: NOW });
  assert.equal(r.event.kind, "stale");
  assert.equal(r.event.files, 8);
  assert.equal(r.event.ops, 8);
  assert.ok(r.event.sample.length <= 3 && r.event.sample.length >= 1);
  // =8 files 触发（边界已验），7 文件 + 3 ops 不触发
  const small = Array.from({ length: 7 }, (_, i) => op(i + 1, MD, [`src/g${i}.ts`], { M: 1 }));
  const r2 = evalTurn({ sessionId: "s", newOps: small, state: st, cfg: CFG, now: NOW });
  assert.equal(r2.event, null);
  // ops 阈值：6 文件 + 12 ops → 触发
  const manyOps = Array.from({ length: 12 }, (_, i) => op(i + 1, MD, [`src/h${i}.ts`], { M: 1 }));
  const r3 = evalTurn({ sessionId: "s", newOps: manyOps, state: st, cfg: CFG, now: NOW });
  assert.equal(r3.event.kind, "stale");
});

test("终态方案豁免 stale：方案/已实施、方案/已过时 → 大改不弹；评审中/无状态照弹（含 enter）", () => {
  const st = base({ plan: "/repo/docs/plan.md", planRel: "docs/plan.md", repoRoot: "/repo", boundAt: NOW });
  const big = Array.from({ length: 8 }, (_, i) => op(i + 1, MD, [`src/f${i}.ts`], { M: 1 }));
  // 终态（已实施）：不弹，游标照推、不设冷却
  const r = evalTurn({ sessionId: "s", newOps: big, state: st, cfg: CFG, now: NOW, planPhase: "方案/已实施" });
  assert.equal(r.event, null);
  assert.equal(r.next.cursor, 8);
  assert.equal(r.next.staleCooldownUntil, 0, "豁免不占 stale 冷却");
  // 终态（已过时）：同样豁免
  assert.equal(evalTurn({ sessionId: "s", newOps: big, state: st, cfg: CFG, now: NOW, planPhase: "方案/已过时" }).event, null);
  // 进行中（评审中）：照弹
  assert.equal(evalTurn({ sessionId: "s", newOps: big, state: st, cfg: CFG, now: NOW, planPhase: "方案/评审中" }).event.kind, "stale");
  // 无 phase（缺 front-matter/违约/未传）：老行为照弹
  assert.equal(evalTurn({ sessionId: "s", newOps: big, state: st, cfg: CFG, now: NOW }).event.kind, "stale");
  // enter 模式（终端桥接进入检查）：同样抑制
  assert.equal(evalTurn({ sessionId: "s", newOps: big, state: st, cfg: CFG, now: NOW, mode: "enter", planPhase: "方案/已实施" }).event, null);
  assert.equal(evalTurn({ sessionId: "s", newOps: big, state: st, cfg: CFG, now: NOW, mode: "enter", planPhase: "方案/评审中" }).event.kind, "stale");
  // 谓词与词表
  assert.equal(isPlanFinalPhase("方案/已实施"), true);
  assert.equal(isPlanFinalPhase("方案/已过时"), true);
  assert.equal(isPlanFinalPhase("方案/评审中"), false);
  assert.equal(isPlanFinalPhase(null), false);
  assert.equal(isPlanFinalPhase(""), false);
  assert.deepEqual([...PLAN_FINAL_PHASES], ["方案/已实施", "方案/已过时"]);
});

test("跟上豁免：方案 ∈ 本轮 paths → followed（多仓绝对路径归一化）", () => {
  const st = base({ plan: "/repo2/docs/plan.md", planRel: "docs/plan.md", repoRoot: "/repo2", boundAt: NOW });
  const r = evalTurn({ sessionId: "s", newOps: [op(1, "/repo", ["a.ts"]), op(2, "/repo2", ["docs/plan.md", "b.ts"])], state: st, cfg: CFG, now: NOW });
  assert.equal(r.event.kind, "followed");
  assert.ok(planTouched([op(9, "/repo2/", ["./docs/plan.md"])], "/repo2/docs/plan.md"));
  assert.equal(planTouched([op(9, "/repo2", ["docs/other.md"])], "/repo2/docs/plan.md"), false);
});

test("规则开关与阈值可配：suggestMd/staleRemind 关闭即静默", () => {
  const r = evalTurn({ sessionId: "s", newOps: [op(1, MD, ["docs/x.md"])], state: base(), cfg: { ...CFG, suggestMd: false }, now: NOW });
  assert.equal(r.event, null);
  const st = base({ plan: "/repo/p.md", boundAt: NOW });
  const big = Array.from({ length: 20 }, (_, i) => op(i + 1, MD, [`f${i}.ts`], { M: 1 }));
  const r2 = evalTurn({ sessionId: "s", newOps: big, state: st, cfg: { ...CFG, staleRemind: false }, now: NOW });
  assert.equal(r2.event, null);
});

test("台账收缩：最新 op < 游标 → 重置游标本轮静默", () => {
  const st = base({ cursor: 42 });
  const r = evalTurn({ sessionId: "s", newOps: [op(10, MD, ["a.ts"])], state: st, cfg: CFG, now: NOW });
  assert.equal(r.event, null);
  assert.equal(r.next.cursor, 10);
});

test("事件 buffer：排序去重（乱序/重复幂等）", () => {
  const out = dedupeOps([op(3, MD, ["c"]), op(1, MD, ["a"]), op(2, MD, ["b"]), op(2, MD, ["b-dup"])]);
  assert.deepEqual(out.map((o) => o.op), [1, 2, 3]);
});

test("countFiles：M+A+D 求和，跨 store 累加，缺 files 记 0", () => {
  assert.equal(countFiles([
    op(1, "/a", ["x"], { M: 2, A: 1, D: 1 }),
    { op: 2, stores: [{ root: "/b", paths: ["y"] }] },
  ]), 4);
});

test("plans.json：round-trip + 坏文件容错 + 30 天修剪", () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-plans-"));
  try {
    const plans = { version: 1, sessions: { s1: base({ plan: "/p.md", touchedAt: NOW }) } };
    savePlans(dir, plans);
    const loaded = loadPlans(dir);
    assert.equal(loaded.sessions.s1.plan, "/p.md");
    // 坏文件 → 新建不抛
    writeFileSync(join(dir, "plans.json"), "{oops");
    assert.deepEqual(loadPlans(dir).sessions, {});
    // 修剪：30 天内保留，更早清除
    const now = Date.now();
    const mixed = { version: 1, sessions: { fresh: base({ touchedAt: now }), stale: base({ touchedAt: now - 31 * 24 * 3600 * 1000 }) } };
    const pruned = prunePlans(mixed, now);
    assert.ok(pruned.sessions.fresh);
    assert.equal(pruned.sessions.stale, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seenMd LRU 上限", () => {
  let st = base();
  const ops = Array.from({ length: SEEN_MD_CAP + 10 }, (_, i) => op(i + 1, MD, [`n${i}.md`]));
  const r = evalTurn({ sessionId: "s", newOps: ops, state: st, cfg: { ...CFG, suggestMd: false }, now: NOW });
  assert.equal(r.next.seenMd.length, SEEN_MD_CAP);
  assert.ok(hasPath(r.next.seenMd, "/repo/n59.md")); // 最新在前
  assert.ok(!hasPath(r.next.seenMd, "/repo/n0.md")); // 最旧被挤出
});

test("BUFFER_CAP 常量与方案一致（500）", () => {
  assert.equal(BUFFER_CAP, 500);
});

// ---------- ignore 文件引擎（.gitignore/.aitiignore；选择器清单过滤） ----------

test("ignore 引擎：注释/否定/目录语义/锚定/** 跨段/无斜杠任意深度", () => {
  const pats = compileIgnoreLines("# 注释\n\nbuild/\n*.log\n!keep.log\n**/tmp\n/sub/x.md\nnode_modules/");
  const t = (p) => isIgnoredBy(p, [{ base: "", patterns: pats }]);
  assert.equal(t("build/x.md"), true);          // 目录语义：内容一并忽略
  assert.equal(t("build"), true);
  assert.equal(t("x.log"), true);               // 无斜杠 → 任意深度
  assert.equal(t("a/b/x.log"), true);
  assert.equal(t("keep.log"), false);           // ! 否定后命中优先
  assert.equal(t("a/b/tmp/c.md"), true);        // **/ 跨段
  assert.equal(t("sub/x.md"), true);            // /sub/x.md 锚定
  assert.equal(t("other/sub/x.md"), false);     // 锚定不匹配别处
  assert.equal(t("README.md"), false);
});

test("ignore 引擎：base 作用域（子目录 .gitignore 只管子树）+ 集合顺序否定", () => {
  const sets = [
    { base: "", patterns: compileIgnoreLines("docs/keep.md") },
    { base: "sub/", patterns: compileIgnoreLines("!keep.md\n*.tmp") },
  ];
  assert.equal(isIgnoredBy("docs/keep.md", sets), true);
  assert.equal(isIgnoredBy("sub/keep.md", sets), false); // 子目录 ! 否定覆盖根规则
  assert.equal(isIgnoredBy("sub/a.tmp", sets), true);
  assert.equal(isIgnoredBy("other/a.tmp", sets), false); // sub/ 的 *.tmp 不越界
});
