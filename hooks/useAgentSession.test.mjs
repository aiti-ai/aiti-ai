import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

test("keeps the session event stream open through the idle grace window", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => void checkServerIdle\(\), EVENT_STREAM_IDLE_GRACE_MS\)/);
  // The idle probe may go through apiUrl() (basePath support) or be a bare fetch.
  assert.match(graceSource, /fetch\((?:apiUrl\()?`?\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`?\)?\)/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /onAgentEnd\?\.\(\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{[\s\S]*?waitForPromptSettlement/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
});

test("a rejected submission preserves a different run reported by the server", () => {
  const reconcileSource = source.slice(
    source.indexOf("  const reconcileAgentState = useCallback"),
    source.indexOf("  // Recovery net for missed SSE events"),
  );

  assert.match(reconcileSource, /sessionIdRef\.current !== sid/);
  assert.match(reconcileSource, /if \(busy\) \{[\s\S]*?sdkAgentActiveRef\.current = Boolean\(state\.isStreaming\)/);
  assert.match(reconcileSource, /rpcPromptPendingRef\.current = Boolean\(state\.isPromptRunning\)/);
  assert.match(reconcileSource, /if \(!agentRunningRef\.current\) return;[\s\S]*?finishPromptWithoutStream/);
});

test("opening System or Tools lazily starts a dormant session without sending a prompt", () => {
  const loadSystemInfoSource = source.slice(
    source.indexOf("  const loadSystemInfo = useCallback"),
    source.indexOf("  const loadSlashCommands = useCallback"),
  );
  const loaderEffectSource = source.slice(
    source.indexOf("  useEffect(() => {\n    onSystemInfoLoaderChange"),
    source.indexOf("  useEffect(() => {\n    if (!onBranchDataChange) return;"),
  );

  assert.match(loadSystemInfoSource, /sessionIdRef\.current \?\? await ensureNewSession\(\)/);
  assert.doesNotMatch(loadSystemInfoSource, /promoteNewSession\(\)/);
  assert.match(loadSystemInfoSource, /sendAgentCommand<AgentStateResponse>\(sid, \{ type: "get_state" \}\)/);
  assert.match(loadSystemInfoSource, /loadTools\(sid\)/);
  assert.doesNotMatch(loadSystemInfoSource, /type: "prompt"/);
  assert.match(loadSystemInfoSource, /setSystemPrompt\(state\.systemPrompt \?\? ""\)/);
  assert.match(loaderEffectSource, /onSystemInfoLoaderChange\?\.\(loadSystemInfo\)/);
  assert.match(loaderEffectSource, /onSystemInfoLoaderChange\?\.\(null\)/);
  assert.match(appShellSource, /onClick=\{\(\) => handleSystemInfoToggle\("system", mobile\)\}/);
  assert.match(appShellSource, /onClick=\{\(\) => handleSystemInfoToggle\("tools", mobile\)\}/);
  assert.match(appShellSource, /systemInfoLoaderRef\.current/);
  assert.doesNotMatch(appShellSource, /systemPrompt !== null \|\| systemInfoLoading/);
  assert.match(appShellSource, /const loadId = \+\+systemInfoLoadIdRef\.current/);
  assert.match(appShellSource, /systemInfoLoadIdRef\.current === loadId/);
  assert.match(
    appShellSource,
    /handleSystemInfoLoaderChange[\s\S]*?systemInfoLoadIdRef\.current \+= 1;[\s\S]*?setSystemInfoLoading\(false\)/,
  );
});

test("new-session promotion rekeys drafts before publishing the real session", () => {
  const promoteSource = source.slice(
    source.indexOf("  const promoteNewSession = useCallback"),
    source.indexOf("  const ensureNewSession = useCallback"),
  );

  assert.match(promoteSource, /draftKeyAliasesRef\.current\.set\(provisionalDraftKey, sid\)/);
  assert.match(promoteSource, /input\.rekeyDraft\(provisionalDraftKey, sid\)/);
  assert.ok(
    promoteSource.indexOf("input.rekeyDraft(provisionalDraftKey, sid)")
      < promoteSource.indexOf("onSessionCreated?.({"),
  );
  assert.match(promoteSource, /}, provisionalDraftKey\)/);
  // 合并后 ChatWindow 把该表达式抽为 const draftKey 再传入
  assert.match(chatWindowSource, /const draftKey = session\?\.id \?\? newSessionDraftKey \?\? undefined;/);
  assert.match(chatWindowSource, /draftKey=\{draftKey\}/);
});

