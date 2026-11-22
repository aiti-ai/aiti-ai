import test from "node:test";
import assert from "node:assert/strict";
import { InteractionBroker, handleMcpRequest } from "../dist/index.js";

test("MCP initialize and tools/list expose the widget tools", async () => {
  const broker = new InteractionBroker();
  const init = await handleMcpRequest(broker, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "aiti-widget-interaction");
  const list = await handleMcpRequest(broker, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.ok(list.result.tools.some((tool) => tool.name === "widget_confirm"));
  assert.ok(list.result.tools.some((tool) => tool.name === "widget_input"));
  broker.close();
});

test("MCP tool call blocks and returns the host envelope on timeout", async () => {
  const broker = new InteractionBroker({ idFactory: () => "mcp-timeout" });
  const response = await handleMcpRequest(broker, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "widget_confirm", arguments: { prompt: "Continue?", timeout: 20 } },
  });
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.status, "timeout");
  broker.close();
});

function toolEnvelope(response) {
  return JSON.parse(response.result.content[0].text);
}

test("async tool call returns an id and widget_await collects the answer", async () => {
  const broker = new InteractionBroker({ idFactory: () => "async-1" });
  const created = await handleMcpRequest(broker, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "widget_confirm", arguments: { prompt: "Continue?", async: true } },
  });
  assert.deepEqual(toolEnvelope(created), { id: "async-1", status: "pending" });

  const waiting = handleMcpRequest(broker, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "widget_await", arguments: { id: "async-1" } } });
  broker.answer("async-1", { action: "approve", approved: true });
  const envelope = toolEnvelope(await waiting);
  assert.equal(envelope.status, "answered");
  assert.equal(envelope.approved, true);
  broker.close();
});

test("widget_await caps the client wait and leaves the host request pending", async () => {
  const broker = new InteractionBroker({ idFactory: () => "async-2" });
  await handleMcpRequest(broker, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "widget_confirm", arguments: { prompt: "Still there?", async: true } },
  });
  const capped = await handleMcpRequest(broker, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: { name: "widget_await", arguments: { id: "async-2", timeout: 20 } },
  });
  const envelope = toolEnvelope(capped);
  assert.equal(envelope.status, "timeout");
  assert.equal(envelope.pending, true);
  assert.equal(broker.pending().length, 1);

  const missing = await handleMcpRequest(broker, { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "widget_await", arguments: { id: "nope" } } });
  assert.equal(missing.error.code, -32602);
  broker.close();
});

test("widget_pick_path maps mode/multiple/extensions onto a pick request", async () => {
  const broker = new InteractionBroker({ idFactory: () => "pick-1" });
  await handleMcpRequest(broker, {
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: { name: "widget_pick_path", arguments: { prompt: "Pick a folder", mode: "directory", multiple: true, extensions: ["png", ""], async: true } },
  });
  const [request] = broker.pending();
  assert.equal(request.kind, "pick_path");
  assert.deepEqual(request.pick, { mode: "directory", multiple: true, extensions: ["png"] });
  broker.close();
});
