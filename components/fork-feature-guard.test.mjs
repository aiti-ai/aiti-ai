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
      /loadSessions\(false, true\)/, // P1-B：刷新按钮分支化（接管态通知扩展），绕缓存语义保留
      /sessionRefreshDone/, // 绿闪反馈仍在
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
      /onEditFromHere=\{sessionBusy \|\| isNew \? undefined : handleEditFromHereMark\}/,  // 运行中隐藏（2026-09-08 拍板：发送时回退与在跑轮次冲突）
      /name="chatOverlay"/,                                          // 消息导航条/锚点横幅插槽
    ],
  },
  {
    name: "ChatWindow：会话请求卡接缝 + 用量徽标透传 + 队列恢复对话框 + 队列导出（auto-merge 高危区）",
    file: "./ChatWindow.tsx",
    must: [
      /<SessionRequestCardHost/,                                     // 会话请求卡接缝（guard 2026-09-16：卡 UI 外迁扩展，接缝+兜底必须在核）
      /backendUsage: isEmptyNew \? null : backendUsage/,             // 用量徽标透传 chatOverlay（展示归 aiti-provider-usage）
      /<QueueRecoveryDialog/,                                        // 队列恢复/导入
      /onExportQueue\?\./,                                           // 队列导出到 AppShell
      /scrollToBottom/,                                              // 我方滚动钉底（与上游 scrollToMessage 并存）
      /scrollToMessage/,                                             // 上游搜索跳转（合并并集样本）
      /newSessionBackendOptions/,                                    // 多后端管理入口插槽（Backend 下拉内扩展条目）
      /sessionBackend/,                                              // 多后端会话状态
    ],
  },
  {
    name: "会话请求卡接缝：sessionRequestCard 插槽路由 + core 兜底卡（卡 UI 外迁扩展后 capability 不得裸奔）",
    file: "./SessionRequestSlot.tsx",
    must: [
      /name="sessionRequestCard"/,                                   // 接缝插槽本体（ExtSlot only 单 item 渲染）
      /function pickSessionRequestCard/,                             // kind/backend/priority 路由
      /function MinimalRequestCard/,                                 // 扩展缺席时的兜底卡（fail-open 到 core）
      /testId="session-request-fallback-card"/,                      // 兜底卡 DOM 契约（CardShell data-testid={testId}）
    ],
  },
  {
    name: "useAgentSession：权限/过期/扩展对话框关闭三态事件 + basePath 包装（并集样本）",
    file: "../hooks/useAgentSession.ts",
    must: [
      /case "permission_request":/,
      /case "permission_expired":/,
      /const sessionRequest = useMemo/,                              // 请求卡统一视图（去核化接缝）
      /const respondToSessionRequest = useCallback/,                 // 统一作答分派（扩展卡+兜底卡共用）
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
    name: "「新会话」静默后台 fork（composer 按钮：fork_branch 当前 leaf + 后台 prompt，不切换会话）",
    file: "./ChatInput.tsx",
    must: [
      /onForkNew/,                                     // 按钮契约（仅输入框有内容时露出）
      /fork: hasContent/,                              // 小屏矩阵：运行/空闲都按「有内容」露出
      /function ForkNewIcon/,                          // 按钮图标（大屏/小屏共用）
      /const handleForkNew = useCallback/,             // 失败保留输入 + 成功后清空
    ],
  },
  {
    name: "「新会话」fork 位于发送/插队/排队按钮左侧（大小屏同一契约）",
    file: "./ChatInput.tsx",
    must: [
      /\{mobileMatrix\.fork && onForkNew && \(/,       // 小屏：send/stop/steer/clock 之前
      /\{hasContent && onForkNew && \([\s\S]*?<StreamingActionButton[\s\S]*?label=\{t\("chat\.forkNew"\)\}/,  // 大屏：steer/followUp + send 之前
    ],
  },
  {
    name: "「新会话」fork 不替换/不关闭源会话（fork_branch 不传 entryId = 当前 leaf；运行中放行）",
    file: "../lib/rpc-manager.ts",
    must: [
      /case "fork_branch": \{[\s\S]*?fork_branch 只读源文件 \+ 写出新分支，源会话继续跑/,   // 有意决策注释在（丢过 = 有人恢复运行中拒绝）
      /command\.entryId[\s\S]*?: sessionManager\.getLeafId\(\)/,                          // 未传 entryId → 当前 leaf
      /sourceManager\.getSessionId\(\)/,                                                    // 创建者实例 id（不重读文件）
      /flag: "wx"/,                                                                          // 分支文件立即落盘兑底
      /notifySessionCreated\(newSessionId, sessionManager\.getCwd\(\), "fork_branch"\)/,  // 侧栏草稿行即时可见（统一 helper；helper 内部 = publishPageEventToBus 宽发布走总线，直调到不了 session-manager）
    ],
    not: [
      /Cannot fork while the session is running/,      // 运行中拒绝回归即红灯
    ],
  },
  {
    name: "「新会话」fork 后台启动不切走当前会话（busy 等到受理；成功首个 toast，失败错误 toast）",
    file: "../hooks/useAgentSession.ts",
    must: [
      /type: "fork_branch"/,
      /await sendAgentCommand\(newSessionId,[\s\S]*?type: "prompt"/, // 等待受理（busy 覆盖到创建成功）
      /新会话已建但后台启动失败/,                        // 启动失败 = 错误 toast + 保留输入
      /已在后台 fork 新会话并开始运行/,                    // 成功后的单个 toast
    ],
  },
  {
    name: "ChatWindow：新会话 fork 按钮接线（新草稿会话/外部后端不接——本地 pi 会话专属）",
    file: "./ChatWindow.tsx",
    must: [
      /onForkNew=\{isNew \|\| sessionCapabilities \? undefined : handleForkNew\}/,
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
