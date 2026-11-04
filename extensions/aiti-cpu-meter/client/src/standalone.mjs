// aiti-cpu-meter 外部版壳 —— 任意网站 <script> 加载即用（esbuild 打包为单文件 IIFE，无导入导出）
//
// 用途：开发者评估自己的网站（service-tunnels 注入 / bookmarklet / 跨实例注入共用本产物）。
// 外部网站没有 aiti-float → 拖动/位置持久化由 core 自带（与内部版功能一致）。
// 配置读取优先级：URL search 参数（meter-pos / meter-score / meter-min / meter-snaps / meter-ask）
//   > window.__aitiCpuMeterOpts（{ pos, score, minimize, snaps, ask, base }）> 默认值。
// 幂等：createMeter 内部会先 dispose window.__aitiCpuMeter 旧实例（防多通道叠加）。
// 卸载：window.__aitiCpuMeter.dispose()（bookmarklet 再点一次 = 卸载）。
//
// 「问 AI」（✨ sparkles 图标；meter-ask=0 关闭）：面板按钮 → 输入弹窗 → 收集现场报告
//   → window.open 打开 pi-web 的 gate.html（顶级导航带登录会话，未登录先登录后回跳；认证链路闭合）
//   → gate 页同源 POST /api/extensions/aiti-cpu-meter/ask-ai 建会话 → 自动跳转会话页。
//   pi-web 地址推导：__aitiCpuMeterOpts.base > 自身 <script src> 前缀 > 同源。
//   数据传递：gate ready 握手后 postMessage 回传（URL 零参数——nginx 日志/历史记录零残留）。

import { createMeter, ICON_AI } from "./core.mjs";

