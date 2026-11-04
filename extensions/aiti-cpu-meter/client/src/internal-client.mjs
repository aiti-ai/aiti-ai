// aiti-cpu-meter 内部版壳 —— pi-web 扩展 client（register(ctx) 形态）
//
// 只做「配置搬运 + 接线」，meter 实现全在 core.mjs（esbuild 打包内联，单一实现）。
// 面板一律 core 自带拖动（内部版/外部版同一份；不再接 aiti-float——Android 实测其接管
// 导致交互延迟数秒 + 评分被操作拉低）。
// 读 extman features：
//   - enabled（bool，默认 true）：本实例页面显示检测器
//   - pos（string，默认 left-bottom）
//   - score（bool，默认 true）：流畅度评分行
//   - minimize（bool，默认 true）：支持最小化
//   - askAi（bool，默认 true）：面板「✨ 问 AI」按钮——组装现场报告交给 aiti-helper
//       （helperId=jank-debug 预选「调试页面卡顿」帮助点，用户补充描述后生成）
//   - inject.enabled（bool，默认 false）+ service.url（string）：跨实例注入（参照 aiti-debug-inject）
//       开启且配地址 → 从目标实例拉外部版 standalone 注入当前页（评估「当前页面」）
//
// 无 toolbar / 无弹窗——「就是简单注入检测器」。幂等：feature 变更重挂（先 dispose 旧实例）。

import { createMeter, ICON_AI } from "./core.mjs";
import { extDisplayName } from "../../../_shared/ext-display-names";

