/**
 * aiti-editor 注入缓冲 helper（多编辑器机制 §1.5）——实现扩展 client 统一走这里。
 *
 * 背景：aiti-editor 与实现扩展（aiti-sheet-univer / aiti-word-* 等）的 client 加载
 * 时序不定。晚到的注入需要缓冲重放：
 *   - aiti-editor 已就绪（window.__aitiEditor 存在）→ 立即注册；
 *   - 未就绪 → 注册函数推进 window.__aitiEditorQueue，aiti-editor setupRegistry
 *     挂载后 flush，并广播 `aiti-editor:registry-ready` 事件。
 *
 * 用法（实现扩展 client 入口）：
 *   import { whenAitiEditorReady } from "../_shared/aiti-editor-inject.mjs";
 *   whenAitiEditorReady(() => {
 *     window.__aitiEditor.registerEditorProvider({ id: "…", displayName: "…", selector: { extensions: [".xlsx"] },
 *       capabilities: ["preview", "edit"], render(host, ctx) { … return { el, dispose() {} }; } });
 *     window.__aitiEditor.registerContentProvider({ id: "…", write(filePath, data, baseMtimeMs) { … } });
 *   });
 *
 * 本文件按「共享权威源 + 构建期内联」模式消费（同 cursor-cli-store）：实现扩展的
 * vite 构建会把本模块打进各自 bundle，运行时零跨目录依赖。
 */

/**
 * aiti-editor 就绪后执行 registerNow（幂等安全：已就绪立即同步执行；
 * 未就绪入队，aiti-editor 就绪时重放）。异常只打日志不扩散（注册失败不拖垮宿主页面）。
 * @param {() => void} registerNow
 */
export function whenAitiEditorReady(registerNow) {
  if (typeof window === "undefined") return;
  if (window.__aitiEditor) {
    try { registerNow(); } catch (e) { console.error("[aiti-editor-inject] 注册失败:", e); }
    return;
  }
  if (!Array.isArray(window.__aitiEditorQueue)) window.__aitiEditorQueue = [];
  window.__aitiEditorQueue.push(() => {
    try { registerNow(); } catch (e) { console.error("[aiti-editor-inject] 注册失败(重放):", e); }
  });
}

/**
 * 监听注册表就绪（含已就绪场景立即触发一次）。用于需要在注册表 ready 后
 * 再做的初始化（如读偏好、拉取候选列表）。
 * @param {() => void} cb
 */
export function onAitiEditorReady(cb) {
  if (typeof window === "undefined") return;
  if (window.__aitiEditor) { try { cb(); } catch (e) { console.error("[aiti-editor-inject]", e); } return; }
  const h = () => { window.removeEventListener("aiti-editor:registry-ready", h); try { cb(); } catch (e) { console.error("[aiti-editor-inject]", e); } };
  window.addEventListener("aiti-editor:registry-ready", h);
}
