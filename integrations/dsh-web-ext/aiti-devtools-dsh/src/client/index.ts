/**
 * @aiti-ai/aiti-devtools-dsh · client 面（浏览器）
 *
 * 被 DSH client-modules 扫描 + serve /plugins/<id>/client.js。本模块让 DSH web UI 充当
 * aiti-devtools 的「AI 窗」：
 *   1. 加载桥的脚本资产（host-protocol.js / bridge-client.js / cdp-core.js，从 /aiti/）
 *   2. 连桥 role=ai（onInteraction/onResult 转发 launcherHost；onEvent 把异步作答转候选）
 *   3. 作答回传监听（dbg_mcp_result / dbg_mcp_interaction_control → BridgeClient）
 *   4. conversation.input.overlay slot 渲染候选条（[元素N]/[回答N]/[错误N] 点击区）
 *
 * 协议层逻辑移植自 pi-web-ext/aiti-devtools/client/aiti-client.mjs（单源 host-protocol.js
 * 管候选/去重/ack/localStorage，本处只做 DSH slot 适配 + 脚本加载）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement, useEffect, useRef, useState, type ReactNode } from 'react'

export const name = 'aiti-devtools-dsh'
export const inject = ['sessions', 'locale']

// ---- AI 窗特征标记（早于一切，防 launcher 嵌套自毁）----
// 与 pi-web aiti-client 同条件：launcher iframe 嵌 DSH 时拼 _dbg 参数；popup 同名窗口。
try {
  if (typeof window !== 'undefined' &&
      (/[?&]_dbg=/.test(window.location.search) || window.name === 'aiti-ai-popup')) {
    ;(window as any).__AITI_AI_WIN__ = true
  }
} catch {}

// ---- 候选区 hover 样式（inline style 无 :hover，一次性注入，幂等）----
try {
  if (typeof document !== 'undefined' && !document.getElementById('aiti-picked-tag-style')) {
    const st = document.createElement('style')
    st.id = 'aiti-picked-tag-style'
    st.textContent = [
      '.aiti-picked-tag{user-select:none}',
      '.aiti-picked-tag:hover{text-decoration:underline;opacity:.85}',
      '.aiti-candidate-chip:hover{border-color:var(--dsw-alias-border-l4)}',
      '.aiti-candidate-desc:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
      '.aiti-candidate-x:hover{color:var(--dsw-static-red-500)!important;opacity:1}',
      '.aiti-candidates-clear:hover{background:var(--dsw-alias-interactive-bg-hover-danger)!important}',
      '.aiti-detail-close:hover{color:var(--dsw-alias-label-primary)!important}',
      '.aiti-detail-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    ].join('\n')
    document.head.appendChild(st)
  }
} catch {}

// ---- i18n 字典（DSH locale 规范：ctx.locale.register(ns,{zh,en}) + slot 注册带 locale → 组件 props.t）----
const AI18N_NS = 'aiti.candidates'
const AI18N = {
  zh: {
    clear: '清空',
    detailSuffix: ' 详情',
    close: '✕ 关闭',
    fieldsTitle: '发送给 AI 的字段（勾选）：',
    errHint: '发送时 [错误N] 替换为完整错误详情（类型/消息/堆栈/时间）。',
    orphanNote: '（占位符发送时由 host 替换为元素详情）',
    tipTag: '点击：仅输入框补占位符（不弹详情）',
    tipDesc: '点击：输入框补占位符 + 查看详情/筛选/打开文件',
    tipOpenFile: '经桥在后台打开（编辑器由 AITI_OPEN_CMD 环境变量指定，无则系统默认）',
  },
  en: {
    clear: 'Clear all',
    detailSuffix: ' details',
    close: '✕ Close',
    fieldsTitle: 'Fields sent to the AI (checked):',
    errHint: '[错误N] expands to full error details (type/message/stack/time) on send.',
    orphanNote: '(placeholder expands to element details on send, host-side)',
    tipTag: 'Click: insert placeholder only (no detail dialog)',
    tipDesc: 'Click: insert placeholder + open details/filters/open-file',
    tipOpenFile: 'Open in background via bridge (editor from AITI_OPEN_CMD, else system default)',
  },
} as const
type Ai18nKey = keyof typeof AI18N['zh']
/** t seat 渐进增强：无 locale face 时回退中文（未注册 locale 的宿主/独立运行不崩）。 */
function tt(t: ((k: string) => string) | undefined, key: Ai18nKey): string {
  return (t && typeof t === 'function' ? t(key) : '') || AI18N.zh[key]
}

