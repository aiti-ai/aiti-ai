/**
 * aiti-codehub — multi-platform research collaboration hub for pi-web.
 *
 * One package, two independent surfaces (work items / repositories), four providers
 * (Yunxiao full; GitHub / Gitee / GitLab read-only), PAT + OAuth, agent tools, and a
 * workspace-hub clone source.
 */
import { startup, shutdown, getRegistry } from "./server/runtime.ts";
import { createMiddleware } from "./server/middleware.ts";
import { api } from "./server/routes.ts";
import { agentTools } from "./server/tools.ts";
import { UI_I18N } from "./ui-i18n.ts";

export default {
  id: "aiti-codehub",
  name: "研发平台",
  icon: "icon.svg",
  category: "code",
  keywords: [
    "codehub", "研发平台", "云效", "yunxiao", "github", "gitee", "gitlab",
    "工作项", "work item", "issue", "repository", "分支", "branch", "merge request",
  ],
  client: "dist/aiti-codehub-client.mjs",

  features: [
    { id: "surface.workitems", label: "Work items panel", description: "Show the work items dock tab / dialog / toolbar entry.", group: "Surfaces", default: true },
    { id: "surface.code", label: "Repositories panel", description: "Show the repositories dock tab / dialog / commands.", group: "Surfaces", default: true },
    { id: "agentTools.enabled", label: "Agent tools", description: "Expose aiti_codehub_* tools to agent sessions.", group: "AI", default: true },
    { id: "tool.aiti_codehub_branch_create", label: "Tool: create branch", description: "Allow the agent to create git branches for work items (git write).", group: "AI", default: false },
    { id: "tool.aiti_codehub_mr_create", label: "Tool: create merge request", description: "Allow the agent to create merge requests (remote write).", group: "AI", default: false },
  ],

  optionalDependsOn: ["aiti-quickstart", "aiti-folder", "aiti-git-ops", "aiti-float", "aiti-event-bus", "aiti-app-center"],

  ui: {
    clientImmediately: false,
    // Also delivered through the pickWorkItem cross-extension service and the
    // aiti-folder commit-actions slot (the "Work item" button registers from the
    // client mount) — materialize in the first idle window so both entry points
    // are ready without opening a surface first.
    clientLazyVia: "service",
    prefetchOnIdle: true,
    toolbar: [
      { id: "open-workitems", label: "i18n:ch.dock.workitems", title: "i18n:ch.toolbar.title", icon: "icons/workitems.svg" },
      { id: "open-code", label: "i18n:ch.toolbar.code", title: "i18n:ch.toolbar.codeTitle", icon: "icons/repo.svg" },
    ],
    rightFileDock: [
      { id: "workitems", label: "i18n:ch.dock.workitems", icon: "icons/workitems.svg" },
      { id: "code", label: "i18n:ch.dock.code", icon: "icons/repo.svg" },
      { id: "repo-workspace", label: "i18n:ch.dock.repo", icon: "icons/repo.svg" },
    ],
    sidebarExplorerDock: [
      { id: "workitems", label: "i18n:ch.dock.workitems", icon: "icons/workitems.svg", priority: 4 },
      { id: "code", label: "i18n:ch.dock.code", icon: "icons/repo.svg", priority: 5 },
      { id: "repo-workspace", label: "i18n:ch.dock.repo", icon: "icons/repo.svg", priority: 6 },
    ],
    dialogs: [
      { id: "workitems", label: "i18n:ch.dlg.workitems" },
      { id: "workitem-detail", label: "i18n:ch.dlg.detail" },
      { id: "workitem-pick", label: "i18n:ch.dlg.pick" },
      { id: "code", label: "i18n:ch.dlg.code" },
      { id: "settings", label: "i18n:ch.dlg.settings" },
      { id: "mr", label: "i18n:ch.dlg.mr" },
      { id: "clone", label: "i18n:ch.dlg.clone" },
      { id: "repo-workspace", label: "i18n:ch.dlg.repo" },
    ],
    i18n: UI_I18N,
  },

  ai: {
    manage: true,
    intro: "AI 能帮我查云效 / GitHub / Gitee / GitLab 的工作项、仓库与分支，按工作项建分支，创建合并请求",
    skills: "skills",
  },

  server: {
    startup,
    shutdown,
    middleware: createMiddleware((id: string) => !!getRegistry().get(id)),
    api,
    agent: {
      agentTools,
    },
  },
};
