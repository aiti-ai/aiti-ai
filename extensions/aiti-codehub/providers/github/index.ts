/**
 * GitHub provider entry (read-only: repos / branches / issues / comments).
 */
import { DEFAULT_TEMPLATES, type ForgeProvider } from "../../server/contract.ts";
import {
  ALLOWED_HOSTS,
  DEFAULT_BASE_URL,
  counts,
  getRepo,
  httpFor,
  getWorkItem,
  getUser,
  listBranches,
  getCommit,
  listCommits,
  getFile,
  listTree,
  listComments,
  listForks,
  listNamespaces,
  listRepos,
  listStarred,
  listWorkItems,
  searchRepos,
} from "./api.ts";
import { githubOAuth } from "./oauth.ts";

export const githubProvider: ForgeProvider = {
  id: "github",
  label: "GitHub",
  contract: 1,
  httpFor: (cfg) => httpFor(cfg),
  defaultBaseUrl: DEFAULT_BASE_URL,
  allowedHosts: ALLOWED_HOSTS,
  allowsCustomBaseUrl: true,
  cloneHosts: ["github.com"],

  capabilities: {
    workItems: {
      scope: "repo",
      comments: true,
      filters: [
        { key: "keyword", kind: "text", label: "关键词" },
        {
          key: "state",
          kind: "multi",
          label: "状态",
          options: [
            { value: "open", label: "open" },
            { value: "closed", label: "closed" },
            { value: "all", label: "all" },
          ],
        },
        { key: "labels", kind: "tags", label: "Labels" },
        { key: "assignee", kind: "user", label: "Assignee" },
      ],
    },
    code: { namespaces: true, repos: true, branches: true, mergeRequests: false, views: { forks: true, starred: true, search: true } },
    auth: ["pat", "oauth", "gh"],
    clone: ["ssh", "https"],
  },

  auth: {
    pat: {
      fields: [
        {
          key: "token",
          label: "Personal Access Token",
          kind: "password",
          required: true,
          helpUrl: "https://github.com/settings/tokens",
          helpText: "classic: repo + read:user；fine-grained: Contents / Branches / Issues 只读",
        },
        {
          key: "baseUrl",
          label: "API 地址",
          kind: "url",
          placeholder: "https://api.github.com（GHES 填 https://ghe.example.com）",
        },
      ],
      validate: (cfg, http) => getUser(cfg, http),
    },
    oauth: githubOAuth,
    gh: { label: "GitHub CLI (gh)", helpUrl: "https://cli.github.com/" },
  },

  workItems: {
    listScopes: (cfg, http, page) => listRepos(cfg, undefined, page || {}, http),
    list: (cfg, http, scope, filter, page) => listWorkItems(cfg, scope, filter, page || {}, http),
    get: (cfg, http, scope, id) => getWorkItem(cfg, scope, id, http),
    comments: (cfg, http, item) => listComments(cfg, item, http),
    counts: (cfg, http, scope, seenAt) => counts(cfg, scope, seenAt, http),
  },

  code: {
    listNamespaces: (cfg, http, _parentId, page) => listNamespaces(cfg, page || {}, http),
    listRepos: (cfg, http, namespace, page) => listRepos(cfg, namespace, page || {}, http),
    getRepo: (cfg, http, id) => getRepo(cfg, id, http),
    listBranches: (cfg, http, repo, page) => listBranches(cfg, repo, page || {}, http),
    listTree: (cfg, http, repo, q) => listTree(cfg, repo, q || {}, http),
    getFile: (cfg, http, repo, q) => getFile(cfg, repo, q, http),
    listCommits: (cfg, http, repo, q) => listCommits(cfg, repo, q || {}, http),
    getCommit: (cfg, http, repo, q) => getCommit(cfg, repo, q, http),
    listStarred: (cfg, http, page) => listStarred(cfg, page || {}, http),
    listForks: (cfg, http, page) => listForks(cfg, page || {}, http),
    searchRepos: (cfg, http, q, page) => searchRepos(cfg, q, page || {}, http),
    cloneUrls: (repo) => ({ ssh: repo.cloneSsh, http: repo.cloneHttp }),
  },

  web: {
    workItem: (item) => item.webUrl || null,
    repo: (repo) => repo.webUrl || null,
  },

  format: { defaults: { ...DEFAULT_TEMPLATES } },
};