export default function register(ctx) {
  if (typeof document === "undefined") return;

  const INJECT_FLAG = "data-aiti-cpu-meter-inject";
  let meter = null; // 本实例 createMeter 句柄
  let appliedKey = "";

  function feats() {
    return (typeof ctx.getFeatures === "function" ? ctx.getFeatures() : {}) || {};
  }
  function posFrom(f) {
    const p = (f && typeof f.pos === "string") ? f.pos : "left-bottom";
    return ["left-bottom", "left-top", "right-bottom", "right-top"].includes(p) ? p : "left-bottom";
  }

  function disposeMeter() {
    if (meter) { try { meter.dispose(); } catch (e) {} meter = null; }
    // 跨实例注入的外部版自注册到 window.__aitiCpuMeter，一并清掉
    if (typeof window !== "undefined" && window.__aitiCpuMeter) {
      try { window.__aitiCpuMeter.dispose(); } catch (e) {}
      window.__aitiCpuMeter = null;
    }
  }
  function removeInjected() {
    document.querySelectorAll("script[" + INJECT_FLAG + "]").forEach((el) => el.remove());
  }

  // 「问 AI」：组装现场报告 → aiti-helper 弹窗（jank-debug 帮助点预选 + extId/extName 本扩展分组）。
  // aiti-helper 是懒加载扩展（clientImmediately:false），window.__aitiHelperInvoke 在其 client
  // 物化前不存在 → 先 ctx.ensureMaterialized("aiti-helper") 物化再调（同 git-review→editor 模式）；
  // 物化失败/未装才降级提示（报告 JSON 打印控制台）。
  function invokeHelper(opts, onFail) {
    const inv = typeof window !== "undefined" ? window.__aitiHelperInvoke : null;
    if (typeof inv === "function") { inv(opts); return; }
    try {
      const p = ctx.ensureMaterialized && ctx.ensureMaterialized("aiti-helper");
      if (p && typeof p.then === "function") {
        p.then(() => {
          const inv2 = typeof window !== "undefined" ? window.__aitiHelperInvoke : null;
          if (typeof inv2 === "function") inv2(opts);
          else onFail && onFail();
        }).catch(() => { onFail && onFail(); });
        return;
      }
    } catch (e) { /* 未拿到 ensureMaterialized → 直接降级 */ }
    onFail && onFail();
  }
  function askAiAction() {
    return {
      id: "ask-ai",
      icon: ICON_AI,
      label: "AI",
      title: "问 AI：带现场数据分析卡顿（aiti-helper）",
      onClick: function (api) {
        let reportJson = "{}";
        try { reportJson = JSON.stringify(api.report()); } catch (e) {}
        const fail = () => {
          alert("aiti-helper 未安装或物化失败，无法唤起 AI。\n可从工具条「AI」按钮进入选「调试页面卡顿」，现场报告 JSON 已打印到控制台。");
          try { console.log("[aiti-cpu-meter] 现场报告：", reportJson); } catch (e) {}
        };
        const msg = "【请在下面补充描述：什么时候卡、做什么操作时卡、持续多久；也可直接点生成，让 AI 按现场报告分析】\n\n" +
          "[cpu-meter 现场报告 JSON]\n```json\n" + reportJson + "\n```";
        // extId/extName：aiti-helper 正统「本扩展」分组机制（同 dialog-ai-button）——
        // 帮助点列表顶部置顶「本扩展 · CPU 流畅度仪表」组并高亮，jank-debug 预选配合
        invokeHelper({ helperId: "jank-debug", extId: "aiti-cpu-meter", extName: extDisplayName("aiti-cpu-meter"), message: msg, contextLabel: "cpu-meter 卡顿调试" }, fail);
      },
    };
  }

  // 从目标实例注入外部版 standalone（带内容哈希版本号：目标改动 → 强制拉新）
  function injectExternal(baseUrl) {
    const base = String(baseUrl || "").replace(/\/+$/, "");
    if (!base) return;
    if (document.querySelector('script[' + INJECT_FLAG + '="' + base + '"]')) return; // 已注入该目标
    const assetUrl = base + "/api/extensions/aiti-cpu-meter/aiti-cpu-meter.js";
    const versionUrl = base + "/api/extensions/aiti-cpu-meter/meter-version";
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    fetch(versionUrl, { cache: "no-store", signal: ac.signal })
      .then((r) => r.json())
      .then((j) => (j && j.hash ? String(j.hash) : ""))
      .catch(() => "")
      .then((hash) => {
        clearTimeout(timer);
        if (document.querySelector('script[' + INJECT_FLAG + '="' + base + '"]')) return;
        const f = feats();
        // 配置随全局变量传给外部版（外部版读取优先级：URL 参数 > __aitiCpuMeterOpts > 默认）
        try { window.__aitiCpuMeterOpts = { pos: posFrom(f), score: f.score !== false, minimize: f.minimize !== false }; } catch (e) {}
        const s = document.createElement("script");
        s.src = hash ? assetUrl + "?v=" + encodeURIComponent(hash) : assetUrl;
        s.defer = true;
        s.setAttribute(INJECT_FLAG, base);
        document.head.appendChild(s);
        console.log("[aiti-cpu-meter] 注入目标实例检测器：" + s.src);
      });
  }

  function apply() {
    const f = feats();
    const enabled = f.enabled !== false;
    const useExternal = f["inject.enabled"] === true && typeof f["service.url"] === "string" && f["service.url"].trim();
    const key = useExternal ? "ext|" + f["service.url"].trim() : (enabled ? "local" : "off");
    if (appliedKey === key) return; // 无变化
    appliedKey = key;
    removeInjected();
    disposeMeter();
    if (useExternal) { injectExternal(f["service.url"]); return; }
    if (!enabled) return;
    // 内部版：float 模式——面板接 aiti-float 契约（拖动/位置持久化统一归它，FAB 仍自带拖动）
    // 问 AI 按钮（askAi feature 默认开）：经 aiti-helper 建卡顿调试会话
    const actions = f.askAi === false ? [] : [askAiAction()];
    meter = createMeter({ pos: posFrom(f), score: f.score !== false, minimize: f.minimize !== false, snaps: true, float: true, actions: actions });
  }

  apply();
  if (typeof ctx.onFeatureChange === "function") {
    ctx.onFeatureChange(() => { appliedKey = ""; apply(); });
  }

  try { console.log("[aiti-cpu-meter] 内部版已挂载（features: enabled/pos/score/minimize/askAi + inject.enabled/service.url）"); } catch (e) {}

  return () => { removeInjected(); disposeMeter(); };
}
