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

test("new-session promotion clears the provisional draft via intent before publishing the real session", () => {
  const promoteSource = source.slice(
    source.indexOf("  const promoteNewSession = useCallback"),
    source.indexOf("  const ensureNewSession = useCallback"),
  );

  // v2 契约：promote 只发意图，provisional 草稿由 keeper 状态机作废；
  // 不再 rekey 搬运（搬运会把已发送消息带进 sid 槽位）
  assert.match(promoteSource, /applyDraftIntent\(\{ type: "sessionCreated", provisionalKey: provisionalDraftKey, sessionId: sid \}\)/);
  assert.doesNotMatch(promoteSource, /rekeyDraft/);
  assert.ok(
    promoteSource.indexOf('applyDraftIntent({ type: "sessionCreated"')
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
  assert.match(changeSource, /activeSessionId !== sid \|\| result\?\.recreated/);
  assert.match(changeSource, /result\?\.recreated[\s\S]*?maintainEventsConnected\(activeSessionId\)/);
  assert.match(changeSource, /sessionIdRef\.current = activeSessionId/);
  assert.doesNotMatch(loadToolsSource, /setPreferredToolPreset/);
});

test("first user messages expose both branch actions and edit before their own entry", () => {
  const navigateSource = source.slice(
    source.indexOf("  const handleNavigate = useCallback"),
    source.indexOf("  const handleLeafChange = useCallback"),
  );

  // fork 拍板（a4aaff0）：运行中/首条消息 fork 均合法——onFork 不带 sessionBusy 门控
  // （上游 sessionBusy || isNew 版本被 ChatWindow.edit-from-here 红灯测试禁止）。
  assert.match(chatWindowSource, /onFork=\{isNew \? undefined : handleFork\}/);
  assert.doesNotMatch(chatWindowSource, /idx === 0 && msg\.role === "user" \? undefined : handleFork/);
  // fork 的「从此处编辑」依赖 prevAssistantEntryId 定分支点（上游无此机制，原 doesNotMatch 不适用）。
  assert.match(navigateSource, /type: "navigate_tree",\s*targetId: entryId/);
  assert.match(navigateSource, /await loadSession\(sid\)/);
});

test("an empty persisted session displays the model it will use on first send", () => {
  assert.match(
    source,
    /currentModel \?\? \(data\?\.context\.messages\.length === 0 \? newSessionDefaultModel : null\)/,
  );
  assert.match(source, /setNewSessionDefaultModel\(displayDefaultModel/);
});

test("the selector prefers the live wrapper model over persisted response metadata", () => {
  assert.match(source, /model\?: \{ provider: string; id: string \}/);
  assert.match(source, /const currentModel = currentModelOverride \?\? liveModel \?\? data\?\.context\.model \?\? pendingModel \?\? null/);
  assert.match(source, /syncLiveModel\(liveState\)/);
  assert.match(source, /syncLiveModel\(state\);[\s\S]*?const busy = data\.running/);
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

test("submission recovery goes through the rejected intent (keeper writes the box)", () => {
  // v2 契约：core 不再自行写框/写槽，rejected 意图交 keeper 处理
  const restoreSource = source.slice(
    source.indexOf("  const restoreSubmission = useCallback"),
    source.indexOf("  const sessionStats = useMemo"),
  );
  assert.match(restoreSource, /const intentKey = targetDraftKey \?\? composerDraftKey;/);
  assert.match(restoreSource, /if \(!intentKey\) return;/);
  assert.match(restoreSource, /applyDraftIntent\(\{ type: "rejected", key: intentKey, text, images: draftImages \}\)/);
  assert.match(chatInputSource, /const clearInput = useCallback\(\(\) => \{[\s\S]*?草稿清空唯一路径 = aiti-draft-keeper/);
  assert.doesNotMatch(chatInputSource, /getDraftApi\(\)\?\.clearDraft/);
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
  assert.match(cwdChangeSource, /if \(isUserProjectSwitch\) \{[\s\S]*?setFileTabs\(\[\]\)/);
  assert.match(
    appShellSource,
    /useLayoutEffect\(\(\) => \{\s*activeNewSessionDraftKeyRef\.current = newSessionDraftKey;/,
  );
  assert.ok(
    createdSource.indexOf("activeNewSessionDraftKeyRef.current !== sourceDraftKey")
      < createdSource.indexOf("setSelectedSession(session)"),
  );
});

test("abandoned fresh-session drafts survive unmount (keeper owns the lifecycle); late rejection still guarded", () => {
  // v2 契约：unmount 不清「废弃」新建草稿——SPA 切走再切回由 keeper scan 恢复；
  // 生命周期唯一所有者是 keeper 状态机
  const mountSource = source.slice(
    source.indexOf("  // Load session on mount"),
    source.indexOf("  useEffect(() => {\n    onSystemPromptChange"),
  );
  const restoreSource = source.slice(
    source.indexOf("  const restoreSubmission = useCallback"),
    source.indexOf("  const sessionStats = useMemo"),
  );

  assert.doesNotMatch(mountSource, /abandonedDraftKey/);
  assert.doesNotMatch(mountSource, /clearDraft/);
  assert.match(restoreSource, /!sessionHookMountedRef\.current[\s\S]*?!newSessionPromotedRef\.current/);
  assert.match(restoreSource, /type: "rejected"/);
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

test("keeps the selected session warm while idle and renews its lease", () => {
  assert.match(source, /sessionRunning\?: boolean/);
  assert.match(
    source,
    /const sid = session\?\.id;[\s\S]*?if \(!sid\) return;[\s\S]*?maintainEventsConnected\(sid\)/,
  );
  assert.match(source, /sessionPropIdRef\.current === sid/);
  assert.match(source, /SESSION_LEASE_RENEW_INTERVAL_MS = 30_000/);
  assert.match(source, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}\/lease`/);
  assert.match(source, /setInterval\(\(\) => void renewLease\(\), SESSION_LEASE_RENEW_INTERVAL_MS\)/);
  assert.match(source, /result\.renewed === 0[\s\S]*?closeEvents\(\)[\s\S]*?maintainEventsConnected\(sid\)/);
  assert.match(source, /if \(sessionPropIdRef\.current === sid\) \{[\s\S]*?cancelEventStreamGrace\(\);[\s\S]*?return;/);
  assert.match(source, /maintainEventsConnected\(sid\)/);
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

test("does not double-append the first user message when the optimistic key was cleared early", () => {
  const messageEndSource = source.slice(
    source.indexOf('case "message_end"'),
    source.indexOf('case "tool_execution_start"'),
  );
  // 首发消息重复根因（2026-09-16）：新会话确保连接时 SSE connected 帧先于 prompt 送达
  // 后端，服务端 isRunning=false → 客户端「判闲纠正」收口分支清空 optimisticUserMessageKeyRef；
  // 随后 agent_start 恢复运行，message_end(user) 到达时 optimisticKey 已丢 → 盲目追加 →
  // 首发 user 气泡显示两次。修复：user 分支加幂等兜底 —— 尾部最后一条是同 key user 消息时
  // 直接跳过，不依赖 ref 是否存活。
  const dedicatedSource = messageEndSource.slice(
    messageEndSource.indexOf("const delivered = normalizeToolCalls(completed)"),
    messageEndSource.indexOf("dispatchStream({ type: \"end\" })"),
  );
  // 原始去重路径仍保留（optimisticKey 存活时消化乐观气泡）。
  assert.match(dedicatedSource, /optimisticKey && last\?\.role === "user" && userMessageKey\(last\) === optimisticKey/);
  // 幂等兜底：optimisticKey 丢失但尾部同 key user 消息仍在原位 → return prev 跳过。
  assert.match(dedicatedSource, /userMessageKey\(last\) === deliveredKey/);
  assert.match(dedicatedSource, /幂等兜底/);
  assert.ok(
    dedicatedSource.indexOf("userMessageKey(last) === deliveredKey") > dedicatedSource.indexOf("userMessageKey(last) === optimisticKey"),
    "幂等兜底必须置于原始 optimisticKey 去重路径之后",
  );
  assert.match(dedicatedSource, /if \(last\?\.role === "user" && userMessageKey\(last\) === deliveredKey\) \{\s*return prev;\s*\}/);
});

test("restoring a running session does not clear an SSE snapshot", () => {
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("useEffect(() => {\n    onSystemPromptChange"),
  );

  assert.match(mountSource, /dispatch(Stream)?\(\{ type: "resume" \}\)/);
  assert.doesNotMatch(mountSource, /dispatch\(\{ type: "start" \}\)/);
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

test("reconnects active shell output to its streaming tool call", () => {
  const updateSource = source.slice(
    source.indexOf('case "tool_execution_update"'),
    source.indexOf('case "tool_execution_end"'),
  );
  const endSource = source.slice(
    source.indexOf('case "tool_execution_end"'),
    source.indexOf('case "queue_update"'),
  );

  assert.match(updateSource, /name === "bash" \|\| name === "powershell"/);
  assert.match(updateSource, /setActiveToolResults/);
  assert.match(updateSource, /content,/);
  assert.match(endSource, /setActiveToolResults[\s\S]*next\.delete\(id\)/);
  assert.match(chatWindowSource, /const map = new Map\(activeToolResults\)/);
  assert.match(chatWindowSource, /<MessageView message=\{streamState\.streamingMessage as AgentMessage\} toolResults=\{toolResultsMap\}/);
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

test("restores an in-page session viewport without the default tail jump", () => {
  assert.match(source, /const initialScrollDoneRef = useRef\(Boolean\(opts\.deferInitialScroll\)\)/);
  assert.match(source, /const scrollToMessage = useCallback\(\(element: HTMLElement, viewportOffset = 16\)/);
  assert.match(source, /container\.scrollTop\s+- viewportOffset/);
  assert.match(chatWindowSource, /deferInitialScroll: Boolean\(pendingScrollRestore\)/);
  assert.match(chatWindowSource, /isScrollAtTail\(container\.scrollTop, container\.clientHeight, container\.scrollHeight\)/);
  assert.match(chatWindowSource, /findChatScrollAnchor\(/);
  assert.match(chatWindowSource, /while \(hasMore && before && !controller\.signal\.aborted\)/);
  assert.match(chatWindowSource, /context\.oldestEntryId === position\.oldestEntryId/);
  assert.match(chatWindowSource, /if \(!context\) \{\s*scrollToBottom\("instant"\);\s*setPendingScrollRestore\(null\);/);
  assert.match(chatWindowSource, /scrollToMessage\(element, position\.anchorOffset\)/);
  assert.match(chatWindowSource, /visibility: pendingScrollRestore \? "hidden" : undefined/);
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
  assert.match(chatWindowSource, /<div ref=\{bottomComposerRef\} className="relative( shrink-0)?"?>/);
  assert.match(chatWindowSource, /height: bottomComposerHeight/);
});

test("freezes passive chat scrolling while composing on a small screen", () => {
  // 根因：小屏键盘弹起时，流式 step-follow / 输入框长高触发的尾钉重滚 / 收尾滚底都会
  // 在用户拇指下移动正文 = 打断输入。修复：文本框持有焦点 + 小屏（或触摸主力设备）
  // → 冻结一切被动滚动；发送/首屏等显式跳转带 force 例外，失焦时事件驱动补跟。
  const freezeHelperSource = source.slice(
    source.indexOf("const CHAT_EDIT_FREEZE_QUERY"),
    source.indexOf("const PROMPT_SETTLE_INITIAL_DELAY_MS"),
  );
  const scrollToBottomSource = source.slice(
    source.indexOf("const scrollToBottom = useCallback"),
    source.indexOf("// Step-follow (always on)"),
  );
  const followStepSource = source.slice(
    source.indexOf("const smartFollowStep = useCallback"),
    source.indexOf("// T-5: rAF-coalesced step-follow"),
  );
  const composingGuardSource = source.slice(
    source.indexOf("// Composing guard (small screens / touch)"),
    source.indexOf("}, [scheduleFollowStep, scrollToBottom]);"),
  );
  const layoutScrollSource = source.slice(
    source.indexOf("useLayoutEffect(() => {\n    if (messages.length > 0)"),
    source.indexOf("// Step-follow 检查信号"),
  );

  // 冻结条件：正在编辑 + 小屏/触摸；桌面鼠标窗口保持流式跟随
  assert.match(freezeHelperSource, /const CHAT_EDIT_FREEZE_QUERY = "\(max-width: 959px\), \(pointer: coarse\)"/);
  assert.match(source, /const isChatScrollFrozen = useCallback\(\s*\(\) => isEditFreezeViewport\(\) && editingRef\.current && Date\.now\(\) < composingUntilRef\.current,/);
  // 冻结靠「最近有编辑事件」的时间窗，不是「有焦点」：手机发送后键盘不收、焦点仍在输入框，
  // 只看焦点会把整轮回复的跟随一起冻结掉。
  assert.match(source, /const COMPOSING_ACTIVE_MS = 5_000/);
  assert.match(source, /const COMPOSING_EVENTS = \["beforeinput", "input", "keydown", "compositionstart"\]/);
  assert.match(followStepSource, /if \(isChatScrollFrozen\(\)\) return;/);
  assert.match(scrollToBottomSource, /if \(!opts\?\.force && isChatScrollFrozen\(\)\) return;/);
  assert.match(followStepSource, /\[isChatScrollFrozen, opts\.promptAnchorSpacerHeightRef/);
  // 尾钉用容器内 scrollTo，绝不 scrollIntoView（那会连带滚 html/body，键盘弹起时整页被顶走）
  assert.doesNotMatch(scrollToBottomSource, /scrollIntoView\(\{/);
  assert.match(scrollToBottomSource, /container\.scrollTo\(\{ top: Math\.max\(0, target\), behavior \}\)/);
  // 首屏落尾不受冻结影响
  assert.match(layoutScrollSource, /scrollToBottom\("instant", \{ force: true \}\)/);
  // 失焦即交还视图：运行中补一帧 step，空闲按原收尾条件滚底（事件驱动，非轮询）
  assert.match(composingGuardSource, /window\.addEventListener\(type, arm, \{ capture: true, passive: true \}\)/);
  assert.match(composingGuardSource, /window\.addEventListener\("focusout", onFocusOut, true\)/);
  assert.match(composingGuardSource, /if \(isEditableNode\(event\.relatedTarget\)\) return;/);
  assert.match(composingGuardSource, /if \(!isEditFreezeViewport\(\) \|\| !isEditableNode\(event\.target\)\) return;/);
  // 显式跳转（发送/导航）解除冻结：本轮回复要照常跟随
  const userScrollSource = source.slice(
    source.indexOf("const scrollUserMsgToTop"),
    source.indexOf("const markUserScrollIntent"),
  );
  assert.match(userScrollSource, /composingUntilRef\.current = 0;\s*editingRef\.current = false;/);
  assert.match(composingGuardSource, /if \(agentRunningRef\.current\) \{\s*scheduleFollowStep\(\);/);
  assert.match(composingGuardSource, /releaseTimer = window\.setTimeout\(\(\) => \{[\s\S]*?release\(\);[\s\S]*?\}, COMPOSING_ACTIVE_MS\);/);
});

test("run elapsed badge recovers its start from the last prompt after page reopen", () => {
  // 根因：页面重开/断线重连时 agent_start 已错过，旧行为 runStartedAtRef ??= Date.now()
  // 会把起点钉在「打开时刻」——读秒每次打开都从零重来。修复：从最近一条用户消息
  // 时间戳（发起该轮 prompt 的时刻）恢复；消息里取不到才退回当前时刻。
  const deriveSource = source.slice(
    source.indexOf("function deriveRunStartedAt"),
    source.indexOf("export function useAgentSession"),
  );
  assert.match(deriveSource, /for \(let i = messages\.length - 1; i >= 0; i--\)/);
  assert.match(deriveSource, /const promptTimestamp = messages\[userIndex\]\.timestamp/);
  assert.match(deriveSource, /typeof promptTimestamp === "number" && promptTimestamp > 0/);
  // 外部后端（codebuddy 等）回放的 user 消息可能无时间戳：退取其后第一条带时间戳的消息
  assert.match(deriveSource, /for \(let i = userIndex \+ 1; i < messages\.length; i\+\+\)/);

  const adoptSource = source.slice(
    source.indexOf("const adoptRunStartedAt = useCallback"),
    source.indexOf("const isChatScrollFrozen"),
  );
  assert.match(adoptSource, /if \(runStartedAtRef\.current !== null\) return/);
  // 服务端 state.runStartedAt（外部后端 handle 侧权威值）优先，再退消息推导/当前时刻
  assert.match(adoptSource, /serverStartedAt\?: number/);
  assert.match(adoptSource, /typeof serverStartedAt === "number" && serverStartedAt > 0 \? serverStartedAt : null/);
  assert.match(adoptSource, /deriveRunStartedAt\(messagesRef\.current\)/);
  assert.match(source, /adoptRunStartedAt\(state\?\.runStartedAt\)/);
  assert.match(source, /adoptRunStartedAt\(st\.runStartedAt\)/);
  assert.match(source, /adoptRunStartedAt\(st\?\.runStartedAt\)/);
  // loadSession 同步镜像：同一流程里的 running 采纳必须立即读到刚加载的消息
  assert.match(source, /messagesRef\.current = persistedMessages/);

  // 远端采纳点（connected / agent_start / grace 对账 / adoptRemoteRun / mount）统一走
  // adoptRunStartedAt，不得再以「打开时刻」当起点
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "session_backend_ready"'),
  );
  assert.match(connectedSource, /adoptRunStartedAt\(\)/);
  assert.doesNotMatch(connectedSource, /runStartedAtRef\.current \?\?= Date\.now\(\)/);
  const graceSource = source.slice(
    source.indexOf("const checkServerIdle"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  assert.match(graceSource, /adoptRunStartedAt\(/);
  assert.doesNotMatch(graceSource, /runStartedAtRef\.current \?\?= Date\.now\(\)/);
  const remoteRunSource = source.slice(
    source.indexOf("const adoptRemoteRun = useCallback"),
    source.indexOf("const resolveRecovery"),
  );
  assert.match(remoteRunSource, /adoptRunStartedAt\(/);
  assert.doesNotMatch(remoteRunSource, /runStartedAtRef\.current \?\?= Date\.now\(\)/);
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?.(systemPrompt)"),
  );
  assert.match(mountSource, /adoptRunStartedAt\(/);
  assert.doesNotMatch(mountSource, /runStartedAtRef\.current \?\?= Date\.now\(\)/);

  // 只有 handleSend 的乐观发送路径保留 Date.now 起点
  const fallbacks = source.match(/runStartedAtRef\.current \?\?= Date\.now\(\)/g) ?? [];
  assert.equal(fallbacks.length, 1);

  // 收口统一清起点（含无 agent_settled 的收口路径），下轮重新起算
  const settleSource = source.slice(
    source.indexOf("const settleUiStage = useCallback"),
    source.indexOf("const notifyPromptStage"),
  );
  assert.match(settleSource, /runStartedAtRef\.current = null/);
});

test("start-plan captcha bridge: event wiring, respond command, and ChatWindow mount (source contract)", async () => {
  // hook 消费 provider_runtime_headers_request → 状态 + 应答 + 导出
  assert.match(source, /case "provider_runtime_headers_request":/);
  assert.match(source, /setProviderHeadersRequest\(\{[\s\S]*?captchaConfig:/);
  assert.match(source, /case "provider_headers_expired":/);
  assert.match(source, /const respondToProviderHeaders = useCallback/);
  assert.match(source, /type: "respond_provider_headers"/);
  assert.match(source, /providerHeadersRequest, respondToProviderHeaders/);
  // ChatWindow 挂载验证卡
  assert.match(chatWindowSource, /providerHeadersRequest, respondToProviderHeaders/);
  assert.match(chatWindowSource, /<ProviderHeadersRequestCard request=\{providerHeadersRequest\} onRespond=\{respondToProviderHeaders\} \/>/);
  assert.match(chatWindowSource, /import \{ ProviderHeadersRequestCard \} from "\.\/ProviderHeadersRequestCard"/);
});

test("busy-state adoption covers compaction windows (state / connected / events)", () => {
  // 根因（2026-09-14 实测）：manual compact 先 abort 当前 run（isStreaming=false）而会话仍忙
  // （wrapper.isRunning 含 isCompacting）——侧栏 running 亮而聊天窗显示空闲。契约：忙态判定
  // 统一走服务端权威 isRunning（get_state / connected 帧下发），mount 采纳与收口都不得漏。
  assert.match(source, /function stateIsActive\(state\?: AgentStateResponse \| null\): boolean/);
  assert.match(source, /state\.isRunning \|\| state\.isStreaming \|\| state\.isPromptRunning \|\| state\.isCompacting/);

  // mount 采纳：isRunning（压缩/续轮等）也算运行中
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?.(systemPrompt)"),
  );
  assert.match(mountSource, /if \(stateIsActive\(agentState\.state\)\)/);
  assert.match(mountSource, /st\.isCompacting \? \{ kind: "compacting" \}/);

  // connected 帧：服务端 isRunning 置位；服务端判闲且本地仍挂运行中 → 兜底收口
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "session_backend_ready"'),
  );
  assert.match(connectedSource, /\.isRunning === true/);
  assert.match(connectedSource, /\.isRunning === false/);
  assert.match(connectedSource, /settleUiStage\(\)/);

  // 压缩开始置忙（manual compact 的 abort 已先收口）、结束且无活跃 run 时收口
  const compactionSource = source.slice(
    source.indexOf('case "auto_compaction_start"'),
    source.indexOf('case "extension_ui_request"'),
  );
  assert.match(compactionSource, /agentRunningRef\.current = true/);
  assert.match(compactionSource, /setAgentPhase\(\{ kind: "compacting" \}\)/);
  assert.match(compactionSource, /if \(!sdkAgentActiveRef\.current && !rpcPromptPendingRef\.current\) \{\s*settleUiStage\(\);/);

  // 守护轮询 / 对账 / 落定轮询统一忙态口径
  assert.match(source, /if \(!data\.running \|\| !state \|\| !stateIsActive\(state\)\) \{/);
  assert.match(source, /const busy = data\.running && !!state && stateIsActive\(state\)/);
});

test("idle-correction on connected skips while a prompt is pending or optimistic bubble undigested", () => {
  // 根因（2026-09-14）：新会话首发时 SSE connected 帧先于 prompt 送达（服务端 isRunning=false），
  // 旧的「判闲纠正」分支无条件 settleUiStage 会误清 agentRunning → 发送后长时间不显示运行中；
  // 同时清 optimisticUserMessageKeyRef → message_end(user) 重复追加（首发消息显示两次）。
  // 修复：纠正分支加守卫——本地有待受理 prompt / 未消化乐观气泡时跳过纠正。
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "session_backend_dead"'),
  );
  assert.match(connectedSource, /\.isRunning === false/);
  assert.match(connectedSource, /!rpcPromptPendingRef\.current/);
  assert.match(connectedSource, /!optimisticUserMessageKeyRef\.current/);
  // 守卫必须在 settleUiStage 之前（同一条件链内）
  assert.ok(
    connectedSource.indexOf("!rpcPromptPendingRef.current") < connectedSource.indexOf("settleUiStage()"),
    "守卫应出现在 settleUiStage 调用之前",
  );
});

test("backend subprocess death settles the frontend running state", () => {
  // 根因（2026-09-14）：PCliSpawnHandle.markDead 只发 session_backend_dead，前端无此 case →
  // agentRunning 永挂（pi 子进程退出后 UI 一直「运行中」，服务端早已判闲）。
  const deadSource = source.slice(
    source.indexOf('case "session_backend_dead"'),
    source.indexOf('case "session_backend_ready"'),
  );
  assert.match(deadSource, /const wasRunning = settleUiStage\(\)/);
  assert.match(deadSource, /void loadSession\(sid\)/);
  assert.match(deadSource, /if \(wasRunning\) onAgentEnd\?\.\(\)/);
});

test("agent_settled 被 rpcPromptPending 拦截时按服务端空闲兜底收尾（spawn 无 prompt_done）", () => {
  // 根因（2026-09-14）：spawn 后端（pi 子进程）不发 prompt_done → rpcPromptPendingRef 残留 true，
  // agent_settled 是一次性事件，被守卫拦下后永不收尾（pi fork 回复完成仍挂运行中，实测复现）。
  // 修复①：agent_end 拉取 state 时以服务端 isPromptRunning 对齐 rpcPromptPending；
  // 修复②：agent_settled 守卫 break 前后台核对服务端，空闲则清标记 + 补收尾。
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  assert.match(agentEndSource, /if \(d\.state\?\.isPromptRunning !== undefined\) \{\s*rpcPromptPendingRef\.current = Boolean\(d\.state\.isPromptRunning\);/);
  const settledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  assert.match(settledSource, /\) \|\| rpcPromptPendingRef\.current\) \{/);
  assert.match(settledSource, /settledSid && rpcPromptPendingRef\.current && agentRunningRef\.current/);
  assert.match(settledSource, /if \(d\.state\?\.isPromptRunning\) return;/);
  assert.match(settledSource, /rpcPromptPendingRef\.current = false;/);
  assert.match(settledSource, /const wasRunning = settleUiStage\(\);/);
  assert.match(settledSource, /void loadSession\(settledSid\);/);
  assert.match(settledSource, /if \(wasRunning\) onAgentEnd\?\.\(\);/);
});

test("manual refresh cuts the stale SSE stream, reloads with ?fresh=1 and reconnects", () => {
  const loadSource = source.slice(
    source.indexOf("const loadSession = useCallback"),
    source.indexOf("const reloadCurrentSession = useCallback"),
  );
  assert.match(loadSource, /const loadSession = useCallback\(async \(sid: string, showLoading = false, includeState = false, fresh = false\) => \{/);
  assert.match(loadSource, /if \(fresh\) params\.set\("fresh", "1"\);/);

  // 刷新必须断开旧流再重连：服务端 ?fresh=1 会回收空闲 wrapper，旧 EventSource 绑在
  // 死 wrapper 上，不断流则此后新 wrapper 的事件永远收不到（发消息无流式）。
  const reloadSource = source.slice(
    source.indexOf("const reloadCurrentSession = useCallback"),
    source.indexOf("const loadContext = useCallback"),
  );
  assert.match(reloadSource, /eventConnectionRef\.current\?\.close\(\);/);
  assert.match(reloadSource, /await loadSession\(sid, false, true, true\);/);
  assert.match(reloadSource, /eventConnectionRef\.current\?\.maintain\(sid\);/);
});
