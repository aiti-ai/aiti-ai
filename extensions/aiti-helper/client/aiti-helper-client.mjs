/**
 * aiti-helper client —— AI 输入 dialog + 历史管理 + 全局弹窗 AI 按钮（M2 核心）
 *
 * 设计：docs/aiti-ai-helper-plan.md §4.3（invoke → 审核 → 落地）+ §4.4（全局弹窗 AI 按钮）
 *
 * 架构：
 *   扩展/用户 → window.__aitiHelperInvoke({system, placeholder, helper}) → 弹 AI dialog
 *   → 用户描述 → POST /api/extensions/aiti-helper/invoke
 *   → server 新建全功能 agent session（系统提示词+工具+文件访问）→ onAgentSettled → text
 *   → 预览区显示 → [入库] [填入聊天框] [复制] [重来]
 *
 * 独立置顶弹窗（用户要求）：
 *   - 顶部工具条 🤖 按钮（不放输入框，避免与 suggest 冲突）
 *   - dialog 常驻置顶：不随 session 切换关闭、可拖拽移动、失焦半透明、无全屏遮罩
 *
 * 历史管理（用户要求）：
 *   - server 持久化 invoke 历史（history.jsonl）——关闭不丢
 *   - dialog 内「历史」tab：查看历史、恢复结果、补落地（入库/填入/复制）
 */
