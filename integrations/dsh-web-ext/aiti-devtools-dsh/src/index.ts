/**
 * aiti-devtools-dsh · DSH（DeepSeek Harness）宿主 adapter（Cordis 插件）—— 路线 B：桥进程内 + DSH 同端口。
 *
 * 桥跑在 DSH 进程内（createBridge），并通过 DSH 的 ctx.webServer 在**同一端口**挂出：
 *   - /aiti/aiti-launcher.js / /aiti/cockpit.html / /aiti/bridge-client.js …（静态资产，loadAssets）
 *   - /aiti/bridge/*（桥 REST：claim/sessions/result/event/agent/tools/call…）
 *   - /aiti/mcp（MCP JSON-RPC，供任意 agent）
 * 工具：bridge.tools() → mapBridgeTools → ctx.tools.register（进程内，不另走 HTTP/MCP）。
 * agent 会话：registerAgent + setAgentSink → injectToModel；agent 完成 → answer。
 *
 * 加载：DSH web profile 的 cordis.patch.yml 插入本 bundle（文件路径引用）。不另开端口。
 * ⚠️ 会话生命周期/inject 精确 API（agent/status、createUserMessage、agents）在落地时按 DSH 版本确认。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { createBridge, loadAssets, readBody, rewriteMessage, clipUrl, type StaticFile, type RewriteCandidate } from '@aiti-ai/aiti-devtools-core'
import { mapBridgeTools, type AgentHost, type BridgeTool } from '@aiti-ai/aiti-devtools-agent'

export const name = 'aiti-devtools-dsh'
export const inject = ['tools', 'webServer']

/**
 * Plugin config（schemastery 校验；misconfiguration fails loud——校验失败在插件加载即抛，
 * 无静默忽略字段）。
 */
export interface Config {
  /** 桥数据目录（JSONL 消息流/会话记录）；默认 ~/.dsh/aiti，可用环境变量 AITI_BRIDGE_DATA_DIR 覆盖。 */
  dataDir?: string
  /** 静态资产目录（launcher/cockpit/bridge-client 等）；默认从安装的 @aiti-ai/aiti-devtools-core 解析。 */
  assetsDir?: string
  /** webServer 挂载前缀；默认 /aiti。 */
  prefix?: string
  /** 桥显示名（日志/会话标识）。 */
  name?: string
}

export const Config: z<Config> = z.object({
  dataDir: z.string().default(''),
  assetsDir: z.string().default(''),
  prefix: z.string().default(DEFAULT_PREFIX),
  name: z.string().default('aiti-devtools'),
})

const DEFAULT_PREFIX = '/aiti'

/** 解析 @aiti-ai/aiti-devtools-core 的 assets 目录（bundle 运行时创建Require，从安装位置找）。 */
function resolveCoreAssetsDir(): string {
  try {
    const req = createRequire(import.meta.url)
    const entry = req.resolve('@aiti-ai/aiti-devtools-core')   // → .../aiti-devtools-core/dist/index.js
    return resolve(dirname(entry), '..', 'assets')             // → .../aiti-devtools-core/assets
  } catch (e) {
    logger.warn('aiti-devtools-dsh: cannot resolve @aiti-ai/aiti-devtools-core/assets: ' + (e as Error).message)
    return join(homedir(), '.dsh', 'aiti')
  }
}

// ---- 进程内桥 → DSH webServer 的路由/静态适配（复用 http.ts 逻辑，但不另建 server）----
function isBridgePath(path: string[], prefix: string): boolean {
  const p = prefix.split('/').filter(Boolean)
  // 形如 /aiti/bridge|mcp → path 已剥前缀
  return path[0] === 'bridge' || path[0] === 'mcp'
}

