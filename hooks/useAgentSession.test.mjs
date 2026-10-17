import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const jitiSource = async (url) => (await readFile(url, "utf8")).replace(/\r\n/g, "\n");
const source = await jitiSource(new URL("./useAgentSession.ts", import.meta.url));
const chatWindowSource = await jitiSource(new URL("../components/ChatWindow.tsx", import.meta.url));
const phaseLabelSource = await jitiSource(new URL("../lib/chat-phase-label.ts", import.meta.url));
const chatInputSource = await jitiSource(new URL("../components/ChatInput.tsx", import.meta.url));
const messageViewSource = await jitiSource(new URL("../components/MessageView.tsx", import.meta.url));
const appShellSource = await jitiSource(new URL("../components/AppShell.tsx", import.meta.url));

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
  // A stopped run ends quietly: the event says so (pi 1.1's agent_settled.aborted, carried on prompt_done).
  assert.match(agentSettledSource, /onAgentEnd\?\.\(\{ aborted: event\.aborted === true \}\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId, event\.aborted === true\)/);
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

  // v2 contract: promote only sends the intent; the provisional draft is voided by the
  // keeper state machine. No more rekey migration (migrating would drag already-sent
  // messages into the sid slot)
  assert.match(promoteSource, /applyDraftIntent\(\{ type: "sessionCreated", provisionalKey: provisionalDraftKey, sessionId: sid \}\)/);
  assert.doesNotMatch(promoteSource, /rekeyDraft/);
  assert.ok(
    promoteSource.indexOf('applyDraftIntent({ type: "sessionCreated"')
      < promoteSource.indexOf("onSessionCreated?.({"),
  );
  assert.match(promoteSource, /}, provisionalDraftKey\)/);
  // After the merge, ChatWindow extracts this expression into const draftKey and passes it down
  assert.match(chatWindowSource, /const draftKey = session\?\.id \?\? newSessionDraftKey \?\? undefined;/);
  assert.match(chatWindowSource, /draftKey=\{draftKey\}/);
});

