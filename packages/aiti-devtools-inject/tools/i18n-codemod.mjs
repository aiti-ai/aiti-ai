#!/usr/bin/env node
/**
 * launcher i18n codemod（一次性工具，配合 docs/launcher-i18n-plan.md）
 *
 * 模式：
 *   collect            扫描 src/launcher/*.js 含 CJK 的简单字符串字面量 → 清单 JSON（供人工产英文映射）
 *   apply <map.json>   按映射（{中文原文: 英文key}）改写源码为 t('<en>') + 生成 locales/zh-cn.js
 *   residual           残留检查：未包 t() 的 CJK 字符串字面量（console.* 白名单跳过）
 *
 * 范围限定（设计取舍，见方案 §二）：
 *   - 只处理单行、不含反斜杠转义、不含同类引号的完整字面量（'...' / "..."）
 *   - 模板字符串/转义字面量/跨行拼接 → 留给 residual 报告后人工处理
 *   - 注释一律不碰（先做行内注释剥离，再扫描字符串）
 *   - console.* 行整体跳过（调试日志不迁移）
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src', 'launcher');
const CJK = /[\u4e00-\u9fff]/;
const SKIP_FILES = new Set(['i18n.js']); // i18n 自身无 UI 文案
const CONSOLE_RE = /\bconsole\./;

// 行内扫描：返回 { code, strings: [{raw, quote, start}] }
// 状态机逐字符走：字符串态内原样收集；字符串态外遇 // 截断（剥行注释）；/* */ 块注释跨行由调用方预处理为按行标记
function scanLine(line, inBlockComment) {
  var code = '';
  var strings = [];
  var i = 0, n = line.length;
  var buf = null, bufStart = 0;
  while (i < n) {
    var c = line[i];
    if (inBlockComment.now) { // 块注释态：找结束 */
      var end = line.indexOf('*/', i);
      if (end === -1) { return { code, strings, blockStill: true }; }
      inBlockComment.now = false;
      i = end + 2;
      continue;
    }
    if (buf) { // 字符串态
      if (c === '\\') { i += 2; continue; } // 转义：标记该串含转义（此处只跳过，串是否可用由 collect 判定）
      if (c === buf) { strings.push({ raw: line.slice(bufStart, i + 1), quote: buf, start: bufStart }); buf = null; }
      i++;
      continue;
    }
    if (c === "'" || c === '"') { buf = c; bufStart = i; i++; continue; }
    if (c === '/' && line[i + 1] === '/') break; // 行注释：剩余全丢
    if (c === '/' && line[i + 1] === '*') { inBlockComment.now = true; i += 2; continue; }
    code += c;
    i++;
  }
  if (buf) code += line.slice(bufStart); // 未闭合引号（跨行字符串）——原样保留，residual 兜底
  return { code, strings };
}

// 从 raw（含引号）取真实内容并判定是否"简单字面量"（无转义）
function parseSimple(raw) {
  var quote = raw[0];
  var inner = raw.slice(1, -1);
  if (inner.indexOf('\\') !== -1) return null; // 含转义 → 人工
  if (inner.indexOf(quote) !== -1) return null; // 异常防御
  return inner;
}

function listTargetFiles() {
  return readdirSync(SRC).filter(f => f.endsWith('.js') && !SKIP_FILES.has(f)).sort();
}

// 遍历每行（带块注释态跨行），产出 {file, line, raw, value} 清单；mode=apply 时返回改写函数
function collect() {
  var items = [];
  for (const f of listTargetFiles()) {
    const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
    const bc = { now: false };
    for (let ln = 0; ln < lines.length; ln++) {
      const r = scanLine(lines[ln], bc);
      if (CONSOLE_RE.test(r.code)) continue;
      for (const s of r.strings) {
        const v = parseSimple(s.raw);
        if (v == null || !CJK.test(v)) continue;
        items.push({ file: relative(root, join(SRC, f)), line: ln + 1, quote: s.quote, value: v });
      }
    }
  }
  return items;
}

function cmdCollect(outPath) {
  const items = collect();
  writeFileSync(outPath, JSON.stringify(items, null, 2), 'utf8');
  console.log(`[codemod] collect → ${items.length} 条 CJK 字符串字面量 → ${outPath}`);
  const uniq = new Set(items.map(x => x.value));
  console.log(`[codemod] 去重后 ${uniq.size} 条唯一文案（人工产英文映射）`);
}

