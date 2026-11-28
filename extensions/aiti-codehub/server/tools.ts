/**
 * Agent tools: read-only by default, writes require confirm=true and a feature gate
 * (tool.<name>; managed by the extension manager, default off).
 */
import type { ForgeRepo, ForgeWorkItem, ForgeWorkItemScope, WorkItemFilter } from "./contract.ts";
import { bind, type InstanceBinding } from "./binding.ts";
import { instanceLabel } from "./instances.ts";
import { ForgeHttpError } from "./http.ts";
import { refreshIfNeeded } from "./oauth.ts";
import { withGhToken } from "./gh-cli.ts";
import { getRegistry, getServices, getStore, runtime } from "./runtime.ts";
import { formatBranchName } from "./format.ts";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function fail(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Tool params: `provider` = platform id or instance id; optional `account` = alias/slug. */
function target(params: Record<string, any> | undefined): InstanceBinding {
  return bind(String(params?.provider || ""), params?.account ? String(params.account) : undefined);
}

async function cfgOf(inst: InstanceBinding) {
  let cfg = getStore().provider(inst.id);
  if (cfg.authType === "oauth" && cfg.token) cfg = await refreshIfNeeded(runtime(), inst.id);
  if (cfg.authType === "gh") cfg = await withGhToken(cfg);
  if (!cfg.token) throw new ForgeHttpError(`${inst.id} is not configured (no token)`, { status: 401, code: "auth" });
  return cfg;
}

function displayLabel(inst: InstanceBinding): string {
  const platformLabel = inst.adapter.label;
  return instanceLabel({ id: inst.id, platform: inst.platform, alias: getStore().provider(inst.id).alias || "" }, platformLabel);
}

function scopeOf(params: Record<string, unknown>): ForgeWorkItemScope {
  const id = String(params.scopeId || "").trim();
  if (!id) throw new ForgeHttpError("scopeId is required", { status: 400, code: "bad_request" });
  return {
    kind: params.scopeKind === "repo" ? "repo" : "project",
    id,
    label: String(params.scopeLabel || id),
  };
}

function filterOf(params: Record<string, unknown>): WorkItemFilter {
  const arr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  return {
    keyword: params.keyword ? String(params.keyword) : undefined,
    types: arr(params.types),
    statuses: arr(params.statuses),
    states: arr(params.states),
    assignee: params.assignee ? String(params.assignee) : undefined,
    labels: arr(params.labels),
    excludeTerminal: params.excludeTerminal === undefined ? getStore().global().excludeClosed : params.excludeTerminal === true,
  };
}

function repoOf(params: Record<string, unknown>): ForgeRepo {
  const path = String(params.repoPath || params.repoId || "").trim();
  if (!path) throw new ForgeHttpError("repoPath is required", { status: 400, code: "bad_request" });
  return {
    id: String(params.repoId || path),
    name: String(params.repoName || path.split("/").pop() || path),
    path,
    defaultBranch: params.defaultBranch ? String(params.defaultBranch) : undefined,
  };
}

function summary(item: ForgeWorkItem) {
  return {
    id: item.id,
    key: item.key,
    number: item.number,
    title: item.title,
    type: item.type,
    status: item.status,
    state: item.state,
    assignee: item.assignee,
    tags: item.tags,
    url: item.webUrl,
    scope: item.scope,
    updatedAt: item.updatedAt,
  };
}

export interface AgentToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, any>, ...rest: any[]) => Promise<unknown>;
}