test("fresh sessions use the preference while persisted and live sessions restore their selection", () => {
  const preferenceSource = source.slice(
    source.indexOf("  const setToolPresetState"),
    source.indexOf("  const scrollToBottom"),
  );
  const loadToolsSource = source.slice(
    source.indexOf("  const loadTools = useCallback"),
    source.indexOf("  const promoteNewSession"),
  );
  const changeSource = source.slice(
    source.indexOf("  const handleToolPresetChange = useCallback"),
    source.indexOf("  const scrollUserMsgToTop"),
  );

  assert.match(
    preferenceSource,
    /const existingSessionId = session\?\.id;[\s\S]*?useLayoutEffect\(\(\) => \{\s*if \(!existingSessionId && \(!isNew \|\| sessionIdRef\.current\)\) return;\s*setToolPresetState\(getPreferredToolPreset\(\)\)/,
  );
  assert.match(source, /if \(agentState\?\.running\) \{\s*loadTools\(session\.id\)/);
  assert.match(source, /d\.toolNames !== undefined \? getPresetFromToolNames\(d\.toolNames\) : "default"/);
  assert.match(changeSource, /setPreferredToolPreset\(preset\)/);
  assert.match(changeSource, /\(sid, \{ type: "set_tools", toolNames \}\)/);
  assert.match(changeSource, /sessionIdRef\.current = activeSessionId/);
  assert.doesNotMatch(loadToolsSource, /setPreferredToolPreset/);
});

test("existing-session prompts rely on the persisted tool selection", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  const existingSessionPrompt = sendSource.slice(sendSource.indexOf("} else if (session)"));

  assert.match(existingSessionPrompt, /type: "prompt",\s*message,/);
  assert.doesNotMatch(existingSessionPrompt, /toolNames:/);
  assert.doesNotMatch(sendSource, /restoreSubmission, toolPreset\]\);/);
});

test("submission recovery updates live refs before a possible session rekey", () => {
  const restoreMethod = chatInputSource.slice(
    chatInputSource.indexOf("    restoreSubmission(text:"),
    chatInputSource.indexOf("    insertText(text:"),
  );

  assert.ok(
    restoreMethod.indexOf("valueRef.current = restoredDraft.value")
      < restoreMethod.indexOf("setValue((current) =>"),
  );
  assert.ok(
    restoreMethod.indexOf("attachedImagesRef.current = restoredImages")
      < restoreMethod.indexOf("setAttachedImages((current) =>"),
  );
});

