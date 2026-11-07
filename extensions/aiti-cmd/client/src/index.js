/**
 * aiti-cmd client bundle — prebuilt ESM（与 aiti-devtools 同模式：host 传 h/useState/useEffect/apiUrl）
 *
 * UI：
 *   - toolbar：⚡ 命令按钮 → 打开主面板
 *   - dialogs：命令面板（命令/终端双页签 + xterm.js 真终端）+ 命令详情（消息识别点开）
 *   - 全局桥：window.__aitiCmd.openCommand(cmd, cwd) — pi-web core 消息点击识别（onCommand）调用
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";
import { uiConfirm, uiAlert, uiPrompt } from "../../../_shared/ui-dialogs";

// 注入 xterm.css（构建时以 text 内联）
if (typeof document !== "undefined" && !document.getElementById("aiti-cmd-xterm-css")) {
  const style = document.createElement("style");
  style.id = "aiti-cmd-xterm-css";
  style.textContent = xtermCss;
  document.head.appendChild(style);
}

// ---------- 模块级状态（跨组件共享；同 aiti-client.mjs 的 listener 模式） ----------
// view：总览页当前详情视图 {kind:"pi"|"pty", id, title}（点列表行进入，← 返回）
const state = { panelOpen: false, view: null, detail: null, detailBusy: false };
const stateListeners = new Set();
function notify() { for (const l of stateListeners) l(); }
function setState(patch) { Object.assign(state, patch); notify(); }
function openView(kind, id, title) { setState({ view: { kind, id, title } }); }
function closeView() { setState({ view: null }); }


const btnStyle = {
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--border)", background: "var(--bg-hover)",
  borderRadius: 6, padding: "5px 12px", cursor: "pointer",
  fontSize: 13, color: "var(--text)", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
  whiteSpace: "nowrap", flexShrink: 0,
};
const rowStyle = { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" };
const inputStyle = {
  flex: 1, border: "1px solid var(--border)", borderRadius: 6,
  padding: "5px 10px", fontSize: 13, background: "var(--bg)", color: "var(--text)",
  fontFamily: "inherit",
};
const smallStyle = { fontSize: 13, color: "var(--text-muted)", margin: 0, wordBreak: "break-all", lineHeight: 1.5 };
// topbar 工具栏按钮：与系统内建按钮一致（AppShell topbarRowBtnStyle：flex 居中 + fixed 36×36（=系统 TOP_BAR_ICON_BUTTON_SIZE） + hover 变色）
const topbarBtnStyle = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 36, height: 36, padding: 0,
  background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
  color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
  transition: "color 0.12s",
};
const SOURCE_LABEL = { manual: "手动", message: "消息识别", shell: "终端", favorite: "收藏", "asr-selfheal": "ASR 自愈", schedule: "定时", suggest: "联想", "ai-helper": "AI", codebuddy: "CodeBuddy", service: "服务", unknown: "未知" };

// 沙箱模式（默认 none 无沙箱）：label 用于编辑弹窗 select；icon 用于列表/会话行标记；hint 用于弹窗提示
const SANDBOX = {
  none:      { label: "无沙箱（完全信任）· 默认", icon: "", short: "无沙箱", hint: "不隔离文件系统/网络，仅限可信命令", warn: true },
  "bwrap-ro":      { label: "系统只读（工作目录可写）", icon: " 🛡", short: "只读", hint: "文件系统只读，改动不落盘；工作目录真实可写", warn: false },
  "bwrap-offline": { label: "只读 + 断网", icon: " 🛡", short: "只读+断网", hint: "文件系统只读且无网络——最高隔离，适合不信任命令", warn: false },
  "bwrap-tmp":     { label: "临时可写盘（退出即丢）", icon: " ♻", short: "临时盘", hint: "一次性环境：系统只读，/tmp、$HOME 可写但退出即丢", warn: false },
};
const SANDBOX_ORDER = ["none", "bwrap-ro", "bwrap-offline", "bwrap-tmp"];

// 终端配色（slate 色板 × 深背景）：默认主题的纯白前景 + 黑底在亮色 UI 里割裂，
// 且 brightBlack(#666) 在黑底上几乎看不清；统一用高对比 slate 色板，背景与容器无缝
const TERM_THEME = {
  background: "#0f172a",
  foreground: "#e2e8f0",
  cursor: "#93c5fd",
  cursorAccent: "#0f172a",
  selectionBackground: "#334155",
  black: "#0f172a", brightBlack: "#7c8ba1",
  red: "#f87171", brightRed: "#fca5a5",
  green: "#4ade80", brightGreen: "#86efac",
  yellow: "#facc15", brightYellow: "#fde047",
  blue: "#60a5fa", brightBlue: "#93c5fd",
  magenta: "#c084fc", brightMagenta: "#e9d5ff",
  cyan: "#22d3ee", brightCyan: "#67e8f9",
  white: "#cbd5e1", brightWhite: "#f8fafc",
};
// 字体：不用页面 --font-mono（链到 next/font 的 Noto Sans Mono，异步加载——xterm 先用
// fallback 测量字符宽度，字体 swap 后列宽错位）；系统等宽栈加载即时、度量稳定
const TERM_FONT = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

// ---------- 终端增强：窗口大小 / 全屏 / 虚拟键盘 / 快捷键 ----------
// 窗口大小预设：fit=自适应容器（默认，桌面端即常规终端观感）；其余为固定 列×行（同常规终端窗口，小屏用滚动看全貌）
const TERM_SIZES = [
  { id: "fit", label: "自适应", cols: null, rows: null },
  { id: "80x24", label: "80×24", cols: 80, rows: 24 },
  { id: "100x30", label: "100×30", cols: 100, rows: 30 },
  { id: "120x40", label: "120×40", cols: 120, rows: 40 },
  { id: "160x50", label: "160×50", cols: 160, rows: 50 },
];
// 常用快捷键参考（帮助弹层）
const TERM_SHORTCUTS = [
  ["Ctrl+C", "中断当前命令（SIGINT）"],
  ["Ctrl+D", "退出 shell / EOF"],
  ["Ctrl+Z", "挂起当前任务（后台）"],
  ["Ctrl+L", "清屏"],
  ["Ctrl+A / Ctrl+E", "光标到行首 / 行尾"],
  ["Ctrl+U / Ctrl+K", "删除到行首 / 删除到行尾"],
  ["Ctrl+W", "删除前一个单词"],
  ["Ctrl+R", "反向搜索命令历史"],
  ["Ctrl+← / Ctrl+→", "按词移动光标（readline）"],
  ["Ctrl+↑ / Ctrl+↓", "上/下翻（终端）"],
  ["Tab", "命令 / 路径补全"],
  ["↑ / ↓", "上一条 / 下一条命令历史"],
  ["← / →", "光标左 / 右移"],
  ["Home / End", "行首 / 行尾"],
  ["PgUp / PgDn", "上翻 / 下翻一页"],
  ["Esc", "取消 / 进入 vi 模式"],
  ["右键 / Ctrl+Shift+C / Ctrl+Insert", "复制选中的终端文本（Ctrl+C 是中断，不能用来复制）"],
  ["Ctrl+Shift+V / Shift+Insert", "粘贴剪贴板到终端"],
  ["Ctrl+Shift+F", "切换终端全屏"],
  ["Ctrl+Shift+K", "切换虚拟键盘"],
  ["Ctrl+Shift+S", "循环终端窗口大小"],
  ["F1–F12", "终端功能键（虚拟键盘「常用/全键」底部一行，mc / htop 等 TUI 用）"],
];
// 工具条按钮说明（帮助弹层用：触屏没有 hover，title 看不见，按钮含义在这里集中解释）；
// 滚动按钮标签随 UI 语言：zh → 「↓底」，其他 → 图标「⇊」
const TOOLBAR_LEGEND = (zh) => [
  [zh ? "↓底" : "⇊", "滚动到底部：跳到最新输出（上翻阅读时不会打扰）"],
  ["⌨", "虚拟键盘：方向 / Tab / Esc / Ctrl / 常用符号（Ctrl+Shift+K）"],
  ["?", "本帮助面板"],
  ["＋", "新建：再开一个 shell（目录 = 当前终端 📁 实时路径）"],
  ["新会话", "新建 pi-web 会话：打开新 agent 会话并 @ 当前终端实时路径"],
  ["⇲", "拉回窗口：终端视图移回 aiti-cmd 弹窗（页签显示占位；仅页签模式有）"],
  ["⛶", "全屏 / 退出全屏（Ctrl+Shift+F）"],
];
// Shift 锁的上档映射：数字/标点键 → 上档符号（字母键走大写分支；符号键已是上档形态时直接吞锁）
const SHIFTED = { "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+", "`": "~", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?" };
// 功能键 F1-F12 行：发 xterm 标准转义序列（F1-F4 走 SS3 \x1bOP..，F5-F12 走 CSI \x1b[15~..；
// 与 xterm.js 物理键盘默认输出一致，mc / htop / less 等 TUI 用 F 键操作）
const KEYPAD_FN_ROW = [
  { k: "F1", seq: "\x1bOP", c: "功能键 F1" },
  { k: "F2", seq: "\x1bOQ", c: "功能键 F2" },
  { k: "F3", seq: "\x1bOR", c: "功能键 F3" },
  { k: "F4", seq: "\x1bOS", c: "功能键 F4" },
  { k: "F5", seq: "\x1b[15~", c: "功能键 F5" },
  { k: "F6", seq: "\x1b[17~", c: "功能键 F6" },
  { k: "F7", seq: "\x1b[18~", c: "功能键 F7" },
  { k: "F8", seq: "\x1b[19~", c: "功能键 F8" },
  { k: "F9", seq: "\x1b[20~", c: "功能键 F9" },
  { k: "F10", seq: "\x1b[21~", c: "功能键 F10" },
  { k: "F11", seq: "\x1b[23~", c: "功能键 F11" },
  { k: "F12", seq: "\x1b[24~", c: "功能键 F12" },
];
// 虚拟键盘键位（参考小屏终端：Termux 默认 extra-keys = ESC / - / HOME / ↑↓←→ / END / PGDN / PGUP / TAB / CTRL / ALT，
// 并补 JuiceSSH / ConnectBot 常见的常用符号与 Ctrl 组合；外加 SHIFT（大写/上档）与 WIN（Meta）锁）
const KEYPAD_ROWS = [
  [
    { k: "ESC", seq: "\x1b", c: "取消" },
    { k: "TAB", seq: "\t", c: "补全" },
    { k: "SHIFT", mod: "shift" },
    { k: "CTRL", mod: "ctrl" },
    { k: "ALT", mod: "alt" },
    { k: "WIN", mod: "win" },
    { k: "|", txt: "|" },
    { k: "~", txt: "~" },
    { k: "-", txt: "-" },
    { k: "_", txt: "_" },
    { k: "HOME", seq: "\x1b[H", c: "行首" },
    { k: "END", seq: "\x1b[F", c: "行尾" },
    { k: "PGUP", seq: "\x1b[5~", c: "上翻" },
    { k: "PGDN", seq: "\x1b[6~", c: "下翻" },
  ],
  [
    { k: "↑", seq: "\x1b[A", c: "上一条历史/上移" },
    { k: "↓", seq: "\x1b[B", c: "下一条历史/下移" },
    { k: "←", seq: "\x1b[D", c: "左移" },
    { k: "→", seq: "\x1b[C", c: "右移" },
    { k: "⌫", seq: "\x7f", c: "退格" },
    { k: "↵", seq: "\r", c: "回车" },
    { k: "C-c", seq: "\x03", c: "中断" },
    { k: "C-d", seq: "\x04", c: "退出/EOF" },
    { k: "C-z", seq: "\x1a", c: "挂起" },
    { k: "C-l", seq: "\x0c", c: "清屏" },
    { k: "C-a", seq: "\x01", c: "光标到行首" },
    { k: "C-e", seq: "\x05", c: "光标到行尾" },
    { k: "C-r", seq: "\x12", c: "反向搜索历史" },
    { k: "C-u", seq: "\x15", c: "删到行首" },
    { k: "C-w", seq: "\x17", c: "删词" },
  ],
  KEYPAD_FN_ROW,
];
// 全键盘（ABC 全键档）：完整字母 / 数字 / 符号 / 空格，CTRL/SHIFT/ALT/WIN 锁 + 键 = 组合键
const KBD_DQUOTE = String.fromCharCode(34); // "
const KBD_BSLASH = String.fromCharCode(92); // \
const KEYPAD_FULL_ROWS = [
  [
    { k: "1", txt: "1" }, { k: "2", txt: "2" }, { k: "3", txt: "3" }, { k: "4", txt: "4" }, { k: "5", txt: "5" },
    { k: "6", txt: "6" }, { k: "7", txt: "7" }, { k: "8", txt: "8" }, { k: "9", txt: "9" }, { k: "0", txt: "0" },
    { k: "-", txt: "-" }, { k: "=", txt: "=" },
  ],
  [
    { k: "Q", txt: "q" }, { k: "W", txt: "w" }, { k: "E", txt: "e" }, { k: "R", txt: "r" }, { k: "T", txt: "t" },
    { k: "Y", txt: "y" }, { k: "U", txt: "u" }, { k: "I", txt: "i" }, { k: "O", txt: "o" }, { k: "P", txt: "p" },
  ],
  [
    { k: "A", txt: "a" }, { k: "S", txt: "s" }, { k: "D", txt: "d" }, { k: "F", txt: "f" }, { k: "G", txt: "g" },
    { k: "H", txt: "h" }, { k: "J", txt: "j" }, { k: "K", txt: "k" }, { k: "L", txt: "l" },
  ],
  [
    { k: "Z", txt: "z" }, { k: "X", txt: "x" }, { k: "C", txt: "c" }, { k: "V", txt: "v" }, { k: "B", txt: "b" },
    { k: "N", txt: "n" }, { k: "M", txt: "m" }, { k: "⌫", seq: "\x7f", c: "退格" },
  ],
  [
    { k: "&", txt: "&" }, { k: ";", txt: ";" }, { k: ":", txt: ":" }, { k: "'", txt: "'" }, { k: KBD_DQUOTE, txt: KBD_DQUOTE },
    { k: KBD_BSLASH, txt: KBD_BSLASH }, { k: "/", txt: "/" }, { k: "?", txt: "?" }, { k: "!", txt: "!" }, { k: "$", txt: "$" },
    { k: "#", txt: "#" }, { k: "@", txt: "@" }, { k: "%", txt: "%" }, { k: "^", txt: "^" }, { k: "*", txt: "*" },
  ],
  [
    { k: "(", txt: "(" }, { k: ")", txt: ")" }, { k: "[", txt: "[" }, { k: "]", txt: "]" }, { k: "{", txt: "{" },
    { k: "}", txt: "}" }, { k: "<", txt: "<" }, { k: ">", txt: ">" }, { k: "=", txt: "=" }, { k: "+", txt: "+" },
    { k: ".", txt: "." }, { k: ",", txt: "," }, { k: "|", txt: "|" }, { k: "~", txt: "~" },
  ],
  [
    { k: "ESC", seq: "\x1b", c: "取消" }, { k: "TAB", seq: "\t", c: "补全" },
    { k: "SHIFT", mod: "shift" }, { k: "CTRL", mod: "ctrl" }, { k: "ALT", mod: "alt" }, { k: "WIN", mod: "win" },
    { k: "␣", txt: " ", c: "空格" }, { k: "↵", seq: "\r", c: "回车" },
  ],
  KEYPAD_FN_ROW,
];
// 终端偏好持久化（localStorage：窗口大小 / 键盘开关）
const LS_TERM_SIZE = "aiti-cmd:term-size";
const LS_TERM_KBD = "aiti-cmd:term-kbd";
function lsGet(key, def) { try { const v = localStorage.getItem(key); if (v == null) return def; return JSON.parse(v); } catch { return def; } }
function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }
// UI 语言（与宿主 pi-web useI18n 同源：localStorage pi-locale；切语言时宿主派发 pi-web:locale-changed）
const LOCALE_CHANGED_EVENT = "pi-web:locale-changed";
function uiLocale() { try { return localStorage.getItem("pi-locale") || "en"; } catch { return "en"; } }

// ---------- 终端链接识别（xterm link provider）：URL → 点击确认 → 新窗口打开 ----------
// http(s):// 开头，排除空白/引号/尖括号/括号/花括号/方括号；匹配后清洗尾部误收标点
const TERM_URL_RE = /https?:\/\/[^\s"'<>\[\]{}()]+/g;
function installTermLinkProvider(term, onLink) {
  try {
    return term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        // xterm 的 linkifier 传 1 基行号（e.y = 1 基可见行 + ydisp）——官方 WebLinksAddon 同约定：
        // getLine 用 0 基（行号-1），range.y 用 1 基（与 _linkAtPosition 的位置空间一致）
        let line = null;
        try { line = term.buffer.active.getLine(bufferLineNumber - 1); } catch (e) {}
        if (!line) { callback(undefined); return; }
        const text = line.translateToString(true);
        const links = [];
        TERM_URL_RE.lastIndex = 0;
        let m;
        while ((m = TERM_URL_RE.exec(text)) !== null) {
          let raw = m[0];
          let start = m.index;
          // 尾部清洗：去掉常见误收标点（.,;:!?）与不成对的右括号
          let tail = raw.replace(/[.,;:!?]+$/, "");
          const cp = tail.lastIndexOf(")");
          const op = tail.lastIndexOf("(");
          if (cp > op) tail = tail.slice(0, cp);
          raw = tail;
          if (raw.length < 9 || !/^https?:\/\//.test(raw)) continue; // 太短/被清洗成非 URL
          const end = start + raw.length;
          links.push({
            range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end, y: bufferLineNumber } },
            text: raw,
            decorations: { pointerCursor: true, underline: true },
            activate: (_event, uri) => onLink(uri),
          });
        }
        callback(links);
      },
    });
  } catch (e) { return null; }
}
// 链接确认浮层：点击链接后弹确认，确认后新窗口打开（noopener）——组件定义在 register(ctx) 内（使用 ctx.h）

// ---------- 终端复制/粘贴绑定：右键=复制选区（有选区时拦截浏览器菜单）；快捷键 Ctrl+Shift+C /
// Ctrl+Insert 复制、Ctrl+Shift+V / Shift+Insert 粘贴。返回 handleKey 供 attachCustomKeyEventHandler
// 接线（返回 true = 已消费，调用方应 ev 已被 preventDefault 并 return false 拦住 xterm 默认行为）。
// 注意 Ctrl+C 保持发 SIGINT 不动——终端里复制只能靠上述途径（浏览器习惯的 Ctrl+C 在终端语义里是中断）。
function installTermClipboard(term, el, onPaste) {
  const copySel = () => {
    try {
      const s = term.getSelection();
      if (!s) return false;
      navigator.clipboard?.writeText(s)?.catch?.(() => {});
      return true;
    } catch { return false; }
  };
  const onCtx = (e) => { if (copySel()) e.preventDefault(); };
  el.addEventListener("contextmenu", onCtx);
  return {
    copySel,
    handleKey(ev) {
      if (ev.type !== "keydown" || !ev.key) return false;
      const k = ev.key.toLowerCase();
      if (ev.ctrlKey && ev.shiftKey && k === "c") { if (copySel()) { ev.preventDefault(); return true; } return false; }
      if (ev.ctrlKey && !ev.shiftKey && k === "insert") { ev.preventDefault(); return copySel(); }
      if (ev.shiftKey && !ev.ctrlKey && k === "insert") { ev.preventDefault(); onPaste?.(); return true; }
      if (ev.ctrlKey && ev.shiftKey && k === "v") { ev.preventDefault(); onPaste?.(); return true; }
      return false;
    },
    dispose() { el.removeEventListener("contextmenu", onCtx); },
  };
}

export default function register(ctx) {
  const { h, useState, useEffect, useRef, apiUrl } = ctx;

  // UI 语言（zh → 中文标签「↓底」，其他语言 → 图标「⇊」；跟随宿主切语言重渲染）
  function useIsZh() {
    const [zh, setZh] = useState(() => uiLocale() === "zh-CN");
    useEffect(() => {
      const onChange = () => setZh(uiLocale() === "zh-CN");
      window.addEventListener(LOCALE_CHANGED_EVENT, onChange);
      return () => window.removeEventListener(LOCALE_CHANGED_EVENT, onChange);
    }, []);
    return zh;
  }

  // lucide 图标（与系统内建线条图标同风格）
  const Ic = (size, paths) => {
    const el = h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths.map((d, i) => h("path", { key: i, d })));
    if (el._store) el._store.validated = 1;
    return el;
  };
  const ICONS = {
    terminal: ["M4 17l6-6-6-6", "M12 19h8"],
    play: ["m6 3 14 9-14 9V3z"],
    pencil: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", "m15 5 4 4"],
    trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
    folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    list: ["M8 6H21", "M8 12H21", "M8 18H21", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
    lock: ["M18 8h1a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4h1", "M7 8V6a5 5 0 0 1 10 0v2", "M12 13v4"],
    alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z", "M12 9v4", "M12 17h.01"],
    bot: ["M12 8V4H8", "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
    monitor: ["M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4"],
  };
  const api = (path) => apiUrl("/api/extensions/aiti-cmd" + path);

  // shell 实时目录查询：GET /sessions/{id}/cwd（服务端读交互 shell 进程实时 pwd）——失败
  // （win32 / 已退出 / 平台不支持）降级会话创建时 cwd。「＋ 新建」/「新 pi-web 会话」都用它，
  // 终端里 cd 过后新会话落在当前 pwd，与系统终端行为一致。
  const liveCwdOf = async (sessionId, fallbackCwd) => {
    try {
      const r = await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/cwd`)).then((x) => x.json()).catch(() => null);
      if (r && r.ok && typeof r.cwd === "string" && r.cwd) return r.cwd;
    } catch {}
    return fallbackCwd || undefined;
  };
  // 宿主新 pi-web 会话通道（AppShell 已注册 pi-web:new-session + __piWebPendingComposer 同契约）：
  // 写预填（@ 当前路径文本，与宿主 @mention 同格式：目录尾斜杠+空格，含空格路径引号包裹）→
  // 派发事件（detail.cwd = 新会话工作目录）。返回是否派发成功。
  const openNewPiSession = (cwd) => {
    if (!cwd) return false;
    const text = cwd.includes(" ") ? `@"${cwd}"/ ` : `@${cwd}/ `;
    try { window.__piWebPendingComposer = { text, at: Date.now() }; } catch {}
    try { window.dispatchEvent(new CustomEvent("pi-web:new-session", { detail: { cwd } })); } catch { return false; }
    return true;
  };

  // ---------- 订阅保活（aiti-event-bus 停推协议）----------
  // 订阅存在期间每 15s POST /alive 报活跃 type；后端 45s 未刷新即停推该 type ——
  // 页面/面板关闭后源头即断，不依赖 SSE 层丢帧。模块级集中一个 timer，
  // 各订阅点 aliveAdd/aliveDel 自己的 type；末位退订自动停表。
  const aliveTypes = new Set();
  let aliveTimer = null;
  const alivePing = () => {
    if (!aliveTypes.size) return;
    try { fetch(api("/alive"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ types: [...aliveTypes] }) }).catch(() => {}); } catch {}
  };
  const aliveAdd = (...types) => {
    let added = false;
    for (const t of types) if (!aliveTypes.has(t)) { aliveTypes.add(t); added = true; }
    if (added) alivePing(); // 新订阅立即报活（不等下个周期，后端尽快从乐观转受管）
    if (!aliveTimer) aliveTimer = setInterval(alivePing, 15000);
  };
  const aliveDel = (...types) => {
    let removed = false;
    for (const t of types) if (aliveTypes.has(t)) { aliveTypes.delete(t); removed = true; }
    if (removed) alivePing(); // 立即上报收缩后的全集（单 tab 时后端 45s 内停推被停 type）
    if (!aliveTypes.size && aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
  };

  // 链接确认浮层：点击终端里的 URL → 弹确认 → 确认后新窗口打开（noopener）
  function TermLinkConfirm({ link, onClose }) {
    if (!link) return null;
    const open = () => {
      try { window.open(link.uri, "_blank", "noopener"); } catch (e) {}
      onClose();
    };
    return h("div", {
      style: { position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
      onClick: onClose,
    },
      h("div", { style: { width: 440, maxWidth: "100%", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", padding: 14 }, onClick: (e) => e.stopPropagation() },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
          h("span", { style: { fontSize: 15, display: "inline-flex" } }, h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [h("path", { key: "p1", d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }), h("path", { key: "p2", d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" })])),
          h("b", { style: { fontSize: 14 } }, "打开链接？"),
        ),
        h("code", { style: { display: "block", fontSize: 13, color: "var(--accent)", wordBreak: "break-all", whiteSpace: "pre-wrap", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", marginBottom: 4, fontFamily: "var(--font-mono)" } }, link.uri),
        h("div", { style: { fontSize: 13, color: "var(--text-muted)", marginBottom: 10 } }, "在新窗口/新标签页中打开（外部网站）"),
        h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
          h("button", { onClick: onClose, style: { ...btnStyle, padding: "5px 16px" } }, "取消"),
          h("button", { onClick: open, style: { ...btnStyle, background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", padding: "5px 18px", fontWeight: 600 } }, "打开"),
        ),
      ),
    );
  }

  // ---------- 全局桥（pi-web core 消息点击识别 onCommand 调用） ----------
  if (typeof window !== "undefined" && !window.__aitiCmd) {
    // 打开交互 shell（§3.3 前端「打开终端」下沉后端）：POST /shell 由服务端建会话（命令文本不落前端），
    // 前端拿 sid 渲染。→ 弹出面板直达终端视图；返回 Promise<{ok, sessionId?, error?}>
    const createShell = (cwd, name) => {
      return fetch(api("/shell"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cwd || undefined, name: name || "终端" }) })
        .then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }))
        .then((r) => {
          if (!r || !r.ok || !r.sessionId) return { ok: false, error: (r && r.error) || "创建终端失败" };
          setState({ panelOpen: true, view: { kind: "pty", id: r.sessionId, title: r.name || name || "终端" }, detail: null });
          return { ok: true, sessionId: r.sessionId };
        });
    };
    // 渲染既有会话（sid 已由后端创建——ai-input suggest ⚡ / codebuddy 等消费方交 sid 过来）
    const openSession = (sessionId, title) => {
      if (!sessionId) return;
      setState({ panelOpen: true, view: { kind: "pty", id: String(sessionId), title: title || ("会话 " + String(sessionId)) }, detail: null });
    };
    window.__aitiCmd = {
      openCommand: (cmd, cwd) => { setState({ detail: { cmd: String(cmd || ""), cwd: cwd || null }, detailBusy: false }); },
      // 打开交互 bash 终端（供其他扩展调：aiti-folder/aiti-editor 顶栏终端按钮等）
      openShell: createShell,
      // 渲染既有会话（sid 已由后端创建——ai-input suggest ⚡ / codebuddy 等 services 消费方交 sid 过来）
      openSession,
    };
    // 跨扩展客户端服务出口（DI 规范 §4-A；新消费方一律走 ctx.getExtService，勿直穿 window）
    try { ctx?.registerExtService?.("aiti-cmd.open-session", openSession); } catch { /* 旧 core 无此面 */ }
    try { ctx?.registerExtService?.("aiti-cmd.open-shell", createShell); } catch { /* 旧 core 无此面 */ }
    // 独立查看窗（/viewer 里的 aiti-folder/aiti-editor）点「打开终端」无本扩展面板 →
    // postMessage 请主窗口（opener）代开；处理完回执 open-shell-result（reqId 对应）
    window.addEventListener("message", (ev) => {
      if (ev.origin !== location.origin) return;
      const m = ev.data;
      if (!m || m.source !== "aiti-ext" || m.type !== "open-shell") return;
      createShell(m.cwd, m.name).then((result) => {
        try { if (ev.source) ev.source.postMessage({ source: "aiti-cmd", type: "open-shell-result", reqId: m.reqId, ...result }, location.origin); } catch (e) { /* noop */ }
      });
    });
    // core 主窗事件通道（监听器唯一，§3.3 收拢历史上的两个重复注册）：
    // AppShell 侧栏「终端」handleOpenTerminal / TerminalPanelBridge 等派发 aiti-cmd:open-shell { cwd }
    window.addEventListener("aiti-cmd:open-shell", (ev) => {
      const cwd = ev.detail && typeof ev.detail.cwd === "string" ? ev.detail.cwd : undefined;
      if (cwd === undefined) return;
      try { createShell(cwd, ev.detail.name || "终端")?.catch?.(() => {}); } catch (e) { /* noop */ }
    });
  }

  // ---------- 消息点击识别扩展点：注册命令动作 provider 到 msg-popover-action 主题 ----------
  // （aiti-msg-smart 消费该主题：段落点击 → 调各 provider recognize → 渲染动作条。
  //  识别/校验/打开面板全在本扩展；aiti-msg-smart 未加载时本注册无害（主题注册表持久）。）
  if (typeof ctx.registerTopicItem === "function") {
    ctx.registerTopicItem("msg-popover-action", {
      id: "aiti-cmd-command",
      recognize: async (text, { cwd }) => {
        const j = await fetch(api("/commands/check"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, cwd: cwd || undefined }) })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!j || !Array.isArray(j.commands) || !j.commands.length) return [];
        return j.commands.map((c) => {
          // cd xxx && … → workdir 作为运行 cwd，action 作为命令本体（识别更准确）
          const wd = c.workdir ? `工作目录：${c.workdir}\n` : "";
          return {
            type: "command",
            id: c.cmd,
            match: c.cmd,   // 原文精确匹配文本（aiti-msg-smart hover 高亮用；label 可能被截断）
            label: c.cmd.length > 40 ? c.cmd.slice(0, 40) + "…" : c.cmd,
            danger: !!(c.danger && c.danger.length),
            unavailable: c.exists === false,
            title: wd + (c.exists === false
              ? "部分命令未安装。点击查看安装建议"
              : (c.danger && c.danger.length ? `危险命令：${c.danger.join("/")}。点击查看/收藏（不会直接执行）` : "点击查看/收藏此命令（不会直接执行）")),
            onClick: () => { setState({ detail: { cmd: c.action || c.cmd, cwd: c.workdir || cwd || null }, detailBusy: false }); },
          };
        });
      },
    });

    // ---------- 行内 code 点击识别：注册命令动作 provider 到 inline-code-action 主题 ----------
    // （aiti-msg-smart 消费：行内 <code> 点击 → 弹层含「复制」+ 各 provider 动作）
    ctx.registerTopicItem("inline-code-action", {
      id: "aiti-cmd-inline",
      recognize: async (text, { element }) => {
        if (!text || text.length > 200) return [];
        const j = await fetch(api("/commands/check"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!j || !Array.isArray(j.commands) || !j.commands.length) return [];
        const c = j.commands[0];
        const wd = c.workdir ? `工作目录：${c.workdir}\n` : "";
        return [{
          type: "command",
          id: "inline:" + c.cmd,
          label: c.cmd.length > 40 ? c.cmd.slice(0, 40) + "…" : c.cmd,
          danger: !!(c.danger && c.danger.length),
          title: wd + (c.exists === false
            ? "部分命令未安装。点击查看安装建议"
            : (c.danger && c.danger.length ? `危险命令：${c.danger.join("/")}。点击查看/收藏（不会直接执行）` : "点击查看/收藏此命令（不会直接执行）")),
          onClick: (codeText, codeEl) => { setState({ detail: { cmd: c.action || c.cmd, cwd: c.workdir || null }, detailBusy: false }); },
        }];
      },
    });
  }

  // ---------- 订阅模块状态 ----------
  function usePanelOpen() {
    const [v, setV] = useState(state.panelOpen);
    useEffect(() => { const l = () => setV(state.panelOpen); stateListeners.add(l); return () => stateListeners.delete(l); }, []);
    return v;
  }
  function useView() {
    const [v, setV] = useState(state.view);
    useEffect(() => { const l = () => setV(state.view); stateListeners.add(l); return () => stateListeners.delete(l); }, []);
    return v;
  }
  function useDetail() {
    const [v, setV] = useState(state.detail);
    useEffect(() => { const l = () => setV(state.detail); stateListeners.add(l); return () => stateListeners.delete(l); }, []);
    return v;
  }
  function useDetailBusy() {
    const [v, setV] = useState(state.detailBusy);
    useEffect(() => { const l = () => setV(state.detailBusy); stateListeners.add(l); return () => stateListeners.delete(l); }, []);
    return v;
  }

  // ---------- 真终端组件（xterm.js + SSE 下行 + POST 上行） ----------
  // 窗口大小：fit=自适应容器（默认）；其余固定 列×行（同常规终端窗口，小屏滚动看全貌）。
  // 全屏 / 虚拟键盘 / 帮助 / 滚动：见下方工具按钮与键盘区。
  // pullBack：页签模式的「⇲ 拉回窗口」（弹窗模式不传不渲染）；onNewShell：「＋ 新建」用
  // 当前终端会话实时 cwd 再开 shell（页签模式开新页签；弹窗模式新建会话并切过去）；
  // onNewPiSession：「💬 新会话」新建 pi-web 会话并 @ 当前终端实时路径。
  function TerminalView({ sessionId, onExit, height, counts, pullBack, onNewShell, onNewPiSession, sendToTab, killPending }) {
    const isZh = useIsZh();
    const ref = useRef(null);
    const [status, setStatus] = useState("connecting");
    const [meta, setMeta] = useState(null);
    const [exitInfo, setExitInfo] = useState(null);
    const [linkConfirm, setLinkConfirm] = useState(null); // {uri} —— 终端 URL 点击确认
    const termRef = useRef(null);
    const fitRef = useRef(null);
    // 窗口大小 / 全屏 / 虚拟键盘 / 帮助（大小与键盘开关偏好持久化 localStorage）
    const [sizeId, setSizeId] = useState(() => lsGet(LS_TERM_SIZE, "fit"));
    const [fullscreen, setFullscreen] = useState(false);
    const [kbdOpen, setKbdOpen] = useState(() => lsGet(LS_TERM_KBD, false));
    const [helpOpen, setHelpOpen] = useState(false);
    const [ctrlLock, setCtrlLock] = useState(false);
    const [altLock, setAltLock] = useState(false);
    const [shiftLock, setShiftLock] = useState(false);
    const [winLock, setWinLock] = useState(false);
    const [kbdMode, setKbdMode] = useState("common"); // common=常用键 / full=全键盘（字母+数字+符号）
    const sizeRef = useRef(sizeId);
    sizeRef.current = sizeId;
    // 小屏检测：宽度断点 max-width: 640px（小屏/大屏布局只看宽度；输入法弹起等只改高度，不应翻转布局）
    const [isSmall, setIsSmall] = useState(() => typeof window !== "undefined" && (window.matchMedia ? (window.matchMedia("(max-width: 640px)").matches) : false));
    useEffect(() => {
      if (typeof window === "undefined" || !window.matchMedia) return;
      const mq = window.matchMedia("(max-width: 640px)");
      const onChange = () => setIsSmall(mq.matches);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }, []);

    // 虚拟键盘 / 快捷键直接向 PTY 发字节（不经 DOM 键盘；xterm 缓冲区由服务端回显保持同步）
    const sendKey = (data) => {
      const sid = sessionId;
      try { fetch(api(`/sessions/${sid}/input`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) }).catch(() => {}); } catch {}
    };
    // 固定尺寸超出容器时跟随最新输出（用户上翻阅读时不打扰）
    const maybeAutoScroll = () => {
      const c = ref.current;
      if (!c || sizeRef.current === "fit") return;
      if (c.scrollHeight - c.scrollTop - c.clientHeight < 40) c.scrollTop = c.scrollHeight;
    };
    const scrollBottom = () => {
      try { const c = ref.current; if (c) c.scrollTop = c.scrollHeight; } catch {}
      try { termRef.current?.scrollToBottom(); } catch {}
    };
    const applySize = () => {
      const term = termRef.current;
      if (!term) return;
      const p = TERM_SIZES.find((s) => s.id === sizeRef.current) || TERM_SIZES[0];
      if (!p.cols) { try { fitRef.current?.fit(); } catch {} }
      else { try { term.resize(p.cols, p.rows); } catch {} } // onResize 自动同步到服务端 PTY
    };
    const cycleSize = () => setSizeId((prev) => {
      const ids = TERM_SIZES.map((s) => s.id);
      const next = ids[(ids.indexOf(prev) + 1) % ids.length];
      lsSet(LS_TERM_SIZE, next);
      return next;
    });
    const toggleKbd = () => setKbdOpen((x) => { lsSet(LS_TERM_KBD, !x); return !x; });

    useEffect(() => {
      if (!ref.current) return;
      const term = new Terminal({ fontFamily: TERM_FONT, fontSize: 13, scrollback: 1000, cursorBlink: true, convertEol: false, rendererType: "dom", theme: TERM_THEME });
      // rendererType:"dom"：xterm 6 默认在支持 WebGL 的环境（如 Edge）走 WebGL renderer——
      // 部分 GPU/驱动下 WebGL 渲染异常导致输入/输出实时不可见（关闭重开重放才显示）；
      // DOM renderer 最稳定，无 GPU 依赖。
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      termRef.current = term;
      fitRef.current = fit;
      try { applySize(); } catch {}
      term.focus();
      // 链接识别：URL 可点击 → 确认浮层 → 新窗口打开
      const linkDisp = installTermLinkProvider(term, (uri) => setLinkConfirm({ uri }));
      const sid = sessionId;
      let disposed = false; // effect 卸载标记：总线 ready/快照异步回来后不再碰已释放的 term
      const send = (path, body) => {
        try { fetch(api(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}); } catch {}
      };
      term.onData((data) => send(`/sessions/${sid}/input`, { data }));
      term.onResize(({ cols, rows }) => send(`/sessions/${sid}/resize`, { cols, rows }));
      // 复制/粘贴：右键=复制选区、Ctrl+Shift+C / Ctrl+Insert 复制、Ctrl+Shift+V / Shift+Insert 粘贴
      const pasteClip = () => { try { navigator.clipboard?.readText?.().then((t) => { if (t) send(`/sessions/${sid}/input`, { data: t }); }).catch(() => {}); } catch {} };
      const clip = installTermClipboard(term, ref.current, pasteClip);
      // 应用内快捷键（终端聚焦时）：Ctrl+Shift+F 全屏 / Ctrl+Shift+K 虚拟键盘 / Ctrl+Shift+S 循环尺寸
      // Esc：虚拟键盘打开时关键盘（不抢终端原生 Esc 行为——只在 kbdOpen 状态接才安全）
      term.attachCustomKeyEventHandler((ev) => {
        if (clip.handleKey(ev)) return false; // 复制/粘贴快捷键（已 preventDefault）
        if (ev.type === "keydown" && ev.ctrlKey && ev.shiftKey) {
          const k = (ev.key || "").toLowerCase();
          if (k === "f") { ev.preventDefault(); setFullscreen((x) => !x); return false; }
          if (k === "k") { ev.preventDefault(); toggleKbd(); return false; }
          if (k === "s") { ev.preventDefault(); cycleSize(); return false; }
        }
        if (ev.type === "keydown" && ev.key === "Escape" && kbdOpen) {
          ev.preventDefault(); toggleKbd(); return false;
        }
        return true;
      });
      // ---------- 下行：aiti-event-bus 主题订阅（cmd-<sid>）唯一通道（2026-09-09 拍板，禁止兑底） ----------
      // 实时小帧走总线；初始回放（ring 可达 1MB 大消息）不走总线——订阅生效后 REST 拉
      // /sessions/{id}/buffered 快照，reset 重放 + seq 去重，与实时流无缝衔接；
      // 断线重连（up）后重拉快照补丢失段。topics 缺席 → 无实时流（状态条提示）。
      let busOff = null;
      let seenSeq = -1;
      let exited = false;
      let everDown = false;
      // 结束横幅：醒目底色块行（被终止红底 / 非零退出黄底 / 正常结束绿底）——幂等，重放 reset 后可重写
      const writeExitBanner = (m) => {
        const tail = `退出码 ${m.code ?? "?"}${m.signal ? " · " + m.signal : ""} · 耗时 ${((m.durationMs || 0) / 1000).toFixed(1)}s${m.truncated ? " · 输出已截断" : ""}`;
        if (m.signal) term.write(`\r\n\x1b[41;97m ⏹ 会话已停止（被 ${m.signal} 终止） · ${tail} \x1b[0m\r\n`);
        else if ((m.code ?? 0) !== 0) term.write(`\r\n\x1b[43;30m ⚠ 会话已结束 · ${tail} \x1b[0m\r\n`);
        else term.write(`\r\n\x1b[42;30m ✓ 会话已结束 · ${tail} \x1b[0m\r\n`);
      };
      const hideCursor = () => { try { term.options.cursorBlink = false; term.write("\x1b[?25l"); } catch {} }; // 已结束：隐藏光标+停闪，避免看起来还能输入
      const applyExit = (m, opts) => {
        if (exited) { if (opts?.rewrite) writeExitBanner(m); return; } // 已处理过：仅重放补横幅（reset 清掉了上一份）
        exited = true;
        setStatus("exit"); setExitInfo({ code: m.code, signal: m.signal, durationMs: m.durationMs, truncated: m.truncated });
        hideCursor();
        writeExitBanner(m);
        busOff?.(); busOff = null; aliveDel("cmd-" + sid); // 已结束：退订实时流+停保活（死会话无帧可推）
        if (onExit) onExit(m);
      };
      const applyFrame = (m) => {
        if (m.evt === "started") { setStatus("running"); setMeta(m); }
        else if (m.evt === "queued") { setStatus("queued"); setMeta(m); } // 排队中（超并发上限 FIFO）：等待自动启动
        else if (m.evt === "pid") { setMeta((prev) => ({ ...(prev || {}), pid: m.pid })); }
        else if (m.evt === "data") {
          if (exited) return; // 已结束不再吃数据帧：防状态回退/光标复活
          if (typeof m.seq === "number") { if (m.seq <= seenSeq) return; seenSeq = m.seq; }
          term.write(m.data); try { term.scrollToBottom(); } catch {} maybeAutoScroll(); setStatus("running");
        }
        else if (m.evt === "exit") applyExit(m);
      };
      const applySnapshot = (d) => {
        if (!d || !d.ok) return;
        // reset 清掉可能已先到的实时帧（订阅生效→快照响应之间的重叠段），
        // 全量重写 ring 后以快照 seq 为去重基线——无缝无重复
        if (d.status === "queued") setStatus("queued"); else if (!exited) setStatus(d.status === "exit" ? "exit" : "running");
        setMeta({ sessionId: sid, pid: d.pid, cmd: d.cmd, cwd: d.cwd });
        try { term.reset(); } catch {}
        for (const c of d.chunks || []) { term.write(c.data); if (typeof c.seq === "number" && c.seq > seenSeq) seenSeq = c.seq; }
        if (typeof d.seq === "number" && d.seq > seenSeq) seenSeq = d.seq;
        if (d.status === "exit") applyExit({ code: d.exitCode, signal: d.signal, durationMs: d.durationMs, truncated: d.truncated }, { rewrite: true });
        else { try { term.scrollToBottom(); } catch {} }
      };
      // 订阅实时流（活会话专用）：订阅生效（ready）后才拉全量快照——订阅生效点早于快照内容
      // 截至点，重叠段由 seq 去重（applyFrame 丢弃 seq<=seenSeq）→ 零间隙；全量快照恰好一次
      const setupLive = () => {
        if (exited || disposed) return;
        const topicsSub = ctx?.getExtService?.("aiti-event-bus.subscribe-topics");
        if (!topicsSub) return;
        const pullSnap = () => { fetch(api(`/sessions/${sid}/buffered`)).then((r) => r.json()).then((d) => { if (!disposed) applySnapshot(d); }).catch(() => {}); };
        const sub = topicsSub(applyFrame, ["cmd-" + sid], (s) => {
          if (s === "reconnecting") { everDown = true; setStatus("reconnecting"); }
          else if (s === "down") { everDown = true; }
          else if (s === "up") {
            setStatus((prev) => (prev === "reconnecting" ? "running" : prev));
            if (everDown && !exited) {
              everDown = false;
              pullSnap(); // 重连补丢失段（全量重放 + seq 去重，幂等）
            }
          }
        });
        busOff = () => { try { sub.off(); } catch {} };
        aliveAdd("cmd-" + sid); // 订阅保活：报活期后端才继续推该终端（45s 无心跳停推）
        sub.ready.then(pullSnap).catch(() => {
          // 总线不可达：退而求其次拉一次快照（无实时流，内容仍可见；状态条已由 onStatus 提示）
          pullSnap();
        });
      };
      // 初始化：轻量状态查询先行（GET /sessions/{id} 无 chunks，毫秒级）——
      // exit 定案：只拉一次全量快照，不订阅不保活（死会话零 SSE 开销）；
      // running/queued：订阅先行零间隙，ready 后拉一次全量快照；
      // 查询失败（网络闪断）保守走活会话路径——宁可多订不可瞎等
      fetch(api(`/sessions/${sid}`)).then((r) => r.json()).then((info) => {
        if (disposed) return;
        if (info && info.ok) {
          if (info.status === "exit") {
            setMeta({ sessionId: sid, cmd: info.cmd, cwd: info.cwd });
            setStatus("exit");
            fetch(api(`/sessions/${sid}/buffered`)).then((r) => r.json()).then((d) => { if (!disposed) applySnapshot(d); }).catch(() => {});
            return;
          }
          setMeta((prev) => ({ ...(prev || {}), sessionId: sid, cmd: info.cmd, cwd: info.cwd }));
        }
        setupLive();
      }).catch(() => setupLive());
      // 自适应模式下容器变化才 refit；固定尺寸模式不 refit（保持标准列×行，由外层滚动）
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { try { if (sizeRef.current === "fit") fit.fit(); } catch {} }) : null;
      if (ro) ro.observe(ref.current);
      // xterm 6 无原生触摸滚动，在终端容器层补偿：touch → term.scrollLines + 简单惯性
      const touchState = { active: false, lastY: 0, lastTime: 0, velocity: 0, inertia: null };
      const endTouch = () => {
        touchState.active = false;
        document.removeEventListener("touchmove", onTouchMove, { passive: false });
        document.removeEventListener("touchend", onTouchEnd);
        document.removeEventListener("touchcancel", onTouchEnd);
      };
      const onTouchStart = (e) => {
        if (e.touches.length !== 1) { touchState.active = false; return; }
        touchState.active = true;
        touchState.lastY = e.touches[0].clientY;
        touchState.lastTime = Date.now();
        touchState.velocity = 0;
        if (touchState.inertia) { cancelAnimationFrame(touchState.inertia); touchState.inertia = null; }
        document.addEventListener("touchmove", onTouchMove, { passive: false });
        document.addEventListener("touchend", onTouchEnd);
        document.addEventListener("touchcancel", onTouchEnd);
      };
      const onTouchMove = (e) => {
        if (!touchState.active || e.touches.length !== 1) { endTouch(); return; }
        const currentY = e.touches[0].clientY;
        const currentTime = Date.now();
        const deltaY = currentY - touchState.lastY;
        const dt = currentTime - touchState.lastTime;
        if (dt > 0) touchState.velocity = deltaY / dt;
        const t = termRef.current;
        if (t) {
          const rowHeight = t._core?._renderService?.dimensions?.css?.cell?.height || (ref.current?.clientHeight / (t.rows || 1));
          const lines = Math.round(deltaY / rowHeight);
          if (lines) try { t.scrollLines(lines); } catch {}
        }
        touchState.lastY = currentY;
        touchState.lastTime = currentTime;
        e.preventDefault();
      };
      const onTouchEnd = () => {
        const wasActive = touchState.active;
        endTouch();
        if (!wasActive) return;
        const v = touchState.velocity;
        if (Math.abs(v) > 0.15) {
          let velocity = v;
          const step = () => {
            velocity *= 0.92;
            if (Math.abs(velocity) < 0.05) { touchState.inertia = null; return; }
            const t = termRef.current;
            if (t) {
              const rowHeight = t._core?._renderService?.dimensions?.css?.cell?.height || (ref.current?.clientHeight / (t.rows || 1));
              const lines = Math.round(velocity * 16 / rowHeight);
              if (lines) try { t.scrollLines(lines); } catch {}
            }
            touchState.inertia = requestAnimationFrame(step);
          };
          touchState.inertia = requestAnimationFrame(step);
        }
      };
      if (ref.current) ref.current.addEventListener("touchstart", onTouchStart, { passive: false });
      return () => {
        disposed = true;
        busOff?.();
        aliveDel("cmd-" + sid);
        linkDisp?.dispose?.();
        clip.dispose();
        ro?.disconnect();
        term.dispose();
        termRef.current = null;
        endTouch();
        if (touchState.inertia) cancelAnimationFrame(touchState.inertia);
        ref.current?.removeEventListener("touchstart", onTouchStart, { passive: false });
      };
    }, [sessionId]);
    // 窗口大小切换：fit → 重新适配容器；固定尺寸 → term.resize（onResize 自动同步到服务端 PTY）
    useEffect(applySize, [sizeId]);
    const miniBtn = { ...btnStyle, padding: "2px 8px", fontSize: 13 };
    const selStyle = { ...inputStyle, flex: "none", width: "auto", fontSize: 13, padding: "1px 8px" };
    // 虚拟键盘按键渲染（常用键 / 全键盘共用）：Ctrl/Alt 锁 + 字母键发组合，Ctrl 锁 + 方向键发按词移动
    const renderKey = (k, i) => {
      const active = (k.mod === "ctrl" && ctrlLock) || (k.mod === "alt" && altLock) || (k.mod === "shift" && shiftLock) || (k.mod === "win" && winLock);
      const press = () => {
        if (k.mod === "ctrl") { setCtrlLock((x) => { if (!x) { setAltLock(false); setWinLock(false); } return !x; }); return; }
        if (k.mod === "alt") { setAltLock((x) => { if (!x) { setCtrlLock(false); setWinLock(false); } return !x; }); return; }
        if (k.mod === "shift") { setShiftLock((x) => !x); return; }
        if (k.mod === "win") { setWinLock((x) => { if (!x) setAltLock(false); return !x; }); return; }
        let seq = k.seq;
        // 修改键优先级：Ctrl（字节组合）> SHIFT（字母大写/数字上档）> ALT/WIN（ESC 前缀 Meta）
        if (k.txt) {
          if (ctrlLock && /^[a-zA-Z]$/.test(k.txt)) { seq = String.fromCharCode(k.txt.toLowerCase().charCodeAt(0) - 96); setCtrlLock(false); setShiftLock(false); }
          else if (shiftLock && /^[a-z]$/.test(k.txt)) { seq = k.txt.toUpperCase(); setShiftLock(false); }
          else if (shiftLock && SHIFTED[k.txt]) { seq = SHIFTED[k.txt]; setShiftLock(false); }
          else if (altLock) { seq = "\x1b" + k.txt; setAltLock(false); }
          else if (winLock) { seq = "\x1b" + k.txt; setWinLock(false); }
          else seq = k.txt;
          if (shiftLock && seq === k.txt) setShiftLock(false); // 未映射符号/空格：吞锁防粘连
        }
        // 方向键 × 修改键 → xterm 标准组合序列（mod：2=Shift 3=Alt 5=Ctrl 6=Shift+Ctrl；
        // 以往 ALT+方向键只发裸箭头——程序无法区分是否带 Alt，这里补上）
        if (seq && /^\x1b\[[ABCD]$/.test(seq)) {
          const mod = (ctrlLock && shiftLock) ? 6 : ctrlLock ? 5 : shiftLock ? 2 : (altLock || winLock) ? 3 : 0;
          if (mod) { seq = "\x1b[1;" + mod + seq.slice(-1); setCtrlLock(false); setShiftLock(false); setAltLock(false); setWinLock(false); }
        }
        // F1-F12 × 修改键 → xterm 带修饰序列（F1-F4 SS3 \x1bOP → CSI \x1b[1;2P；F5-F12 \x1b[15~ → \x1b[15;5~）；
        // 无修饰时保持裸序列（SS3 / CSI），与 xterm.js 物理键盘输出一致；
        // 数字限定 F 键（15/17/18/19/20/21/23/24）——不误伤 PGUP/PGDN（\x1b[5~/\x1b[6~）等 CSI ~ 键
        if (seq && /^\x1b(O[PQRS]|\[(?:15|17|18|19|20|21|23|24)~)$/.test(seq)) {
          const mod = (ctrlLock && shiftLock) ? 6 : ctrlLock ? 5 : shiftLock ? 2 : (altLock || winLock) ? 3 : 0;
          if (mod) {
            seq = seq[1] === "O" ? "\x1b[1;" + mod + seq[2] : seq.slice(0, -1) + ";" + mod + "~";
            setCtrlLock(false); setShiftLock(false); setAltLock(false); setWinLock(false);
          }
        }
        sendKey(seq);
      };
      return h("button", {
        key: i,
        onPointerDown: (e) => { e.preventDefault(); press(); }, // pointerdown+preventDefault：不抢终端焦点，点键不发移动端输入法
        title: k.mod ? (k.mod === "ctrl" ? "Ctrl 锁：点一次锁定，再按字母键发 Ctrl+字母、按方向键发 Ctrl+方向（按词移动）" : k.mod === "alt" ? "Alt 锁：点一次锁定，再按字母/符号键发 Alt+键（ESC 前缀）、按方向键发 Alt+方向" : k.mod === "shift" ? "SHIFT 锁：点一次锁定，再按字母=大写（如 grep -E）、数字=上档符号、方向键=Shift+方向（选择）" : k.mod === "win" ? "WIN/Meta 锁：点一次锁定，再按键=ESC 前缀（终端 Meta 键，同 ALT 语义；部分程序区分绑定）" : "") : (k.c || ""),
        style: { minWidth: 34, height: 30, borderRadius: 6, border: "1px solid " + (active ? "var(--accent)" : "var(--border)"), background: active ? "var(--accent)" : "var(--bg-hover)", color: active ? "#fff" : "var(--text)", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "0 6px", fontFamily: "inherit", flexShrink: 0 },
      }, k.k);
    };
    // 虚拟键盘：两档切换（⌨ 常用 = 方向/编辑/Ctrl 组合；ABC 全键 = 完整字母数字符号，Ctrl 锁直接可用）
    const kbdRows = kbdMode === "full" ? KEYPAD_FULL_ROWS : KEYPAD_ROWS;
    const keypad = h("div", { style: { flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, maxHeight: "48%", overflowY: "auto" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 } },
        h("button", { onClick: () => setKbdMode("common"), title: "常用键：方向 / 编辑 / Ctrl 组合 / 常用符号", style: { ...miniBtn, fontSize: 12, padding: "1px 8px", background: kbdMode === "common" ? "var(--accent)" : "transparent", color: kbdMode === "common" ? "#fff" : "var(--text-muted)", border: "1px solid " + (kbdMode === "common" ? "var(--accent)" : "var(--border)") } }, "常用"),
        h("button", { onClick: () => setKbdMode("full"), title: "全键盘：字母 / 数字 / 符号 / 空格 —— Ctrl 锁 + 字母键 = Ctrl+字母", style: { ...miniBtn, fontSize: 12, padding: "1px 8px", background: kbdMode === "full" ? "var(--accent)" : "transparent", color: kbdMode === "full" ? "#fff" : "var(--text-muted)", border: "1px solid " + (kbdMode === "full" ? "var(--accent)" : "var(--border)") } }, "ABC 全键"),
        h("span", { style: { ...smallStyle, marginLeft: "auto", fontSize: 12, whiteSpace: "nowrap" } }, kbdMode === "full" ? "CTRL/SHIFT/ALT/WIN 锁 + 键 = 组合键" : "参考 Termux extra-keys"),
        // 关闭按钮：常显（即使开键盘就忘的人也一眼能看到），快捷键 Esc + 顶栏 ⌨ 同步切换；
        // aria-label 用「收起」而非「关闭」：ai-helper 弹窗 🤖 扫描器按 aria-label*=「关闭」找弹窗关闭按钮，
        // 这里若叫「关闭…」会被当成弹窗关闭按钮误挂 🤖（它只是键盘面板的开关）
        h("button", { onClick: toggleKbd, title: "关闭虚拟键盘 (Esc)", "aria-label": "收起虚拟键盘", style: { ...miniBtn, fontSize: 13, padding: "0 8px", height: 22, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 3 } }, "×", h("span", { style: { fontSize: 12 } }, "关闭")),
      ),
      kbdRows.map((row, ri) => h("div", { key: ri, style: { display: "flex", flexWrap: "wrap", gap: 3 } },
        row.map((k, i) => renderKey(k, i)),
      )),
    );
    // 常用快捷键帮助（参考小屏终端：Termux / JuiceSSH / ConnectBot 常见键位）+ 工具条按钮说明
    // （触屏没有 hover，title 看不见 —— 按钮含义集中在这里查，不给顶栏按钮加会变字的标签）
    const help = h("div", { style: { flexShrink: 0, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", maxHeight: "45%", overflowY: "auto", fontSize: 13 } },
      h("div", { style: { fontWeight: 700, marginBottom: 6 } }, "常用快捷键"),
      h("table", { style: { borderCollapse: "collapse", width: "100%" } },
        h("tbody", {},
          TERM_SHORTCUTS.map((pair) =>
            h("tr", { key: pair[0] },
              h("td", { style: { padding: "2px 10px 2px 0", whiteSpace: "nowrap", color: "var(--accent)", fontWeight: 600 } }, pair[0]),
              h("td", { style: { padding: "2px 0", color: "var(--text-muted)" } }, pair[1]),
            )),
        ),
      ),
      h("div", { style: { marginTop: 6, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 } }, "虚拟键盘有「⌨ 常用 / ABC 全键」两档：常用 = 方向/编辑/Ctrl 组合；全键 = 完整字母数字符号键盘（含空格，可输入命令全文）。CTRL/SHIFT/ALT/WIN 四把锁，点一次锁定、再按任意键自动解锁（与物理键盘同感）：CTRL 锁 + 字母 = Ctrl+字母（如 a→Ctrl+A 行首）、+ 方向键 = 按词移动（readline）；SHIFT 锁 + 字母 = 大写（grep -E 必需）、+ 数字 = 上档符号、+ 方向键 = Shift+方向（选择）；ALT/WIN 锁 + 字母/符号 = ESC 前缀（Meta 键），+ 方向键 = Alt+方向（xterm \x1b[1;3x 序列，程序可区分是否带 Alt）。注意：终端转义协议不区分左右 Shift/Alt（只有 GUI 程序能区分），所以只有一把 SHIFT/ALT 锁。终端聚焦时 Ctrl+Shift+F 全屏、Ctrl+Shift+K 键盘、Ctrl+Shift+S 循环窗口大小。"),
      h("div", { style: { fontWeight: 700, margin: "8px 0 4px", borderTop: "1px solid var(--border)", paddingTop: 8 } }, "工具条按钮"),
      h("table", { style: { borderCollapse: "collapse", width: "100%" } },
        h("tbody", {},
          TOOLBAR_LEGEND(isZh).map((pair) =>
            h("tr", { key: pair[0] },
              h("td", { style: { padding: "2px 10px 2px 0", whiteSpace: "nowrap", color: "var(--accent)", fontWeight: 600, textAlign: "center", width: 56 } }, pair[0]),
              h("td", { style: { padding: "2px 0", color: "var(--text-muted)" } }, pair[1]),
            )),
        ),
      ),
    );
    const isFit = sizeId === "fit";
    return h("div", { style: fullscreen
      ? { position: "fixed", inset: 0, zIndex: 500, background: "var(--bg-panel)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4, boxSizing: "border-box" }
      : { display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 } },
      h("div", { style: { ...smallStyle, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
        // 顶部状态：exit 用醒目底色 badge（被终止红 / 非零黄 / 正常绿），其余纯色文字
        status === "exit" ? h("span", { style: { display: "inline-flex", alignItems: "center", flexShrink: 0, padding: "1px 8px", borderRadius: 6, fontWeight: 700, fontSize: 11, lineHeight: "16px", color: exitInfo?.signal ? "#fff" : exitInfo && (exitInfo.code ?? 0) !== 0 ? "var(--warn, #facc15)" : "var(--ok, #4ade80)", background: exitInfo?.signal ? "var(--danger, #ef4444)" : exitInfo && (exitInfo.code ?? 0) !== 0 ? "color-mix(in srgb, var(--warn, #facc15) 22%, transparent)" : "color-mix(in srgb, var(--ok, #4ade80) 18%, transparent)" } },
          isSmall
            ? (exitInfo?.signal ? "已停止" : exitInfo && (exitInfo.code ?? 0) !== 0 ? "已结束" : "已结束")
            : (exitInfo?.signal ? "会话已停止（被 " + exitInfo.signal + " 终止）" : exitInfo && (exitInfo.code ?? 0) !== 0 ? "会话已结束（退出码 " + exitInfo.code + "）" : "会话已结束"))
        : h("span", { style: { color: status === "running" ? (killPending ? "var(--warn, #f59e0b)" : "var(--ok, #4ade80)") : "var(--text)" } },
          isSmall
            ? (killPending ? "⏳" : status === "running" ? "●" : status === "queued" ? "⏳" : status === "replaying" ? "⟳" : status === "reconnecting" ? "⚠" : "…")
            : (killPending && status === "running" ? "终止中（已发 SIGTERM，最多 3s 后强制 KILL）" : status === "running" ? "● 运行中" : status === "queued" ? "排队中（等待并发空位）" : status === "replaying" ? "⟳ 回放中" : status === "reconnecting" ? "连接中断，重连中…" : "… 连接中")),
        meta && !isSmall && h("span", { title: meta.cwd, style: { fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1 } }, "📁 " + (meta.cwd || "")),
        meta && !isSmall && h("code", { style: { ...smallStyle, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 2 } }, "$ " + String(meta.cmd).slice(0, 60)),
        // 窗口大小（自适应 / 固定标准尺寸）：小屏也显示（用户要求可见；窄屏下 label 较短占用有限），Ctrl+Shift+S 仍可循环
        h("select", { value: sizeId, onChange: (e) => { const v = e.target.value; setSizeId(v); lsSet(LS_TERM_SIZE, v); }, style: selStyle, title: "终端窗口大小（列×行）：自适应容器，或固定标准尺寸——小屏也能看到完整终端，超出可滚动" },
          TERM_SIZES.map((s) => h("option", { key: s.id, value: s.id }, s.label)),
        ),
        h("button", { onClick: scrollBottom, title: "滚动到底部", "aria-label": "滚动到底部", style: miniBtn }, isZh ? "↓底" : "⇊"),
        h("button", { onClick: toggleKbd, title: "虚拟键盘：方向键 / Tab / Esc / Ctrl / 常用符号 (Ctrl+Shift+K)", "aria-label": "虚拟键盘", style: { ...miniBtn, background: kbdOpen ? "var(--accent)" : undefined, color: kbdOpen ? "#fff" : undefined } }, "⌨"),
        h("button", { onClick: () => setHelpOpen((x) => !x), title: "常用快捷键帮助", "aria-label": "常用快捷键帮助", style: { ...miniBtn, background: helpOpen ? "var(--accent)" : undefined, color: helpOpen ? "#fff" : undefined } }, "?"),
        // 页签模式操作区（顺序：＋ 新建 · ⇲ 拉回窗口 · ⛶ 最大化）；弹窗模式不传不渲染；
        // 弹窗模式传 sendToTab（⇱ 转到页签：终端移到文件区工作区终端页签）
        sendToTab && h("button", { onClick: sendToTab, title: "转到页签：终端移到右侧文件区的工作区终端页签（弹窗内变占位）", "aria-label": "转到工作区页签", style: miniBtn }, isSmall ? "⇱" : "⇱ 转到页签"),
        onNewShell && h("button", { onClick: onNewShell, title: "新建：再开一个 shell（目录 = 当前终端 📁 实时路径）", "aria-label": "新建 shell", style: miniBtn }, isSmall ? "＋" : "＋ 新建"),
        onNewPiSession && h("button", { onClick: onNewPiSession, title: "新建 pi-web 会话：打开新 agent 会话并 @ 当前终端实时路径", "aria-label": "新建 pi-web 会话", style: miniBtn }, isSmall ? "💬" : "新会话"),
        pullBack && h("button", { onClick: pullBack, title: "拉回窗口：终端视图移回 aiti-cmd 弹窗（页签显示占位）", "aria-label": "拉回窗口", style: miniBtn }, isSmall ? "⇲" : "⇲ 拉回窗口"),
        // 最大化/还原 放最末：与 aiti-float 自动注入的 ⛶/❐ 同位（关闭按钮之前），习惯后置
        h("button", { onClick: () => setFullscreen((x) => !x), title: "全屏 / 退出全屏 (Ctrl+Shift+F)", "aria-label": "全屏", style: { ...miniBtn, background: fullscreen ? "var(--accent)" : undefined, color: fullscreen ? "#fff" : undefined } }, fullscreen ? "⤡" : "⛶"),
        exitInfo && h("span", { style: { fontWeight: 700, color: exitInfo.signal ? "var(--danger, #ef4444)" : (exitInfo.code ?? 0) !== 0 ? "#b45309" : "var(--text-muted)" } }, `退出码 ${exitInfo.code ?? "?"}${exitInfo.signal ? " · " + exitInfo.signal : ""} · ${((exitInfo.durationMs || 0) / 1000).toFixed(1)}s`),
      ),
      h("div", { ref, style: { flex: 1, minHeight: 0, background: "#0f172a", borderRadius: 8, padding: 6, overflow: isFit ? "hidden" : "auto", touchAction: "none" } }),
      // 小屏底部状态栏：顶部简化后 cwd/命令全不可见——底部放一份；统计计数（🤖 agent / 🖥 终端）也下沉到这里
      isSmall && meta && h("div", { style: { flexShrink: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)", padding: "4px 6px 0", overflow: "hidden", minHeight: 0, whiteSpace: "nowrap" } },
        counts && h("span", { title: "当前：🤖 agent 在跑 / 🖥 终端在跑", style: { flexShrink: 0 } }, "🤖" + counts.piRunning + "/" + counts.piTotal + " 🖥" + counts.ptyRunning),
        meta.cwd && h("span", { title: "工作目录", style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 } }, "📁 " + meta.cwd),
        h("code", { title: String(meta.cmd), style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 2, color: "var(--text)" } }, "$ " + String(meta.cmd).slice(0, 60)),
      ),
      kbdOpen && keypad,
      helpOpen && help,
      h(TermLinkConfirm, { link: linkConfirm, onClose: () => setLinkConfirm(null) }),
    );
  }

  // ---------- agent 运行中命令视图（只读 xterm + SSE diff 协议 data/replace） ----------
  function PiCommandView({ cmdId, counts }) {
    const isZh = useIsZh();
    const ref = useRef(null);
    const [status, setStatus] = useState("connecting");
    const [meta, setMeta] = useState(null);
    const [exitInfo, setExitInfo] = useState(null);
    const [hasSel, setHasSel] = useState(false);
    const [linkConfirm, setLinkConfirm] = useState(null); // {uri} —— 终端 URL 点击确认
    const termRef = useRef(null);
    const [killBusy, setKillBusy] = useState(false); // 终止中（点击即反馈，防重复点）
    const [fs, setFs] = useState(false); // 全屏
    // 小屏检测：宽度断点 max-width: 640px（高度变化如输入法弹起不翻转布局）
    const [isSmall, setIsSmall] = useState(() => typeof window !== "undefined" && (window.matchMedia ? (window.matchMedia("(max-width: 640px)").matches) : false));
    useEffect(() => {
      if (typeof window === "undefined" || !window.matchMedia) return;
      const mq = window.matchMedia("(max-width: 640px)");
      const onChange = () => setIsSmall(mq.matches);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }, []);
    useEffect(() => {
      if (!ref.current) return;
      // 只读终端：agent 的 bash 无 stdin，不接 onData；disableStdin 防止抢焦点
      const term = new Terminal({ fontFamily: TERM_FONT, fontSize: 13, scrollback: 2000, convertEol: false, rendererType: "dom", cursorBlink: false, disableStdin: true, theme: TERM_THEME });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      termRef.current = term;
      try { fit.fit(); } catch {}
      // 链接识别：URL 可点击 → 确认浮层 → 新窗口打开
      const linkDisp = installTermLinkProvider(term, (uri) => setLinkConfirm({ uri }));
      // ---------- 下行：aiti-event-bus 主题订阅（cmd-<cmdId>）唯一通道（2026-09-09 拍板，禁止兑底） ----------
      // 初始全量 text（≤512KB 大消息）不走总线：订阅生效后 REST 拉 /pi-commands/{id}
      // 快照（text=已发布基线 + seq），reset 重写 + seq 去重与实时增量帧无缝衔接。
      let busOff = null;
      let seenSeq = -1;
      let exited = false;
      let everDown = false;
      let disposed = false;
      let currentCmd = "";
      let headerWritten = false;
      // 命令头幂等写入：xterm 的 write 是异步队列、reset 是同步清屏——若 started 和 replace
      // 各写一次，第一次的写入还在队列里，reset 清不掉，会渲染出两遍命令头；改为仅在
      // 真正写输出前懒写一次，replace 重放时重置标志重建。
      const ensureHeader = () => { if (!headerWritten) { headerWritten = true; try { term.write(`\x1b[94m$ ${currentCmd || "（订阅前已开始）"}\x1b[0m\r\n`); } catch {} } };
      // 结束横幅：醒目底色块行（被终止/出错红底 / 正常绿底），替代旧灰色小字；快照重放后也补写
      const writeExitBanner = (m) => {
        const tail = `耗时 ${((m.durationMs || 0) / 1000).toFixed(1)}s${m.truncated ? " · 输出已截断" : ""}`;
        if (m.isError) term.write(`\r\n\x1b[41;97m ⏹ 命令已停止（出错/被终止） · ${tail} \x1b[0m\r\n`);
        else term.write(`\r\n\x1b[42;30m ✓ 命令已完成 · ${tail} \x1b[0m\r\n`);
      };
      const hideCursor = () => { try { term.write("\x1b[?25l"); } catch {} }; // 已结束：隐藏光标（空心框易被当可交互）
      const applyFrame = (m) => {
        if (m.evt === "started") { setStatus(m.status === "running" ? "running" : "exit"); setMeta(m); currentCmd = String(m.cmd || ""); }
        else if (m.evt === "replace") {
          if (typeof m.seq === "number") { if (m.seq <= seenSeq) return; seenSeq = m.seq; }
          try { term.reset(); } catch {} headerWritten = false; ensureHeader(); term.write(m.data || ""); try { term.scrollToBottom(); } catch {}
        }
        else if (m.evt === "data") {
          if (exited) return; // 已结束不再吃数据帧：防状态回退/横幅后混入旧输出
          if (typeof m.seq === "number") { if (m.seq <= seenSeq) return; seenSeq = m.seq; }
          ensureHeader(); term.write(m.data || ""); try { term.scrollToBottom(); } catch {} setStatus("running");
        }
        else if (m.evt === "exit") {
          if (exited) return;
          exited = true;
          ensureHeader();
          setStatus("exit"); setExitInfo(m);
          hideCursor();
          writeExitBanner(m);
          busOff?.(); busOff = null; aliveDel("cmd-" + cmdId); // 已结束：退订实时流+停保活（死会话无帧可推）
        }
      };
      const applySnapshot = (d) => {
        if (!d || !d.ok) return;
        setStatus(d.status === "done" ? "exit" : "running");
        setMeta({ sessionId: d.sessionId, cmd: d.cmd, cwd: d.cwd }); // 显式字段：不把大 text 存进 state
        currentCmd = String(d.cmd || "");
        try { term.reset(); } catch {} headerWritten = false; ensureHeader();
        if (d.text) term.write(d.text);
        try { term.scrollToBottom(); } catch {}
        if (typeof d.seq === "number" && d.seq > seenSeq) seenSeq = d.seq;
        if (d.status === "done") {
          hideCursor();
          writeExitBanner(d); // reset 重放后补横幅（exited 已置位也要补——reset 清掉了上一份）
          if (!exited) { exited = true; setExitInfo({ isError: d.isError, durationMs: d.durationMs, truncated: d.truncated }); }
        }
      };
      // 订阅实时流（活命令专用）：订阅生效（ready）后才拉全量快照——重叠段由 seq 去重 → 零间隙，
      // 全量快照恰好一次（同 TerminalView）
      const setupLive = () => {
        if (exited || disposed) return;
        const topicsSub = ctx?.getExtService?.("aiti-event-bus.subscribe-topics");
        if (!topicsSub) return;
        const pullSnap = () => { fetch(api(`/pi-commands/${cmdId}`)).then((r) => r.json()).then((d) => { if (!disposed) applySnapshot(d); }).catch(() => {}); };
        const sub = topicsSub(applyFrame, ["cmd-" + cmdId], (s) => {
          if (s === "reconnecting") { everDown = true; setStatus("reconnecting"); }
          else if (s === "up") {
            setStatus((prev) => (prev === "reconnecting" ? "running" : prev));
            if (everDown && !exited) {
              everDown = false;
              pullSnap(); // 重连补丢失段（全量重放 + seq 去重，幂等）
            }
          }
        });
        busOff = () => { try { sub.off(); } catch {} };
        aliveAdd("cmd-" + cmdId); // 订阅保活（停推协议，同 TerminalView）
        sub.ready.then(pullSnap).catch(() => {
          // 总线不可达：退而求其次拉一次快照（无实时流，内容仍可见）
          pullSnap();
        });
      };
      // 初始化：轻量状态查询先行（?meta=1 无 text）——done 定案只拉一次全量，不订阅不保活；
      // running 订阅先行零间隙；查询失败保守走活命令路径
      fetch(api(`/pi-commands/${cmdId}?meta=1`)).then((r) => r.json()).then((info) => {
        if (disposed) return;
        if (info && info.ok) {
          if (info.status === "done") {
            setMeta(info);
            setStatus("exit");
            fetch(api(`/pi-commands/${cmdId}`)).then((r) => r.json()).then((d) => { if (!disposed) applySnapshot(d); }).catch(() => {});
            return;
          }
          setMeta((prev) => ({ ...(prev || {}), ...info }));
        }
        setupLive();
      }).catch(() => setupLive());
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { try { fit.fit(); } catch {} }) : null;
      if (ro) ro.observe(ref.current);
      // 只读视图同样可复制：右键=复制选区、Ctrl+Shift+C / Ctrl+Insert（无粘贴——无 stdin）
      const clip = installTermClipboard(term, ref.current);
      term.attachCustomKeyEventHandler((ev) => !clip.handleKey(ev));
      term.onSelectionChange(() => { try { setHasSel(!!term.getSelection()); } catch {} });
      return () => { disposed = true; busOff?.(); aliveDel("cmd-" + cmdId); linkDisp?.dispose?.(); clip.dispose(); ro?.disconnect(); term.dispose(); termRef.current = null; };
    }, [cmdId]);
    const killPi = () => {
      if (killBusy) return;
      setKillBusy(true);
      // 终端内即时提示（不等总线帧）：代理缓冲/总线慢时用户也能立刻看到点击生效
      try { termRef.current?.write?.("\r\n\x1b[90m[已发送终止信号（SIGTERM），等待进程退出…]\x1b[0m\r\n"); } catch {}
      fetch(api(`/pi-commands/${cmdId}/kill`), { method: "POST" }).catch(() => {}).finally(() => {
        setTimeout(() => setKillBusy(false), 1500); // 最短可见防闪烁；退出后按钮随 status 消失
      });
    };
    // 收藏命令：选区优先（可只收藏片段），否则完整命令 → 命令详情面板（编辑/收藏/执行）
    const saveCmd = () => {
      try {
        const sel = termRef.current?.getSelection?.().trim();
        const cmd = sel || String(meta?.cmd || "").trim();
        if (!cmd) return;
        setState({ detail: { cmd, cwd: meta?.cwd || null }, detailBusy: false });
      } catch {}
    };
    // 滚动到底部（长输出跟随最新）
    const scrollBottom = () => {
      try { const c = ref.current; if (c) c.scrollTop = c.scrollHeight; } catch {}
      try { termRef.current?.scrollToBottom(); } catch {}
    };
    return h("div", { style: fs ? { position: "fixed", inset: 0, zIndex: 500, background: "var(--bg-panel)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4, boxSizing: "border-box" } : { display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 } },
      h("div", { style: { ...smallStyle, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
        // 顶部状态：exit 用醒目底色 badge（被终止/出错红 / 正常绿 / 已清理灰），其余纯色文字
        status === "exit" ? h("span", { style: { display: "inline-flex", alignItems: "center", flexShrink: 0, padding: "1px 8px", borderRadius: 6, fontWeight: 700, fontSize: 11, lineHeight: "16px", color: exitInfo?.swept ? "var(--text)" : exitInfo?.isError ? "#fff" : "var(--ok, #4ade80)", background: exitInfo?.swept ? "var(--bg-hover)" : exitInfo?.isError ? "var(--danger, #ef4444)" : "color-mix(in srgb, var(--ok, #4ade80) 18%, transparent)" } },
          isSmall
            ? (exitInfo?.swept ? "已结束" : exitInfo?.isError ? "已停止" : "完成")
            : (exitInfo?.swept ? "已结束（服务器已清理记录）" : exitInfo?.isError ? "命令已停止（出错/被终止）" : "命令已完成"))
        : h("span", { style: { color: status === "running" ? "var(--ok, #4ade80)" : "var(--text)" } },
          isSmall
            ? (status === "running" ? "●" : status === "reconnecting" ? "⚠" : "…")
            : (status === "running" ? "● 运行中" : status === "reconnecting" ? "重连中…" : "… 连接中")),
        // 顶栏 meta 信息小屏隐藏（移到下方状态栏）
        !isSmall && meta && h("code", { style: smallStyle }, "🤖 " + String(meta.sessionId || "").slice(0, 8) + " $ " + String(meta.cmd || "（订阅前已开始）").slice(0, 70)),
        h("button", { onClick: saveCmd, disabled: !hasSel && !String(meta?.cmd || "").trim(), title: hasSel ? "收藏选中的文本（可只收藏命令片段）" : "收藏完整命令到常用命令", "aria-label": "收藏命令", style: { ...btnStyle, padding: isSmall ? "2px 6px" : "2px 10px", opacity: hasSel || String(meta?.cmd || "").trim() ? 1 : 0.5, cursor: hasSel || String(meta?.cmd || "").trim() ? "pointer" : "not-allowed" } }, isSmall ? "＋" : "＋ 收藏"),
        exitInfo && !isSmall && !exitInfo.swept && h("span", { style: { fontWeight: 700, color: exitInfo.isError ? "var(--danger, #ef4444)" : "var(--text-muted)" } }, (exitInfo.isError ? "出错/被终止" : "完成") + " · " + ((exitInfo.durationMs || 0) / 1000).toFixed(1) + "s"),
        status !== "exit" && h("button", { onClick: killPi, disabled: killBusy, title: killBusy ? "终止信号已发送，等待进程退出…" : "只终止这条 bash 命令（agent 收到错误后继续思考；同会话并发 bash 会一起终止）", "aria-label": "终止命令", style: { ...btnStyle, color: "var(--danger, #ef4444)", padding: isSmall ? "2px 6px" : "2px 10px", opacity: killBusy ? 0.6 : 1, cursor: killBusy ? "wait" : "pointer" } }, killBusy ? (isSmall ? "⏳" : "终止中…") : (isSmall ? "⏹" : "终止命令")),
        h("button", { onClick: scrollBottom, title: "滚动到底部", "aria-label": "滚动到底部", style: { ...btnStyle, padding: "2px 8px" } }, isZh ? "↓底" : "⇊"),
        // 最大化放最末：与 TerminalView 一致习惯
        h("button", { onClick: () => setFs((x) => !x), title: "全屏 / 退出全屏", "aria-label": "全屏", style: { ...btnStyle, padding: "2px 8px", color: fs ? "var(--accent)" : undefined } }, fs ? "⤡" : "⛶"),
      ),
      h("div", { ref, style: { flex: 1, minHeight: 0, background: "#0f172a", borderRadius: 8, padding: 6, overflow: "hidden" } }),
      // 小屏底部状态栏：meta 必含（订阅运行中命令）；统计计数下沉到这里
      isSmall && meta && h("div", { style: { flexShrink: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)", padding: "4px 6px 0", overflow: "hidden", minHeight: 0, whiteSpace: "nowrap" } },
        counts && h("span", { title: "当前：🤖 agent 在跑 / 🖥 终端在跑", style: { flexShrink: 0 } }, "🤖" + counts.piRunning + "/" + counts.piTotal + " 🖥" + counts.ptyRunning),
        h("span", { title: "agent 会话", style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 } }, "🤖 " + String(meta.sessionId || "").slice(0, 8)),
        h("code", { title: String(meta.cmd), style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 2, color: "var(--text)" } }, "$ " + String(meta.cmd || "（订阅前已开始）").slice(0, 60)),
        exitInfo && h("span", { style: { color: exitInfo.isError ? "var(--danger, #ef4444)" : "var(--text-muted)", flexShrink: 0 } }, exitInfo.swept ? "已清理" : (exitInfo.isError ? "⚠ " : "✓ ") + ((exitInfo.durationMs || 0) / 1000).toFixed(1) + "s"),
      ),
      h(TermLinkConfirm, { link: linkConfirm, onClose: () => setLinkConfirm(null) }),
    );
  }

  // ---------- 主面板（命令 / 终端 双页签） ----------
  function CommandPanel() {
    const open = usePanelOpen();
    const view = useView();
    // dock 单实例：终端会话被工作区页签持有（未 detach）时详情区渲染占位卡。
    // hook 必须在 if (!open) return null 之前无条件调用（Rules of Hooks）。
    const hostTabId = useSessionHostTab(view && view.kind === "pty" ? view.id : null);
    const [tab, setTab] = useState("overview");
    // 小屏（宽度断点 640px）：详情工具条按钮图标化（← / ＋ / ⏹）；统计下沉到底栏
    const [isSmall, setIsSmall] = useState(() => typeof window !== "undefined" && (window.matchMedia ? window.matchMedia("(max-width: 640px)").matches : false));
    useEffect(() => {
      if (typeof window === "undefined" || !window.matchMedia) return;
      const mq = window.matchMedia("(max-width: 640px)");
      const onChange = () => setIsSmall(mq.matches);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }, []);
    const [commands, setCommands] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [q, setQ] = useState("");
    const [err, setErr] = useState(null);
    const [editing, setEditing] = useState(null); // {name, cmd, cwd, tags, confirm, suggest}
    const [refreshTick, setRefreshTick] = useState(0);
    const [records, setRecords] = useState([]);
    // 来源分布（M4a §4：/history?groupBy=source UI 化）——审计「按来源追责」可视入口
    const [srcGroups, setSrcGroups] = useState([]);
    const [srcFilter, setSrcFilter] = useState(null);
    const [expanded, setExpanded] = useState(null);
    const [outputs, setOutputs] = useState({});
    const [groups, setGroups] = useState([]);
    const [collapsed, setCollapsed] = useState({});
    const [editingGroup, setEditingGroup] = useState(null); // {id?, name, parentId}
    const [activeTag, setActiveTag] = useState(null);
    const [dictOpen, setDictOpen] = useState(false);
    const [dictData, setDictData] = useState(null); // { groups, user }
    const [dictText, setDictText] = useState("");
    const [piCmds, setPiCmds] = useState([]);   // agent 运行中命令（pi-commands）
    // 点击即反馈的忙态：终止中 id 集（点击变 ⏳ + 防重复点）；新终端开启中
    const [killBusy, setKillBusy] = useState(() => new Set());
    const [piKillBusy, setPiKillBusy] = useState(() => new Set());
    const [newTermBusy, setNewTermBusy] = useState(false);
    // 详情态「⋯ 更多终端」下拉开合（点外部自动收起）
    const [tabMenuOpen, setTabMenuOpen] = useState(false);
    // Hooks 必须在早退之前全部调用（open=false 时不渲染，但 hook 数量不能变）
    const refresh = () => {
      fetch(api("/commands")).then((r) => r.json()).then((d) => { setCommands(d.commands || []); setGroups(d.groups || []); }).catch(() => {});
      fetch(api("/sessions")).then((r) => r.json()).then((d) => setSessions(d.sessions || [])).catch(() => {});
      fetch(api("/pi-commands")).then((r) => r.json()).then((d) => setPiCmds(d.commands || [])).catch(() => {});
    };
    const refreshHistory = () => {
      fetch(api("/history?limit=200")).then((r) => r.json()).then((d) => setRecords(d.records || [])).catch(() => {});
      fetch(api("/history?groupBy=source")).then((r) => r.json()).then((d) => setSrcGroups(d.groups || [])).catch(() => {});
    };
    const [verifyResult, setVerifyResult] = useState(null);
    const loadDict = async () => {
      const d = await fetch(api("/commands/dict")).then((r) => r.json()).catch(() => null);
      if (d) { setDictData(d); setDictText((d.user && d.user.extra || []).join("\n")); }
    };
    const verifyChain = async () => {
      const d = await fetch(api("/history/verify")).then((r) => r.json()).catch(() => null);
      if (!d) { setVerifyResult("校验失败"); return; }
      setVerifyResult(d.ok ? "链完整 · " + d.checkedHashes + " 条哈希" + (d.legacy ? "（legacy " + d.legacy + "）" : "") : "篡改于 " + (d.brokenAt || "?") + " · " + d.checkedHashes + " 条");
    };
    const expand = async (id) => {
      if (expanded === id) { setExpanded(null); return; }
      setExpanded(id);
      if (outputs[id] === undefined) {
        const d = await fetch(api("/history/" + id)).then((r) => r.json()).catch(() => null);
        setOutputs((o) => ({ ...o, [id]: (d && d.output) || "（无输出）" }));
      }
    };
    useEffect(() => { if (open) { refresh(); const iv = setInterval(refresh, 5000); return () => clearInterval(iv); } }, [open, refreshTick]);
    useEffect(() => { if (open && tab === "history") refreshHistory(); }, [open, tab, refreshTick]);
    // view 被设置（含外部路径：消息识别面板 doRun / runCommand 等）但当前不在总览页 → 自动切回，
    // 否则详情视图渲染在总览页里，用户停在历史/命令页签时看不到刚启动的终端
    useEffect(() => { if (view && tab !== "overview") setTab("overview"); }, [view]);
    // 列表实时帧（aiti-event-bus：cmd-sessions / cmd-pilist，aiti-cmd 状态变化时推送）——topics 唯一
    // （2026-09-09 拍板，无兑底轮询；topics 缺席 → 列表靠打开时 refresh() 一次性拉取）。
    // 另加本地 1s tick（纯重渲染，无网络）：运行时长跳动。
    const [, setListTick] = useState(0);
    useEffect(() => { if (!open || tab !== "overview") return; const t = setInterval(() => setListTick((x) => x + 1), 1000); return () => clearInterval(t); }, [open, tab]);
    useEffect(() => {
      if (!open || tab !== "overview" || view) return;
      const topicsSub = ctx?.getExtService?.("aiti-event-bus.subscribe-topics");
      if (!topicsSub) return;
      const s = topicsSub((f) => {
        if (f.evt === "sessions") setSessions(f.sessions || []);
        else if (f.evt === "pilist") setPiCmds(f.commands || []);
      }, ["cmd-sessions", "cmd-pilist"]);
      aliveAdd("cmd-sessions", "cmd-pilist"); // 列表帧同样受停推协议管理
      s.ready.then(() => {
        // 生效后拉一次初值（订阅前的存量）
        fetch(api("/pi-commands")).then((r) => r.json()).then((d) => setPiCmds(d.commands || [])).catch(() => {});
        fetch(api("/sessions")).then((r) => r.json()).then((d) => setSessions(d.sessions || [])).catch(() => {});
      }).catch(() => {}); // 总线不可用 → 无实时列表（打开时 refresh() 已拉）
      return () => { try { s.off(); } catch {} aliveDel("cmd-sessions", "cmd-pilist"); };
    }, [open, tab, view]);
    // 「⋯ 更多终端」下拉：点面板其他区域自动收起（打开的那次 click 已冒泡完，延后一拍再挂监听）
    useEffect(() => {
      if (!tabMenuOpen) return;
      const close = () => setTabMenuOpen(false);
      const t = setTimeout(() => document.addEventListener("click", close), 0);
      return () => { clearTimeout(t); document.removeEventListener("click", close); };
    }, [tabMenuOpen]);
    if (!open) return null;

    // 运行命令（危险命令一次性 token 确认流程：服务端强制）
    const runWithConfirm = async (payload) => {
      let r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
      if (r.needConfirm) {
        const ok = await uiConfirm({ message: `确认执行危险命令${r.danger && r.danger.length ? "（" + r.danger.join("/") + "）" : ""}？`, detail: `$ ${payload.command}`, danger: true });
        if (!ok) return null;
        r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, confirmToken: r.confirmToken }) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
      }
      return r;
    };
    // 运行一条命令（处理参数/确认）
    const runCommand = async (item) => {
      const params = item.params || [];
      let filled = {};
      if (params.length) {
        const vals = {};
        for (const p of params) { const v = await uiPrompt({ message: `参数 ${p}：` }); if (v == null) return; vals[p] = v; }
        filled = vals;
      }
      let cmd = item.cmd;
      for (const [k, v] of Object.entries(filled)) cmd = cmd.replaceAll("{" + k + "}", v);
      const r = await runWithConfirm({ command: cmd, cwd: item.cwd, name: item.name, source: "favorite", commandId: item.id, confirm: !!item.confirm, sandbox: item.sandbox || "none" });
      if (!r) return;
      if (!r.ok) { setErr(r.error || "运行失败"); return; }
      if (r.queued) setErr("已加入队列，等待执行（位置 " + r.position + "/" + r.maxConcurrent + " 并发）");
      openView("pty", r.sessionId, item.name || item.cmd);
      setTab("overview");
      setRefreshTick((t) => t + 1);
    };
    // 弹窗终端 ⇱ 转到工作区页签（详情态 TerminalView 工具条按钮）：
    // · 会话已被某页签绑定（含 ⇲ 拉回窗口态）→ 直接切回页签归属（不新建页签）；
    // · 从未绑定 → 走宿主 pi-web.ui 服务 onOpenTerminal(cwd, true) 新建同 cwd 页签
    //   （AppShell 全局注册，任何时刻可建，不依赖已存在终端页签），pendingTakeovers
    //   由新页签 effect 消费接管（绑既有会话，不另起新 shell），随后弹窗回总览。
    const sendToTab = (s) => {
      if (!s) return;
      for (const [tid, e] of Object.entries(tabAttached)) {
        if (e && e.sessionId === s.id) {
          tabDetached[tid] = false;
          notifyTabAttached();
          closeView();
          return;
        }
      }
      const cwd = s.cwd || "";
      if (!cwd) {
        setErr("转到页签失败：此终端会话没有工作目录，无法定位到项目页签");
        return;
      }
      // 建页签走宿主 pi-web.ui 服务（交互时刻同步读，AppShell 必已挂载）；onOpenTerminal
      // 即 handleOpenTerminal(cwd, forceNew)，forceNew=true 与原 openShellTab 语义一致。
      const openTab = ctx?.getExtService?.("pi-web.ui")?.get?.("onOpenTerminal");
      if (typeof openTab !== "function") {
        setErr("转到页签失败：宿主建页签能力缺席（pi-web.ui.onOpenTerminal）");
        return;
      }
      pendingTakeovers.push({ cwd, sessionId: s.id, title: s.name || s.cmd || "bash", ts: Date.now() });
      try { openTab(cwd, true); } catch (e) {
        pendingTakeovers.pop();
        setErr("转到页签失败：" + ((e instanceof Error && e.message) || String(e)));
        return;
      }
      closeView();
    };
    const saveEditing = async () => {
      if (!editing || !editing.cmd.trim()) return;
      // 规范化 payload：tags 逗号串→数组（store 直接展开，字符串会覆盖 string[] 导致
      // 标签过滤变成子串匹配）；cwd 空串剔除（create 用 ||undefined，update 不清洗会存 ""）
      const payload = { ...editing, tags: (editing.tags || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean) };
      if (!payload.cwd) delete payload.cwd;
      if (editing.id) {
        await fetch(api("/commands/" + editing.id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
      } else {
        // name 缺省用 cmd（与服务端 store.create 一致，UI 提示「名称（默认=命令）」）
        await fetch(api("/commands"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, name: editing.name.trim() || editing.cmd, source: "manual" }) }).catch(() => {});
      }
      setEditing(null); setRefreshTick((t) => t + 1);
    };
    const killSession = (id) => {
      if (killBusy.has(id)) return; // 终止中：忽略重复点击
      setKillBusy((prev) => { const n = new Set(prev); n.add(id); return n; });
      fetch(api(`/sessions/${id}/kill`), { method: "POST" }).catch(() => {}).finally(() => {
        // 最短可见至服务端 SIGKILL 兕底（3s）之后；会话真正退出后按钮随状态渲染消失
        setTimeout(() => setKillBusy((prev) => { const n = new Set(prev); n.delete(id); return n; }), 3500);
      });
      setRefreshTick((t) => t + 1);
    };
    // agent 命令终止（总览行 ⏹；详情视图 PiCommandView 自带本地忙态，不走这里）
    const killPiCommand = (id) => {
      if (piKillBusy.has(id)) return;
      setPiKillBusy((prev) => { const n = new Set(prev); n.add(id); return n; });
      fetch(api(`/pi-commands/${id}/kill`), { method: "POST" }).catch(() => {}).finally(() => {
        setTimeout(() => setPiKillBusy((prev) => { const n = new Set(prev); n.delete(id); return n; }), 1500);
      });
    };
    // ＋ 新终端（忙态防连点；§3.3 终端拉起类一律 /shell——后端建会话，命令文本不落前端）
    const newShell = (cwd) => {
      if (newTermBusy) return;
      setNewTermBusy(true);
      const useCwd = cwd || ctx?.getExtService?.("pi-web.ui")?.get?.("selectedCwd") || undefined;
      Promise.resolve(
        fetch(api("/shell"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "终端", cwd, ttlMs: 24 * 3600 * 1000 }) })
          .then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }))
      ).then((r) => {
        if (!r || !r.ok) setErr((r && r.error) || "创建终端失败");
        else { openView("pty", r.sessionId, r.name || "终端"); setTab("overview"); setRefreshTick((t) => t + 1); }
      }).finally(() => setNewTermBusy(false));
    };
    // 「＋ 新建 / ＋ 新终端」@ 上 shell 实时路径：先查当前终端会话实时 pwd（cd 后取 cd 后的），再建新终端
    const newShellAt = async (s) => {
      if (!s) return newShell();
      if (newTermBusy) return;
      const live = await liveCwdOf(s.id, s.cwd);
      newShell(live);
    };
    // 「💬 新会话」新建 pi-web 会话 @ 当前终端路径：查实时 pwd → 宿主新会话通道（预填 @路径 + 切换）
    const newPiSession = async (s) => {
      if (!s) return;
      const live = await liveCwdOf(s.id, s.cwd);
      if (!openNewPiSession(live)) {
        setErr(live ? "新建 pi-web 会话失败：宿主新会话通道不可用" : "新建 pi-web 会话失败：当前终端会话没有工作目录");
        return;
      }
      closeView(); // 收敛弹窗回总览；宿主已切新会话页
    };
    const filtered = commands.filter((c) => (!q || (c.name + " " + c.cmd).toLowerCase().includes(q.toLowerCase())) && (!activeTag || (c.tags || []).includes(activeTag)));
    // 全部标签（用于过滤 chips）
    const allTags = Array.from(new Set(commands.flatMap((c) => c.tags || []))).sort();
    // ---- 树形分组辅助 ----
    const childrenOf = (pid) => groups.filter((g) => g.parentId === pid).sort((a, b) => a.name.localeCompare(b.name));
    const commandsOf = (gid) => filtered.filter((c) => c.groupId === gid);
    const ungrouped = filtered.filter((c) => !c.groupId);
    const groupPathOf = (id) => {
      if (!id) return "未分组";
      const parts = []; let cur = groups.find((g) => g.id === id); let guard = 0;
      while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parentId ? groups.find((g) => g.id === cur.parentId) : undefined; }
      return parts.join(" / ") || "未分组";
    };
    const saveGroupEditing = async () => {
      if (!editingGroup || !editingGroup.name.trim()) return;
      if (editingGroup.id) {
        await fetch(api("/commands/groups/" + editingGroup.id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: editingGroup.name, parentId: editingGroup.parentId }) }).catch(() => {});
      } else {
        await fetch(api("/commands/groups"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: editingGroup.name, parentId: editingGroup.parentId }) }).catch(() => {});
      }
      setEditingGroup(null); setRefreshTick((t) => t + 1);
    };
    const miniBtn = { ...btnStyle, padding: "1px 7px", fontSize: 13 };
    const miniBtnDanger = { ...miniBtn, color: "var(--danger, #ef4444)" };
    // 复制命令：写入剪贴板 + 打开「新建命令」弹窗预填内容（可改后另存新命令）
    const copyAsNew = (c) => {
      try {
        const t = c.cmd;
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).catch(() => {});
        else {
          const ta = document.createElement("textarea");
          ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } catch {}
          document.body.removeChild(ta);
        }
      } catch {}
      setEditingGroup(null); // 互斥：命令/分组弹窗不同时开
      setEditing({ name: c.name, cmd: c.cmd, cwd: c.cwd || "", tags: (c.tags || []).join(","), confirm: !!c.confirm, groupId: c.groupId || null, sandbox: c.sandbox || "none", suggest: c.suggest !== false });
      setTimeout(() => { try { document.getElementById("aiti-cmd-edit-cmd")?.focus(); } catch {} }, 60);
    };
    // ⏰ 定时执行：委托 ⏰调度 页预填新建（aiti-ai-schedule 未加载则直接创建待确认计划）
    const scheduleCommand = async (c) => {
      // 危险命令（带执行确认标记）排班前二次确认——定时到点会无人值守自动执行
      if (c.confirm && !(await uiConfirm({ message: `命令「${c.name || c.cmd}」标记为危险命令。\n创建定时计划后到点将不经确认直接执行，确认继续？`, danger: true }))) return;
      const prefill = {
        name: (c.name || c.cmd || "定时命令").slice(0, 60),
        prompt: "执行以下命令并汇报结果" + (c.cwd ? "（工作目录：" + c.cwd + "）" : "") + "：\n$ " + c.cmd + "\n完成后简要汇报输出要点与退出码。" + (c.params && c.params.length ? "\n注意：命令含 {参数} 占位符，请按当前上下文合理填充后再执行。" : ""),
        cwd: c.cwd || undefined,
        mode: "session",
      };
      try {
        if (typeof window.__aitiAiScheduleOpen === "function") { window.__aitiAiScheduleOpen(prefill); return; }
      } catch {}
      fetch(apiUrl("/api/extensions/aiti-ai-schedule/plans"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...prefill, schedule: "0 9 * * *", enabled: false, autoApprove: false }),
      }).then((r) => r.json()).then((d) => {
        if (d && d.ok) void uiAlert({ message: `已创建待确认计划「${prefill.name}」（默认每天9点，到 ⏰调度 页修改并批准）`, kind: "success" });
        else void uiAlert({ message: "创建失败：" + ((d && d.error) || "未知错误"), kind: "error" });
      }).catch((e) => void uiAlert({ message: "创建失败：" + String(e), kind: "error" }));
    };
