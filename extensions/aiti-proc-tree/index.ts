/**
 * aiti-proc-tree · child-process tree manager for pi-web.
 *
 * Lists the processes the pi-web ecosystem spawns (terminals, tunnels,
 * subagents, external agents, host descendants) as a tree with CPU/memory,
 * and stops a single process or a whole subtree. Sampling happens only while
 * the panel is open: the server holds no timers, the client poll is the only
 * driver (same discipline as aiti-sysmon).
 *
 * Data sources (all read-only):
 *   - Linux /proc (two-phase: stat graph + details for the visible set only)
 *   - aiti-cmd-host registry, agent-starter registry, bridge-registry
 *   - service-tunnels registered-pids files, pi-subagents async status files
 *   - Phase 2: ctx.services from aiti-cmd / service-tunnels / aiti-subagents /
 *     aiti-acp-agent (precise session metadata; registries remain the fallback)
 *
 * Unrelated processes are never collected or returned (default view).
 */
import { resolveSelf } from "./server/discovery/instances.ts";
import { readRegistries } from "./server/discovery/registries.ts";
import { executeKill } from "./server/kill.ts";
import * as sampler from "./server/sampler/index.ts";
import * as linuxSampler from "./server/sampler/linux.ts";

const core = require("./core.cjs");

const ID = "aiti-proc-tree";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function truncate(s: unknown, max: number): string {
  const v = String(s == null ? "" : s);
  return v.length > max ? v.slice(0, max) + "…" : v;
}

/** Service rows exposed by Phase 2 providers (all optional). */
function serviceRows(ctx: any): any[] {
  const keys: Array<[string, string]> = [
    ["aiti-cmd.procs", "aiti-cmd"],
    ["service-tunnels.procs", "service-tunnels"],
    ["aiti-subagents.procs", "aiti-subagents"],
    ["aiti-acp-agent.procs", "aiti-acp-agent"],
  ];
  const rows: any[] = [];
  for (const [key, owner] of keys) {
    try {
      const svc = ctx?.services?.get?.(key);
      if (!svc || typeof svc.list !== "function") continue;
      const list = svc.list();
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        rows.push({ ...row, owner: row.owner || owner });
      }
    } catch {
      /* a broken provider must not break the panel */
    }
  }
  return rows;
}

async function buildSnapshot(ctx: any) {
  const instance = resolveSelf();
  const registries = readRegistries();
  const rows = core.normalizeRegistryRows({
    cmdHost: registries.cmdHost,
    agentStarter: registries.agentStarter,
    bridge: registries.bridge,
    tunnels: registries.tunnels,
    subagents: registries.subagents,
    services: serviceRows(ctx),
  });
  const sampled = await sampler.sample({
    selfPid: instance.selfPid,
    cliPid: instance.cliPid,
    rows,
  });
  const tree = core.buildTree({
    raw: sampled.raw,
    details: sampled.details,
    rows,
    selfPid: instance.selfPid,
    cliPid: instance.cliPid,
    mode: instance.mode,
  });
  return { instance, rows, sampled, tree };
}

/** Whitelisted env keys for the detail drawer (full environ never leaves the server). */
const ENV_EXACT = new Set(["PATH", "HOME", "SHELL", "TERM", "USER", "LOGNAME", "PI_CODING_AGENT_DIR"]);
const ENV_PREFIX = ["AITI_PROC_TREE_", "PI_SUBAGENT_", "SERVICE_TUNNELS_"];

function envWhitelist(text: string | undefined): Record<string, string> {
  const all = core.parseEnviron(text || "");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (ENV_EXACT.has(k) || ENV_PREFIX.some((p) => k.startsWith(p))) {
      out[k] = truncate(v, 400);
    }
  }
  return out;
}

