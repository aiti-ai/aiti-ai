// src/broker.ts
import { randomUUID } from "node:crypto";
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function normalizeRequest(input, id, now, defaultTimeoutMs) {
  const timeoutValue = input.timeoutMs ?? defaultTimeoutMs;
  const options = (input.options || []).map((option) => typeof option === "string" ? { id: option, label: option } : { ...option });
  const state = input.state ? { ...input.state } : {};
  return {
    id,
    version: 1,
    kind: input.kind,
    title: String(input.title || ""),
    message: String(input.message || ""),
    detail: String(input.detail || ""),
    options,
    actions: Array.isArray(input.actions) ? input.actions.map((action) => ({ ...action })) : [],
    input: { ...input.input || {} },
    pick: { ...input.pick || {} },
    custom: { ...input.custom || {} },
    timeoutMs: Math.max(0, Number.isFinite(Number(timeoutValue)) ? Number(timeoutValue) : 0),
    keepOpen: input.keepOpen === true,
    data: input.data,
    state,
    agent: input.agent ? { ...input.agent } : void 0,
    createdAt: new Date(now).toISOString()
  };
}
var InteractionBroker = class {
  constructor(options = {}) {
    this.entries = /* @__PURE__ */ new Map();
    /** Recently resolved envelopes, so a late `wait()` (daemon HTTP) still gets the result. */
    this.settled = /* @__PURE__ */ new Map();
    this.listeners = /* @__PURE__ */ new Set();
    this.closed = false;
    this.defaultTimeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    this.idFactory = options.idFactory || (() => `int_${randomUUID()}`);
    this.now = options.now || (() => Date.now());
  }
  /** Create a request and wait for its final result. */
  ask(input) {
    return this.open(input).result;
  }
  /** Create a request and return its id/request/result without awaiting. */
  open(input) {
    if (this.closed) throw new Error("interaction broker is closed");
    const id = this.idFactory();
    const request = normalizeRequest(input, id, this.now(), this.defaultTimeoutMs);
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    const entry = {
      request,
      result: {
        id,
        status: "answered",
        action: void 0,
        value: void 0,
        comment: void 0,
        reason: void 0,
        state: {},
        tookMs: 0,
        timeoutMs: request.timeoutMs
      },
      promise,
      resolve,
      timer: null,
      startedAt: this.now(),
      done: false
    };
    this.entries.set(id, entry);
    if (request.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        this.finish(entry, {
          ...entry.result,
          status: "timeout",
          reason: "timeout",
          tookMs: this.now() - entry.startedAt
        });
      }, request.timeoutMs);
    }
    this.emit({ type: "request", request: clone(request) });
    return { id, request: clone(request), result: promise };
  }
  /** Submit an answer from a renderer. Late/duplicate answers are rejected. */
  answer(id, input = {}) {
    const entry = this.entries.get(String(id));
    if (!entry || entry.done) {
      return { ok: false, code: "not_found", error: "no pending interaction with that id" };
    }
    const state = { ...entry.request.state || {}, ...input.state || {} };
    if (input.keepOpen === true) {
      entry.request.state = state;
      state.lastAction = input.action;
      if (input.value !== void 0) state.value = input.value;
      this.emit({ type: "update", id: entry.request.id, request: clone(entry.request), state: clone(state) });
      return { ok: true, code: "keep_open", keepOpen: true, state: clone(state) };
    }
    const status = input.action === "cancel" ? "cancelled" : "answered";
    const result = {
      id: entry.request.id,
      status,
      action: input.action,
      approved: input.approved,
      value: input.value,
      comment: input.comment,
      reason: input.reason,
      state,
      tookMs: this.now() - entry.startedAt,
      timeoutMs: entry.request.timeoutMs
    };
    this.finish(entry, result);
    return { ok: true, result };
  }
  /** Host-only state update for custom/keep-open UI. */
  update(id, state) {
    const entry = this.entries.get(String(id));
    if (!entry || entry.done) return false;
    entry.request.state = { ...entry.request.state || {}, ...state };
    this.emit({ type: "update", id: entry.request.id, request: clone(entry.request), state: clone(entry.request.state) });
    return true;
  }
  /** Host-only final resolution (used by custom/keep-open flows). */
  resolve(id, result = {}) {
    const entry = this.entries.get(String(id));
    if (!entry || entry.done) return false;
    this.finish(entry, {
      id: entry.request.id,
      status: result.status || "answered",
      action: result.action,
      approved: result.approved,
      value: result.value,
      comment: result.comment,
      reason: result.reason,
      state: result.state || entry.request.state,
      tookMs: this.now() - entry.startedAt,
      timeoutMs: entry.request.timeoutMs
    });
    return true;
  }
  /** Host-only cancellation. */
  cancel(id, reason = "cancelled") {
    const entry = this.entries.get(String(id));
    if (!entry || entry.done) return false;
    this.finish(entry, {
      ...entry.result,
      status: "cancelled",
      reason,
      tookMs: this.now() - entry.startedAt
    });
    return true;
  }
  /** Snapshot of all pending requests, oldest first. */
  pending() {
    return [...this.entries.values()].filter((entry) => !entry.done).sort((a, b) => a.startedAt - b.startedAt).map((entry) => clone(entry.request));
  }
  /** Await an existing request's final result (daemon / HTTP wait). */
  wait(id) {
    const entry = this.entries.get(String(id));
    if (entry && !entry.done) return entry.promise;
    const settled = this.settled.get(String(id));
    return settled ? Promise.resolve(settled) : null;
  }
  has(id) {
    return !!this.entries.get(String(id));
  }
  /** SSE/browser subscription. The initial snapshot is delivered synchronously. */
  subscribe(listener) {
    this.listeners.add(listener);
    try {
      listener({ type: "snapshot", requests: this.pending() });
    } catch {
    }
    return () => this.listeners.delete(listener);
  }
  /** Close all pending requests and reject future requests. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.entries.values()]) {
      this.finish(entry, {
        ...entry.result,
        status: "cancelled",
        reason: "broker closed",
        tookMs: this.now() - entry.startedAt
      });
    }
    this.listeners.clear();
  }
  finish(entry, result) {
    if (entry.done) return;
    entry.done = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.entries.delete(entry.request.id);
    entry.resolve(result);
    this.settled.set(entry.request.id, result);
    while (this.settled.size > 64) this.settled.delete(this.settled.keys().next().value);
    this.emit({ type: "resolved", id: entry.request.id, result });
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }
};

// src/server.ts
import { createServer } from "node:http";
import { randomUUID as randomUUID2 } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};
function json(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}
function tokenOf(req, url) {
  const auth = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : String(url.searchParams.get("token") || "");
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function serveFile(res, path, contentType) {
  try {
    const body = readFileSync(path);
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}
async function startInteractionServer(options) {
  const host = options.host || "127.0.0.1";
  const port = Number.isInteger(options.port) ? Number(options.port) : 0;
  const token = options.token === void 0 ? randomUUID2() : String(options.token);
  const pageDir = options.pageDir || fileURLToPath(new URL("../page/", import.meta.url));
  const pageFile = options.pageFile || "interaction.html";
  const clientFile = options.clientFile || "interaction-client.js";
  const sseClients = /* @__PURE__ */ new Set();
  const authorized = (req, url2) => token === "" || tokenOf(req, url2) === token;
  const server = createServer(async (req, res) => {
    const url2 = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, JSON_HEADERS);
      res.end();
      return;
    }
    try {
      if (req.method === "GET" && (url2.pathname === "/" || url2.pathname === "/index.html")) {
        serveFile(res, join(pageDir, pageFile), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url2.pathname === "/interaction-client.js") {
        serveFile(res, join(pageDir, clientFile), "text/javascript; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url2.pathname === "/health") {
        json(res, 200, { ok: true, pending: options.broker.pending().length });
        return;
      }
      if (!authorized(req, url2)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url2.pathname === "/interactions/pending") {
        json(res, 200, { ok: true, requests: options.broker.pending() });
        return;
      }
      if (req.method === "GET" && url2.pathname === "/interactions/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": "*"
        });
        res.write("retry: 1000\n\n");
        sseClients.add(res);
        const write = (event) => {
          try {
            res.write(`data: ${JSON.stringify(event)}

`);
          } catch {
          }
        };
        const unsubscribe = options.broker.subscribe(write);
        const heartbeat = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
          }
        }, 15e3);
        heartbeat.unref?.();
        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          sseClients.delete(res);
        };
        req.on("close", cleanup);
        req.on("error", cleanup);
        return;
      }
      if (options.allowCreate && req.method === "POST" && url2.pathname === "/interactions") {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          json(res, 400, { error: String(error?.message || error) });
          return;
        }
        const spec = body.request && typeof body.request === "object" ? body.request : body;
        if (!spec || typeof spec.kind !== "string") {
          json(res, 400, { error: "request.kind is required" });
          return;
        }
        const opened = options.broker.open(spec);
        try {
          options.onCreate?.(opened.request);
        } catch {
        }
        json(res, 200, { ok: true, id: opened.id, request: opened.request });
        return;
      }
      const waitMatch = /^\/interactions\/([^/]+)\/wait$/.exec(url2.pathname);
      if (req.method === "GET" && waitMatch) {
        const id = decodeURIComponent(waitMatch[1]);
        const pending = options.broker.wait(id);
        if (!pending) {
          json(res, 409, { error: "no pending interaction with that id" });
          return;
        }
        const result = await pending;
        json(res, 200, { ok: true, result });
        return;
      }
      const oneMatch = /^\/interactions\/([^/]+)$/.exec(url2.pathname);
      if (req.method === "GET" && oneMatch) {
        const id = decodeURIComponent(oneMatch[1]);
        const request = options.broker.pending().find((r) => r.id === id);
        if (!request) {
          json(res, 404, { error: "no pending interaction with that id" });
          return;
        }
        json(res, 200, { ok: true, request });
        return;
      }
      const answerMatch = /^\/interactions\/([^/]+)\/answer$/.exec(url2.pathname);
      if (req.method === "POST" && answerMatch) {
        const id = decodeURIComponent(answerMatch[1]);
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          json(res, 400, { error: String(error?.message || error) });
          return;
        }
        const outcome = options.broker.answer(id, body);
        if (!outcome.ok) {
          const status = outcome.code === "not_found" ? 409 : 400;
          json(res, status, { error: outcome.error || "answer failed", ...outcome });
          return;
        }
        json(res, 200, { ok: true, ...outcome });
        return;
      }
      const cancelMatch = /^\/interactions\/([^/]+)\/cancel$/.exec(url2.pathname);
      if (req.method === "POST" && cancelMatch) {
        const id = decodeURIComponent(cancelMatch[1]);
        const ok = options.broker.cancel(id, "cancelled by renderer");
        json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "no pending interaction with that id" });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 500, { error: String(error?.message || error) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}/`;
  const url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
  return {
    server,
    port: actualPort,
    host,
    baseUrl,
    url,
    token,
    close: async () => {
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
        }
      }
      sseClients.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

// src/widget-window.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function resolveWidgetBinary(explicit) {
  const candidates = [
    explicit,
    process.env.AITI_DESKTOP_WIDGET_BIN,
    join2(homedir(), ".pi", "bin", process.platform === "win32" ? "aiti-desktop-widget.exe" : "aiti-desktop-widget")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
    }
  }
  return candidates.length ? candidates[0] : null;
}
function withInteractionParams(pageUrl, baseUrl, token = "") {
  const url = new URL(pageUrl);
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  url.searchParams.set("base", base);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
var InteractionWidgetWindow = class {
  constructor(options = {}) {
    this.child = null;
    this.lastUrl = "";
    this.options = {
      ...options,
      width: Math.max(240, Math.round(Number(options.width) || 560)),
      height: Math.max(120, Math.round(Number(options.height) || 260)),
      title: String(options.title || "aiti interaction")
    };
  }
  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }
  async open(url) {
    this.lastUrl = url;
    if (this.running) {
      try {
        this.child.stdin.write(`${JSON.stringify({ cmd: "navigate", url })}
