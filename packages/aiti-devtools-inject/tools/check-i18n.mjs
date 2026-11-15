#!/usr/bin/env node
/**
 * launcher i18n 校验（docs/launcher-i18n-plan.md §Phase 1）：
 *   1) key parity：源码全部 t('...') key ↔ locales/zh-cn.js 表 key 双向一致（缺失/死键即 FAIL）
 *   2) residual：未包 t() 的 CJK 字符串字面量（console.* 白名单跳过）→ FAIL 防回归
 * 退出码非 0 即门禁失败。用法：node tools/check-i18n.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ZH_CN from '../src/launcher/locales/zh-cn.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src', 'launcher');
const SKIP_FILES = new Set(['i18n.js']);
const CONSOLE_RE = /\bconsole\./;
const CJK = /[\u4e00-\u9fff]/;

// 与 codemod 同款的行内扫描（剥注释/正则感知有限——正则字面量含引号的行由 residual 人工清单兜底）
function scanLine(line, inBlockComment) {
  const code = [];
  const strings = [];
  let i = 0;
  const n = line.length;
  let buf = null;
  let bufStart = 0;
  while (i < n) {
    const c = line[i];
    if (inBlockComment.now) {
      const end = line.indexOf('*/', i);
      if (end === -1) return { code: code.join(''), strings, blockStill: true };
      inBlockComment.now = false;
      i = end + 2;
      continue;
    }
    if (buf) {
      if (c === '\\') { i += 2; continue; }
      if (c === buf) { strings.push({ raw: line.slice(bufStart, i + 1), start: bufStart }); buf = null; }
      i++;
      continue;
    }
    if (c === "'" || c === '"') { buf = c; bufStart = i; i++; continue; }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '/' && line[i + 1] === '*') { inBlockComment.now = true; i += 2; continue; }
    code.push(c);
    i++;
  }
  return { code: code.join(''), strings };
}

let fail = 0;

// ---- 1) t('...') key 收集（含转义单引号的 key 同样解析） ----
const usedKeys = new Set();
const files = readdirSync(SRC).filter(f => f.endsWith('.js') && !SKIP_FILES.has(f));
for (const f of files) {
  const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
  const bc = { now: false };
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const r = scanLine(line, bc);
    if (CONSOLE_RE.test(r.code)) continue;
    // 从代码区找 t(' 开始（code 只含注释外文本，但字符串体已被剥——改从原行定位）
    let i = 0;
    while ((i = line.indexOf("t('", i)) !== -1) {
      // 前一字符非标识符（防 text( 误伤）
      if (i > 0 && /[A-Za-z0-9_$]/.test(line[i - 1])) { i += 3; continue; }
      let j = i + 3;
      let key = '';
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') {
          // 解码转义与运行时实参一致：\n→换行 \t→tab \'→' \\→\ 其余保留原字符
          const nx = line[j + 1];
          key += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          j += 2;
          continue;
        }
        if (line[j] === "'") { closed = true; break; }
        key += line[j];
        j++;
      }
      if (closed) usedKeys.add(key);
      i = j + 1;
    }
  }
}

const bundleKeys = new Set(Object.keys(ZH_CN));
const missing = [...usedKeys].filter(k => !bundleKeys.has(k));
const dead = [...bundleKeys].filter(k => !usedKeys.has(k));
if (missing.length) {
  fail = 1;
  console.error(`[check-i18n] FAIL 缺译文 ${missing.length} 条（t() 有 key、bundle 无）：`);
  missing.slice(0, 20).forEach(k => console.error('  MISSING:', JSON.stringify(k.slice(0, 60))));
}
if (dead.length) {
  fail = 1;
  console.error(`[check-i18n] FAIL 死键 ${dead.length} 条（bundle 有、源码无 t() 引用）：`);
  dead.slice(0, 20).forEach(k => console.error('  DEAD:', JSON.stringify(k.slice(0, 60))));
}

// ---- 2) residual：未包 t() 的 CJK 简单字面量 ----
const residual = [];
for (const f of files) {
  const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
  const bc = { now: false };
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const r = scanLine(line, bc);
    if (CONSOLE_RE.test(r.code)) continue;
    if (/i18n-keep:/.test(line)) continue; // 显式豁免标记（如语言名本体）
    for (const s of r.strings) {
      const inner = s.raw.slice(1, -1);
      if (inner.indexOf('\\') !== -1) continue; // 转义字面量不在简单校验内
      if (!CJK.test(inner)) continue;
      const pre = line.slice(0, s.start).trimEnd();
      if (/t\($/.test(pre)) continue;
      residual.push(`${f}:${ln + 1}  ${inner.slice(0, 40)}`);
    }
  }
}
if (residual.length) {
  fail = 1;
  console.error(`[check-i18n] FAIL 残留 ${residual.length} 条未迁移 CJK 字面量：`);
  residual.slice(0, 30).forEach(x => console.error('  ' + x));
}

if (fail) {
  console.error(`[check-i18n] FAIL（keys ${usedKeys.size}/${bundleKeys.size}，residual ${residual.length}）`);
  process.exit(1);
}
console.log(`[check-i18n] PASS：parity ${usedKeys.size}/${bundleKeys.size}，residual 0`);
