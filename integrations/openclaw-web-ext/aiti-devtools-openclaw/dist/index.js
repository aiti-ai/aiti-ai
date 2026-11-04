/**
 * @aiti-ai/aiti-devtools-openclaw —— aiti-devtools 宿主 adapter（OpenClaw 插件）v0.2
 * 由 tools/build.mjs 生成（2026-08-24T05:29:18.327Z）；工具定义源：桥 MCP tools/list（16 个）。
 *
 * v0.3 能力：
 *   1. api.registerTool × 16（aiti_ 前缀）；execute → POST {bridge}/bridge/agent/tools/call（REST 直连，无 MCP）
 *   2. 身份接线：toolContext（agentId/sessionId/sessionKey/workspaceDir）→ 桥会话（registered + cwd 显示）
 *   3. 桥推送：每会话 SSE（/bridge/agent/sse）→ agent_push/page_event → 会话注入（见 6）
 *   4. 答复回传：api.on("before_message_write") → 已知 aiti 会话（sessionKey 匹配）→ POST /bridge/agent/answer（AI 窗/页面实时显示）
 *   5. 会话自动上线：api.on("session_start")（新会话）+ before_message_write user 消息兑底（gateway 重启后已有会话）
 *      → POST /bridge/agent/register + 开 SSE 流——**不等调过工具**（cockpit 主动发起的消息有处可投）；session_end → 下线。
 *   6. 消息进循环（v0.5）：非 bundled 插件的 scheduleSessionTurn 被 origin 门拦（返回 undefined 静默）——
 *      改走 registerHttpRoute(/aiti-devtools-push, auth:'plugin') + dispatchGatewayMethod('chat.send')（官方契约），
 *      onPush 同时 enqueueNextTurnInjection 兑底（下一轮可见）。
 *   7. 占位符改写（v0.6，DSH pre-step 等价物）：用户消息里的 [元素N]/[回答N]/[错误N] 在
 *      before_message_write（落盘前）展开为完整描述 + [发自: pid · url]；候选源 = 桥 GET /bridge/picked
 *      （cockpit 点选上报）；消费 → POST /bridge/ai/event aiti_consumed（AI 窗清候选）。
 *      另挂 before_prompt_build：prependSystemContext 注入 aiti 使用守则（缓存友好）。
 *
 * 桥地址：plugins.entries.aiti-devtools.config.bridgeUrl > 环境变量 AITI_BRIDGE_URL > http://127.0.0.1:8777。
 */