export default function register(ctx) {
  const { h, useState, useEffect, useRef, useCallback } = ctx;

  // ==================== 全局状态（跨组件通信：invoke 入口 ↔ dialog 渲染） ====================
  const _state = {
    open: false,
    opts: null,        // { system?, placeholder?, contextLabel?, helperId? }
    lastResult: "",
    loading: false,
    error: null,
    historyId: null,   // 当前结果对应历史记录 id（落地时回传标记）
    sessionId: null,   // 当前结果对应的 agent 会话 id（追问 steer 同一会话，上下文完整延续）
    dialogEl: null,    // 触发本次 invoke 的弹窗元素（fill 回填用）
    pageId: null,      // 当前发起页面在 aiti-devtools 桥里的 pageId（如 xxx/ai、xxx/host）——预取后随 invoke 报告
    isAiWin: false,    // 是否 AI 主窗口（xxx/ai）
    pos: { x: null, y: null },  // 弹窗位置（null=默认右上角）
    dim: false,        // 失焦半透明
    activeTab: "ai",   // "ai" | "history"
  };
  const _listeners = new Set();
  const notify = () => _listeners.forEach((fn) => fn());

  // lucide 图标（与系统内建线条图标同风格）
  const Ic = (size, paths) => {
    const el = h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths.map((d, i) => h("path", { key: i, d })));
    if (el._store) el._store.validated = 1;
    return el;
  };
  const ICONS = {
    sparkles: ["M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z", "M20 3v4", "M22 5h-4"],
    clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    help: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"],
    plus: ["M5 12h14", "M12 5v14"],
    bot: ["M12 8V4H8", "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
    copy: ["M8 8H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2", "M14 2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6l-4-4z", "M14 2v6h6"],
    msg: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
    refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
  };

  /** 外部调用入口：扩展/弹窗 AI 按钮/suggest 兜底 都经此唤起 */
  window.__aitiHelperInvoke = function (opts = {}) {
    _state.open = true;
    _state.opts = opts;
    _state.lastResult = "";
    _state.loading = false;
    _state.error = null;
    _state.historyId = null;
    _state.sessionId = null;
    _state.activeTab = "ai";
    _state.dim = false;
    // opts.dialogEl：从弹窗 AI 按钮唤起时带上目标弹窗（fill 回填用）
    _state.dialogEl = opts.dialogEl || null;
    notify();
    return true;
  };
  /** suggest AI 兜底接入（aiti-ai-input 无静态命中时调用） */
  window.__aitiSuggestAiFallback = function (q) {
    window.__aitiHelperInvoke({
      system: "用户在聊天输入框打字但没命中收藏命令/prompt。请根据用户输入生成一条有用的简短建议（命令或 prompt 文本），只输出建议内容本身，不加解释。",
      placeholder: "AI 生成中…（基于「" + q + "」）",
      contextLabel: "suggest 兜底：「" + q + "」",
    });
  };

  const close = () => { _state.open = false; notify(); };

  // ==================== AI Dialog 组件（独立置顶弹窗） ====================
  function AiHelperDialog(props) {
    const [, force] = useState(0);
    useEffect(() => {
      const fn = () => force((n) => n + 1);
      _listeners.add(fn);
      return () => _listeners.delete(fn);
    }, []);

    const isOpen = _state.open;
    const opts = _state.opts || {};

    const [input, setInput] = useState("");
    const [followup, setFollowup] = useState("");   // 追问输入
    const [turns, setTurns] = useState([]);           // 多轮对话历史 [{message, result, system}]（不含当前轮）
    const [helpers, setHelpers] = useState(null);
    const [selHelper, setSelHelper] = useState(null);
    const [viewingSkill, setViewingSkill] = useState(null);   // 正在查看的 skill 说明 {id,title,body,summary}
    const [skillLoading, setSkillLoading] = useState(false);
    const [showSkillForm, setShowSkillForm] = useState(false);  // 新增 skill 表单显隐
    const [skillForm, setSkillForm] = useState({ name: "", owner: "", title: "", summary: "", body: "" });
    const [savingSkill, setSavingSkill] = useState(false);
    const [skillMsg, setSkillMsg] = useState(null);            // {status, msg} 保存反馈
    const [historyList, setHistoryList] = useState(null);   // 历史列表
    const taRef = useRef(null);
    const panelRef = useRef(null);
    const dragRef = useRef(null); // { startX, startY, origX, origY }

    // 拉取帮助点列表（打开时拉）
    useEffect(() => {
      if (!isOpen) return;
      let alive = true;
      fetch(ctx.apiUrl("/api/extensions/aiti-helper/helpers"), { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (alive && d.ok) setHelpers(d.helpers || []); })
        .catch(() => {});
      return () => { alive = false; };
    }, [isOpen]);

    // 历史 tab 打开时拉历史
    useEffect(() => {
      if (!isOpen || _state.activeTab !== "history") return;
      let alive = true;
      fetch(ctx.apiUrl("/api/extensions/aiti-helper/history?limit=50"), { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (alive && d.ok) setHistoryList(d.history || []); })
        .catch(() => {});
      return () => { alive = false; };
    }, [isOpen, _state.activeTab]);

    const loading = _state.loading;
    const result = _state.lastResult;
    const err = _state.error;
    const activeTab = _state.activeTab;
    const dim = _state.dim;
    const pos = _state.pos;

    // 收集当前会话完整上下文（传给新 AI session）
    // dialog 挂 pages slot：props.activeCwd = 当前会话工作目录（toolbar slot 只有 currentSession:null）
    const sessionCtx = {
      sessionId: props.currentSession?.id || props.sessionId || null,
      cwd: opts.cwd || props.activeCwd || props.currentSession?.cwd || props.cwd || null,
      sessionName: props.currentSession?.name || props.sessionName || null,
      model: props.model || null,
      inputValue: props.inputValue || null,
      isStreaming: props.isStreaming || false,
    };

    const doInvoke = useCallback(async (isFollowup = false) => {
      prefetchPageId();   // 确保发起方 pageId 最新（重试拿桥 sessions 匹配当前页面）
      const text = (isFollowup ? followup : input).trim();
      if (!text || loading) return;
      // 追问：把当前这轮（原要求+结果）并入 turns 作为手工上下文（fallback 用）
      let prevTurns = turns;
      if (isFollowup && result) {
        prevTurns = [...turns, { message: input, result: result, system: selHelper?.system || opts.system }];
        setTurns(prevTurns);
        setInput(text);            // 主输入框改为追问内容（保持可见）
        setFollowup("");          // 清空追问框
      }
      _state.loading = true; _state.error = null; _state.lastResult = ""; _state.historyId = null; notify();
      try {
        let data = null;
        // 追问优先：复用同一 agent 会话 steer 继续（AI 记得前几轮，上下文完整）——会话被回收则 404 回落
        if (isFollowup && _state.sessionId) {
          const fr = await fetch(ctx.apiUrl("/api/extensions/aiti-helper/followup"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: _state.sessionId, message: text, contextLabel: opts.contextLabel || null }),
          });
          data = await fr.json().catch(() => null);
          if (!data || !data.ok) {
            if (data && data.code === "session_gone") _state.sessionId = null;  // 回收 → 下次新建
            data = null;  // 回落 invoke（带手工 prevTurns）
          }
        }
        if (!data) {
          const r = await fetch(ctx.apiUrl("/api/extensions/aiti-helper/invoke"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              system: selHelper?.system || opts.system,
              message: text,
              contextLabel: opts.contextLabel || null,
              helperId: selHelper?.id || opts.helperId || null,
              prevTurns,   // 手工上下文（新建 session 时给 AI 前几轮要求与回复）
              sessionCtx,
              sourcePageId: _state.pageId || null,   // 发起方 pageId（如 xxx/ai），报告给 AI
              sourceIsAiWin: _state.isAiWin || false,
            }),
          });
          data = await r.json();
        }
        if (!data.ok) throw new Error(data.error + (data.debug ? " | " + JSON.stringify(data.debug) : ""));
        _state.lastResult = data.text || "";
        _state.sessionId = data.sessionId || null;   // 记住 agent 会话（追问继续用）
        // 拉最新历史拿 id（invoke 成功已写历史）——最新记录即本次
        try {
          const hr = await fetch(ctx.apiUrl("/api/extensions/aiti-helper/history?limit=3"), { cache: "no-store" });
          const hd = await hr.json();
          if (hd.ok && hd.history && hd.history[0]) _state.historyId = hd.history[0].id;
        } catch {}
      } catch (e) {
        _state.error = String(e.message || e);
      } finally {
        _state.loading = false; notify();
      }
    }, [input, followup, turns, result, loading, opts, sessionCtx, selHelper]);

    // 落地到 API / 回填弹窗表单（帮助点 action）——共享给当前结果与历史恢复
    const [landing, setLanding] = useState(null);
    // 按 label/placeholder/name/id 在弹窗里找表单字段（打分匹配：label 优先，placeholder/name 兜底）
    const findField = useCallback((dialog, label) => {
      const els = dialog.querySelectorAll("input, textarea, select, [contenteditable=\"true\"], [contenteditable=\"plaintext-only\"], [contenteditable=\"\"]");
      const key = String(label).toLowerCase().trim();
      if (!key) return null;
      let best = null; let bestScore = 0;
      for (const el of els) {
        const lblEl = el.closest("label");
        const labelText = lblEl ? (lblEl.textContent || "").trim().toLowerCase() : "";
        const ph = (el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("aria-label") || "").toLowerCase();
        const elName = (el.getAttribute("name") || "").toLowerCase();
        const elId = (el.id || "").toLowerCase();
        let score = 0;
        if (labelText === key) score = 4;
        else if (labelText && labelText.includes(key)) score = 3;
        else if (key.includes(labelText) && labelText.length >= 2) score = 2;  // label 是 key 的子串（如 label="命令"，key="命令内容"）
        if (ph === key) score = Math.max(score, 3);
        else if (ph && ph.includes(key)) score = Math.max(score, 1);
        if (elName === key) score = Math.max(score, 3);
        else if (elName && elName.includes(key)) score = Math.max(score, 1);
        if (elId === key) score = Math.max(score, 3);
        else if (elId && elId.includes(key)) score = Math.max(score, 1);
        if (score > bestScore) { best = el; bestScore = score; }
      }
      return bestScore >= 2 ? best : null;  // 只有强匹配（label/精确）才返回，防 placeholder 误伤
    }, []);
    // 写入可编辑元素：React 兼容“真实键入”（等价 CDP Input.insertText）——contenteditable（富文本/<p> 可编辑块）
    // focus + execCommand('insertText')（浏览器原生输入路径，React onChange 正确接收）；input/textarea 原生原型 setter
    const setNativeValue = useCallback((el, value) => {
      const text = String(value == null ? "" : value);
      if (el.isContentEditable || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT" && el.hasAttribute && el.hasAttribute("contenteditable"))) {
        try { el.focus(); } catch (e) {}
        try {
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        } catch (e) {}
        let done = false;
        try { done = document.execCommand("insertText", false, text); } catch (e) {}
        if (!done) {
          try { el.textContent = text; } catch (e) {}
          try { el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })); }
          catch (e) { try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (e2) {} }
        }
        el.style.outline = "2px solid var(--accent,#2563eb)";
        el.style.outlineOffset = "1px";
        setTimeout(() => { el.style.outline = ""; }, 1800);
        return;
      }
      const proto = (el.tagName === "TEXTAREA")
        ? window.HTMLTextAreaElement.prototype
        : (el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype);
      try {
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, text);
      } catch (e) { el.value = text; }
      el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      el.style.outline = "2px solid var(--accent,#2563eb)";
      el.style.outlineOffset = "1px";
      setTimeout(() => { el.style.outline = ""; }, 1800);
    }, []);
    // 回填弹窗表单：AI JSON { field: value } → 按 label 匹配填充
    // action.fields 结构：数组（字符串=直接当 label 匹配）或 [{ key, label }]（AI key → 表单 label）
    const doFill = useCallback((parsed, action) => {
      const dialog = _state.dialogEl;
      if (!dialog || !document.body.contains(dialog)) { setLanding({ status: "err", msg: "原弹窗已关闭，无法回填（请从弹窗 AI 按钮唤起）" }); return 0; }
      const fields = action.fields || null;
      const mapping = action.mapping || null;   // 兼容：{ aiKey: label }
      let filled = 0; let missed = 0;
      for (const [aiKey, val] of Object.entries(parsed)) {
        if (val === undefined || val === null) continue;
        // 决定目标 label：fields[{key,label}] → 用其 label；fields[字符串] → 直接当 label；mapping → label；否则用 AI key
        let targetLabel = null;
        if (Array.isArray(fields) && typeof fields[0] === "object") {
          const f = fields.find((x) => x.key === aiKey || (x.label && String(x.label).toLowerCase() === aiKey.toLowerCase()));
          if (f) targetLabel = f.label || aiKey;
        } else if (Array.isArray(fields)) {
          if (!fields.some((x) => String(x).toLowerCase() === aiKey.toLowerCase())) continue;  // 不在声明内则跳过
          targetLabel = aiKey;
        } else if (mapping) {
          targetLabel = mapping[aiKey] || aiKey;
        } else { targetLabel = aiKey; }
        const el = findField(dialog, targetLabel || aiKey);
        if (el) { setNativeValue(el, val); filled++; }
        else missed++;
      }
      return filled;
    }, [findField, setNativeValue]);
    const doLand = useCallback(async (resultText, helper, historyId) => {
      if (!resultText || !helper?.action) { setLanding({ status: "err", msg: "该条无落地动作（自由发挥结果）" }); return; }
      const action = helper.action;
      let parsed = null;
      try {
        let t = resultText.trim();
        t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        parsed = JSON.parse(t);
      } catch (e) {
        setLanding({ status: "err", msg: "结果不是有效 JSON：" + (e.message || e) });
        return;
      }
      // action: fill → 回填弹窗表单（AI 输出两种：①工具链已填，filled 对象确认；②未填，{字段:值} 让前端兜底）
      if (action.type === "fill") {
        // 工具链已填：parsed.filled = {字段: 值}（确认报告）；未填时直接回填 parsed 本体
        const source = (parsed && typeof parsed === "object" && parsed.filled && typeof parsed.filled === "object")
          ? parsed.filled
          : parsed;
        const filled = doFill(source, action);
        const detail = filled > 0
          ? "已回填 " + filled + " 个表单字段" + (parsed.note ? "（" + parsed.note + "）" : "")
          : (parsed.note ? parsed.note : "没有可回填的字段（AI 输出需为 {字段:值} JSON）");
        setLanding({ status: filled > 0 ? "ok" : "info", msg: detail });
        if (historyId) {
          try { await fetch(ctx.apiUrl("/api/extensions/aiti-helper/history/" + historyId + "/land"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ detail }) }); } catch {}
        }
        return;
      }
      // action: api → POST 落地（现状）
      try {
        const body = {};
        if (action.mapping) {
          for (const [aiKey, apiKey] of Object.entries(action.mapping)) {
            if (parsed[aiKey] !== undefined) body[apiKey] = parsed[aiKey];
          }
        } else { Object.assign(body, parsed); }
        // path 支持 {field} 占位符（如 /commands/{id}）：用 body 里的值替换，并从 body 移除（避免路径字段重复进 body）
        let path = action.path.startsWith("/api/") ? action.path : "/api/" + action.path;
        const placeholders = path.match(/\{[a-zA-Z0-9_]+\}/g) || [];
        for (const ph of placeholders) {
          const key = ph.slice(1, -1);
          if (body[key] !== undefined) { path = path.replace(ph, encodeURIComponent(String(body[key]))); delete body[key]; }
        }
        const url = ctx.apiUrl(path);
        const r = await fetch(url, {
          method: action.method || "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || (d && d.ok === false)) {
          setLanding({ status: "err", msg: "入库失败：" + ((d && d.error) || r.status) });
        } else {
          const detail = "已入库" + (d && d.command ? "：「" + (d.command.name || d.command.cmd) + "」" : "");
          setLanding({ status: "ok", msg: detail });
          // 标记历史已落地
          if (historyId) {
            try { await fetch(ctx.apiUrl("/api/extensions/aiti-helper/history/" + historyId + "/land"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ detail }) }); } catch {}
          }
        }
      } catch (e) {
        setLanding({ status: "err", msg: "入库异常：" + (e.message || e) });
      }
    }, [ctx, doFill]);

    const adoptChat = useCallback((text) => {
      if (!text) return;
      try { ctx.sendChatMessage(text, "steer"); } catch (e) {}
      close();
    }, [ctx]);

    const copyResult = useCallback((text) => {
      if (!text) return;
      try { navigator.clipboard.writeText(text); } catch (e) {}
    }, []);

    const retry = useCallback(() => {
      _state.lastResult = ""; _state.error = null; notify();
      setTurns([]); setFollowup("");
      if (taRef.current) taRef.current.focus();
    }, []);

    // 查看某帮助点（skill）的说明：调 /skill/<id> 读 SKILL.md 正文 → 展示说明面板
    const viewSkill = useCallback(async (helper) => {
      if (!helper || !helper.id) return;
      setSkillLoading(true);
      setViewingSkill({ id: helper.id, title: helper.title || helper.id, body: "", summary: helper.summary || "" });
      try {
        const r = await fetch(ctx.apiUrl("/api/extensions/aiti-helper/skill/" + encodeURIComponent(helper.id)), { cache: "no-store" });
        const d = await r.json();
        if (d.ok) setViewingSkill({ id: helper.id, title: d.helper?.title || helper.title || helper.id, body: d.body || "", summary: d.helper?.summary || helper.summary || "", meta: d.meta || {} });
        else setViewingSkill((v) => v && { ...v, body: "", err: d.error || "读取失败" });
      } catch (e) { setViewingSkill((v) => v && { ...v, body: "", err: "读取失败" }); }
      setSkillLoading(false);
    }, []);
    const closeSkillView = useCallback(() => setViewingSkill(null), []);

    // 保存用户自定义 skill：POST /user-skills → 写 data 目录 → 刷新帮助点列表
    const saveUserSkill = useCallback(async () => {
      const name = (skillForm.name || "").trim();
      if (!name) { setSkillMsg({ status: "err", msg: "请填写 skill 名" }); return; }
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) { setSkillMsg({ status: "err", msg: "skill 名只能用字母/数字/下划线/连字符" }); return; }
      setSavingSkill(true); setSkillMsg(null);
      try {
        const r = await fetch(ctx.apiUrl("/api/extensions/aiti-helper/user-skills"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, owner: (skillForm.owner || "").trim() || undefined, title: (skillForm.title || name).trim(), summary: (skillForm.summary || "").trim() || undefined, body: skillForm.body || "" }),
        });
        const d = await r.json();
        if (!d.ok) { setSkillMsg({ status: "err", msg: d.error || "保存失败" }); return; }
        setSkillMsg({ status: "ok", msg: "已保存到 data 目录（归属 " + (d.skill?.owner || "aiti-helper") + "）" });
        // 刷新帮助点列表（新 skill 立即出现）
        const hr = await fetch(ctx.apiUrl("/api/extensions/aiti-helper/helpers"), { cache: "no-store" });
        const hd = await hr.json();
        if (hd.ok) setHelpers(hd.helpers || []);
        setSkillForm({ name: "", owner: "", title: "", summary: "", body: "" });
      } catch (e) { setSkillMsg({ status: "err", msg: "保存失败: " + (e.message || e) }); }
      setSavingSkill(false);
    }, [skillForm]);
    // 关闭新增表单：若已保存成功则回列表，否则保留表单
    const closeSkillForm = useCallback(() => { setShowSkillForm(false); setSkillMsg(null); }, []);

    // 历史恢复：把历史记录载入当前结果视图（含用户输入回填到输入框）
    const restoreHistory = useCallback((h) => {
      _state.lastResult = h.result;
      _state.historyId = h.id;
      _state.error = null;
      _state.activeTab = "ai";
      _state.opts = { contextLabel: h.contextLabel || (h.helperId ? h.helperId : null) };
      if (h.message) setInput(h.message);   // 回填用户原始输入（可再编辑/重新生成）
      setTurns([]);                         // 重置对话链（从该条开始继续追问）
      setFollowup("");
      _state.sessionId = h.agentSessionId || null;   // 恢复 agent 会话：追问优先继续同一会话（已回收则自动回落）
      if (h.helperId && helpers) setSelHelper(helpers.find((x) => x.id === h.helperId) || null);
      setLanding(null);
      notify();
    }, [helpers]);

    // 拖拽移动
    const onDragStart = useCallback((e) => {
      if (e.target.closest("button, textarea, input, pre, select")) return;
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
      const onMove = (ev) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        _state.pos = { x: dragRef.current.origX + dx, y: dragRef.current.origY + dy };
        notify();
      };
      const onUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }, []);

    // 失焦半透明：点击 dialog 外部 → dim；内部 → 恢复
    const onOverlayClick = useCallback((e) => {
      const panel = panelRef.current;
      if (panel && panel.contains(e.target)) { _state.dim = false; notify(); }
      else { _state.dim = true; notify(); }
    }, []);

    if (!isOpen) return null;

    const fmtTime = (ts) => {
      const d = new Date(ts);
      return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    };

    // 弹窗定位：pos.x 有值用 pos，否则默认右上角（距顶 72，距右 16）
    const panelLeft = pos.x != null ? pos.x : null;
    const panelTop = pos.y != null ? pos.y : null;

    return h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 2147483100, pointerEvents: "none",
      },
      onClick: onOverlayClick,
    },
      // dialog 面板（独立置顶，无遮罩）
      h("div", {
        ref: panelRef,
        onMouseDown: onDragStart,
        style: {
          position: "fixed", zIndex: 2147483101,
          left: panelLeft != null ? panelLeft + "px" : "auto",
          top: panelTop != null ? panelTop + "px" : "72px",
          right: panelLeft != null ? "auto" : "16px",
          width: "min(580px, 90vw)", maxHeight: "78vh", display: "flex", flexDirection: "column",
          background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
          border: "1px solid var(--border,#e0e0e0)", borderRadius: 14,
          boxShadow: "0 16px 64px rgba(0,0,0,.25)",
          opacity: dim ? 0.45 : 1, transition: "opacity .2s",
          pointerEvents: "auto", overflow: "hidden",
        },
      },
        // 标题栏（可拖拽）
        h("div", { key: "header",
          style: { display: "flex", alignItems: "center", gap: 8, cursor: "move",
            padding: "10px 14px", borderBottom: "1px solid var(--border,#e0e0e0)", flexShrink: 0, userSelect: "none" },
        },
          h("span", { key: "title", style: { fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5 } }, AiBotIcon(15), " AI Helper"),
          // tab 切换
          h("div", { key: "tabs", style: { display: "flex", gap: 2, marginLeft: 12 } },
            h("button", { key: "ai", onClick: () => { _state.activeTab = "ai"; notify(); }, style: { ...tabStyle(activeTab === "ai"), display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.sparkles), "AI"),
            h("button", { key: "hist", onClick: () => { _state.activeTab = "history"; notify(); }, style: { ...tabStyle(activeTab === "history"), display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.clock), "历史"),
          ),
          opts.contextLabel ? h("span", { key: "ctx", style: { fontSize: 10, opacity: 0.55, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, opts.contextLabel) : h("span", { key: "ctx-empty", style: { flex: 1 } }),
          h("button", { key: "close", onClick: close, title: "关闭（历史已保存，可随时从 🕘 历史找回）", style: closeBtnStyle() }, Ic(12, ICONS.x)),
        ),
        // 内容区
        h("div", { key: "body", style: { padding: 14, display: "flex", flexDirection: "column", gap: 10, overflow: "auto", flex: 1 } },
          // ===== AI tab =====
          activeTab === "ai" ? (viewingSkill ? (
            // 技能说明面板（查看某帮助点做什么）
            h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                h("span", { style: { fontSize: 13, fontWeight: 600, flex: 1, display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.help), viewingSkill.title),
                h("button", { onClick: closeSkillView, style: btnStyle() }, "← 返回"),
              ),
              viewingSkill.summary ? h("div", { style: { fontSize: 12, opacity: 0.75, background: "var(--bg-subtle,#f5f5f5)", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)" } }, viewingSkill.summary) : null,
              skillLoading ? h("div", { style: { fontSize: 12, opacity: 0.6 } }, "加载说明…") : null,
              viewingSkill.err ? h("div", { style: { color: "var(--danger, #ef4444)", fontSize: 12 } }, "⚠️ " + viewingSkill.err) : null,
              viewingSkill.body ? h("pre", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "12px 14px", background: "var(--bg-subtle,#f5f5f5)", color: "inherit", borderRadius: 8, fontSize: 12, lineHeight: 1.6, border: "1px solid var(--border,#e0e0e0)", maxHeight: 320, overflow: "auto", margin: 0 } }, viewingSkill.body) : null,
            )
          ) : showSkillForm ? (
            // 新增 skill 表单（用户自己给扩展加 skill，存 data 目录）
            h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                h("span", { style: { fontSize: 13, fontWeight: 600, flex: 1, display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.plus), "新增 Skill"),
                h("button", { onClick: closeSkillForm, style: btnStyle() }, "← 返回"),
              ),
              h("div", { style: { fontSize: 11, opacity: 0.6 } }, "自定义 skill 存到 data 目录（不覆盖任何扩展的部署产物）；归属扩展不打标签则默认归 ai-helper。"),
              // 名称
              h("label", { style: { fontSize: 12, opacity: 0.8 } }, "名称（必填，字母/数字/_/-）"),
              h("input", { value: skillForm.name, onInput: (e) => setSkillForm((f) => ({ ...f, name: e.target.value })), placeholder: "如 session-archive-30d", style: inputStyle() }),
              // 归属扩展
              h("label", { style: { fontSize: 12, opacity: 0.8 } }, "归属扩展（不指定归 ai-helper）"),
              h("select", { value: skillForm.owner, onInput: (e) => setSkillForm((f) => ({ ...f, owner: e.target.value })), style: { ...inputStyle(), padding: "7px 10px" } },
                h("option", { key: "__none__", value: "" }, "（不指定 · 归 ai-helper）"),
                (helpers || []).filter((h) => h.owner && h.owner !== "aiti-helper").map((h) => h.owner).filter((v, i, a) => a.indexOf(v) === i).map((o) => h("option", { key: o, value: o }, o)),
              ),
              // 标题
              h("label", { style: { fontSize: 12, opacity: 0.8 } }, "显示标题（可空，默认用名称）"),
              h("input", { value: skillForm.title, onInput: (e) => setSkillForm((f) => ({ ...f, title: e.target.value })), placeholder: "如 AI 帮我归档 30 天会话", style: inputStyle() }),
              // 说明
              h("label", { style: { fontSize: 12, opacity: 0.8 } }, "一句话说明（可空）"),
              h("input", { value: skillForm.summary, onInput: (e) => setSkillForm((f) => ({ ...f, summary: e.target.value })), placeholder: "这个 skill 能做什么", style: inputStyle() }),
              // 正文
              h("label", { style: { fontSize: 12, opacity: 0.8 } }, "正文手册（可空；可让 AI 帮你写）"),
              h("textarea", { value: skillForm.body, onInput: (e) => setSkillForm((f) => ({ ...f, body: e.target.value })), placeholder: "SKILL.md 正文（任务说明、API、输出格式…）。留空则先建骨架，再用「AI 帮我新增/修改 skill」补全。", style: { ...inputStyle(), minHeight: 90, resize: "vertical", lineHeight: 1.5 } }),
              // 操作
              skillMsg ? h("div", { style: { fontSize: 12, padding: "7px 10px", borderRadius: 6, background: skillMsg.status === "ok" ? "rgba(16,185,129,.12)" : "rgba(239,68,68,.12)", color: skillMsg.status === "ok" ? "#16a34a" : "#dc2626" } }, skillMsg.msg) : null,
              h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
                h("button", { onClick: () => saveUserSkill(), disabled: savingSkill, style: btnStyle("primary") }, savingSkill ? "保存中…" : "保存"),
                h("button", { onClick: () => { setShowSkillForm(false); setSelHelper(helpers && helpers.find((h) => h.id === "skill-manage") || null); }, style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.bot), "让 AI 写"),
              ),
            )
          ) : h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
            // 帮助点选择
            h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
              (helpers || []).map((hp) =>
                h("button", {
                  key: hp.id,
                  onClick: () => {
                    setSelHelper(selHelper && selHelper.id === hp.id ? null : hp);
                    if (hp.placeholder) _state.opts.placeholder = hp.placeholder;
                    notify();
                  },
                  title: hp.summary || "",
                  style: {
                    padding: "4px 10px", borderRadius: 12, cursor: "pointer", fontSize: 11,
                    border: "1px solid " + (hp.user ? "rgba(250,204,21,.6)" : (selHelper && selHelper.id === hp.id ? "var(--accent,#2563eb)" : "var(--border,#e0e0e0)")),
                    background: hp.user ? "rgba(250,204,21,.08)" : (selHelper && selHelper.id === hp.id ? "rgba(37,99,235,.12)" : "rgba(128,128,128,.06)"),
                    color: "inherit",
                  },
                }, (selHelper && selHelper.id === hp.id ? "✓ " : "") + (hp.user ? "✦ " : "") + hp.title + (hp.user && hp.owner ? " ·" + hp.owner : "")),
              ),
              // 新增自定义 skill 入口
              h("button", {
                onClick: () => { setShowSkillForm(true); setSelHelper(null); },
                title: "用户自定义 skill（存 data 目录，可指定归属扩展）",
                style: { padding: "4px 10px", borderRadius: 12, cursor: "pointer", fontSize: 11,
                  border: "1px dashed var(--accent,#2563eb)", background: "rgba(37,99,235,.05)", color: "inherit" },
              }, Ic(13, ICONS.plus), "新增 Skill"),
            ),
            // 已选帮助点 + 查看说明按钮（输入框上方，较大易点）
            selHelper ? h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 2 } },
              h("span", { style: { fontSize: 12, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 } }, Ic(12, ICONS.sparkles), " 已选：" + selHelper.title),
              h("button", {
                onClick: () => viewSkill(selHelper),
                title: "查看这个帮助点（skill）能做什么",
                style: { padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12, flexShrink: 0,
                  border: "1px dashed var(--border,#e0e0e0)", background: "rgba(128,128,128,.07)", color: "inherit" },
              }, Ic(13, ICONS.help), "看看它能做什么"),
            ) : null,
            // 输入框
            h("textarea", {
              ref: taRef,
              value: input,
              onInput: (e) => setInput(e.target.value),
              placeholder: opts.placeholder || "描述你想让 AI 做什么…",
              disabled: loading,
              style: { width: "100%", minHeight: 72, maxHeight: 180, resize: "vertical",
                padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)",
                background: "var(--bg-subtle,#f5f5f5)", color: "inherit", fontSize: 13, lineHeight: 1.5,
                boxSizing: "border-box", outline: "none", opacity: loading ? 0.6 : 1 },
              onKeyDown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doInvoke(); } },
            }),
            // 生成按钮
            h("button", {
              onClick: () => doInvoke(), disabled: loading || !input.trim(),
              style: { alignSelf: "flex-start", padding: "6px 15px", borderRadius: 8, cursor: "pointer",
                border: "1px solid var(--accent,#2563eb)", background: loading ? "rgba(37,99,235,.08)" : "rgba(37,99,235,.12)",
                color: "inherit", fontSize: 13, fontWeight: 500, opacity: (loading || !input.trim()) ? 0.5 : 1 },
            }, loading ? "生成中…" : [Ic(13, ICONS.sparkles), "生成"]),
            // 错误
            err ? h("div", { style: { color: "var(--danger, #ef4444)", fontSize: 12, padding: "7px 10px", background: "rgba(239,68,68,.1)", borderRadius: 6 } }, "❌ " + err) : null,
            // 结果预览
            result ? h("div", null,
              h("div", { style: { fontSize: 11, opacity: 0.6, marginBottom: 5 } }, Ic(12, ICONS.copy), " 结果预览（审核后落地；关闭后可在历史找回）"),
              h("pre", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "10px 12px",
                background: "var(--bg-subtle,#f5f5f5)", color: "inherit", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
                border: "1px solid var(--border,#e0e0e0)", maxHeight: 220, overflow: "auto", margin: 0 } }, result),
              // 操作行
              h("div", { style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" } },
                selHelper?.action ? h("button", { onClick: () => doLand(result, selHelper, _state.historyId), style: btnStyle("primary") }, selHelper.action.type === "fill" ? "回填弹窗" : "入库") : null,
                h("button", { onClick: () => adoptChat(result), style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.msg), "填入聊天框"),
                h("button", { onClick: () => copyResult(result), style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.copy), "复制"),
                h("button", { onClick: retry, style: { ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.refresh), "重来"),
              ),
              // 追问（结果不满意 → 追加要求继续迭代；带上下文）
              h("div", { style: { marginTop: 10, display: "flex", gap: 8, alignItems: "flex-start" } },
                h("input", {
                  value: followup,
                  onInput: (e) => setFollowup(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); doInvoke(true); } },
                  placeholder: "不满意？输入追加要求继续，如「改成中文输出」「加个确认」「再详细点」…",
                  disabled: loading,
                  style: { flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)",
                    background: "var(--bg-subtle,#f5f5f5)", color: "inherit", fontSize: 12, outline: "none" },
                }),
                h("button", {
                  onClick: () => doInvoke(true), disabled: loading || !followup.trim(),
                  style: { padding: "6px 12px", borderRadius: 8, cursor: "pointer", flexShrink: 0,
                    border: "1px solid var(--accent,#2563eb)", background: loading ? "rgba(37,99,235,.08)" : "rgba(37,99,235,.12)",
                    color: "inherit", fontSize: 12, opacity: (loading || !followup.trim()) ? 0.5 : 1 },
                }, "↪ 追问"),
              ),
              // 对话轮次指示
              (_state.sessionId || turns.length) ? h("div", { style: { marginTop: 5, fontSize: 10, opacity: 0.55 } }, "已" + (_state.sessionId ? "在同一 AI 会话延续（上下文完整）" : "迭代 " + (turns.length + 1) + " 轮·追问带手工上下文")) : null,
              // 落地状态
              landing ? h("div", { style: { marginTop: 8, fontSize: 12, padding: "7px 10px", borderRadius: 6, background: landing.status === "ok" ? "rgba(16,185,129,.12)" : "rgba(239,68,68,.12)", color: landing.status === "ok" ? "#16a34a" : "#dc2626" } }, landing.msg) : null,
            ) : null,
          )) : null,
          // ===== 历史 tab =====
          activeTab === "history" ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            h("div", { style: { fontSize: 11, opacity: 0.6 } }, Ic(12, ICONS.clock), " 历史记录（server 持久化，关闭不丢）" + (historyList && historyList.length ? " · " + historyList.length + " 条" : "")),
            !historyList ? h("div", { style: { fontSize: 12, opacity: 0.5, padding: 12 } }, "加载中…") :
            !historyList.length ? h("div", { style: { fontSize: 12, opacity: 0.5, padding: 12 } }, "暂无历史记录。用 ✨ AI 生成一次就有了。") :
            historyList.map((rec) =>
              h("div", {
                key: rec.id,
                onClick: () => restoreHistory(rec),
                title: "点击恢复此结果",
                style: { border: "1px solid var(--border,#e0e0e0)", borderRadius: 8, padding: "8px 10px", cursor: "pointer", background: "var(--bg-subtle,#f5f5f5)" },
              },
                h("div", { style: { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" } },
                  h("span", { style: { fontSize: 10, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } }, (rec.contextLabel || rec.helperId || "自由发挥") + (rec.turn && rec.turn > 1 ? " · 第" + rec.turn + "轮" : "") + " · " + fmtTime(rec.at)),
                  h("span", { style: { fontSize: 10, padding: "1px 7px", borderRadius: 9, border: "1px solid " + (rec.landed ? "rgba(22,163,74,.5)" : "rgba(220,38,38,.4)"), color: rec.landed ? "#16a34a" : "#dc2626" } }, rec.landed ? "已落地" : "未落地"),
                ),
                h("div", { style: { fontSize: 12, fontWeight: 500, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: 1.4 } }, "💬 " + (rec.message || "（早期记录无输入）")),
                h("div", { style: { fontSize: 11, opacity: 0.75, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, rec.result.slice(0, 200)),
                rec.landed && rec.landDetail ? h("div", { style: { fontSize: 10, color: "#16a34a", marginTop: 4 } }, rec.landDetail) : null,
              ),
            ),
          ) : null,
        ),
      ),
    );
  }

  function tabStyle(active) {
    return {
      padding: "3px 10px", borderRadius: 7, cursor: "pointer", fontSize: 12,
      border: "1px solid " + (active ? "var(--accent,#2563eb)" : "transparent"),
      background: active ? "rgba(37,99,235,.12)" : "transparent",
      color: "inherit",
    };
  }
  function closeBtnStyle() {
    return { background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 17, padding: "0 4px", lineHeight: 1, flexShrink: 0 };
  }
  function btnStyle(variant) {
    const base = { padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border,#e0e0e0)", background: "rgba(128,128,128,.08)", color: "inherit" };
    if (variant === "primary") { base.background = "rgba(37,99,235,.12)"; base.borderColor = "var(--accent,#2563eb)"; base.fontWeight = 500; }
    return base;
  }
  // 输入框通用样式（新增 skill 表单用）
  function inputStyle() {
    return { width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)", color: "inherit", fontSize: 12, outline: "none", boxSizing: "border-box" };
  }

  // ==================== 图标：星星眼机器人（AI 魔法感：sparkle 星星眼 + 圆角方头 + 腮红微笑；lucide 线图风格，黑白 currentColor） ====================
  // React 版本（用于 toolbar 按钮/标题栏）
  const AiBotIcon = (size = 16) => {
    const el = h("svg", {
      viewBox: "0 0 24 24", width: size, height: size, fill: "none",
      stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
      "aria-hidden": true,
    }, [
      // lucide sparkles：大四角星 + 右上小星（AI 通用符号，与系统内建线条图标同风格）
      h("path", { key: "p1", d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" }),
      h("path", { key: "p2", d: "M20 3v4" }),
      h("path", { key: "p3", d: "M22 5h-4" }),
    ]);
    if (el._store) el._store.validated = 1;
    return el;
  };
  // DOM 版本（用于 MutationObserver 注入的弹窗按钮）
  const AiBotIconSvg = (size = 16) =>
    '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>' +
    '<path d="M20 3v4"/>' +
    '<path d="M22 5h-4"/>' +
    "</svg>";

  // ==================== 工具栏 AI 按钮（toolbar slot，不占输入框） ====================
  function AiHelperButton(props) {
    const open = () => window.__aitiHelperInvoke({ placeholder: "描述你想让 AI 做什么…" });
    return h("button", {
      onClick: open,
      title: "AI Helper：一句话唤起 AI（可拖拽、有历史）",
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-muted)"; },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      },
    }, AiBotIcon(16));
  }

  // ==================== 全局弹窗 AI 按钮（§4.4：dialog 关闭按钮左边自动插 🤖） ====================
  function installDialogAiButton() {
    const AI_BTN_ATTR = "data-aiti-ai-btn";
    let scanTimer = null;

    const findCloseBtn = (dialog) => {
      const candidates = dialog.querySelectorAll(
        'button[aria-label*="close" i], button[aria-label*="关闭"], button[aria-label*="Close"], ' +
        '[class*="close" i] button, [class*="Close"] button, ' +
        'button[class*="close" i], button[class*="Close"]'
      );
      for (const b of candidates) {
        if (b.hasAttribute(AI_BTN_ATTR)) continue;
        const rect = b.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return b;
      }
      for (const b of dialog.querySelectorAll("button")) {
        if (b.hasAttribute(AI_BTN_ATTR)) continue;
        const t = (b.textContent || "").trim();
        if (t === "×" || t === "✕" || t === "✖") return b;
      }
      return null;
    };

    const getDialogContext = (dialog) => {
      // 提取弹窗标题/正文 + 表单字段当前值（供 AI 理解当前状态）
      const heading = dialog.querySelector("h1,h2,h3,[class*='title' i],[class*='Title'],[role='heading']");
      const title = heading ? (heading.textContent || "").trim().slice(0, 80) : "";
      const body = (dialog.textContent || "").trim().slice(0, 200);
      // 表单字段
      const fields = [];
      dialog.querySelectorAll("input, textarea, select, [contenteditable=\"true\"], [contenteditable=\"plaintext-only\"], [contenteditable=\"\"]").forEach((el, i) => {
        if (i >= 6) return;
        const label = el.closest("label") ? el.closest("label").textContent.trim().slice(0, 20) : (el.getAttribute("aria-label") || el.getAttribute("data-placeholder") || "").slice(0, 20);
        const val = (el.isContentEditable ? (el.innerText || "") : (el.value || "")).slice(0, 40);
        if (label || val) fields.push((label || "字段" + (i + 1)) + "=" + val);
      });
      return { title, body, fields: fields.join("；") };
    };

    const injectButton = (dialog) => {
      if (dialog.hasAttribute(AI_BTN_ATTR + "-done")) return;
      const closeBtn = findCloseBtn(dialog);
      if (!closeBtn) return;
      dialog.setAttribute(AI_BTN_ATTR + "-done", "1");

      const aiBtn = document.createElement("button");
      aiBtn.setAttribute(AI_BTN_ATTR, "1");
      aiBtn.innerHTML = AiBotIconSvg(16);
      aiBtn.title = "AI Helper：让 AI 帮我处理这个弹窗";
      aiBtn.style.cssText = "cursor:pointer;border:none;background:none;color:inherit;padding:2px 6px;line-height:1;opacity:.85;display:inline-flex;align-items:center";
      aiBtn.onmouseenter = () => aiBtn.style.opacity = "1";
      aiBtn.onmouseleave = () => aiBtn.style.opacity = ".85";
      aiBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const ctxInfo = getDialogContext(dialog);
        const system = "用户在一个扩展弹窗里点了 AI 按钮。弹窗标题：「" + ctxInfo.title + "」。内容摘要：" + ctxInfo.body +
          (ctxInfo.fields ? "。当前表单值：" + ctxInfo.fields : "") + "。请根据弹窗上下文帮用户处理相关任务。";
        window.__aitiHelperInvoke({
          system,
          placeholder: "告诉 AI 你想对这个弹窗做什么…",
          contextLabel: ctxInfo.title || "弹窗 AI",
          dialogEl: dialog,   // 供 action:fill 回填弹窗表单
        });
      };

      try {
        closeBtn.parentNode.insertBefore(aiBtn, closeBtn);
      } catch (e) {
        try { closeBtn.parentNode.appendChild(aiBtn); } catch (e2) {}
      }
    };

    const scan = () => {
      const dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="Dialog"], [class*="modal" i], [class*="Modal"]');
      dialogs.forEach((d) => {
        const rect = d.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 50) injectButton(d);
      });
    };

    const observer = new MutationObserver(() => {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(scan, 500);

    return () => { observer.disconnect(); if (scanTimer) clearTimeout(scanTimer); };
  }

  // ==================== 预取当前页面 pageId（发起方来源标注用） ====================
  // 当前页面在 aiti-devtools 桥里的 pageId（如 xxx/ai = AI 主窗口、xxx/host = 宿主页）。
  // 经 BridgeClient.listSessions 匹配当前页面（self 标记 / url 匹配）异步拿；桥未连通时延迟重试。
  function prefetchPageId() {
    try {
      _state.isAiWin = window.name === "aiti-ai-popup" || !!window.__AITI_AI_WIN__;
    } catch (e) {}
    let tries = 0;
    const attempt = () => {
      tries++;
      try {
        if (!window.BridgeClient || typeof window.BridgeClient.listSessions !== "function") {
          if (tries < 5) setTimeout(attempt, 1200 * tries);  // 桥未注入 → 退避重试
          return;
        }
        window.BridgeClient.listSessions().then((rows) => {
          const active = (rows || []).filter((r) => r.active);
          // 优先 url 精确匹配当前页面（多 self/多窗口时并行窗口不抢占）；无 url 匹配再兜底 self
          const cur = active.find((r) => r.url && location.href && (r.url === location.href || location.href.startsWith(r.url)))
            || active.find((r) => r.self);
          if (cur && cur.pageId) { _state.pageId = cur.pageId; if (cur.self) _state.isAiWin = true; notify(); }
          else if (tries < 5) setTimeout(attempt, 1200 * tries);
        }).catch(() => { if (tries < 5) setTimeout(attempt, 1200 * tries); });
      } catch (e) { if (tries < 5) setTimeout(attempt, 1200 * tries); }
    };
    attempt();
  }
  prefetchPageId();

  // ==================== 注册 ====================
  // 按钮 → toolbar（AppShell 全局壳）；dialog → pages（传 activeCwd，且不随 session 切换卸载——满足「点击其他 session 弹窗不关闭」）
  ctx.registerItems("toolbar", [
    { id: "aiti-helper-open", render: AiHelperButton, meta: { label: "AI 助手" } },
  ]);
  ctx.registerItems("pages", [
    { id: "aiti-helper-dialog", render: AiHelperDialog },
  ]);

  const cleanupAiButton = installDialogAiButton();
  try { window.__aitiHelperCleanup = cleanupAiButton; } catch (e) {}

  try { console.log("[aiti-helper] client M2 已挂载：顶部 🤖 + 独立置顶弹窗（拖拽/失焦半透明）+ 历史 tab + 全局弹窗 AI 按钮"); } catch (e) {}
}