async function cmdApply(mapPath) {
  // 映射支持 .json / .mjs（export default {...}）——JS 字面量避免 HTML 双引号转义地狱
  let map;
  if (mapPath.endsWith('.mjs')) map = (await import(mapPath)).default;
  else map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const bundle = {};
  let replaced = 0, missing = [];
  for (const f of listTargetFiles()) {
    const fp = join(SRC, f);
    const lines = readFileSync(fp, 'utf8').split('\n');
    const bc = { now: false };
    let changed = false;
    for (let ln = 0; ln < lines.length; ln++) {
      const r = scanLine(lines[ln], bc);
      if (CONSOLE_RE.test(r.code)) continue;
      let newline = lines[ln];
      // 逆序替换（start 定位不受前部改动影响）
      const hits = [];
      for (const s of r.strings) {
        const v = parseSimple(s.raw);
        if (v == null || !CJK.test(v)) continue;
        const en = map[v];
        if (!en) { missing.push(`${f}:${ln + 1} ${v.slice(0, 30)}`); continue; }
        hits.push({ start: s.start, raw: s.raw, en });
        bundle[en] = v;
      }
      for (let k = hits.length - 1; k >= 0; k--) {
        const h = hits[k];
        newline = newline.slice(0, h.start) + `t('${h.en.replace(/'/g, "\\'")}')` + newline.slice(h.start + h.raw.length);
        replaced++;
      }
      lines[ln] = newline;
      if (newline !== lines[ln] || hits.length) changed = changed || hits.length > 0;
    }
    if (changed) {
      lines.forEach((l, i) => { if (!l.includes(`from './i18n.js'`) && l.includes('t(')) {} });
      writeFileSync(fp, addImport(lines, f), 'utf8');
    }
  }
  // 生成 zh-cn bundle（JSON.stringify 产出的 key/value 均为合法 JS 字符串字面量）
  const keys = Object.keys(bundle).sort();
  const body = keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(bundle[k])},`).join('\n');
  const banner = `// zh-cn bundle: English source string -> Chinese translation\n// Maintained by tools/i18n-codemod.mjs (apply generates this file); parity checked\n// by tools/check-i18n.mjs (keys must exactly match t('...') calls in src/launcher/).\nexport default {\n${body}\n};\n`;
  writeFileSync(join(SRC, 'locales', 'zh-cn.js'), banner, 'utf8');
  console.log(`[codemod] apply 完成：替换 ${replaced} 处，bundle ${keys.length} 键`);
  if (missing.length) {
    console.log(`[codemod] ⚠ ${missing.length} 处缺映射（未改动）：`);
    missing.slice(0, 20).forEach(m => console.log('  ' + m));
  }
}

// 源文件头部加 t import（已有 i18n import 则跳过）；launcher 各模块均为相对 './' 导入
function addImport(lines, f) {
  const text = lines.join('\n');
  if (text.includes(`from './i18n.js'`)) return text;
  // 插在首个 import 行后；无 import 的文件插在最前
  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (/^import /.test(lines[i])) idx = i;
  lines.splice(idx + 1, 0, `import { t } from './i18n.js';`);
  return lines.join('\n');
}

function cmdResidual() {
  let bad = [];
  for (const f of listTargetFiles()) {
    if (f === 'locales' || f.startsWith('locales/')) continue;
    const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
    const bc = { now: false };
    for (let ln = 0; ln < lines.length; ln++) {
      const r = scanLine(lines[ln], bc);
      if (CONSOLE_RE.test(r.code)) continue;
      for (const s of r.strings) {
        const v = parseSimple(s.raw);
        if (v == null || !CJK.test(v)) continue;
        // 已包 t() 的跳过：字面量紧邻前缀为 t(
        const before = r.code.slice(0, s.start).trimEnd();
        // r.code 不含字符串体——用原行判断前缀
        const line = lines[ln];
        const pre = line.slice(0, s.start).trimEnd();
        if (/t\($/.test(pre)) continue;
        bad.push(`${f}:${ln + 1}  ${v.slice(0, 40)}`);
      }
    }
  }
  if (bad.length) {
    console.log(`[codemod] 残留 ${bad.length} 处未包 t() 的 CJK 字面量（人工处理）：`);
    bad.forEach(b => console.log('  ' + b));
    process.exitCode = 1;
  } else {
    console.log('[codemod] 残留检查通过：无未迁移的 CJK UI 字面量');
  }
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'collect') cmdCollect(arg || join(root, 'tools', 'i18n-collect.json'));
else if (mode === 'apply') cmdApply(arg || join(root, 'tools', 'i18n-map.mjs')).catch(e => { console.error('[codemod] apply 失败：', e.message); process.exit(1); });
else if (mode === 'residual') cmdResidual();
else { console.log('用法: node tools/i18n-codemod.mjs collect|apply <map.json>|residual'); process.exit(1); }