// ---- 桥地址（DSH 同端口 /aiti/；/aiti/bridge/* 为桥 REST/SSE，/aiti/mcp 为 MCP JSON-RPC）----
function bridgeBase(): string { return '/aiti' }
function assetUrl(f: string): string { return '/aiti/' + f }

// ---- host-protocol / bridge-client / cdp-core 加载（window 全局）----
/** host-protocol.js（JS 全局资产）的最小使用面声明——字段按本适配端实际调用收敛，非完整 SDK。 */
interface HostProtocol {
  setPicked(list: Candidate[]): void
  getPicked(): Candidate[]
  removeCandidate(el: Candidate): void
  describe(el: Candidate, pageId: string | null): string
  brief(el: Candidate): string
  detailRows(el: Candidate, pageId: string | null): Array<[string, string]>
  stripFromText(text: string, items: unknown[]): string
  hostIdentity(): { pageId: string; targetUrl?: string | null } | null
  sendReady(): void
  reportAiPage?: (base: string) => void
  resetAiPageReport?: () => void
  reportSelfPage?: (base: string) => void
  resetSelfPageReport?: () => void
  reportActive?: (base: string) => void
  rowFileInfo?(el: Candidate, key: string): { file?: string; line?: number } | null
  bridgeConnectParams?(): Record<string, unknown>
}
/** 候选（元素/错误/回答共用形状；宿主 enrich 字段自由扩展，本端只读声明的子集）。 */
interface Candidate {
  tag: string
  kind?: 'element' | 'error' | 'answer' | string
  pageId?: string
  answer?: string
  message?: string
  include?: Record<string, boolean>
  [k: string]: unknown
}
let hp: HostProtocol | null = null
let pickedElements: Candidate[] = []
const pickedListeners = new Set<() => void>()

function loadScript(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve(true)
    s.onerror = () => resolve(false)
    document.head.appendChild(s)
  })
}

function syncPicked(list: any[]) { pickedElements = list || []; for (const l of pickedListeners) l(); reportPickedToHost() }

