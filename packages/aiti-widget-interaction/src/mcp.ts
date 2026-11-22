import type { InteractionRequest, InteractionRequestInput, InteractionResult } from "./types.ts";

export interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Ask/cancel surface used by the MCP adapter. `InteractionBroker` satisfies it directly;
 * `createHttpInteractionTransport` talks to a running `aiti-dialog --daemon` instead,
 * so an MCP client can share one window with local CLI callers.
 */
export interface InteractionTransport {
  ask(input: InteractionRequestInput): Promise<InteractionResult>;
  cancel(id: string): boolean | Promise<boolean>;
  /** Create a pending request without waiting (MCP `async: true`). */
  open(input: InteractionRequestInput): { id: string; request?: InteractionRequest } | Promise<{ id: string; request?: InteractionRequest }>;
  /** Await a request by id; null when the id was never seen. */
  wait(id: string): Promise<InteractionResult> | null;
}

export interface HttpTransportOptions {
  /** Daemon base URL, e.g. `http://127.0.0.1:18095/` (from `aiti-dialog --daemon`). */
  baseUrl: string;
  token?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function createHttpInteractionTransport(options: HttpTransportOptions): InteractionTransport {
  const base = String(options.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("createHttpInteractionTransport: baseUrl is required");
  const token = String(options.token || "");
  const request = options.fetchImpl || fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const call = async (path: string, init: RequestInit = {}): Promise<Record<string, any>> => {
    const response = await request(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    let body: Record<string, any> = {};
    try {
      body = (await response.json()) as Record<string, any>;
    } catch {
      body = {};
    }
    if (!response.ok) {
      throw new Error(`interaction daemon ${path} failed (${response.status}): ${body.error || response.statusText || "unknown error"}`);
    }
    return body;
  };

  const open: InteractionTransport["open"] = async (input) => {
    const created = await call("/interactions", { method: "POST", body: JSON.stringify({ request: input }) });
    const id = String(created.id || created.request?.id || "");
    if (!id) throw new Error("interaction daemon returned no id");
    return { id, request: created.request as InteractionRequest | undefined };
  };

  const wait: InteractionTransport["wait"] = async (id) => {
    const response = await request(`${base}/interactions/${encodeURIComponent(id)}/wait`, { headers });
    if (response.status === 409) return null;
    let body: Record<string, any> = {};
    try {
      body = (await response.json()) as Record<string, any>;
    } catch {
      body = {};
    }
    if (!response.ok) throw new Error(`interaction daemon wait failed (${response.status}): ${body.error || response.statusText || "unknown error"}`);
    return body.result as InteractionResult;
  };

  return {
    open,
    wait,
    async ask(input) {
      const created = await open(input);
      return (await wait(created.id)) as InteractionResult;
    },
    async cancel(id) {
      const response = await request(`${base}/interactions/${encodeURIComponent(id)}/cancel`, { method: "POST", headers });
      if (response.status === 409) return false;
      if (!response.ok) {
        let message = response.statusText;
        try {
          message = (await response.json()).error || message;
        } catch {
          /* keep statusText */
        }
        throw new Error(`interaction daemon cancel failed (${response.status}): ${message}`);
      }
      return true;
    },
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

const common = {
  prompt: { type: "string", description: "Question or instruction for the human." },
  title: { type: "string", description: "Optional card title." },
  detail: { type: "string", description: "Optional secondary explanation." },
  timeout: { type: "number", description: "Timeout in milliseconds; 0 or omitted means wait forever." },
  async: { type: "boolean", description: "Return {id, status:'pending'} immediately and collect the answer with widget_await." },
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "widget_confirm",
    description: "Ask the human a yes/no question in the aiti widget interaction window. Returns {status, approved, comment, tookMs, timeoutMs}.",
    inputSchema: { type: "object", properties: { ...common, prompt: { type: "string" } }, required: ["prompt"] },
  },
  {
    name: "widget_choose",
    description: "Ask the human to choose one option in the widget. Returns {status, value:{id,label}, comment, tookMs}.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        options: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
      },
      required: ["prompt", "options"],
    },
  },
  {
    name: "widget_input",
    description: "Ask the human to type text in the widget. Returns {status, value:{text}, comment, tookMs}.",
    inputSchema: {
      type: "object",
      properties: { ...common, placeholder: { type: "string" }, defaultValue: { type: "string" }, secret: { type: "boolean" } },
      required: ["prompt"],
    },
  },
  {
    name: "widget_presence",
    description: "Ask the human to confirm they are present. Returns the same envelope as widget_confirm.",
    inputSchema: { type: "object", properties: common, required: ["prompt"] },
  },
  {
    name: "widget_notify",
    description: "Show a blocking notification card until the human dismisses it. For fire-and-forget notifications use a host notification instead.",
    inputSchema: { type: "object", properties: { ...common, body: { type: "string" } }, required: ["prompt"] },
  },
  {
    name: "widget_pick_path",
    description: "Ask the human to pick files or a directory with the native picker. Returns {status, value:{paths:[...]}, tookMs}.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        mode: { type: "string", enum: ["file", "directory"], description: "Defaults to file." },
        multiple: { type: "boolean", description: "Allow selecting more than one path." },
        extensions: { type: "array", items: { type: "string" }, description: "File extension filters, e.g. [\"png\", \"jpg\"]." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "widget_await",
    description: "Wait for the result of a request created with async:true. Returns the same envelope as the blocking tools (status timeout + pending:true when the local wait expires).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Request id returned by an async tool call." },
        timeout: { type: "number", description: "Client-side wait cap in milliseconds; the host request stays pending. 0 = wait until resolved." },
      },
      required: ["id"],
    },
  },
  {
    name: "widget_custom",
    description: "Render a host-provided loopback page for a custom interaction. Requires the in-process MCP server (it navigates the window to `page`); the page receives {base, token} query params.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        page: { type: "string", description: "Loopback page URL, e.g. http://127.0.0.1:9000/custom.html." },
        data: { description: "Arbitrary JSON handed to the page as request.data." },
        keepOpen: { type: "boolean", description: "Keep the request pending after an answer (host resolves it later)." },
      },
      required: ["page"],
    },
  },
  {
    name: "widget_cancel",
    description: "Cancel a pending widget interaction by id. No-op/404 if already resolved.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}
function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Custom pages carry the broker token, so only loopback origins are accepted. */
function isLoopbackPage(page: string): boolean {
  if (!page) return false;
  try {
    const url = new URL(page);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function toRequest(name: string, args: Record<string, unknown>): InteractionRequestInput | null {
  const prompt = asString(args.prompt || args.message);
  const title = asString(args.title) || prompt;
  const detail = asString(args.detail || args.body);
  const timeoutMs = Math.max(0, asNumber(args.timeout, 0));
  if (name === "widget_confirm" || name === "widget_presence") {
    return { kind: "confirm", title, message: prompt, detail, timeoutMs, actions: [
      { id: "approve", label: "Continue", kind: "primary" },
      { id: "reject", label: "Cancel", kind: "danger" },
    ] };
  }
  if (name === "widget_choose") {
    const options = Array.isArray(args.options) ? args.options.map(String).slice(0, 8) : [];
    if (!options.length) return null;
    return { kind: "choose", title, message: prompt, detail, options, timeoutMs };
  }
  if (name === "widget_input") {
    return {
      kind: "input", title, message: prompt, detail, timeoutMs,
      input: {
        placeholder: asString(args.placeholder),
        defaultValue: asString(args.defaultValue),
        secret: args.secret === true,
      },
    };
  }
  if (name === "widget_pick_path") {
    const mode = asString(args.mode) === "directory" ? "directory" : "file";
    const extensions = Array.isArray(args.extensions) ? args.extensions.map(String).filter(Boolean).slice(0, 8) : undefined;
    return {
      kind: "pick_path",
      title,
      message: prompt,
      detail,
      timeoutMs,
      pick: { mode, multiple: args.multiple === true, ...(extensions?.length ? { extensions } : {}) },
    };
  }
  if (name === "widget_custom") {
    const page = asString(args.page);
    if (!isLoopbackPage(page)) return null;
    return {
      kind: "custom",
      title: title || "Custom interaction",
      message: prompt,
      detail,
      timeoutMs,
      keepOpen: args.keepOpen === true,
      // `data` is the canonical host payload (pages read request.data); the custom spec
      // only carries the page URL.
      data: args.data,
      custom: { pageUrl: page },
    };
  }
  if (name === "widget_notify") {
    return { kind: "notify", title, message: prompt, detail: prompt, timeoutMs: 0 };
  }
  return null;
}

export interface McpOptions {
  /** Called right after a request is created; hosts use it to navigate a custom page. */
  onOpened?: (opened: { id: string; request?: InteractionRequest }) => void;
  /** Reject widget_custom: a daemon cannot navigate its shared window per request. */
  disableCustom?: boolean;
}

/** Minimal MCP stdio handler. The caller owns transport/JSON parsing. */
export async function handleMcpRequest(
  transport: InteractionTransport,
  request: McpRequest,
  options: McpOptions = {},
): Promise<Record<string, unknown> | null> {
  const id = request.id;
  const respond = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const method = String(request.method || "");
  if (method === "initialize") {
    return respond({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "aiti-widget-interaction", version: "0.1.0" },
      instructions: "Use widget_confirm/widget_choose/widget_input to ask the human. The browser page owns only rendering; pending state and callbacks belong to this server.",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return respond({});
  if (method === "tools/list") return respond({ tools: MCP_TOOLS });
  if (method === "tools/call") {
    const params = (request.params || {}) as Record<string, unknown>;
    const name = asString(params.name);
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
    if (name === "widget_cancel") {
      const ok = await transport.cancel(asString(args.id));
      if (!ok) return fail(-32602, `no pending interaction ${asString(args.id)}`);
      return respond(text({ ok: true }));
    }
    if (name === "widget_await") {
      const id = asString(args.id);
      if (!id) return fail(-32602, "widget_await requires an id");
      const waiting = transport.wait(id);
      if (!waiting) return fail(-32602, `no pending interaction ${id}`);
      const cap = Math.max(0, asNumber(args.timeout, 0));
      if (!cap) {
        return respond(text(await waiting));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = await Promise.race([
        waiting,
        new Promise((resolveCap) => {
          timer = setTimeout(() => resolveCap({ id, status: "timeout", pending: true }), cap);
        }),
      ]);
      if (timer) clearTimeout(timer);
      return respond(text(capped));
    }
    if (name === "widget_custom" && options.disableCustom) {
      return fail(-32602, "widget_custom needs the in-process MCP server (a daemon cannot navigate its shared window)");
    }
    const input = toRequest(name, args);
    if (!input) return fail(-32602, `unknown tool or invalid arguments: ${name}`);
    const opened = await transport.open(input);
    options.onOpened?.(opened);
    if (args.async === true) {
      return respond(text({ id: opened.id, status: "pending" }));
    }
    const waiting = transport.wait(opened.id);
    if (!waiting) return fail(-32603, `interaction ${opened.id} disappeared before it could be awaited`);
    return respond(text(await waiting));
  }
  return fail(-32601, `method not found: ${method}`);
}
