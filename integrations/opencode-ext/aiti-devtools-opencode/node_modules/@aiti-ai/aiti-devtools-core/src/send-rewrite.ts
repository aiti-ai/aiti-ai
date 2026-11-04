/**
 * send-rewrite.ts —— 候选占位符 → 发送文本的公共改写库（B1 下沉）
 *
 * 单一来源：占位符替换 + 换行分隔 + 孤儿兜底 + 旧标签摘除 + 发自标注 + 幂等清理。
 * 适配端（pi-web preSend / DSH host agent/pre-step / 未来载体）在此之上只做薄壳：
 *   - pi-web：preSend(text) → rewriteMessage(text, picked, {pid, url})
 *   - DSH：agent/pre-step → rewriteMessage(text, picked, {pid, url})（include 筛选经 el.include 原样生效——
 *     describe 由适配端传入或用 defaultDescribe；本库不 import host-protocol.js 资产，保持 node/browser 两栖）
 *
 * 与 pi-web aiti-client.mjs preSend 行为逐条对齐（2026-08-23 版）：
 *   1) 无候选：孤儿兜底（全占位符→失效提示）+ 发自（有 pid）
 *   2) 旧版 [选择N] 摘除
 *   3) 候选替换：replaceTag 换行分隔（desc 末行不与用户原文粘连）
 *   4) 替换后残留孤儿兜底
 *   5) 发自：[发自: pid · url（工具提示）]，先摘已有 [发自:] 再追加（幂等）
 */

/** 占位符存在性（元素/回答/错误/选择——选择为旧版，仅摘除不替换）。 */
export const PLACEHOLDER_RE = /\[(?:元素|回答|错误|选择)\d+\]/;
const ORPHAN_RE = /\[(?:元素|回答|错误)\d+\]/g;
const LEGACY_TAG_RE = /\[选择\d+\]/g;
const SRC_TAG_RE = /\[发自:[^\]]*\]\s*/g;
export const ORPHAN_NOTICE = '[⚠ 候选已失效，占位符已移除（重新选元素/刷新页面重采）]';

/** rewriteMessage 的候选输入（最小面；适配端从 host-protocol picked 映射而来）。 */
export interface RewriteCandidate {
  /** 占位符标签（[元素N]/[回答N]/[错误N]）。 */
  tag: string
  /** 展开文本（已应用 include 筛选的 describe）。 */
  describe: string
  /** 来源页身份（发自/优先级用）。 */
  pageId?: string
}

export interface RewriteOptions {
  /** 来源页 pageId；空则不加发自（pi-web 同款：pid 为空原样返回）。 */
  pid?: string | null
  /** 来源页 URL（发自内裁剪展示）。 */
  pageUrl?: string | null
  /** 发自里的工具提示语（默认 aiti-* 中文提示；适配端可换语言）。 */
  srcNote?: string
}

/** URL 裁剪（与 host-protocol clipUrl 同语义：去 hash、query 前 2 项、120 截断）。 */
export function clipUrl(u: string, max = 120): string {
  if (!u) return ''
  try {
    const p = new URL(u)
    p.hash = ''
    let out = p.origin + p.pathname
    if (p.search) {
      const q = p.search.slice(1).split('&').filter(Boolean).slice(0, 2)
      if (q.length) out += '?' + q.join('&')
    }
    return out.length > max ? out.slice(0, max) + '…' : out
  } catch { return u.length > max ? u.slice(0, max) + '…' : u }
}

/** 发自标注（幂等：先摘已有 [发自:] 与尾空白，再追加独立一行）。 */
export function withSourceTag(text: string, opts: RewriteOptions): string {
  const pid = opts.pid || ''
  if (!pid) return text
  const note = opts.srcNote ?? 'aiti-*：pageId 参数用它'
  const tag = '[发自: ' + pid + (opts.pageUrl ? ' · ' + clipUrl(opts.pageUrl) : '') + '（' + note + '）]'
  const cleaned = String(text || '').replace(SRC_TAG_RE, '').replace(/\s+$/, '')
  return (cleaned ? cleaned + '\n' : '') + tag
}

/** 孤儿占位符 → 失效提示（全部：无候选时整条兜底；有候选时兜底残留）。 */
export function stripOrphanTags(text: string): string {
  return String(text || '').replace(ORPHAN_RE, ORPHAN_NOTICE)
}

/** 单个标签替换：标签后还有用户文本时用换行与 desc 块分隔（防元数据末行与原文粘连）。 */
export function replaceTag(text: string, tag: string, desc: string): string {
  const i = text.indexOf(tag)
  if (i < 0) return text
  const rest = text.slice(i + tag.length)
  return text.slice(0, i) + desc + (rest.trim() ? '\n' + rest : rest)
}

/**
 * 主入口：一条用户文本 → 改写后的发送文本。
 * 返回 { text, usedTags, usedAny }——usedTags 供适配端做"发送即消费"清理（DSH aiti_consumed 携带）。
 */
export function rewriteMessage(
  text: string,
  picked: RewriteCandidate[],
  opts: RewriteOptions = {},
): { text: string; usedTags: string[]; usedAny: boolean } {
  let out = String(text || '')
  const usedTags: string[] = []
  // 旧版 [选择N]（改名前草稿残留）：无法映射到现候选——直接摘除
  out = out.replace(LEGACY_TAG_RE, '')
  if (picked.length) {
    for (const c of picked) {
      if (c.tag && out.includes(c.tag)) {
        out = replaceTag(out, c.tag, c.describe || c.tag)
        usedTags.push(c.tag)
      }
    }
  }
  // 孤儿兜底（无条件）：无候选上报/编号过期/跨窗口残留/替换后残留——不裸发
  if (ORPHAN_RE.test(out)) { ORPHAN_RE.lastIndex = 0; out = stripOrphanTags(out) }
  else ORPHAN_RE.lastIndex = 0
  const usedAny = usedTags.length > 0
  const finalText = withSourceTag(out, opts)
  return { text: finalText, usedTags, usedAny }
}
