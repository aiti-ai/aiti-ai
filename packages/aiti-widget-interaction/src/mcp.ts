import type { InteractionRequestInput, InteractionResult } from "./types.ts";

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

  return {
    async ask(input) {
      const created = await call("/interactions", { method: "POST", body: JSON.stringify({ request: input }) });
      const id = String(created.id || created.request?.id || "");
      if (!id) throw new Error("interaction daemon returned no id");
      const waited = await call(`/interactions/${encodeURIComponent(id)}/wait`);
      return waited.result as InteractionResult;
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
  if (name === "widget_notify") {
    return { kind: "notify", title, message: prompt, detail: prompt, timeoutMs: 0 };
  }
  return null;
}

/** Minimal MCP stdio handler. The caller owns transport/JSON parsing. */
export async function handleMcpRequest(transport: InteractionTransport, request: McpRequest): Promise<Record<string, unknown> | null> {
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
    const input = toRequest(name, args);
    if (!input) return fail(-32602, `unknown tool or invalid arguments: ${name}`);
    const result = await transport.ask(input);
    return respond(text(result));
  }
  return fail(-32601, `method not found: ${method}`);
}
