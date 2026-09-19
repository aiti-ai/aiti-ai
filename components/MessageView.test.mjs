import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  MessageView,
  ThinkingBlock,
  getModelDisplayName,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { splitFinalAssistantBlocks } = await jiti.import("@/lib/message-display");
const { setToolCallExpanded, clearExpandedToolCalls } = await jiti.import("@/lib/tool-call-expansion");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("updates a reused message when its written files change", () => {
  const props = { message: { role: "assistant", content: [] } };
  assert.equal(MessageView.compare(props, props), true);
  assert.equal(MessageView.compare(props, { ...props, writtenFiles: [{ path: "/tmp/result.txt" }] }), false);
});

test("matches response model aliases and otherwise includes the provider", () => {
  const names = {
    "gateway:claude-sonnet-5": "Sonnet 5",
    "custom-api:GLM-5.3": "GLM 5.3",
  };

  assert.equal(getModelDisplayName("gateway", "anthropic/claude-sonnet-5", names), "Sonnet 5");
  assert.equal(getModelDisplayName("CUSTOM-API", "glm-5.3", names), "GLM 5.3");
  assert.equal(getModelDisplayName("gateway", "unknown-model", names), "gateway/unknown-model");
});

test("tolerates a missing model or provider (external-agent replay frames)", () => {
  const names = { "gateway:claude-sonnet-5": "Sonnet 5" };

  // provider-only (ACP replay frames / error messages: provider present, model missing) used to crash the whole page:
  // getModelDisplayName called responseModel.toLowerCase() unguarded → crash on undefined → global-error.
  assert.equal(getModelDisplayName("aiti-acp-agent/codebuddy", undefined, names), "aiti-acp-agent/codebuddy");
  assert.equal(getModelDisplayName("gateway", undefined, names), "gateway");
  assert.equal(getModelDisplayName(undefined, "deepseek-v4.1-flash", names), "deepseek-v4.1-flash");
  assert.equal(getModelDisplayName(undefined, undefined, names), "");

  // Render regression: assistant messages missing a model no longer take down MessageView.
  const providerOnly = renderMessage({ role: "assistant", content: [{ type: "text", text: "replayed" }], provider: "aiti-acp-agent/codebuddy" });
  assert.match(providerOnly, /aiti-acp-agent\/codebuddy/);
  const modelOnly = renderMessage({ role: "assistant", content: [{ type: "text", text: "no provider" }], model: "deepseek-v4.1-flash" });
  assert.match(modelOnly, /deepseek-v4\.1-flash/);
  const neither = renderMessage({ role: "assistant", content: [{ type: "text", text: "no stamp" }] });
  assert.doesNotMatch(neither, /undefined/);
});

test("previews the first thinking line and reveals the full text with the saved default", () => {
  const previousWindow = globalThis.window;
  try {
    for (const expanded of [false, true]) {
      globalThis.window = { localStorage: { getItem: () => String(expanded) } };
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        null,
        React.createElement(ThinkingBlock, {
          block: { type: "thinking", thinking: "**Independent reasoning**\n\nDetailed second line." },
          blockIndex: 2,
          duration: 3,
        }),
      ));
      assert.match(html, new RegExp(`aria-expanded="${expanded}"`));
      assert.equal((html.match(/>[^<]*Independent reasoning[^<]*</g) ?? []).length, 1);
      assert.equal(html.includes("Detailed second line."), expanded);
      assert.match(html, /aria-label="Thinking: /);
      assert.match(html, /3s/);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("shows deferred thinking previews without loading the full content", () => {
  const html = renderMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Historical first line", deferred: true }],
  });
  assert.match(html, />Historical first line<\/span>/);
  assert.match(html, /aria-expanded="false"/);
});

test("marks only the matched text block after splitting thinking and the final answer", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "Thinking about the result" },
      { type: "text", text: "Process text" },
      { type: "toolCall", toolCallId: "read-1", toolName: "read", input: {} },
      { type: "text", text: "First answer" },
      { type: "text", text: "Matched pi-cwd-spark answer" },
    ],
  };
  const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
  for (const index of [2, 4, 5]) {
    const searchBlock = message.content[index];
    for (const content of [processBlocks, answerBlocks]) {
      const html = renderMessage({ ...message, content }, { searchBlock });
      assert.equal((html.match(/data-search-target="true"/g) ?? []).length, content.includes(searchBlock) ? 1 : 0);
      if (content.includes(searchBlock)) {
        assert.match(html, new RegExp(`data-search-target="true">(?:(?!data-message-text)[\\s\\S])*${searchBlock.text}`));
      }
    }
  }
});

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /write/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("renders subagents as standard tool calls with only an extra session button", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, result]]),
    onOpenSession() {},
  });

  assert.match(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
  assert.match(html, />Agent</);
  assert.match(html, />Explore</);
  assert.match(html, /aria-label="Open sub-agent session"/);
  assert.doesNotMatch(html, />completed</);
  assert.doesNotMatch(html, />Find parser</);

  const ordinaryHtml = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ ...block, toolCallId: "call-extension-1", toolName: "extension_tool" }],
  }, {
    toolResults: new Map(),
    onOpenSession() {},
  });
  assert.doesNotMatch(ordinaryHtml, /Open sub-agent session/);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("marks persisted assistant messages with their source entry", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Select this response" }],
  }, { entryId: "assistant-entry" });

  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /data-entry-id="assistant-entry"/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