// 候选变化时把 {tag, describe, pageId} 上报给 host（POST /aiti/picked）——host 在 agent/pre-step
// waterfall（DSH 官方消息预处理插入点）里做占位符替换+发自（发送方式无关；describe 由 host-protocol.describe 生成）。
let reportTimer: any = null
function reportPickedToHost(): void {
  if (reportTimer) return
  reportTimer = setTimeout(() => {
    reportTimer = null
    try {
      // 宿主页身份兜底：错误候选不落在具体帧（无 el.pageId）——用 hp.hostIdentity()（debugTarget/boot
      // 注册的宿主页 pageId，launcher 拼 AI 窗 URL 参数兑底）补齐，发送替换/发自/前端清理才全通。
      let pageId = pickedElements.find((x) => x.pageId)?.pageId || null
      if (!pageId && hp && hp.hostIdentity) { try { pageId = hp.hostIdentity()?.pageId || null } catch {} }
      const payload = pickedElements.map((el) => ({
        tag: el.tag || '',
        pageId: el.pageId || pageId,
        describe: (hp && hp.describe) ? hp.describe(el, el.pageId || pageId) : String(el.tag || ''),
      }))
      void fetch('/aiti/picked', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    } catch {}
  }, 150)
}

function initHostProtocol(): HostProtocol | null {
  const w = window as any
  if (hp || !w.AitiHostProtocol) return hp
  hp = w.AitiHostProtocol.create({
    onPicked: syncPicked,
    onBoot: () => {},
    insertPlaceholder: (el: Candidate) => insertPlaceholderIntoTextarea(el),
    // 宿主指示文本（launcher HUD 👆 按钮的 element_instruction）→ 追加输入框（pi-web 同款）
    onUserMessage: (p: { kind?: string; text?: string }) => {
      if (!p || p.kind !== 'element_instruction' || !p.text) return
      try {
        const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
        if (!ta) return
        setTaValue(ta, (ta.value.trim() ? ta.value.trim() + ' ' : '') + p.text)
        ta.focus()
      } catch {}
    },
    onInspect: () => {},
    // 宿主页面事件（page_log/page_network/page_error/open_file…）→ 桥（AI 窗是桥唯一浏览器端点；
    // 此前空回调导致页面日志/网络/错误环形缓冲全空——aiti_page_logs/page_network 拉不到数据）
    onBridgeEvent: (type: string, payload: unknown, target: { pageId?: string } | null) => {
      try { if ((window as any).BridgeClient) (window as any).BridgeClient.postEvent(type, payload, (target && target.pageId) || null) } catch {}
    },
  })
  ;(window as any).__aitiDshHp = hp
  return hp
}

async function ensureHostProtocol(): Promise<HostProtocol | null> {
  if (hp) return hp
  if ((window as any).AitiHostProtocol) { initHostProtocol(); return hp }
  await loadScript(assetUrl('host-protocol.js'))
  if ((window as any).AitiHostProtocol) { initHostProtocol(); return hp }
  console.error('[aiti-dsh-client] host-protocol.js 加载失败')
  return null
}

async function ensureBridgeClient(): Promise<boolean> {
  const w = window as any
  if (w.BridgeClient && typeof w.BridgeClient.connect === 'function') return true
  await loadScript(assetUrl('bridge-client.js'))
  return !!(w.BridgeClient && typeof w.BridgeClient.connect === 'function')
}

async function ensureCdpCore(): Promise<boolean> {
  const w = window as any
  if (w.__AitiCdpCore) return true
  await loadScript(assetUrl('cdp-core.js'))
  return !!w.__AitiCdpCore
}

// ---- launcher 宿主窗口（popup=opener / iframe=parent / 同窗=self）----
function launcherHost(): Window {
  if (window.opener && !window.opener.closed) return window.opener
  if (window.parent !== window) return window.parent
  return window
}
function postToLauncher(msg: unknown): void {
  // 吞掉 postMessage 异常：宿主窗口可能已关闭/跨源受限——消息丢失由宿主侧重发协议兜底。
  try { launcherHost().postMessage(msg, '*') } catch {}
}

// ---- React 受控 textarea 写值（原生 setter + input 事件）----
function setTaValue(ta: HTMLTextAreaElement, v: string): void {
  // 吞掉 setter/dispatch 异常：textarea 已卸载时静默跳过（下一次候选交互重试）。
  try {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, v)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  } catch {}
}

// ---- 候选点击 → 插入 composer：插入短占位符 [元素N]/[回答N]/[错误N]（干净），发送时由 host 端
//     agent/pre-step（DSH 官方消息预处理 waterfall）替换成完整 describe + 发自 —— 发送方式无关，
//     前端零发送 hook，composer 不塞大段描述。候选数据由 reportPickedToHost() POST /aiti/picked 上报。
function insertPlaceholderIntoTextarea(el: Candidate | { tag?: string }): void {
  try {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
    if (!ta) return
    const tag = (el && el.tag) || ''
    if (!tag) return
    if (ta.value.includes(tag)) { ta.focus(); return }
    setTaValue(ta, (ta.value.trim() ? ta.value.trim() + ' ' : '') + tag)
    ta.focus()
  } catch {}
}

// ---- 候选详情弹窗状态（点击候选描述区打开）----
let detailIdx = -1
const detailListeners = new Set<() => void>()
function setDetail(idx: number): void { detailIdx = idx; for (const l of detailListeners) l() }