test("stale fresh-session completion cannot replace the active composer", () => {
  const cwdChangeSource = appShellSource.slice(
    appShellSource.indexOf("  const handleCwdChange = useCallback"),
    appShellSource.indexOf("  const handleSelectSession = useCallback"),
  );
  const newSessionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleNewSession = useCallback"),
    appShellSource.indexOf("  // Global keyboard shortcuts"),
  );
  const createdSource = appShellSource.slice(
    appShellSource.indexOf("  const handleSessionCreated = useCallback"),
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
  );

  assert.match(newSessionSource, /const draftKey = `new:\$\{sessionId\}:\$\{cwd\}`/);
  assert.match(newSessionSource, /activeNewSessionDraftKeyRef\.current = draftKey/);
  assert.match(createdSource, /activeNewSessionDraftKeyRef\.current !== sourceDraftKey/);
  assert.match(cwdChangeSource, /const currentFreshCwd = newSessionCwd \?\? activeCwd/);
  assert.match(
    cwdChangeSource,
    /currentProject === newProject\s*&& \(selectedSession !== null \|\| currentFreshCwd === cwd\)/,
  );
  assert.match(cwdChangeSource, /if \(currentProject !== newProject\) \{[\s\S]*?setFileTabs\(\[\]\)/);
  assert.match(
    appShellSource,
    /useLayoutEffect\(\(\) => \{\s*activeNewSessionDraftKeyRef\.current = newSessionDraftKey;/,
  );
  assert.ok(
    createdSource.indexOf("activeNewSessionDraftKeyRef.current !== sourceDraftKey")
      < createdSource.indexOf("setSelectedSession(session)"),
  );
});

test("abandoned fresh-session drafts are cleared and cannot be recreated by late rejection", () => {
  const restoreSource = source.slice(
    source.indexOf("  const restoreSubmission = useCallback"),
    source.indexOf("  const sessionStats = useMemo"),
  );
  const mountSource = source.slice(
    source.indexOf("  // Load session on mount"),
    source.indexOf("  useEffect(() => {\n    onSystemPromptChange"),
  );

  assert.match(restoreSource, /!sessionHookMountedRef\.current[\s\S]*?!newSessionPromotedRef\.current/);
  assert.match(mountSource, /const abandonedDraftKey = isNew \? newSessionDraftKey : null/);
  assert.match(mountSource, /clearDraft\(abandonedDraftKey\)/);
});

test("streaming submissions cannot be stranded in an idle direct queue", () => {
  const queueSource = source.slice(
    source.indexOf("  // Let AgentSession.prompt decide atomically"),
    source.indexOf("  const handleAbortCompaction"),
  );

  assert.match(queueSource, /type: "prompt"/);
  assert.match(queueSource, /streamingBehavior: behavior/);
  assert.match(queueSource, /if \(isPromptRejectedError\(e\)\) restore\(\)/);
  assert.doesNotMatch(queueSource, /type: "steer"/);
  assert.doesNotMatch(queueSource, /type: "follow_up"/);
});

test("built-in clone switches to the independent child session", () => {
  const builtinSource = source.slice(
    source.indexOf("  const handleBuiltinSlashCommand"),
    source.indexOf("  // Let AgentSession.prompt decide atomically"),
  );

  assert.match(builtinSource, /case "clone"/);
  assert.match(builtinSource, /type: "clone",\s+leafId: activeLeafId/);
  assert.match(builtinSource, /agentRunningRef\.current \|\| bashRunningRef\.current/);
  assert.match(builtinSource, /onSessionForked\?\.\(result\.newSessionId\)/);
});

test("post-accept prompt errors do not duplicate the user submission", () => {
  const promptErrorSource = source.slice(
    source.indexOf('case "prompt_error"'),
    source.indexOf('case "extension_error"'),
  );

  assert.match(promptErrorSource, /addNotice/);
  assert.doesNotMatch(promptErrorSource, /restoreSubmission/);
});

test("delegates event stream readiness and hides an empty agent phase", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  // SSE reuse now lives in AgentEventConnection (lib/agent-event-connection.ts,
  // covered by its own tests); the hook delegates via ensureEventsConnected.
  assert.match(ensureSource, /ensureConnected\(sid\)/);
  assert.match(chatWindowSource, /agentRunning && !hasStreamingContent && agentPhase/);
  assert.match(chatWindowSource, /return null;/);
});

test("uses one absolute agent-readiness deadline instead of a five-second transport deadline", () => {
  assert.match(source, /EVENT_STREAM_READY_TIMEOUT_MS = 60_000/);
  assert.doesNotMatch(source, /EVENT_STREAM_OPEN_TIMEOUT_MS/);
});

test("uses server pagination state instead of guessing from rendered rows", () => {
  const loadContextSource = source.slice(
    source.indexOf("const loadContext = useCallback"),
    source.indexOf("const loadTools = useCallback"),
  );
  assert.match(source, /const \[hasEarlierMessages, setHasEarlierMessages\] = useState\(false\)/);
  assert.match(source, /setHasEarlierMessages\(d\.context\.hasMore\)/);
  assert.match(source, /setHistoryCursor\(d\.context\.oldestEntryId\)/);
  assert.match(loadContextSource, /setData\(\(prev\) => \{[\s\S]*messages: \[\.\.\.d\.context\.messages, \.\.\.prev\.context\.messages\]/);
  assert.match(chatWindowSource, /const oldestId = historyCursor/);
  assert.doesNotMatch(chatWindowSource, /const oldestId = entryIds\[0\]/);
  assert.match(chatWindowSource, /if \(!hasEarlierMessages\) return/);
  assert.match(chatWindowSource, /const hasMore = startIndex > 0 \|\| hasEarlierMessages/);
  assert.doesNotMatch(chatWindowSource, /rendered\.length >= visibleCount/);
});

test("connects a selected session when another browser reports it running", () => {
  assert.match(source, /sessionRunning\?: boolean/);
  assert.match(
    source,
    /if \(!session\?\.id \|\| !sessionRunning\) return;[\s\S]*?maintainEventsConnected\(session\.id\)/,
  );
  assert.match(source, /maintainEventsConnected\(session\.id\)/);
  assert.doesNotMatch(source, /void connectEvents\(/);
  assert.match(chatWindowSource, /sessionRunning\?: boolean/);
  assert.match(chatWindowSource, /session, sessionRunning, newSessionCwd/);
  assert.match(appShellSource, /runningSessionIds\.has\(selectedSession\.id\)/);
  assert.match(appShellSource, /onRunningSessionIdsChange=\{handleRunningSessionIdsChange\}/);
});

test("keeps one reducer-owned assistant partial and consumes Pi JSON deltas", () => {
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "agent_start"'),
  );
  const streamSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const messageEndSource = source.slice(
    source.indexOf('case "message_end"'),
    source.indexOf('case "tool_execution_start"'),
  );

  assert.match(source, /streamReducer,[\s\S]*type ClientAssistantMessageEvent/);
  assert.doesNotMatch(source, /streamingMessageRef/);
  assert.match(connectedSource, /dispatchStream\(\{ type: "end" \}\)/);
  assert.match(connectedSource, /event\.isStreaming === true/);
  assert.match(connectedSource, /agentRunningRef\.current = true/);
  assert.match(streamSource, /msg\?\.role === "assistant"[\s\S]*dispatchStream\(\{ type: "snapshot", message: msg \}\)/);
  assert.match(streamSource, /event\.assistantMessageEvent as ClientAssistantMessageEvent/);
  assert.match(streamSource, /enqueueDelta\(delta\)/);
  assert.match(source, /dispatch\(\{ type: "delta-batch", events: batch \}\)/);
  // setAgentPhase 已移入 flushPendingDeltas（每帧一次）：有内容事件（非纯 toolcall 元数据）时清等待模型态
  assert.match(source, /all\.some\(\(d\) => d\.type !== "toolcall_start" && d\.type !== "toolcall_delta"\)[\s\S]*?setAgentPhase\(null\)/);
  assert.doesNotMatch(streamSource, /case "message_delta"/);
  assert.match(messageEndSource, /const completed = event\.message as AgentMessage/);
  assert.match(messageEndSource, /normalizeToolCalls\(completed\)/);
  assert.match(messageEndSource, /dispatchStream\(\{ type: "end" \}\)/);
  assert.doesNotMatch(messageEndSource, /streamState\.streamingMessage/);
});

test("shows the latest streamed tool execution progress in the running phase", () => {
  const updateSource = source.slice(
    source.indexOf('case "tool_execution_update"'),
    source.indexOf('case "tool_execution_end"'),
  );

  assert.match(updateSource, /getToolExecutionProgress\(event\.partialResult\)/);
  assert.match(updateSource, /tools: \[\.\.\.tools\.filter\([\s\S]*?, updated\]/);
  assert.match(chatWindowSource, /if \(latest\?\.progress\)/);
  assert.match(chatWindowSource, /chat\.runningNamedTool[\s\S]*latest\.progress/);
});

test("plays the enabled sound once for each extension dialog", () => {
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef = useRef<string \| null>\(null\)/);
  assert.match(
    chatWindowSource,
    /soundedExtensionDialogIdRef\.current === extensionDialog\.id/,
  );
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef\.current = extensionDialog\.id/);
  assert.match(chatWindowSource, /playDoneSoundRef\.current\(\)/);
});

test("suppresses sounds and browser attention for the active subagent session", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(chatWindowSource, /completionNotificationsEnabled = session\?\.relation\?\.kind !== "subagent"/);
  assert.match(chatWindowSource, /completionNotificationsEnabled && soundEnabledRef\.current/);
  assert.match(chatWindowSource, /!completionNotificationsEnabled[\s\S]*?!extensionDialog/);
  assert.match(completionSource, /selectedSession\?\.relation\?\.kind === "subagent"\) return/);
  assert.match(attentionSource, /selectedSession\?\.relation\?\.kind === "subagent"\) return/);
});

