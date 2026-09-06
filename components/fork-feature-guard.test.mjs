// ─────────────────────────────────────────────────────────────────────────────
// fork 特性护栏（fork-feature-guard）
//
// 背景：2026-08/09 上游合并时，多次出现「auto-merge 静默丢掉我方特性」或
// 「冲突解决以错误一侧为准」的事故（绿闪刷新按钮误判丢失、运行态三源聚合被上游
// 单源顶掉、i18n 重复键、media 明文路径回归风险、插槽契约丢失、fork-gates 断线、
// steer 重试卡死回归等，详见 docs/pi-web-merge-notes.md + §3.9 预警清单）。
//
// 本文件是**源码标记清单**：每条 = 一次事故的教训。合并上游后 `bun run test`
// 若在这里失败，说明对应 fork 特性被丢——按 merge-notes 原则（冲突以我方为准）
// 恢复我方实现，而不是改测试迁就合并结果。
//
// 维护约定：
//   • 特性被**有意重构**时，同步更新对应标记（commit message 注明 guard）。
//   • 新增 fork 特性时，往 GUARDS 里加一行——丢过一次的东西必须在这里。
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

const GUARDS = [
  {
    name: "会话侧栏：树形视图 + 绿闪手动刷新按钮 + 行内 meta 插槽（绿闪按钮曾误判丢失）",
    file: "./SessionSidebar.tsx",
    must: [
      /function buildSessionTree/,                                   // 我方树形侧栏（上游 families 方案不回退）
      /onClick=\{\(\) => loadSessions\(false, true\)\}/,             // 手动刷新按钮
      /sessionRefreshDone \? "rgba\(74,222,128,0\.18\)"/,            // 刷新成功绿闪反馈
      /name="sessionRowMeta"/,                                       // 行内 meta 扩展槽（aiti-plan-first 方案标/tags）
      /relation\?\.kind === "subagent"/,                             // 子会话/分支关系图标
      /isDraft=/,                                                    // 未落盘草稿行（客户端 draft row）
    ],
  },
  {
    name: "运行态三源聚合：RPC + 后端 handle + TUI 桥（上游单源会顶掉多后端运行态）",
    file: "../app/api/agent/running/route.ts",
    must: [
      /getRunningRpcSessionIds\(\), \.\.\.getRunningHandleIds\(\), \.\.\.getBridgeRunningIds\(\)/,
      /sessionListVersion: getSessionListVersion\(\)/,               // 上游 #625 跨窗口缓存版本号并存
    ],
  },
  {
    name: "会话列表路由：运行态聚合 + sessionListVersion 双方并存",
    file: "../app/api/sessions/route.ts",
    must: [
      /\[\.\.\.getRunningRpcSessionIds\(\), \.\.\.getRunningHandleIds\(\), \.\.\.getBridgeRunningIds\(\)\]/,
      /sessionListVersion,/,
    ],
  },
  {
    name: "会话删除：站位文件锚点删除（extId）+ 上游父缺失容错并存（#659）",
    file: "../app/api/sessions/[id]/route.ts",
    must: [
      /if \(deleteHeader\?\.extId\) \{/,                             // 我方站位：只删锚点不碰外部原始数据
      /removePlaceholderByUuid\(id\)/,
      /treat it as absent/,                                          // 上游：父文件已删时容错
    ],
  },
  {
    name: "FileViewer 票据制：媒体取流禁止回退明文路径 URL（getFileApiUrl 模式禁止回归）",
    file: "./FileViewer.tsx",
    must: [
      /useTicketUrl\(filePath, "read"/,                              // 图片/视频/文档 src 走短时效票据
      /buildTicketUrl\(filePath, "watch"\)/,                         // watch 通道走票据（EventSource）
      /fetchFileGet\(filePath, "meta"/,                              // fetch 型请求路径走 body
      /getExtUiItems\("fileViewer"\)/,                               // aiti-editor 接管跳板
      /isVideoPath\(filePath\)/,                                     // 上游 #655 视频预览已吸收
    ],
    not: [
      /getFileApiUrl/,                                               // 明文路径拼 URL（安全回归即失败）
    ],
  },
  {
    name: "扩展插槽契约：模型接管/设置模型/文件查看器（P4 去 fork + wizard 接线）",
    file: "../lib/ext/types.ts",
    must: [
      /"fileViewer"/,
      /"modelSelector"/,                                             // aiti-model-wizard 接管聊天模型按钮
      /"settingsModels"/,                                            // 设置面板模型页签接管
      /"sessionRowMeta"/,
      /interface ModelSelectorSlotProps/,                            // 接管组件拿同等契约（保底快速切换不丢）
    ],
  },
  {
    name: "ChatInput：模型按钮接管接线（未注册时原生下拉兜底）",
    file: "./ChatInput.tsx",
    must: [
      /useExtSlotItems\("modelSelector"\)\.find\(hasExtRender\)/,
    ],
  },
  {
    name: "SettingsPanel：settingsModels 接管接线",
    file: "./SettingsPanel.tsx",
    must: [
      /useExtSlotItems\("settingsModels"\)\.find\(hasExtRender\)/,
      /slot="settingsModels"/,
    ],
  },
  {
    name: "AppShell：项目身份预推进 + 扩展顶栏/工具栏接管错误边界 + 统计刷新器注册",
    file: "./AppShell.tsx",
    must: [
      /activeProjectKeyRef\.current = workspaceKeyOf\(session\)/,    // 先于 cwd-sync effect（首次点选不失败）
      /slot=\{toolbarItem \? "toolbar" : "sessionTopbar"\}/,         // 顶栏/工具栏扩展接管
      /onSessionStatsRefresherRegister/,
    ],
  },
  {
    name: "「从此处编辑」fork-gates 前置门（aiti-git-trace 回撤三选项入口，曾随合并断线）",
    file: "./ChatWindow.tsx",
    must: [
      /import \{ runSessionForkGates \} from "@\/lib\/ext\/fork-gates"/,
      /await runSessionForkGates\(\{ sessionId/,                     // 标记前先问回撤，取消则中止
      /const handleEditFromHereMark = useCallback\(async /,          // 门是 async——签名演进要有测试跟着改
      /if \(!hasPending && chatInputRef\?\.current\?\.hasInput\?\.\(\)\) return;[\s\S]*?await runSessionForkGates\(\{ sessionId/,
                                                                      // 免打扰预检在门之前（先弹门会白答一次，2026-09 审核）
    ],
  },
  {
    name: "fork 不触发 ai变更处置门（9963a46 有意决策：新会话追加式不动原会话，无回滚诉求）",
    file: "../hooks/useAgentSession.ts",
    not: [
      /runSessionForkGates\(/,                                       // 门只在「从此处编辑」（ChatWindow）；fork 重新挂门=回归旧语义，红灯强制有意识决策
    ],
  },
  {
    name: "扩展渲染错误边界：接管组件崩溃不拖垮页面（ExtItemBoundary 必须包住接管点）",
    file: "./ChatWindow.tsx",
    must: [
      /data-entry-id=\{entryIds\[idx\]\}/,                           // msg-smart/锚点扩展的 DOM 契约
      /onEditFromHere=\{isNew \? undefined : handleEditFromHereMark\}/,
      /name="chatOverlay"/,                                          // 消息导航条/锚点横幅插槽
    ],
  },
  {
    name: "ChatWindow：权限浮条 + 后端用量浮条 + 队列恢复对话框 + 队列导出（auto-merge 高危区）",
    file: "./ChatWindow.tsx",
    must: [
      /\{permissionRequest && \(/,                                   // 工具授权浮层（本地方案）
      /backendUsage && !isEmptyNew/,                                 // backend usage 悬浮条
      /<QueueRecoveryDialog/,                                        // 队列恢复/导入
      /onExportQueue\?\./,                                           // 队列导出到 AppShell
      /scrollToBottom/,                                              // 我方滚动钉底（与上游 scrollToMessage 并存）
      /scrollToMessage/,                                             // 上游搜索跳转（合并并集样本）
      /newSessionBackendBar/,                                        // 多后端管理入口插槽（沉底区迁移后仍在）
      /sessionBackend/,                                              // 多后端会话状态
    ],
  },
  {
    name: "useAgentSession：权限/过期/扩展对话框关闭三态事件 + basePath 包装（并集样本）",
    file: "../hooks/useAgentSession.ts",
    must: [
      /case "permission_request":/,
      /case "permission_expired":/,
      /case "extension_ui_closed":/,                                 // 上游 #612 可收起对话框的关闭事件
      /apiUrl\(`\/api\/sessions\/\$\{encodeURIComponent\(sid\)\}\/context/, // 子路径部署 basePath 包装
    ],
  },
  {
    name: "队列面板插槽 + 三态底栏（aiti-queue-keeper 契约，P3 去 fork 成果）",
    file: "./ChatInput.tsx",
    must: [
      /name="queuePanel"/,                                           // 扩展接管队列 UI
      /extOwnsQueuePanel/,                                           // 无接管时原生兜底 banner
      /function BottomModeBar/,                                      // 三态折叠条（full/queueHidden/minimal）
      /t\("chat\.steerFromQueueHint"\)/,                             // 我方排队/插队语义键
      /canQueueStreamingMessage = hasInputText \|\| attachedImages\.length > 0/, // 2026-09 采纳上游语义：图片可随消息排队（禁图分支已移除）
    ],
  },
  {
    name: "重试不卡死：emergency 复用会话必须带 streamingBehavior（曾致重试永远冻结）",
    file: "../app/api/emergency/route.ts",
    must: [
      /streamingBehavior: "steer"/,
    ],
  },
  {
    name: "publicApi 声明式跨源豁免（扩展资产跨域加载，aiti-devtools 注入页依赖）",
    file: "../lib/ext/registry.ts",
    must: [
      /export function isPublicApiPath/,
    ],
  },
];

for (const g of GUARDS) {
  test(`[fork-guard] ${g.name}`, async () => {
    const src = await read(g.file);
    for (const re of g.must ?? []) {
      assert.match(src, re, `\n  ${g.file} 缺少 fork 特性标记: ${re}\n  → 上游合并把特性丢了；按 merge-notes「冲突以我方为准」恢复我方实现，勿改本测试迁就。\n`);
    }
    for (const re of g.not ?? []) {
      assert.doesNotMatch(src, re, `\n  ${g.file} 出现了被禁止的模式: ${re}\n  → 通常是上游实现替代了我方方案（如明文路径 URL），请恢复我方版本。\n`);
    }
  });
}
