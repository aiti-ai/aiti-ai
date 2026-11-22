import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { InteractionBroker, startInteractionServer } from "../dist/index.js";

const BIN = fileURLToPath(new URL("../bin/widget-interaction-mcp.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("--notify emits notifications/aiti/interaction when a request resolves", async () => {
  const child = spawn(process.execPath, [BIN, "--no-widget", "--notify"], { stdio: ["pipe", "pipe", "pipe"] });
  const replies = [];
  let stderr = "";
  let buffer = "";
  child.stdout.on("data", (data) => {
    buffer += data;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  try {
    for (let attempt = 0; attempt < 40 && !/server ready: /.test(stderr); attempt += 1) await sleep(50);
    const match = /server ready: (\S+)/.exec(stderr);
    assert.ok(match, `server URL missing: ${stderr}`);
    const pageUrl = new URL(match[1]);
    const token = pageUrl.searchParams.get("token");
    const base = pageUrl.origin;

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "widget_confirm", arguments: { prompt: "Notify?", async: true } } });
    for (let attempt = 0; attempt < 40 && !replies.some((entry) => entry.id === 1); attempt += 1) await sleep(50);
    const created = JSON.parse(replies.find((entry) => entry.id === 1).result.content[0].text);
    assert.equal(created.status, "pending");

    const answer = await fetch(`${base}/interactions/${created.id}/answer?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", approved: true }),
    });
    assert.equal(answer.status, 200);

    for (let attempt = 0; attempt < 40 && !replies.some((entry) => entry.method === "notifications/aiti/interaction"); attempt += 1) await sleep(50);
    const notification = replies.find((entry) => entry.method === "notifications/aiti/interaction");
    assert.ok(notification, `no notification in ${JSON.stringify(replies)}`);
    assert.equal(notification.params.id, created.id);
    assert.equal(notification.params.result.status, "answered");
    assert.equal(notification.params.result.approved, true);
  } finally {
    child.kill("SIGKILL");
  }
});

test("--notify works against a daemon over --http", async () => {
  const broker = new InteractionBroker();
  const handle = await startInteractionServer({ broker, port: 0, token: "notify-token", allowCreate: true });
  const child = spawn(process.execPath, [BIN, "--http", handle.baseUrl, "--token", handle.token, "--notify"], { stdio: ["pipe", "pipe", "pipe"] });
  const replies = [];
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    buffer += data;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "widget_confirm", arguments: { prompt: "Remote?", async: true } } })}\n`);
    for (let attempt = 0; attempt < 60 && !replies.some((entry) => entry.id === 2); attempt += 1) await sleep(50);
    const created = JSON.parse(replies.find((entry) => entry.id === 2).result.content[0].text);
    assert.equal(created.status, "pending");

    const answer = await fetch(`${handle.baseUrl}interactions/${created.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer notify-token" },
      body: JSON.stringify({ action: "approve", approved: true }),
    });
    assert.equal(answer.status, 200);

    for (let attempt = 0; attempt < 60 && !replies.some((entry) => entry.method === "notifications/aiti/interaction"); attempt += 1) await sleep(50);
    const notification = replies.find((entry) => entry.method === "notifications/aiti/interaction");
    assert.ok(notification, `no notification in ${JSON.stringify(replies)} stderr=${stderr}`);
    assert.equal(notification.params.id, created.id);
    assert.equal(notification.params.result.status, "answered");
  } finally {
    child.kill("SIGKILL");
    await handle.close();
    broker.close();
  }
});