// ---- 候选描述公共库（host-protocol.js 单源）：薄封装，不复制逻辑 ----
function briefText(el: Candidate): string {
  try {
    if (hp && hp.brief) return hp.brief(el)
    if (el && el.kind === 'error') return '⚠ ' + String(el.message || '')
    return '<' + (el && el.tag ? el.tag.replace(/[\[\]]/g, '') : '?') + '>'
  } catch { return '<' + ((el && el.tag) || '?') + '>' }
}
function detailRowsText(el: Candidate): Array<[string, string]> {
  try {
    if (hp && hp.detailRows) {
      const pid = pickedElements.find((x: any) => x.pageId)?.pageId || null
      return hp.detailRows(el, pid) || []
    }
  } catch {}
  return []
}
function stripTagsFromInput(tags: string[]): void {
  try {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
    if (!ta || !ta.value || !tags || !tags.length) return
    const items = tags.filter(Boolean).map((t) => ({ tag: t }))
    if (!items.length) return
    let v = hp && hp.stripFromText ? hp.stripFromText(ta.value, items) : ta.value
    if (v !== ta.value) setTaValue(ta, v.trim())
  } catch {}
}
// 逐条清除候选（host-protocol 记录指纹防复活 + 输入框摘该条占位符）
function removeOneCandidate(el: Candidate): void {
  try {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
    if (hp && hp.removeCandidate) hp.removeCandidate(el) // 内部 setPicked → deriveTags 重编号 → onPicked → syncPicked
    const v = hp && hp.stripFromText && ta ? hp.stripFromText(ta.value, [el]) : (ta ? ta.value : '')
    if (ta && v !== ta.value) setTaValue(ta, v.trim())
  } catch {}
}
// 清空全部候选（快照旧 tag 再逐个 removeCandidate——防重编号摘错）
function clearAllCandidates(): void {
  try {
    const tags = pickedElements.map((el) => el.tag)
    pickedElements.forEach((el) => { try { if (hp && hp.removeCandidate) hp.removeCandidate(el) } catch {} })
    stripTagsFromInput(tags)
    if (hp && hp.setPicked) hp.setPicked([])
    else syncPicked([])
  } catch {}
}


// ---- 桥连接 ----
let bridgeConnecting = false
function connectBridge(): Promise<{ ok: boolean; error?: string }> {
  const w = window as any
  if (w.BridgeClient && w.BridgeClient.isConnected && w.BridgeClient.isConnected()) {
    return Promise.resolve({ ok: true, already: true })
  }
  if (bridgeConnecting) return Promise.resolve({ ok: true, inFlight: true })
  bridgeConnecting = true
  void ensureCdpCore() // 预载（不阻塞连桥）
  return ensureBridgeClient().then((ok) => {
    bridgeConnecting = false
    if (!ok) return { ok: false, error: 'bridge-client.js 加载失败' }
    const common = (hp && hp.bridgeConnectParams) ? hp.bridgeConnectParams() : { role: 'ai', token: 'dev', useForward: true }
    w.BridgeClient.connect({
      base: bridgeBase(), ...common,
      onStatus: () => {},
      onReady: () => {
        if (!hp) return
        try { hp.resetAiPageReport?.(); hp.reportAiPage?.(bridgeBase()) } catch {}
        try { hp.resetSelfPageReport?.(); hp.reportSelfPage?.(bridgeBase()) } catch {}
        try { hp.reportActive?.(bridgeBase()) } catch {}
      },
      onExec: () => {},
      // 桥用户交互（confirm/choose/input/presence/pick_element）→ 转发 launcherHost
      // （DSH 在 iframe 里时 launcher 在父窗口；作答回传经 dbg_mcp_result → 下方监听 → postResult）
      onInteraction: (m: any) => {
        postToLauncher({ __dbg: 1, type: 'dbg_mcp_interaction', payload: { requestId: m.requestId, interaction: m.interaction } })
      },
      onResult: (m: any) => {
        postToLauncher({ __dbg: 1, _aiBridge: 1, type: 'dbg_mcp_result', payload: { requestId: m.requestId, ok: m.ok, result: m.result } })
      },
      onEvent: (m: any) => {
        // BridgeClient 剥层：type:'event' 消息回调 onEvent(m.event || m) —— m.event 是【字符串】（如
        // 'aiti_consumed'，payload 已丢）；兼容对象形状（{event,type}）防御未来 BridgeClient 改剥层。
        const evName = typeof m === 'string' ? m : (m && (m.event || m.type)) || ''
        // host agent/pre-step 替换成功的权威信号（桥消息流）：发送即消费 → 清理候选 + 摘输入框占位符。
        // 替代此前 useSession snapshot 轮询（selector 坑/基线初始化全不需要），链路更短更可靠。
        if (evName === 'aiti_consumed') {
          clearAllCandidates()
          return
        }
        if (!m || m.type !== 'user_answer') return
        const pv = m.payload || {}
        if (pv.status === 'answered') {
          const cand = { kind: pv.kind || 'answer', answer: String(pv.answer || '').trim() }
          if (!cand.answer) return
          if (!pickedElements.some((x) => x.answer === cand.answer)) {
            const next = [...pickedElements, cand]
            if (hp && hp.setPicked) hp.setPicked(next) // 委托 host-protocol（deriveTags + localStorage + onPicked → syncPicked）
            else syncPicked(next)
            insertPlaceholderIntoTextarea(cand)
          }
        }
      },
    })
    // 宿主页注册自愈（幂等；桥 sessions 经 AI 宿主页可见）
    try { if (hp) hp.reportAiPage?.(bridgeBase()) } catch {}
    return { ok: true }
  })
}

