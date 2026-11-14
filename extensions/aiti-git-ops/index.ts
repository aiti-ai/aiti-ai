/**
 * aiti-git-ops · Git 操作共享引擎扩展（方案 docs/aiti-git-ops-shared-plan.md M1）
 *
 * 零 UI、零 npm 运行时依赖的纯服务端引擎：
 *  - REST：POST /api/extensions/aiti-git-ops/git/*（§1.2 全表，cwd 走 JSON body 不落 URL）
 *  - services：ctx.services.provide("aiti-git-ops.api", {...}) 与 REST 同面（§1.6）
 *  - 事件：aiti-git-ops:changed:<hash(repoRoot)> 经 aiti-event-bus publish-local 发布
 *    （alive 保活门控——订阅方 POST /alive {types} 刷新，45s 无保活停推，§1.5 契约）
 *
 * 消费方：aiti-folder（提交面板/SyncBar）、session-manager（分支 chip 面板，M2）。
 * 引擎缺席时消费方各自降级（optionalDependsOn 软依赖），本扩展不感知。
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import * as engine from "./git-engine.ts";

export default {
  id: "aiti-git-ops",
  name: "Git Ops（共享 Git 操作引擎）",
  icon: "icons/git-branch.svg",
  // 零 client bundle（同 aiti-echo-agent 等 10 个纯服务端扩展先例）
  provides: ["aiti-git-ops.api"],

  server: {
    startup: async (ctx: any) => {
      servicesCtx = ctx?.services ?? null;
      // 数据分层（AGENTS §data-layering）：审计→state（不可再生）；隔离区→cache（可整体 rm -rf）
      const configDir = (ctx?.configDir as string) || "";
      const stateDir = (ctx?.stateDir as string) || (configDir ? join(configDir, "state") : "");
      const cacheDir = (ctx?.cacheDir as string) || (configDir ? join(configDir, "cache") : "");
      if (stateDir) await mkdir(join(stateDir, "aiti-git-ops"), { recursive: true }).catch(() => {});
      if (cacheDir) await mkdir(join(cacheDir, "aiti-git-ops", "discarded"), { recursive: true }).catch(() => {});

      engine.initGitEngine({
        stateDir,
        cacheDir,
        source: "aiti-git-ops",
        onChanged: (repo, kind, summary) => publish(engine.repoTopic(repo), { kind, summary, repo }),
      });

      // services 出口（§1.6）：与 REST 同面，供服务端消费方与测试进程内直调
      try {
        ctx.services?.provide?.("aiti-git-ops.api", {
          refs: (cwd: string) => engine.gitRefs(cwd),
          log: (cwd: string, cursor: number) => engine.gitLog(cwd, cursor),
          checkout: (cwd: string, ref: string, mode?: string) => engine.gitCheckout(cwd, ref, mode),
          branchCreate: (cwd: string, name: string, from?: string, checkout?: boolean) => engine.gitBranchCreate(cwd, name, from, checkout),
          branchDelete: (cwd: string, name: string) => engine.gitBranchDelete(cwd, name),
          tags: (cwd: string) => engine.gitTags(cwd),
          tagCreate: (cwd: string, name: string, ref?: string, opts?: { annotate?: boolean; message?: string }) => engine.gitTagCreate(cwd, name, ref, opts),
          commitShow: (cwd: string, sha: string) => engine.gitCommitShow(cwd, sha),
          commitDiff: (cwd: string, sha: string, paths: string[]) => engine.gitCommitDiff(cwd, sha, paths),
          cherryPick: (cwd: string, sha: string, opts?: { abort?: boolean }) => engine.gitCherryPick(cwd, sha, opts),
          stage: (cwd: string, paths: string[]) => engine.gitStage(cwd, paths),
          unstage: (cwd: string, paths: string[]) => engine.gitUnstage(cwd, paths),
          discard: (cwd: string, paths: string[]) => engine.gitDiscard(cwd, paths),
          ignoreAdd: (cwd: string, paths: string[]) => engine.gitIgnoreAdd(cwd, paths),
          commit: (cwd: string, message?: string, amend?: boolean) => engine.gitCommit(cwd, message, amend),
          planExecute: (cwd: string, groups: engine.PlanGroup[]) => engine.gitPlanExecute(cwd, groups),
          planRollback: (cwd: string, baseHEAD: string) => engine.gitPlanRollback(cwd, baseHEAD),
          stashList: (cwd: string) => engine.stashList(cwd),
          stashFiles: (cwd: string, index: number) => engine.stashFiles(cwd, index),
          stashPush: (cwd: string, opts: { message?: string; includeUntracked?: boolean; paths?: string[] }) => engine.stashPush(cwd, opts),
          stashApply: (cwd: string, index: number, opts: { pop?: boolean; paths?: string[] }) => engine.stashApply(cwd, index, opts),
          stashDrop: (cwd: string, index: number) => engine.stashDrop(cwd, index),
          stashBranch: (cwd: string, index: number, name: string) => engine.stashBranch(cwd, index, name),
          push: (cwd: string, opts: { remote?: string; branch?: string; setUpstream?: boolean }) => engine.gitPush(cwd, opts),
          pull: (cwd: string, opts: { mode?: "ff-only" | "rebase" | "merge" }) => engine.gitPull(cwd, opts),
          fetch: (cwd: string, remote?: string) => engine.gitFetch(cwd, remote),
        });
      } catch { /* services 不可用时 REST 仍可用 */ }
    },

    shutdown: async () => {},

    api: async (req: Request, ctx: any) => {
      const p: string[] = ctx?.path || [];
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      if (req.method !== "POST") return json({ ok: false, error: "仅支持 POST" }, 405);

      // alive 保活（§1.5）：订阅方周期刷新关注的 topic，发布侧超时停推
      if (p[0] === "alive") {
        const body = await readBody(req);
        for (const t of Array.isArray(body?.types) ? body.types : []) {
          if (typeof t === "string" && t.startsWith("aiti-git-ops:changed:")) aliveMap.set(t, Date.now());
        }
        return json({ ok: true });
      }

      if (p[0] !== "git") return json({ ok: false, error: "not found: " + p.join("/") }, 404);
      const body = await readBody(req);
      const cwd = body?.cwd;
      try {
        switch (p[1]) {
          case "refs": return json({ ok: true, ...(await engine.gitRefs(cwd)) });
          case "log": return json({ ok: true, ...(await engine.gitLog(cwd, body?.cursor ?? 0)) });
          case "checkout": return json(await engine.gitCheckout(cwd, body?.ref, body?.mode));
          case "branch-create": return json(await engine.gitBranchCreate(cwd, body?.name, body?.from, body?.checkout !== false));
          case "branch-delete": return json(await engine.gitBranchDelete(cwd, body?.name));
          case "tags": return json({ ok: true, ...(await engine.gitTags(cwd)) });
          case "tag-create": return json(await engine.gitTagCreate(cwd, body?.name, body?.ref, body));
          case "commit-show": return json({ ok: true, ...(await engine.gitCommitShow(cwd, body?.sha)) });
          case "commit-diff": return json({ ok: true, ...(await engine.gitCommitDiff(cwd, body?.sha, body?.paths)) });
          case "cherry-pick": return json(await engine.gitCherryPick(cwd, body?.sha, body || {}));
          case "stage": return json(await engine.gitStage(cwd, body?.paths));
          case "unstage": return json(await engine.gitUnstage(cwd, body?.paths));
          case "discard": return json(await engine.gitDiscard(cwd, body?.paths));
          case "ignore-add": return json(await engine.gitIgnoreAdd(cwd, body?.paths));
          case "commit": return json(await engine.gitCommit(cwd, body?.message, !!body?.amend));
          case "plan":
            if (p[2] === "execute") return json(await engine.gitPlanExecute(cwd, body?.groups));
            if (p[2] === "rollback") return json(await engine.gitPlanRollback(cwd, body?.baseHEAD));
            break;
          case "stash":
            if (p[2] === "list") return json({ ok: true, ...(await engine.stashList(cwd)) });
            if (p[2] === "files") return json({ ok: true, ...(await engine.stashFiles(cwd, body?.index)) });
            if (p[2] === "push") return json(await engine.stashPush(cwd, body || {}));
            if (p[2] === "apply") return json(await engine.stashApply(cwd, body?.index, body || {}));
            if (p[2] === "drop") return json(await engine.stashDrop(cwd, body?.index));
            if (p[2] === "branch") return json(await engine.stashBranch(cwd, body?.index, body?.name));
            break;
          case "push": return json(await engine.gitPush(cwd, body || {}));
          case "pull": return json(await engine.gitPull(cwd, body || {}));
          case "fetch": return json(await engine.gitFetch(cwd, body?.remote));
        }
        return json({ ok: false, error: "not found: git/" + p.slice(1).join("/") }, 404);
      } catch (e) {
        const err = e as engine.GitOpsFail;
        return json(
          { ok: false, error: err?.message || String(e), ...(err?.conflict ? { conflict: true, files: err.files } : {}) },
          err?.status && Number.isInteger(err.status) ? err.status : 500,
        );
      }
    },
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

const readBody = async (req: Request): Promise<any> => {
  try { return await req.json(); } catch { return {}; }
};

// ── 事件发布（aiti-event-bus publish-local + aliveMap 保活停推，aiti-cmd 范式） ──

const ALIVE_TIMEOUT_MS = 45_000;
const aliveMap = new Map<string, number>();
let servicesCtx: { get?: (n: string) => { publish?: (t: string, d?: Record<string, unknown>) => void } | undefined } | null = null;

function publish(type: string, data: Record<string, unknown>) {
  try {
    const last = aliveMap.get(type);
    if (last !== undefined && Date.now() - last > ALIVE_TIMEOUT_MS) return; // 订阅停止：停推
    const svc = servicesCtx?.get?.("aiti-event-bus.publish-local") ?? servicesCtx?.get?.("aiti-event-bus.publish");
    svc?.publish?.(type, data);
  } catch { /* 事件失败不阻断 */ }
}
