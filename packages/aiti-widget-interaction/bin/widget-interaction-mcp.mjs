#!/usr/bin/env node
/**
 * Minimal MCP stdio server for @aiti-ai/widget-interaction.
 *
 * The Host (this process) owns pending requests; the browser page is a renderer.
 * stdout carries JSON-RPC only; diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import {
  InteractionBroker,
  InteractionWidgetWindow,
  createHttpInteractionTransport,
  withInteractionParams,
  handleMcpRequest,
  startInteractionServer,
} from "../dist/index.js";

const args = process.argv.slice(2);
const argValue = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

if (has("--help") || has("-h")) {
  process.stderr.write("widget-interaction-mcp [--port N] [--token T] [--width N] [--height N] [--widget-bin PATH] [--no-widget]\n"      + "  --http <baseUrl>  proxy to a running `aiti-dialog --daemon` instead of owning the broker\n"
      + "  --notify          emit notifications/aiti/interaction when a request resolves (local mode)\n");
  process.exit(0);
}

const remoteBase = argValue("--http", "");
if (remoteBase) {
  // Remote mode: a long-lived `aiti-dialog --daemon` owns the broker and the window,
  // so several MCP clients and CLI callers share one interaction surface.
  const transport = createHttpInteractionTransport({ baseUrl: remoteBase, token: argValue("--token", "") });
  const writeRemote = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  const remote = createInterface({ input: process.stdin, crlfDelay: Infinity });
  remote.on("line", (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      writeRemote({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${String(error?.message || error)}` } });
      return;
    }
    void handleMcpRequest(transport, request, { disableCustom: true })
      .then((response) => {
        if (response) writeRemote(response);
      })
      .catch((error) => {
        writeRemote({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32603, message: String(error?.message || error) } });
      });
  });
  remote.on("close", () => process.exit(0));
} else {
  const broker = new InteractionBroker();
  const requestedToken = argValue("--token", "");
  const server = await startInteractionServer({
    broker,
    port: Number(argValue("--port", "0")) || 0,
    // Random token by default: every local process shares the loopback interface.
    ...(requestedToken ? { token: requestedToken } : {}),
  });
  const window = new InteractionWidgetWindow({
    bin: argValue("--widget-bin", ""),
    width: Number(argValue("--width", "560")) || 560,
    height: Number(argValue("--height", "260")) || 260,
    title: "aiti interaction",
  });
  const wantWidget = !has("--no-widget");
  if (wantWidget) {
    try {
      const opened = await window.open(server.url);
      if (!opened) process.stderr.write(`[widget-interaction] widget binary not found; open ${server.url}\n`);
    } catch (error) {
      process.stderr.write(`[widget-interaction] widget open failed: ${String(error?.message || error)}; open ${server.url}\n`);
    }
  } else {
    process.stderr.write(`[widget-interaction] server ready: ${server.url}\n`);
  }

  const write = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  // Custom requests need the window on the host page; ordinary kinds return to the
  // built-in page (which re-syncs pending state from the broker snapshot).
  let currentPage = server.url;
  const showPage = (url) => {
    if (!url || url === currentPage) return;
    currentPage = url;
    void window.open(url);
  };
  const openCustomPage = (opened) => {
    const request = opened?.request;
    const page = request && request.kind === "custom" ? String(request.custom?.pageUrl || "") : "";
    if (page) {
      showPage(withInteractionParams(page, server.baseUrl, server.token));
      return;
    }
    showPage(server.url);
  };

  if (has("--notify")) {
    broker.subscribe((event) => {
      if (event.type !== "resolved") return;
      write({ jsonrpc: "2.0", method: "notifications/aiti/interaction", params: { id: event.id, result: event.result } });
    });
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await window.close(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
    broker.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  rl.on("line", (line) => {
    if (closing || !line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${String(error?.message || error)}` } });
      return;
    }
    void handleMcpRequest(broker, request, { onOpened: openCustomPage }).then((response) => {
      if (response) write(response);
    }).catch((error) => {
      write({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32603, message: String(error?.message || error) } });
    });
  });
  rl.on("close", () => { void shutdown(); });
}
