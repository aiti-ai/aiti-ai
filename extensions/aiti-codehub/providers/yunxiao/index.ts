/**
 * Yunxiao provider (full: work items, code, branches, merge requests).
 */
import { DEFAULT_TEMPLATES, type ForgeAccount, type ForgeProvider, type ProviderConfig } from "../../server/contract.ts";
import * as api from "./api.ts";
import { FILTERS } from "./constants.ts";
import { yunxiaoOAuth } from "./oauth.ts";

export const yunxiaoProvider: ForgeProvider = {
  id: "yunxiao",
  label: "云效",
  contract: 1,
  httpFor: (cfg) => api.httpFor(cfg),
  fileProxy: {
    allowedHosts: ["devops.aliyun.com", "openapi-rdc.aliyuncs.com"],
    pathPrefixes: ["/projex/api/workitem/file/"],
    authHeaders: (cfg) => api.authHeaders(cfg),
    resolve: async (cfg, http, p) => {
      const org = api.orgIdOf(cfg);
      const raw = await http.json<Record<string, unknown>>(`/oapi/v1/projex/organizations/${encodeURIComponent(org)}/workitems/${encodeURIComponent(p.workitemId)}/files/${encodeURIComponent(p.fileId)}`);
      const url = String(raw.url || raw.embedUrl || "");
      if (!url) throw new Error("Work-item file has no download URL");
      const suffix = String(raw.suffix || "").replace(/^\./, "").toLowerCase();
      const image = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(suffix);
      const contentType = image ? `image/${suffix === "jpg" ? "jpeg" : suffix === "svg" ? "svg+xml" : suffix}` : undefined;
      return { url, name: raw.name ? String(raw.name) : undefined, contentType };
    },
  },
  defaultBaseUrl: api.DEFAULT_BASE_URL,
  allowedHosts: api.ALLOWED_HOSTS,
  cloneHosts: ["codeup.aliyun.com"],

  capabilities: {
    workItems: { scope: "project", filters: FILTERS, comments: true },
    code: { namespaces: true, repos: true, branches: true, mergeRequests: "write" },
    auth: ["pat", "oauth"],
    clone: ["ssh", "https"],
  },

  auth: {
    pat: {
      fields: [
        {
          key: "orgId",
          label: "组织 ID",
          kind: "text",
          required: true,
          placeholder: "如 66a0326c1d2a2a350e263a7d",
          helpUrl: "https://devops.aliyun.com/organization",
          helpText: "云效工作台地址 https://devops.aliyun.com/organization/<orgId> 中的那段 ID",
        },
        {
          key: "token",
          label: "个人访问令牌（PAT）",
          kind: "password",
          required: true,
          helpUrl: "https://account-devops.aliyun.com/settings/personalAccessToken",
          helpText: "需要：组织（用户只读）、项目（项目/工作项只读）、代码管理（代码组/仓库/分支只读、合并请求读写）",
        },
        {
          key: "baseUrl",
          label: "API 域名",
          kind: "url",
          placeholder: "https://openapi-rdc.aliyuncs.com（Region 站填实例域名）",
        },
      ],
      async validate(cfg: ProviderConfig, http): Promise<ForgeAccount> {
        const user = await api.getUser(cfg, http);
        const orgId = cfg.orgId || user.lastOrganization || "";
        return {
          provider: "yunxiao",
          userId: user.id,
          username: user.username,
          displayName: user.name,
          extra: orgId ? { orgId } : undefined,
        };
      },
    },
    oauth: yunxiaoOAuth,
  },

  workItems: {
    listScopes: (cfg, http, page) => api.listProjects(cfg, page || {}, http),
    list: (cfg, http, scope, filter, page) => api.listWorkItems(cfg, scope, filter, page || {}, http),
    get: (cfg, http, scope, id) => api.getWorkItem(cfg, scope, id, http),
    comments: (cfg, http, item) => api.listComments(cfg, item, http),
    counts: (cfg, http, scope, seenAt) => api.counts(cfg, scope, seenAt, http),
  },

  code: {
    listNamespaces: (cfg, http, parentId, page) => api.listNamespaces(cfg, parentId, page || {}, http),
    listRepos: (cfg, http, namespace, page) => api.listRepos(cfg, namespace, page || {}, http),
    getRepo: (cfg, http, id) => api.getRepo(cfg, id, http),
    listBranches: (cfg, http, repo, page) => api.listBranches(cfg, repo, page || {}, http),
    createMR: (cfg, http, repo, input) => api.createMR(cfg, repo, input, http),
    cloneUrls: (repo) => ({ ssh: repo.cloneSsh, http: repo.cloneHttp }),
    listTree: (cfg, http, repo, q) => api.listTree(cfg, repo, q, http),
    getFile: (cfg, http, repo, q) => api.getFile(cfg, repo, q, http),
    listCommits: (cfg, http, repo, q) => api.listCommits(cfg, repo, q, http),
    getCommit: (cfg, http, repo, q) => api.getCommit(cfg, repo, q, http),
  },

  web: {
    workItem: (item) => item.webUrl || null,
    project: (project) => project.webUrl || null,
    repo: (repo) => repo.webUrl || null,
  },

  format: {
    defaults: { ...DEFAULT_TEMPLATES },
  },
};