export default {
  id: ID,
  name: "子进程管理",
  icon: "icon.svg",
  client: "dist/aiti-proc-tree-client.mjs",
  // The dock face talks to the aiti-float state machine.
  clientDependsOn: ["aiti-float"],

  ai: {
    manage: true,
    intro: "AI 能帮我查看 pi-web 生态的子进程树（终端/隧道/子代理/外部 Agent/宿主后代），显示 PID、CPU、内存、运行时长与命令行，并可结束单个进程或整棵子树（aiti-proc-tree）",
  },

  ui: {
    // Eager bundle: the dock restore-default-presence needs the client at page start.
    clientImmediately: true,
    sidebarExplorerDock: [{ id: "panel", label: "i18n:pt.panel.label", icon: "icons/process-tree.svg" }],
    toolbar: [{ id: "aiti-proc-tree-open", label: "i18n:pt.toolbar.label", title: "i18n:pt.toolbar.title", icon: "icons/process-tree.svg" }],
    i18n: {
      "zh-CN": {
        "pt.panel.label": "子进程",
        "pt.toolbar.label": "子进程",
        "pt.toolbar.title": "打开子进程管理",
        "子进程管理": "子进程管理",
        "进程": "进程",
        "名称": "名称",
        "内存": "内存",
        "时长": "时长",
        "刷新": "刷新",
        "暂停": "暂停",
        "恢复": "恢复",
        "刷新间隔": "刷新间隔",
        "搜索 PID / 命令 / 名称": "搜索 PID / 命令 / 名称",
        "显示未归属（只读）": "显示未归属（只读）",
        "显示其它实例": "显示其它实例",
        "结束进程": "结束进程",
        "结束子树": "结束子树",
        "查看详情": "查看详情",
        "打开终端": "打开终端",
        "打开会话": "打开会话",
        "打开对应会话": "打开该进程对应的外部 Agent 会话",
        "TERM→KILL": "TERM→KILL",
        "打开服务面板": "打开服务面板",
        "复制 PID": "复制 PID",
        "复制命令": "复制命令",
        "加载中": "加载中",
        "空": "当前没有可见的子进程",
        "错误": "采样失败",
        "已暂停": "已暂停",
        "首轮采样中，CPU 将在下一轮显示": "首轮采样中，CPU 将在下一轮显示",
        "已结束": "已结束",
        "部分失败": "部分失败",
        "详情": "详情",
        "环境变量": "环境变量",
        "白名单": "白名单",
        "按名称排序": "按名称排序",
        "点击排序": "点击排序",
        "点击排序（再次点击切换升/降序）": "点击排序（再次点击切换升/降序）",
        "父进程": "父进程",
        "子进程": "子进程",
        "命令行": "命令行",
        "工作目录": "工作目录",
        "状态": "状态",
        "用户": "用户",
        "来源": "来源",
        "套接字 / Unit": "套接字 / Unit",
        "关闭": "关闭",
        "不可结束": "不可结束",
        "宿主进程默认禁止结束": "宿主进程默认禁止结束",
        "将结束 {n} 个进程（含 {m} 个子进程）": "将结束 {n} 个进程（含 {m} 个子进程）",
        "确认结束": "确认结束",
        "取消": "取消",
        "合计": "合计",
        "个进程": "个进程",
        "已截断": "已截断（按 CPU 前 {n}）",
      },
      en: {
        "pt.panel.label": "Processes",
        "pt.toolbar.label": "Processes",
        "pt.toolbar.title": "Open the process tree",
        "子进程管理": "Process Tree",
        "进程": "Processes",
        "名称": "Name",
        "内存": "Memory",
        "时长": "Age",
        "刷新": "Refresh",
        "暂停": "Pause",
        "恢复": "Resume",
        "刷新间隔": "Interval",
        "搜索 PID / 命令 / 名称": "Search PID / command / name",
        "显示未归属（只读）": "Show unowned (read-only)",
        "显示其它实例": "Show other instances",
        "结束进程": "End process",
        "结束子树": "End subtree",
        "查看详情": "Details",
        "打开终端": "Open terminal",
        "打开会话": "Open session",
        "打开对应会话": "Open the agent session behind this process",
        "TERM→KILL": "TERM→KILL",
        "打开服务面板": "Open services panel",
        "复制 PID": "Copy PID",
        "复制命令": "Copy command",
        "加载中": "Loading",
        "空": "No visible child processes",
        "错误": "Sampling failed",
        "已暂停": "Paused",
        "首轮采样中，CPU 将在下一轮显示": "First sample in progress — CPU appears on the next tick",
        "已结束": "Ended",
        "部分失败": "Partially failed",
        "详情": "Details",
        "环境变量": "Environment",
        "白名单": "whitelist",
        "按名称排序": "Sort by name",
        "点击排序": "Click to sort",
        "点击排序（再次点击切换升/降序）": "Click to sort (click again to flip)",
        "父进程": "Parent",
        "子进程": "Children",
        "命令行": "Command line",
        "工作目录": "Working directory",
        "状态": "State",
        "用户": "User",
        "来源": "Source",
        "套接字 / Unit": "Socket / Unit",
        "关闭": "Close",
        "不可结束": "Not killable",
        "宿主进程默认禁止结束": "Host process is protected by default",
        "将结束 {n} 个进程（含 {m} 个子进程）": "End {n} process(es) ({m} children included)?",
        "确认结束": "End",
        "取消": "Cancel",
        "合计": "Total",
        "个进程": "processes",
        "宿主": "Host",
        "终端": "Terminals",
        "外部 Agent": "External agents",
        "子代理": "Subagents",
        "隧道": "Tunnels",
        "其它": "Other",
        "已截断": "Truncated (top {n} by CPU)",
      },
    },
  },

  features: [
    {
      id: "interval",
      type: "string",
      label: "刷新间隔（秒）",
      group: "采样",
      description: "面板展开时的采样间隔秒数（默认 2；1~30）。面板折叠或页面隐藏时不采样，服务端零常驻开销。",
      value: "2",
      placeholder: "2",
    },
    {
      id: "limit",
      type: "string",
      label: "单次返回上限（条）",
      group: "采样",
      description: "按 CPU 排序截断的节点数上限（默认 200；0 = 不截断）。只影响面板显示体积，不影响 kill 的完整子树计算。",
      value: "200",
      placeholder: "200",
    },
    {
      id: "showUnknown",
      type: "boolean",
      label: "显示未归属进程（只读）",
      group: "范围",
      description: "调试用：列出未归属进程的 stat 级信息（PID/PPID/状态），不读命令行/环境变量，永远不可结束。默认关。",
      default: false,
    },
    {
      id: "showOtherInstances",
      type: "boolean",
      label: "显示其它 pi-web 实例",
      group: "范围",
      description: "调试用：显示其它 pi-web 实例的宿主树（只读）。默认关，避免把生产/沙箱实例混在一起。",
      default: false,
    },
  ],

  server: {
    startup(ctx: any) {
      const instance = resolveSelf();
      console.log(
        "[aiti-proc-tree] ready · platform=" + sampler.platform +
        " · self=" + instance.selfPid +
        " · cli=" + instance.cliPid +
        " · mode=" + instance.mode,
      );
      // Warm the service map so the first poll can consume providers that are
      // already up (order-independent; missing providers are fine).
      try { void serviceRows(ctx); } catch { /* ignore */ }
    },

    async shutdown() {
      sampler.reset();
    },

    async api(req: Request, ctx: any) {
      const method = ctx.method;
      const path: string[] = Array.isArray(ctx.path) ? ctx.path : [];
      const action = path[0] || "";

      if (action === "tree" && method === "GET") {
        const params = ctx.searchParams || new URLSearchParams();
        const withCmd = params.get("withCmd") === "1";
        const includeUnknown = params.get("includeUnknown") === "1";
        const includeOther = params.get("includeOtherInstances") === "1";
        const limitRaw = params.get("limit");
        const limit = limitRaw == null ? 200 : Math.max(0, Math.min(2000, Number(limitRaw) || 0));

        try {
          const snap = await buildSnapshot(ctx);
          let nodes = snap.tree.nodes;
          if (!includeUnknown) nodes = nodes.filter((n: any) => n.kind !== "unknown");
          if (!includeOther) nodes = nodes.filter((n: any) => n.instance !== "other");

          // Sort: CPU desc (null last), then pid asc. Client builds the tree from
          // parentPid, so list order is purely for truncation/totals.
          nodes = nodes.slice().sort((a: any, b: any) => {
            const ca = a.cpu == null ? -1 : a.cpu;
            const cb = b.cpu == null ? -1 : b.cpu;
            if (cb !== ca) return cb - ca;
            return a.pid - b.pid;
          });
          const truncated = limit > 0 && nodes.length > limit;
          if (truncated) nodes = nodes.slice(0, limit);

          const out = nodes.map((n: any) => {
            const base: any = {
              pid: n.pid,
              ppid: n.ppid,
              parentPid: n.parentPid,
              kind: n.kind,
              owner: n.owner,
              label: truncate(n.label, 120),
              sessionId: n.sessionId || undefined,
              cwd: n.cwd,
              user: n.user,
              state: n.state,
              cpu: n.cpu,
              mem: n.mem,
              etimeMs: n.etimeMs,
              canKill: n.canKill,
              protectedReason: n.protectedReason,
              instance: n.instance,
              source: n.source,
              transport: n.transport,
              url: n.url,
              socket: n.socket,
              attached: n.attached,
              hasChildren: n.hasChildren,
            };
            if (withCmd) base.cmd = truncate(n.cmd, 200);
            return base;
          });

          return json({
            ts: Date.now(),
            instance: snap.instance,
            sampling: {
              firstTick: snap.sampled.firstTick,
              scanned: snap.sampled.scanned,
              visible: snap.sampled.visible,
              approxCpu: snap.sampled.approxCpu,
              truncated,
              limit,
            },
            stats: snap.tree.stats,
            nodes: out,
          });
        } catch (e: any) {
          return json({ error: String(e?.message || e) }, 500);
        }
      }

      if (action === "kill" && method === "POST") {
        let body: any = null;
        try {
          body = await req.json();
        } catch {
          return json({ error: "invalid json" }, 400);
        }
        if (!body || body.confirm !== true) return json({ error: "confirm required" }, 400);
        const pids = Array.isArray(body.pids) ? body.pids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0) : [];
        if (!pids.length) return json({ error: "pids required" }, 400);
        if (pids.length > 64) return json({ error: "too many pids (max 64)" }, 400);
        const mode = body.mode === "subtree" ? "subtree" : "single";
        const allowHost = body.allowHost === true;

        try {
          const snap = await buildSnapshot(ctx);
          const owned = new Set<number>(snap.tree.nodes.map((n: any) => n.pid));
          const uid = typeof process.getuid === "function" ? process.getuid() : null;
          const plan = core.killPlan({
            raw: snap.sampled.raw,
            targets: pids,
            mode,
            uid,
            selfPid: snap.instance.selfPid,
            cliPid: snap.instance.cliPid,
            allowHost,
            owned,
            uidOf: (pid: number) => (process.platform === "linux" ? sampler.uidOf(pid) : null),
          });
          const result = await executeKill({
            allowed: plan.allowed,
            denied: plan.denied,
            mode: plan.mode,
            stateDir: ctx.stateDir,
            allowHost,
            selfPid: snap.instance.selfPid,
          });
          return json({
            ok: result.results.every((r: any) => r.ok),
            mode: plan.mode,
            results: result.results,
            denied: result.denied,
          });
        } catch (e: any) {
          return json({ error: String(e?.message || e) }, 500);
        }
      }

      if (action === "node" && path[1] && method === "GET") {
        const pid = Number(path[1]);
        if (!Number.isFinite(pid) || pid <= 0) return json({ error: "bad pid" }, 400);
        try {
          const snap = await buildSnapshot(ctx);
          const node = snap.tree.nodes.find((n: any) => n.pid === pid);
          if (!node) return json({ error: "not a managed process" }, 404);

          let detail: any = snap.sampled.details.get(pid) || {};
          if (process.platform === "linux") {
            try {
              const fresh = linuxSampler.readDetail(pid, { withEnv: true });
              detail = { ...detail, ...fresh, envText: fresh.envText };
            } catch { /* keep sampled detail */ }
          }
          const children = snap.tree.nodes
            .filter((n: any) => n.parentPid === pid)
            .map((n: any) => ({ pid: n.pid, label: n.label, kind: n.kind }));
          const parent = node.parentPid ? snap.tree.nodes.find((n: any) => n.pid === node.parentPid) : null;

          return json({
            pid,
            node: {
              ...node,
              label: truncate(node.label, 200),
            },
            detail: {
              cmd: truncate(detail.cmd, 4000),
              cwd: detail.cwd || node.cwd || "",
              user: detail.user || node.user || "",
              state: detail.state || node.state || "",
              etimeMs: detail.etimeMs == null ? node.etimeMs : detail.etimeMs,
              fdCount: detail.fdCount == null ? null : detail.fdCount,
              env: envWhitelist(detail.envText),
            },
            parent: parent ? { pid: parent.pid, label: parent.label } : null,
            children,
          });
        } catch (e: any) {
          return json({ error: String(e?.message || e) }, 500);
        }
      }

      return null;
    },
  },
};