const TOOLS = [
 {
  "ocName": "aiti_page_exec",
  "name": "page_exec",
  "description": "在已连接页面执行类 CDP 命令（DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser 域）。危险命令/浏览器受限操作会自动弹用户确认；Page.captureScreenshot 截屏会弹确认卡+浏览器选择器（大图自动落盘返回文件路径）。调试会话中从被调试页面（inject）发出的消息统一带 [发自: <pageId> · <url>] 来源标注——把 pageId 值传给 pageId 参数即操作该页面。\n\niframe 支持：Page.getFrameTree 查看 frame 树（iframe src/name/title，同域含 url/readyState）；Runtime.evaluate 传 contextId（iframe 索引从 1 起，同域可 eval）进 iframe 上下文执行。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "cmd": {
     "type": "string"
    },
    "args": {
     "type": "object"
    },
    "pageId": {
     "type": "string",
     "description": "目标页面完整 ID——来自 AI 消息的 [发自: xxx]（如 30142/host）；也可 /bridge/sessions 查询"
    }
   },
   "required": [
    "cmd"
   ]
  }
 },
 {
  "ocName": "aiti_page_snapshot",
  "name": "page_snapshot",
  "description": "拉取已连接页面基础现场（URL/选区/模拟条件）",
  "inputSchema": {
   "type": "object",
   "properties": {
    "pageId": {
     "type": "string"
    }
   }
  }
 },
 {
  "ocName": "aiti_self_ui",
  "name": "self_ui",
  "description": "扫描目标页面（缺省 AI 主窗口 xxx/ai）当前打开的弹窗/dialog/表单字段/按钮清单——ai-helper 回填定位用。返回 {dialogs:[{title, fields:[{label,selector,type}], buttons}]}，无弹窗时 dialogs 为空数组。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "pageId": {
     "type": "string",
     "description": "缺省用 AI 主窗口（xxx/ai）；也可指定其他页面"
    }
   }
  }
 },
 {
  "ocName": "aiti_form_fill",
  "name": "form_fill",
  "description": "在目标页面（缺省 AI 主窗口 xxx/ai）的弹窗/表单里回填字段值——AI 结果直接操作扩展弹窗表单（React 兼容：原生 value setter + dispatch input/change）。配合 self_ui 使用：先 self_ui 拿字段 label/selector，再 form_fill 填值。参数：dialog（弹窗标识：标题子串或序号 0 起，缺省取面积最大的可见弹窗）、fields[{selector|label, value}]、button（可选，回填后点击的按钮文本如『保存』）。返回 {foundDialog, title, filled, missed, clicked}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "pageId": {
     "type": "string",
     "description": "缺省用 AI 主窗口（xxx/ai）；也可指定其他页面"
    },
    "dialog": {
     "type": "string",
     "description": "弹窗标识：标题子串或序号（0 起）；缺省取面积最大的可见弹窗"
    },
    "fields": {
     "type": "array",
     "items": {
      "type": "object",
      "properties": {
       "selector": {
        "type": "string",
        "description": "CSS 选择器（优先）"
       },
       "label": {
        "type": "string",
        "description": "弹窗内文本匹配（label[for]/包裹/文本包含）"
       },
       "value": {
        "type": "string",
        "description": "要填的值"
       }
      },
      "required": [
       "value"
      ]
     },
     "description": "要填的字段列表"
    },
    "button": {
     "type": "string",
     "description": "回填后点击的按钮文本（如『保存』『确定』）"
    }
   }
  }
 },
 {
  "ocName": "aiti_bridge_status",
  "name": "bridge_status",
  "description": "查询已连接页面（sessions：含 pageId/url/title/frameworks）与挂起请求。用户提到页面标题或 URL 时，按 title/url 匹配 pageId（如 refresh『某标题页面』或『某个 url 页面』）。",
  "inputSchema": {
   "type": "object",
   "properties": {}
  }
 },
 {
  "ocName": "aiti_page_logs",
  "name": "page_logs",
  "description": "从目标页面拉取本地缓冲的 console 日志（log/debug/info/warn/error 全量，CDP Runtime.evaluate 读取 window.__dbg.__consoleRing）。页面报错排查首选：先查 warn/error 再逐步放开。返回 {logs:[{ts,level,text,count}], bufferSize}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "pageId": {
     "type": "string",
     "description": "目标页面完整 ID（[发自: xxx] 或 /bridge/sessions）"
    },
    "level": {
     "type": "string",
     "description": "过滤级别：debug/log/info/warn/error（默认全部）"
    },
    "since": {
     "type": "string",
     "description": "ISO 时间：只返回此时间之后的日志"
    },
    "limit": {
     "type": "number",
     "description": "条数上限（≤200，默认 50，取最新）"
    },
    "token": {
     "type": "string"
    }
   }
  }
 },
 {
  "ocName": "aiti_page_network",
  "name": "page_network",
  "description": "从目标页面拉取本地缓冲的 ajax/fetch 请求完成态（CDP Runtime.evaluate 读取 window.__dbg.__netRing）。失败排查：status 传 400 或 errorOnly:true。注意：不含静态资源加载（那是 CDP Network 的能力）。返回 {requests:[{kind,method,url,status,statusText,durationMs,size,error,ts}], bufferSize}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "pageId": {
     "type": "string"
    },
    "url": {
     "type": "string",
     "description": "URL 子串过滤"
    },
    "status": {
     "type": "number",
     "description": "status >= 此值才返回（如 400 只看失败）"
    },
    "errorOnly": {
     "type": "boolean",
     "description": "只看失败（error 非空 或 status>=400）"
    },
    "limit": {
     "type": "number",
     "description": "条数上限（≤100，默认 30，取最新）"
    },
    "token": {
     "type": "string"
    }
   }
  }
 },
 {
  "ocName": "aiti_user_pick_element",
  "name": "user_pick_element",
  "description": "请当前页面的人类用户点选一个页面元素（自动进入 Inspector 点选模式、收起 AI 窗口、弹点选面板；用户可确认选中或拒绝）。返回元素载荷 {tag,rect,xpath,text,attributes,framework,selector}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "prompt": {
     "type": "string",
     "description": "给用户看的说明（为什么需要点选这个元素）"
    },
    "timeout": {
     "type": "number",
     "description": "等待超时 ms（默认 60000，范围 5000-300000）"
    },
    "rejectable": {
     "type": "boolean",
     "description": "是否允许用户拒绝（默认 true）"
    },
    "async": {
     "type": "boolean",
     "description": "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待"
    },
    "pageId": {
     "type": "string",
     "description": "目标页面完整 ID（instanceId/frameId）"
    }
   },
   "required": [
    "prompt"
   ]
  }
 },
 {
  "ocName": "aiti_user_confirm",
  "name": "user_confirm",
  "description": "在 AI 窗口内向人类用户提一个是/否问题（如“确认执行此操作？”“是否继续？”），用户点 ✅/❌ 作答，并可附「补充说明」自由文本（value.comment）；另有固定选项「都不适合」→ 自定义回答（approved:null, custom）。返回 {status, approved, comment?, custom?, reason?}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "prompt": {
     "type": "string",
     "description": "问题内容"
    },
    "timeout": {
     "type": "number",
     "description": "等待超时 ms（默认 60000）"
    },
    "rejectable": {
     "type": "boolean",
     "description": "是否允许用户以“暂时无法处理”拒绝（默认 true）"
    },
    "async": {
     "type": "boolean",
     "description": "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送（不阻塞本调用）；缺省=同步等待"
    },
    "pageId": {
     "type": "string"
    }
   },
   "required": [
    "prompt"
   ]
  }
 },
 {
  "ocName": "aiti_user_choose",
  "name": "user_choose",
  "description": "在 AI 窗口内给人类用户一组选项让其选择（如修复方案 A/B/C）。单选（默认）→ value:{index,label}；multiple:true 多选 → value:{indexes,labels}。用户可附「补充说明」自由文本（value.comment）；另有固定选项「这些都不适合」→ 自定义答案（index:-1, custom:true）。返回 {status, value, reason?}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "prompt": {
     "type": "string"
    },
    "choices": {
     "type": "array",
     "items": {
      "type": "string"
     },
     "description": "选项列表（2-8 个）"
    },
    "multiple": {
     "type": "boolean",
     "description": "是否允许多选（默认 false；true 时返回 indexes/labels）"
    },
    "timeout": {
     "type": "number"
    },
    "rejectable": {
     "type": "boolean",
     "description": "是否允许用户拒绝（默认 true）"
    },
    "async": {
     "type": "boolean",
     "description": "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待"
    },
    "pageId": {
     "type": "string"
    }
   },
   "required": [
    "prompt",
    "choices"
   ]
  }
 },
 {
  "ocName": "aiti_user_input",
  "name": "user_input",
  "description": "在 AI 窗口内请人类用户输入一段文本（如期望文案、配置值、场景描述），回车/点击即发送。返回 {status, value:{text}, reason?}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "prompt": {
     "type": "string"
    },
    "defaultValue": {
     "type": "string",
     "description": "预填默认值（可选）"
    },
    "timeout": {
     "type": "number"
    },
    "rejectable": {
     "type": "boolean",
     "description": "是否允许用户拒绝（默认 true）"
    },
    "async": {
     "type": "boolean",
     "description": "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待"
    },
    "pageId": {
     "type": "string"
    }
   },
   "required": [
    "prompt"
   ]
  }
 },
 {
  "ocName": "aiti_user_presence",
  "name": "user_presence",
  "description": "探测人类用户是否在场/在线（AI 需要用户配合长任务前先确认），用户点「我在/稍后」，可附「补充说明」（value.comment）。返回 {status, present, comment?}；超时即视为不在线。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "prompt": {
     "type": "string",
     "description": "询问文案（默认“你在吗？需要你配合继续开发”）"
    },
    "timeout": {
     "type": "number",
     "description": "默认 30000"
    },
    "async": {
     "type": "boolean",
     "description": "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待"
    },
    "pageId": {
     "type": "string"
    }
   },
   "required": []
  }
 },
 {
  "ocName": "aiti_user_notify",
  "name": "user_notify",
  "description": "非阻塞通知：通过浏览器 Notification 告诉用户一条消息（如“修复完成，请刷新验证”），不等待回答。返回 {notified:true}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "title": {
     "type": "string",
     "description": "通知标题"
    },
    "body": {
     "type": "string",
     "description": "通知内容"
    },
    "async": {
     "type": "boolean",
     "description": "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待"
    },
    "pageId": {
     "type": "string"
    }
   },
   "required": [
    "body"
   ]
  }
 },
 {
  "ocName": "aiti_aiti_hello",
  "name": "aiti_hello",
  "description": "agent 自我介绍/注册：覆盖 agentId（默认 clientInfo.name）与 sessionId（默认 Mcp-Session-Id 或桥随机）、绑定默认目标页 pageId、订阅页面事件（page_error）。注意：page_log/page_network 不再实时推送，改用 page_logs/page_network 工具按需拉取。建议会话开始时调用一次——注册后消息可定向到本会话（agentKey=agentId/sessionId）。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "agentId": {
     "type": "string",
     "description": "自定义 agent 标识（如 pi / cc / qoder；缺省用 clientInfo.name）"
    },
    "sessionId": {
     "type": "string",
     "description": "本实例会话标识（多实例/多会话时区分；缺省用 Mcp-Session-Id，无则桥生成随机）"
    },
    "name": {
     "type": "string",
     "description": "显示名（可选，如 'pi · 工作区A'）"
    },
    "cwd": {
     "type": "string",
     "description": "工作目录（可选，显示 CWD . name (id)，方便识别 agent 身份）"
    },
    "pageId": {
     "type": "string",
     "description": "绑定默认调试目标页（pageId/url/title 均可，留空不绑）"
    },
    "subEvents": {
     "type": "array",
     "items": {
      "type": "string"
     },
     "description": "订阅实时事件：page_error（默认不投递，显式订阅才推；page_log/page_network 不再实时推送，改用 page_logs/page_network 工具按需拉取）"
    }
   }
  }
 },
 {
  "ocName": "aiti_file_stat",
  "name": "file_stat",
  "description": "查询文件存在性/类型/大小/修改时间（绝对路径；组件源码/调用位置定位、AI 窗『后端打开/前端打开』前置校验用）。不存在或非法路径返回 {exists:false}。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "path": {
     "type": "string",
     "description": "绝对路径（如 /home/user/src/App.vue）"
    }
   },
   "required": [
    "path"
   ]
  }
 },
 {
  "ocName": "aiti_aiti_inbox",
  "name": "aiti_inbox",
  "description": "消息主通道：拉取发给本 agent 会话的消息（人主动发话 user_message / 异步 user_* 作答 user_answer / 订阅的页面事件）。开始新一轮或需要最新信息时先调用；处理完把消息 id 放 ack 参数确认（标记 consumed，历史保留）。返回 agentKey（agentId/sessionId），未注册时提示调 aiti_hello 注册。",
  "inputSchema": {
   "type": "object",
   "properties": {
    "agentId": {
     "type": "string",
     "description": "agent 标识（缺省用 aiti_hello 注册值或 clientInfo.name）"
    },
    "sessionId": {
     "type": "string",
     "description": "本实例会话标识（缺省用 Mcp-Session-Id 或 aiti_hello 注册值）"
    },
    "ack": {
     "description": "已处理消息 id 列表，或 { ids: [...], summary: '执行总结' }——summary（必带）会作为 agent 处理记录显示在操作台消息流",
     "oneOf": [
      {
       "type": "array",
       "items": {
        "type": "string"
       }
      },
      {
       "type": "object",
       "properties": {
        "ids": {
         "type": "array",
         "items": {
          "type": "string"
         }
        },
        "summary": {
         "type": "string"
        }
       }
      }
     ]
    }
   }
  }
 }
];