// ---- 候选条 React 组件（conversation.input.overlay slot）----
// 结构对齐 pi-web 原版：每条 chip = 占位符区（点击仅补输入框）+ 描述区（点击补占位符 + 开详情弹窗）+ ✕ 清除；
// 尾部「清空」按钮。发送后清理走桥消息流（onEvent 'aiti_consumed'——host agent/pre-step 替换成功的
// 权威信号，见 connectBridge 的 onEvent），本组件只管渲染，无副作用。
// 样式：全部用 DSH `--dsw-alias-*` 设计变量（亮/暗主题自动适配）；交互用标准 onClick。
function CandidatesBar(props: any): ReactNode {
  const t = typeof props?.t === 'function' ? props.t as (k: string) => string : undefined
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    pickedListeners.add(l)
    return () => { pickedListeners.delete(l) }
  }, [])
  if (!pickedElements.length) return null
  // DSH overlayAnchor 是 height:0 的空锚点（slot 条目需自行定位：bottom:100% 弹到输入卡上方）——
  // 流式布局会与 textarea 重叠且被其热区覆盖（点击落不到候选条），必须 absolute 上浮。
  return createElement('div', {
    className: 'aiti-candidates-bar',
    style: {
      position: 'absolute', bottom: '100%', left: 0, right: 0,
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      padding: '4px 8px 6px', fontSize: 11, marginBottom: 6, borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-3)',
      border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)',
      boxShadow: 'var(--dsw-shadow-lv2)',
      color: 'var(--dsw-alias-label-primary)',
    } as any,
  },
    ...pickedElements.map((el, i) => {
      const tag = (el && el.tag) || (el.kind === 'answer' ? `[回答${i + 1}]` : el.kind === 'error' ? `[错误${i + 1}]` : `[元素${i + 1}]`)
      const isErr = el && el.kind === 'error'
      return createElement('span', {
        key: String(el?.tag || i),
        className: 'aiti-candidate-chip',
        style: {
          display: 'inline-flex', alignItems: 'center', maxWidth: '100%',
          background: isErr ? 'var(--dsw-alias-interactive-bg-hover-danger)' : 'var(--dsw-alias-interactive-bg-hover-accent)',
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6,
          padding: '1px 2px 1px 0', whiteSpace: 'nowrap',
          color: isErr ? 'var(--dsw-static-red-500)' : 'var(--dsw-alias-label-primary)',
        } as any,
      },
        // 占位符区：点击仅补输入框占位符（不弹详情）
        createElement('span', {
          className: 'aiti-picked-tag',
          onClick: (e: any) => { e.stopPropagation(); insertPlaceholderIntoTextarea(el) },
          title: tt(t, 'tipTag'),
          style: {
            padding: '0 6px', borderRight: '1px dashed var(--dsw-alias-border-l2)', fontWeight: 600,
            cursor: 'pointer', flexShrink: 0, userSelect: 'none',
          } as any,
        }, tag),
        // 描述区：点击补占位符 + 开详情弹窗（信息/字段筛选/打开文件）
        createElement('span', {
          className: 'aiti-candidate-desc',
          onClick: (e: any) => { e.stopPropagation(); insertPlaceholderIntoTextarea(el); setDetail(i) },
          title: tt(t, 'tipDesc'),
          style: {
            padding: '0 4px', cursor: 'pointer', overflow: 'hidden',
            textOverflow: 'ellipsis', maxWidth: 220, flexShrink: 1,
            color: 'var(--dsw-alias-label-secondary)',
          } as any,
        }, briefText(el)),
        // 逐条清除
        createElement('button', {
          className: 'aiti-candidate-x',
          onClick: (e: any) => { e.stopPropagation(); removeOneCandidate(el) },
          style: {
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--dsw-alias-label-tertiary)',
            padding: '0 3px', fontSize: 11, lineHeight: 1, flexShrink: 0,
          } as any,
          title: '清除该候选（同步删输入框里的 ' + tag + '）',
        }, '✕'),
      )
    }),
    // 清空全部
    createElement('button', {
      className: 'aiti-candidates-clear',
      onClick: (e: any) => { e.stopPropagation(); clearAllCandidates() },
      style: {
        marginLeft: 'auto', padding: '1px 8px', fontSize: 11, borderRadius: 4,
        cursor: 'pointer', color: 'var(--dsw-static-red-500)',
        background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
      } as any,
    }, tt(t, 'clear')),
    // 详情弹窗（fixed 覆盖层，portal 到 body；react-dom 不可用时退回 inline）；t 透传（locale 渐进增强）
    createElement(DetailDialog, { t }),
  )
}

