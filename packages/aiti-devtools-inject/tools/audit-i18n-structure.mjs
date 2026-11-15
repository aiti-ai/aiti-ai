#!/usr/bin/env node
// 一次性审计 v3：以 git diff -U0 的 hunk 头做精确行配对，逐对行做骨架对比
// OLD 行的中文字面量 ↔ NEW 行的 t('...')（解码转义后）必须一一对应，顺序/数量一致。
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src', 'launcher');
const CJK = /[\u4e00-\u9fff]/;

function oldSkeleton(line) {
  // 注释剥离（行注释；字符串内 // 罕见，双端同规则）
  const s = line.replace(/\/\/.*$/, '');
  let out = '';
  let i = 0;
  let buf = null;
  let bs = 0;
  let n = 0;
  while (i < s.length) {
    const c = s[i];
    if (buf) {
      if (c === '\\') { i += 2; continue; }
      if (c === buf) {
        out += CJK.test(s.slice(bs + 1, i)) ? `<t${++n}>` : s.slice(bs, i + 1);
        buf = null;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') { buf = c; bs = i; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function newSkeleton(line) {
  const s = line.replace(/\/\/.*$/, '');
  let out = '';
  let i = 0;
  let n = 0;
  while (i < s.length) {
    const idx = s.indexOf("t('", i);
    if (idx === -1) { out += s.slice(i); break; }
    if (idx > 0 && /[A-Za-z0-9_$]/.test(s[idx - 1])) { out += s.slice(i, idx + 3); i = idx + 3; continue; }
    out += s.slice(i, idx);
    out += `<t${++n}>`;
    let j = idx + 3;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; } // 解码转义（占位不含内容）
      if (s[j] === "'") break;
      j++;
    }
    i = (s[j + 1] === ')') ? j + 2 : j + 1;
  }
  return out;
}

let bad = 0;
let checked = 0;
const diff = execSync('git diff -U0 HEAD -- src/launcher', { cwd: root, encoding: 'utf8' });
let curFile = null;
let oldLines = [];
let newLines = [];
let minus = [];
let plus = [];

function flushHunk() {
  if (!curFile || !minus.length && !plus.length) { minus = []; plus = []; return; }
  const fp = join(SRC, curFile);
  // 只审计「- 行含 CJK 字面量 且 + 行含 t(」的纯替换对（等量替换）
  if (minus.length === plus.length) {
    for (let k = 0; k < minus.length; k++) {
      const o = minus[k];
      const p = plus[k];
      if (!CJK.test(o) || !p.includes("t('")) continue;
      if (/\bconsole\./.test(o)) continue;
      checked++;
      const so = oldSkeleton(o);
      const sp = newSkeleton(p);
      if (so !== sp) {
        bad++;
        console.log(`STRUCT ${curFile}: ${o.trim().slice(0, 90)}`);
        console.log(`   OLD: ${so.slice(0, 130)}`);
        console.log(`   NEW: ${sp.slice(0, 130)}`);
      }
    }
  } else {
    // 不等量（如 hud 结构修复行）→ 列出供人工确认
    console.log(`HUNK(${minus.length}->${plus.length}) ${curFile}:`);
    minus.forEach(x => console.log('  -', x.trim().slice(0, 110)));
    plus.forEach(x => console.log('  +', x.trim().slice(0, 110)));
  }
  minus = [];
  plus = [];
}

for (const line of diff.split('\n')) {
  if (line.startsWith('diff ') || line.startsWith('index ')) continue;
  if (line.startsWith('+++')) { const m = line.match(/ b\/(.*)$/); if (m) curFile = m[1].replace(/^src\/launcher\//, ''); continue; }
  if (line.startsWith('---')) continue;
  const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  if (hunk) { flushHunk(); continue; }
  if (line.startsWith('-')) minus.push(line.slice(1));
  else if (line.startsWith('+')) plus.push(line.slice(1));
  // 上下文行（U0 无）忽略
}
flushHunk();
console.log(`[audit] 结构对比 ${checked} 行，异常 ${bad}`);
process.exit(bad ? 1 : 0);