import { randomUUID } from 'node:crypto';

let dispatchGatewayMethod = null; // 懒加载（handler 首次调用时 import；loader 禁 top-level await）

const ROUTE_TOKEN = randomUUID();
const state = { bridgeUrl: '', api: null, routeToken: ROUTE_TOKEN, gatewayPort: process.env.OPENCLAW_GATEWAY_PORT || '18789', gatewayToken: '' };
/** 桥 agentKey → ident（{agentId, sessionId, sessionKey, cwd}） */
const sessions = new Map();

function base() {
  return (state.bridgeUrl || process.env.AITI_BRIDGE_URL || 'http://127.0.0.1:8777').replace(/\/+$/, '');
}

async function callBridge(tool, args, ident) {
  let r;
  try {
    r = await fetch(base() + '/bridge/agent/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool, args: args ?? {},
        agentId: ident.agentId, sessionId: ident.sessionId, cwd: ident.cwd, source: 'extension',
      }),
    });
  } catch (e) {
    return { ok: false, text: 'aiti-devtools 桥不可达（' + base() + '）：' + String((e && e.message) || e) };
  }
  const d = await r.json().catch(() => ({ ok: false, error: 'bad bridge response ' + r.status }));
  if (!d.ok) return { ok: false, text: '桥错误：' + String(d.error || r.status) };
  return { ok: true, text: String(d.result ?? ''), isError: !!d.isError, agentKey: d.agentKey };
}

