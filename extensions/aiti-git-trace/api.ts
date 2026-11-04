import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
/**
 * aiti-git-trace · API 处理层（纯 ESM，node:test 直接可测）
 *
 * handleApi(req, {path, searchParams}, {configDir, dir, allowRoot}) → Response
 * 路由表（方案 §5.2/§5.3/§6.3/§7.2；总览视图 docs/aiti-git-trace-overview-view-plan.md §3）：
 *   GET  ops?session=&fixture=            台账读取（fixture 驱动开发）
 *   GET  fork-preview?session=&entryId=   fork 点后 op 摘要（空 → 前端直通）；响应附带 files/totals 聚合（R4）
 *   POST fork-preview {session,entryIds}  按被裁轮集合圈定；响应附带 files/totals 聚合（R4）
 *   GET  files?session=&entryIds=a,b      变更总览聚合（只读；storeMissing/rejected 部分返回）
 *   GET  file-diff?root=&session=&base=&target=&path=&maxLines=  单文件区间 diff（只读，截断保护）
 *   POST rollback                         全量回撤（safety → read-tree -u --reset → 记账）
 *   POST rollback-partial                 部分回滚（过滤逆 patch → apply -R → -3 兜底 → 记账）
 *   POST workspace/resolve {cwd}          workspace key + 配置 + nogit 探测
 *   GET/POST/DELETE workspace?key=        关注路径配置 CRUD（原子写）
 *   POST watch/resolve {path}             单路径归属（walk-up + 嵌套仓扫描）
 *   POST new-session-cwd {targetDir,cwd}  @到新会话 CWD 判定（不随便变更：目标在当前 CWD/关注路径内保持，否则切目标）
 *   GET  excludes                         内置排除清单内容
 *   GET  events                           SSE：op 事件实时推（services.trace.onOp 同一 bus；方案 §3.2）
 */
import {
  repoRootOf, storeOk, sanitizeSession, workspaceKey,
  readOps, readOpsWithMeta, appendOps, forkPreviewOps, sessionRepoRoots,
  rollbackFull, rollbackPartial, forkPreviewOpsByUserEntries, rollbackOpsReversed,
  loadWorkspace, saveWorkspace, deleteWorkspace, resolveWatchPath,
  ensureExcludesFile, looseDecision, cleanupSessionOps, cleanupWorkspace, lineage,
  sessionFileSummary, fileDiffText,
} from "./trace-core.ts";
import { resolveNewSessionCwd } from "@aiti-ai/ext-shared/new-session-cwd";

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
});

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

/** 被撤 op 的原台账行（按 op 号映射），用于汇总 files/paths 与 targetOps 明细 */
function ledgerByOp(configDir, sessionId) {
  const m = new Map();
  for (const o of readOps(configDir, sessionId)) if (typeof o?.op === "number" && !m.has(o.op)) m.set(o.op, o);
  return m;
}

/** 汇总一组 op 的 stores[].files/paths 增量并集（与时间线/徽标同口径：只认 before→after 增量） */
function sumStoresOf(rows) {
  const acc = new Map(); // root → {root, files, paths, partial, before, after}
  for (const row of rows) {
    for (const st of row?.stores || []) {
      const cur = acc.get(st.root) || { root: st.root, files: { M: 0, A: 0, D: 0 }, paths: [], before: st.before || null, after: st.after || null, partial: !!st.partial };
      if (st.before) {
        cur.files.M += st.files?.M || 0; cur.files.A += st.files?.A || 0; cur.files.D += st.files?.D || 0;
        for (const p of st.paths || []) if (!cur.paths.includes(p)) cur.paths.push(p);
      }
      if (st.before && !cur.before) cur.before = st.before;
      if (st.after && !cur.after) cur.after = st.after;
      acc.set(st.root, cur);
    }
  }
  return [...acc.values()];
}

/** 回撤一等化记账行：LedgerRow 同构 + 回撤自身可逆（stores[].before=safety, after=记账 commit）。
 *  不占引擎 op 号（kind:"rollback" 标识 + 时间序展示，避免与引擎运行中 nextOp 撞号）。 */