test("routes blocking extension requests through deduplicated browser attention notifications", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(
    extensionRequestSource,
    /isBlockingExtensionUiRequest\(request\)[\s\S]*?onAttentionNeeded\?\.\(request\)/,
  );
  assert.match(chatWindowSource, /onAttentionNeeded, onSessionCreated/);
  assert.match(completionSource, /if \(!shouldShowBrowserNotification\(\)\) return/);
  assert.doesNotMatch(completionSource, /pushActive/);
  assert.match(completionSource, /tag: targetSession \? `pi-session-complete:\$\{targetSession\.id\}`/);
  assert.doesNotMatch(completionSource, /document\.visibilityState === "visible"/);
  assert.match(attentionSource, /shouldShowBrowserNotification\(\)/);
  assert.match(attentionSource, /claimExtensionAttentionNotification\(request, notifiedAttentionRequestIdsRef\.current\)/);
  assert.match(attentionSource, /tag: `pi-extension-ui:\$\{request\.id\}`/);
  assert.match(appShellSource, /onAttentionNeeded=\{handleAttentionNeeded\}/);
});

test("keeps live following cancellable when the user scrolls away from the tail", () => {
  const streamUpdateSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const scrollHandlerSource = source.slice(
    source.indexOf("const handleScrollPositionChange"),
    source.indexOf("// Load session on mount"),
  );

  assert.match(source, /const liveFollowFrameRef = useRef<number \| null>\(null\)/);
  // Step-follow 由 useEffect [streamState] → scheduleFollowStep 承担（passive effect，
  // message_update 不再 rAF 读 rect（React commit 未落 DOM → 旧布局 → step 抖动），
  // RO 回调只在发送/用户滚动被抑制（pendingScrollToUserRef）时跳过 scheduleFollowStep。
  assert.doesNotMatch(streamUpdateSource, /liveFollowFrameRef\.current === null/);
  assert.match(source, /useEffect\(\(\) => \{[\s\S]*?if \(pendingScrollToUserRef\.current\) return;[\s\S]*?if \(!agentRunningRef\.current\) return;[\s\S]*?scheduleFollowStep\(\);[\s\S]*?\}, \[streamState, messages, scheduleFollowStep\]\);/)
  assert.match(scrollHandlerSource, /cancelAnimationFrame\(liveFollowFrameRef\.current\)/);
});