/** 记录会话并确保桥 SSE 流（推送 → scheduleSessionTurn） */
function recordSession(ident, agentKey) {
  if (!agentKey || !ident.sessionKey) return;
  if (sessions.has(agentKey)) return;
  sessions.set(agentKey, ident);
  openStream(agentKey, ident);
}

/** 会话自动上线：register → 开流（幂等）。session_start（新会话）/ user 消息兑底（重启后已有会话）都调它。 */
async function ensureRegistered(ident) {
  if (!ident || !ident.sessionKey) return null;
  if (!ident.sessionId) {
    // bmw 的 ctx 只有 {agentId, sessionKey}（无 sessionId）——从 sessionKey 尾段派生（桥侧 sessionId 只要求稳定唯一）
    const tail = ident.sessionKey.split(':').filter(Boolean).pop();
    ident.sessionId = tail || ident.sessionKey;
  }
  for (const [k, v] of sessions) if (v.sessionKey === ident.sessionKey) return k; // 已上线
  try {
    const r = await fetch(base() + '/bridge/agent/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: ident.agentId, sessionId: ident.sessionId, name: 'openclaw', cwd: ident.cwd || undefined, source: 'extension' }),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok || !d.agentKey) return null;
    recordSession({ ...ident, sessionKey: ident.sessionKey }, d.agentKey);
    try { console.log('[aiti-devtools-openclaw] 会话上线 ' + ident.sessionKey + ' → ' + d.agentKey); } catch {}
    return d.agentKey;
  } catch { return null; }
}

function dropSession(agentKey) {
  sessions.delete(agentKey); // 流靠空闲 60s 自然断；openStream 重连前查 Map 不在即停
}

const STREAM_IDLE_MS = 60000;
function openStream(agentKey, ident) {
  let retry = 2000;
  let stopped = false;
  const run = async () => {
    if (stopped || !sessions.has(agentKey)) return; // 会话已下线（session_end）→ 停止重连
    const ctrl = new AbortController();
    let idleTimer = null;
    const poke = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { try { ctrl.abort(); } catch {} }, STREAM_IDLE_MS);
    };
    try {
      const resp = await fetch(base() + '/bridge/agent/sse?agentKey=' + encodeURIComponent(agentKey), {
        signal: ctrl.signal, headers: { Accept: 'text/event-stream' },
      });
      if (!resp.ok || !resp.body) throw new Error('SSE HTTP ' + resp.status);
      retry = 2000;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      poke();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        poke();
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (line) { try { onPush(ident, JSON.parse(line.slice(5).trim())); } catch {} }
        }
      }
    } catch {}
    if (idleTimer) clearTimeout(idleTimer);
    setTimeout(() => { if (!stopped) run(); }, retry);
    retry = Math.min(30000, retry * 2);
  };
  run();
}

