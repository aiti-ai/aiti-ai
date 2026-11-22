/* @aiti-ai/aiti-devtools-agent · 多 agent 接线层 · 构建产物，勿手改 */

// src/bridge-client.ts
var AgentBridgeClient = class {
  _bridgeUp = false;
  /** 桥地址（已剥尾部斜杠，含 /aiti 路径前缀等） */
  base;
  constructor(base) {
    this.base = base.replace(/\/+$/, "");
  }
  /** 桥当前连通状态（probe/register 成功置 true，失败置 false） */
  get isUp() {
    return this._bridgeUp;
  }
  /** 桥连通性预检（GET /bridge/sessions；本地拒绝连接即时返回） */
  async probe(timeoutMs = 2500) {
    try {
      const res = await fetch(this.base + "/bridge/sessions", { signal: AbortSignal.timeout(timeoutMs) });
      this._bridgeUp = res.ok;
      return res.ok;
    } catch {
      this._bridgeUp = false;
      return false;
    }
  }
  /** agent 启动注册（POST /bridge/agent/register）→ agentKey；失败返回 null */
  async register(opts) {
    try {
      const res = await fetch(this.base + "/bridge/agent/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5e3),
        body: JSON.stringify({
          agentId: opts.agentId,
          sessionId: opts.sessionId,
          name: opts.name,
          cwd: opts.cwd || void 0,
          source: opts.source || "extension",
          subEvents: opts.subEvents ?? ["page_error"]
        })
      });
      const b = await res.json().catch(() => null);
      return b && b.ok ? b : null;
    } catch {
      return null;
    }
  }
  /** 工具执行（POST /bridge/agent/tools/call）——支持宿主 signal 取消 + cancelId 通知桥中断挂起请求 */
  async callTool(tool, args, opts, signal) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 65e3);
    const onAbort = () => {
      clearTimeout(t);
      try {
        ctrl.abort();
      } catch {
      }
      if (opts.cancelId) {
        void fetch(this.base + "/bridge/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cancelId: opts.cancelId }),
          signal: AbortSignal.timeout(3e3)
        }).catch(() => {
        });
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return { ok: false, error: "已取消（agent 停止）" };
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const res = await fetch(this.base + "/bridge/agent/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        tool,
        args: args || {},
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        cwd: opts.cwd || void 0,
        source: "extension",
        cancelId: opts.cancelId
      })
    }).catch(() => null);
    if (signal) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
      }
    }
    clearTimeout(t);
    if (!res) return { ok: false, error: "桥不可达：" + this.base };
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, error: "桥响应异常（HTTP " + res.status + "）" };
    return body;
  }
  /** agent 完成 → 回答回桥（POST /bridge/agent/answer）——消息流落盘供窗口展示 */
  async answer(agentKey, text) {
    try {
      await fetch(this.base + "/bridge/agent/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5e3),
        body: JSON.stringify({ agentKey, text })
      });
    } catch {
    }
  }
  /**
   * agent SSE 持久流（桥 → 宿主注入模型）。断线指数退避重连 + 空闲兜底。
   *
   * @param registerFn 每次（重）连前调用以（重新）注册并取 agentKey——桥重启后 agents 表会丢，
   *   必须在 connect 前重新 register；返回 null 表示本轮不连（宿主要求，不重试）。
   * @param onMessage 每条 SSE 消息回调（含 type/text/payload）
   * @param opts idleMs（空闲超时，默认 60000）；retryBase（退避基数，默认 2000）
   * @returns 停止函数（置停 + abort 当前流；不再重连）
   */
  connectAgentStream(registerFn, onMessage, opts = {}) {
    const idleMs = opts.idleMs ?? 6e4;
    let retry = opts.retryBase ?? 2e3;
    let ctrl = null;
    let stopped = false;
    const run = async () => {
      if (stopped) return;
      const c = new AbortController();
      ctrl = c;
      const agentKey = await registerFn();
      if (!agentKey || stopped) {
        if (ctrl === c) ctrl = null;
        return;
      }
      this._bridgeUp = true;
      let idleTimer = null;
      const poke = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try {
            c.abort();
          } catch {
          }
        }, idleMs);
      };
      try {
        const resp = await fetch(this.base + "/bridge/agent/sse?agentKey=" + encodeURIComponent(agentKey), {
          signal: c.signal,
          headers: { Accept: "text/event-stream" }
        });
        if (!resp.ok || !resp.body) throw new Error("SSE HTTP " + resp.status);
        retry = opts.retryBase ?? 2e3;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        poke();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          poke();
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (line) {
              try {
                onMessage(JSON.parse(line.slice(5).trim()));
              } catch {
              }
            }
          }
        }
      } catch {
      }
      if (idleTimer) clearTimeout(idleTimer);
      if (stopped) return;
      if (ctrl === c) {
        setTimeout(() => {
          if (ctrl === c && !stopped) run();
        }, retry);
        retry = Math.min(3e4, retry * 2);
      }
    };
    run();
    return () => {
      stopped = true;
      try {
        ctrl?.abort();
      } catch {
      }
      ctrl = null;
    };
  }
};

// src/agent-host.ts
function mapBridgeTools(bridgeTools, host, opts) {
  const prefix = opts.prefix ?? "aiti_";
  const parameters = opts.parameters ?? ((s) => s);
  const descriptionSuffix = opts.descriptionSuffix ? "（" + opts.descriptionSuffix + "）" : "";
  for (const t of bridgeTools) {
    const name = prefix + t.name;
    const description = t.description + descriptionSuffix;
    const def = {
      name,
      description,
      parameters: parameters(t.inputSchema || { type: "object", properties: {} }),
      ...opts.output ? { output: opts.output(t) } : {},
      execute: async (args, signal) => opts.execute(t, args || {}, signal)
    };
    host.registerTool(def);
  }
}
function wrapToolResult(r) {
  if (!r.ok) {
    return { content: [{ type: "text", text: r.error || "未知错误" }], details: {}, isError: true };
  }
  return {
    content: [{ type: "text", text: r.result ?? "" }],
    details: {},
    ...r.isError ? { isError: true } : {}
  };
}
export {
  AgentBridgeClient,
  mapBridgeTools,
  wrapToolResult
};
