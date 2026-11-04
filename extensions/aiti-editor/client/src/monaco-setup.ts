/**
 * aiti-editor · Monaco AMD 加载器 + 语言贡献/装饰/诊断（自手写版原样搬运）。
 */
import { apiUrl, ensureEditorTicket } from "./host-shim";
import { CSV_RAINBOW, detectDelimiter, parseCsvLine } from "./lib";
import { loadJsYaml } from "./registry";

// 注册 Markdown 折叠/大纲（基于标题的无侵入式语言服务，不依赖 Monaco 内建）
export function registerMarkdownServices(m: any): void {
  // 折叠提供者：## 标题 → 折叠区域
  m.languages.registerFoldingRangeProvider("markdown", {
    provideFoldingRanges: (model: any) => {
      const text = model.getValue();
      const lines = text.split("\n");
      const ranges: any[] = [];
      const stack: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        const m2 = lines[i].match(/^(#{1,6})\s/);
        if (!m2) continue;
        const level = m2[1].length;
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          const prev = stack.pop();
          if (prev.startLine < i) ranges.push({ start: prev.startLine + 1, end: i });
        }
        stack.push({ level, startLine: i });
      }
      while (stack.length > 0) {
        const prev = stack.pop();
        if (prev.startLine < lines.length - 1) ranges.push({ start: prev.startLine + 1, end: lines.length });
      }
      return ranges;
    },
  });
  // 文档符号提供者（大纲面板）
  m.languages.registerDocumentSymbolProvider("markdown", {
    provideDocumentSymbols: (model: any) => {
      const text = model.getValue();
      const lines = text.split("\n");
      const symbols: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        const m2 = lines[i].match(/^(#{1,6})\s+(.+)/);
        if (!m2) continue;
        symbols.push({
          name: m2[2],
          kind: m.languages.SymbolKind.String, // 用 String 代表 heading
          tags: [],
          containerName: "",
          range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: lines[i].length + 1 },
          selectionRange: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: lines[i].length + 1 },
        });
      }
      return symbols;
    },
  });
}