// react-dom createPortal（可用则弹窗脱离输入卡容器，避免被裁剪/受 containing block 影响）
let createPortalFn: ((n: ReactNode, c: Element) => ReactNode) | null = null
try {
  const rd = require('react-dom') as any
  if (rd && typeof rd.createPortal === 'function') createPortalFn = rd.createPortal
} catch {}

// ---- 候选详情弹窗（点击描述区打开）：detailRows 信息行 + 字段筛选勾选 + 打开文件 ----
function DetailDialog(props: any): ReactNode {
  const t = typeof props?.t === 'function' ? props.t as (k: string) => string : undefined
  // React hooks 规则：全部 hooks 在任何条件 return 之前无条件调用（早退后补 hook 会触发 #310
  // —— hooks 数量随渲染路径变化）。el 依赖的初始化走惰性读取（el 可能尚不存在）。
  const FIELD_LABELS: Array<[string, string]> = [['tag', '标签'], ['text', '文本'], ['xpath', 'xpath'], ['selector', 'selector'], ['rect', '尺寸'], ['docRect', '文档位置'], ['attributes', '属性'], ['computed', '样式'], ['framework', '框架'], ['component', '组件'], ['file', '组件源码'], ['usedAt', '调用位置'], ['frame', '页面']]
  const readInc = (c: Candidate | null): Record<string, boolean> => {
    const o: Record<string, boolean> = {}
    const inc = (c && c.include) || {}
    FIELD_LABELS.forEach(([fld]) => { o[fld] = inc[fld] !== false })
    return o
  }
  const [d, setD2] = useState(detailIdx)
  const [, force] = useState(0)
  const [incState, setIncState] = useState<Record<string, boolean>>(() => readInc(null))
  useEffect(() => {
    const l = () => { setD2(detailIdx); force((n) => n + 1) }
    detailListeners.add(l)
    return () => { detailListeners.delete(l) }
  }, [])
  // 受控 state 镜像：d（候选切换/弹窗打开）时从 el.include 重置。toggle 先改 state（UI 即时）
  // 再同步 hp（持久化 + host 重上报）——el.include 是外部可变对象，checked 直读非受控约定。
  useEffect(() => { setIncState(readInc(d >= 0 ? pickedElements[d] || null : null)) }, [d])
  if (d < 0) return null
  const el = pickedElements[d]
  if (!el) return null
  if (!el.include) el.include = {}
  const toggle = (fld: string) => {
    setIncState((m) => ({ ...m, [fld]: !m[fld] }))
    el.include![fld] = !(incState[fld] !== false)
    if (hp && hp.setPicked) hp.setPicked([...pickedElements])
    else syncPicked([...pickedElements])
  }
  const close = () => setDetail(-1)
  const overlay = createElement('div', {
    className: 'aiti-detail-overlay',
    style: {
      position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--dsw-alias-bg-mask-3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    } as any,
    onClick: close,
  },
    createElement('div', {
      className: 'aiti-detail-dialog',
      style: {
        width: 380, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto', padding: 14,
        borderRadius: 10, background: 'var(--dsw-alias-bg-layer-3)',
        border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: 'var(--dsw-shadow-lv2)', fontFamily: 'inherit',
      } as any,
      onClick: (e: any) => e.stopPropagation(),
    },
      createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } as any },
        createElement('b', { style: { fontSize: 13 } as any }, (el.tag || '') + tt(t, 'detailSuffix')),
        createElement('button', {
          className: 'aiti-detail-close',
          onClick: close,
          style: {
            background: 'var(--dsw-alias-interactive-bg-hover)', border: 'none', cursor: 'pointer',
            fontSize: 12, padding: '2px 8px', borderRadius: 4, lineHeight: 1.4,
            color: 'var(--dsw-alias-label-secondary)',
          } as any,
          'aria-label': '关闭', title: '关闭',
        }, tt(t, 'close')),
      ),
      // 信息行
      createElement('div', { className: 'aiti-detail-rows', style: { marginBottom: 10 } as any },
        ...detailRowsText(el).map(([k, v], i) => {
          const fi = (hp && hp.rowFileInfo) ? (hp.rowFileInfo(el, k) || {}) : {}
          const file = fi.file || null
          const line = fi.line || null
          return createElement('div', {
            key: i,
            className: 'aiti-detail-row',
            style: {
              display: 'flex', gap: 6, fontSize: 11, padding: '3px 0',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              alignItems: 'center', borderRadius: 4,
            } as any,
          },
            createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', minWidth: 64, fontWeight: 600, flexShrink: 0 } as any }, k),
            createElement('code', { style: { flex: 1, wordBreak: 'break-all', fontSize: 11 } as any }, v),
            (file) && createElement('button', {
              className: 'aiti-file-open',
              onClick: (e: any) => {
                e.stopPropagation()
                try { if ((window as any).BridgeClient) (window as any).BridgeClient.postEvent('open_file', { file, line }) } catch {}
              },
              title: tt(t, 'tipOpenFile'),
              style: {
                background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 4, padding: '0 6px', fontSize: 10, cursor: 'pointer', flexShrink: 0,
                color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6,
              } as any,
            }, '📂 ' + (tt(t, 'close') === '✕ Close' ? 'Open' : '后台打开')),
          )
        }),
      ),
      // 字段筛选（元素候选）
      el.kind === 'error'
        ? createElement('p', { style: { margin: '8px 0', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } as any }, tt(t, 'errHint'))
        : createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '8px 0', marginBottom: 4 } as any },
            createElement('p', { style: { marginBottom: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } as any }, tt(t, 'fieldsTitle')),
            createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px' } as any },
              ...FIELD_LABELS.map(([fld, label]) =>
                createElement('label', {
                  key: fld,
                  style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)' } as any,
                },
                  createElement('input', {
                    type: 'checkbox',
                    checked: incState[fld] !== false,
                    onChange: () => toggle(fld),
                    style: { accentColor: 'var(--dsw-alias-label-primary)' } as any,
                  }),
                  label,
                ),
              ),
            ),
          ),
    ),
  )
  return createPortalFn ? createPortalFn(overlay, document.body) : overlay
}

