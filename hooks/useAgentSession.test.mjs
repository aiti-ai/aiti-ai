import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

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

test("reuses an open event stream and hides an empty agent phase", () => {
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
  // Step-follow 由 useEffect [streamState] → smartFollowStep 承担（passive effect，
  // message_update 不再 rAF 读 rect（React commit 未落 DOM → 旧布局 → step 抖动），
  // RO 回调只在发送/用户滚动被抑制（pendingScrollToUserRef）时跳过 smartFollowStep。
  assert.doesNotMatch(streamUpdateSource, /liveFollowFrameRef\.current === null/);
  assert.match(source, /useEffect\(\(\) => \{[\s\S]*?if \(!streamState\.isStreaming\) return;[\s\S]*?if \(pendingScrollToUserRef\.current\) return;[\s\S]*?smartFollowStep\(\);/)
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