// ── 注册额外 Monarch 语法：TOML、.env、Log 文件（Monaco basic-languages 未打包）──
export function registerExtraLanguages(monaco: any): void {
  // --- TOML ---
  monaco.languages.register({ id: 'toml' });
  monaco.languages.setMonarchTokensProvider('toml', {
    defaultToken: '',
    tokenPostfix: '.toml',
    brackets: [{ token: 'delimiter.array', open: '[', close: ']' }],
    tokenizer: {
      root: [
        { include: '@whitespace' },
        { include: '@comment' },
        { include: '@table' },
        { include: '@string' },
        { include: '@number' },
        { include: '@keyword' },
        { include: '@datetime' },
        [/[a-zA-Z0-9_.-]+/, 'key'],
        [/=/, 'delimiter'],
      ],
      whitespace: [[/[ \t\r\n]+/, '']],
      comment: [[/#.*$/, 'comment']],
      table: [
        [/^\[\[.*?\]\]/, 'keyword'],
        [/^\[.*?\]/, 'keyword'],
      ],
      string: [
        [/"""/, { token: 'string', next: '@multilineBasicString' }],
        [/'''/, { token: 'string', next: '@multilineLiteralString' }],
        [/"/, { token: 'string', next: '@stringDouble' }],
        [/'/, { token: 'string', next: '@stringSingle' }],
      ],
      stringDouble: [[/[^"\\]+/, 'string'], [/\\./, 'string.escape'], [/"/, { token: 'string', next: '@pop' }]],
      stringSingle: [[/[^']+/, 'string'], [/'/, { token: 'string', next: '@pop' }]],
      multilineBasicString: [[/[^"\\]+/, 'string'], [/\\./, 'string.escape'], [/"""/, { token: 'string', next: '@pop' }], [/"/, 'string']],
      multilineLiteralString: [[/[^']+/, 'string'], [/'''/, { token: 'string', next: '@pop' }], [/'/, 'string']],
      number: [
        [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/0[xX][0-9a-fA-F]+/, 'number.hex'],
        [/0[oO][0-7]+/, 'number.octal'],
        [/0[bB][01]+/, 'number.binary'],
      ],
      keyword: [[/\b(?:true|false)\b/, 'keyword']],
      datetime: [
        [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/, 'number'],
        [/\d{4}-\d{2}-\d{2}/, 'number'],
        [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, 'number'],
      ],
    },
  });
  // --- .env / properties ---
  monaco.languages.register({ id: 'env' });
  monaco.languages.setMonarchTokensProvider('env', {
    tokenizer: {
      root: [
        [/^export\s+/, 'keyword'],
        [/^\s*#.*$/, 'comment'],
        [/^\s*;.*$/, 'comment'],
        [/^[^=#\s;\r\n]+/, 'key'],
        [/=/, 'delimiter'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/[^\r\n]+/, 'value'],
      ],
    },
  });
  // --- Log 文件 ---
  monaco.languages.register({ id: 'log' });
  monaco.languages.setMonarchTokensProvider('log', {
    tokenizer: {
      root: [
        [/\b(?:ERROR|FATAL|CRITICAL)\b/, 'error'],
        [/\b(?:WARN(?:ING)?)\b/, 'warn'],
        [/\b(?:INFO)\b/, 'info'],
        [/\b(?:DEBUG|TRACE)\b/, 'debug'],
        [/\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/, 'number'],
        [/\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/, 'number'],
        [/\[\d+\]/, 'tag'],
        [/^\s+at\s+/, 'tag'],
        [/\b(?:Exception|Error|Traceback|Caused by|Suppressed)\b/, 'error'],
        [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/, 'number'],
        [/\[\w+\]/, 'tag'],
      ],
    },
  });
  // --- CSV（仅注册，无 Monarch 语法；彩虹列用装饰实现）---
  monaco.languages.register({ id: 'csv' });
}

// 检测光标/选区是否落在 Markdown 表格内（上下扩展找表体，≥2 行判定；与 formatTable 同款扩展规则）
export function detectTable(editor: any): boolean {
  if (!editor) return false;
  var model = editor.getModel();
  if (!model) return false;
  var sel = editor.getSelection();
  var pos = sel || (editor.getPosition ? editor.getPosition() : null);
  if (!pos) return false;
  var startLine = sel ? sel.startLineNumber : pos.lineNumber;
  var endLine = sel ? sel.endLineNumber : startLine;
  const isTblLine = (s: string) => { const l = s.trim(); return l.charAt(0) === "|" || /^\|?[-:| ]+\|?$/.test(l); };
  var tableStart = startLine;
  while (tableStart > 1 && isTblLine(model.getLineContent(tableStart - 1))) tableStart--;
  var tableEnd = endLine;
  while (tableEnd < model.getLineCount() && isTblLine(model.getLineContent(tableEnd + 1))) tableEnd++;
  return tableEnd - tableStart >= 1;
}

// Markdown table formatting: align columns by width
export function formatTable(editor: any): void {
  if (!editor) return;
  var model = editor.getModel();
  if (!model) return;
  var sel = editor.getSelection();
  var startLine = sel ? sel.startLineNumber : editor.getPosition().lineNumber;
  var endLine = sel ? sel.endLineNumber : startLine;
  var tableStart = startLine;
  while (tableStart > 1) {
    var l = model.getLineContent(tableStart - 1).trim();
    if (l.charAt(0) === '|' || /^\|?[-:| ]+\|?$/.test(l)) tableStart--;
    else break;
  }
  var tableEnd = endLine;
  while (tableEnd < model.getLineCount()) {
    var l = model.getLineContent(tableEnd + 1).trim();
    if (l.charAt(0) === '|' || /^\|?[-:| ]+\|?$/.test(l)) tableEnd++;
    else break;
  }
  if (tableEnd - tableStart < 1) return;
  var rows: string[] = [];
  for (var i = tableStart; i <= tableEnd; i++) rows.push(model.getLineContent(i));
  var cols: number[] = [];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    if (/^\|?[-:| ]+\|?$/.test(row.trim())) continue;
    var parts = row.split('|');
    var p: string[] = [];
    for (var pi = 0; pi < parts.length; pi++) {
      var t = parts[pi].trim();
      if (pi === 0 && !t) continue;
      if (pi === parts.length - 1 && !t) continue;
      p.push(t);
    }
    if (p.length < 2) continue;
    for (var ci = 0; ci < p.length; ci++) {
      if (!cols[ci] || p[ci].length > cols[ci]) cols[ci] = p[ci].length;
    }
  }
  if (cols.length < 2) return;
  for (var ci = 0; ci < cols.length; ci++) cols[ci] = Math.max(cols[ci], 3);
  var newRows: string[] = [];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var parts = row.split('|');
    var p: string[] = [];
    for (var pi = 0; pi < parts.length; pi++) {
      var t = parts[pi].trim();
      if (pi === 0 && !t) continue;
      if (pi === parts.length - 1 && !t) continue;
      p.push(t);
    }
    if (/^\|?[-:| ]+\|?$/.test(row.trim())) {
      var sep = '|';
      for (var ci = 0; ci < p.length; ci++) {
        var cw = cols[ci] || 3;
        var d = p[ci].replace(/[^\-]/g, '') || '-';
        var left = p[ci].indexOf(':') === 0 ? ':' : ' ';
        var right = p[ci].lastIndexOf(':') === p[ci].length - 1 ? ':' : ' ';
        sep += ' ' + left + d.charAt(0).repeat(Math.max(cw - 3, 1)) + right + ' |';
      }
      newRows.push(sep);
    } else {
      var nl = '|';
      for (var ci = 0; ci < p.length; ci++) {
        var t = p[ci];
        var pad = cols[ci] - t.length;
        var left = Math.floor(pad / 2);
        var right = pad - left;
        nl += ' ' + ' '.repeat(left) + t + ' '.repeat(right) + ' |';
      }
      newRows.push(nl);
    }
  }
  editor.executeEdits('md-table-format', [{
    range: { startLineNumber: tableStart, startColumn: 1, endLineNumber: tableEnd, endColumn: model.getLineContent(tableEnd).length + 1 },
    text: newRows.join('\n'),
  }]);
}

// ── TS/JSX 语言服务默认配置（editor 友好：TSX 不整片标红）──
const REACT_TYPE_STUB = `
declare module "react" {
  export function useState<T>(init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(init: T): { current: T };
  export function useCallback<T extends (...a: any[]) => any>(fn: T, deps?: readonly unknown[]): T;
  export function useMemo<T>(fn: () => T, deps?: readonly unknown[]): T;
  export function useContext<T>(c: any): T;
  export const Fragment: any;
  const _default: { [k: string]: any };
  export default _default;
}
declare module "react/jsx-runtime" {
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
  export const Fragment: any;
}
declare namespace JSX { interface IntrinsicElements { [elem: string]: any } interface Element { [k: string]: any } }
`;

export function setupTsDefaults(monaco: any): void {
  try {
    const t = monaco.languages.typescript;
    const opts = {
      jsx: t.JsxEmit.ReactJSX,
      allowNonTsExtensions: true,
      allowJs: true,
      checkJs: false,
      moduleResolution: t.ModuleResolutionKind.NodeJs,
      target: t.ScriptTarget.ES2020,
      module: t.ModuleKind.ESNext,
      skipLibCheck: true,
    };
    t.typescriptDefaults.setCompilerOptions(opts);
    t.javascriptDefaults.setCompilerOptions(opts);
    t.typescriptDefaults.addExtraLib(REACT_TYPE_STUB, "ts:types/react.d.ts");
  } catch { /* 不阻塞编辑器 */ }
}

// ── 同目录兄弟文件 → TS extraLib（相对导入解析：浏览器 worker 无 FS，读不到 './host-shim'）──
export async function registerSiblingLibs(monaco: any, filePath: string): Promise<void> {
  const base = apiUrl("/api/extensions/aiti-editor");
  const tsDefaults = monaco.languages.typescript.typescriptDefaults;
  const dir = filePath.slice(0, filePath.lastIndexOf("/"));
  if (!dir) return;
  try {
    const t = await ensureEditorTicket(filePath);
    const r = await fetch(base + "/t/" + t + "/ts-siblings");
    const d = await r.json();
    if (!d.ok || !Array.isArray(d.files)) return;
    const openUris = new Set((monaco.editor.getModels() || []).map((m: any) => m.uri.toString()));
    for (const f of d.files) {
      if (!f.path || typeof f.content !== "string") continue;
      const uri = "file://" + f.path;
      if (openUris.has(uri)) continue; // 已作为模型打开 → 模型优先
      try { tsDefaults.addExtraLib(f.content, uri); } catch {}
    }
  } catch { /* 拉取失败不阻塞编辑器 */ }
}

let monacoPromise: Promise<any> | null = null;
let monacoAttempts = 0;
const MONACO_MAX_ATTEMPTS = 3;
// 注：不再做「清场重试」（移除 /monaco/vs/ 脚本 + 删 window.require/define）。
// 破坏性清场会把正在加载中的 AMD 模块链拦腰斩断（模块执行时 define 已消失 →
// 静默不注册，依赖方永远等待）。attempt() 本身幂等（monaco 就绪/loader 已执行/
// 需注入三种状态都能自愈），重试时直接重新评估当前状态即可。

// loader.js 执行就绪的全局握手（跨扩展共享）：谁注入谁登记，后续调用方直接复用同一个
// Promise——用 Promise 而非 DOM load 事件，避免“事件已触发过后再挂监听”的静默悬挂。
function ensureLoaderExecuted(vs: string): Promise<void> {
  const w = window as any;
  if ((window as any).require) return Promise.resolve();
  if (w.__aitiLoaderReady) return w.__aitiLoaderReady;
  w.__aitiLoaderReady = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = vs + "/loader.js";
    script.onload = () => resolve();
    script.onerror = () => {
      if ((window as any).__aitiLoaderReady === w.__aitiLoaderReady) delete w.__aitiLoaderReady;
      reject(new Error("Monaco loader.js fetch fail"));
    };
    document.head.appendChild(script);
  });
  return w.__aitiLoaderReady;
}

let _extrasRegistered = false;
/**
 * 确保 Markdown 折叠/额外 Monarch 语法（toml/env/log/csv）/TS 默认配置已注册。
 * 幂等：无论 window.monaco 由谁加载（本扩展 / aiti-git-review 预热走快速通道），
 * 创建模型前都必须调一次——否则这些语言未注册，createModel 会静默回退 plaintext。
 */
export function ensureMonacoExtras(_monaco?: any): void {
  const w = window as any;
  const monaco = _monaco || w.monaco;
  if (!monaco || _extrasRegistered) return;
  _extrasRegistered = true;
  registerMarkdownServices(monaco);
  registerExtraLanguages(monaco);
  setupTsDefaults(monaco);
}

export function loadMonaco(): Promise<any> {
  const w = window as any;
  if (w.monaco) return Promise.resolve(w.monaco);
  if (monacoPromise) return monacoPromise;
  const vs = apiUrl("/api/extensions/aiti-editor/assets/monaco/vs");
  monacoPromise = new Promise((resolve, reject) => {
    const attempt = () => {
      // 跨扩展安全（修双 loader 竞态）：aiti-git-review 等共用同一份 vs assets。
      // loader 注入经 ensureLoaderExecuted 全局握手去重（绝不二次注入执行）；
      // AMD 的 require/config/require(["vs/editor/editor.main"]) 幂等，直接复用。
      ensureLoaderExecuted(vs).then(() => {
        try {
          if (!(window as any).require) return fail(new Error("loader.js: no require"));
          w.__aitiMonacoOwned = true;
          w.require.config({ paths: { vs } });
          w.require(["vs/editor/editor.main"], () => {
            if (w.monaco) {
              monacoAttempts = 0;
              ensureMonacoExtras(w.monaco);
              // 注入加载动画 CSS（一次性）
              if (!document.getElementById('aiti-editor-spinner')) {
                const style = document.createElement('style');
                style.id = 'aiti-editor-spinner';
                style.textContent = '@keyframes aiti-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
                document.head.appendChild(style);
              }
              resolve(w.monaco);
            } else fail(new Error("editor.main loaded but no monaco"));
          }, (err: any) => fail(err || new Error("editor.main load fail")));
        } catch (e) { fail(e); }
      }).catch((e) => fail(e));
    };
    const fail = (err: any) => {
      monacoAttempts += 1;
      if (monacoAttempts >= MONACO_MAX_ATTEMPTS) {
        monacoPromise = null; // 不永久毒化：下次打开/点重试仍会重新加载
        reject(err);
        return;
      }
      setTimeout(attempt, monacoAttempts * 600); // 600ms / 1200ms 退避
    };
    attempt();
  });
  return monacoPromise;
}

// ── 语言贡献模块懒加载 ──
const CONTRIB_MAP: Record<string, string> = {
  typescript: "vs/language/typescript/monaco.contribution",
  javascript: "vs/language/typescript/monaco.contribution",
  json: "vs/language/json/monaco.contribution",
  jsonc: "vs/language/json/monaco.contribution",
  css: "vs/language/css/monaco.contribution",
  scss: "vs/language/css/monaco.contribution",
  less: "vs/language/css/monaco.contribution",
  html: "vs/language/html/monaco.contribution",
  htm: "vs/language/html/monaco.contribution",
  vue: "vs/language/html/monaco.contribution",
};
const contribLoaded: Record<string, boolean> = {};
export function loadContribution(lang: string): Promise<void> {
  const path = CONTRIB_MAP[lang];
  if (!path) return Promise.resolve();
  if (contribLoaded[path]) return Promise.resolve();
  contribLoaded[path] = true;
  return new Promise((resolve) => {
    try { (window as any).require([path], () => resolve(), () => resolve()); }
    catch { resolve(); }
  });
}

// CSV 彩虹列装饰 + 列数诊断
export function setupCsvDecorations(monaco: any, editor: any): (() => void) | undefined {
  if (!editor || !editor.getModel()) return;
  const model = editor.getModel();
  let decorationIds: any[] = [];
  function updateDecorations(): void {
    const text = model.getValue();
    const lines = text.split('\n');
    if (lines.length < 2) { decorationIds = editor.deltaDecorations(decorationIds, []); return; }
    const delim = detectDelimiter(lines[0]);
    const colCounts: number[] = [];
    const decorations: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i], delim);
      colCounts.push(fields.length);
      let colStart = 0;
      for (let j = 0; j < fields.length; j++) {
        const fieldLen = fields[j].length;
        const colEnd = colStart + fieldLen;
        const colorIdx = j % CSV_RAINBOW.length;
        decorations.push({
          range: new monaco.Range(i + 1, colStart + 1, i + 1, colEnd + 1),
          options: { inlineClassName: 'csv-column-' + colorIdx, isWholeLine: false },
        });
        colStart = colEnd + 1;
      }
    }
    decorationIds = editor.deltaDecorations(decorationIds, decorations);
    // 动态注入 CSS（一次）
    if (!document.getElementById('csv-rainbow-css')) {
      const style = document.createElement('style');
      style.id = 'csv-rainbow-css';
      let css = '';
      for (let i = 0; i < CSV_RAINBOW.length; i++) {
        css += '.csv-column-' + i + '{background:' + CSV_RAINBOW[i] + ';}\n';
      }
      style.textContent = css;
      document.head.appendChild(style);
    }
    // 诊断：列数不一致
    const markers: any[] = [];
    if (colCounts.length > 1) {
      const expected = colCounts[0];
      for (let i = 1; i < colCounts.length; i++) {
        if (colCounts[i] !== expected && colCounts[i] > 0) {
          markers.push({
            severity: monaco.MarkerSeverity.Warning,
            message: '列数不一致：第 ' + (i + 1) + ' 行有 ' + colCounts[i] + ' 列，期望 ' + expected + ' 列',
            startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: lines[i].length + 1,
          });
        }
      }
    }
    monaco.editor.setModelMarkers(model, 'csv-lint', markers);
  }
  updateDecorations();
  const disposable = model.onDidChangeContent(() => updateDecorations());
  return () => { disposable.dispose(); decorationIds = editor.deltaDecorations(decorationIds, []); };
}

// ── 通用诊断：YAML / TOML 语法验证（在编辑器创建时调用）──
export function setupModelDiagnostics(monaco: any, editor: any): (() => void) | undefined {
  if (!editor || !editor.getModel()) return;
  const model = editor.getModel();
  const lang = model.getLanguageId();
  if (lang !== 'yaml' && lang !== 'toml') return;
  const update = () => {
    const text = model.getValue();
    const markers: any[] = [];
    if (lang === 'yaml') {
      if (!(window as any).jsyaml) {
        // js-yaml 未就绪：主动触发懒加载，完成后重跑一次诊断。
        // （旧行为只在用户手动格式化时才加载 → 打开文件后诊断永远沉默；
        //   且旧 <script> 直插在 Monaco AMD 环境下永远挂不上 window.jsyaml）
        // 防循环保险：无论加载成败，每个模型只触发一次懒加载重跑
        const upd = update as any;
        if (!upd._yamlLoadKicked) {
          upd._yamlLoadKicked = true;
          loadJsYaml().then(() => update()).catch(() => {});
        }
        return;
      }
      try {
        (window as any).jsyaml.load(text, { schema: (window as any).jsyaml.DEFAULT_SCHEMA });
      } catch (e: any) {
        const msg = (e && e.message) || 'YAML 语法错误';
        const lineMatch = msg.match(/line (\d+)/i);
        const line = lineMatch ? parseInt(lineMatch[1]) : 1;
        markers.push({
          severity: monaco.MarkerSeverity.Error,
          message: msg,
          startLineNumber: line, startColumn: 1, endLineNumber: line,
          endColumn: (model.getLineContent(line) || '').length + 1,
        });
      }
    } else if (lang === 'toml') {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
        if (trimmed.includes('=')) continue;
        if (/^["'\d\[\{]/.test(trimmed)) continue;
        if (/^(true|false)\s*$/.test(trimmed)) continue;
        markers.push({
          severity: monaco.MarkerSeverity.Hint,
          message: '无法解析的行（TOML 语法）',
          startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: lines[i].length + 1,
        });
      }
    }
    monaco.editor.setModelMarkers(model, lang + '-lint', markers);
  };
  update();
  const disposable = model.onDidChangeContent(() => update());
  return () => { disposable.dispose(); monaco.editor.setModelMarkers(model, lang + '-lint', []); };
}

// 语言服务桥（M4）：消费注册表 services → 注册 Monaco provider（模块级去重防重复注册）。
const _servicesApplied: Record<string, boolean> = {};
export function applyLanguageServices(monaco: any, lang: string, model: any): void {
  const svc = (window as any).__aitiEditor._getServices(lang);
  if (!svc || _servicesApplied[lang]) return;
  _servicesApplied[lang] = true;
  try {
    if (typeof svc.completion === "function") {
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: svc.triggerCharacters || [],
        provideCompletionItems: (m: any, pos: any) => {
          const list = svc.completion(m.getValue(), pos.lineNumber, pos.column, m, pos) || [];
          return { suggestions: list.map((it: any) => ({
            label: it.label,
            kind: monaco.languages.CompletionItemKind[it.kind] || monaco.languages.CompletionItemKind.Text,
            insertText: it.insertText || it.label,
            detail: it.detail || "",
          })) };
        },
      });
    }
    if (typeof svc.hover === "function") {
      monaco.languages.registerHoverProvider(lang, {
        provideHover: (m: any, pos: any) => {
          const info = svc.hover(m.getValue(), pos.lineNumber, pos.column, m, pos);
          if (!info) return null;
          const val = typeof info === "string" ? info : (info.value || info.contents);
          return { contents: [{ value: String(val) }] };
        },
      });
    }
    if (typeof svc.format === "function") {
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        provideDocumentFormattingEdits: (m: any) => {
          const out = svc.format(m.getValue(), m);
          if (!out || out === m.getValue()) return [];
          return [{ range: m.getFullModelRange(), text: out }];
        },
      });
    }
    if (typeof svc.folding === "function") {
      monaco.languages.registerFoldingRangeProvider(lang, {
        provideFoldingRanges: () => (svc.folding(model) || []).map((r: any) => ({ start: r.start, end: r.end })),
      });
    }
    if (typeof svc.outline === "function") {
      monaco.languages.registerDocumentSymbolProvider(lang, {
        provideDocumentSymbols: () => {
          const out = svc.outline(model) || [];
          return out.map((s: any) => ({
            name: s.name,
            kind: monaco.languages.SymbolKind[s.kind] || monaco.languages.SymbolKind.String,
            tags: [], containerName: s.containerName || "",
            range: s.range, selectionRange: s.selectionRange || s.range,
          }));
        },
      });
    }
  } catch { /* provider 注册失败不阻断编辑 */ }
}