/** 桥推送 → 会话注入：主路 chat.send（立即触发一轮）；失败才兑底 enqueueNextTurnInjection（下一轮可见）。
 *  ⚠ 两路不能同时成功——同一文本会重复进上下文（chat.send 的 prompt + enqueue 的 append_context）。 */
async function pushToSession(ident, text) {
  const api = state.api;
  // 主路：chat.send 立即触发（经插件路由获得 dispatch 作用域）
  let sent = false;
  try {
    const r = await fetch('http://127.0.0.1:' + state.gatewayPort + '/aiti-devtools-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aiti-token': state.routeToken, authorization: 'Bearer ' + state.gatewayToken },
      body: JSON.stringify({ sessionKey: ident.sessionKey, message: text }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) { sent = true; }
    else console.error('[aiti-devtools-openclaw] chat.send 失败：' + JSON.stringify(d).slice(0, 200));
  } catch (e) {
    try { console.error('[aiti-devtools-openclaw] chat.send 路由不可达', e && e.message); } catch {}
  }
  if (sent) return;
  // 兑底：下一轮注入（仅 chat.send 失败时）
  try {
    if (api && typeof api.session?.workflow?.enqueueNextTurnInjection === 'function') {
      await api.session.workflow.enqueueNextTurnInjection({ sessionKey: ident.sessionKey, text, placement: 'append_context' });
      try { console.log('[aiti-devtools-openclaw] chat.send 失败 → 已兑底 enqueue 下一轮注入'); } catch {}
    }
  } catch {}
}

function onPush(ident, m) {
  if (!m || typeof m !== 'object') return;
  let text = '';
  if (m.type === 'page_event') text = String(m.text || '');
  else if (m.type === 'agent_push') {
    text = (m.kind === 'user_answer' ? '💬 你的交互请求有人作答（来自 aiti-devtools）：' : '💬 人发来消息（来自 aiti-devtools）：') + (m.text || '');
  }
  if (!text) return;
  try { console.log('[aiti-devtools-openclaw] 推送 → 会话 ' + ident.sessionKey + '：' + text.slice(0, 120)); } catch {}
  // 推送到达 = 人刚操作过页面/AI 窗 → 顺手预取候选缓存（同步 bmw 展开用）
  if (ident && ident.sessionKey) {
    const k = agentKeyForSession(ident.sessionKey, null);
    if (k) refreshPickedCache(k);
  }
  pushToSession(ident, text);
}

/** 答复回传：agent 回复完成 → 已知 aiti 会话 → POST /bridge/agent/answer（AI 窗/页面实时显示）。
 *  只回传本插件记录过的会话（调过 aiti 工具），避免把钉钉等所有渠道回复灌进桥。 */
