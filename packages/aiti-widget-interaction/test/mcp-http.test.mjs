import test from "node:test";
import assert from "node:assert/strict";
import {
  InteractionBroker,
  createHttpInteractionTransport,
  handleMcpRequest,
  startInteractionServer,
} from "../dist/index.js";

function nextRequest(broker) {
  return new Promise((resolveRequest) => {
    let unsubscribe = () => {};
    unsubscribe = broker.subscribe((event) => {
      if (event.type !== "request") return;
      unsubscribe();
      resolveRequest(event.request);
    });
  });
}

function answer(handle, id, body) {
  return fetch(`${handle.baseUrl}interactions/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${handle.token}` },
    body: JSON.stringify(body),
  });
}

test("MCP over HTTP proxies tool calls to a running daemon", async () => {
  const broker = new InteractionBroker();
  const handle = await startInteractionServer({ broker, port: 0, token: "daemon-token", allowCreate: true });
  const transport = createHttpInteractionTransport({ baseUrl: handle.baseUrl, token: handle.token });
  try {
    const pending = nextRequest(broker);
    const call = handleMcpRequest(transport, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "widget_confirm", arguments: { prompt: "Continue?", timeout: 10000 } },
    });
    const request = await pending;
    assert.equal(request.kind, "confirm");
    assert.equal(request.message, "Continue?");
    const answered = await answer(handle, request.id, { action: "approve", approved: true });
    assert.equal(answered.status, 200);

    const response = await call;
    const result = JSON.parse(response.result.content[0].text);
    assert.equal(result.status, "answered");
    assert.equal(result.approved, true);
  } finally {
    await handle.close();
    broker.close();
  }
});

test("MCP over HTTP cancels a pending request through the daemon", async () => {
  const broker = new InteractionBroker();
  const handle = await startInteractionServer({ broker, port: 0, token: "daemon-token", allowCreate: true });
  const transport = createHttpInteractionTransport({ baseUrl: handle.baseUrl, token: handle.token });
  try {
    const pending = nextRequest(broker);
    const waiting = transport.ask({ kind: "confirm", title: "Hold", message: "Hold", timeoutMs: 0 });
    const request = await pending;

    const cancelled = await handleMcpRequest(transport, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "widget_cancel", arguments: { id: request.id } },
    });
    assert.equal(cancelled.result.content[0].text, JSON.stringify({ ok: true }));

    const result = await waiting;
    assert.equal(result.status, "cancelled");
  } finally {
    await handle.close();
    broker.close();
  }
});

test("MCP over HTTP reports unknown tools and dead requests", async () => {
  const broker = new InteractionBroker();
  const handle = await startInteractionServer({ broker, port: 0, token: "daemon-token", allowCreate: true });
  const transport = createHttpInteractionTransport({ baseUrl: handle.baseUrl, token: handle.token });
  try {
    const unknown = await handleMcpRequest(transport, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "widget_nope", arguments: {} },
    });
    assert.equal(unknown.error.code, -32602);

    const missing = await handleMcpRequest(transport, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "widget_cancel", arguments: { id: "int_missing" } },
    });
    assert.equal(missing.error.code, -32602);

    const unauthorized = createHttpInteractionTransport({ baseUrl: handle.baseUrl, token: "wrong" });
    await assert.rejects(
      handleMcpRequest(unauthorized, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "widget_cancel", arguments: { id: "int_missing" } },
      }),
      /401/,
    );
  } finally {
    await handle.close();
    broker.close();
  }
});

test("async tool calls and widget_await work over HTTP", async () => {
  const broker = new InteractionBroker();
  const handle = await startInteractionServer({ broker, port: 0, token: "daemon-token", allowCreate: true });
  const transport = createHttpInteractionTransport({ baseUrl: handle.baseUrl, token: handle.token });
  try {
    const created = await handleMcpRequest(transport, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "widget_choose", arguments: { prompt: "Pick", options: ["A", "B"], async: true } },
    });
    const { id, status } = JSON.parse(created.result.content[0].text);
    assert.equal(status, "pending");
    assert.ok(id);

    const waiting = handleMcpRequest(transport, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "widget_await", arguments: { id } } });
    const answered = await answer(handle, id, { value: { id: "B", label: "B" } });
    assert.equal(answered.status, 200);
    const envelope = JSON.parse((await waiting).result.content[0].text);
    assert.equal(envelope.status, "answered");
    assert.deepEqual(envelope.value, { id: "B", label: "B" });

    // A late wait replays the stored envelope instead of failing with 409.
    const late = await handleMcpRequest(transport, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "widget_await", arguments: { id } } });
    assert.equal(JSON.parse(late.result.content[0].text).status, "answered");
  } finally {
    await handle.close();
    broker.close();
  }
});