const USER_MSG = {
  role: "user",
  content: "普通用户消息",
  timestamp: 1787000000000,
};

// "Edit from here" pending-send marker: regular message (has a previous assistant entry) → mark button;
// first message (no branch point) → same button; once pending the button becomes "Cancel" and is highlighted.
test("hides the edit-from-here button when no handler is provided", () => {
  const html = renderMessage(USER_MSG, { entryId: "entry-1" });
  assert.doesNotMatch(html, /Edit from here/);
  assert.doesNotMatch(html, /Cancel edit from here/);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("marks apply_patch returned failures as errors even when isError is unset", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-patch-1",
    toolName: "apply_patch",
    input: {
      input: "*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch",
    },
  };
  const failed = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "apply_patch failed.\nRecovery: MUST read src/a.ts before retrying." }],
    details: {
      result: { appliedFiles: [], failures: [{ filePath: "src/a.ts", message: "context mismatch" }] },
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [block],
  }, { toolResults: new Map([[block.toolCallId, failed]]) });

  assert.match(html, /border:1px solid rgba\(248,113,113,0\.45\)/);
  assert.match(html, />apply_patch</);
  assert.doesNotMatch(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
});

test("apply_patch failures render the applied preview instead of the requested input", () => {
  clearExpandedToolCalls();
  setToolCallExpanded("call-patch-2", true);
  // input requests two files, but the preview (actual result) only contains the successful one — failed files must not appear with the applied style.
  const block = {
    type: "toolCall",
    toolCallId: "call-patch-2",
    toolName: "apply_patch",
    input: {
      input: [
        "*** Begin Patch",
        "*** Update File: src/ok.ts",
        "-  a = 1",
        "+  a = 2",
        "*** Update File: src/bad.ts",
        "-  b = 1",
        "+  b = 2",
        "*** End Patch",
      ].join("\n"),
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "apply_patch failed.\nRecovery: MUST read src/bad.ts before retrying." }],
    details: {
      result: { appliedFiles: ["src/ok.ts"], failures: [{ filePath: "src/bad.ts", message: "context mismatch" }] },
      preview: { files: [{ filePath: "src/ok.ts", operation: "update", diff: "-  1 a = 1\n+  1 a = 2" }] },
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [block],
  }, { toolResults: new Map([[block.toolCallId, result]]) });

  // Successful file comes from the preview (with real line numbers) rather than the input request (preview text has no leading spaces).
  assert.match(html, />a = 2</);
  assert.match(html, />a = 1</);
  // Diffs for the failed file b = 1 / b = 2 must not render.
  assert.doesNotMatch(html, />b = 1</);
  assert.doesNotMatch(html, />b = 2</);
});

test("apply_patch failures without preview exclude failed paths from the input parse", () => {
  clearExpandedToolCalls();
  setToolCallExpanded("call-patch-3", true);
  // Without a preview fall back to the input, dropping failed paths file by file and keeping only successful ones.
  const block = {
    type: "toolCall",
    toolCallId: "call-patch-3",
    toolName: "apply_patch",
    input: {
      input: [
        "*** Begin Patch",
        "*** Update File: src/ok.ts",
        "-  a = 1",
        "+  a = 2",
        "*** Update File: src/bad.ts",
        "-  b = 1",
        "+  b = 2",
        "*** Update File: src/moved.ts",
        "*** Move to: src/renamed.ts",
        "-  m = 1",
        "+  m = 2",
        "*** End Patch",
      ].join("\n"),
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "apply_patch failed." }],
    details: {
      result: { failures: [{ filePath: "src/bad.ts", message: "context mismatch" }, { filePath: "src/moved.ts", message: "move source unreadable" }] },
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [block],
  }, { toolResults: new Map([[block.toolCallId, result]]) });

  // Successful files render as usual (kept after being dropped from the input).
  assert.match(html, />  a = 2</);
  // Diffs of failed files (including the move source name) must not render.
  assert.doesNotMatch(html, />  b = 1</);
  assert.doesNotMatch(html, />  b = 2</);
  assert.doesNotMatch(html, />  m = 1</);
  assert.doesNotMatch(html, />  m = 2</);
  // Overall it is still framed red.
  assert.match(html, /border:1px solid rgba\(248,113,113,0\.45\)/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});