async function answerToBridge(agentKey, text) {
  try {
    const r = await fetch(base() + '/bridge/agent/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentKey, text }),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.error('[aiti-devtools-openclaw] answer 回传失败：' + JSON.stringify(d).slice(0, 200));
    else console.log('[aiti-devtools-openclaw] 答复已回桥（' + String(text || '').slice(0, 60) + '…）');
  } catch (e) {
    try { console.error('[aiti-devtools-openclaw] answer 回传异常', e); } catch {}
  }
}

function agentKeyForSession(sessionKey, sessionId) {
  for (const [key, ident] of sessions) {
    if ((sessionKey && ident.sessionKey === sessionKey) || (!sessionKey && sessionId && ident.sessionId === sessionId)) return key;
  }
  return null;
}

// ---- 占位符改写（v0.6，core send-rewrite 语义的独立实现：无构建链依赖） ----
const PLACEHOLDER_RE = /[(?:元素|回答|错误|选择)d+]/g;
const LEGACY_TAG_RE = /[选择d+]/g;
/** 自实现 replaceTag（core 同语义：替换后清理多余空行） */
function replaceTag(text, tag, describe) {
  const out = text.split(tag).join(describe);
  return out.replace(/\n{3,}/g, '\n\n');
}
function stripOrphanTags(text) {
  return text.replace(PLACEHOLDER_RE, '').replace(/[ 	]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}
function withSourceTag(text, pid, pageUrl) {
  if (!pid) return text;
  const tag = pageUrl ? ' [发自: ' + pid + ' · ' + pageUrl + '（aiti-*：pageId 参数用它）]' : ' [发自: ' + pid + '（aiti-*：pageId 参数用它）]';
  const re = /s*[发自: [^]]*]s*$/;
  return re.test(text) ? text.replace(re, tag) : text + tag;
}
/** 拉取候选（桥 GET /bridge/picked；依次试 agentKey → agentId → __all__）+ 页 URL */
async function fetchPickedAndUrl(agentKey) {
  try {
    const tries = [agentKey, 'openclaw', '__all__'];
    let cands = [];
    for (const k of tries) {
      const r = await fetch(base() + '/bridge/picked?agentKey=' + encodeURIComponent(k), { headers: { accept: 'application/json' } });
      const d = await r.json().catch(() => ({}));
      if (d.ok && Array.isArray(d.candidates) && d.candidates.length) {
        cands = d.candidates.filter((c) => c && typeof c.tag === 'string' && typeof c.describe === 'string');
        break;
      }
    }
    const pid = (cands.find((c) => c.pageId) || {}).pageId || null;
    let pageUrl = null;
    if (pid) {
      try {
        const r2 = await fetch(base() + '/bridge/sessions', { headers: { accept: 'application/json' } });
        const d2 = await r2.json().catch(() => []);
        const hit = (Array.isArray(d2) ? d2 : []).find((x) => x && x.pageId === pid);
        pageUrl = (hit && hit.url) || null;
      } catch {}
    }
    return { cands, pid, pageUrl };
  } catch { return { cands: [], pid: null, pageUrl: null }; }
}
/** 占位符改写主函数（rewriteMessage 同语义）：返回 {text, usedTags} */
function rewriteText(text, cands, pid, pageUrl) {
  let out = String(text || '');
  const usedTags = [];
  out = out.replace(LEGACY_TAG_RE, '');
  if (cands.length) {
    for (const c of cands) {
      if (c.tag && out.includes(c.tag)) {
        out = replaceTag(out, c.tag, c.describe || c.tag);
        usedTags.push(c.tag);
      }
    }
  }
  out = stripOrphanTags(out);
  return { text: withSourceTag(out, pid, pageUrl), usedTags };
}
async function notifyConsumed(tags, pid) {
  try {
    await fetch(base() + '/bridge/ai/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'aiti_consumed', payload: { tags, pid: pid || null, at: Date.now() } }),
    });
  } catch {}
}

/** 候选缓存（agentKey → {cands,pid,pageUrl}）：SSE 推送到达时预取；同步 bmw 展开用（不能 await） */
const pickedCache = new Map();
async function refreshPickedCache(agentKey) {
  const p = await fetchPickedAndUrl(agentKey);
  if (p.cands.length) pickedCache.set(agentKey, p);
  else pickedCache.delete(agentKey);
  return p;
}

/** AgentMessage.content → 纯文本（string 或 parts 数组） */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((p) => (p && p.type === 'text' ? String(p.text || '') : '')).join('\n').trim();
  if (content.type === 'text') return String(content.text || '').trim();
  return '';
}