test("keeps a newly sent user message at the top while its response starts", () => {
  const streamUpdateSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const userScrollSource = source.slice(
    source.indexOf("const scrollUserMsgToTop"),
    source.indexOf("const markUserScrollIntent"),
  );
  const scrollEffectSource = source.slice(
    source.indexOf("useLayoutEffect(() => {\n    if (messages.length > 0)"),
    source.indexOf("// Load model list"),
  );

  assert.doesNotMatch(streamUpdateSource, /!pendingScrollToUserRef\.current && isNearBottomRef\.current/);
  assert.match(source, /const \[promptAnchorActive, setPromptAnchorActive\] = useState\(false\)/);
  assert.match(source, /pendingScrollToUserRef\.current = true;\s*setPromptAnchorActive\(true\)/);
  assert.match(userScrollSource, /const targetTop = Math\.min\(Math\.max\(0, elAbsTop - 16\), maxScrollTop\)/);
  assert.match(userScrollSource, /cancelAnimationFrame\(liveFollowFrameRef\.current\)/);
  assert.match(userScrollSource, /isNearBottomRef\.current = targetTop >= maxScrollTop - SCROLL_BOTTOM_THRESHOLD/);
  assert.match(userScrollSource, /container\.scrollTo\(\{ top: targetTop, behavior: "smooth" \}\)/);
  assert.match(scrollEffectSource, /pendingScrollToUserRef\.current = false;[\s\S]*?scrollUserMsgToTop\(\)/);
  // Step-follow spacer 已移除：不再撑 promptAnchorSpacerHeight（与 smartFollowStep 冲突），
  // 滚动跟随由 useAgentSession 的 smartFollowStep 全权负责。
  assert.doesNotMatch(chatWindowSource, /maxScrollTopWithoutAnchor/);
  assert.doesNotMatch(chatWindowSource, /nextPromptAnchorSpacerHeight/);
  assert.match(chatWindowSource, /step-follow 由 smartFollowStep 全权负责/);
});