function serveStatic(res: ServerResponse, sf: StaticFile): void {
  if (sf.status && sf.status >= 300) {
    res.writeHead(sf.status, { ...(sf.headers || {}), 'access-control-allow-origin': '*' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': sf.type || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  res.end(sf.content || '')
}

/** 把桥的 Fetch handler 接到 DSH 的 node (req,res)。 */
function bridgeNodeHandler(
  bridge: ReturnType<typeof createBridge>,
  staticFiles: Record<string, StaticFile>,
  prefix: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const pathname = url.pathname
    const stripped = pathname.startsWith(prefix + '/') ? pathname.slice(prefix.length) : pathname
    const path = stripped.split('/').filter(Boolean)

    // 静态资产（先于桥端点）——stripped 如 /aiti-launcher.js /cockpit.html
    const sf = staticFiles[stripped]
    if (sf && !isBridgePath(path, prefix)) { serveStatic(res, sf); return }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type' })
      res.end(); return
    }

    if (!isBridgePath(path, prefix)) { res.writeHead(404); res.end('aiti-devtools: not found'); return }

    // 桥端点 → bridge.handle（Fetch 接口）。/aiti/bridge/* 与 /aiti/mcp 直服务（不剥前缀）。
    const body = await readBody(req)
    const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: body.length ? body : undefined })
    const response = await bridge.handle(request, path, url.searchParams)

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    if (response.body) {
      const reader = response.body.getReader()
      res.on('close', () => { reader.cancel().catch(() => {}) })
      const pump = async () => {
        try {
          const { done, value } = await reader.read()
          if (done) { res.end(); return }
          res.write(value); pump()
        } catch { res.end() }
      }
      pump()
    } else {
      res.end(Buffer.from(await response.arrayBuffer()))
    }
  }
}

// ---- agent/pre-step 事件类型（本地最小声明，形态对齐 dsh-agent runtime-types；避免 dsh-agent peerDep）----
interface PreStepPayload { agent: unknown; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }
type PreStepNext = () => Promise<PreStepDecision>
/** 桥上报的候选摘要（AI 窗 POST /aiti/picked 的元素）。 */
interface PickedReport { tag: string; describe: string; pageId?: string }

