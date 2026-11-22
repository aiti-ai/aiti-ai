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
