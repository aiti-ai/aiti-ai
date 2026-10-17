// ─────────────────────────────────────────────────────────────────────────────
// Fork feature guard (fork-feature-guard)
//
// Background: during the 2026-08/09 upstream merges there were repeated incidents of
// "auto-merge silently dropping our features" or "conflict resolution picking the wrong
// side" (the green-flash refresh button wrongly judged lost, the three-source running-
// state aggregation clobbered by upstream's single source, duplicate i18n keys, media
// plaintext-path regression risk, lost slot contracts, fork-gates disconnects, the steer
// retry freeze regression, etc. — see docs/pi-web-merge-notes.md + the §3.9 watch list).
//
// This file is a **source-marker checklist**: each entry = the lesson of one incident.
// If `bun run test` fails here after an upstream merge, the corresponding fork feature
// was dropped — restore our implementation per the merge-notes principle (conflicts
// resolve in our favor); do not weaken the test to fit the merge result.
//
// Maintenance rules:
//   • When a feature is **intentionally refactored**, update its marker in the same
//     commit (note "guard" in the commit message).
//   • When adding a fork feature, add a line to GUARDS — anything lost once must live here.
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

const GUARDS = [
  {
    name: "Session sidebar: tree view + green-flash manual refresh button + inline meta slot (the green-flash button was once wrongly judged lost)",
    file: "./SessionSidebar.tsx",
    must: [
      /buildSessionTree\(/,                                          // our tree sidebar（合并：实现随上游提取进 lib/session-tree.ts，import 使用——不回退 families 设计）
      /loadSessions\(false, true\)/, // P1-B: refresh button branched (notifies extensions in takeover state); bypass-cache semantics kept
      /done=\{manualRefreshDone\}/, // green-flash feedback still present（融合：走上游 ToolbarIconButton done 模式）
      /<RefreshIcon size=\{12\} \/>/,                                  // green-flash on refresh success（is-done 样式，app/sidebar.css 1120）
      // sessionRowMeta 槽随行渲染迁入 SessionTree.tsx，由 SessionSidebar.running-time.test 第三断言守护（不在此重复）
      /relation\?\.kind === "subagent"/,                             // subagent/branch relation icon
      // TODO(行级移植收尾)：client-side draft 行（isDraft）尚未随行渲染迁入 SessionTree
      // （草稿行 = 刚新建未落盘会话的临时行）——恢复后补回此 marker。
    ],
  },
  {
    name: "Running-state three-source aggregation: RPC + backend handle + TUI bridge (upstream's single source would clobber multi-backend running state)",
    file: "../app/api/agent/running/route.ts",
    must: [
      /getRunningRpcSessionIds\(\), \.\.\.getRunningHandleIds\(\), \.\.\.getBridgeRunningIds\(\)/,
      /sessionListVersion: getSessionListVersion\(\)/,               // upstream #625 cross-window cache version coexisting
    ],
  },
  {
    name: "Session list route: running-state aggregation + sessionListVersion, both sides coexisting",
    file: "../app/api/sessions/route.ts",
    must: [
      /\[\.\.\.getRunningRpcSessionIds\(\), \.\.\.getRunningHandleIds\(\), \.\.\.getBridgeRunningIds\(\)\]/,
      /sessionListVersion,/,
    ],
  },
  {
    name: "Session deletion: placeholder-file anchor deletion (extId) coexisting with upstream's missing-parent tolerance (#659)",
    file: "../app/api/sessions/[id]/route.ts",
    must: [
      /if \(deleteHeader\?\.extId\) \{/,                             // our placeholder: delete only the anchor, never touch the external original data
      /removePlaceholderByUuid\(id\)/,
    ],
  },
  {
    name: "Session deletion: upstream's missing-parent tolerance survives the shared delete engine (#659)",
    file: "../lib/session-delete.ts",
    must: [
      /treat it as absent/,                                          // tolerate an already-deleted parent file
    ],
  },
  {
    name: "FileViewer ticketing: media streaming must never fall back to plaintext-path URLs (the getFileApiUrl pattern is forbidden from regressing)",
    file: "./FileViewer.tsx",
    must: [
      /useTicketUrl\(filePath, "read"/,                              // image/video/document src goes through short-lived tickets
      /buildTicketUrl\(filePath, "watch"\)/,                         // the watch channel goes through a ticket (EventSource)
      /fetchFileGet\(filePath, "meta"/,                              // fetch-style request paths carry it in the body
      /getExtUiItems\("fileViewer"\)/,                               // file-editor extension takeover trampoline
      /isVideoPath\(filePath\)/,                                     // upstream #655 video preview absorbed
    ],
    not: [
      /getFileApiUrl/,                                               // plaintext-path URL building (any security regression fails here)
    ],
  },
  {
    name: "Extension slot contracts: model takeover / set-model / file viewer (P4 de-fork + wizard wiring)",
    file: "../lib/ext/types.ts",
    must: [
      /"fileViewer"/,
      /"modelSelector"/,                                             // the model-wizard extension takes over the chat model button
      /"settingsModels"/,                                            // settings panel models tab takeover
      /"sessionRowMeta"/,
      /interface ModelSelectorSlotProps/,                            // takeover components get the same contract (the fallback quick switcher must not be lost)
    ],
  },
  {
    name: "ChatInput: model button takeover wiring (native dropdown fallback when unregistered)",
    file: "./ChatInput.tsx",
    must: [
      /useExtSlotItems\("modelSelector"\)\.find\(hasExtRender\)/,
    ],
  },
  {
    name: "SettingsPanel: settingsModels takeover wiring",
    file: "./SettingsPanel.tsx",
    must: [
      /useExtSlotItems\("settingsModels"\)\.find\(hasExtRender\)/,
      /slot="settingsModels"/,
    ],
  },
  {
    name: "AppShell: project identity pre-advance + extension topbar/toolbar takeover error boundary + stats refresher registration",
    file: "./AppShell.tsx",
    must: [
      /activeProjectKeyRef\.current = workspaceKeyOf\(session\)/,    // precedes the cwd-sync effect (first selection must not fail)
      /slot=\{toolbarItem \? "toolbar" : "sessionTopbar"\}/,         // topbar/toolbar extension takeover
      /onSessionStatsRefresherRegister/,
    ],
  },
  {
    name: "\"Edit from here\" fork-gates pre-gate (the git-history extension's three revert options entry; once broken by a merge)",
    file: "./ChatWindow.tsx",
    must: [
      /import \{ runSessionForkGates \} from "@\/lib\/ext\/fork-gates"/,
      /await runSessionForkGates\(\{ sessionId/,                     // ask about reverting before marking; cancel aborts
      /const handleEditFromHereMark = useCallback\(async /,          // the gate is async — signature evolution must update this test
      /if \(!hasPending && chatInputRef\?\.current\?\.hasInput\?\.\(\)\) return;[\s\S]*?await runSessionForkGates\(\{ sessionId/,
                                                                      // the quiet pre-check precedes the gate (popping the gate first would waste an answer; 2026-09 review)
    ],
  },
  {
    name: "Fork does not trigger the AI-change handling gate (9963a46 deliberate decision: a new session appends and never touches the original; no rollback needed)",
    file: "../hooks/useAgentSession.ts",
    not: [
      /runSessionForkGates\(/,                                       // the gate only applies to "edit from here" (ChatWindow); re-gating fork = regressing to the old semantics, the red light forces a conscious decision
    ],
  },
  {
    name: "Extension render error boundary: a takeover component crash must not take down the page (ExtItemBoundary must wrap every takeover point)",
    file: "./ChatWindow.tsx",
    must: [
      /data-entry-id=\{entryIds\[idx\]\}/,                           // DOM contract for the message-smart/anchor extensions
      /onEditFromHere=\{sessionBusy \|\| isNew \|\| !\(sessionCap\("navigateTree"\) \|\| sessionCap\("fork"\)\) \? undefined : handleEditFromHereMark\}/,  // hidden while running (2026-09-08 decision: rewinding on send conflicts with the running turn) + capability gating (2026-09-18: external backends need navigateTree or fork; zcode uses session/fork semantics, other external backends hide the button = unsupported)
      /name="chatOverlay"/,                                          // message nav bar / anchor banner slot
    ],
  },
  {
    name: "ChatWindow: session request card seam + usage badge pass-through + queue recovery dialog + queue export (high-risk auto-merge zone)",
    file: "./ChatWindow.tsx",
    must: [
      /<SessionRequestCardHost/,                                     // session request card seam (guard 2026-09-16: card UI moved to an extension; the seam + fallback must stay in core)
      /backendUsage: isEmptyNew \? null : backendUsage/,             // usage badge passed through to chatOverlay (display owned by the provider-usage extension)
      /name="recoveryDialog"/,                                       // queue recovery dialog slot (UI owned by the aiti-recovery extension; core keeps the render condition)
      /onExportQueue\?\./,                                           // queue export to AppShell
      /scrollToBottom/,                                              // our scroll pin-to-bottom (coexists with upstream scrollToMessage)
      /scrollToMessage/,                                             // upstream search jump (union sample for merges)
      /newSessionBackendOptions/,                                    // multi-backend management entry slot (extension items inside the Backend dropdown)
      /sessionBackend/,                                              // multi-backend session state
    ],
  },
  {
    name: "Session request card seam: sessionRequestCard slot routing + core fallback card (after the card UI moved to an extension, capabilities must not render bare)",
    file: "./SessionRequestSlot.tsx",
    must: [
      /name="sessionRequestCard"/,                                   // the seam slot itself (ExtSlot renders the single item only)
      /function pickSessionRequestCard/,                             // kind/backend/priority routing
      /function MinimalRequestCard/,                                 // fallback card when the extension is absent (fail-open to core)
      /testId="session-request-fallback-card"/,                      // fallback card DOM contract (CardShell data-testid={testId})
    ],
  },
  {
    name: "useAgentSession: permission/expired/extension-dialog-closed tri-state events + basePath wrapping (union sample)",
    file: "../hooks/useAgentSession.ts",
    must: [
      /case "permission_request":/,
      /case "permission_expired":/,
      /const sessionRequest = useMemo/,                              // unified request-card view (de-cored seam)
      /const respondToSessionRequest = useCallback/,                 // unified answer dispatch (shared by extension + fallback cards)
      /case "extension_ui_closed":/,                                 // upstream #612 dismissible dialog close event
      /apiUrl\(`\/api\/sessions\/\$\{encodeURIComponent\(sid\)\}\/context/, // basePath wrapping for subpath deployments
    ],
  },
  {
    name: "Queue panel slot + tri-state bottom bar (the queue-keeper extension contract; a P3 de-fork outcome)",
    file: "./ChatInput.tsx",
    must: [
      /name="queuePanel"/,                                           // extension takes over the queue UI
      /extOwnsQueuePanel/,                                           // native fallback banner without takeover
      /function BottomModeBar/,                                      // tri-state collapse bar (full/queueHidden/minimal)
      /t\("chat\.steerFromQueueHint"\)/,                             // our queue/steer semantic key
      /canQueueStreamingMessage = hasInputText \|\| attachedImages\.length > 0/, // 2026-09 adopted upstream semantics: images may queue with a message (the images-forbidden branch was removed)
    ],
  },
  {
    name: "\"New session\" silent background fork (composer button: fork_branch the current leaf + background prompt, no session switch)",
    file: "./ChatInput.tsx",
    must: [
      /onForkNew/,                                     // button contract (shown only when the composer has content)
      /fork: hasContent/,                              // mobile matrix: shown on "has content" whether running or idle
      /function ForkNewIcon/,                          // button icon (shared by desktop/mobile)
      /const handleForkNew = useCallback/,             // keep input on failure + clear on success
    ],
  },
  {
    name: "\"New session\" fork sits left of the send/steer/queue buttons (one contract for desktop and mobile)",
    file: "./ChatInput.tsx",
    must: [
      /\{mobileMatrix\.fork && onForkNew && \(/,       // mobile: before send/stop/steer/clock
      /\{hasContent && onForkNew && \([\s\S]*?<StreamingActionButton[\s\S]*?label=\{t\("chat\.forkNew"\)\}/,  // desktop: before steer/followUp + send
    ],
  },
  {
    name: "\"New session\" fork never replaces/closes the source session (fork_branch without entryId = current leaf; allowed while running)",
    file: "../lib/rpc-manager.ts",
    must: [
      /case "fork_branch": \{[\s\S]*?fork_branch only reads the source file \+ writes the new branch, and the source/,   // the deliberate-decision comment is present (losing it = someone restored the running rejection)
      /command\.entryId[\s\S]*?: sessionManager\.getLeafId\(\)/,                          // no entryId passed → current leaf
      /sourceManager\.getSessionId\(\)/,                                                    // creator instance id (no file re-read)
      /flag: "wx"/,                                                                          // branch file persisted to disk immediately as a safety net
      /notifySessionCreated\(newSessionId, sessionManager\.getCwd\(\), "fork_branch"\)/,  // sidebar draft row visible immediately (unified helper; inside the helper = publishPageEventToBus wide-publishes through the event bus, a direct call would never reach session-manager)
    ],
    not: [
      /Cannot fork while the session is running/,      // the running rejection regressing turns the light red
    ],
  },
  {
    name: "\"New session\" fork starts in the background without switching away (busy waits for acceptance; single success toast, error toast on failure)",
    file: "../hooks/useAgentSession.ts",
    must: [
      /type: "fork_branch"/,
      /await sendAgentCommand\(newSessionId,[\s\S]*?type: "prompt"/, // wait for acceptance (busy covers through successful creation)
      /t\("session\.forkStartFailed", \{ error: msg \}\)/,   // startup failure = error toast + keep input
      /t\("session\.forkBackgroundOk"\)/,                    // the single toast on success
    ],
  },
  {
    name: "ChatWindow: new-session fork button wiring (fresh draft sessions/external backends don't wire it — local pi sessions only)",
    file: "./ChatWindow.tsx",
    must: [
      /onForkNew=\{isNew \|\| sessionCapabilities \? undefined : handleForkNew\}/,
    ],
  },
  {
    name: "Steer 按能力门控：无 steer 注入面的后端（qoder/codex/cursor/…）不画「插队」，点了静默变排队的假承诺不得回归",
    file: "./ChatWindow.tsx",
    must: [
      /onSteer=\{agentRunning && sessionCap\("steer"\) \? handleSteer : undefined\}/,
      /onQueueSteerSend=\{sessionCap\("steer"\) \? handleSteer : undefined\}/,
    ],
  },
  {
    name: "队列面板 steer 行只读由能力派生（不得退回 sessionId 前缀猜测——那会把 pi 协议后端可重注入的 steering 队列也锁成只读）",
    file: "./ChatInput.tsx",
    must: [
      /steerReadonly: computeQueueSteerReadonly\(sessionCapabilities\)/,
      /queueOnlyBackend \? t\("chat\.queueOnlyPlaceholder"\) : t\("chat\.steerPlaceholder"\)/,
    ],
    not: [
      /steerReadonly: \/\^\(\?!new:\)/,                              // 前缀正则旧实现
    ],
  },
  {
    name: "队列面板 steerSend 只在有 steer 面时下发（存在性=能力；无条件包一层会让扩展删掉条目却什么都没发）",
    file: "./ChatInput.tsx",
    must: [
      /steerSend: onQueueSteerSend \?/,
    ],
    not: [
      /steerSend: \(text, images\) => onQueueSteerSend\?\./,         // 旧的空操作包装
    ],
  },
  {
    name: "Retry never freezes: emergency session reuse must carry streamingBehavior (once froze retries forever)",
    file: "../app/api/emergency/route.ts",
    must: [
      /streamingBehavior: "steer"/,
    ],
  },
  {
    name: "publicApi declarative cross-origin exemption (extension assets loaded cross-origin; the devtools injection page depends on it)",
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
      assert.match(src, re, `\n  ${g.file} is missing a fork feature marker: ${re}\n  → an upstream merge dropped the feature; restore our implementation per the merge-notes principle ("conflicts resolve in our favor"), do not weaken this test to fit the merge.\n`);
    }
    for (const re of g.not ?? []) {
      assert.doesNotMatch(src, re, `\n  ${g.file} contains a forbidden pattern: ${re}\n  → usually an upstream implementation replaced ours (e.g. plaintext-path URLs); restore our version.\n`);
    }
  });
}
