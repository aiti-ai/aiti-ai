// src/index.ts
import { tool } from "@opencode-ai/plugin";

// node_modules/@aiti-ai/aiti-devtools-agent/dist/index.js
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
  async callTool(tool2, args, opts, signal) {
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
        return { ok: false, error: "\u5DF2\u53D6\u6D88\uFF08agent \u505C\u6B62\uFF09" };
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const res = await fetch(this.base + "/bridge/agent/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        tool: tool2,
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
    if (!res) return { ok: false, error: "\u6865\u4E0D\u53EF\u8FBE\uFF1A" + this.base };
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, error: "\u6865\u54CD\u5E94\u5F02\u5E38\uFF08HTTP " + res.status + "\uFF09" };
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
function wrapToolResult(r) {
  if (!r.ok) {
    return { content: [{ type: "text", text: r.error || "\u672A\u77E5\u9519\u8BEF" }], details: {}, isError: true };
  }
  return {
    content: [{ type: "text", text: r.result ?? "" }],
    details: {},
    ...r.isError ? { isError: true } : {}
  };
}

// node_modules/@aiti-ai/aiti-devtools-core/dist/index.js
import { homedir } from "node:os";
import { join as join3, dirname as dirname3 } from "node:path";
import { existsSync as existsSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2, renameSync as renameSync2, mkdirSync as mkdirSync3, rmSync as rmSync3 } from "node:fs";
var PAIR_PEER_TTL = parseInt(process.env.AITI_PAIR_PEER_TTL || "3600000", 10);
var PAIR_FILE_TTL = parseInt(process.env.AITI_PAIR_FILE_TTL || "3600000", 10);
var PAIR_FILE_MAX = parseInt(process.env.AITI_PAIR_FILE_MAX || String(200 * 1024 * 1024), 10);
var CHUNK_MAX = 2 * 1024 * 1024;
var ID_TTL = parseInt(process.env.AITI_BRIDGE_TTL || "600000", 10);
var AGENT_TTL = parseInt(process.env.AITI_AGENT_TTL || "3600000", 10);
var BROADCAST_TTL = parseInt(process.env.AITI_BROADCAST_TTL || "600000", 10);
var AGENT_GRACE_TTL = parseInt(process.env.AITI_AGENT_GRACE_TTL || "120000", 10);
var AGENT_HISTORY_TTL = parseInt(process.env.AITI_AGENT_HISTORY_TTL || String(7 * 24 * 3600 * 1e3), 10);
var SWEEP_MS = parseInt(process.env.AITI_SWEEP_MS || "60000", 10);
var BRIDGE_TOOLS = [
  {
    name: "page_exec",
    description: "\u5728\u5DF2\u8FDE\u63A5\u9875\u9762\u6267\u884C\u7C7B CDP \u547D\u4EE4\uFF08DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser \u57DF\uFF09\u3002pageId \u7F3A\u7701=\u6700\u65B0 AI \u4E3B\u7A97\u53E3\uFF08self:true\uFF09\uFF1B\u663E\u5F0F pageId \u4F18\u5148\u3002\u5371\u9669\u547D\u4EE4/\u6D4F\u89C8\u5668\u53D7\u9650\u64CD\u4F5C\u4F1A\u81EA\u52A8\u5F39\u7528\u6237\u786E\u8BA4\uFF1BPage.captureScreenshot \u622A\u5C4F\u4F1A\u5148\u5F39\u51C6\u5907\u5361\u5C55\u793A\u622A\u53D6\u610F\u56FE\uFF08args.reason\uFF0C\u8BF7\u52A1\u5FC5\u7528\u4E00\u53E5\u8BDD\u8BF4\u660E\u60F3\u622A\u4EC0\u4E48\uFF09\uFF0C\u7528\u6237\u8C03\u6574\u597D\u9875\u9762\u624D\u5F00\u59CB\u622A\u5C4F\uFF0C\u622A\u5B8C\u518D\u5F39\u9884\u89C8\u786E\u8BA4\uFF08\u5927\u56FE\u81EA\u52A8\u843D\u76D8\u8FD4\u56DE\u6587\u4EF6\u8DEF\u5F84\uFF09\uFF1B\u786E\u8BA4\u5361\u5012\u8BA1\u65F6\u53EF\u7528 args.timeout\uFF08ms\uFF09\u8C03\u6574\uFF08\u9ED8\u8BA4 280000\uFF0C\u670D\u52A1\u7AEF\u5B89\u5168\u7F51\u81EA\u52A8\u540C\u6B65 +30s \u4F59\u91CF\uFF09\u3002\u8C03\u8BD5\u4F1A\u8BDD\u4E2D\u4ECE\u88AB\u8C03\u8BD5\u9875\u9762\uFF08inject\uFF09\u53D1\u51FA\u7684\u6D88\u606F\u7EDF\u4E00\u5E26 [\u53D1\u81EA: <pageId> \xB7 <url>] \u6765\u6E90\u6807\u6CE8\u2014\u2014\u628A pageId \u503C\u4F20\u7ED9 pageId \u53C2\u6570\u5373\u64CD\u4F5C\u8BE5\u9875\u9762\u3002\n\niframe \u652F\u6301\uFF1APage.getFrameTree \u67E5\u770B frame \u6811\uFF08iframe src/name/title\uFF0C\u540C\u57DF\u542B url/readyState\uFF09\uFF1BRuntime.evaluate \u4F20 contextId\uFF08iframe \u7D22\u5F15\u4ECE 1 \u8D77\uFF0C\u540C\u57DF\u53EF eval\uFF09\u8FDB iframe \u4E0A\u4E0B\u6587\u6267\u884C\u3002",
    inputSchema: { type: "object", properties: {
      cmd: { type: "string" },
      args: { type: "object" },
      pageId: { type: "string", description: "\u76EE\u6807\u9875\u9762\u5B8C\u6574 ID\u2014\u2014\u6765\u81EA AI \u6D88\u606F\u7684 [\u53D1\u81EA: xxx]\uFF08\u5982 3001/host\uFF09\uFF1B\u4E5F\u53EF /bridge/sessions \u67E5\u8BE2" }
    }, required: ["cmd"] }
  },
  { name: "page_snapshot", description: "\u62C9\u53D6\u5DF2\u8FDE\u63A5\u9875\u9762\u57FA\u7840\u73B0\u573A\uFF08URL/\u9009\u533A/\u6A21\u62DF\u6761\u4EF6\uFF09\u3002pageId \u7F3A\u7701=\u6700\u65B0 AI \u4E3B\u7A97\u53E3\uFF08self:true\uFF09\uFF1B\u663E\u5F0F pageId \u4F18\u5148\u3002", inputSchema: { type: "object", properties: { pageId: { type: "string" } } } },
  { name: "self_ui", description: "\u626B\u63CF\u76EE\u6807\u9875\u9762\uFF08\u7F3A\u7701 AI \u4E3B\u7A97\u53E3 xxx/ai\uFF09\u5F53\u524D\u6253\u5F00\u7684\u5F39\u7A97/dialog/\u8868\u5355\u5B57\u6BB5/\u6309\u94AE\u6E05\u5355\u2014\u2014ai-helper \u56DE\u586B\u5B9A\u4F4D\u7528\u3002\u8FD4\u56DE {dialogs:[{title, fields:[{label,selector,type}], buttons}]}\uFF0C\u65E0\u5F39\u7A97\u65F6 dialogs \u4E3A\u7A7A\u6570\u7EC4\u3002", inputSchema: { type: "object", properties: { pageId: { type: "string", description: "\u7F3A\u7701\u7528 AI \u4E3B\u7A97\u53E3\uFF08xxx/ai\uFF09\uFF1B\u4E5F\u53EF\u6307\u5B9A\u5176\u4ED6\u9875\u9762" } } } },
  { name: "form_fill", description: "\u5728\u76EE\u6807\u9875\u9762\uFF08\u7F3A\u7701 AI \u4E3B\u7A97\u53E3 xxx/ai\uFF09\u7684\u5F39\u7A97/\u8868\u5355\u91CC\u56DE\u586B\u5B57\u6BB5\u503C\u2014\u2014AI \u7ED3\u679C\u76F4\u63A5\u64CD\u4F5C\u6269\u5C55\u5F39\u7A97\u8868\u5355\uFF08React \u517C\u5BB9\uFF1A\u539F\u751F value setter + dispatch input/change\uFF09\u3002\u914D\u5408 self_ui \u4F7F\u7528\uFF1A\u5148 self_ui \u62FF\u5B57\u6BB5 label/selector\uFF0C\u518D form_fill \u586B\u503C\u3002\u53C2\u6570\uFF1Adialog\uFF08\u5F39\u7A97\u6807\u8BC6\uFF1A\u6807\u9898\u5B50\u4E32\u6216\u5E8F\u53F7 0 \u8D77\uFF0C\u7F3A\u7701\u53D6\u9762\u79EF\u6700\u5927\u7684\u53EF\u89C1\u5F39\u7A97\uFF09\u3001fields[{selector|label, value}]\u3001button\uFF08\u53EF\u9009\uFF0C\u56DE\u586B\u540E\u70B9\u51FB\u7684\u6309\u94AE\u6587\u672C\u5982\u300E\u4FDD\u5B58\u300F\uFF09\u3002\u8FD4\u56DE {foundDialog, title, filled, missed, clicked}\u3002", inputSchema: { type: "object", properties: {
    pageId: { type: "string", description: "\u7F3A\u7701\u7528 AI \u4E3B\u7A97\u53E3\uFF08xxx/ai\uFF09\uFF1B\u4E5F\u53EF\u6307\u5B9A\u5176\u4ED6\u9875\u9762" },
    dialog: { type: "string", description: "\u5F39\u7A97\u6807\u8BC6\uFF1A\u6807\u9898\u5B50\u4E32\u6216\u5E8F\u53F7\uFF080 \u8D77\uFF09\uFF1B\u7F3A\u7701\u53D6\u9762\u79EF\u6700\u5927\u7684\u53EF\u89C1\u5F39\u7A97" },
    fields: { type: "array", items: { type: "object", properties: { selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF08\u4F18\u5148\uFF09" }, label: { type: "string", description: "\u5F39\u7A97\u5185\u6587\u672C\u5339\u914D\uFF08label[for]/\u5305\u88F9/\u6587\u672C\u5305\u542B\uFF09" }, value: { type: "string", description: "\u8981\u586B\u7684\u503C" } }, required: ["value"] }, description: "\u8981\u586B\u7684\u5B57\u6BB5\u5217\u8868" },
    button: { type: "string", description: "\u56DE\u586B\u540E\u70B9\u51FB\u7684\u6309\u94AE\u6587\u672C\uFF08\u5982\u300E\u4FDD\u5B58\u300F\u300E\u786E\u5B9A\u300F\uFF09" }
  } } },
  { name: "bridge_status", description: "\u67E5\u8BE2\u6865\u4E0A\u5168\u90E8\u8BBE\u5907\uFF08devices \u7EDF\u4E00\u89C6\u56FE\uFF1Akind=page \u6CE8\u5165\u9875\u9762\uFF08\u542B pageId/url/title + device \u6D4F\u89C8\u5668\xB7OS\xB7\u5C4F\u5E55\uFF09/kind=agent agent \u4F1A\u8BDD\uFF08\u542B cwd\uFF09/kind=pair web \u8BBE\u5907\u5982\u624B\u673A\uFF09+ \u5DF2\u8FDE\u63A5\u9875\u9762\u660E\u7EC6\uFF08sessions\uFF09\u4E0E\u6302\u8D77\u8BF7\u6C42\u3002\u7528\u6237\u63D0\u5230\u9875\u9762\u6807\u9898\u6216 URL \u65F6\u6309 title/url \u5339\u914D pageId\uFF1B\u63D0\u5230\u624B\u673A/\u8BBE\u5907\u65F6\u5728 devices \u91CC\u9009\uFF08id \u6216\u540D\u5B57\u4F20\u7ED9 aiti_pair_send/aiti_pair_file \u5373\u53EF\u4E92\u53D1\u6D88\u606F\u4E92\u4F20\u6587\u4EF6\uFF09\u3002", inputSchema: { type: "object", properties: {} } },
  {
    name: "page_logs",
    description: "\u4ECE\u76EE\u6807\u9875\u9762\u62C9\u53D6\u672C\u5730\u7F13\u51B2\u7684 console \u65E5\u5FD7\uFF08log/debug/info/warn/error \u5168\u91CF\uFF0CCDP Runtime.evaluate \u8BFB\u53D6 window.__dbg.__consoleRing\uFF09\u3002pageId \u7F3A\u7701=\u6700\u65B0 AI \u4E3B\u7A97\u53E3\uFF08self:true\uFF09\uFF1B\u663E\u5F0F pageId \u4F18\u5148\u3002\u9875\u9762\u62A5\u9519\u6392\u67E5\u9996\u9009\uFF1A\u5148\u67E5 warn/error \u518D\u9010\u6B65\u653E\u5F00\u3002\u8FD4\u56DE {logs:[{ts,level,text,count}], bufferSize}\u3002",
    inputSchema: { type: "object", properties: {
      pageId: { type: "string", description: "\u76EE\u6807\u9875\u9762\u5B8C\u6574 ID\uFF08[\u53D1\u81EA: xxx] \u6216 /bridge/sessions\uFF09" },
      level: { type: "string", description: "\u8FC7\u6EE4\u7EA7\u522B\uFF1Adebug/log/info/warn/error\uFF08\u9ED8\u8BA4\u5168\u90E8\uFF09" },
      since: { type: "string", description: "ISO \u65F6\u95F4\uFF1A\u53EA\u8FD4\u56DE\u6B64\u65F6\u95F4\u4E4B\u540E\u7684\u65E5\u5FD7" },
      limit: { type: "number", description: "\u6761\u6570\u4E0A\u9650\uFF08\u2264200\uFF0C\u9ED8\u8BA4 50\uFF0C\u53D6\u6700\u65B0\uFF09" },
      token: { type: "string" }
    } }
  },
  {
    name: "page_network",
    description: "\u4ECE\u76EE\u6807\u9875\u9762\u62C9\u53D6\u672C\u5730\u7F13\u51B2\u7684 ajax/fetch \u8BF7\u6C42\u5B8C\u6210\u6001\uFF08CDP Runtime.evaluate \u8BFB\u53D6 window.__dbg.__netRing\uFF09\u3002pageId \u7F3A\u7701=\u6700\u65B0 AI \u4E3B\u7A97\u53E3\uFF08self:true\uFF09\uFF1B\u663E\u5F0F pageId \u4F18\u5148\u3002\u5931\u8D25\u6392\u67E5\uFF1Astatus \u4F20 400 \u6216 errorOnly:true\u3002\u6CE8\u610F\uFF1A\u4E0D\u542B\u9759\u6001\u8D44\u6E90\u52A0\u8F7D\uFF08\u90A3\u662F CDP Network \u7684\u80FD\u529B\uFF09\u3002\u8FD4\u56DE {requests:[{kind,method,url,status,statusText,durationMs,size,error,ts}], bufferSize}\u3002",
    inputSchema: { type: "object", properties: {
      pageId: { type: "string" },
      url: { type: "string", description: "URL \u5B50\u4E32\u8FC7\u6EE4" },
      status: { type: "number", description: "status >= \u6B64\u503C\u624D\u8FD4\u56DE\uFF08\u5982 400 \u53EA\u770B\u5931\u8D25\uFF09" },
      errorOnly: { type: "boolean", description: "\u53EA\u770B\u5931\u8D25\uFF08error \u975E\u7A7A \u6216 status>=400\uFF09" },
      limit: { type: "number", description: "\u6761\u6570\u4E0A\u9650\uFF08\u2264100\uFF0C\u9ED8\u8BA4 30\uFF0C\u53D6\u6700\u65B0\uFF09" },
      token: { type: "string" }
    } }
  },
  // ---- 用户交互型工具：AI 与人在页面上协作（AI 提问 → 人在 AI 窗口/页面作答或拒绝 → 结果回 AI） ----
  // 统一机制：prompt 显示给人看；timeout 为可选——不传=永久等待（面板常驻直到用户操作，不读秒不超时）；
  //   传了才显示读秒倒计时（可暂停）且服务器强制到点返回“用户无响应/不在线”；
  //   交互消息到达时页面走浏览器 Notification（+标题闪烁/提示音）通知用户；人可拒绝（rejectable）。
  // 响应信封：{ status:'answered'|'rejected'|'timeout'|'error', value?, reason?, error?, tookMs, timeoutMs }
  {
    name: "user_pick_element",
    description: "\u8BF7\u5F53\u524D\u9875\u9762\u7684\u4EBA\u7C7B\u7528\u6237\u70B9\u9009\u4E00\u4E2A\u9875\u9762\u5143\u7D20\uFF08\u81EA\u52A8\u8FDB\u5165 Inspector \u70B9\u9009\u6A21\u5F0F\u3001\u6536\u8D77 AI \u7A97\u53E3\u3001\u5F39\u70B9\u9009\u9762\u677F\uFF1B\u7528\u6237\u53EF\u786E\u8BA4\u9009\u4E2D\u6216\u62D2\u7EDD\uFF09\u3002\u8FD4\u56DE\u5143\u7D20\u8F7D\u8377 {tag,rect,xpath,text,attributes,framework,selector}\u3002",
    inputSchema: { type: "object", properties: {
      prompt: { type: "string", description: "\u7ED9\u7528\u6237\u770B\u7684\u8BF4\u660E\uFF08\u4E3A\u4EC0\u4E48\u9700\u8981\u70B9\u9009\u8FD9\u4E2A\u5143\u7D20\uFF09" },
      timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u64CD\u4F5C\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u81EA\u52A8\u8FD4\u56DE timeout" },
      rejectable: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u7528\u6237\u62D2\u7EDD\uFF08\u9ED8\u8BA4 true\uFF09" },
      async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
      pageId: { type: "string", description: "\u76EE\u6807\u9875\u9762\u5B8C\u6574 ID\uFF08instanceId/frameId\uFF09" }
    }, required: ["prompt"] }
  },
  {
    name: "user_confirm",
    description: "\u5728 AI \u7A97\u53E3\u5185\u5411\u4EBA\u7C7B\u7528\u6237\u63D0\u4E00\u4E2A\u662F/\u5426\u95EE\u9898\uFF08\u5982\u201C\u786E\u8BA4\u6267\u884C\u6B64\u64CD\u4F5C\uFF1F\u201D\u201C\u662F\u5426\u7EE7\u7EED\uFF1F\u201D\uFF09\uFF0C\u7528\u6237\u70B9 \u2705/\u274C \u4F5C\u7B54\uFF0C\u5E76\u53EF\u9644\u300C\u8865\u5145\u8BF4\u660E\u300D\u81EA\u7531\u6587\u672C\uFF08value.comment\uFF09\uFF1B\u53E6\u6709\u56FA\u5B9A\u9009\u9879\u300C\u90FD\u4E0D\u9002\u5408\u300D\u2192 \u81EA\u5B9A\u4E49\u56DE\u7B54\uFF08approved:null, custom\uFF09\u3002\u8FD4\u56DE {status, approved, comment?, custom?, reason?}\u3002",
    inputSchema: { type: "object", properties: {
      prompt: { type: "string", description: "\u95EE\u9898\u5185\u5BB9" },
      timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u64CD\u4F5C\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u81EA\u52A8\u8FD4\u56DE timeout" },
      rejectable: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u7528\u6237\u4EE5\u201C\u6682\u65F6\u65E0\u6CD5\u5904\u7406\u201D\u62D2\u7EDD\uFF08\u9ED8\u8BA4 true\uFF09" },
      async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF08\u4E0D\u963B\u585E\u672C\u8C03\u7528\uFF09\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
      pageId: { type: "string" }
    }, required: ["prompt"] }
  },
  {
    name: "user_choose",
    description: "\u5728 AI \u7A97\u53E3\u5185\u7ED9\u4EBA\u7C7B\u7528\u6237\u4E00\u7EC4\u9009\u9879\u8BA9\u5176\u9009\u62E9\uFF08\u5982\u4FEE\u590D\u65B9\u6848 A/B/C\uFF09\u3002\u5355\u9009\uFF08\u9ED8\u8BA4\uFF09\u2192 value:{index,label}\uFF1Bmultiple:true \u591A\u9009 \u2192 value:{indexes,labels}\u3002\u7528\u6237\u53EF\u9644\u300C\u8865\u5145\u8BF4\u660E\u300D\u81EA\u7531\u6587\u672C\uFF08value.comment\uFF09\uFF1B\u53E6\u6709\u56FA\u5B9A\u9009\u9879\u300C\u8FD9\u4E9B\u90FD\u4E0D\u9002\u5408\u300D\u2192 \u81EA\u5B9A\u4E49\u7B54\u6848\uFF08index:-1, custom:true\uFF09\u3002\u8FD4\u56DE {status, value, reason?}\u3002",
    inputSchema: { type: "object", properties: {
      prompt: { type: "string" },
      choices: { type: "array", items: { type: "string" }, description: "\u9009\u9879\u5217\u8868\uFF082-8 \u4E2A\uFF09" },
      multiple: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u591A\u9009\uFF08\u9ED8\u8BA4 false\uFF1Btrue \u65F6\u8FD4\u56DE indexes/labels\uFF09" },
      timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u64CD\u4F5C\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u81EA\u52A8\u8FD4\u56DE timeout" },
      rejectable: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u7528\u6237\u62D2\u7EDD\uFF08\u9ED8\u8BA4 true\uFF09" },
      async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
      pageId: { type: "string" }
    }, required: ["prompt", "choices"] }
  },
  {
    name: "user_input",
    description: "\u5728 AI \u7A97\u53E3\u5185\u8BF7\u4EBA\u7C7B\u7528\u6237\u8F93\u5165\u4E00\u6BB5\u6587\u672C\uFF08\u5982\u671F\u671B\u6587\u6848\u3001\u914D\u7F6E\u503C\u3001\u573A\u666F\u63CF\u8FF0\uFF09\uFF0C\u56DE\u8F66/\u70B9\u51FB\u5373\u53D1\u9001\u3002\u8FD4\u56DE {status, value:{text}, reason?}\u3002",
    inputSchema: { type: "object", properties: {
      prompt: { type: "string" },
      defaultValue: { type: "string", description: "\u9884\u586B\u9ED8\u8BA4\u503C\uFF08\u53EF\u9009\uFF09" },
      timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u64CD\u4F5C\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u81EA\u52A8\u8FD4\u56DE timeout" },
      rejectable: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u7528\u6237\u62D2\u7EDD\uFF08\u9ED8\u8BA4 true\uFF09" },
      async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
      pageId: { type: "string" }
    }, required: ["prompt"] }
  },
  {
    name: "user_presence",
    description: "\u63A2\u6D4B\u4EBA\u7C7B\u7528\u6237\u662F\u5426\u5728\u573A/\u5728\u7EBF\uFF08AI \u9700\u8981\u7528\u6237\u914D\u5408\u957F\u4EFB\u52A1\u524D\u5148\u786E\u8BA4\uFF09\uFF0C\u7528\u6237\u70B9\u300C\u6211\u5728/\u7A0D\u540E\u300D\uFF0C\u53EF\u9644\u300C\u8865\u5145\u8BF4\u660E\u300D\uFF08value.comment\uFF09\u3002\u8FD4\u56DE {status, present, comment?}\uFF1B\u8D85\u65F6\u5373\u89C6\u4E3A\u4E0D\u5728\u7EBF\u3002",
    inputSchema: { type: "object", properties: {
      prompt: { type: "string", description: "\u8BE2\u95EE\u6587\u6848\uFF08\u9ED8\u8BA4\u201C\u4F60\u5728\u5417\uFF1F\u9700\u8981\u4F60\u914D\u5408\u7EE7\u7EED\u5F00\u53D1\u201D\uFF09" },
      timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u4F5C\u7B54\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u8FD4\u56DE status:'timeout'\uFF08\u89C6\u4E3A\u4E0D\u5728\u7EBF\uFF09\u2014\u2014\u9700\u8981\u5FEB\u901F\u63A2\u6D4B\u5728\u573A/\u9650\u65F6\u7B49\u5F85\u65F6\u624D\u663E\u5F0F\u4F20" },
      async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
      pageId: { type: "string" }
    }, required: [] }
  },
  {
    name: "user_notify",
    description: "\u975E\u963B\u585E\u901A\u77E5\uFF1A\u901A\u8FC7\u6D4F\u89C8\u5668 Notification \u544A\u8BC9\u7528\u6237\u4E00\u6761\u6D88\u606F\uFF08\u5982\u201C\u4FEE\u590D\u5B8C\u6210\uFF0C\u8BF7\u5237\u65B0\u9A8C\u8BC1\u201D\uFF09\uFF0C\u4E0D\u7B49\u5F85\u56DE\u7B54\u3002\u8FD4\u56DE {notified:true}\u3002",
    inputSchema: { type: "object", properties: {
      title: { type: "string", description: "\u901A\u77E5\u6807\u9898" },
      body: { type: "string", description: "\u901A\u77E5\u5185\u5BB9" },
      timeout: { type: "number", description: "\u53EF\u9009\uFF1A\u901A\u77E5\u5361\u81EA\u52A8\u5173\u95ED\u65F6\u9650 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u5173\u95ED" },
      async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
      pageId: { type: "string" }
    }, required: ["body"] }
  },
  // ---- 方案 G · P2：agent 接入 + 消息主通道 ----
  {
    name: "aiti_hello",
    description: "agent \u81EA\u6211\u4ECB\u7ECD/\u6CE8\u518C\uFF1A\u8986\u76D6 agentId\uFF08\u9ED8\u8BA4 clientInfo.name\uFF09\u4E0E sessionId\uFF08\u9ED8\u8BA4 Mcp-Session-Id \u6216\u6865\u968F\u673A\uFF09\u3001\u7ED1\u5B9A\u9ED8\u8BA4\u76EE\u6807\u9875 pageId\u3001\u8BA2\u9605\u9875\u9762\u4E8B\u4EF6\uFF08page_error\uFF09\u3002\u6CE8\u610F\uFF1Apage_log/page_network \u4E0D\u518D\u5B9E\u65F6\u63A8\u9001\uFF0C\u6539\u7528 page_logs/page_network \u5DE5\u5177\u6309\u9700\u62C9\u53D6\u3002\u5EFA\u8BAE\u4F1A\u8BDD\u5F00\u59CB\u65F6\u8C03\u7528\u4E00\u6B21\u2014\u2014\u6CE8\u518C\u540E\u6D88\u606F\u53EF\u5B9A\u5411\u5230\u672C\u4F1A\u8BDD\uFF08agentKey=agentId/sessionId\uFF09\u3002",
    inputSchema: { type: "object", properties: {
      agentId: { type: "string", description: "\u81EA\u5B9A\u4E49 agent \u6807\u8BC6\uFF08\u5982 pi / cc / qoder\uFF1B\u7F3A\u7701\u7528 clientInfo.name\uFF09" },
      sessionId: { type: "string", description: "\u672C\u5B9E\u4F8B\u4F1A\u8BDD\u6807\u8BC6\uFF08\u591A\u5B9E\u4F8B/\u591A\u4F1A\u8BDD\u65F6\u533A\u5206\uFF1B\u7F3A\u7701\u7528 Mcp-Session-Id\uFF0C\u65E0\u5219\u6865\u751F\u6210\u968F\u673A\uFF09" },
      name: { type: "string", description: "\u663E\u793A\u540D\uFF08\u53EF\u9009\uFF0C\u5982 'pi \xB7 \u5DE5\u4F5C\u533AA'\uFF09" },
      cwd: { type: "string", description: "\u5DE5\u4F5C\u76EE\u5F55\uFF08\u53EF\u9009\uFF0C\u663E\u793A CWD . name (id)\uFF0C\u65B9\u4FBF\u8BC6\u522B agent \u8EAB\u4EFD\uFF09" },
      pageId: { type: "string", description: "\u7ED1\u5B9A\u9ED8\u8BA4\u8C03\u8BD5\u76EE\u6807\u9875\uFF08pageId/url/title \u5747\u53EF\uFF0C\u7559\u7A7A\u4E0D\u7ED1\uFF09" },
      subEvents: { type: "array", items: { type: "string" }, description: "\u8BA2\u9605\u5B9E\u65F6\u4E8B\u4EF6\uFF1Apage_error\uFF08\u9ED8\u8BA4\u4E0D\u6295\u9012\uFF0C\u663E\u5F0F\u8BA2\u9605\u624D\u63A8\uFF1Bpage_log/page_network \u4E0D\u518D\u5B9E\u65F6\u63A8\u9001\uFF0C\u6539\u7528 page_logs/page_network \u5DE5\u5177\u6309\u9700\u62C9\u53D6\uFF09" }
    } }
  },
  {
    name: "file_stat",
    description: "\u67E5\u8BE2\u6587\u4EF6\u5B58\u5728\u6027/\u7C7B\u578B/\u5927\u5C0F/\u4FEE\u6539\u65F6\u95F4\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF1B\u7EC4\u4EF6\u6E90\u7801/\u8C03\u7528\u4F4D\u7F6E\u5B9A\u4F4D\u3001AI \u7A97\u300E\u540E\u7AEF\u6253\u5F00/\u524D\u7AEF\u6253\u5F00\u300F\u524D\u7F6E\u6821\u9A8C\u7528\uFF09\u3002\u4E0D\u5B58\u5728\u6216\u975E\u6CD5\u8DEF\u5F84\u8FD4\u56DE {exists:false}\u3002",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "\u7EDD\u5BF9\u8DEF\u5F84\uFF08\u5982 /home/user/src/App.vue\uFF09" }
    }, required: ["path"] }
  },
  {
    name: "aiti_inbox",
    description: "\u6D88\u606F\u4E3B\u901A\u9053\uFF1A\u62C9\u53D6\u53D1\u7ED9\u672C agent \u4F1A\u8BDD\u7684\u6D88\u606F\uFF08\u4EBA\u4E3B\u52A8\u53D1\u8BDD user_message / \u5F02\u6B65 user_* \u4F5C\u7B54 user_answer / \u8BA2\u9605\u7684\u9875\u9762\u4E8B\u4EF6\uFF09\u3002\u5F00\u59CB\u65B0\u4E00\u8F6E\u6216\u9700\u8981\u6700\u65B0\u4FE1\u606F\u65F6\u5148\u8C03\u7528\uFF1B\u5904\u7406\u5B8C\u628A\u6D88\u606F id \u653E ack \u53C2\u6570\u786E\u8BA4\uFF08\u6807\u8BB0 consumed\uFF0C\u5386\u53F2\u4FDD\u7559\uFF09\u3002\u8FD4\u56DE agentKey\uFF08agentId/sessionId\uFF09\uFF0C\u672A\u6CE8\u518C\u65F6\u63D0\u793A\u8C03 aiti_hello \u6CE8\u518C\u3002",
    inputSchema: { type: "object", properties: {
      agentId: { type: "string", description: "agent \u6807\u8BC6\uFF08\u7F3A\u7701\u7528 aiti_hello \u6CE8\u518C\u503C\u6216 clientInfo.name\uFF09" },
      sessionId: { type: "string", description: "\u672C\u5B9E\u4F8B\u4F1A\u8BDD\u6807\u8BC6\uFF08\u7F3A\u7701\u7528 Mcp-Session-Id \u6216 aiti_hello \u6CE8\u518C\u503C\uFF09" },
      ack: { description: "\u5DF2\u5904\u7406\u6D88\u606F id \u5217\u8868\uFF0C\u6216 { ids: [...], summary: '\u6267\u884C\u603B\u7ED3' }\u2014\u2014summary\uFF08\u5FC5\u5E26\uFF09\u4F1A\u4F5C\u4E3A agent \u5904\u7406\u8BB0\u5F55\u663E\u793A\u5728\u64CD\u4F5C\u53F0\u6D88\u606F\u6D41", oneOf: [{ type: "array", items: { type: "string" } }, { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, summary: { type: "string" } } }] }
    } }
  },
  // ---- pair 设备互连（临时聊天/互传文件；设备发现走 bridge_status 的 devices 统一视图） ----
  {
    name: "aiti_pair_send",
    description: "\u7ED9\u6865\u4E0A\u53E6\u4E00\u53F0\u8BBE\u5907\u53D1\u6587\u672C\u6D88\u606F\uFF08pair web \u8BBE\u5907\u5982\u624B\u673A / \u5176\u4ED6 agent \u4F1A\u8BDD / \u6CE8\u5165\u9875\u9762\uFF09\u3002to \u4F20\u8BBE\u5907 id \u6216\u540D\u5B57\uFF08\u6A21\u7CCA\u5339\u914D\uFF0C\u552F\u4E00\u547D\u4E2D\u5373\u53D1\uFF0C\u591A\u4E2A/\u65E0\u547D\u4E2D\u8FD4\u56DE\u5019\u9009\u6E05\u5355\u2014\u2014\u7167\u5019\u9009\u91CD\u8C03\u5373\u53EF\uFF09\uFF1Bto \u7701\u7565\u6216\u4F20 'all' \u7FA4\u53D1\u5168\u90E8 pair \u8BBE\u5907\u4E0E agent\u3002\u5BF9\u65B9\u662F agent \u65F6\u6D88\u606F\u8FDB\u5176 aiti_inbox\uFF08\u5E26 [\u53D1\u81EA pair: <\u540D>] \u6807\u6CE8\uFF09\u3002\u6587\u4EF6\u4F20\u8F93\u7528 aiti_pair_file\u3002",
    inputSchema: { type: "object", properties: {
      to: { type: "string", description: "\u76EE\u6807\u8BBE\u5907 id \u6216\u540D\u5B57\uFF08bridge_status \u7684 devices \u91CC\u9009\uFF1B\u7F3A\u7701=\u7FA4\u53D1\uFF09" },
      text: { type: "string", description: "\u6D88\u606F\u6587\u672C" }
    }, required: ["text"] }
  },
  {
    name: "aiti_pair_file",
    description: "\u628A\u6865\u6240\u5728\u673A\u5668\u4E0A\u7684\u672C\u5730\u6587\u4EF6\u63A8\u7ED9\u53E6\u4E00\u53F0\u8BBE\u5907\uFF08pair web \u8BBE\u5907\u5728\u6D4F\u89C8\u5668\u91CC\u76F4\u63A5\u4E0B\u8F7D\uFF1Bagent \u6536\u5230 file-meta \u540E\u7528 aiti_pair_fetch \u53D6\u56DE\uFF09\u3002to \u4F20\u8BBE\u5907 id \u6216\u540D\u5B57\u3002\u5355\u6587\u4EF6\u4E0A\u9650 200MB\uFF0C\u4E2D\u8F6C\u6682\u5B58 1 \u5C0F\u65F6\u3002",
    inputSchema: { type: "object", properties: {
      to: { type: "string", description: "\u76EE\u6807\u8BBE\u5907 id \u6216\u540D\u5B57" },
      path: { type: "string", description: "\u672C\u5730\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84" }
    }, required: ["to", "path"] }
  },
  {
    name: "aiti_pair_fetch",
    description: "\u628A\u6536\u5230\u7684 pair \u6587\u4EF6\u53D6\u56DE\u5230\u6865\u6240\u5728\u673A\u5668\u78C1\u76D8\uFF08fileId \u6765\u81EA aiti_inbox \u6D88\u606F payload.file.fileId\uFF09\u3002\u7F3A\u7701\u843D dataDir/aiti-bridge/pair-inbox/<\u539F\u6587\u4EF6\u540D>\uFF0C\u8FD4\u56DE\u53EF\u8BFB\u8DEF\u5F84\uFF1B\u4F20 savePath \u81EA\u5B9A\u4E49\u843D\u70B9\u3002",
    inputSchema: { type: "object", properties: {
      fileId: { type: "string", description: "\u6587\u4EF6 id\uFF08aiti_inbox \u6D88\u606F payload.file.fileId\uFF09" },
      savePath: { type: "string", description: "\u843D\u76D8\u7EDD\u5BF9\u8DEF\u5F84\uFF08\u7F3A\u7701 pair-inbox \u76EE\u5F55 + \u539F\u6587\u4EF6\u540D\uFF09" }
    }, required: ["fileId"] }
  }
];
var ORPHAN_RE = /\[(?:元素|回答|错误)\d+\]/g;
var LEGACY_TAG_RE = /\[选择\d+\]/g;
var SRC_TAG_RE = /\[发自:[^\]]*\]\s*/g;
var ORPHAN_NOTICE = "[\u26A0 \u5019\u9009\u5DF2\u5931\u6548\uFF0C\u5360\u4F4D\u7B26\u5DF2\u79FB\u9664\uFF08\u91CD\u65B0\u9009\u5143\u7D20/\u5237\u65B0\u9875\u9762\u91CD\u91C7\uFF09]";
function clipUrl(u, max = 120) {
  if (!u) return "";
  try {
    const p = new URL(u);
    p.hash = "";
    let out = p.origin + p.pathname;
    if (p.search) {
      const q = p.search.slice(1).split("&").filter(Boolean).slice(0, 2);
      if (q.length) out += "?" + q.join("&");
    }
    return out.length > max ? out.slice(0, max) + "\u2026" : out;
  } catch {
    return u.length > max ? u.slice(0, max) + "\u2026" : u;
  }
}
function withSourceTag(text, opts) {
  const pid = opts.pid || "";
  if (!pid) return text;
  const note = opts.srcNote ?? "aiti-*\uFF1ApageId \u53C2\u6570\u7528\u5B83";
  const tag = "[\u53D1\u81EA: " + pid + (opts.pageUrl ? " \xB7 " + clipUrl(opts.pageUrl) : "") + "\uFF08" + note + "\uFF09]";
  const cleaned = String(text || "").replace(SRC_TAG_RE, "").replace(/\s+$/, "");
  return (cleaned ? cleaned + "\n" : "") + tag;
}
function stripOrphanTags(text) {
  return String(text || "").replace(ORPHAN_RE, ORPHAN_NOTICE);
}
function replaceTag(text, tag, desc) {
  const i = text.indexOf(tag);
  if (i < 0) return text;
  const rest = text.slice(i + tag.length);
  return text.slice(0, i) + desc + (rest.trim() ? "\n" + rest : rest);
}
function rewriteMessage(text, picked, opts = {}) {
  let out = String(text || "");
  const usedTags = [];
  out = out.replace(LEGACY_TAG_RE, "");
  if (picked.length) {
    for (const c of picked) {
      if (c.tag && out.includes(c.tag)) {
        out = replaceTag(out, c.tag, c.describe || c.tag);
        usedTags.push(c.tag);
      }
    }
  }
  if (ORPHAN_RE.test(out)) {
    ORPHAN_RE.lastIndex = 0;
    out = stripOrphanTags(out);
  } else ORPHAN_RE.lastIndex = 0;
  const usedAny = usedTags.length > 0;
  const finalText = withSourceTag(out, opts);
  return { text: finalText, usedTags, usedAny };
}
var homeDir = () => homedir();
var MCP_TARGETS = {
  // pi 实际读取 getAgentDir()/mcp.json（getAgentDir = $PI_CODING_AGENT_DIR，默认 ~/.pi/agent）；
  // ~/.config/mcp/mcp.json 是历史误记——默认 pi 不读它（探针实证 2026-09-10，见执行记录 P17）
  pi: [{ path: () => join3(process.env.PI_CODING_AGENT_DIR || join3(homeDir(), ".pi", "agent"), "mcp.json"), key: "mcpServers" }],
  zcode: [{ path: () => join3(homeDir(), ".zcode", "cli", "config.json"), key: "mcpServers", keyPath: ["mcp", "servers"] }],
  opencode: [{
    path: () => join3(homeDir(), ".config", "opencode", "opencode.json"),
    key: "mcpServers",
    keyPath: ["mcp"],
    shimEntry: (shimPath) => ({ type: "local", command: ["node", shimPath], enabled: true }),
    envKey: "environment",
    // opencode 的 env map 字段名异构；条目零顶层私有键（schema 严格拒未知键）
    httpEntry: (url) => ({ type: "remote", url, enabled: true })
    // D23：http 类型对 opencode 非法
  }],
  claude: [
    { path: () => join3(homeDir(), ".claude.json"), key: "mcpServers" },
    { path: (p) => join3(p, ".mcp.json"), key: "mcpServers", project: true }
  ],
  // CodeBuddy Code（腾讯 cbc）：用户级 ~/.codebuddy/.mcp.json（官方 mcp.md：.mcp.json 推荐 /
  // mcp.json 已废弃；条目形状 mcpServers+stdio 与 claude 同构，2026-09-11 cbc mcp add 实测钉死）。
  // 项目级 .mcp.json 与 claude 同文件（claude 目标已覆盖），不重复注册。
  codebuddy: [{ path: () => join3(homeDir(), ".codebuddy", ".mcp.json"), key: "mcpServers" }],
  cursor: [{ path: () => join3(homeDir(), ".cursor", "mcp.json"), key: "mcpServers" }],
  windsurf: [{ path: () => join3(homeDir(), ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" }],
  vscode: [{ path: (p) => join3(p, ".vscode", "mcp.json"), key: "servers", project: true }],
  zed: [
    { path: () => join3(homeDir(), ".config", "zed", "settings.json"), key: "mcp" },
    { path: (p) => join3(p, ".zed", "settings.json"), key: "mcp", project: true }
  ]
};
function detectStructureKey(cfg) {
  if (cfg && typeof cfg === "object") {
    const c = cfg;
    if (c.mcpServers && typeof c.mcpServers === "object") return { key: "mcpServers", inferred: false };
    if (c.servers && typeof c.servers === "object") return { key: "servers", inferred: false };
    if (c.mcp && typeof c.mcp === "object") return { key: "mcp", inferred: false };
  }
  return { key: "mcpServers", inferred: true };
}
function readJson(path) {
  try {
    return { cfg: JSON.parse(stripBom(readFileSync2(path, "utf8"))) };
  } catch {
    try {
      const clean = stripJsonComments(stripBom(readFileSync2(path, "utf8"))).replace(/,\s*([}\]])/g, "$1");
      return { cfg: JSON.parse(clean) };
    } catch (e) {
      return { cfg: null, error: "JSON \u89E3\u6790\u5931\u8D25\uFF1A" + String(e?.message || e) };
    }
  }
}
function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}
function isPlainContainer(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function stripJsonComments(text) {
  let out = "";
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}
function resolveContainer(cfg, keyPath) {
  let cur = cfg;
  for (const k of keyPath) {
    if (!isPlainContainer(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}
function writeAtomic(path, cfg) {
  const tmp = path + ".tmp";
  const bak = path + ".bak";
  mkdirSync3(dirname3(path), { recursive: true });
  writeFileSync2(tmp, JSON.stringify(cfg, null, 2) + "\n");
  if (existsSync3(path)) {
    try {
      renameSync2(path, bak);
    } catch {
    }
  }
  try {
    renameSync2(tmp, path);
  } catch (e) {
    if (existsSync3(bak) && !existsSync3(path)) {
      try {
        renameSync2(bak, path);
      } catch {
      }
    }
    try {
      rmSync3(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
function listPlannedWrites(opts) {
  const projectDir = opts.projectDir || process.cwd();
  const out = [];
  const hasConfigPaths = !!(opts.configPaths && opts.configPaths.length);
  const auto = (opts.targets === "auto" || !opts.targets) && !hasConfigPaths;
  if (!hasConfigPaths) {
    const targets = auto ? Object.keys(MCP_TARGETS) : opts.targets;
    for (const t of targets) {
      const files = MCP_TARGETS[t];
      if (!files) continue;
      for (const f of files) {
        const p = f.path(projectDir);
        if (auto && !existsSync3(p)) continue;
        out.push({ target: t, path: p, key: f.key, exists: existsSync3(p), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry });
      }
    }
  }
  for (const p of opts.configPaths || []) {
    const abs = p.replace(/^~(?=\/|$)/, homeDir());
    let matched = null;
    for (const [t, files] of Object.entries(MCP_TARGETS)) {
      for (const f of files) {
        if (f.path(projectDir) === abs) {
          matched = { target: t, path: abs, key: f.key, exists: existsSync3(abs), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry };
          break;
        }
      }
      if (matched) break;
    }
    out.push(matched ?? { target: abs, path: abs, key: "mcpServers", exists: existsSync3(abs) });
  }
  return out;
}
function assertKnownTargets(targets) {
  if (!targets || targets === "auto") return null;
  const unknown = targets.filter((t) => !MCP_TARGETS[t]);
  return unknown.length ? `\u672A\u77E5\u6CE8\u518C\u76EE\u6807\uFF1A${unknown.join("\u3001")}\uFF08\u53EF\u7528\uFF1A${Object.keys(MCP_TARGETS).join("\u3001")}\uFF09` : null;
}
var LEGACY_VERSION_FIELD = "_aitiShimVersion";
var SHIM_VERSION_ENV = "AITI_SHIM_VERSION";
function readShimEntryVersion(entry, envKey) {
  const env = entry[envKey];
  if (!isPlainContainer(env)) return 0;
  return parseInt(String(env[SHIM_VERSION_ENV] ?? ""), 10) || 0;
}
function entryReferencesShimPath(entry, shimPath) {
  return JSON.stringify(entry).includes(JSON.stringify(shimPath));
}
function registerAitiShim(opts) {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l) => console.log(l));
  const results = [];
  let changed = false;
  for (const w of listPlannedWrites(opts)) {
    const outcome = (() => {
      let cfg;
      if (!existsSync3(w.path)) {
        cfg = {};
      } else {
        const r = readJson(w.path);
        if (r.error) return { changed: false, error: "JSON \u89E3\u6790\u5931\u8D25\uFF1A" + r.error };
        cfg = r.cfg;
      }
      if (!isPlainContainer(cfg)) return { changed: false, error: "\u914D\u7F6E\u4E0D\u662F\u5BF9\u8C61" };
      const map = w.keyPath ? resolveContainer(cfg, w.keyPath) : (() => {
        const det = detectStructureKey(cfg);
        if (!isPlainContainer(cfg[det.key])) cfg[det.key] = {};
        return cfg[det.key];
      })();
      const existing = map[serverName] && typeof map[serverName] === "object" && !Array.isArray(map[serverName]) ? map[serverName] : null;
      const envKey = w.envKey || "env";
      const existingVer = existing ? readShimEntryVersion(existing, envKey) : 0;
      const hasLegacyField = !!existing && LEGACY_VERSION_FIELD in existing;
      const shimShapeBroken = !!w.shimEntry && !!existing && ("args" in existing || "env" in existing && envKey !== "env");
      if (existing && !hasLegacyField && !shimShapeBroken && existingVer >= opts.version && !opts.force && entryReferencesShimPath(existing, opts.shimPath)) {
        return { changed: false, note: `\u5DF2\u662F\u6700\u65B0\uFF08v${existingVer} >= v${opts.version}\uFF09` };
      }
      if (!dryRun) {
        const entry = { ...existing || {}, ...w.shimEntry ? w.shimEntry(opts.shimPath) : { type: "stdio", command: "node", args: [opts.shimPath] } };
        delete entry.url;
        delete entry[LEGACY_VERSION_FIELD];
        if (w.shimEntry) {
          delete entry.args;
          delete entry.env;
        }
        const prevEnv = isPlainContainer(entry[envKey]) ? entry[envKey] : {};
        entry[envKey] = { ...prevEnv, [SHIM_VERSION_ENV]: String(opts.version) };
        map[serverName] = entry;
        try {
          writeAtomic(w.path, cfg);
        } catch (e) {
          return { changed: false, error: "\u5199\u5165\u5931\u8D25\uFF1A" + String(e?.message || e) };
        }
      }
      return { changed: true, note: hasLegacyField ? `\u8FC1\u79FB\uFF08\u9876\u5C42\u7248\u672C\u952E \u2192 ${envKey}.${SHIM_VERSION_ENV}\uFF09` : existing ? `\u5347\u7EA7 v${existingVer} \u2192 v${opts.version}` : "\u65B0\u5EFA" };
    })();
    results.push({ target: w.target, path: w.path, changed: outcome.changed, error: outcome.error });
    if (outcome.error) log(`  \u2717 ${w.target} \u2192 ${w.path}\uFF1A${outcome.error}`);
    else {
      if (outcome.changed) changed = true;
      log(`  ${outcome.changed ? "\u2713" : "\xB7"} ${w.target} \u2192 ${w.path}${outcome.note ? "\uFF1A" + outcome.note : ""}`);
    }
  }
  const ok = results.every((r) => !r.error);
  const summary = `${dryRun ? "[dry-run] " : ""}shim ${serverName} v${opts.version}\uFF08${opts.shimPath}\uFF09${results.length ? "\uFF1B" + results.map((r) => r.error ? r.target + " \u2717" : r.changed ? r.target + " \u2713" : r.target + " \xB7").join(" ") : "\uFF08\u65E0\u76EE\u6807\u6587\u4EF6\uFF09"}`;
  return { ok, changed, results, summary };
}
function resolveShimPathAuto(cwdCandidates) {
  const installedCandidates = [
    process.env.AITI_WEB_ROOT && join3(process.env.AITI_WEB_ROOT, "node_modules"),
    join3(homeDir(), ".pi", "web", "node_modules"),
    join3(homeDir(), ".pi", "web-dev", "node_modules")
  ].filter((p) => !!p).map((nm) => join3(nm, "@aiti-ai", "aiti-bridge", "bin", "aiti-mcp-shim.cjs"));
  const candidates = [
    process.env.AITI_SHIM_PATH,
    ...installedCandidates,
    ...cwdCandidates || [],
    join3(homeDir(), "workspace", "aiti-ai", "packages", "aiti-bridge", "bin", "aiti-mcp-shim.cjs")
  ].filter((p) => !!p);
  for (const p of candidates) {
    try {
      const m = readFileSync2(p, "utf8").match(/SHIM_VERSION\s*=\s*(\d+)/);
      if (m) return { shimPath: p, version: parseInt(m[1], 10) };
    } catch {
    }
  }
  return null;
}

// src/index.ts
import { existsSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join } from "node:path";
var z = tool.schema;
var BRIDGE_BASE = (process.env.AITI_BRIDGE_URL || "http://127.0.0.1:8777").replace(/\/+$/, "") + "/aiti";
var AGENT_ID = "opencode";
var PREFIX = "aiti_";
var DESCRIPTION_SUFFIX = "\uFF08aiti-devtools \u76F4\u8FDE\uFF0COpenCode \u4F1A\u8BDD\uFF09";
function schemaToZod(s) {
  const sch = s || {};
  const d = (zod) => typeof sch.description === "string" && sch.description ? zod.describe(sch.description) : zod;
  switch (sch.type) {
    case "string":
      return d(z.string());
    case "number":
      return d(z.number());
    case "boolean":
      return d(z.boolean());
    case "object": {
      if (sch.properties && typeof sch.properties === "object") {
        const shape = {};
        const req = new Set(Array.isArray(sch.required) ? sch.required : []);
        for (const [k, v] of Object.entries(sch.properties)) {
          shape[k] = req.has(k) ? schemaToZod(v) : schemaToZod(v).optional();
        }
        return d(z.object(shape));
      }
      return d(z.record(z.string(), z.any()));
    }
    case "array":
      return d(z.array(schemaToZod(sch.items)));
    default:
      return z.any();
  }
}
function schemaToShape(schema) {
  const out = {};
  const props = schema?.properties || {};
  const req = new Set(Array.isArray(schema?.required) ? schema.required : []);
  for (const [k, v] of Object.entries(props)) {
    out[k] = req.has(k) ? schemaToZod(v) : schemaToZod(v).optional();
  }
  return out;
}
async function fetchBridgeTools(base) {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5e3),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await res.json().catch(() => null);
  const tools = body?.result?.tools;
  return Array.isArray(tools) ? tools : [];
}
function autoRegisterShimInline() {
  try {
    const found = resolveShimPathAuto();
    if (!found) return;
    const cfgPath = join(homedir2(), ".config", "opencode", "opencode.json");
    if (!existsSync(cfgPath)) return;
    registerAitiShim({ shimPath: found.shimPath, version: found.version, configPaths: [cfgPath], log: () => {
    } });
  } catch {
  }
}
var AitiDevtoolsPlugin = async (input) => {
  const { client, directory: ctxDirectory } = input;
  autoRegisterShimInline();
  const bridge = new AgentBridgeClient(BRIDGE_BASE);
  const log = (msg) => {
    void client.app.log({ body: { service: "aiti-devtools-opencode", level: "info", message: msg } }).catch(() => {
    });
  };
  const sessions = /* @__PURE__ */ new Map();
  async function registerAndStream(sessionID, directory) {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const reg = await bridge.register({
      agentId: AGENT_ID,
      sessionId: sessionID,
      name: "OpenCode",
      cwd: directory,
      source: "plugin",
      subEvents: ["page_error"]
    });
    if (!reg || !reg.agentKey) return null;
    const sess = { agentKey: reg.agentKey, cwd: directory, stopStream: () => {
    } };
    sessions.set(sessionID, sess);
    sess.stopStream = bridge.connectAgentStream(
      async () => {
        const r = await bridge.register({ agentId: AGENT_ID, sessionId: sessionID, name: "OpenCode", cwd: directory, source: "plugin", subEvents: ["page_error"] });
        return r?.agentKey ?? null;
      },
      (m) => {
        const text = typeof m.text === "string" && m.text || (m.payload && typeof m.payload.text === "string" ? m.payload.text : "") || JSON.stringify(m);
        log("push \u2192 session.prompt: " + text.slice(0, 80));
        void client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } }).catch((e) => {
          log("session.prompt failed: " + (e instanceof Error ? e.message : String(e)));
        });
      }
    );
    log("session registered: " + sessionID + " (cwd " + directory + ")");
    return sess;
  }
  const bridgeTools = await fetchBridgeTools(BRIDGE_BASE);
  const hooks = { event: void 0, tool: {} };
  if (!bridgeTools.length) {
    log("bridge not reachable at " + BRIDGE_BASE + " \u2014 cold-start: " + BRIDGE_TOOLS.length + " self-healing placeholder tools registered");
    const errText = "\u6865\u4E0D\u53EF\u8FBE\uFF1A" + BRIDGE_BASE + "\u3002\u672C\u5DE5\u5177\u5904\u4E8E\u51B7\u542F\u52A8\u964D\u7EA7\u6A21\u5F0F\uFF08\u5360\u4F4D\u6E05\u5355\uFF09\uFF1B\u6865\u542F\u52A8/\u6062\u590D\u540E\u518D\u6B21\u8C03\u7528\u5373\u81EA\u52A8\u6D3E\u53D1\u771F\u5B9E\u5DE5\u5177\uFF0C\u65E0\u9700\u91CD\u542F opencode\u3002\u542F\u52A8\u72EC\u7ACB\u6865\uFF1Anode ~/workspace/aiti-dev/packages/aiti-bridge/bin/aiti-bridge.mjs\uFF08\u9ED8\u8BA4 127.0.0.1:8777\uFF09\u3002";
    const healExecute = (toolName) => async (args, ctx) => {
      const fresh = await fetchBridgeTools(BRIDGE_BASE);
      if (!fresh.length) return errText;
      const sess = await registerAndStream(ctx.sessionID, ctx.directory);
      if (!sess) return "\u6865\u6CE8\u518C\u5931\u8D25\uFF1A" + BRIDGE_BASE + "\uFF08\u6865\u53EF\u80FD\u521A\u6062\u590D\uFF0C\u91CD\u8BD5\u5373\u53EF\uFF09";
      log("bridge back up \u2014 healed dispatch: " + toolName + " (" + fresh.length + " tools live)");
      const r = await bridge.callTool(toolName, args || {}, { agentId: AGENT_ID, sessionId: ctx.sessionID, cwd: ctx.directory, cancelId: ctx.callID }, ctx.abort);
      const wrapped = wrapToolResult(r);
      return wrapped.content[0]?.text ?? JSON.stringify(wrapped);
    };
    hooks.tool = Object.fromEntries(BRIDGE_TOOLS.map((t) => [
      PREFIX + t.name,
      tool({
        description: "\u3010\u51B7\u542F\u52A8\u964D\u7EA7\xB7\u6865\u4E0D\u53EF\u8FBE\u3011" + (t.description || t.name) + DESCRIPTION_SUFFIX,
        args: schemaToShape(t.inputSchema || { type: "object", properties: {} }),
        execute: healExecute(t.name)
      })
    ]));
    return hooks;
  }
  for (const t of bridgeTools) {
    hooks.tool[PREFIX + t.name] = tool({
      description: (t.description || t.name) + DESCRIPTION_SUFFIX,
      args: schemaToShape(t.inputSchema || { type: "object", properties: {} }),
      async execute(args, ctx) {
        const sess = await registerAndStream(ctx.sessionID, ctx.directory);
        if (!sess) return "\u6865\u6CE8\u518C\u5931\u8D25\uFF1A" + BRIDGE_BASE + "\uFF08\u6865\u53EF\u80FD\u521A\u91CD\u542F\uFF0C\u91CD\u8BD5\u5373\u53EF\uFF09";
        const r = await bridge.callTool(
          t.name,
          args || {},
          { agentId: AGENT_ID, sessionId: ctx.sessionID, cwd: ctx.directory, cancelId: ctx.callID },
          ctx.abort
        );
        const wrapped = wrapToolResult(r);
        return wrapped.content[0]?.text ?? JSON.stringify(wrapped);
      }
    });
  }
  log("registered " + bridgeTools.length + " aiti_* tools from " + BRIDGE_BASE);
  hooks.event = async ({ event }) => {
    if (event.type === "session.idle") {
      const sessionID = event.properties?.sessionID;
      const sess = sessionID ? sessions.get(sessionID) : null;
      if (!sess) return;
      try {
        const res = await client.session.messages({ path: { id: sessionID } });
        const msgs = res.data ?? [];
        const last = [...msgs].reverse().find((m) => m.info.role === "assistant");
        const text = (last?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
        if (text) await bridge.answer(sess.agentKey, text);
      } catch {
      }
    } else if (event.type === "session.error") {
      const props = event.properties;
      const sess = props?.sessionID ? sessions.get(props.sessionID) : null;
      if (!sess) return;
      const errName = String(props.error?.name || "");
      const errMsg = String(props.error?.data?.message || props.error?.name || "\u672A\u77E5\u9519\u8BEF");
      const text = /abort/i.test(errName) ? "\u23F9 \u4F1A\u8BDD\u5DF2\u88AB\u4E2D\u6B62\uFF08\u7528\u6237\u53D6\u6D88\uFF09\uFF0C\u672C\u8F6E\u7EC8\u6B62\u3002" : "\u26A0\uFE0F \u4F1A\u8BDD\u51FA\u9519\uFF1A" + errMsg;
      try {
        await bridge.answer(sess.agentKey, text);
      } catch {
      }
    }
  };
  hooks["chat.message"] = async (input2) => {
    const sessionID = input2.sessionID;
    if (sessionID && !sessions.has(sessionID)) {
      void registerAndStream(sessionID, input2.directory || ctxDirectory).catch(() => {
      });
    }
  };
  const PLACEHOLDER_EXISTS = /\[(?:元素|回答|错误|选择)\d+\]/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fetchPicked() {
    try {
      const res = await fetch(BRIDGE_BASE + "/bridge/picked", { signal: AbortSignal.timeout(4e3) });
      if (!res.ok) return [];
      const b = await res.json().catch(() => null);
      return Array.isArray(b?.candidates) ? b.candidates : [];
    } catch {
      return [];
    }
  }
  hooks["experimental.chat.messages.transform"] = async (_input, output) => {
    const msgs = output.messages || [];
    if (!msgs.length) return;
    const hasTag = msgs.some((m) => m?.info?.role === "user" && (m.parts || []).some((p) => p?.type === "text" && PLACEHOLDER_EXISTS.test(String(p.text || ""))));
    if (!hasTag) return;
    let picked = [];
    for (let i = 0; i < 9; i++) {
      picked = await fetchPicked();
      if (picked.length) break;
      await sleep(100);
    }
    const pid = picked.find((c) => c.pageId)?.pageId || null;
    let pageUrl = null;
    if (pid) {
      try {
        const res = await fetch(BRIDGE_BASE + "/bridge/sessions", { signal: AbortSignal.timeout(4e3) });
        if (res.ok) {
          const rows = await res.json().catch(() => []);
          pageUrl = (Array.isArray(rows) ? rows : []).find((r) => r?.pageId === pid)?.url || null;
        }
      } catch {
      }
    }
    const cands = picked.map((c) => ({ tag: c.tag, describe: c.describe, pageId: c.pageId }));
    const rwOpts = { pid, pageUrl };
    const usedTagsAll = [];
    let lastUser = null;
    for (const m of msgs) {
      if (m && m.info?.role === "user" && Array.isArray(m.parts)) lastUser = m;
    }
    if (!lastUser) return;
    for (const p of lastUser.parts) {
      if (!p || p.type !== "text" || typeof p.text !== "string" || !p.text) continue;
      if (!PLACEHOLDER_EXISTS.test(p.text)) continue;
      const r = rewriteMessage(p.text, cands, rwOpts);
      if (r.text === p.text) continue;
      p.text = r.text;
      if (r.usedAny) usedTagsAll.push(...r.usedTags);
    }
    const used = [...new Set(usedTagsAll)];
    if (used.length) {
      log("placeholder consumed: " + used.join(","));
      void fetch(BRIDGE_BASE + "/bridge/ai/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(4e3),
        body: JSON.stringify({ event: "aiti_consumed", payload: { tags: used, pid, at: Date.now() } })
      }).catch(() => {
      });
    }
  };
  return hooks;
};
var index_default = AitiDevtoolsPlugin;
export {
  AitiDevtoolsPlugin,
  index_default as default
};