// ---- 作答回传监听（launcher sendInteractionResult → dbg_mcp_result → postResult）----
// 独立具名函数：apply 装载时挂、disposer 卸载（HMR/插件重载不累积重复监听器）。
function onLauncherMessage(e: MessageEvent): void {
  const m = e.data as { __dbg?: number; type?: string; _aiBridge?: number; payload?: { requestId?: string; ok?: boolean; result?: unknown; action?: unknown } }
  if (!m || m.__dbg !== 1) return
  const w = window as { BridgeClient?: { postResult(id: string, ok: boolean, r: unknown): void; postInteraction(id: string, a: unknown): void } }
  if (m.type === 'dbg_mcp_result') {
    // 回环防御：本模块转发的结算通知带 _aiBridge；作答方向无此标记
    if (m._aiBridge) return
    const p = m.payload || {}
    if (p.requestId && w.BridgeClient) w.BridgeClient.postResult(p.requestId, p.ok !== false, p.result)
  } else if (m.type === 'dbg_mcp_interaction_control') {
    const p = m.payload || {}
    if (p.requestId && w.BridgeClient) w.BridgeClient.postInteraction(p.requestId, p.action)
  }
}

// ---- DSH client 插件入口 ----
export function apply(ctx: ClientContext): void {
  const logger = (ctx as { logger?: { info(m: string): void; error(m: string): void } }).logger
  logger?.info?.('aiti-devtools-dsh client: loaded')

  // i18n（locale 渐进增强：ctx.locale 可用则注册双语字典；不可用时组件回退中文）
  const localeCtx = ctx as { locale?: { register(ns: string, dict: Record<string, Record<string, string>>): () => void }; effect?: (fn: () => (() => void) | void, label?: string) => void }
  if (localeCtx.locale?.register) {
    const dispose = localeCtx.locale.register(AI18N_NS, { zh: { ...AI18N.zh }, en: { ...AI18N.en } })
    localeCtx.effect?.(() => dispose, 'aiti-devtools-dsh: locale dictionaries')
  }

  // 测试/调试钩子：脱离 launcher 交互流，独立验证候选/插入/变换/发自
  ;(window as { __aitiDshAddCandidate?: unknown }).__aitiDshAddCandidate = (el: Candidate) => { try { const H = ((window as { __aitiDshHp?: HostProtocol }).__aitiDshHp) || hp; if (H && H.setPicked) H.setPicked([...(H.getPicked() || []), el]); else syncPicked([...pickedElements, el]) } catch {} }
  ;(window as { __aitiDshGetPicked?: unknown }).__aitiDshGetPicked = () => pickedElements
  ;(window as { __aitiDshInsert?: unknown }).__aitiDshInsert = (tag: string) => insertPlaceholderIntoTextarea({ tag })

  // 作答回传监听（模块旧版曾挂在顶层——重载会重复注册；按 cordis 规范经 ctx.effect 注册，卸载自动摘除）
  const fx = ctx as { effect?: (fn: () => (() => void) | void, label?: string) => void }
  fx.effect?.(() => {
    window.addEventListener('message', onLauncherMessage)
    return () => { window.removeEventListener('message', onLauncherMessage) }
  }, 'aiti-devtools-dsh: launcher message relay')
  // 兜底：effect 不可用时直接挂（该宿主下无重载语义，无泄漏风险）
  if (!fx.effect) window.addEventListener('message', onLauncherMessage)

  // 启动协议层 + 连桥（异步，不阻塞 slot 注册）
  void ensureHostProtocol().then((h) => { if (h) { try { h.sendReady() } catch { /* 握手失败由宿主重发兜底 */ } } return connectBridge() })
    .catch((e) => logger?.error?.('aiti-devtools-dsh client: protocol bootstrap failed: ' + String(e)))

  // 注册候选条到 conversation.input.overlay slot（DSH 官方输入区 overlay 扩展点；locale 声明
  // 让框架把 t seat 注入组件 props——未安装 locale face 时组件侧 tt() 回退中文）
  ctx.inject(['slots'], (scope: any) => {
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register(
      {
        name: 'conversation.input.overlay',
        id: 'aiti-devtools-candidates',
        order: 1000,
        locale: AI18N_NS,
      },
      CandidatesBar as any,
    ))
  })

}