export function agentTools(info: { sessionId: string; cwd: string }): AgentToolDefinition[] {
  const defaultCwd = String(info.cwd || "");

  return [
    {
      name: "aiti_codehub_providers",
      label: "aiti_codehub_providers",
      description:
        "List CodeHub platforms and their configured accounts (instances). Pass an instance id (or provider + account) to every other tool.",
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const platforms = getRegistry().list().map((p) => ({
            platform: p.id,
            label: p.label,
            capabilities: p.capabilities,
          }));
          const instances = getStore().instances().map((i) => {
            const cfg = getStore().provider(i.id);
            const platformLabel = getRegistry().get(i.platform)?.label || i.platform;
            return {
              id: i.id,
              platform: i.platform,
              alias: instanceLabel({ ...i, alias: cfg.alias || i.alias }, platformLabel),
              configured: !!cfg.token,
              authType: cfg.authType || "pat",
              account: cfg.account?.username || null,
              orgId: cfg.orgId || "",
            };
          });
          return ok({ platforms, instances });
        } catch (e) {
          return fail({ ok: false, error: msg(e) });
        }
      },
    },

    {
      name: "aiti_codehub_workitems",
      label: "aiti_codehub_workitems",
      description:
        "Search/list work items (Yunxiao) or issues (GitHub/Gitee/GitLab). Provide provider + scope (project id for Yunxiao, owner/repo for the others). " +
        "Returns normalized items with key/title/state/assignee/url and the usage markers recorded in the UI.",
      parameters: {
        type: "object",
        required: ["provider", "scopeId"],
        properties: {
          provider: { type: "string", description: "Instance id (e.g. \"github\" or \"github~work\") or platform id" },
          account: { type: "string", description: "Account alias/slug when the platform has several accounts (ignored when provider is already an instance id)" },
          scopeKind: { type: "string", description: "project (Yunxiao) | repo (issues platforms)" },
          scopeId: { type: "string", description: "Yunxiao project id or owner/repo" },
          scopeLabel: { type: "string" },
          keyword: { type: "string", description: "Title/description keyword, or #123 / ABC-123" },
          types: { type: "array", items: { type: "string" }, description: "Yunxiao category ids (Req/Bug/Task/Risk/SubTask)" },
          statuses: { type: "array", items: { type: "string" }, description: "Yunxiao status display names" },
          states: { type: "array", items: { type: "string" }, description: "Issues: open/closed/all" },
          assignee: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          excludeTerminal: { type: "boolean" },
          page: { type: "number" },
          pageSize: { type: "number" },
        },
      },
      async execute(_id, params) {
        try {
          const inst = target(params);
          const p = inst.adapter;
          if (!p.workItems) return fail({ ok: false, error: "provider has no work items" });
          const cfg = await cfgOf(inst);
          const page = await p.workItems.list(cfg, p.httpFor(cfg), scopeOf(params), filterOf(params), {
            page: Number(params?.page || 1) || 1,
            pageSize: Number(params?.pageSize || getStore().global().pageSize) || 50,
          });
          const usage = Object.fromEntries(
            page.items.map((i) => [i.id, getStore().usage(inst.id, i.id)]),
          );
          return ok({ ok: true, total: page.total, hasMore: page.hasMore, items: page.items.map(summary), usage });
        } catch (e) {
          return fail({ ok: false, error: msg(e) });
        }
      },
    },

    {
      name: "aiti_codehub_workitem",
      label: "aiti_codehub_workitem",
      description: "Get one work item / issue with its description (plain text + image URLs) and optionally its comments.",
      parameters: {
        type: "object",
        required: ["provider", "scopeId", "id"],
        properties: {
          provider: { type: "string", description: "Instance id (e.g. \"github\" or \"github~work\") or platform id" },
          account: { type: "string", description: "Account alias/slug when the platform has several accounts (ignored when provider is already an instance id)" },
          scopeKind: { type: "string" },
          scopeId: { type: "string" },
          scopeLabel: { type: "string" },
          id: { type: "string", description: "Yunxiao work item id or issue number" },
          comments: { type: "boolean", description: "Include comments (default false)" },
        },
      },
      async execute(_id, params) {
        try {
          const inst = target(params);
          const p = inst.adapter;
          if (!p.workItems) return fail({ ok: false, error: "provider has no work items" });
          const cfg = await cfgOf(inst);
          const scope = scopeOf(params);
          const item = await p.workItems.get(cfg, p.httpFor(cfg), scope, String(params?.id || ""));
          let comments;
          if (params?.comments) comments = await p.workItems.comments(cfg, p.httpFor(cfg), item);
          getStore().addRecent({ provider: inst.id, kind: "workitem", id: item.id, label: `#${item.key} ${item.title}`, sub: scope.label, scopeKind: scope.kind, scopeId: scope.id });
          return ok({
            ok: true,
            item: {
              ...summary(item),
              description: item.description,
              images: item.images,
              extraFields: item.extraFields,
              creator: item.creator,
              priority: item.priority,
              createdAt: item.createdAt,
              comments,
            },
            usage: getStore().usage(inst.id, item.id),
          });
        } catch (e) {
          return fail({ ok: false, error: msg(e) });
        }
      },
    },

    {
      name: "aiti_codehub_repos",
      label: "aiti_codehub_repos",
      description: "List/search repositories for a provider (optionally inside a namespace/group/org).",
      parameters: {
        type: "object",
        required: ["provider"],
        properties: {
          provider: { type: "string", description: "Instance id (e.g. \"github\" or \"github~work\") or platform id" },
          account: { type: "string", description: "Account alias/slug when the platform has several accounts (ignored when provider is already an instance id)" },
          namespace: { type: "string" },
          q: { type: "string" },
          page: { type: "number" },
          pageSize: { type: "number" },
        },
      },
      async execute(_id, params) {
        try {
          const inst = target(params);
          const p = inst.adapter;
          if (!p.code) return fail({ ok: false, error: "provider has no code" });
          const cfg = await cfgOf(inst);
          const page = await p.code.listRepos(cfg, p.httpFor(cfg), params?.namespace ? String(params.namespace) : undefined, {
            page: Number(params?.page || 1) || 1,
            pageSize: Number(params?.pageSize || getStore().global().pageSize) || 50,
            q: params?.q ? String(params.q) : undefined,
          });
          return ok({
            ok: true,
            total: page.total,
            hasMore: page.hasMore,
            items: page.items.map((r) => ({
              id: r.id, name: r.name, path: r.path, defaultBranch: r.defaultBranch,
              url: r.webUrl, cloneSsh: r.cloneSsh, cloneHttp: r.cloneHttp, updatedAt: r.updatedAt,
            })),
          });
        } catch (e) {
          return fail({ ok: false, error: msg(e) });
        }
      },
    },

    {
      name: "aiti_codehub_branches",
      label: "aiti_codehub_branches",
      description: "List/search branches of a repository.",
      parameters: {
        type: "object",
        required: ["provider", "repoPath"],
        properties: {
          provider: { type: "string", description: "Instance id (e.g. \"github\" or \"github~work\") or platform id" },
          account: { type: "string", description: "Account alias/slug when the platform has several accounts (ignored when provider is already an instance id)" },
          repoId: { type: "string" },
          repoPath: { type: "string" },
          repoName: { type: "string" },
          defaultBranch: { type: "string" },
          q: { type: "string" },
          page: { type: "number" },
          pageSize: { type: "number" },
        },
      },
      async execute(_id, params) {
        try {
          const inst = target(params);
          const p = inst.adapter;
          if (!p.code) return fail({ ok: false, error: "provider has no code" });
          const cfg = await cfgOf(inst);
          const page = await p.code.listBranches(cfg, p.httpFor(cfg), repoOf(params), {
            page: Number(params?.page || 1) || 1,
            pageSize: Number(params?.pageSize || getStore().global().pageSize) || 50,
            q: params?.q ? String(params.q) : undefined,
          });
          return ok({
            ok: true,
            total: page.total,
            hasMore: page.hasMore,
            items: page.items.map((b) => ({ name: b.name, default: b.default, protected: b.protected, commit: b.commit })),
          });
        } catch (e) {
          return fail({ ok: false, error: msg(e) });
        }
      },
    },

    {
      name: "aiti_codehub_branch_create",
      label: "aiti_codehub_branch_create",
      description:
        "Create (and check out) a git branch for a work item in the current working directory, using the provider branch template. " +
        "Writes to git: requires confirm=true. Uses the shared git-ops engine when available.",
      parameters: {
        type: "object",
        required: ["provider", "scopeId", "id"],
        properties: {
          provider: { type: "string", description: "Instance id (e.g. \"github\" or \"github~work\") or platform id" },
          account: { type: "string", description: "Account alias/slug when the platform has several accounts (ignored when provider is already an instance id)" },
          scopeKind: { type: "string" },
          scopeId: { type: "string" },
          scopeLabel: { type: "string" },
          id: { type: "string" },
          cwd: { type: "string", description: "Defaults to the session cwd" },
          template: { type: "string", description: "Defaults to the configured branch template" },
          confirm: { type: "boolean", description: "Must be true to perform the write" },
        },
      },
      async execute(_id, params) {
        if (params?.confirm !== true) return fail({ ok: false, error: "confirm=true is required for git writes" });
        try {
          const inst = target(params);
          const p = inst.adapter;
          if (!p.workItems) return fail({ ok: false, error: "provider has no work items" });
          const cfg = await cfgOf(inst);
          const scope = scopeOf(params);
          const item = await p.workItems.get(cfg, p.httpFor(cfg), scope, String(params?.id || ""));
          const template = String(params?.template || getStore().global().templates.branch || p.format?.defaults.branch || "{type}_{id}");
          const branch = formatBranchName(item, displayLabel(inst), template, getStore().provider(inst.id).alias || "");
          const cwd = String(params?.cwd || defaultCwd || "");
          if (!cwd) return fail({ ok: false, error: "cwd is required" });

          const svc = getServices()?.get?.("aiti-git-ops.api") as
            | { refs?: (cwd: string) => Promise<{ current?: string; branches?: string[] }>; branchCreate?: (cwd: string, name: string) => Promise<{ ok: boolean; branch?: string }> }
            | undefined;
          if (!svc?.branchCreate) return fail({ ok: false, error: "aiti-git-ops is not available" });
          const refs = svc.refs ? await svc.refs(cwd).catch(() => null) : null;
          const exists = Array.isArray(refs?.branches) && refs!.branches!.includes(branch);
          if (exists) return fail({ ok: false, error: `branch already exists: ${branch}`, branch });
          const res = await svc.branchCreate(cwd, branch);
          if (!res?.ok) return fail({ ok: false, error: "branch creation failed", branch });
          getStore().markUsage(inst.id, item.id, "branch", branch);
          return ok({ ok: true, branch, cwd, item: summary(item) });
        } catch (e) {
          return fail({ ok: false, error: msg(e) });
        }
      },
    },

    {
      name: "aiti_codehub_mr_create",
      label: "aiti_codehub_mr_create",
      description: "Create a merge request (Yunxiao only in this version). Requires confirm=true.",
      parameters: {
        type: "object",
        required: ["provider", "repoPath", "sourceBranch", "targetBranch", "title"],
        properties: {
          provider: { type: "string", description: "Instance id (e.g. \"github\" or \"github~work\") or platform id" },
          account: { type: "string", description: "Account alias/slug when the platform has several accounts (ignored when provider is already an instance id)" },
          repoId: { type: "string" },
          repoPath: { type: "string" },
          repoName: { type: "string" },
          defaultBranch: { type: "string" },
          sourceBranch: { type: "string" },
          targetBranch: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          workItemIds: { type: "array", items: { type: "string" } },
          confirm: { type: "boolean" },
        },
      },
      async execute(_id, params) {
        if (params?.confirm !== true) return fail({ ok: false, error: "confirm=true is required for merge requests" });
        try {
          const inst = target(params);
          const p = inst.adapter;
          if (!p.code?.createMR) return fail({ ok: false, error: "provider does not support merge requests" });
          const cfg = await cfgOf(inst);
          const mr = await p.code.createMR(cfg, p.httpFor(cfg), repoOf(params), {
            sourceBranch: String(params?.sourceBranch || ""),
            targetBranch: String(params?.targetBranch || ""),
            title: String(params?.title || ""),
            description: params?.description ? String(params.description) : undefined,
            workItemIds: Array.isArray(params?.workItemIds) ? params.workItemIds.map(String) : undefined,
          });
          return ok({ ok: true, mr });
        } catch (e) {
          return fail({ ok: false, error: msg(e) });
        }
      },
    },
  ];
}
