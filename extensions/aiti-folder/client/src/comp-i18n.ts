/**
 * comp-i18n · 跨扩展复用组件自带多语。
 *
 * 背景：aiti-folder 的可复用组件（WorkspaceDropdown / DirectoryBrowser / FolderSwitcher）
 * 会被其他扩展构建期内联（session-manager、aiti-git-review 等）。运行时宿主 t() 委托的是
 * 调用方扩展的 i18n 字典——那里没有本扩展的 key，界面会原样显示 key 字符串。
 *
 * 解法：可复用组件用到的文案内置在 COMPONENT_DICT，ct() 按当前语言直查；
 * 未收录的 key 回落宿主 t()（不破坏既有行为）。新增可复用组件文案一律加到这里，
 * 组件内不要再用宿主 t() 直查本扩展页面专属词条。
 */
import { t } from "./host-shim";

const COMPONENT_DICT: Record<string, Record<string, string>> = {
  en: {
    "files.cancel": "Cancel",
    "files.loading": "Loading files...",
    "files.noSubdirs": "No subdirectories",
    "files.parentDir": "Parent directory",
    "files.selectFolder": "Select this folder",
    "i18n.close": "Close",
    "sidebar.customPath": "Custom path…",
    "files.openFolder": "Open Folder",
    "sidebar.filterProjects": "Filter projects…",
    "sidebar.noMatchingProjects": "No matching projects",
    "sidebar.useDefaultDirectory": "Use default directory",

    "git.branchPanelTitle": "Branch panel (branch / tag / stash)",
    "git.pushTitle": "Push commits",
    "git.pullTitle": "Pull (ff-only)",
    "git.pushConfirm": "Push {count} commit(s) to upstream?",
    "git.pullConfirm": "Pull {count} commit(s) from upstream (ff-only)?",
    "git.commitTitle": "Commit",
    "git.commitShort": "Commit",
    "git.stageAll": "Select all",
    "git.stageNone": "Staged only",
    "git.stagedCount": "{count} selected",
    "git.commitPlaceholder": "Commit message…",
    "git.amend": "Amend last commit",
    "git.commitBtn": "Commit",
    "git.planShort": "Group",
    "git.planTitle": "Group & commit plan (staged group-by-group, breakpoint-resumable)",
    "git.planMoveTo": "Move to next group",
    "git.planExclude": "Exclude from plan",
    "git.planRestore": "Restore to first group",
    "git.planAddGroup": "＋ New group (takes last file of largest group)",
    "git.planExcluded": "Excluded (won't be committed)",
    "git.planStuck": "Stuck at group {group} — earlier groups already committed",
    "git.planRolledBack": "rolled back to base HEAD",
    "git.planRollback": "Roll back plan (reset --mixed)",
    "git.planExecute": "Commit group by group",
    "git.planConfirm": "Commit {count} group(s), one commit each?",
    "git.planNewGroupMessage": "chore: new group",
    "git.aiRefine": "AI refine",
    "git.aiRefineBusy": "AI grouping… (up to 3 min)",
    "git.aiMessage": "Generate",
    "git.aiMessageBusy": "Generating… (up to 3 min)",
    "git.aiMessageOverwrite": "Message already has content. Overwrite with the generated commit message?",
    "git.aiMessageTitle": "Generate a commit message with AI (reads AGENTS.md and the diff of selected files)",
    "git.stagedBucket": "Staged",
    "git.unstagedBucket": "Changes",
    "git.stageTitle": "Stage",
    "git.unstageTitle": "Unstage",
    "git.discardTitle": "Discard changes",
    // 已跟踪文件（引擎 discard = checkout 恢复到上次提交；untracked 由客户端分流到回收站，走下方专属文案）
    "git.discardConfirm": "Discard ALL uncommitted changes of {path}? (tracked files restore to the last commit)",
    "git.discardUntrackedConfirm": "Move the untracked file to the trash? (restorable from the trash)",
    "git.diffTitle": "View diff (git-review)",
    "git.changesToggle": "Toggle changed-files section",
    "git.planRetry": "Retry remaining groups",
  },
  "zh-CN": {
    "files.cancel": "取消",
    "files.loading": "正在加载文件...",
    "files.noSubdirs": "无子目录",
    "files.parentDir": "上级目录",
    "files.selectFolder": "选择此文件夹",
    "i18n.close": "关闭",
    "sidebar.customPath": "自定义路径…",
    "files.openFolder": "打开文件夹",
    "sidebar.filterProjects": "筛选项目…",
    "sidebar.noMatchingProjects": "没有匹配的项目",
    "sidebar.useDefaultDirectory": "使用默认目录",

    "git.branchPanelTitle": "分支面板（分支 / tag / stash）",
    "git.pushTitle": "推送提交",
    "git.pullTitle": "拉取（ff-only）",
    "git.pushConfirm": "推送 {count} 个提交到上游？",
    "git.pullConfirm": "从上游拉取 {count} 个提交（ff-only）？",
    "git.commitTitle": "提交",
    "git.commitShort": "提交",
    "git.stageAll": "全选",
    "git.stageNone": "仅暂存区",
    "git.stagedCount": "已选 {count} 个",
    "git.commitPlaceholder": "提交消息…",
    "git.amend": "修正上一笔（amend）",
    "git.commitBtn": "提交",
    "git.planShort": "分组",
    "git.planTitle": "分组提交计划（逐组提交 · 失败断点可回滚）",
    "git.planMoveTo": "移到下一组",
    "git.planExclude": "剔除出计划",
    "git.planRestore": "恢复到第一组",
    "git.planAddGroup": "＋ 新建组（取最大组的最后一个文件）",
    "git.planExcluded": "已剔除（不会提交）",
    "git.planStuck": "卡在第 {group} 组——之前的组已提交",
    "git.planRolledBack": "已回滚到起点 HEAD",
    "git.planRollback": "回滚本计划（reset --mixed）",
    "git.planExecute": "逐组提交",
    "git.planConfirm": "共 {count} 组，每组一笔提交？",
    "git.planNewGroupMessage": "chore: new group",
    "git.aiRefine": "AI 精修",
    "git.aiRefineBusy": "AI 分组中…（最长 3 分钟）",
    "git.aiMessage": "生成",
    "git.aiMessageBusy": "生成中…（最长 3 分钟）",
    "git.aiMessageOverwrite": "输入框已有内容，生成结果将覆盖，是否继续？",
    "git.aiMessageTitle": "AI 生成提交信息（读取 AGENTS.md 与所选文件的 diff）",
    "git.stagedBucket": "已暂存",
    "git.unstagedBucket": "工作区",
    "git.stageTitle": "暂存",
    "git.unstageTitle": "取消暂存",
    "git.discardTitle": "丢弃变更",
    // 已跟踪文件（引擎 discard = checkout 恢复到上次提交；untracked 由客户端分流到回收站，走下方专属文案）
    "git.discardConfirm": "丢弃 {path} 的全部未提交改动？（已跟踪文件将恢复到上次提交）",
    "git.discardUntrackedConfirm": "将未跟踪文件移入回收站？（可在回收站还原）",
    "git.diffTitle": "查看 diff（git-review）",
    "git.changesToggle": "开/合变更文件区",
    "git.planRetry": "重试剩余组",
  },
};

/** 当前语言（pi-web 注入 __PI_LOCALE__；兜底 <html lang>；zh 系归一为 zh-CN） */
function currentLocale(): string {
  const raw = (window as any).__PI_LOCALE__ || document.documentElement.lang || "en";
  const l = String(raw);
  if (l.startsWith("zh")) return "zh-CN";
  return l;
}

/** 组件多语：内置字典优先；未收录回落宿主 t() */
export function ct(key: string, params?: Record<string, unknown>): string {
  const dict = COMPONENT_DICT[currentLocale()];
  let hit: string | undefined = dict && dict[key];
  if (hit === undefined) hit = t(key);
  if (params && typeof hit === "string") {
    for (const [k, v] of Object.entries(params)) hit = hit.split("{" + k + "}").join(String(v));
  }
  return hit;
}