test("a refused new session reports the server's reason, not a bare status (#1061)", () => {
  const ensureSource = source.slice(
    source.indexOf("  const ensureNewSession = useCallback"),
    source.indexOf("  const loadSystemInfo = useCallback"),
  );

  assert.match(
    ensureSource,
    /if \(!res\.ok\) \{[\s\S]*?await res\.json\(\)\.catch\(\(\) => null\)[\s\S]*?typeof body\?\.error === "string" \? body\.error : `HTTP \$\{res\.status\}`/,
  );
  assert.doesNotMatch(ensureSource, /if \(!res\.ok\) throw new Error\(`HTTP \$\{res\.status\}`\)/);
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
  // Opening/restoring a session no longer auto-fetches get_tools (2026-09-15 laziness:
  // viewing alone must not spin up the runtime); the tool list is fetched via
  // loadSystemInfo when the user opens the system/tools panel.
  assert.doesNotMatch(source, /if \(agentState\?\.running\) \{\s*loadTools\(session\.id\)/);
  assert.match(source, /const loadSystemInfo = useCallback\(async \(\) => \{[\s\S]*?loadTools\(sid\)/);
  assert.match(source, /d\.toolNames !== undefined \? getPresetFromToolNames\(d\.toolNames\) : CONFIGURED_TOOL_PRESET/);
  assert.match(changeSource, /setPreferredToolPreset\(preset\)/);
  assert.match(changeSource, /type: "set_tools",\s*\.\.\.\(toolNames !== undefined \? \{ toolNames \} : \{\}\),/);
  assert.match(changeSource, /activeSessionId !== sid \|\| result\?\.recreated/);
  assert.match(changeSource, /result\?\.recreated[\s\S]*?maintainEventsConnected\(activeSessionId\)/);
  assert.match(changeSource, /sessionIdRef\.current = activeSessionId/);
  assert.doesNotMatch(loadToolsSource, /setPreferredToolPreset/);
});

test("a fresh composer starts from carried model picks and reports its own", () => {
  assert.match(source, /const initialChoices = isNew \? opts\.initialNewSessionChoices \?\? null : null;/);
  assert.match(source, /useState<SelectedModel \| null>\(\(\) => initialChoices\?\.model \?\? null\)/);
  assert.match(source, /useState<ConcreteThinkingLevel \| null>\(\(\) => initialChoices\?\.thinkingLevel \?\? null\)/);
  // What ensureNewSession sends is the same carried pick, not just what the selector shows.
  assert.match(source, /const newSessionModelOverrideRef = useRef<SelectedModel \| null>\(initialChoices\?\.model \?\? null\);/);
  assert.match(source, /const thinkingLevelOverrideRef = useRef<ConcreteThinkingLevel \| null>\(initialChoices\?\.thinkingLevel \?\? null\);/);
  assert.match(source, /useEffect\(\(\) => \{\s*if \(isNew\) onNewSessionChoicesChange\?\.\(\{ model: newSessionModel, thinkingLevel: newSessionThinkingLevel \}\);\s*\}, \[isNew, newSessionModel, newSessionThinkingLevel, onNewSessionChoicesChange\]\);/);
  assert.match(chatWindowSource, /newSessionDraftKey, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd: wrappedOnAgentEnd,/);
  // The tool preset needs no carrying: every fresh composer starts from the stored pick.
  assert.match(source, /setToolPresetState\(getPreferredToolPreset\(\)\)/);
});

test("sessions the user never overrode follow pi's configured defaultTools (#700)", () => {
  const ensureSource = source.slice(
    source.indexOf("  const ensureNewSession = useCallback"),
    source.indexOf("  const loadSystemInfo = useCallback"),
  );
  const loadToolsSource = source.slice(
    source.indexOf("  const loadTools = useCallback"),
    source.indexOf("  const promoteNewSession"),
  );

  // A new session must omit toolNames entirely rather than pin pi-web's own preset.
  assert.match(ensureSource, /\.\.\.\(toolNames !== undefined \? \{ toolNames \} : \{\}\),/);
  assert.doesNotMatch(ensureSource, /^ +toolNames,$/m);
  assert.match(ensureSource, /sessionToolsPinnedRef\.current = toolNames !== undefined/);

  // An unpinned session keeps saying "configured" instead of borrowing whichever
  // preset its resolved tools happen to match.
  assert.match(
    loadToolsSource,
    /setToolPresetState\(sessionToolsPinnedRef\.current \? getPresetFromTools\(tools\) : CONFIGURED_TOOL_PRESET\)/,
  );
});

test("only the session-mount load probes disk for external appends", () => {
  const loadSessionSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("sessionHookMountedRef.current = false"),
  );
  assert.match(loadSessionSource, /options\?: \{ force\?: boolean; fresh\?: boolean \}/);
  assert.match(loadSessionSource, /if \(options\?\.force\) params\.set\("force", "1"\)/);
  assert.match(loadSessionSource, /d\.wrapperRebuilt[\s\S]*?eventConnectionRef\.current\?\.close\(\)[\s\S]*?maintain\(sid\)/);
  assert.match(mountSource, /loadSession\(session\.id, !cached, true, \{ force: true \}\)/);
  assert.match(source, /await loadSession\(sid\)/);
  // fork: the count is narrowed to the loadSession call shape —
  // scrollToBottom("instant", { force: true }) is a lookalike literal in the fork
  // scroll code and outside this "probe disk only on mount" guard's scope
  assert.equal([...source.matchAll(/loadSession\([^)]*\{ force: true \}\)/g)].length, 1);
});

test("forking stays available during a run while in-session branch switches wait for it", () => {
  const forkSource = source.slice(
    source.indexOf("  const handleFork = useCallback"),
    source.indexOf("  const handleNavigate = useCallback"),
  );
  const leafChangeSource = source.slice(
    source.indexOf("  const handleLeafChange = useCallback"),
    source.indexOf("  const handleModelChange = useCallback"),
  );

  // Fork copies into a new file, so only a shell command blocks it; the
  // in-session edit still waits because pi refuses navigate_tree mid-run.
  // 合并适配：本地能力门（sessionCap("fork")）与上游 bashRunning 门槛并存
  assert.match(chatWindowSource, /onFork=\{bashRunning \|\| isNew \|\| !sessionCap\("fork"\) \? undefined : handleFork\}/);
  assert.match(chatWindowSource, /onEditContent=\{sessionBusy \? undefined : handleEditContent\}/);
  assert.match(chatWindowSource, /onAskInNewChat && quotedSelection\.sourceEntryId && !bashRunning &&/);
  assert.match(forkSource, /addNotice\(\{ type: "error", message:/);

  assert.match(leafChangeSource, /if \(bashRunningRef\.current \|\| agentRunningRef\.current \|\| isCompacting\) return;/);
  assert.match(source, /const branchSwitchLocked = agentRunning \|\| bashRunning \|\| isCompacting;/);
  assert.match(source, /onBranchDataChange\(data\?\.tree \?\? \[\], activeLeafId, handleLeafChange, branchSwitchLocked\)/);
  assert.match(appShellSource, /setBranchSwitchLocked\(locked\)/);
  assert.equal((appShellSource.match(/locked=\{branchSwitchLocked\}/g) ?? []).length, 2);
});

test("first user messages expose both branch actions and edit before their own entry", () => {
  const navigateSource = source.slice(
    source.indexOf("  const handleNavigate = useCallback"),
    source.indexOf("  const handleLeafChange = useCallback"),
  );

  // fork decision (a4aaff0): forking while running / on the first message are both
  // legal — onFork carries no sessionBusy gating (the upstream sessionBusy || isNew
  // variant is forbidden by the ChatWindow edit-from-here red test).
  // 2026-09-18: added the fork capability gate (local sessions without caps unchanged;
  // external backends without fork support hide the button).
  // 合并适配：同一调用点，融合形态 = 本地能力门 ∪ 上游 bashRunning 门槛
  assert.match(chatWindowSource, /onFork=\{bashRunning \|\| isNew \|\| !sessionCap\("fork"\) \? undefined : handleFork\}/);
  assert.doesNotMatch(chatWindowSource, /idx === 0 && msg\.role === "user" \? undefined : handleFork/);
  // Edit-from-here for fork relies on prevAssistantEntryId to locate the branch point (upstream has no such mechanism, so the old doesNotMatch no longer applies).
  assert.match(navigateSource, /type: "navigate_tree",\s*targetId: entryId/);
  assert.match(navigateSource, /await loadSession\(sid\)/);
});

test("history edits move the branch only when sent, so cancel or reload keeps it", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  // 合并适配：上游本版移除了 MessageView 的 onNavigate（历史编辑全部走 onEditContent）。
  // 本地 fork 的 edit-from-here 三件套（onEditFromHere/editingFromStart/onCancelEditFromStart）
  // 仍需要 onNavigate（点击只标记、发送才回退），由 MessageView.edit-from-here 守护测试看护。
  // 这里保留上游意图：历史编辑接线必须走 onEditContent，而非 onNavigate。
  assert.match(chatWindowSource, /onEditContent=\{sessionBusy \? undefined : handleEditContent\}/);
  assert.match(source, /opts\.chatInputRef\?\.current\?\.replaceMessage\(message\);\s*setEdit\(entryId\)/);
  assert.match(messageViewSource, /onClick=\{onCancelEdit\}/);
  assert.match(source, /const cancelEdit = useCallback\(\(\) => setEdit\(null\)/);
  assert.match(sendSource, /setEdit\(null\);\s*if \(!\(await handleNavigateRef\.current\?\.\(entryId\)\)\) \{\s*setEdit\(entryId\);\s*restoreSubmission\(/);
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
  // v2 contract: core no longer writes the box/slot itself; the rejected intent goes to the keeper
  const restoreSource = source.slice(
    source.indexOf("  const restoreSubmission = useCallback"),
    source.indexOf("  const sessionStats = useMemo"),
  );
  assert.match(restoreSource, /const intentKey = targetDraftKey \?\? composerDraftKey;/);
  assert.match(restoreSource, /if \(!intentKey\) return;/);
  assert.match(restoreSource, /applyDraftIntent\(\{ type: "rejected", key: intentKey, text, images: draftImages \}\)/);
  assert.match(chatInputSource, /const clearInput = useCallback\(\(\) => \{[\s\S]*?The only path that clears the draft/);
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
  // 合并适配：本地 isUserProjectSwitch 守卫 + 上游 #1107 changeFileWorkspace 驻留动作（双方在 v0.11 殊途同归）
  assert.match(cwdChangeSource, /if \(isUserProjectSwitch\) \{[\s\S]*?changeFileWorkspace\(currentProject, newProject\)/);
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
  // v2 contract: unmount does not clear "abandoned" new-session drafts — switching away
  // and back in the SPA restores them via the keeper scan; the sole lifecycle owner is
  // the keeper state machine
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
  assert.match(source, /new AgentEventConnection\(\{/);
  assert.match(source, /shouldMaintain: \(sid\)[\s\S]*?sessionIdRef\.current === sid/);
  assert.match(ensureSource, /eventConnectionRef\.current!\.ensureConnected\(sid\)/);
  assert.match(ensureSource, /eventConnectionRef\.current!\.maintain\(sid\)/);
  // 合并适配：上游把 isCompacting 并进同一占位（agentPhase || isCompacting）
  assert.match(chatWindowSource, /agentRunning && !hasStreamingContent && \(agentPhase \|\| isCompacting\)/);
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
  // Nothing older on the server: the sentinel only widens the window over loaded rows.
  assert.match(chatWindowSource, /if \(!hasEarlierMessages\) \{[\s\S]*?setVisibleCount\(\(current\) => getNextVisibleCount\(current\)\);\s*return;\s*\}/);
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

test("opens the selected session's event stream even when Strict Mode re-runs effects", () => {
  // Strict Mode re-runs effects in declaration order after a simulated
  // unmount. The mount-only effect's cleanup flips sessionHookMountedRef to
  // false and only restores it when it re-runs, which happens after the
  // warm-session effect. That effect must therefore re-assert the ref itself
  // or shouldMaintain() refuses to open the stream on mount and on every
  // switch back to a running session.
  const warmSource = source.slice(
    source.indexOf("  // Keep the selected session warm even while its agent is idle."),
    source.indexOf("    const renewLease = async () => {"),
  );
  assert.match(warmSource, /sessionHookMountedRef\.current = true;\s*maintainEventsConnected\(sid\);/);
  assert.ok(
    warmSource.indexOf("sessionHookMountedRef.current = true;")
      < warmSource.indexOf("maintainEventsConnected(sid);"),
  );
  const mountSource = source.slice(
    source.indexOf("  useEffect(() => {\n    sessionHookMountedRef.current = true;"),
    source.indexOf("  useEffect(() => {\n    onSystemPromptChange?.(systemPrompt);"),
  );
  assert.match(mountSource, /return \(\) => \{\s*sessionHookMountedRef\.current = false;/);
  assert.match(mountSource, /closeEvents\(\);\s*\};\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\s*\}, \[\]\);/);
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
  // setAgentPhase moved into flushPendingDeltas (once per frame): content events (not pure toolcall metadata) clear the waiting-for-model state
  assert.match(source, /all\.some\(\(d\) => d\.type !== "toolcall_start" && d\.type !== "toolcall_delta"\)[\s\S]*?setAgentPhase\(null\)/);
  assert.doesNotMatch(streamSource, /case "message_delta"/);
  assert.match(messageEndSource, /const completed = event\.message as AgentMessage/);
  // Transcript system messages (Pi >= 0.86 prompt and tool loadout) never enter the chat.
  assert.match(streamSource, /if \(isSystemMessageEvent\(event\)\) break;/);
  assert.match(messageEndSource, /if \(isSystemMessageEvent\(event\)\) break;/);
  assert.match(messageEndSource, /normalizeToolCalls\(completed\)/);
  assert.match(messageEndSource, /dispatchStream\(\{ type: "end" \}\)/);
  assert.doesNotMatch(messageEndSource, /streamState\.streamingMessage/);
});

test("does not double-append the first user message when the optimistic key was cleared early", () => {
  const messageEndSource = source.slice(
    source.indexOf('case "message_end"'),
    source.indexOf('case "tool_execution_start"'),
  );
  // Root cause of the duplicated first message (2026-09-16): on new-session connect the
  // SSE connected frame reaches the backend before the prompt, so the server reports
  // isRunning=false → the client's idle-correction settle branch clears
  // optimisticUserMessageKeyRef; agent_start then resumes, and when message_end(user)
  // arrives the optimisticKey is gone → blind append → the first user bubble renders
  // twice. Fix: add an idempotent fallback in the user branch — if the tail's last entry
  // is a user message with the same key, skip it outright, regardless of ref liveness.
  const dedicatedSource = messageEndSource.slice(
    messageEndSource.indexOf("const delivered = normalizeToolCalls(completed)"),
    messageEndSource.indexOf("dispatchStream({ type: \"end\" })"),
  );
  // The original dedup path is kept (it consumes the optimistic bubble while optimisticKey is alive).
  assert.match(dedicatedSource, /optimisticKey && last\?\.role === "user" && userMessageKey\(last\) === optimisticKey/);
  // Idempotent fallback: optimisticKey lost but a same-key user message still sits at the tail → return prev to skip.
  assert.match(dedicatedSource, /userMessageKey\(last\) === deliveredKey/);
  assert.match(dedicatedSource, /Idempotent backstop/);
  assert.ok(
    dedicatedSource.indexOf("userMessageKey(last) === deliveredKey") > dedicatedSource.indexOf("userMessageKey(last) === optimisticKey"),
    "the idempotent fallback must come after the original optimisticKey dedup path",
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
  assert.match(phaseLabelSource, /if \(latest\?\.progress\)/);
  assert.match(phaseLabelSource, /chat\.runningNamedTool[\s\S]*latest\.progress/);
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

  assert.match(updateSource, /name === "bash" \|\| name === "powershell" \|\| name === CODEMODE_TOOL_NAME/);
  assert.match(updateSource, /setActiveToolResults/);
  assert.match(updateSource, /content,/);
  assert.match(endSource, /setActiveToolResults[\s\S]*next\.delete\(id\)/);
  assert.match(chatWindowSource, /const map = new Map\(activeToolResults\)/);
  assert.match(chatWindowSource, /<MessageView message=\{streamState\.streamingMessage as AgentMessage\} toolResults=\{toolResultsMap\}/);
});

test("reports a running script's newest call as its progress", () => {
  const updateSource = source.slice(
    source.indexOf('case "tool_execution_update"'),
    source.indexOf('case "tool_execution_end"'),
  );
  // A codemode snapshot has no text content, so the generic progress would stay empty.
  assert.match(
    updateSource,
    /name === CODEMODE_TOOL_NAME\s*\? getCodemodeProgress\(event\.partialResult\)\s*: getToolExecutionProgress\(event\.partialResult\)/,
  );
});

test("keeps calls a tool made itself out of the running tools", () => {
  // A codemode script's nested calls would otherwise show as top-level running
  // tools beside the script that made them.
  for (const [from, to] of [
    ['case "tool_execution_start"', 'case "tool_execution_update"'],
    ['case "tool_execution_update"', 'case "tool_execution_end"'],
    ['case "tool_execution_end"', 'case "queue_update"'],
  ]) {
    const caseSource = source.slice(source.indexOf(from), source.indexOf(to));
    const guard = caseSource.indexOf("if (isNestedToolExecutionEvent(event)) break;");
    assert.notEqual(guard, -1, `${from} must skip nested tool events`);
    assert.ok(guard < caseSource.indexOf("const id = event.toolCallId"), `${from} must skip them before using the id`);
  }
  assert.match(source, /import \{ isNestedToolExecutionEvent, isSystemMessageEvent \} from "@\/lib\/agent-event-wire";/);
});

test("plays the enabled sound once when an extension dialog appears over an empty slot", () => {
  const soundSource = chatWindowSource.slice(
    chatWindowSource.indexOf("const surfaced = "),
    chatWindowSource.indexOf("}, [completionNotificationsEnabled, extensionDialog]);"),
  );
  assert.match(chatWindowSource, /extensionDialogShownRef = useRef\(false\)/);
  // A dialog queued behind another surfaces right after the user answers that one,
  // so only the transition from no dialog to a dialog sounds.
  assert.match(soundSource, /const surfaced = Boolean\(extensionDialog\) && !extensionDialogShownRef\.current;/);
  assert.match(soundSource, /extensionDialogShownRef\.current = Boolean\(extensionDialog\);\s+if \(!completionNotificationsEnabled \|\| !surfaced\) return;/);
  assert.match(soundSource, /playDoneSoundRef\.current\(\)/);
});

test("queues extension dialogs and custom panels by request id instead of sharing one slot", () => {
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const respondSource = source.slice(
    source.indexOf("  const respondToExtensionUi = useCallback"),
    source.indexOf("  const sendExtensionCustomInput = useCallback"),
  );
  const closedSource = source.slice(
    source.indexOf('      case "extension_ui_closed":'),
    source.indexOf("  handleAgentEventRef.current = handleAgentEvent;"),
  );

  assert.match(
    source,
    /import \{\s+enqueueExtensionUiRequest,\s+removeExtensionUiRequest,\s+retainExtensionUiRequests,\s+upsertExtensionUiRequest,\s+\} from "@\/lib\/extension-ui-queue"/,
  );
  // A (re)connect drops what the server no longer holds; its replay follows.
  const connectedSource = source.slice(source.indexOf('      case "connected": {'), source.indexOf('      case "agent_start":'));
  assert.match(connectedSource, /const pending = new Set\(event\.pendingExtensionUiIds as string\[\]\);/);
  assert.match(connectedSource, /setExtensionDialogs\(\(queue\) => retainExtensionUiRequests\(queue, pending\)\);/);
  assert.match(connectedSource, /setExtensionCustomUis\(\(queue\) => retainExtensionUiRequests\(queue, pending\)\);/);
  assert.match(source, /const \[extensionDialogs, setExtensionDialogs\] = useState<ExtensionUiDialogRequest\[\]>\(\[\]\)/);
  assert.match(source, /const \[extensionCustomUis, setExtensionCustomUis\] = useState<ExtensionUiCustomRequest\[\]>\(\[\]\)/);
  assert.doesNotMatch(source, /setExtensionDialog\(|setExtensionCustomUi\(/);
  assert.match(
    extensionRequestSource,
    /case "editor":\s+setExtensionDialogs\(\(queue\) => enqueueExtensionUiRequest\(queue, request\)\)/,
  );
  // A custom panel re-renders under its id: replace it where it stands, drop it on close.
  assert.match(
    extensionRequestSource,
    /case "custom":\s+setExtensionCustomUis\(\(queue\) => request\.closed\s+\? removeExtensionUiRequest\(queue, request\.id\)\s+: upsertExtensionUiRequest\(queue, request\)\)/,
  );
  assert.match(respondSource, /setExtensionDialogs\(\(queue\) => removeExtensionUiRequest\(queue, request\.id\)\)/);
  assert.match(closedSource, /setExtensionDialogs\(\(queue\) => removeExtensionUiRequest\(queue, event\.id as string\)\)/);
  // The hook keeps exposing what is on screen under the old names, plus how many wait behind it.
  assert.match(source, /const extensionDialog = extensionDialogs\[0\] \?\? null;/);
  assert.match(source, /const waitingExtensionDialogCount = Math\.max\(0, extensionDialogs\.length - 1\);/);
  assert.match(source, /const extensionCustomUi = extensionCustomUis\[0\] \?\? null;/);
  assert.match(source, /const waitingExtensionCustomUiCount = Math\.max\(0, extensionCustomUis\.length - 1\);/);
  assert.match(source, /notices: noticeState\.visible, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount,/);
  assert.match(chatWindowSource, /notices, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount,/);
});

test("drops queued extension UI when a tool change rebuilds the wrapper", () => {
  const setToolsSource = source.slice(
    source.indexOf("  const handleToolPresetChange = useCallback"),
    source.indexOf("  const scrollToMessage = useCallback"),
  );
  // The old wrapper closes its event stream before cancelling its pending requests,
  // so their extension_ui_closed events never reach this hook.
  assert.match(
    setToolsSource,
    /if \(activeSessionId !== sid \|\| result\?\.recreated\) \{[\s\S]*?closeEvents\(\);[\s\S]*?setExtensionDialogs\(\[\]\);\s+setExtensionCustomUis\(\[\]\);[\s\S]*?maintainEventsConnected\(activeSessionId\)/,
  );
  // A tool change that keeps the wrapper keeps its pending requests on screen.
  const unconditional = setToolsSource.slice(setToolsSource.indexOf("      setSlashCommands([]);"));
  assert.doesNotMatch(unconditional, /setExtensionDialogs|setExtensionCustomUis/);
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
  assert.match(chatWindowSource, /!completionNotificationsEnabled \|\| !surfaced/);
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
  // Step-follow is handled by useEffect [streamState] → scheduleFollowStep (a passive
  // effect; message_update no longer reads rect in rAF — React hasn't committed the DOM
  // → stale layout → step jitter). The RO callback only skips scheduleFollowStep when
  // sends/user scrolls are suppressed (pendingScrollToUserRef).
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
  // The step-follow spacer was removed: promptAnchorSpacerHeight is no longer inflated
  // (it conflicted with smartFollowStep); scroll following is fully owned by
  // useAgentSession's smartFollowStep.
  assert.doesNotMatch(chatWindowSource, /maxScrollTopWithoutAnchor/);
  assert.doesNotMatch(chatWindowSource, /nextPromptAnchorSpacerHeight/);
  assert.match(chatWindowSource, /step-follow is fully owned by smartFollowStep/);
});

test("applies the running eye-room padding in the same commit as the send jump", () => {
  // Root cause (2026-08-28, surfaced after the upstream merge): bottomEyeRoom used to be
  // passive-effect + state, landing one beat after handleSend's optimistic commit
  // (agentRunning set synchronously + user message appended); the send jump
  // scrollUserMsgToTop reads maxScrollTop in that commit's layout phase → without the
  // padding → target clamps to the current position = no-op, the new message stays below
  // the viewport; the compensating step is then suppressed by the 2s press guard opened
  // by pointerdown → "nothing moves after sending; the reply grows out of view".
  // Fix: (1) derive eye-room during render (lands in the same commit as agentRunning);
  // (2) the jump clears the press guard.
  const userScrollSource = source.slice(
    source.indexOf("const scrollUserMsgToTop"),
    source.indexOf("const markUserScrollIntent"),
  );
  // (1) render-time derivation (do not regress to effect+state — that would reintroduce the race)
  assert.match(chatWindowSource, /const bottomEyeRoom = agentRunning\s*\?\s*Math\.max\(0, scrollViewportH - 120 - bottomComposerHeight\)\s*:\s*0;/);
  assert.doesNotMatch(chatWindowSource, /setBottomEyeRoom/);
  assert.doesNotMatch(chatWindowSource, /\[agentRunning, scrollViewportH, scReady, bottomComposerHeight, loading, error\]/);
  // (2) the jump clears the press guard (before scrollTo), so the post-send compensating step is no longer silently skipped
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
  // Root cause: on small screens with the keyboard up, streaming step-follow / tail-pin
  // re-scrolls triggered by composer growth / final scroll-to-bottom all moved the body
  // under the user's thumb = breaking input. Fix: focused composer + small screen (or
  // touch-primary device) → freeze all passive scrolling; explicit jumps (send/first
  // paint) carry a force exception, and blur re-enables following via events.
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
    source.indexOf("// Step-follow trigger signals"),
  );

  // Freeze condition: editing + small screen/touch; desktop mouse windows keep stream following
  assert.match(freezeHelperSource, /const CHAT_EDIT_FREEZE_QUERY = "\(max-width: 959px\), \(pointer: coarse\)"/);
  assert.match(source, /const isChatScrollFrozen = useCallback\(\s*\(\) => isEditFreezeViewport\(\) && editingRef\.current && Date\.now\(\) < composingUntilRef\.current,/);
  // Freezing keys off a "recent edit event" time window, not "has focus": on phones the
  // keyboard stays up after sending and focus remains in the composer, so focus alone
  // would freeze following for the entire reply.
  assert.match(source, /const COMPOSING_ACTIVE_MS = 5_000/);
  assert.match(source, /const COMPOSING_EVENTS = \["beforeinput", "input", "keydown", "compositionstart"\]/);
  assert.match(followStepSource, /if \(isChatScrollFrozen\(\)\) return;/);
  assert.match(scrollToBottomSource, /if \(!opts\?\.force && isChatScrollFrozen\(\)\) return;/);
  assert.match(followStepSource, /\[isChatScrollFrozen, opts\.promptAnchorSpacerHeightRef/);
  // Tail pinning uses in-container scrollTo, never scrollIntoView (that also scrolls html/body; with the keyboard up the whole page gets shoved away)
  assert.doesNotMatch(scrollToBottomSource, /scrollIntoView\(\{/);
  assert.match(scrollToBottomSource, /container\.scrollTo\(\{ top: Math\.max\(0, target\), behavior \}\)/);
  // First-paint tail snap is exempt from the freeze
  assert.match(layoutScrollSource, /scrollToBottom\("instant", \{ force: true \}\)/);
  // On blur, hand the view back: while running, schedule one step; when idle, scroll to bottom under the original settle conditions (event-driven, no polling)
  assert.match(composingGuardSource, /window\.addEventListener\(type, arm, \{ capture: true, passive: true \}\)/);
  assert.match(composingGuardSource, /window\.addEventListener\("focusout", onFocusOut, true\)/);
  assert.match(composingGuardSource, /if \(isEditableNode\(event\.relatedTarget\)\) return;/);
  assert.match(composingGuardSource, /if \(!isEditFreezeViewport\(\) \|\| !isEditableNode\(event\.target\)\) return;/);
  // Explicit jumps (send/navigation) release the freeze: this turn's reply must keep following as usual
  const userScrollSource = source.slice(
    source.indexOf("const scrollUserMsgToTop"),
    source.indexOf("const markUserScrollIntent"),
  );
  assert.match(userScrollSource, /composingUntilRef\.current = 0;\s*editingRef\.current = false;/);
  assert.match(composingGuardSource, /if \(agentRunningRef\.current\) \{\s*scheduleFollowStep\(\);/);
  assert.match(composingGuardSource, /releaseTimer = window\.setTimeout\(\(\) => \{[\s\S]*?release\(\);[\s\S]*?\}, COMPOSING_ACTIVE_MS\);/);
});

test("run elapsed badge recovers its start from the last prompt after page reopen", () => {
  // Root cause: on page reopen/reconnect the agent_start was missed, and the old
  // runStartedAtRef ??= Date.now() pinned the start to "the moment of opening" — the
  // elapsed badge restarted from zero on every open. Fix: recover from the latest user
  // message timestamp (when that prompt was issued); fall back to now only if the
  // messages carry no timestamp.
  const deriveSource = source.slice(
    source.indexOf("function deriveRunStartedAt"),
    source.indexOf("export function useAgentSession"),
  );
  assert.match(deriveSource, /for \(let i = messages\.length - 1; i >= 0; i--\)/);
  assert.match(deriveSource, /const promptTimestamp = messages\[userIndex\]\.timestamp/);
  assert.match(deriveSource, /typeof promptTimestamp === "number" && promptTimestamp > 0/);
  // User messages replayed by external backends (codebuddy etc.) may lack timestamps: fall back to the first timestamped message after it
  assert.match(deriveSource, /for \(let i = userIndex \+ 1; i < messages\.length; i\+\+\)/);

  const adoptSource = source.slice(
    source.indexOf("const adoptRunStartedAt = useCallback"),
    source.indexOf("const isChatScrollFrozen"),
  );
  assert.match(adoptSource, /if \(runStartedAtRef\.current !== null\) return/);
  // Server state.runStartedAt (the authoritative value on the external backend's handle side) wins; then message derivation/current time
  assert.match(adoptSource, /serverStartedAt\?: number/);
  assert.match(adoptSource, /typeof serverStartedAt === "number" && serverStartedAt > 0 \? serverStartedAt : null/);
  assert.match(adoptSource, /deriveRunStartedAt\(messagesRef\.current\)/);
  assert.match(source, /adoptRunStartedAt\(state\?\.runStartedAt\)/);
  assert.match(source, /adoptRunStartedAt\(st\.runStartedAt\)/);
  assert.match(source, /adoptRunStartedAt\(st\?\.runStartedAt\)/);
  // loadSession mirrors synchronously: a running adoption in the same flow must immediately read the just-loaded messages
  assert.match(source, /messagesRef\.current = persistedMessages/);

  // All remote adoption points (connected / agent_start / grace reconciliation /
  // adoptRemoteRun / mount) go through adoptRunStartedAt — "the moment of opening" must
  // never be the start again
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

  // Only handleSend's optimistic send path keeps the Date.now start
  const fallbacks = source.match(/runStartedAtRef\.current \?\?= Date\.now\(\)/g) ?? [];
  assert.equal(fallbacks.length, 1);

  // Settlement uniformly clears the start (including settle paths without agent_settled); the next round starts fresh
  const settleSource = source.slice(
    source.indexOf("const settleUiStage = useCallback"),
    source.indexOf("const notifyPromptStage"),
  );
  assert.match(settleSource, /runStartedAtRef\.current = null/);
});

test("start-plan captcha bridge: event wiring, respond command, and sessionRequestCard seam (source contract)", async () => {
  // The hook consumes provider_runtime_headers_request → state + response + export (the protocol layer stays in core)
  assert.match(source, /case "provider_runtime_headers_request":/);
  assert.match(source, /setProviderHeadersRequest\(\{[\s\S]*?captchaConfig:/);
  assert.match(source, /case "provider_headers_expired":/);
  assert.match(source, /const respondToProviderHeaders = useCallback/);
  assert.match(source, /type: "respond_provider_headers"/);
  assert.match(source, /providerHeadersRequest, respondToProviderHeaders/);
  // Session request card seam (agent-capability UI moved out of core): the three families
  // derive one state + unified answer dispatch + a single mount point in ChatWindow;
  // the card UI itself lives in extensions (the session-cards extension / the zcode agent
  // client extension) — see SessionRequestSlot.test.mjs.
  assert.match(source, /const sessionRequest = useMemo<SessionRequestPayload \| null>/);
  assert.match(source, /kind: `interaction:\$\{interactionRequest\.kind\}`/);
  assert.match(source, /const respondToSessionRequest = useCallback/);
  assert.match(source, /sessionRequest, respondToSessionRequest,/);
  assert.match(chatWindowSource, /sessionRequest, respondToSessionRequest/);
  assert.match(chatWindowSource, /<SessionRequestCardHost/);
  assert.match(chatWindowSource, /import \{ SessionRequestCardHost \} from "\.\/SessionRequestSlot"/);
});

test("busy-state adoption covers compaction windows (state / connected / events)", () => {
  // Root cause (observed 2026-09-14): manual compact aborts the current run first
  // (isStreaming=false) while the session is still busy (wrapper.isRunning includes
  // isCompacting) — the sidebar glowed "running" while the chat window showed idle.
  // Contract: busy-state determination always follows the server's authoritative
  // isRunning (delivered via get_state / connected frames); neither mount adoption nor
  // settlement may miss it.
  assert.match(source, /function stateIsActive\(state\?: AgentStateResponse \| null\): boolean/);
  assert.match(source, /state\.isRunning \|\| state\.isStreaming \|\| state\.isPromptRunning \|\| state\.isCompacting/);

  // Mount adoption: isRunning (compaction/queued continuation etc.) also counts as running
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?.(systemPrompt)"),
  );
  assert.match(mountSource, /if \(stateIsActive\(agentState\.state\)\)/);
  assert.match(mountSource, /st\.isCompacting \? \{ kind: "compacting" \}/);

  // connected frame: server isRunning set; when the server is idle but local state still says running → fallback settle
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "session_backend_ready"'),
  );
  assert.match(connectedSource, /\.isRunning === true/);
  assert.match(connectedSource, /\.isRunning === false/);
  assert.match(connectedSource, /settleUiStage\(\)/);

  // Compaction start sets busy (manual compact's abort settles first); on end, settle when no active run remains
  const compactionSource = source.slice(
    source.indexOf('case "auto_compaction_start"'),
    source.indexOf('case "extension_ui_request"'),
  );
  assert.match(compactionSource, /agentRunningRef\.current = true/);
  assert.match(compactionSource, /setAgentPhase\(\{ kind: "compacting" \}\)/);
  assert.match(compactionSource, /if \(!sdkAgentActiveRef\.current && !rpcPromptPendingRef\.current\) \{\s*settleUiStage\(\);/);

  // Guardian polling / reconciliation / settlement polling share one busy-state definition
  assert.match(source, /if \(!data\.running \|\| !state \|\| !stateIsActive\(state\)\) \{/);
  assert.match(source, /const busy = data\.running && !!state && stateIsActive\(state\)/);
});

test("idle-correction on connected skips while a prompt is pending or optimistic bubble undigested", () => {
  // Root cause (2026-09-14): on a new session's first send the SSE connected frame
  // arrives before the prompt (server isRunning=false), and the old idle-correction
  // branch unconditionally ran settleUiStage, wrongly clearing agentRunning → the run
  // indicator stayed hidden long after sending; it also cleared
  // optimisticUserMessageKeyRef → message_end(user) appended twice (the first message
  // rendered twice). Fix: guard the correction branch — skip correction while a local
  // prompt is pending / an optimistic bubble is undigested.
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "session_backend_dead"'),
  );
  assert.match(connectedSource, /\.isRunning === false/);
  assert.match(connectedSource, /!rpcPromptPendingRef\.current/);
  assert.match(connectedSource, /!optimisticUserMessageKeyRef\.current/);
  // The guards must precede settleUiStage (within the same condition chain)
  assert.ok(
    connectedSource.indexOf("!rpcPromptPendingRef.current") < connectedSource.indexOf("settleUiStage()"),
    "the guards must appear before the settleUiStage() call",
  );
});

test("backend subprocess death settles the frontend running state", () => {
  // Root cause (2026-09-14): PCliSpawnHandle.markDead only emitted session_backend_dead
  // and the frontend had no case for it → agentRunning stuck forever (after the pi child
  // process exited, the UI kept showing "running" long after the server went idle).
  const deadSource = source.slice(
    source.indexOf('case "session_backend_dead"'),
    source.indexOf('case "session_backend_ready"'),
  );
  assert.match(deadSource, /const wasRunning = settleUiStage\(\)/);
  assert.match(deadSource, /void loadSession\(sid\)/);
  // 合并适配：上游 onAgentEnd 携带 AgentEndInfo；后端崩溃≠完成，aborted=true 抑制完成音（本地无参=响铃，融合后取不响）
  assert.match(deadSource, /if \(wasRunning\) onAgentEnd\?\.\(\{ aborted: true \}\)/);
});

test("agent_settled blocked by rpcPromptPending falls back to settling on server idle (spawn sends no prompt_done)", () => {
  // Root cause (2026-09-14): spawn backends (the pi child process) never send prompt_done
  // → rpcPromptPendingRef stays true, and agent_settled is a one-shot event; once the
  // guard blocks it, settlement never happens (a pi fork reply finished but the UI stayed
  // "running"; reproduced). Fix (1): when agent_end fetches state, align
  // rpcPromptPending with the server's isPromptRunning. Fix (2): before the agent_settled
  // guard breaks, double-check the server; if idle, clear the flag and settle late.
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
  // 合并适配：同上
  assert.match(settledSource, /if \(wasRunning\) onAgentEnd\?\.\(\{ aborted: false \}\);/);
});

test("manual refresh cuts the stale SSE stream, reloads with ?fresh=1 and reconnects", () => {
  const loadSource = source.slice(
    source.indexOf("const loadSession = useCallback"),
    source.indexOf("const reloadCurrentSession = useCallback"),
  );
  assert.match(loadSource, /const loadSession = useCallback\(async \(sid: string, showLoading = false, includeState = false, options\?: \{ force\?: boolean; fresh\?: boolean \}\) => \{/);
  assert.match(loadSource, /if \(options\?\.fresh\) params\.set\("fresh", "1"\);/);

  // Refresh must cut the old stream before reconnecting: the server's ?fresh=1 recycles
  // the idle wrapper; the old EventSource is bound to the dead wrapper, and without
  // closing it the new wrapper's events would never arrive (sending showed no streaming).
  const reloadSource = source.slice(
    source.indexOf("const reloadCurrentSession = useCallback"),
    source.indexOf("const loadContext = useCallback"),
  );
  assert.match(reloadSource, /eventConnectionRef\.current\?\.close\(\);/);
  assert.match(reloadSource, /await loadSession\(sid, false, true, \{ fresh: true \}\);/);
  assert.match(reloadSource, /eventConnectionRef\.current\?\.maintain\(sid\);/);
});

test("queued continuation after stop never sticks on \"stopping\": aborting moves into the hook and resets on current-turn settlement", () => {
  // Root cause (observed 2026-09): after clicking stop, aborting only reset once
  // sessionBusy (agentRunning||bashRunning) went false, but abort only stops the current
  // turn — the next queued message immediately fires agent_start and keeps running →
  // agentRunning stays true → the UI stayed stuck on "stopping"; after a refresh you
  // could see the current message had stopped and the agent was processing the next
  // queue entry.
  // Fix: move aborting into useAgentSession and tie the reset to "current turn settled"
  // (agent_end / settleUiStage / bash completion) rather than "agent fully idle".
  assert.match(source, /const \[aborting, setAborting\] = useState\(false\);/);
  // The hook's return value must expose aborting (ChatWindow consumes the same-named prop)
  const retSource = source.slice(source.indexOf("    dispatch, setAgentRunning, setForkingEntryId,"));
  assert.match(retSource, /aborting,/);

  // Clicking stop → handleAbort sets it (before both the bash and agent paths)
  const abortSource = source.slice(
    source.indexOf("  const handleAbort = useCallback"),
    source.indexOf("  const handleFork = useCallback"),
  );
  assert.ok(
    abortSource.indexOf("setAborting(true);") < abortSource.indexOf('if (bashRunningRef.current)'),
    "setAborting(true) must precede the bash/agent branches (both stop kinds enter the waiting state)",
  );

  // Reset point (1): agent_end (current turn ends, even if a queued turn follows immediately)
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  assert.match(agentEndSource, /setAborting\(false\);/);

  // Reset point (2): settleUiStage (shared by agent_settled / prompt_done / session_backend_dead / reconnect idle-correction)
  const settleSource = source.slice(
    source.indexOf("  const settleUiStage = useCallback"),
    source.indexOf("  }, [dispatchStream]);"),
  );
  assert.match(settleSource, /setAborting\(false\);/);

  // Reset point (3): bash completion (both the executeBash finally and the waitForBashSettlement poll)
  const bashSettlementSource = source.slice(
    source.indexOf("  const waitForBashSettlement = useCallback"),
    source.indexOf("  // Reconcile client streaming state"),
  );
  assert.match(bashSettlementSource, /setBashRunning\(false\);\s*setAborting\(false\);/);
  const executeBashSource = source.slice(
    source.indexOf("  const executeBash = useCallback"),
    source.indexOf("  executeBashRef.current = executeBash;"),
  );
  assert.match(executeBashSource, /setBashRunning\(false\);\s*\/\/ After bash finishes \(including an abort via abort_bash\)/);

  // ChatWindow no longer holds a local aborting state / sessionBusy reset effect (old implementation)
  assert.doesNotMatch(chatWindowSource, /const \[aborting, setAborting\] = useState\(false\);/);
  assert.doesNotMatch(chatWindowSource, /if \(!sessionBusy\) setAborting\(false\);/);
  // ChatWindow destructures aborting from the hook and forwards it to ChatInput
  assert.match(chatWindowSource, /agentRunning, bashRunning, pendingBash, aborting,/);
  assert.match(chatWindowSource, /aborting=\{aborting\}/);
  assert.doesNotMatch(chatWindowSource, /setAborting\(true\);/);
});

test("auto-compact slash command toggles session auto-compaction", () => {
  const commandSource = source.slice(
    source.indexOf('case "auto-compact"'),
    source.indexOf('case "reload"'),
  );
  assert.ok(commandSource.length > 0, "auto-compact case not found before reload case");
  assert.match(commandSource, /sendAgentCommand<AgentStateResponse>\(sid, \{\s*type: "get_state"\s*\}\)/);
  assert.match(commandSource, /!\(liveState\?\.autoCompactionEnabled \?\? true\)/);
  assert.match(commandSource, /sendAgentCommand\(sid, \{\s*type: "set_auto_compaction",\s*enabled: nextEnabled,\s*\}\)/);
  assert.match(commandSource, /setAutoCompactionEnabled\(nextEnabled\)/);
  assert.doesNotMatch(commandSource, /!autoCompactionEnabled/);
  // State mirrors the wrapper so the toggle reflects server-side changes too.
  assert.match(source, /setAutoCompactionEnabled\(state\?\.autoCompactionEnabled \?\? true\)/);
  assert.match(source, /setAutoCompactionEnabled\(liveState\.autoCompactionEnabled \?\? true\)/);
});

test("keeps the compaction control reachable while a turn is auto-compacting", () => {
  // Auto-compaction starts mid-turn, so `isStreaming` (sessionBusy) is already true. Hiding
  // the control behind `!isStreaming` left only the generic stop button, which aborts the
  // whole prompt instead of the compaction.
  // 合并适配：本地是三态单行（compacting→中止 / queued→取消 / idle→压缩），按钮仅在 onCompact 存在时渲染
  // ——比上游的 (!isStreaming || isCompacting) 门更强：任意状态下都可达，mid-compaction 点击即中止。
  const controlBlock = chatInputSource.slice(
    chatInputSource.indexOf("{/* Context-meter extension ratio bar: the slot just left of the compact button"),
    chatInputSource.indexOf('aria-label={isCompacting ? t("chat.stopCompaction")'),
  );

  assert.match(controlBlock, /\{onCompact && \(/);
  assert.doesNotMatch(controlBlock, /\{!isStreaming && onCompact && \(/);
  // 上游意图保留：auto-compaction 中点击走 onAbortCompaction（而非中止整个 prompt）
  assert.match(controlBlock, /if \(isCompacting\) onAbortCompaction\?\.\(\);/);
  assert.match(controlBlock, /cursor: "pointer"/);
});