const renderCommandRow = (c, depth) =>
      h("div", { key: c.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 8, background: "var(--bg-hover)", border: "1px solid var(--border)", marginLeft: depth * 18 } },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: 14, fontWeight: 600 } }, c.name + (c.confirm ? " ⚠" : "") + (SANDBOX[c.sandbox || "none"] ? SANDBOX[c.sandbox || "none"].icon : "")),
          h("code", { style: { fontSize: 13, color: "var(--text-muted)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "$ " + c.cmd + (c.cwd ? "  ·  " + c.cwd : "")),
        ),
        h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, "×" + (c.runCount || 0)),
        h("button", { onClick: () => runCommand(c), style: { ...btnStyle, background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none" }, title: "▶ 执行此命令" + (c.params && c.params.length ? "（含参数，执行时逐一填写）" : "") + (c.confirm ? "（危险命令，执行前弹窗确认）" : "") }, Ic(13, ICONS.play), "执行"),
        h("button", { onClick: () => copyAsNew(c), style: btnStyle, title: "复制命令内容到剪贴板并打开「新建命令」预填（可改后另存）" }, "⧉"),
        h("button", { onClick: () => scheduleCommand(c), style: btnStyle, title: "定时执行：创建调度计划（预填本条命令）" }, "⏰"),
        h("button", { onClick: () => setEditing({ id: c.id, name: c.name, cmd: c.cmd, cwd: c.cwd || "", tags: (c.tags || []).join(","), confirm: !!c.confirm, groupId: c.groupId || null, sandbox: c.sandbox || "none", suggest: c.suggest !== false }), style: btnStyle, title: "编辑命令（名称/命令/cwd/标签/分组/沙箱/执行确认/智能提示）" }, Ic(13, ICONS.pencil)),
        h("button", { onClick: () => { fetch(api("/commands/" + c.id), { method: "DELETE" }).then(() => setRefreshTick((t) => t + 1)); }, style: miniBtnDanger, title: "删除此命令" }, Ic(13, ICONS.trash)),
      );
    const renderGroupTree = (parentId, depth) => {
      const subs = childrenOf(parentId);
      const rows = [];
      // 在指定分组下新建命令（groupId 预填，聚焦命令输入框）
      const newCmdInGroup = (gid) => {
        setEditingGroup(null); // 互斥：命令/分组弹窗不同时开
        setEditing({ name: "", cmd: "", cwd: "", tags: "", confirm: false, groupId: gid, sandbox: "none", suggest: true });
        setTimeout(() => { try { document.getElementById("aiti-cmd-edit-cmd")?.focus(); } catch {} }, 60);
      };
      for (const g of subs) {
        const subCount = childrenOf(g.id).length;
        const cmdCount = commandsOf(g.id).length;
        const isCollapsed = !!collapsed[g.id];
        rows.push(
          h("div", { key: "g" + g.id, style: { display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6, cursor: "pointer", marginLeft: depth * 18, background: "transparent" }, onClick: () => setCollapsed({ ...collapsed, [g.id]: !isCollapsed }) },
            h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, (subCount || cmdCount) ? (isCollapsed ? "▸" : "▾") : "·"),
            h("span", { style: { fontSize: 14, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.folder), g.name),
            h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, cmdCount + (subCount ? "+" + subCount + "子" : "")),
            h("span", { style: { marginLeft: "auto", display: "flex", gap: 2 }, onClick: (e) => e.stopPropagation() },
              h("button", { onClick: () => newCmdInGroup(g.id), style: miniBtn, title: "在此分组下新建命令" }, "＋命令"),
              h("button", { onClick: () => { setEditing(null); setEditingGroup({ name: "", parentId: g.id }); }, style: miniBtn, title: "在此分组下新建子分组" }, "＋子组"),
              h("button", { onClick: () => setEditingGroup({ id: g.id, name: g.name, parentId: g.parentId }), style: miniBtn, title: "重命名/移动" }, Ic(12, ICONS.pencil)),
              h("button", { onClick: async () => { if (await uiConfirm({ message: `删除分组「${g.name}」及其子分组？组内命令将移入未分组`, danger: true })) { fetch(api("/commands/groups/" + g.id), { method: "DELETE" }).then(() => setRefreshTick((t) => t + 1)); } }, style: miniBtnDanger, title: "删除分组" }, Ic(12, ICONS.trash)),
            ),
          ),
        );
        if (!isCollapsed) {
          rows.push(...renderGroupTree(g.id, depth + 1));
          for (const c of commandsOf(g.id)) rows.push(renderCommandRow(c, depth + 1));
        }
      }
      return rows;
    };

    // tab 页签按钮（紧凑单行：高度 ~18px，active 下划线）
    const tabBtn = (active) => ({
      ...btnStyle,
      background: "transparent", borderTop: "none", borderRight: "none", borderLeft: "none",
      borderBottom: "2px solid " + (active ? "var(--accent)" : "transparent"),
      color: active ? "var(--text)" : "var(--text-muted)",
      fontWeight: active ? 600 : 400,
      borderRadius: "5px 5px 0 0", padding: "1px 10px", fontSize: 12, lineHeight: "16px",
      height: 20, marginBottom: -1, display: "inline-flex", alignItems: "center", gap: 4,
    });

    return h("div", {
      style: { position: "fixed", inset: 0, zIndex: 320, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
      onClick: () => setState({ panelOpen: false }),
    },
      h("div", {
        "data-ext-float": "1", "data-ext-float-w": 860, "data-ext-float-h": 620, "data-ext-float-full": "1",
        style: { width: 860, maxWidth: "96vw", height: "82vh", display: "flex", flexDirection: "column", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", overflow: "hidden" },
        onClick: (e) => e.stopPropagation(),
      },
        // 标题栏（窗口工具区：单行紧凑——icon + 标题 + 副标题同行省略号 + 最大化的⛶/🤖/关闭；tab 在内容区顶部）
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0, minHeight: 26, lineHeight: 1 } },
          h("span", { style: { width: 18, height: 18, borderRadius: 5, background: "var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 } }, Ic(12, ICONS.terminal)),
          h("span", { style: { fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 } }, "aiti-cmd"),
          h("span", { style: { fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "运行总览 · 常用命令 · 执行审计"),
          // aria-label="关闭"：ai-helper 弹窗 🤖 注入的定位标记（全局 UI 契约，同 model-wizard/configs 等扩展）
          h("button", { onClick: () => setState({ panelOpen: false }), title: "关闭面板", "aria-label": "关闭", style: { ...btnStyle, padding: "1px 6px", fontSize: 12, background: "transparent", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", color: "var(--text-muted)", flexShrink: 0, display: "inline-flex", lineHeight: 1 } }, Ic(12, ICONS.x)),
        ),
        // 内容区（顶部 tab 页签带：active 下划线 + 主色，系统 TabBar 风格；单行紧凑高度）
        h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "6px 10px 10px", overflow: "hidden", gap: 6 } },
          h("div", { style: { display: "flex", gap: 2, flexShrink: 0, borderBottom: "1px solid var(--border)", lineHeight: 1 } },
            h("button", { onClick: () => { closeView(); setTab("overview"); refresh(); }, title: "总览：agent 运行中命令 / 终端会话一览", style: tabBtn(tab === "overview") }, Ic(12, ICONS.list), "总览"),
            h("button", { onClick: () => setTab("commands"), title: "命令：常用命令列表（执行/复制/编辑/删除）", style: tabBtn(tab === "commands") }, "命令"),
            h("button", { onClick: () => setTab("history"), title: "历史：执行审计（append-only 留存）", style: tabBtn(tab === "history") }, "历史"),
          ),
        err && h("p", { style: { ...smallStyle, color: "var(--danger, #ef4444)", marginBottom: 6 } }, String(err)),
        tab === "commands" && h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: rowStyle },
            h("input", { style: { ...inputStyle, maxWidth: 240 }, value: q, placeholder: "搜索命令…", onChange: (e) => setQ(e.target.value) }),
            h("button", { onClick: () => { setEditingGroup(null); setEditing({ name: "", cmd: "", cwd: "", tags: "", confirm: false, groupId: null, sandbox: "none", suggest: true }); }, style: btnStyle, title: "＋ 新建命令（保存后出现在命令列表对应分组）" }, "＋ 新建命令"),
            h("button", { onClick: () => { setEditing(null); setEditingGroup({ name: "", parentId: null }); }, style: btnStyle, title: "＋ 新建分组（树形分组整理命令）" }, "＋ 新分组"),
            h("button", { onClick: () => { loadDict(); setDictOpen(!dictOpen); }, style: btnStyle, title: "词库：常用命令名（AI 消息识别用，全文扫描）" }, "词库"),
          ),
          allTags.length > 0 && h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 2 } },
            h("button", { onClick: () => setActiveTag(null), title: "全部：取消标签过滤", style: { ...btnStyle, padding: "1px 8px", fontSize: 13, background: !activeTag ? "var(--accent)" : "transparent", color: !activeTag ? "#fff" : "var(--text)", border: "1px solid " + (!activeTag ? "var(--accent)" : "var(--border)") } }, "全部"),
            allTags.map((tag) =>
              h("button", { key: tag, onClick: () => setActiveTag(activeTag === tag ? null : tag), title: "#" + tag + "：按标签过滤（再点取消）", style: { ...btnStyle, padding: "1px 8px", fontSize: 13, background: activeTag === tag ? "var(--accent)" : "transparent", color: activeTag === tag ? "#fff" : "var(--text)", border: "1px solid " + (activeTag === tag ? "var(--accent)" : "var(--border)") } }, "#" + tag)),
          ),
          dictOpen && h("div", { style: { border: "1px solid var(--border)", borderRadius: 8, padding: 8, marginBottom: 4, background: "var(--bg)" } },
            h("div", { style: { ...rowStyle, marginBottom: 4 } },
              h("b", { style: { fontSize: 14 } }, "常用命令词库（消息识别用）"),
              h("span", { style: { ...smallStyle, flex: 1 } }, "内置 " + (dictData ? dictData.groups.reduce((a, g) => a + g.names.length, 0) : "?") + " 命令名 / 识别时全文扫描"),
              h("button", { onClick: () => setDictOpen(false), title: "关闭词库", style: { ...btnStyle, padding: "2px 8px", display: "inline-flex" } }, Ic(12, ICONS.x)),
            ),
            dictData && h("div", { style: { display: "flex", flexWrap: "wrap", gap: "2px 8px", marginBottom: 6, fontSize: 13, color: "var(--text-muted)" } },
              dictData.groups.map((g) => h("span", { key: g.group, style: { padding: "1px 8px", background: "var(--bg-hover)", borderRadius: 6 } }, g.group + ": " + g.names.slice(0, 12).join(" ") + (g.names.length > 12 ? " …" : ""))),
            ),
            h("textarea", { style: { ...inputStyle, minHeight: 56, fontFamily: "var(--font-mono)" }, value: dictText, placeholder: "自定义命令词（每行一个，如：mytool / just get / pnpm-dlx）", onChange: (e) => setDictText(e.target.value) }),
            h("div", { style: { ...rowStyle, marginTop: 4 } },
              h("button", { onClick: async () => { await fetch(api("/commands/dict"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ extra: dictText.split(/\n|,|，/).map((s) => s.trim()).filter(Boolean) }) }); setDictText(""); setRefreshTick((t) => t + 1); loadDict(); }, style: { ...btnStyle, background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none" }, title: "保存自定义命令词到词库（消息识别立即生效）" }, "保存词库"),
              h("span", { style: smallStyle }, "新增词后，消息识别会立即用新词扫描"),
            ),
          ),
          h("div", { style: { flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 } },
            filtered.length === 0 && groups.length === 0 ? h("p", { style: smallStyle }, "（无命令——从 AI 消息识别收藏，或点「＋ 新建命令」）")
            : [
                // 顶层分组树
                renderGroupTree(null, 0),
                // 未分组命令（无分组归属，且不在任何分组内的命令）
                ungrouped.length > 0 && h("div", { key: "_ungrouped", style: { marginTop: 4 } },
                  h("div", { style: { fontSize: 13, color: "var(--text-muted)", padding: "2px 8px" } }, "未分组"),
                  ungrouped.map((c) => renderCommandRow(c, 0)),
                ),
              ],
          ),
        ),
        tab === "history" && h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: rowStyle },
            h("b", { style: { fontSize: 14 } }, "执行审计（append-only 留存）"),
            h("span", { style: { ...smallStyle, flex: 1 } }, "命令/参数/输出/退出码/时间/来源——安全审计"),
            h("button", { onClick: verifyChain, title: "校验审计链完整性（哈希链）", style: { ...btnStyle, padding: "2px 10px", display: "inline-flex", alignItems: "center", gap: 4 } }, verifyResult ? "✓ " + verifyResult : [Ic(12, ICONS.lock), "校验链"]),
            h("button", { onClick: () => setRefreshTick((t) => t + 1), style: btnStyle, title: "刷新历史记录" }, "↻ 刷新"),
          ),
          // 来源分布 chips（M4a：groupBy=source 可视化；点击过滤，再点取消）
          srcGroups.length > 0 && h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" } },
            h("span", { style: { ...smallStyle, marginRight: 2 } }, "来源分布"),
            srcGroups.map((g) => h("button", {
              key: g.source,
              onClick: () => setSrcFilter(srcFilter === g.source ? null : g.source),
              title: SOURCE_LABEL[g.source] || g.source + "：共 " + g.count + " 条，失败 " + g.failCount + "（" + Math.round(g.failRate * 100) + "%），最近 " + new Date(g.lastTs).toLocaleString("zh-CN", { hour12: false }),
              style: { ...btnStyle, padding: "1px 8px", fontSize: 13, background: srcFilter === g.source ? "var(--accent)" : "transparent", color: srcFilter === g.source ? "#fff" : "var(--text)", border: "1px solid " + (srcFilter === g.source ? "var(--accent)" : "var(--border)") },
            }, (SOURCE_LABEL[g.source] || g.source) + " " + g.count + (g.failCount ? " ⚠" + g.failCount : ""))),
          ),
          h("div", { style: { flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 } },
            records.length === 0 ? h("p", { style: smallStyle }, "（暂无执行记录）")
            : (srcFilter ? records.filter((r) => r.source === srcFilter) : records).map((rec) =>
              h("div", { key: rec.id, style: { display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px", borderRadius: 8, background: "var(--bg-hover)", border: "1px solid var(--border)", cursor: "pointer" }, onClick: () => expand(rec.id) },
                h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                  h("span", { style: { fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap" } }, new Date(rec.ts).toLocaleString("zh-CN", { hour12: false })),
                  h("code", { style: { flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "$ " + rec.cmd),
                  h("span", { style: { fontSize: 13, color: rec.exit === 0 ? "var(--ok, #4ade80)" : "var(--danger, #f87171)" } }, "exit " + (rec.exit ?? "?")),
                  h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, ((rec.durationMs || 0) / 1000).toFixed(1) + "s"),
                  h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, SOURCE_LABEL[rec.source] || rec.source),
                  rec.danger && rec.danger.length ? h("span", { style: { color: "var(--warn, #f59e0b)", display: "inline-flex" } }, Ic(12, ICONS.alert)) : null,
                ),
                expanded === rec.id && h("pre", { style: { ...smallStyle, background: "#0f172a", color: "#a5f3fc", padding: 8, borderRadius: 6, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", margin: 0, fontFamily: "var(--font-mono)" } }, outputs[rec.id] !== undefined ? outputs[rec.id] : "加载中…"),
              )),
          ),
        ),
        tab === "overview" && (() => {
          const piRunning = piCmds.filter((c) => c.status === "running").length;
          const ptyRunning = sessions.filter((s) => s.status === "running").length;
          const ptyQueued = sessions.filter((s) => s.status === "queued").length;
          const counts = { piRunning, piTotal: piCmds.length, ptyRunning, ptyQueued };
          // 详情态：原「运行总览头」与「视图头」双行合一 → 单行工具条。
          // 统计压成右侧徽标（大屏显示，小屏下沉到终端底栏）；「点行看详情」在详情态无意义，删除。
          // 详情态工具条：← 返回总览 + 终端 tab 条 + 右侧统计/＋新终端/⏹终止。
          // tab 条显示所有还活着（running/queued）的命令/终端，点击直接切换，不用回总览再点；
          // 顺序固定（数据序），切换只改高亮不挪位；超过 maxVisible 收进「⋯」下拉（点开列出全部）；
          // 当前 tab 落在隐藏区时「⋯」按钮上带出标题提示；已退出的当前视图末尾补位显示。
          const renderDetailHeader = () => {
            const maxVisible = isSmall ? 2 : 5;
            // 详情态当前 pty 会话（为「＋ 新终端」@上当前终端路径：新会话 cwd = 当前终端会话 cwd）
            const curPty = view && view.kind === "pty" ? sessions.find((x) => x.id === view.id) || null : null;
            const live = [];
            for (const c of piCmds) if (c.status === "running") live.push({ kind: "pi", id: c.id, title: c.cmd || "（订阅前已开始）", icon: "🤖", state: "running" });
            for (const s of sessions) if (s.status === "running" || s.status === "queued") live.push({ kind: "pty", id: s.id, title: s.name || s.cmd, icon: "🖥", state: s.status });
            const isCur = (t) => !!view && t.kind === view.kind && t.id === view.id;
            // 当前视图已退出（不在活列表）→ 末尾补位，不动活跃 tab 的位置
            if (view && !live.some(isCur)) live.push({ kind: view.kind, id: view.id, title: view.title || view.id, icon: view.kind === "pi" ? "🤖" : "🖥", state: "dead" });
            // 固定顺序截断：前 maxVisible 个直接显示，其余进「⋯」下拉
            const shown = live.slice(0, maxVisible);
            const hidden = live.slice(maxVisible);
            const hiddenCur = hidden.find(isCur);
            // 菜单可视态：hidden 清零（会话退完）时 tabMenuOpen 残留 true 会让下次首次点「⋯」反转失效，派生量统一兜住
            const menuOpen = tabMenuOpen && hidden.length > 0;
            const stateDot = (t) => t.state === "running" ? "●" : t.state === "queued" ? "⏳" : "■";
            const stateText = { running: "运行中", queued: "排队中", dead: "已退出" };
            // tab 胶囊：active 主色边框高亮；label 截断，完整标题看 hover tooltip / 下拉
            const liveTabBtn = (t, active) => h("button", {
              key: t.kind + ":" + t.id,
              onClick: () => { if (!active) openView(t.kind, t.id, t.title); },
              title: stateDot(t) + " " + stateText[t.state] + " — " + t.title + (active ? "（当前）" : "（点击切换）"),
              style: {
                ...btnStyle, display: "inline-flex", alignItems: "center", minWidth: 0, maxWidth: 160,
                flexShrink: 1, // 空间不足时收缩（label 已 ellipsis），防止长标题 tab 把「⋯」按钮挤出容器被裁
                padding: isSmall ? "0 5px" : "0 7px", fontSize: 12, height: 20, lineHeight: "18px",
                background: active ? "var(--bg-hover)" : "transparent",
                border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
                color: active ? "var(--text)" : "var(--text-muted)", fontWeight: active ? 600 : 400,
              },
            },
              h("span", { style: { color: t.state === "running" ? "var(--ok, #4ade80)" : t.state === "queued" ? "var(--warn, #f59e0b)" : "var(--text-muted)", flexShrink: 0, marginRight: 3 } }, stateDot(t)),
              h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (t.icon + " " + t.title).trim()),
            );
            return h("div", { style: { ...rowStyle, marginBottom: 2, gap: 6, minHeight: 22, lineHeight: 1 } },
              h("button", { onClick: closeView, title: "← 返回总览", style: { ...btnStyle, padding: isSmall ? "0 6px" : "0 8px", fontSize: 12, height: 20, lineHeight: "18px" } }, isSmall ? "←" : "← 返回总览"),
              // tab 条（固定顺序：数据序前 maxVisible 个 + 「⋯」下拉；切换只改高亮不挪位）
              h("div", { style: { display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0, overflow: "hidden" } },
                shown.map((t) => liveTabBtn(t, isCur(t))),
                hidden.length > 0 && h("div", { style: { position: "relative", flexShrink: 0 } },
                  h("button", { onClick: (e) => { e.stopPropagation(); setTabMenuOpen(!menuOpen); }, title: hiddenCur ? "当前：" + stateDot(hiddenCur) + " " + stateText[hiddenCur.state] + " — " + hiddenCur.title + "（更多终端/命令，还有 " + hidden.length + " 个未显示）" : "更多终端/命令（还有 " + hidden.length + " 个未显示），点开列表切换", "aria-label": "更多终端", style: { ...btnStyle, display: "inline-flex", alignItems: "center", gap: 4, padding: isSmall ? "0 5px" : "0 7px", fontSize: 12, height: 20, lineHeight: "18px", background: menuOpen ? "var(--bg-hover)" : "transparent", border: "1px solid " + (hiddenCur ? "var(--accent)" : "var(--border)") } },
                    "⋯",
                    hiddenCur && h("span", { style: { maxWidth: 92, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: hiddenCur.state === "dead" ? "var(--text-muted)" : "var(--text)", fontWeight: 600 } }, stateDot(hiddenCur) + " " + hiddenCur.title),
                  ),
                  menuOpen && h("div", { onClick: (e) => e.stopPropagation(), style: { position: "absolute", top: 24, left: 0, zIndex: 350, width: 340, maxWidth: "78vw", maxHeight: 280, overflowY: "auto", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", padding: 4, display: "flex", flexDirection: "column", gap: 1 } },
                    live.map((t) => h("button", {
                      key: "m" + t.kind + ":" + t.id,
                      onClick: () => { setTabMenuOpen(false); if (!isCur(t)) openView(t.kind, t.id, t.title); },
                      title: stateDot(t) + " " + stateText[t.state] + " — " + t.title,
                      style: { display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", border: "1px solid transparent", background: isCur(t) ? "var(--bg-hover)" : "transparent", borderRadius: 6, padding: "5px 8px", cursor: "pointer", fontFamily: "inherit", color: "var(--text)" },
                    },
                      h("span", { style: { fontSize: 12, color: t.state === "running" ? "var(--ok, #4ade80)" : t.state === "queued" ? "var(--warn, #f59e0b)" : "var(--text-muted)", flexShrink: 0 } }, stateDot(t)),
                      h("span", { style: { fontSize: 12, color: "var(--text-muted)", flexShrink: 0 } }, t.icon),
                      h("span", { style: { fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isCur(t) ? 600 : 400 } }, t.title),
                      h("span", { style: { fontSize: 12, color: "var(--text-muted)", flexShrink: 0 } }, stateText[t.state]),
                    )),
                  ),
                ),
              ),
              !isSmall && h("span", { style: { ...smallStyle, fontSize: 12, lineHeight: 1, flexShrink: 0, whiteSpace: "nowrap" } }, "🤖 " + piRunning + "/" + piCmds.length + " · 🖥 " + ptyRunning),
              h("button", { onClick: curPty ? () => newShellAt(curPty) : () => newShell(), disabled: newTermBusy, title: newTermBusy ? "正在创建终端会话…" : (curPty ? "＋ 新终端：再开一个 shell（目录 = 当前终端 📁 实时路径）" : "＋ 新终端：开一个交互式 shell（无沙箱）"), style: { ...btnStyle, padding: isSmall ? "0 6px" : "0 8px", fontSize: 12, height: 20, lineHeight: "18px", background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", flexShrink: 0, opacity: newTermBusy ? 0.6 : 1, cursor: newTermBusy ? "wait" : "pointer" } }, newTermBusy ? (isSmall ? "⏳" : "开启中…") : (isSmall ? "＋" : "＋ 新终端")),
              // 会话已结束则隐藏中止（点了也只能 409）；PTY 结束态经 sessions 列表感知
              view.kind === "pty" && sessions.find((x) => x.id === view.id)?.status === "running" && (() => {
                const kb = killBusy.has(view.id);
                return h("button", { onClick: () => killSession(view.id), disabled: kb, title: kb ? "终止信号已发送，等待进程退出…" : "终止命令（杀进程）", style: { ...btnStyle, color: "var(--danger, #ef4444)", padding: isSmall ? "0 6px" : "0 8px", fontSize: 12, height: 20, lineHeight: "18px", opacity: kb ? 0.6 : 1, cursor: kb ? "wait" : "pointer" } }, isSmall ? (kb ? "⏳" : "⏹") : (kb ? "终止中…" : "终止"));
              })(),
            );
          };
          const header = view ? renderDetailHeader() : h("div", { style: { ...rowStyle, marginBottom: 2, gap: 6, minHeight: 22, lineHeight: 1 } },
                h("b", { style: { fontSize: 13, whiteSpace: "nowrap", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 } }, Ic(13, ICONS.list), "运行总览"),
                h("span", { style: { ...smallStyle, fontSize: 12, lineHeight: 1, flex: 1, minWidth: 140 } },
                  "agent " + piRunning + " 条在跑" + (piCmds.length > piRunning ? "（共 " + piCmds.length + "）" : "") + " · 🖥 终端 " + ptyRunning + " 个在跑" + (ptyQueued ? "（" + ptyQueued + " 排队）" : "") + " · 点行看详情"),
                h("button", { onClick: () => newShell(), disabled: newTermBusy, title: newTermBusy ? "正在创建终端会话…" : "＋ 新终端：开一个交互式 shell（无沙箱）", style: { ...btnStyle, fontSize: 12, height: 20, lineHeight: "18px", padding: "0 10px", background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", marginLeft: "auto", flexShrink: 0, opacity: newTermBusy ? 0.6 : 1, cursor: newTermBusy ? "wait" : "pointer" } }, newTermBusy ? "开启中…" : "＋ 新终端"),
              );
          // dock 单实例：该终端会话被工作区页签持有（未 detach）时，弹窗渲染占位卡——
          // 视图此刻归页签；「拉回窗口」切归属（detached 标记）后这里恢复 TerminalView。
          const content = view
            ? h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
                view.kind === "pi" ? h(PiCommandView, { cmdId: view.id, counts })
                : hostTabId ? h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, color: "var(--text-dim)", fontSize: 12 } },
                    h("div", { style: { display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" } },
                      h("span", { style: { display: "inline-flex", flexShrink: 0 } }, Ic(14, ICONS.monitor)),
                      h("span", null, "此终端已在工作区页签打开（右侧文件区）"),
                    ),
                    h("button", { onClick: () => { tabDetached[hostTabId] = true; notifyTabAttached(); }, style: { ...btnStyle, padding: "6px 14px", color: "var(--accent)", fontWeight: 600, fontSize: 12 } }, "拉回窗口"),
                    h("span", { style: { fontSize: 11, color: "var(--text-muted)" } }, "终端同时只能在一处显示；页签内已变为占位"),
                  )
                : (() => {
                    const s = sessions.find((x) => x.id === view.id);
                    const canSend = s && (s.status === "running" || s.status === "queued");
                    // onNewShell：弹窗模式「＋ 新建」@ 当前终端实时路径（实时 pwd，cd 后新会话落在当前目录）；
                    // onNewPiSession：「💬 新会话」新建 pi-web 会话并 @ 同一实时路径
                    return h(TerminalView, { sessionId: view.id, height: "100%", counts, onExit: () => refresh(), sendToTab: canSend ? () => sendToTab(s) : undefined, killPending: killBusy.has(view.id),
                      onNewShell: s ? () => newShellAt(s) : undefined,
                      onNewPiSession: s ? () => newPiSession(s) : undefined });
                  })(),
              )
            : h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 8 } },
                // 🤖 agent 命令（2s 自动刷新；点行进详情，⏹ 只终止命令不 abort turn）
                h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h("div", { style: { fontSize: 14, fontWeight: 700, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.bot), "agent 命令"),
                  piCmds.length === 0 ? h("p", { style: { ...smallStyle, margin: 0 } }, "（没有在跑的 bash 命令；agent 会话执行命令时自动出现）")
                  : piCmds.map((c) =>
                    h("div", { key: c.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: "var(--bg-hover)", border: "1px solid var(--border)", cursor: "pointer" }, onClick: () => openView("pi", c.id, c.cmd) },
                      h("span", { style: { fontSize: 13, color: c.status === "running" ? "var(--ok, #4ade80)" : c.isError ? "var(--danger, #f87171)" : "var(--text-muted)" } }, c.status === "running" ? "●" : c.isError ? "⚠" : "■"),
                      h("div", { style: { flex: 1, minWidth: 0 } },
                        h("code", { style: { fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "$ " + (c.cmd || "（订阅前已开始）")),
                        h("span", { style: { fontSize: 13, color: "var(--text-muted)" } },
                          "🤖 " + String(c.sessionId || "").slice(0, 8) + (c.cwd ? " · " + c.cwd : "") + " · " + (c.status === "running" ? "运行中" : c.isError ? "出错/被终止" : "完成") + " · " + ((c.status === "running" ? Date.now() - c.startedTs : c.durationMs || 0) / 1000).toFixed(0) + "s" + (c.bytes ? " · " + (c.bytes / 1024).toFixed(1) + "KB" : "") + (c.truncated ? " · 截断" : "")),
                      ),
                      c.status === "running" && h("button", { onClick: (e) => { e.stopPropagation(); killPiCommand(c.id); }, disabled: piKillBusy.has(c.id), title: piKillBusy.has(c.id) ? "终止信号已发送，等待进程退出…" : "只终止这条命令（不 abort 整个 turn）", style: { ...btnStyle, color: "var(--danger, #ef4444)", padding: "2px 8px", opacity: piKillBusy.has(c.id) ? 0.6 : 1, cursor: piKillBusy.has(c.id) ? "wait" : "pointer" } }, piKillBusy.has(c.id) ? "⏳" : "⏹"),
                    )),
                ),
                // 🖥 终端会话（点行进终端；⏹ 杀进程）
                h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h("div", { style: { fontSize: 14, fontWeight: 700, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.monitor), "终端会话"),
                  sessions.length === 0 ? h("p", { style: { ...smallStyle, margin: 0 } }, "（无活跃会话——点「＋ 新终端」开一个 shell，或执行一条命令）")
                  : sessions.map((s) =>
                    h("div", { key: s.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: "var(--bg-hover)", border: "1px solid var(--border)", cursor: "pointer" }, onClick: () => openView("pty", s.id, s.name || s.cmd) },
                      h("span", { style: { fontSize: 13, color: s.status === "running" ? "var(--ok, #4ade80)" : s.status === "queued" ? "var(--warn, #f59e0b)" : "var(--text-muted)" } }, s.status === "running" ? "●" : s.status === "queued" ? "⏳" : "■"),
                      h("div", { style: { flex: 1, minWidth: 0 } },
                        h("code", { style: { fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "$ " + s.cmd + (SANDBOX[s.sandbox || "none"] ? SANDBOX[s.sandbox || "none"].icon : "")),
                        h("span", { style: { fontSize: 13, color: "var(--text-muted)" } },
                          (sessionHostTabSync(s.id) ? "工作区页签 · " : "") +
                          (s.status === "queued" ? "排队中 (" + s.queuePosition + "/" + s.queueLength + ")" : (s.status === "running" ? "运行中" : "退出 " + (s.exitCode ?? "?")) + " · " + ((s.status === "running" ? Date.now() - s.startTs : s.durationMs || 0) / 1000).toFixed(0) + "s" + (s.sandbox ? " · " + (SANDBOX[s.sandbox] ? SANDBOX[s.sandbox].short : s.sandbox) : " · 无沙箱"))),
                      ),
                      (s.status === "running" || s.status === "queued") && h("button", { onClick: (e) => { e.stopPropagation(); killSession(s.id); }, disabled: killBusy.has(s.id), title: killBusy.has(s.id) ? "终止信号已发送，等待进程退出…" : s.status === "queued" ? "取消排队" : "终止命令（杀进程）", style: { ...btnStyle, color: "var(--danger, #ef4444)", padding: "2px 8px", opacity: killBusy.has(s.id) ? 0.6 : 1, cursor: killBusy.has(s.id) ? "wait" : "pointer" } }, killBusy.has(s.id) ? "⏳" : s.status === "queued" ? "取消" : "⏹"),
                    )),
                ),
                // ⚡ 常用命令：tag 云卡片（点击执行；颜色随标签，尺寸随使用次数微放大）——放最后
                commands.length > 0 && (() => {
                  const CLOUD_COLORS = ["#6366f1", "#0ea5e9", "var(--ok, #10b981)", "var(--warn, #f59e0b)", "var(--danger, #ef4444)", "#8b5cf6", "#ec4899", "#14b8a6", "var(--warn, #eab308)", "#06b6d4"];
                  const cloudColor = (s) => { let h = 0; const t = String(s || "?"); for (let i = 0; i < t.length; i++) h = (h * 31 + (t.codePointAt(i) || 0)) % 9973; return CLOUD_COLORS[h % CLOUD_COLORS.length]; };
                  const sorted = [...commands].sort((a, b) => (b.runCount || 0) - (a.runCount || 0) || String(a.name || a.cmd).localeCompare(String(b.name || b.cmd)));
                  const shown = sorted.slice(0, 30);
                  return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                    h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                      h("span", { style: { fontSize: 14, fontWeight: 700, color: "var(--text-muted)" } }, "常用命令"),
                      h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, sorted.length + " 条 · 点击执行"),
                      h("button", { onClick: () => setTab("commands"), title: "到命令页管理（新建/编辑/分组/标签）", style: { ...miniBtn, marginLeft: "auto" } }, "管理 →"),
                    ),
                    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5 } },
                      shown.map((c) => {
                        const tag = (c.tags && c.tags[0]) || "";
                        const base = cloudColor(tag || (c.name || c.cmd));
                        const weight = Math.min(3, c.runCount || 0);
                        return h("button", {
                          key: c.id,
                          onClick: () => runCommand(c),
                          title: "$ " + c.cmd + (c.cwd ? "  ·  " + c.cwd : "") + (c.confirm ? "（危险命令，执行前确认）" : "") + (c.runCount ? " · 已执行 " + c.runCount + " 次" : ""),
                          style: {
                            border: "1px solid " + base + "66", background: base + "1f", color: `color-mix(in srgb, ${base} 68%, var(--text))`,
                            borderRadius: 999, padding: weight ? "3px 11px" : "2px 9px", fontSize: 13 + weight, fontWeight: 500,
                            cursor: "pointer", fontFamily: "inherit",
                            maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          },
                        }, (c.name || c.cmd) + (c.confirm ? " ⚠" : ""));
                      }),
                      sorted.length > shown.length && h("span", { style: { ...smallStyle, alignSelf: "center" } }, "… 还有 " + (sorted.length - shown.length) + " 条"),
                    ),
                  );
                })(),
              );
          return h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 } },
            header,
            content,
          );
        })(),
        // 新建/编辑命令：弹窗（与消息识别的命令详情弹窗同模式：居中卡片 + 遮罩）
        // 布局：CSS Grid 两列表单（命令/沙箱等长字段跨双列）——flex-wrap 列宽
        // 不可控（曾把 textarea 挤成窄列），控件统一 flex:none+width:100%（inputStyle
        // 自带 flex:1，放进纵向 flex 容器会把输入框拉成 90px 高条）。
        editing && (() => {
          const set = (patch) => setEditing({ ...editing, ...patch });
          const ctl = (extra) => ({ ...inputStyle, flex: "none", width: "100%", boxSizing: "border-box", ...extra });
          const field = (label, control, hint, full) =>
            h("label", { style: { display: "flex", flexDirection: "column", gap: 4, gridColumn: full ? "1 / -1" : undefined, minWidth: 0 } },
              h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text-muted)" } }, label),
              control,
              hint && h("span", { style: { fontSize: 13, color: "var(--text-muted)", lineHeight: 1.4 } }, hint),
            );
          return h("div", {
            style: { position: "fixed", inset: 0, zIndex: 340, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
            onClick: () => setEditing(null),
          },
            h("div", {
              tabIndex: -1,
              "data-ext-float": "1", "data-ext-float-w": 540, "data-ext-float-autoh": "1", "data-ext-float-full": "1",
              style: { width: 540, maxWidth: "100%", maxHeight: "88vh", overflow: "auto", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", outline: "none" },
              onClick: (e) => e.stopPropagation(),
              onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); saveEditing(); } },
            },
              // 标题栏
              h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border)" } },
                h("span", { style: { width: 28, height: 28, borderRadius: 8, background: "var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700, color: "var(--accent)", flexShrink: 0 } }, "$"),
                h("div", { style: { flex: 1, minWidth: 0 } },
                  h("div", { style: { fontSize: 15, fontWeight: 700 } }, editing.id ? "编辑命令" : "新建命令"),
                  h("div", { style: { fontSize: 13, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, editing.groupId ? "📁 " + groupPathOf(editing.groupId) : "未分组"),
                ),
                h("button", { onClick: () => setEditing(null), title: "关闭 (Esc)", "aria-label": "关闭", style: { background: "transparent", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", color: "var(--text-muted)", fontSize: 16, cursor: "pointer", padding: "4px 8px", borderRadius: 4 } }, "✕"),
              ),
              // 表单区：两列 Grid（名称/分组/工作目录 前置；命令全宽居中）
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px", padding: "16px 18px" } },
                field("名称", h("input", { style: ctl(), value: editing.name, placeholder: "缺省 = 命令文本", onChange: (e) => set({ name: e.target.value }) })),
                field("分组", h("select", { style: ctl(), value: editing.groupId || "", onChange: (e) => set({ groupId: e.target.value || null }) },
                  h("option", { value: "" }, "（未分组）"),
                  groups.map((g) => h("option", { key: g.id, value: g.id }, groupPathOf(g.id))),
                )),
                field("工作目录", h("input", { style: ctl({ fontFamily: "var(--font-mono)" }), value: editing.cwd || "", placeholder: "缺省 = 当前会话目录", onChange: (e) => set({ cwd: e.target.value }) })),
                field("标签", h("input", { style: ctl(), value: editing.tags || "", placeholder: "逗号分隔，如 build, fe", onChange: (e) => set({ tags: e.target.value }) })),
                field("命令", h("textarea", { id: "aiti-cmd-edit-cmd", autoFocus: !editing.id, style: ctl({ minHeight: 72, fontFamily: "var(--font-mono)", resize: "vertical" }), value: editing.cmd, placeholder: "pnpm build --filter {pkg}", onChange: (e) => set({ cmd: e.target.value }) }), "支持 {参数} 占位符，执行时填入", true),
                field("沙箱", h("select", { style: ctl((editing.sandbox || "none") === "none" ? { borderColor: "var(--warn, #f59e0b)", background: "color-mix(in srgb, var(--warn, #f59e0b) 12%, transparent)", color: "var(--warn, #f59e0b)" } : null), value: editing.sandbox || "none", onChange: (e) => set({ sandbox: e.target.value }) },
                  SANDBOX_ORDER.map((v) => h("option", { key: v, value: v }, SANDBOX[v].label)),
                ), (() => { const m = SANDBOX[editing.sandbox || "none"] || SANDBOX.none; return h("span", { style: { fontSize: 13, lineHeight: 1.4, color: m.warn ? "var(--warn, #f59e0b)" : "var(--ok, #10b981)" } }, m.hint); })()),
                field("执行确认", h("button", {
                  type: "button",
                  onClick: () => set({ confirm: !editing.confirm }),
                  title: "执行前是否弹窗确认（危险命令建议开启）",
                  style: { ...ctl(), display: "flex", alignItems: "center", gap: 8, textAlign: "left", cursor: "pointer", padding: "6px 10px" },
                },
                  h("span", { style: { position: "relative", width: 32, height: 18, borderRadius: 999, background: editing.confirm ? "var(--warn, #f59e0b)" : "var(--border)", flexShrink: 0, transition: "background .15s" } },
                    h("span", { style: { position: "absolute", top: 2, left: editing.confirm ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left .15s" } }),
                  ),
                  h("span", { style: { fontSize: 13, color: "var(--text)" } }, editing.confirm ? "执行前弹窗确认" : "直接执行"),
                ), null),
                field("智能提示", h("button", {
                  type: "button",
                  onClick: () => set({ suggest: !editing.suggest }),
                  title: "作为 aiti-ai-input 智能提示（输入联想/补全）的来源；关掉后输入时不再提示此命令",
                  style: { ...ctl(), display: "flex", alignItems: "center", gap: 8, textAlign: "left", cursor: "pointer", padding: "6px 10px" },
                },
                  h("span", { style: { position: "relative", width: 32, height: 18, borderRadius: 999, background: editing.suggest ? "var(--accent)" : "var(--border)", flexShrink: 0, transition: "background .15s" } },
                    h("span", { style: { position: "absolute", top: 2, left: editing.suggest ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left .15s" } }),
                  ),
                  h("span", { style: { fontSize: 13, color: "var(--text)" } }, editing.suggest ? "参与智能提示" : "不参与智能提示"),
                ), "作为 aiti-ai-input 输入联想/补全的来源（默认开）", true),
              ),
              // 页脚
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" } },
                h("span", { style: { ...smallStyle, flex: 1 } }, editing.id ? "改动即时生效" : "保存后出现在命令列表对应分组"),
                h("button", { onClick: () => setEditing(null), style: { ...btnStyle, padding: "6px 14px" } }, "取消"),
                h("button", { onClick: saveEditing, disabled: !editing.cmd.trim(), style: { ...btnStyle, background: editing.cmd.trim() ? "var(--accent)" : "var(--bg-hover)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", padding: "6px 18px", fontWeight: 600, cursor: editing.cmd.trim() ? "pointer" : "not-allowed", opacity: editing.cmd.trim() ? 1 : 0.6 } }, editing.id ? "保存修改" : "创建"),
              ),
            ),
          );
        })(),
        // 新建/编辑分组：同弹窗模式（小卡片）
        editingGroup && (() => {
          const setG = (patch) => setEditingGroup({ ...editingGroup, ...patch });
          const ctl = (extra) => ({ ...inputStyle, flex: "none", width: "100%", boxSizing: "border-box", ...extra });
          const field = (label, control) =>
            h("label", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },
              h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text-muted)" } }, label),
              control,
            );
          return h("div", {
            style: { position: "fixed", inset: 0, zIndex: 340, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
            onClick: () => setEditingGroup(null),
          },
            h("div", {
              tabIndex: -1,
              "data-ext-float": "1", "data-ext-float-w": 460, "data-ext-float-autoh": "1", "data-ext-float-full": "1",
              style: { width: 460, maxWidth: "100%", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", outline: "none" },
              onClick: (e) => e.stopPropagation(),
              onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); setEditingGroup(null); } else if (e.key === "Enter") { e.preventDefault(); saveGroupEditing(); } },
            },
              h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border)" } },
                h("span", { style: { width: 28, height: 28, borderRadius: 8, background: "var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 } }, "📁"),
                h("div", { style: { flex: 1 } },
                  h("div", { style: { fontSize: 15, fontWeight: 700 } }, editingGroup.id ? "编辑分组" : "新建分组"),
                  h("div", { style: { fontSize: 13, color: "var(--text-muted)" } }, editingGroup.parentId ? "位于：" + groupPathOf(editingGroup.parentId) : "顶层分组"),
                ),
                h("button", { onClick: () => setEditingGroup(null), title: "关闭 (Esc)", "aria-label": "关闭", style: { background: "transparent", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", color: "var(--text-muted)", fontSize: 16, cursor: "pointer", padding: "4px 8px", borderRadius: 4 } }, "✕"),
              ),
              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px", padding: "16px 18px" } },
                field("分组名", h("input", { autoFocus: true, style: ctl(), value: editingGroup.name, placeholder: "如：构建 / 部署", onChange: (e) => setG({ name: e.target.value }) })),
                field("上级分组", h("select", { style: ctl(), value: editingGroup.parentId || "", onChange: (e) => setG({ parentId: e.target.value || null }) },
                  h("option", { value: "" }, "（顶层）"),
                  groups.filter((g) => g.id !== editingGroup.id).map((g) => h("option", { key: g.id, value: g.id }, groupPathOf(g.id))),
                )),
              ),
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" } },
                h("span", { style: { ...smallStyle, flex: 1 } }, "删除分组时组内命令自动移入未分组"),
                h("button", { onClick: () => setEditingGroup(null), style: { ...btnStyle, padding: "6px 14px" } }, "取消"),
                h("button", { onClick: saveGroupEditing, disabled: !editingGroup.name.trim(), style: { ...btnStyle, background: editingGroup.name.trim() ? "var(--accent)" : "var(--bg-hover)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", padding: "6px 18px", fontWeight: 600, cursor: editingGroup.name.trim() ? "pointer" : "not-allowed", opacity: editingGroup.name.trim() ? 1 : 0.6 } }, editingGroup.id ? "保存修改" : "创建"),
              ),
            ),
          );
        })(),
        ),
      ),
    );
  }

  // ---------- 命令详情面板（消息识别点开：点开/编辑/收藏/执行） ----------
  function CommandDetailPanel() {
    const detail = useDetail();
    const busy = useDetailBusy();
    const [name, setName] = useState("");
    const [cwd, setCwd] = useState("");
    const [confirm, setConfirm] = useState(false);
    const [groupId, setGroupId] = useState(null);
    const [groups, setGroups] = useState([]);
    const [saved, setSaved] = useState(false);
    const [err, setErr] = useState(null);
    const [info, setInfo] = useState(null);
    const [desc, setDesc] = useState(null);
    const [current, setCurrent] = useState(null); // 当前显示/管理的命令（点击 related 可切换）
    useEffect(() => { if (detail) { setName(""); setCwd(detail.cwd || ""); setConfirm(false); setGroupId(null); setSaved(false); setErr(null); setInfo(null); setDesc(null); setCurrent(detail.cmd); fetch(api("/commands")).then((r) => r.json()).then((d) => setGroups(d.groups || [])).catch(() => {}); } }, [detail]);
    // 随 current 刷新校验 + 描述（点击 related/peers 切换命令；detail 变化强制重跑——同命令重开也刷新）
    useEffect(() => { if (!current) return;
      fetch(api("/commands/check"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: current }) }).then((r) => r.json()).then((d) => { const c = d.single || (Array.isArray(d.commands) && d.commands[0]) || null; setInfo(c || null); }).catch(() => {});
      fetch(api("/commands/describe?text=" + encodeURIComponent(current))).then((r) => r.json()).then((d) => setDesc(d || null)).catch(() => {});
    }, [current, detail]);
    if (!detail) return null;
    // 分组路径（与命令面板一致）：如 "构建 / 前端"
    const groupPathOf = (id) => {
      if (!id) return "未分组";
      const parts = []; let cur = groups.find((g) => g.id === id); let guard = 0;
      while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parentId ? groups.find((g) => g.id === cur.parentId) : undefined; }
      return parts.join(" / ") || "未分组";
    };
    const doSave = async () => {
      setSaved(false); setErr(null);
      if (!current || !String(current).trim()) { setErr("命令内容为空，无法收藏"); return; }
      const r = await fetch(api("/commands"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name || current, cmd: current, cwd: cwd || undefined, groupId: groupId || null, confirm, sandbox: "none", source: "ai-message" }) }).then((x) => x.json());
      if (r.ok) setSaved(true); else setErr(r.error || "保存失败");
    };
    const doRun = async () => {
      const cmd = current;
      let r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd, cwd: cwd || undefined, source: "message", sandbox: "none" }) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
      if (r.needConfirm) {
        const danger = (r.danger || []).join("/");
        const ok = await uiConfirm({ message: `确认执行危险命令${danger ? "（" + danger + "）" : ""}？`, detail: `$ ${cmd}`, danger: true });
        if (!ok) return;
        r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd, cwd: cwd || undefined, source: "message", sandbox: "none", confirmToken: r.confirmToken }) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
      }
      if (!r.ok) { setErr(r.error || "运行失败"); return; }
      setState({ panelOpen: true, view: { kind: "pty", id: r.sessionId, title: cmd }, detail: null });
    };
    return h("div", {
      style: { position: "fixed", inset: 0, zIndex: 330, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
      onClick: () => setState({ detail: null }),
    },
      h("div", {
        "data-ext-float": "1", "data-ext-float-w": 460, "data-ext-float-h": 540, "data-ext-float-full": "1",
        style: { width: 460, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", overflow: "hidden" },
        onClick: (e) => e.stopPropagation(),
      },
        // 标题栏（统一风格）
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 } },
          h("span", { style: { width: 28, height: 28, borderRadius: 8, background: "var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 } }, "＋"),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: 15, fontWeight: 700 } }, "命令管理"),
            h("div", { style: { fontSize: 13, color: "var(--text-muted)" } }, "查看 / 收藏 / 编辑，不会直接执行"),
          ),
          h("button", { onClick: () => setState({ detail: null }), title: "关闭", "aria-label": "关闭", style: { ...btnStyle, padding: "2px 10px", background: "transparent", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", color: "var(--text-muted)" } }, "✕"),
        ),
        // 内容区
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: 14 } },
        h("p", { style: { ...smallStyle, marginBottom: 8, color: "var(--text-muted)" } }, "此面板用于 查看 / 收藏 / 编辑 命令，不会直接执行。"),
        current !== detail.cmd && h("div", { style: { ...rowStyle, marginBottom: 4 } },
          h("button", { onClick: () => setCurrent(detail.cmd), title: "返回原命令", style: { ...btnStyle, padding: "1px 8px", fontSize: 13 } }, "← 返回: " + detail.cmd.slice(0, 30)),
          h("span", { style: smallStyle }, "正在查看相关命令"),
        ),
        h("pre", { style: { background: "#0f172a", color: "#a5f3fc", padding: 10, borderRadius: 8, fontSize: 13, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "0 0 8px" } }, current),
        info && h("div", { style: { ...smallStyle, marginBottom: 8 } },
          info.exists === false
            ? h("span", { style: { color: "var(--danger, #ef4444)" } }, "command not found：" + info.cmd + " 未安装（PATH/项目 bin 中找不到）")
            : h("span", {}, "命令可识别" + (info.exists === true ? " · 已安装（PATH/项目 bin）" : "")),
          (info.params && info.params.length) ? h("span", {}, " · 参数: {" + info.params.join("}, {") + "}") : null,
          (info.danger && info.danger.length) ? h("span", {}, " · ⚠ 危险: " + info.danger.join("/")) : null,
        ),
        info && info.exists === false && info.installSuggestion && h("div", { style: { ...smallStyle, marginBottom: 8, background: "color-mix(in srgb, var(--danger, #ef4444) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--danger, #ef4444) 35%, transparent)", borderRadius: 6, padding: "6px 8px", color: "var(--danger, #ef4444)" } },
          h("span", { style: { fontWeight: 600 } }, "安装建议："), h("code", { style: { fontSize: 13 } }, info.installSuggestion),
          h("button", { onClick: () => { try { navigator.clipboard.writeText(info.installSuggestion); } catch {} }, style: { ...btnStyle, padding: "1px 8px", fontSize: 13, marginLeft: 6 } }, "复制"),
        ),
        desc && desc.found && h("div", { style: { ...smallStyle, marginBottom: 8, background: "var(--bg-hover)", borderRadius: 6, padding: "6px 8px" } },
          h("span", { style: { fontWeight: 600 } }, "📂 " + desc.name + " · " + desc.group + ""),
          desc.desc ? h("span", { style: { marginLeft: 6 } }, desc.desc) : null,
          desc.related && desc.related.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 } },
            h("span", { style: { fontSize: 13, color: "var(--text-muted)", marginRight: 2 } }, "常用:"),
            desc.related.map((p) => h("button", { key: p, type: "button", onClick: () => setCurrent(p), title: "点击查看/管理此命令", style: { fontSize: 13, background: "var(--bg)", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--border)", color: "var(--accent)", cursor: "pointer" } }, p)))
          : null,
          desc.peers && desc.peers.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 } },
            h("span", { style: { fontSize: 13, color: "var(--text-muted)", marginRight: 2 } }, "同类:"),
            desc.peers.map((p) => h("button", { key: p, type: "button", onClick: () => setCurrent(p), title: "点击查看/管理此命令", style: { fontSize: 13, background: "var(--bg)", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--border)", color: "var(--accent)", cursor: "pointer" } }, p)))
          : null,
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 } },
          h("input", { style: inputStyle, value: name, placeholder: "收藏名称（默认=命令文本）", onChange: (e) => setName(e.target.value) }),
          h("select", { style: inputStyle, value: groupId || "", title: "收藏到哪个分组", onChange: (e) => setGroupId(e.target.value || null) },
            h("option", { value: "" }, "（未分组）"),
            groups.map((g) => h("option", { key: g.id, value: g.id }, groupPathOf(g.id))),
          ),
          h("input", { style: inputStyle, value: cwd, placeholder: "cwd（缺省=当前会话目录）", onChange: (e) => setCwd(e.target.value) }),
          h("label", { style: { fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4 } }, h("input", { type: "checkbox", checked: confirm, onChange: (e) => setConfirm(e.target.checked) }), "危险命令执行前确认"),
        ),
        err && h("p", { style: { ...smallStyle, color: "var(--danger, #ef4444)", marginBottom: 6 } }, String(err)),
        h("div", { style: { display: "flex", gap: 8 } },
          h("button", { onClick: doSave, style: { ...btnStyle, background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", flex: 1 } }, saved ? "已收藏" : "＋ 收藏到常用命令"),
          h("button", { onClick: doRun, style: { ...btnStyle, flex: 1, color: "var(--accent)" } }, busy ? "…" : "▶ 单独执行"),
        ),
        h("p", { style: { ...smallStyle, marginTop: 8 } }, "收藏后可在 ⚡ 命令面板随时一键调用（不依赖 AI）；执行记录全部写入审计日志。"),
        ),
      ),
    );
  }

  // ---------- 工具栏按钮 ----------
  // ---------- 工作区终端页签（dock 位）：单实例渲染归属状态机 ----------
  // dock 方案（docs/aiti-web-ext-float-dock-plan.md）的 terminal 专项二态版：
  // 一个 pty 会话任一时刻只渲染在「工作区终端页签」（右侧文件区 dock 位）或
  // 「aiti-cmd 弹窗」其一——tabAttached[tabId] 记归属会话，detached[tabId] 标记
  // 「已拉回窗口」。两处渲染互为占位（结构性防双开）。
  const tabAttached = {};   // { [tabId]: { sessionId, title, cwd } | undefined }
  const tabDetached = {};   // { [tabId]: true } —— true = 视图在弹窗（页签显示占位）
  const tabAttachedListeners = new Set();
  function notifyTabAttached() { for (const l of tabAttachedListeners) l(); }
  // tabId→sessionId 绑定持久化（sessionStorage，与宿主 pi-web:terminal-tabs 同生命周期）：
  // 刷新后宿主按原 tabId 恢复页签（restored），绑定记录随之找回同一 shell 会话——
  // TerminalView 经 SSE /stream 的 buffered 回放续上历史输出，不再重开新 shell。
  const DOCK_TABS_KEY = "pi-web:aiti-cmd:terminal-dock";
  const saveTabAttached = () => { try { sessionStorage.setItem(DOCK_TABS_KEY, JSON.stringify(tabAttached)); } catch {} };
  try {
    const saved = JSON.parse(sessionStorage.getItem(DOCK_TABS_KEY) || "null");
    if (saved && typeof saved === "object") for (const [tid, e] of Object.entries(saved)) if (e && e.sessionId) tabAttached[tid] = e;
    // 孤儿清理：宿主页签记录里已不存在的 tabId（页签被关但清理 effect 未及跑）→ 丢弃绑定
    const hostTabs = JSON.parse(sessionStorage.getItem("pi-web:terminal-tabs") || "null");
    const hostIds = new Set(((hostTabs && Array.isArray(hostTabs.tabs)) || []).map((t) => t && t.id).filter(Boolean));
    for (const tid of Object.keys(tabAttached)) if (!hostIds.has(tid)) delete tabAttached[tid];
  } catch {}
  // entry 增删唯一入口（内存 + 持久化 + 通知）；detached 标记是纯内存视图归属，不持久化——
  // 刷新后统一回「页签持有」态（视图回页签，要弹窗再点 ⇲）。
  function setTabEntry(tabId, entry) { tabAttached[tabId] = entry; delete tabDetached[tabId]; saveTabAttached(); notifyTabAttached(); }
  function clearTabEntry(tabId) { if (!(tabId in tabAttached) && !(tabId in tabDetached)) return; delete tabAttached[tabId]; delete tabDetached[tabId]; saveTabAttached(); notifyTabAttached(); }
  // 非 hook 版：会话当前是否被某页签持有（弹窗总览列表标「页签」徽标用）
  function sessionHostTabSync(sessionId) { for (const [tid, e] of Object.entries(tabAttached)) if (e && e.sessionId === sessionId && tabDetached[tid] !== true) return tid; return null; }
  // 待接管队列：弹窗「转到页签」push → openShellTab 新建页签 → 新页签 effect 按 cwd 消费，
  // 绑定既有会话（不另起新 shell）。带时间戳 TTL：宿主拒绝建页签/时序异常时残留自动过期。
  const pendingTakeovers = []; // { cwd, sessionId, title, ts }
  const PENDING_TAKEOVER_TTL = 15000;
  function useTabAttachedState(tabId) {
    const [v, setV] = useState(() => ({ entry: tabAttached[tabId] || null, detached: tabDetached[tabId] === true }));
    useEffect(() => {
      const l = () => setV({ entry: tabAttached[tabId] || null, detached: tabDetached[tabId] === true });
      tabAttachedListeners.add(l);
      l();
      return () => tabAttachedListeners.delete(l);
    }, [tabId]);
    return v;
  }
  // 弹窗侧：该 pty 会话是否正被某页签持有（未 detach）——是则渲染占位卡
  function useSessionHostTab(sessionId) {
    const [hostTabId, setHostTabId] = useState(() => sessionHostTabSync(sessionId));
    useEffect(() => {
      const l = () => setHostTabId(sessionHostTabSync(sessionId));
      l(); // sessionId 变化（进详情）时立即求值——不等下一次归属变更通知
      tabAttachedListeners.add(l);
      return () => tabAttachedListeners.delete(l);
    }, [sessionId]);
    return hostTabId;
  }

  // 页签专用建 shell（§3.3 同 createShell 走后端 /shell；不开弹窗、不切 view——归属由调用方决定）
  async function createShellSession(cwd) {
    const r = await fetch(api("/shell"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cwd || undefined, name: "bash" }) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
    if (!r || !r.ok || !r.sessionId) throw new Error((r && r.error) || "创建终端失败");
    return { sessionId: r.sessionId, title: r.name || "bash" };
  }

  // 工作区终端页签宿主组件（terminalDock 插槽 render）：真接管——页签内直接渲染终端视图。
  // openShellTab：宿主回调（TerminalPanelBridge 透传）——「＋ 新建」同 cwd 强制新开 shell 页签；缺席（旧宿主）时不渲染入口。
  function WorkspaceTerminalHost({ cwd, tabId, active, restored, onClosed, openShellTab }) {
    const attached = useTabAttachedState(tabId);
    const triedRef = useRef(false);
    const attachingRef = useRef(false); // 同事件循环双击守卫（state 异步更新，闭包值滞后）
    const [attaching, setAttaching] = useState(false);
    const [error, setError] = useState(null);
    const attach = async () => {
      if (attachingRef.current) return;
      attachingRef.current = true;
      setAttaching(true);
      setError(null);
      try {
        const entry = await createShellSession(cwd);
        setTabEntry(tabId, entry);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        attachingRef.current = false;
        setAttaching(false);
      }
    };
    // 首次激活自动接管，分三路（详见 effect 内注释）：① 弹窗「转到页签」待接管；
    // ② 持久化恢复绑定的活性验证；③ 无绑定时新建（restored 出按钮不静默起）。
    useEffect(() => {
      if (!active || triedRef.current) return;
      // ① 弹窗「转到页签」的待接管（同 cwd 新建的本页签）：绑定既有会话即收，不另起新 shell。
      //    forceNew 建的新 tabId 此刻必然 triedRef=false 且 active（宿主建后即激活），
      //    同 cwd 旧页签要么已 tried 要么非激活，不会抣。
      const now = Date.now();
      for (let i = 0; i < pendingTakeovers.length; i++) {
        if (now - pendingTakeovers[i].ts >= PENDING_TAKEOVER_TTL) { pendingTakeovers.splice(i, 1); i--; }
      }
      const pIdx = pendingTakeovers.findIndex((p) => p.cwd === cwd);
      if (pIdx >= 0) {
        triedRef.current = true;
        const p = pendingTakeovers.splice(pIdx, 1)[0];
        setTabEntry(tabId, { sessionId: p.sessionId, title: p.title, cwd });
        return;
      }
      // ② 持久化恢复的绑定（刷新后 attached.entry 从 sessionStorage 找回）：单查会话活性——
      //    活着/已退出都不动（TerminalView 渲染后 SSE 重连回放 / exit 事件→onExit 清绑定），
      //    404（服务端重启/超时被清）才清掉绑定，回落到③的按钮态。不弹新建，不静默重建。
      if (attached.entry && !attached.detached) {
        triedRef.current = true;
        const sid = attached.entry.sessionId;
        fetch(api("/sessions/" + sid)).then((r) => (r.ok ? r.json() : null)).then((d) => {
          if (d && d.ok && (d.status === "running" || d.status === "queued" || d.status === "exit")) return;
          clearTabEntry(tabId); // 会话已不存在：绑定失效，出「接管到页签」（点击新建）
        }).catch(() => {}); // 网络异常：保留绑定，交由 TerminalView 的 SSE 自动重连
        return;
      }
      // ③ 无绑定：原版语义——新页签自动起 shell；restored 恢复页签不静默起，出「接管到页签」按钮。
      if (restored || attached.entry || attachingRef.current) return;
      triedRef.current = true;
      void attach();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, restored, attached.entry]);
    // 页签关闭：宿主移除页签（closing effect 调 onClosed）→ 本组件卸载 → cleanup 释放
    // 归属记录（shell 会话不死，仍可在弹窗总览里继续）。onClosed 由宿主负责调用时机。
    useEffect(() => () => clearTabEntry(tabId), [tabId]);

    const detachedEntry = attached.entry && attached.detached;
    // 拉回窗口：归属切到弹窗并直接打开该会话视图（「detach 之后窗口就可以用了」）
    const pullBackToPanel = () => {
      if (!attached.entry) return;
      tabDetached[tabId] = true;
      notifyTabAttached();
      setState({ panelOpen: true, view: { kind: "pty", id: attached.entry.sessionId, title: attached.entry.title }, detail: null });
    };
    // 接管到页签：归属切回页签（弹窗侧该会话自动变占位）
    const takeBackToTab = () => {
      tabDetached[tabId] = false;
      notifyTabAttached();
    };

    // 头行（dock 方案 DockBody chrome="tab" 同构：标题 + ⇲ 拉回；页签 ✕ 归 TabBar，防双 ✕）
    let body;
    if (!attached.entry) {
      body = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, color: "var(--text-dim)", fontSize: 12 } },
        h("div", { title: cwd, style: { display: "flex", alignItems: "center", gap: 6, maxWidth: "100%", overflow: "hidden", color: "var(--text-muted)" } },
          h("span", { style: { display: "inline-flex", flexShrink: 0 } }, Ic(14, ICONS.monitor)),
          h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, cwd),
        ),
        attaching ? h("span", null, "正在启动 shell…")
        : h("button", { onClick: attach, style: { ...btnStyle, padding: "6px 14px", background: "var(--bg-hover)", borderColor: "var(--border)", color: "var(--accent)", fontWeight: 600, fontSize: 12 } },
            "接管到页签",
          ),
        error && h("span", { role: "alert", style: { color: "var(--danger, #ef4444)" } }, error),
        h("span", { style: { fontSize: 11, color: "var(--text-muted)" } }, "shell 由 aiti-cmd 承载 · 24h 会话"),
      );
    } else if (detachedEntry) {
      // 已拉回窗口：页签显示占位（单实例——视图此刻归弹窗）
      body = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, color: "var(--text-dim)", fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" } },
          h("span", { style: { display: "inline-flex", flexShrink: 0 } }, Ic(14, ICONS.monitor)),
          h("span", null, attached.entry.title + " 已在 aiti-cmd 窗口打开"),
        ),
        h("button", { onClick: takeBackToTab, style: { ...btnStyle, padding: "6px 14px", color: "var(--accent)", fontWeight: 600, fontSize: 12 } }, "接管到页签"),
        h("span", { style: { fontSize: 11, color: "var(--text-muted)" } }, "终端同时只能在一处显示；接管后窗口内该终端变为占位"),
      );
    } else {
      // 无独立头行（双标题栏收敛）：标题/目录已在页签栏与工具条（📁 cwd），操作收进 TerminalView
      // 工具条右侧（＋ 新建 · ⇲ 拉回窗口 · ⛶ 最大化）。
      body = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" } },
        h(TerminalView, {
          sessionId: attached.entry.sessionId,
          height: "100%",
          onExit: () => clearTabEntry(tabId),
          pullBack: pullBackToPanel,
          // 「＋ 新建」@ 当前终端实时路径（实时 pwd）：先查再开新页签
          onNewShell: typeof openShellTab === "function" && attached.entry ? () => { void liveCwdOf(attached.entry.sessionId, cwd).then((live) => openShellTab(live || cwd)); } : undefined,
          // 「💬 新会话」新建 pi-web 会话并 @ 同一实时路径（宿主通道 openNewPiSession）
          onNewPiSession: attached.entry ? () => { void liveCwdOf(attached.entry.sessionId, cwd).then((live) => { openNewPiSession(live || cwd); }); } : undefined,
        }),
      );
    }
    return h("div", { style: { height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "#0f172a" } }, body);
  }

  function ToolbarButton() {
    return h("button", {
      onClick: () => setState({ panelOpen: true, view: null }), // 重开面板回总览列表（旧详情视图可能已过期——会话死了会无限重连）
      style: topbarBtnStyle,
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-muted)"; },
      title: "aiti-cmd：运行总览 / 常用命令 / 执行记录",
    },
      // lucide terminal：命令终端——与系统内建线条图标同风格
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("polyline", { points: "4 17 10 11 4 5" }),
        h("line", { x1: 12, y1: 19, x2: 20, y2: 19 })));
  }

  // 懒加载 v2 M3批②：声明式条目（无 render）——宿主渲染静态按钮，点击经转发器到本 onClick
  ctx.registerItems("toolbar", [{
    id: "aiti-cmd-open",
    meta: {
      label: "常用命令",
      title: "aiti-cmd：运行总览 / 常用命令 / 执行记录",
      icon: { svg: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
      // 重开面板回总览列表（旧详情视图可能已过期——会话死了会无限重连）
      onClick: () => setState({ panelOpen: true, view: null }),
    },
  }]);
  ctx.registerItems("dialogs", [
    { id: "aiti-cmd-panel", render: CommandPanel },
    { id: "aiti-cmd-detail", render: CommandDetailPanel },
  ]);
  // 工作区终端页签内容接管（terminalDock）：真接管——页签内直接渲染终端视图；
  // tab⇄弹窗单实例二选一（归属状态机见 WorkspaceTerminalHost），双向占位。
  ctx.registerItems("terminalDock", [{ id: "workspace-terminal", render: WorkspaceTerminalHost }]);
}