// ---- 工具注册（进程内桥）+ agent 会话接线 ----
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  const prefix = (config.prefix || DEFAULT_PREFIX).replace(/\/+$/, '')
  const dataDir = config.dataDir || process.env.AITI_BRIDGE_DATA_DIR || join(homedir(), '.dsh', 'aiti')
  const bridge = createBridge(dataDir, { name: config.name })
  const staticFiles = loadAssets(config.assetsDir || resolveCoreAssetsDir())
  // aiti-client 加载 cdp-core.js（M1 self-exec），但 loadAssets 的 ASSET_NAMES 不含它——补上
  try {
    staticFiles['/cdp-core.js'] = { type: 'application/javascript; charset=utf-8', content: readFileSync(resolve(resolveCoreAssetsDir(), 'cdp-core.js'), 'utf8') }
  } catch { logger.warn('aiti-devtools-dsh: cdp-core.js not found in assets dir') }


  // 1. 桥工具 → ctx.tools.register（进程内直连，不走 HTTP/MCP）
  const tools = bridge.tools() as BridgeTool[] | undefined
  if (tools) {
    const host: AgentHost = {
      kind: 'dsh',
      currentSession: () => null,
      registerTool: (def) => {
        ctx.tools.register({
          name: def.name,
          description: def.description,
          parameters: def.parameters as Record<string, unknown>,
          output: def.output ?? { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v ?? null) }] },
          async execute(args: unknown, exec: { signal?: AbortSignal }) { return def.execute(args as Record<string, unknown>, exec?.signal) },
        })
      },
      injectToModel: (agentKey, text) => {
        const sessionId = agentKey.startsWith('dsh/') ? agentKey.slice(4) : agentKey
        // 可选服务依赖：不在顶层 inject 声明 'agents'（声明即硬依赖——纯 CLI/raw profile 无
        // agent 服务时本插件仍应可挂桥）；运行时缺失则本条注入静默丢弃（页面事件仍完整）。
        const agents = ctx.get('agents') as { get: (id: string) => { followup(m: unknown): void } | undefined } | undefined
        const agent = agents?.get(sessionId)
        if (!agent) return
        // 完整 UserMessage 契约（frozen、带 id/source）——followup 入 inbox 后 append session 时
        // 不依赖调用方补字段；@deepseek-ai/dsh-llm 是 peerDep，运行时由 DSH 提供。
        const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
        void (agent.followup(message) as Promise<unknown> | void).catch?.(() => {})
      },
      notify: (text, kind) => { console[kind === 'warning' ? 'warn' : 'log']('[aiti-devtools-dsh] notify:', text) },
    }
    mapBridgeTools(tools, host, {
      prefix: 'aiti_',
      descriptionSuffix: 'aiti-devtools 进程内直连，DSH 会话',
      output: () => ({ schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v ?? null) }] }),
      execute: (tool, args, signal) =>
        bridge.callTool(tool.name, args || {}, { agentId: 'dsh', id: 'dsh' }, signal)  // session 对象 -> agentKey 'dsh/dsh'
          .then((r) => {
            // 进程内桥 callTool 返回 MCP 格式 { content: [{text}], isError }（非 AgentCallResult）——用 pi-web 同款取法
            const text = (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r)
            if (r && r.isError) throw new Error(text)
            return text                       // 字符串，与 output.schema={type:'string'} 匹配
          }),
    })
    logger.info('aiti-devtools-dsh: registered ' + tools.length + ' aiti_* tools (in-process bridge, mounted ' + prefix + ')')
  } else {
    logger.warn('aiti-devtools-dsh: bridge tools() returned empty')
  }

  // 2. 挂到 DSH 同端口（route B）。两个路由的 disposer 经 ctx.effect 归一卸载（reversible effect）。
  const handler = bridgeNodeHandler(bridge, staticFiles, prefix)
  const disposeBridgeRoute = ctx.webServer.register({ kind: 'prefix', path: prefix, handler })
  logger.info('aiti-devtools-dsh: mounted ' + prefix + ' on DSH webServer (launcher/cockpit/bridge/mcp same port)')

  // 2.5 候选上报端点：AI 窗（client 插件）候选变化时 POST /aiti/picked（{tag,describe,pageId}[]）
  //     —— 纯数据同步（非发送 hook）；host 存内存供 agent/pre-step 占位符替换。
  let lastPicked: PickedReport[] = []
  const disposePickedRoute = ctx.webServer.register({ kind: 'exact', path: prefix + '/picked', handler: async (_req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const c of _req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      const body = JSON.parse(Buffer.concat(chunks).toString() || '[]')
      lastPicked = Array.isArray(body) ? body : []
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify({ ok: true, count: lastPicked.length }))
    } catch (e) {
      // 吞掉 JSON 解析错误：非 JSON body 一律 400 拒收（调用端 next 上报重试），不致命。
      res.writeHead(400); res.end('bad picked payload')
    }
  } })

  // 3. 占位符替换（DSH 官方消息预处理插入点）：agent/pre-step waterfall —— 在消息进入 LLM 步骤前
  //    把用户消息里的 [元素N]/[回答N]/[错误N] 改写为完整描述 + 发自。改写算法 = core send-rewrite
  //    公共库（B1 下沉，与 pi-web preSend 逐条对齐）：占位符替换/换行分隔/孤儿兜底/旧标签摘除/
  //    发自幂等。本 host 只做薄壳：映射 lastPicked → RewriteCandidate + 逐 text block 调用 +
  //    发自的 URL 查询（bridge.sessions）。替换成功 → pushAiEvent('aiti_consumed') 通知 AI 窗清理。
  const PLACEHOLDER_EXISTS = /\[(?:元素|回答|错误|选择)\d+\]/
  // 候选上报竞态兜底：文本含占位符但 lastPicked 空（AI 窗上报 150ms 防抖+POST 在途）→ 短暂等待到达
  // （pre-step 是 async waterfall，可 await；正常路径 <200ms，最长 800ms 后走孤儿兜底）。
  const waitForPicked = async (): Promise<void> => {
    for (let i = 0; i < 8 && !lastPicked.length; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  ctx.on('agent/pre-step', async (_payload: PreStepPayload, next: PreStepNext) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
    const batchHasTag = decision.messages.some((m) => {
      if (!m || m.role !== 'user' || !Array.isArray(m.content)) return false
      return m.content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && PLACEHOLDER_EXISTS.test(b.text))
    })
    if (batchHasTag) await waitForPicked()
    // 来源页身份：候选带 pageId 优先
    const pid: string = lastPicked.find((c) => c.pageId)?.pageId || ''
    // 发自 URL：按 pid 查桥会话（宿主页注册带 url）
    let pageUrl: string = ''
    if (pid) {
      try {
        const sessions = (bridge.sessions?.() || []) as Array<{ pageId?: string; url?: string }>
        pageUrl = sessions.find((x) => x?.pageId === pid)?.url || ''
      } catch { /* sessions 不可用：发自退化为无 URL（pid 仍有效） */ }
    }
    const rwOpts = { pid: pid || null, pageUrl: pageUrl || null }
    const cands: RewriteCandidate[] = lastPicked
    let lastReplacedIdx = -1
    const usedTagsAll: string[] = []
    const messages = decision.messages.map((m, idx: number) => {
      if (!m || m.role !== 'user' || !Array.isArray(m.content)) return m
      let msgChanged = false
      let lastBlkUsed = false
      const content = m.content.map((b) => {
        if (!b || b.type !== 'text' || typeof b.text !== 'string' || !b.text) return b
        const hasTag = PLACEHOLDER_EXISTS.test(b.text)
        const r = rewriteMessage(b.text, cands, rwOpts)
        if (r.text === b.text) return b
        msgChanged = true
        lastBlkUsed = r.usedAny || r.text.includes('[发自:')
        if (r.usedAny) usedTagsAll.push(...r.usedTags)
        return { ...b, text: r.text }
      })
      if (!msgChanged) return m
      lastReplacedIdx = idx
      return { ...m, content }
    })
    // 无占位符引用的纯文本消息：调试会话（有候选上报过）也带发自（pi-web 同款语义）
    if (lastReplacedIdx < 0) {
      if (!pid || !lastPicked.length) return decision
      let plainIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m && m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'text' && (b.text || '').trim())) { plainIdx = i; break }
      }
      if (plainIdx < 0) return decision
      const target = messages[plainIdx]
      messages[plainIdx] = {
        ...target,
        content: target.content.map((b, i) => {
          if (i === 0 && b && b.type === 'text' && typeof b.text === 'string') {
            const r = rewriteMessage(b.text, [], rwOpts)
            return r.text === b.text ? b : { ...b, text: r.text }
          }
          return b
        }),
      }
    }
    // 替换成功（消费了占位符）→ 桥消息流通知 AI 窗清理候选（权威信号 + 携带 tags）
    if (usedTagsAll.length) {
      // 吞掉推送失败（AI 窗未连桥时 write 抛错）：清理信号丢失仅表现为候选条多留一轮，下次发送再清。
      try { bridge.pushAiEvent?.('aiti_consumed', { tags: usedTagsAll, pid: pid || null, at: Date.now() }) } catch {}
    }
    return { ...decision, messages }
  })
  logger.info('aiti-devtools-dsh: agent/pre-step placeholder rewrite hooked (placeholder→describe+source tag, send-path agnostic)')
  // 路由卸载与监听器同生命周期（ctx.on 返回的 disposer 由 Cordis 追踪，这里只收 web 路由 + 桥 sweep）。
  ctx.effect(() => () => {
    disposeBridgeRoute(); disposePickedRoute()
    try { bridge.close?.() } catch { /* close 幂等；异常仅影响泄漏统计，不影响正确性 */ }
  }, 'aiti-devtools-dsh: web routes + bridge sweep')
}