`);
        return true;
      } catch {
        this.child = null;
      }
    }
    const bin = resolveWidgetBinary(this.options.bin);
    if (!bin) return false;
    const args = [
      "--url",
      url,
      "--width",
      String(this.options.width),
      "--height",
      String(this.options.height),
      "--title",
      this.options.title,
      "--always-on-top",
      "true",
      "--focusable",
      "true",
      "--click-through",
      "false",
      "--skip-taskbar",
      "true",
      "--all-workspaces",
      "true",
      "--resizable",
      "true",
      ...this.options.args || []
    ];
    try {
      const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      this.child = child;
      child.once("exit", () => {
        if (this.child === child) this.child = null;
      });
      child.once("error", () => {
        if (this.child === child) this.child = null;
      });
      return true;
    } catch {
      this.child = null;
      return false;
    }
  }
  /** Re-open the most recent URL (used after the user closed the window). */
  async reopen() {
    return this.lastUrl ? this.open(this.lastUrl) : false;
  }
  async close() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ cmd: "close" })}
`);
    } catch {
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
        resolve();
      }, 800);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
};

// src/mcp.ts
function createHttpInteractionTransport(options) {
  const base = String(options.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("createHttpInteractionTransport: baseUrl is required");
  const token = String(options.token || "");
  const request = options.fetchImpl || fetch;
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const call = async (path, init = {}) => {
    const response = await request(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) {
      throw new Error(`interaction daemon ${path} failed (${response.status}): ${body.error || response.statusText || "unknown error"}`);
    }
    return body;
  };
  return {
    async ask(input) {
      const created = await call("/interactions", { method: "POST", body: JSON.stringify({ request: input }) });
      const id = String(created.id || created.request?.id || "");
      if (!id) throw new Error("interaction daemon returned no id");
      const waited = await call(`/interactions/${encodeURIComponent(id)}/wait`);
      return waited.result;
    },
    async cancel(id) {
      const response = await request(`${base}/interactions/${encodeURIComponent(id)}/cancel`, { method: "POST", headers });
      if (response.status === 409) return false;
      if (!response.ok) {
        let message = response.statusText;
        try {
          message = (await response.json()).error || message;
        } catch {
        }
        throw new Error(`interaction daemon cancel failed (${response.status}): ${message}`);
      }
      return true;
    }
  };
}
var text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
var common = {
  prompt: { type: "string", description: "Question or instruction for the human." },
  title: { type: "string", description: "Optional card title." },
  detail: { type: "string", description: "Optional secondary explanation." },
  timeout: { type: "number", description: "Timeout in milliseconds; 0 or omitted means wait forever." }
};
var MCP_TOOLS = [
  {
    name: "widget_confirm",
    description: "Ask the human a yes/no question in the aiti widget interaction window. Returns {status, approved, comment, tookMs, timeoutMs}.",
    inputSchema: { type: "object", properties: { ...common, prompt: { type: "string" } }, required: ["prompt"] }
  },
  {
    name: "widget_choose",
    description: "Ask the human to choose one option in the widget. Returns {status, value:{id,label}, comment, tookMs}.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        options: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }
      },
      required: ["prompt", "options"]
    }
  },
  {
    name: "widget_input",
    description: "Ask the human to type text in the widget. Returns {status, value:{text}, comment, tookMs}.",
    inputSchema: {
      type: "object",
      properties: { ...common, placeholder: { type: "string" }, defaultValue: { type: "string" }, secret: { type: "boolean" } },
      required: ["prompt"]
    }
  },
  {
    name: "widget_presence",
    description: "Ask the human to confirm they are present. Returns the same envelope as widget_confirm.",
    inputSchema: { type: "object", properties: common, required: ["prompt"] }
  },
  {
    name: "widget_notify",
    description: "Show a blocking notification card until the human dismisses it. For fire-and-forget notifications use a host notification instead.",
    inputSchema: { type: "object", properties: { ...common, body: { type: "string" } }, required: ["prompt"] }
  },
  {
    name: "widget_cancel",
    description: "Cancel a pending widget interaction by id. No-op/404 if already resolved.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
  }
];
function asString(value, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}
function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function toRequest(name, args) {
  const prompt = asString(args.prompt || args.message);
  const title = asString(args.title) || prompt;
  const detail = asString(args.detail || args.body);
  const timeoutMs = Math.max(0, asNumber(args.timeout, 0));
  if (name === "widget_confirm" || name === "widget_presence") {
    return { kind: "confirm", title, message: prompt, detail, timeoutMs, actions: [
      { id: "approve", label: "Continue", kind: "primary" },
      { id: "reject", label: "Cancel", kind: "danger" }
    ] };
  }
  if (name === "widget_choose") {
    const options = Array.isArray(args.options) ? args.options.map(String).slice(0, 8) : [];
    if (!options.length) return null;
    return { kind: "choose", title, message: prompt, detail, options, timeoutMs };
  }
  if (name === "widget_input") {
    return {
      kind: "input",
      title,
      message: prompt,
      detail,
      timeoutMs,
      input: {
        placeholder: asString(args.placeholder),
        defaultValue: asString(args.defaultValue),
        secret: args.secret === true
      }
    };
  }
  if (name === "widget_notify") {
    return { kind: "notify", title, message: prompt, detail: prompt, timeoutMs: 0 };
  }
  return null;
}
async function handleMcpRequest(transport, request) {
  const id = request.id;
  const respond = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const method = String(request.method || "");
  if (method === "initialize") {
    return respond({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "aiti-widget-interaction", version: "0.1.0" },
      instructions: "Use widget_confirm/widget_choose/widget_input to ask the human. The browser page owns only rendering; pending state and callbacks belong to this server."
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return respond({});
  if (method === "tools/list") return respond({ tools: MCP_TOOLS });
  if (method === "tools/call") {
    const params = request.params || {};
    const name = asString(params.name);
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    if (name === "widget_cancel") {
      const ok = await transport.cancel(asString(args.id));
      if (!ok) return fail(-32602, `no pending interaction ${asString(args.id)}`);
      return respond(text({ ok: true }));
    }
    const input = toRequest(name, args);
    if (!input) return fail(-32602, `unknown tool or invalid arguments: ${name}`);
    const result = await transport.ask(input);
    return respond(text(result));
  }
  return fail(-32601, `method not found: ${method}`);
}

// src/dialog-kinds.ts
var DEFAULT_TITLES = {
  confirm: "Confirm",
  choose: "Choose",
  input: "Input",
  file: "Choose file",
  directory: "Choose folder",
  notify: "Notice"
};
function dialogToRequest(spec) {
  const text2 = String(spec.text || "");
  const title = String(spec.title || DEFAULT_TITLES[spec.kind] || "aiti-dialog");
  const detail = String(spec.detail || "");
  const timeoutMs = Math.max(0, Number(spec.timeoutMs) || 0);
  const ok = String(spec.okLabel || (spec.kind === "confirm" ? "OK" : "OK"));
  const cancel = String(spec.cancelLabel || "Cancel");
  if (spec.kind === "confirm") {
    return {
      kind: "confirm",
      title,
      message: text2,
      detail,
      timeoutMs,
      actions: [
        { id: "approve", label: ok, kind: "primary", value: true },
        { id: "reject", label: cancel, kind: "secondary", value: false }
      ]
    };
  }
  if (spec.kind === "choose") {
    const options = (spec.options || []).map((option) => String(option)).filter(Boolean);
    if (!options.length) throw new Error("choose requires at least one --options value");
    return { kind: "choose", title, message: text2, detail, timeoutMs, options: options.map((option) => ({ id: option, label: option })), actions: [] };
  }
  if (spec.kind === "input") {
    return {
      kind: "input",
      title,
      message: text2,
      detail,
      timeoutMs,
      input: {
        placeholder: String(spec.placeholder || ""),
        defaultValue: String(spec.defaultValue || ""),
        secret: spec.password === true
      },
      actions: [{ id: "submit", label: ok, kind: "primary" }]
    };
  }
  if (spec.kind === "file" || spec.kind === "directory") {
    return {
      kind: "pick_path",
      title,
      message: text2,
      detail,
      timeoutMs,
      pick: {
        mode: spec.kind === "directory" ? "directory" : "file",
        multiple: spec.multiple === true,
        extensions: (spec.filters || []).map((f) => String(f))
      },
      actions: [
        { id: "pick", label: ok, kind: "primary" },
        { id: "cancel", label: cancel, kind: "secondary" }
      ]
    };
  }
  if (spec.kind === "notify") {
    return {
      kind: "notify",
      title,
      message: text2,
      detail,
      timeoutMs,
      actions: [{ id: "dismiss", label: ok, kind: "primary" }]
    };
  }
  return {
    kind: "custom",
    title,
    message: text2,
    detail,
    timeoutMs,
    custom: { pageUrl: String(spec.page || ""), data: spec.data },
    data: spec.data,
    actions: []
  };
}
function dialogExitCode(result) {
  if (result.status === "timeout") return 5;
  if (result.status === "cancelled") return 1;
  if (result.status === "error") return 4;
  if (result.action === "cancel" || result.action === "reject") return 1;
  if (result.approved === false) return 1;
  return 0;
}
function stringValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value;
    if (typeof record.label === "string") return record.label;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.paths)) return record.paths.map(String).join("\n");
    if (typeof record.path === "string") return record.path;
    if (typeof record.id === "string") return record.id;
  }
  return "";
}
function dialogStdout(result, spec) {
  if (result.status !== "answered") return "";
  if (spec.kind === "confirm") return "";
  if (spec.kind === "notify") return "";
  const fromValue = stringValue(result.value);
  if (fromValue) return fromValue;
  if (spec.kind === "input") return "";
  return "";
}
function dialogWindowTitle(spec) {
  return String(spec.title || DEFAULT_TITLES[spec.kind] || "aiti-dialog");
}
function dialogWindowSize(spec) {
  if (spec.kind === "confirm") return { width: 420, height: 190 };
  if (spec.kind === "notify") return { width: 400, height: 160 };
  if (spec.kind === "input") return { width: 460, height: 230 };
  if (spec.kind === "choose") {
    const rows = Math.max(1, Math.min(8, (spec.options || []).length));
    return { width: 460, height: 170 + rows * 34 };
  }
  if (spec.kind === "file" || spec.kind === "directory") return { width: 460, height: 210 };
  return { width: 560, height: 300 };
}
export {
  InteractionBroker,
  InteractionWidgetWindow,
  MCP_TOOLS,
  createHttpInteractionTransport,
  dialogExitCode,
  dialogStdout,
  dialogToRequest,
  dialogWindowSize,
  dialogWindowTitle,
  handleMcpRequest,
  resolveWidgetBinary,
  startInteractionServer,
  withInteractionParams
};