function appendReverseRollbackLedger(configDir, sessionId, repoRoot, targetOps, r) {
  const byOp = ledgerByOp(configDir, sessionId);
  const rows = targetOps.map((op) => byOp.get(op)).filter(Boolean);
  const stores = sumStoresOf(rows);
  // 回撤动作自身的净效果（before=safety, after=记账 commit）也记进 stores 的 before/after
  const marked = stores.map((s) => ({ ...s, before: r.safety, after: r.rollback }));
  if (marked.length === 0) marked.push({ root: repoRoot, files: { M: 0, A: 0, D: 0 }, paths: [], partial: false, before: r.safety, after: r.rollback });
  const applied = r.applied || 0; const skipped = (r.skipped || []).map((s) => s.op);
  const gapN = (r.skipped || []).length;
  let summary = targetOps.length
    ? `回撤 #${targetOps.join(",")}（从此处编辑）· 撤 ${applied}`
    : `撤销回撤 · 撤 ${applied}`;
  if (gapN) summary += ` · 跳过 ${gapN}（无基线）`;
  if (r.failed) summary += ` · 失败@${r.failed.op}`;
  appendOps(configDir, sessionId, {
    kind: "rollback",
    scope: "reverse-ops",
    tool: "rollback",
    summary,
    t0: Date.now(), t1: Date.now(),
    cwd: repoRoot,
    entryId: null, userEntryId: null, prompt: null,
    stores: marked,
    leaks: [],
    rollback: { targetOps, applied, skipped, failed: r.failed || null, usedThreeway: !!r.usedThreeway },
  });
}

