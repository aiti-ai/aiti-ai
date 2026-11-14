/**
 * qoder-acp-stub.mjs — fake ACP agent child for aiti-qoder-agent unit tests.
 *
 * The handle's transport talks newline-delimited JSON-RPC over the child's stdio.
 * This stub wires two PassThrough streams into that shape and auto-answers the
 * bootstrap methods (initialize / session/new / session/load / set_mode / set_model),
 * while `session/prompt` answers are scriptable (auto end_turn by default, or park
 * them for the test via `autoAnswerPrompt: false` + `answerPrompt()`).
 *
 * Test-side surface:
 *   .child           — shape expected by `new QoderHandle(...)` (stdout/stdin/stderr/once/kill)
 *   .sent            — every JSON-RPC frame the handle wrote (requests + notifications)
 *   .notify(update)  — push a session/update notification to the handle
 *   .request(method, params) — push an agent→client *request* (e.g. session/request_permission)
 *   .answerPrompt(result)    — resolve the oldest parked session/prompt
 *   .respond(id, result)     — raw response to anything (incl. pending agent requests)
 */
import { PassThrough } from "node:stream";

const DEFAULT_SESSION_META = {
  modes: {
    availableModes: [
      { id: "default", name: "Default" },
      { id: "acceptEdits", name: "Accept Edits" },
      { id: "auto", name: "Auto" },
      { id: "dontAsk", name: "Don't Ask" },
      { id: "yolo", name: "Bypass Permissions" },
    ],
    currentModeId: "default",
  },
  models: {
    availableModels: [
      { modelId: "auto", name: "Auto (default)", description: "Reasoning · Vision" },
      { modelId: "qmodel_38max", name: "Qwen3.8-Max", description: "Reasoning · Vision" },
    ],
  },
};

export function createAcpChild(opts = {}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const sid = opts.sessionId ?? "sid-stub-1";
  const sent = [];
  const agentRequests = [];
  let pendingPrompts = [];
  let buf = "";

  const respond = (id, result) => stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const respondError = (id, message) => stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }) + "\n");

  stdin.on("data", (c) => {
    buf += String(c);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      sent.push(msg);
      // Notifications (no id) still drive stub behavior: session/cancel cancels the
      // parked prompt (CLI answers its pending session/prompt with stopReason cancelled).
      // opts.cancelSilent = true simulates a dead/unresponsive CLI (no answer at all).
      if (msg.method === "session/cancel" && msg.id === undefined) {
        if (!opts.cancelSilent) {
          const p = pendingPrompts.shift();
          if (p) respond(p.id, { stopReason: "cancelled", userMessageId: "um-cancel" });
        }
        continue;
      }
      if (msg.id === undefined || msg.method === undefined) continue;
      switch (msg.method) {
        case "initialize":
          respond(msg.id, {
            protocolVersion: 1,
            agentInfo: { name: "qoder-cli-cn", version: opts.cliVersion ?? "1.1.83-test" },
            agentCapabilities: { loadSession: true },
          });
          break;
        case "session/new":
          respond(msg.id, { sessionId: sid, ...(opts.sessionMeta ?? DEFAULT_SESSION_META) });
          break;
        case "session/load":
          if (opts.loadReject) respondError(msg.id, opts.loadReject);
          else respond(msg.id, { ...(opts.sessionMeta ?? DEFAULT_SESSION_META) });
          break;
        case "session/set_mode":
        case "session/set_model":
          respond(msg.id, {});
          break;
        case "session/prompt":
          if (opts.autoAnswerPrompt === false) pendingPrompts.push(msg);
          else respond(msg.id, opts.promptResult ?? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
          break;
        case "session/cancel": {
          // addressed form (should not happen; notify is the norm) — ack and settle parked prompt
          const p = pendingPrompts.shift();
          if (p) respond(p.id, { stopReason: "cancelled", userMessageId: "um-cancel" });
          else respond(msg.id, {});
          break;
        }
        default:
          respond(msg.id, {});
      }
    }
  });

  return {
    stdout,
    stdin,
    sid,
    sent,
    get pendingPrompts() { return pendingPrompts; },
    child: {
      stdout,
      stderr: { on() {} },
      once() {},
      stdin,
      kill() {},
      exitCode: null,
    },
    /** Push any raw frame to the handle (notifications AND agent→client requests). */
    writeFrame(obj) {
      stdout.write(JSON.stringify(obj) + "\n");
    },
    /** Push a session/update notification. */
    notify(update) {
      this.writeFrame({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update } });
    },
    /** Push an agent→client request; returns its JSON-RPC id (answer via respond()). */
    request(method, params) {
      const id = 10_000 + agentRequests.length;
      agentRequests.push({ id, method, params });
      this.writeFrame({ jsonrpc: "2.0", id, method, params });
      return id;
    },
    /** Resolve the oldest parked session/prompt. Returns false if none parked. */
    answerPrompt(result) {
      const p = pendingPrompts.shift();
      if (!p) return false;
      respond(p.id, result ?? { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      return true;
    },
  };
}

/**
 * Ready-to-drive handle: construct + run the ACP bootstrap to completion
 * (initialize → session/new|load → set_mode → agent_start).
 * Sandbox env (EXT_MODEL_STATE_DIR etc.) must be set by the test file BEFORE
 * importing index.ts — same discipline as qoder-hardening.test.mjs.
 */
export async function makeReadyHandle(QoderHandle, { id = "qodercn:new-acp-test", stubOpts, handleOpts, sessionId } = {}) {
  const stub = createAcpChild(stubOpts);
  const h = new QoderHandle(
    sessionId ? `qodercn:${sessionId}` : id,
    stub.child,
    handleOpts?.client ?? null,
    handleOpts?.cwd ?? "/tmp",
    handleOpts?.variant ?? "cn",
    handleOpts?.cliPath ?? "/tmp/qoderclicn-fake",
  );
  const events = [];
  h.subscribe((e) => events.push(e));
  await h.startSession({ sessionId: sessionId ?? stubOpts?.sessionId, seedModel: handleOpts?.seedModel });
  return { h, events, stub };
}

export const flush = () => new Promise((r) => setTimeout(r, 5));