(function bootstrap() {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  function param(name, fallback) {
    try {
      const v = new URLSearchParams(window.location.search).get(name);
      if (v === null || v === "") return fallback;
      return v;
    } catch (e) { return fallback; }
  }
  function boolParam(name, fallback) {
    const v = param(name, null);
    if (v === null) return fallback;
    return v === "1" || v === "true" || v === "on";
  }

  const pre = (typeof window.__aitiCpuMeterOpts === "object" && window.__aitiCpuMeterOpts) ? window.__aitiCpuMeterOpts : {};
  const posRaw = param("meter-pos", pre.pos || "left-bottom");
  const pos = ["left-bottom", "left-top", "right-bottom", "right-top"].includes(posRaw) ? posRaw : "left-bottom";
  const localeRaw = param("meter-locale", pre.locale || "");
  const askOn = boolParam("meter-ask", pre.ask !== false);

  // ── 「问 AI」弹窗（外部版专属：无 aiti-helper，POST 回 pi-web 建会话再跳转）──────
  const ASK_ID = "aiti-cpu-meter-ask";
  const ASK_STYLE_ID = "aiti-cpu-meter-ask-style";
  let askEl = null, askTa = null, askStatus = null, askInfo = null;
  let reportApi = null; // createMeter 传入的 { report }

  // pi-web 基址：显式 opts.base > 自身 <script src> 前缀（strip /api/extensions/aiti-cpu-meter/）> 同源
  function scriptBase() {
    try {
      if (typeof pre.base === "string" && pre.base.trim()) return pre.base.trim().replace(/\/+$/, "");
      const s = document.querySelector('script[src*="aiti-cpu-meter"]');
      if (s && s.src) {
        const i = s.src.indexOf("/api/extensions/aiti-cpu-meter/");
        if (i > 0) return s.src.slice(0, i);
      }
    } catch (e) {}
    return "";
  }
  function scriptUrl() {
    try {
      const s = document.querySelector('script[src*="aiti-cpu-meter"]');
      if (s && s.src) return String(s.src).slice(0, 500);
    } catch (e) {}
    return "";
  }

  // 报告瘦身（GET 兜底 URL 长度有限：先砍 ltLog/快照/LoAF/UA，仍超长再截断）
  function compactReport(r) {
    let s = "";
    try { s = JSON.stringify(r); } catch (e) { return "{}"; }
    if (s.length <= 6000) return s;
    const env = r && r.env || {};
    const slim = Object.assign({}, r, {
      env: { ua: String(env.ua || "").slice(0, 80), cores: env.cores || null, net: env.net || null },
      ltLog: [], loaf: ((r && r.loaf) || []).slice(-2), snaps: ((r && r.snaps) || []).slice(-2),
    });
    try { s = JSON.stringify(slim); } catch (e) {}
    return s.length > 9000 ? s.slice(0, 9000) + "…（超长截断）" : s;
  }

  function closeAsk() {
    if (askEl && askEl.parentNode) askEl.parentNode.removeChild(askEl);
    askEl = null; askTa = null; askStatus = null; askInfo = null;
  }

  function setStatus(msg, isError) {
    if (!askStatus) return;
    askStatus.textContent = msg || "";
    askStatus.style.color = isError ? "#FF7B7B" : "rgba(124,255,124,.85)";
  }

  // 提交流程（2026-09-08 重构）：不再跨源 fetch ask-ai——跨源 fetch 的 preflight 永远无登录
  // cookie（Authelia 302 → CORS 禁止 preflight 重定向），而免认证放行等于公网裸奔 AI 入口，已回滚。
  // 改为 gate 流程：window.open gate.html（pi-web 扩展页；顶级导航带登录会话，未登录先登录后回跳），
  // prompt/report 走 URL query（≤6500，报告逐级瘦身，核心指标永不丢），gate 同源 POST ask-ai 后跳转。
  function submitAsk() {
    if (!askTa) return;
    const prompt = askTa.value.trim();
    if (!prompt) { setStatus("请先描述卡顿现象（什么时候卡/做什么操作/持续多久）", true); askTa.focus(); return; }
    let reportJson = "{}";
    try { reportJson = compactReport(reportApi ? reportApi.report() : null); } catch (e) {}
    const payload = {
      prompt: prompt.slice(0, 4000),
      report: reportJson,
      url: String(location.href).slice(0, 500),
      title: String(document.title || "").slice(0, 200),
      scriptUrl: scriptUrl(),
      base: scriptBase(), // origin+basePath（服务端 server→server 调用与跳转地址都靠它）
      ts: Date.now(),
    };
    setStatus("正在打开创建页…", false);
    // gate 页：URL 零参数（prompt/report 不进 URL——nginx 日志/历史记录零残留），顶级导航带登录
    // 会话（未登录先登录后回跳，opener 引用跨导航保留）；gate ready 后 postMessage 回传 payload
    // （gateOrigin 定向，防数据散播），gate 同源 POST ask-ai 后自动跳转会话页。
    // 消息命名空间化：type 带 'aiti-cpu-meter:' 前缀（不用裸词，防与页面其他 message 监听撞车；
    // launcher 侧消息另有 __dbg:1 标记，互不相干），nonce 防多窗口/重发错配。
    let gateOrigin = "";
    try { gateOrigin = new URL(scriptBase()).origin; } catch (e) {}
    const w = window.open(scriptBase() + "/api/extensions/aiti-cpu-meter/gate.html", "_blank");
    if (!w) { setStatus("浏览器拦截了窗口——请允许弹窗后重试", true); return; }
    const onGateReady = (ev) => {
      const d = ev.data;
      if (ev.source !== w || !d || d.source !== "aiti-cpu-meter-gate" || d.type !== "aiti-cpu-meter:gate-ready") return;
      window.removeEventListener("message", onGateReady);
      try { w.postMessage({ source: "aiti-cpu-meter-gate-ack", type: "aiti-cpu-meter:gate-payload", nonce: d.nonce, ...payload }, gateOrigin || "*"); } catch (e) {}
      setStatus("已发送数据，等待会话创建（见新窗口）", false);
      setTimeout(closeAsk, 1500);
    };
    window.addEventListener("message", onGateReady);
    setTimeout(() => window.removeEventListener("message", onGateReady), 60000); // 登录/握手超时兜底
    setStatus("已打开创建页——等待握手与创建（见新窗口）", false);
  }

  function openAskDialog(api) {
    reportApi = api;
    if (askEl) { askTa && askTa.focus(); return; }
    let st = document.getElementById(ASK_STYLE_ID);
    if (!st) { st = document.createElement("style"); st.id = ASK_STYLE_ID; document.head.appendChild(st); }
    st.textContent = (
      "#" + ASK_ID + "{position:fixed;z-index:2147483647;left:50%;top:16%;transform:translateX(-50%);" +
        "width:min(460px,92vw);background:rgba(10,10,10,.96);color:#7CFF7C;border:1px solid #1a3;border-radius:10px;" +
        "box-shadow:0 8px 30px rgba(0,0,0,.55);font:12px/1.55 Menlo,Consolas,monospace;text-shadow:0 0 4px rgba(124,255,124,.4)}" +
      "#" + ASK_ID + " .ask-head{display:flex;align-items:center;gap:6px;padding:6px 10px;font-weight:bold;font-size:12px;" +
        "background:rgba(20,120,40,.25);border-radius:10px 10px 0 0}" +
      "#" + ASK_ID + " .ask-head svg{width:13px;height:13px;display:block}" +
      "#" + ASK_ID + " .ask-close{margin-left:auto;cursor:pointer;border:0;background:transparent;color:#7CFF7C;font-size:14px;" +
        "padding:0 4px;border-radius:4px}" +
      "#" + ASK_ID + " .ask-close:hover{background:rgba(255,60,60,.35);color:#fff}" +
      "#" + ASK_ID + " .ask-info{padding:4px 10px 0;color:rgba(255,255,255,.55);font-size:11px}" +
      "#" + ASK_ID + " textarea{display:block;width:calc(100% - 20px);margin:6px 10px;min-height:88px;resize:vertical;" +
        "background:rgba(0,0,0,.5);color:#dfffe0;border:1px solid rgba(124,255,124,.35);border-radius:6px;" +
        "font:12px/1.5 Menlo,Consolas,monospace;padding:6px;outline:none}" +
      "#" + ASK_ID + " textarea:focus{border-color:#7CFF7C}" +
      "#" + ASK_ID + " .ask-status{padding:0 10px;min-height:16px;color:rgba(124,255,124,.85);font-size:11px}" +
      "#" + ASK_ID + " .ask-foot{display:flex;align-items:center;gap:8px;padding:6px 10px 10px}" +
      "#" + ASK_ID + " .ask-hint{flex:1;color:rgba(255,255,255,.4);font-size:10px}" +
      "#" + ASK_ID + " button.ask-btn{cursor:pointer;border:1px solid rgba(124,255,124,.5);background:rgba(20,120,40,.3);" +
        "color:#7CFF7C;border-radius:6px;padding:5px 12px;font:12px Menlo,Consolas,monospace}" +
      "#" + ASK_ID + " button.ask-btn:hover{background:rgba(20,120,40,.55);color:#fff}" +
      "#" + ASK_ID + " button.ask-btn.primary{border-color:#7CFF7C}"
    );
    askEl = document.createElement("div");
    askEl.id = ASK_ID;
    const head = document.createElement("div");
    head.className = "ask-head";
    head.style.display = "flex";
    const ttl = document.createElement("span");
    ttl.appendChild((function () { const s = document.createElement("span"); s.style.display = "inline-flex"; s.style.verticalAlign = "-2px"; s.style.marginRight = "4px"; s.innerHTML = ICON_AI; const w = s.querySelector("svg"); if (w) { w.setAttribute("width", "13"); w.setAttribute("height", "13"); } return s; })());
    ttl.appendChild(document.createTextNode("问 AI · 页面卡顿调试"));
    head.appendChild(ttl);
    const closeBtn = document.createElement("button");
    closeBtn.className = "ask-close";
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.addEventListener("click", closeAsk);
    head.appendChild(closeBtn);
    askInfo = document.createElement("div");
    askInfo.className = "ask-info";
    try {
      const r = api.report();
      const bits = [];
      if (r.score != null) bits.push("当前 " + r.score + " 分");
      if (r.avg != null) bits.push("平均 " + r.avg);
      if (r.min != null) bits.push("最低 " + r.min);
      if (r.blocking) bits.push("longtask " + r.blocking.longtask + " (max " + r.blocking.longtaskMax + "ms)");
      askInfo.textContent = "现场： " + (bits.join(" · ") || "采集中") + "（自动附带）";
    } catch (e) { askInfo.textContent = "现场： 报告不可用"; }
    askTa = document.createElement("textarea");
    askTa.placeholder = "描述卡顿现象：什么时候卡？做什么操作时卡？持续多久？有无报错…";
    askStatus = document.createElement("div");
    askStatus.className = "ask-status";
    const foot = document.createElement("div");
    foot.className = "ask-foot";
    const hint = document.createElement("span");
    hint.className = "ask-hint";
    hint.textContent = "提交后在 pi-web 新会话中分析";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ask-btn";
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", closeAsk);
    const okBtn = document.createElement("button");
    okBtn.className = "ask-btn primary";
    okBtn.type = "button";
    okBtn.textContent = "创建调试会话 →";
    okBtn.addEventListener("click", submitAsk);
    foot.appendChild(hint); foot.appendChild(cancelBtn); foot.appendChild(okBtn);
    askEl.appendChild(head); askEl.appendChild(askInfo); askEl.appendChild(askTa);
    askEl.appendChild(askStatus); askEl.appendChild(foot);
    (document.body || document.documentElement).appendChild(askEl);
    askTa.focus();
  }

  const opts = {
    pos: pos,
    score: boolParam("meter-score", pre.score !== false),
    minimize: boolParam("meter-min", pre.minimize !== false),
    snaps: boolParam("meter-snaps", pre.snaps !== false),
    cookie: boolParam("meter-cookie", pre.cookie !== false), // report() 携带同站 cookie（meter-cookie=0 关）
    locale: (localeRaw === "zh" || localeRaw === "en") ? localeRaw : "", // 空 = 自动检测 navigator.language
    actions: askOn ? [{
      id: "ask-ai",
      icon: ICON_AI, // lucide sparkles（同 aiti-helper 图形，_shared/icons 单源）
      label: "AI",
      title: "问 AI：收集流畅度现场，创建调试会话并跳转",
      onClick: openAskDialog,
    }] : [],
  };

  const handle = createMeter(opts);
  // createMeter 已挂 window.__aitiCpuMeter = handle（幂等 + 可卸载；handle.report() 可取现场报告）
  try { console.log("[aiti-cpu-meter] 外部版已挂载（standalone 注入；配置", JSON.stringify(Object.assign({}, opts, { actions: undefined })), "）"); } catch (e) {}
})();