export async function handleApi(req, ctx, env) {
  const { configDir, dir, services } = env;
  const allowRoot = env.allowRoot || (async () => true);
  const p = ctx.path || [];
  if (!configDir) return json({ ok: false, error: "扩展未初始化" }, 500);
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    // ── 台账 ──
    if (p[0] === "ops" && req.method === "GET") {
      const q = ctx.searchParams || new URLSearchParams();
      const sid = sanitizeSession(q.get("session") || "default");
      if (q.get("fixture")) {
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const f = join(dir || "", "test", "fixtures", "ops-" + String(q.get("fixture")).replace(/[^a-z0-9-]/gi, "") + ".jsonl");
        const ops = existsSync(f)
          ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
          : [];
        return json({ ok: true, session: sid, fixture: true, ops });
      }
      let state = null;
      try { state = JSON.parse(readFileSync(join(dirname(configDir), "cache", "state", sanitizeSession(sid) + ".json"), "utf8")); } catch { /* 无状态文件 */ }
      // [P1-3 意图维 join] 进程内消费 services.plans（plan-first 提供方；缺席静默降级）——
      // 时间线头部据此显示 📋 方案绑定（planRel），实现「本会话依据哪份方案」一眼可读。
      let plan: { planRel: string | null; path: string } | null = null;
      try {
        const plans = services?.get?.("aiti-plan-first.plans");
        const hit = plans?.planDocs?.().find((p2: any) => p2.sessionId === sid);
        if (hit) plan = { planRel: hit.planRel ?? null, path: hit.path };
      } catch { /* 服务缺席/状态异常：plan 保持 null，零影响 */ }
      // ETag 再校验（§11.3 扩缩）：台账未变（size+mtime 同）→ 304 零传输。语义只覆盖 ops
      // 本身（state/plan 变化不参与 etag）——消费方仅限 badge/footer（只用 ops）；面板不吃 304。
      const { rows, etag } = readOpsWithMeta(configDir, sid);
      const inm = req.headers?.get?.("if-none-match");
      if (etag && inm && inm === etag) return new Response(null, { status: 304, headers: { etag } });
      return json({ ok: true, session: sid, ops: rows, state, plan }, 200, etag ? { etag } : {});
    }

    if (p[0] === "fork-preview" && req.method === "POST") {
      // 方案 §3.2：按被裁轮集合精确圈定（含被编辑轮）——POST { session, entryIds[] }
      const body = await readBody(req);
      const sid = sanitizeSession(String(body?.session || "default"));
      const entryIds = Array.isArray(body?.entryIds) ? body.entryIds.map(String).filter(Boolean) : [];
      const ops = forkPreviewOpsByUserEntries(configDir, sid, entryIds);
      // R4：回撤弹窗汇总行/文件数由本响应附带（不另发 /files）；聚合失败不阻塞预览
      let files, totals;
      try {
        const summary = await sessionFileSummary(configDir, sid, entryIds, { allowRoot });
        files = summary.files; totals = summary.totals;
      } catch { /* 聚合缺席降级 */ }
      return json({ ok: true, session: sid, entryIds, ops, files, totals });
    }

    if (p[0] === "fork-preview" && req.method === "GET") {
      const q = ctx.searchParams || new URLSearchParams();
      const sid = sanitizeSession(q.get("session") || "default");
      const entryId = q.get("entryId") || "";
      const ops = forkPreviewOps(configDir, sid, entryId);
      // R4：fork 点后 ops 圈定（opSet）出同口径聚合；旧 core 降级路径同样有汇总行
      let files, totals;
      try {
        const opSet = new Set(ops.map((o) => o.op).filter((n) => typeof n === "number"));
        const summary = await sessionFileSummary(configDir, sid, [], { allowRoot, opSet });
        files = summary.files; totals = summary.totals;
      } catch { /* 聚合缺席降级 */ }
      return json({ ok: true, session: sid, entryId, ops, files, totals });
    }

    // ── 变更总览（overview 方案 §3，只读）──
    if (p[0] === "files" && req.method === "GET") {
      const q = ctx.searchParams || new URLSearchParams();
      const sid = sanitizeSession(q.get("session") || "default");
      const entryIds = (q.get("entryIds") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const r = await sessionFileSummary(configDir, sid, entryIds, { allowRoot });
      return json({ ok: true, session: sid, entryIds, ...r });
    }

    if (p[0] === "file-diff" && req.method === "GET") {
      const q = ctx.searchParams || new URLSearchParams();
      const root = String(q.get("root") || "");
      if (!root || !storeOk(root)) return json({ ok: false, error: "该仓没有 trace store（.aiti-trace 不存在）" }, 400);
      if (!(await allowRoot(root))) return json({ ok: false, error: "root 不在允许范围（allowed-roots 拒绝）" }, 403);
      const sid = sanitizeSession(q.get("session") || "default");
      const base = String(q.get("base") || ""), target = String(q.get("target") || "");
      if (!base || !target) return json({ ok: false, error: "缺少 base/target" }, 400);
      const path = String(q.get("path") || "");
      const maxLines = parseInt(q.get("maxLines") || "", 10) || undefined;
      const r = await fileDiffText(root, sid, base, target, path, maxLines); // 坏 ref → throw → 400
      return json({ ok: true, session: sid, root, base, target, path, ...r });
    }

    // ── 回撤（写路径单一收敛点） ──
    if (p[0] === "rollback" && req.method === "POST") {
      const body = await readBody(req);
      const repoRoot = String(body?.storeRoot || "");
      if (!repoRoot || !storeOk(repoRoot)) return json({ ok: false, error: "该仓没有 trace store（.aiti-trace 不存在）" }, 400);
      if (!(await allowRoot(repoRoot))) return json({ ok: false, error: "storeRoot 不在允许范围（allowed-roots 拒绝）" }, 403);
      const targetCommit = String(body?.targetCommit || "");
      if (!targetCommit) return json({ ok: false, error: "缺少 targetCommit" }, 400);
      const sessionId = sanitizeSession(body?.sessionId);
      const r = await rollbackFull({ repoRoot, sessionId, targetCommit });
      appendOps(configDir, sessionId, {
        kind: "rollback", t: Date.now(), storeRoot: repoRoot, target: targetCommit,
        safety: r.safety, commit: r.rollback, scope: "full",
      });
      return json({ ok: true, ...r });
    }

    if (p[0] === "rollback-partial" && req.method === "POST") {
      const body = await readBody(req);
      const repoRoot = String(body?.storeRoot || "");
      if (!repoRoot || !storeOk(repoRoot)) return json({ ok: false, error: "该仓没有 trace store（.aiti-trace 不存在）" }, 400);
      if (!(await allowRoot(repoRoot))) return json({ ok: false, error: "storeRoot 不在允许范围（allowed-roots 拒绝）" }, 403);
      const base = String(body?.base || ""), target = String(body?.target || "");
      const files = Array.isArray(body?.files) ? body.files.map(String).filter(Boolean) : [];
      const hunkIdx = Array.isArray(body?.hunkIdx) ? body.hunkIdx.map((n) => Number(n) | 0).filter((n) => n >= 0) : [];
      if (!base || !target) return json({ ok: false, error: "缺少 base/target" }, 400);
      // [P0-1] 空 hunkIdx = 该文件全部 hunk（合法）；只有 files 缺失才 400
      if (!files.length) return json({ ok: false, error: "缺少 files" }, 400);
      const sessionId = sanitizeSession(body?.sessionId);
      const r = await rollbackPartial({ repoRoot, sessionId, base, target, files, hunkIdx });
      appendOps(configDir, sessionId, {
        kind: "rollback", t: Date.now(), storeRoot: repoRoot, base, target,
        files, hunkIdx, safety: r.safety, commit: r.rollback, usedThreeway: r.usedThreeway, scope: "partial",
      });
      return json({ ok: true, ...r });
    }

    if (p[0] === "plan-record" && req.method === "POST") {
      // [P1-1] plan 采认/丢弃记账（GAP-3/5 记账合一）：op-less 台账行，kind=plan-accept/plan-discard。
      // 写入方：aiti-plan-review applyOne（web 采认路径）。时间线/摘要按 kind 可查可过滤。
      const body = await readBody(req);
      const sessionId = sanitizeSession(body?.sessionId);
      const outcome = body?.outcome === "accepted" ? "plan-accept" : "plan-discard";
      appendOps(configDir, sessionId, {
        kind: outcome, t: Date.now(),
        sandbox: String(body?.sandbox || ""),
        mission: String(body?.mission || ""),
        files: Array.isArray(body?.files) ? body.files.map(String).filter(Boolean) : [],
        summary: String(body?.summary || "").slice(0, 500),
      });
      return json({ ok: true });
    }

    if (p[0] === "rollback-reversed" && req.method === "POST") {
      // 方案 §3.2/§7：逐 op 逆序反向回撤 + 回撤自身一等化记账（LedgerRow 同构、可逆）
      const body = await readBody(req);
      const repoRoot = String(body?.storeRoot || "");
      if (!repoRoot || !storeOk(repoRoot)) return json({ ok: false, error: "该仓没有 trace store（.aiti-trace 不存在）" }, 400);
      if (!(await allowRoot(repoRoot))) return json({ ok: false, error: "storeRoot 不在允许范围（allowed-roots 拒绝）" }, 403);
      const sessionId = sanitizeSession(body?.sessionId);
      const refs = Array.isArray(body?.refs) ? body.refs
        .map((rf) => ({ op: Number(rf?.op) | 0, before: rf?.before ? String(rf.before) : null, after: rf?.after ? String(rf.after) : null }))
        .filter((rf) => rf.before || rf.after) : []; // op 可为任意整数（撤销回撤用 -1 表示「非 op 的逆操作」），必须有 before/after
      if (!refs.length) return json({ ok: false, error: "缺少 refs" }, 400);
      const targetOps = refs.filter((rf) => rf.op > 0).map((rf) => rf.op);
      const r = await rollbackOpsReversed({ repoRoot, sessionId, refs });
      // 一等化记账行：LedgerRow 同构（时间线「↩ 回撤记录」区块可读、可「撤销回撤」）
      appendReverseRollbackLedger(configDir, sessionId, repoRoot, targetOps, r);
      return json({ ok: true, ...r });
    }

    // ── 家谱（§3.3）：parent 链聚合（祖先 + 当前 + 后代）──
    if (p[0] === "lineage" && req.method === "GET") {
      const q = ctx.searchParams || new URLSearchParams();
      const sid = sanitizeSession(q.get("session") || "");
      if (!sid) return json({ ok: false, error: "缺少 session" }, 400);
      const lin: any = lineage(configDir, sid);
      // [P1-3] 节点 📋 方案绑定标注（services.plans 反查；缺席静默降级为无标注）
      try {
        const plans = services?.get?.("aiti-plan-first.plans");
        const bySid = new Map<string, string>((plans?.planDocs?.() ?? []).map((p2: any) => [p2.sessionId, p2.planRel || p2.path]));
        for (const n of [lin.self, ...(lin.ancestors ?? []), ...(lin.descendants ?? [])]) {
          if (n?.id) n.planRel = bySid.get(n.id) ?? null;
        }
      } catch { /* 服务缺席：节点无标注 */ }
      return json({ ok: true, session: sid, ...lin });
    }
    // ── 清理（§15）：会话台账 / 工作区深清理 ──
    if (p[0] === "cleanup" && req.method === "POST") {
      const body = await readBody(req);
      if (body?.scope === "session") {
        const sid = sanitizeSession(String(body.session || ""));
        if (!sid) return json({ ok: false, error: "缺少 session" }, 400);
        const beforeOp = body.beforeOp ? parseInt(body.beforeOp, 10) : undefined;
        const r = cleanupSessionOps(configDir, sid, beforeOp);
        return json({ ok: true, ...r });
      }
      if (body?.scope === "workspace") {
        const root = String(body.root || "");
        if (!root) return json({ ok: false, error: "缺少 root" }, 400);
        if (!(await allowRoot(root))) return json({ ok: false, error: "root 不在允许范围（allowed-roots 拒绝）" }, 403);
        const r = cleanupWorkspace(configDir, root);
        return json({ ok: true, ...r });
      }
      return json({ ok: false, error: "scope 需为 session | workspace" }, 400);
    }
    // ── workspace 关注路径 ──
    if (p[0] === "workspace" && p[1] === "resolve" && req.method === "POST") {
      const body = await readBody(req);
      const cwd = String(body?.cwd || "");
      if (!cwd) return json({ ok: false, error: "缺少 cwd" }, 400);
      const repoRoot = repoRootOf(cwd);
      const key = workspaceKey(repoRoot || cwd); // key 锚定主仓根（与 pi 引擎 workspaceConfigFile 一致）
      // §13.4：无 git 时给出 loose 决策（autoInit 开 + 不在 denylist + 预算内 → 会自动建简易追踪）
      // 会话识别仓（§7.2 session 级）：pi 扩展落盘的 state/<sid>.json；
      // 台账补全（sessionRepoRoots）：state 只是运行时快照，引擎重启会丢之前的副仓，
      // 台账才是持久记录——合并后供 watch 弹窗展示与跨仓文件分辨（aiti-msg-smart）使用。
      let sessionStores = null;
      const reqSid = String(body?.session || "");
      if (reqSid) {
        try {
          const st = JSON.parse(readFileSync(join(dirname(configDir), "cache", "state", sanitizeSession(reqSid) + ".json"), "utf8"));
          if (Array.isArray(st.stores)) sessionStores = st.stores;
        } catch { /* 无状态文件 */ }
        const opsRoots = sessionRepoRoots(configDir, reqSid);
        if (opsRoots.length) {
          const have = new Set((sessionStores || []).map((s) => (s && s.root) || ""));
          for (const r of opsRoots) {
            if (have.has(r)) continue;
            sessionStores = [...(sessionStores || []), { root: r, role: "secondary" }];
          }
        }
      }
      let loose = null;
      if (!repoRoot && cwd) {
        let cfg2 = {};
        try { cfg2 = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")); } catch { /* 缺省开 */ }
        loose = looseDecision(cwd, { autoInit: cfg2.autoInit !== false, maxFiles: cfg2.autoInitMaxFiles });
      }
      return json({ ok: true, key, repoRoot, nogit: !repoRoot, loose, sessionStores, config: loadWorkspace(configDir, key) });
    }
    if (p[0] === "workspace" && req.method === "GET" && !p[1]) {
      const q = ctx.searchParams || new URLSearchParams();
      const key = String(q.get("key") || "");
      if (!key) return json({ ok: false, error: "缺少 key" }, 400);
      return json({ ok: true, key, config: loadWorkspace(configDir, key) });
    }
    if (p[0] === "workspace" && req.method === "POST" && !p[1]) {
      const body = await readBody(req);
      const key = String(body?.key || "");
      if (!key) return json({ ok: false, error: "缺少 key" }, 400);
      const config = saveWorkspace(configDir, key, body);
      return json({ ok: true, key, config });
    }
    if (p[0] === "workspace" && req.method === "DELETE" && !p[1]) {
      const q = ctx.searchParams || new URLSearchParams();
      const key = String(q.get("key") || "");
      if (!key) return json({ ok: false, error: "缺少 key" }, 400);
      deleteWorkspace(configDir, key);
      return json({ ok: true, key, deleted: true });
    }

    if (p[0] === "watch" && p[1] === "resolve" && req.method === "POST") {
      const body = await readBody(req);
      const path = String(body?.path || "");
      if (!path) return json({ ok: false, error: "缺少 path" }, 400);
      const r = resolveWatchPath(path);
      return json({ ok: true, ...r, isGit: !!r.repoRoot });
    }

    // ── @到新会话 CWD 判定 v2（docs/pi-web-at-new-session-cwd-plan.md + …-v2-plan.md）：
    //    ① 目标在当前 CWD 内 → 保持；② 目标在当前 CWD 关注路径（watchPaths，repoRoot ?? path）内
    //    → 切到该关注路径；③ 目标在已有 workspace（client 传入 /api/sessions 派生候选）内 → 最长覆盖；
    //    ④ 否则用自己的目录（剥离 docs/tmp/design 等常规目录名）。消费方：aiti-editor / aiti-folder /
    //    aiti-doc-center 的「@到新会话」统一走本端点复核（watchPaths = 判定数据源，能力归口）。 ──
    if (p[0] === "new-session-cwd" && req.method === "POST") {
      const body = await readBody(req);
      const targetDir = String(body?.targetDir || "");
      const targetPath = String(body?.targetPath || "");
      const cwd = String(body?.cwd || "");
      const knownWorkspaces = Array.isArray(body?.knownWorkspaces)
        ? body.knownWorkspaces.filter((x: unknown) => typeof x === "string" && x)
        : [];
      if (!targetDir && !targetPath) return json({ ok: false, error: "缺少 targetDir" }, 400);
      // 与 services.trace.watchPaths 同源（traceService 用 configDir 同参）；git 仓根锚定 workspace key；
      // 传完整对象（含 repoRoot）——v2 关注目录命中取 repoRoot ?? path（仓库根优先）。
      const watchPaths = cwd
        ? loadWorkspace(configDir, workspaceKey(repoRootOf(cwd) || cwd)).paths
        : [];
      const r = resolveNewSessionCwd({ targetDir, targetPath, currentCwd: cwd, watchPaths, knownWorkspaces });
      return json({ ok: true, cwd: r.cwd, switched: r.switched });
    }

    // ── 事件出口（docs/aiti-plan-first-plan.md §3.2）：op 事件实时推浏览器（SSE，aiti-ai-schedule 同款；
  //    EventSource 断线自愈非轮询）。消费方：git-trace 自家 UI 实时化 / 任意页面可直听 ──
  if (p[0] === "events" && req.method === "GET") {
    const onTraceOp = (env as any).onTraceOp;
    if (typeof onTraceOp !== "function") return json({ ok: false, error: "事件总线未就绪" }, 503);
    const encoder = new TextEncoder();
    let off: (() => void) | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    // 退订必须双钩：cancel 只在流被消费方取消时触发，客户端静默断开（页面刷新/网络断）
    // 可能不走 cancel——漏退订会把 op 监听器 + 15s ping 永久留在 traceBus 上
    // （MaxListenersExceeded + 闭包钉死模块图，2026-09-15 dev 实例内存膨胀实证）。
    const cleanup = () => {
      try { off?.(); } catch {}
      if (ping) clearInterval(ping);
      off = null; ping = null;
    };
    const stream = new ReadableStream({
      start(controller) {
        const send = (chunk: string) => {
          try { controller.enqueue(encoder.encode(chunk)); } catch { /* 客户端已断开 */ }
        };
        send(": connected\n\n");
        off = onTraceOp((evt: unknown) => send(`event: op\ndata: ${JSON.stringify(evt)}\n\n`));
        ping = setInterval(() => send(": ping\n\n"), 15000); // 传输保活（防代理空闲断连；非状态轮询）
        req.signal?.addEventListener("abort", cleanup, { once: true }); // 第二退订钩（aiti-event-bus 同款）
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
    });
  }

  if (p[0] === "excludes" && req.method === "GET") {
      const f = ensureExcludesFile(configDir);
      const { readFileSync } = await import("node:fs");
      return json({ ok: true, text: readFileSync(f, "utf8") });
    }

    return json({ ok: false, error: "not found" }, 404);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 400);
  }
}