export default {
  name: 'aiti-devtools',
  register(api) {
    state.api = api;
    try {
      const cfg = (typeof api.getConfig === 'function' ? api.getConfig() : api.pluginConfig) || api.pluginConfig || {};
      if (cfg && typeof cfg.bridgeUrl === 'string' && cfg.bridgeUrl) state.bridgeUrl = cfg.bridgeUrl;
    } catch {}
    // gateway token（auth:'gateway' 路由的内部调用凭据）
    try {
      const t = api.config && api.config.gateway && api.config.gateway.auth && api.config.gateway.auth.token;
      if (typeof t === 'string' && t) state.gatewayToken = t;
    } catch {}
    // chat.send 触发路由（auth:'plugin'，挂 gateway 根路径；仅本插件内部调用，校验启动期随机 token）。
    // manifest contracts.gatewayMethodDispatch:['authenticated-request'] 授权 dispatchGatewayMethod。
    try {
      api.registerHttpRoute({
        path: '/aiti-devtools-push',
        auth: 'gateway',
        match: 'exact',
        gatewayRuntimeScopeSurface: 'write-default',
        async handler(req, res) {
          try {
            if (req.headers['x-aiti-token'] !== state.routeToken) { res.writeHead(403); res.end('{}'); return; }
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            if (!body.sessionKey || !body.message) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"bad request"}'); return; }
            if (!dispatchGatewayMethod) {
              try { ({ dispatchGatewayMethod } = await import('openclaw/plugin-sdk/gateway-method-runtime')); } catch {}
            }
            if (!dispatchGatewayMethod) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"dispatchGatewayMethod unavailable"}'); return; }
            const r = await dispatchGatewayMethod('chat.send', { sessionKey: body.sessionKey, message: body.message, idempotencyKey: 'aiti-' + randomUUID() }, { expectFinal: true, timeoutMs: 15000 });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: r.ok, error: r.error && r.error.message }));
          } catch (e) {
            try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); } catch {}
          }
        },
      });
    } catch (e) { try { console.error('[aiti-devtools-openclaw] registerHttpRoute 失败', e); } catch {} }
    // 会话自动上线：新会话立即注册（cockpit 主动发消息有处可投）；typed hook 用 api.on。
    try {
      api.on('session_start', (event, ctx) => {
        try {
          const ident = {
            agentId: 'openclaw', // 桥侧统一身份（cockpit to:'openclaw' 可定向）
            ocAgentId: (ctx && ctx.agentId) || 'main',
            sessionId: (event && event.sessionId) || (ctx && ctx.sessionId) || '',
            sessionKey: (event && event.sessionKey) || (ctx && ctx.sessionKey) || '',
            cwd: '',
          };
          ensureRegistered(ident);
        } catch {}
      });
      api.on('session_end', (event, ctx) => {
        try {
          const sk = (event && (event.sessionKey || event.sessionId)) || (ctx && (ctx.sessionKey || ctx.sessionId));
          if (!sk) return;
          for (const [k, v] of [...sessions]) if (v.sessionKey === sk || v.sessionId === sk) dropSession(k);
        } catch {}
      });
    } catch (e) { try { console.error('[aiti-devtools-openclaw] session hooks 注册失败', e); } catch {} }
    // 占位符改写（v0.6）：user 消息落盘前展开。⚠ before_message_write 是同步 hook（async 返回值被忽略）
    // → 不能在 handler 里 await；候选已在 push 时预取缓存（pickedCache，SSE 推送自带候选时更新）。
    try {
      api.on('before_message_write', (event, ctx) => {
        try {
          const msg = event && event.message;
          if (!msg || msg.role !== 'user') return;
          const raw = extractText(msg.content);
          if (!raw) return;
          PLACEHOLDER_RE.lastIndex = 0;
          if (!PLACEHOLDER_RE.test(raw)) { PLACEHOLDER_RE.lastIndex = 0; return; }
          PLACEHOLDER_RE.lastIndex = 0;
          const sk = (ctx && ctx.sessionKey) || event.sessionKey || msg.sessionKey;
          const key = sk ? agentKeyForSession(sk, null) : null;
          const p = (key && pickedCache.get(key)) || pickedCache.get('__all__') || null;
          if (!p) return; // 无候选缓存（未收到过携带候选的推送/未预取）不改写
          // 只用与本文匹配的候选（桥 picked 全局键可能被其他宿主会话覆盖，跨会话候选不作数）
          const matched = p.cands.filter((c) => c && c.tag && raw.includes(c.tag));
          const pid = matched.length ? p.pid : null;
          const r = rewriteText(raw, matched, pid, p.pageUrl);
          if (r.text !== raw) {
            if (r.usedTags.length) notifyConsumed(r.usedTags, p.pid);
            try { console.log('[aiti-devtools-openclaw] 占位符展开（' + r.usedTags.join(',') + '）：' + raw.slice(0, 50) + ' → ' + r.text.slice(0, 80)); } catch {}
            const replaced = typeof msg.content === 'string' ? r.text
              : Array.isArray(msg.content) ? msg.content.map((blk) => (blk && blk.type === 'text' ? { ...blk, text: r.text } : blk)) : msg.content;
            return { message: { ...msg, content: replaced } };
          }
        } catch {}
      });
    } catch (e) { try { console.error('[aiti-devtools-openclaw] 占位符 hook 注册失败', e); } catch {} }
    // before_prompt_build：模型输入注入（prompt 无法直接替换，但 prependContext 会拼进模型 prompt——
    // composeModelPromptContext = prepend + prompt + append）。占位符在 transcript（bmw）已展开落盘；
    // 这里把「展开对照表」注入模型输入，双保险：模型看到完整描述 + 发自。
    try {
      api.on('before_prompt_build', async (event, ctx) => {
        try {
          try { console.log('[aiti-devtools-openclaw] before_prompt_build fired，prompt 前 40 字：' + String(event && event.prompt || '').slice(0, 40)); } catch {}
          const prompt = event && typeof event.prompt === 'string' ? event.prompt : '';
          PLACEHOLDER_RE.lastIndex = 0;
          const hasPh = PLACEHOLDER_RE.test(prompt);
          PLACEHOLDER_RE.lastIndex = 0;
          const lines = [
            '[aiti-devtools] 你接入页面调试工具集（aiti_*）：page_exec（CDP）/ page_snapshot / page_logs / page_network / user_confirm / user_pick_element 等。',
            '用户消息中的完整页面元素描述（含 [发自: pageId · url] 标注）来自目标页点选，pageId 参数用它；与页面交互前先 aiti_bridge_status 查在线页。',
          ];
          if (hasPh) {
            const sk = (ctx && ctx.sessionKey) || event.sessionKey || '';
            const key = sk && agentKeyForSession(sk, null);
            const p = key ? await fetchPickedAndUrl(key) : null;
            // 写入缓存：bpb 先于 bmw 触发（同步），此处 fetch 到的候选供同轮 bmw 展开使用
            if (key && p && p.cands.length) pickedCache.set(key, p);
            const cands = (p && p.cands) || [];
            const used = [];
            for (const c of cands) {
              PLACEHOLDER_RE.lastIndex = 0;
              if (c.tag && prompt.includes(c.tag)) used.push(c.tag + ' = ' + c.describe);
            }
            if (used.length) {
              lines.push('本轮用户消息占位符展开对照（以完整描述为准）：');
              lines.push(...used);
              if (p.pid) lines.push('[发自: ' + p.pid + (p.pageUrl ? ' · ' + p.pageUrl : '') + '（aiti-*：pageId 参数用它）]');
            }
          }
          return { prependSystemContext: lines.join('\n'), appendContext: hasPh ? undefined : undefined, prependContext: undefined };
        } catch { return undefined; }
      });
    } catch (e) { try { console.error('[aiti-devtools-openclaw] before_prompt_build 注册失败', e); } catch {} }
    // 答复回传：typed hook 必须用 api.on（registerHook 走 legacy 内部路径不会触发）。
    // before_agent_reply 仅在渠道投递路径触发（CLI/web 直答不触发），改用 before_message_write（每条消息落盘前，含 assistant 终稿；sessionKey 在第二参 ctx，event 上没有）。
    // user 消息同时兼作会话上线兑底（gateway 重启后已有会话不再发 session_start）。
    try {
      api.on('before_message_write', (event, ctx) => {
        try {
          const msg = event && event.message;
          if (!msg) return;
          const sk = (ctx && ctx.sessionKey) || event.sessionKey || msg.sessionKey;
          const sid = (ctx && ctx.sessionId) || event.sessionId || '';
          if (msg.role === 'user') {
            if (sk) ensureRegistered({ agentId: 'openclaw', ocAgentId: (ctx && ctx.agentId) || 'main', sessionId: sid, sessionKey: sk, cwd: '' });
            return;
          }
          if (msg.role !== 'assistant') return;
          const text = extractText(msg.content);
          if (!text) return;
          const key = agentKeyForSession(sk, null);
          if (!key) return; // 非 aiti 会话（未上线）不回传
          answerToBridge(key, text);
        } catch {}
      });
    } catch (e) { try { console.error('[aiti-devtools-openclaw] api.on(before_message_write) 注册失败', e); } catch {} }
    for (const t of TOOLS) {
      api.registerTool(
        (ctx) => ({
          name: t.ocName,
          description: t.description,
          parameters: t.inputSchema,
          async execute(_id, params) {
            // 身份：toolContext（可信运行时上下文）→ 桥会话（aiti_hello 可自行覆盖 agentId）
            const ident = {
              agentId: 'openclaw',
              sessionId: (ctx && ctx.sessionId) || ('oc_' + Date.now().toString(36)),
              sessionKey: (ctx && ctx.sessionKey) || '',
              cwd: (ctx && ctx.workspaceDir) || '',
            };
            const r = await callBridge(t.name, params ?? {}, ident);
            if (r.agentKey) recordSession(ident, r.agentKey);
            return {
              content: [{ type: 'text', text: r.text }],
              details: { tool: t.ocName, ok: r.ok, isError: !!r.isError },
            };
          },
        }),
        { name: t.ocName },
      );
    }
  },
};