test("applies the running eye-room padding in the same commit as the send jump", () => {
  // 根因（2026-08-28，上游合并后显性化）：bottomEyeRoom 原为 passive-effect + state，
  // 比 handleSend 的乐观提交（agentRunning 同步置位 + 用户消息追加）晚一拍；发送跳转
  // scrollUserMsgToTop 在该 commit 的 layout 阶段读 maxScrollTop → 不含 padding →
  // target 被 clamp 到当前位置 = no-op，新消息留在视口下方；随后补偿 step 又被
  // pointerdown 打开的 2s 按压守卫压制 → 「发送后视图不动，回复长在视口外」。
  // 修复：① eye-room 改渲染期派生（与 agentRunning 同 commit 生效）；② 跳转清除按压守卫。
  const userScrollSource = source.slice(
    source.indexOf("const scrollUserMsgToTop"),
    source.indexOf("const markUserScrollIntent"),
  );
  // ① 渲染期派生（禁止回退成 effect+state —— 那会重现竞态）
  assert.match(chatWindowSource, /const bottomEyeRoom = agentRunning\s*\?\s*Math\.max\(0, scrollViewportH - 120 - bottomComposerHeight\)\s*:\s*0;/);
  assert.doesNotMatch(chatWindowSource, /setBottomEyeRoom/);
  assert.doesNotMatch(chatWindowSource, /\[agentRunning, scrollViewportH, scReady, bottomComposerHeight, loading, error\]/);
  // ② 跳转清除按压守卫（在 scrollTo 之前），真实点击发送后补偿 step 不再被静默跳过
  const clearIdx = userScrollSource.indexOf("userScrollIntentUntilRef.current = 0;");
  const scrollIdx = userScrollSource.indexOf('container.scrollTo({ top: targetTop, behavior: "smooth" })');
  assert.ok(clearIdx !== -1, "jump must clear the 2s user-scroll-intent window");
  assert.ok(scrollIdx !== -1 && clearIdx < scrollIdx, "intent clear must precede the jump scrollTo");
});

test("sizes the message tail from the rendered bottom composer", () => {
  assert.match(chatWindowSource, /const bottomComposerRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(chatWindowSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(chatWindowSource, /updateBottomComposerHeight\(entry\.borderBoxSize\?\.\[0\]\?\.blockSize \?\? entry\.contentRect\.height\)/);
  assert.match(chatWindowSource, /bottomComposerScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(chatWindowSource, /distanceFromBottom <= Math\.abs\(nextHeight - previousHeight\) \+ 1/);
  assert.match(chatWindowSource, /scrollToBottom\("auto"\)/);
  assert.match(chatWindowSource, /<div ref=\{bottomComposerRef\} className="relative">/);
  assert.match(chatWindowSource, /height: bottomComposerHeight/);
});
