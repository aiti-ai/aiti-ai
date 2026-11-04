/**
 * folder-actions —— 开放点共享小模块（拆包专用，docs/aiti-ext-lazy-loading-plan.md D3）。
 *
 * registerAction（薄入口静态持有：window.__aitiFolder 开放点同步可用）与
 * FolderBrowser（重 chunk，按需 import()）共同导入本模块——同一模块实例保证
 * 薄入口阶段注册的动作在重 chunk 加载后可见（Rollup 共享模块归并入口 chunk）。
 */

// ── 开放点：其他扩展注册目录级工具条按钮（match(dirPath, ctx) → 显示/隐藏；onClick(dirPath)）──
// icon：可选图标（ReactNode，如 aiti-git-review 的统一 GrEyeIcon）；给了则按钮渲染 icon 而非 label 文本
export type FolderAction = { id?: string; label: string; title?: string; icon?: any; match?: (dirPath: string, ctx: { gitFiles: any[] }) => boolean; onClick: (dirPath: string) => void };
export const folderActions: FolderAction[] = [];
export function registerAction(reg: FolderAction) { folderActions.push(reg); return () => { const i = folderActions.indexOf(reg); if (i >= 0) folderActions.splice(i, 1); }; }
