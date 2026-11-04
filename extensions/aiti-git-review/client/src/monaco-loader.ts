/**
 * aiti-git-review · Monaco AMD 加载器（与 aiti-editor 同源资产；window.monaco 已存在则复用）。
 *
 * Monaco AMD 依赖链全有-or-none：任一依赖脚本（loader.js / editor.main / worker shim）
 * 被浏览器中止（网络抖动/页面导航）就整链失败。旧实现把 reject 永久缓存 → 只能刷页恢复；
 * 这里失败即清场重试，彻底失败后置空不毒化（下次 diff/打开仍会重新加载）。
 */

let monacoPromise: Promise<any> | null = null;
let monacoAttempts = 0;
const MONACO_MAX_ATTEMPTS = 3;
// 注：不再做「清场重试」（移除 /monaco/vs/ 脚本 + 删 window.require/define）。
// 破坏性清场会把正在加载中的 AMD 模块链拦腰斩断（模块执行时 define 已消失 →
// 静默不注册，依赖方永远等待）。attempt() 本身幂等（monaco 就绪/loader 已执行/
// 需注入三种状态都能自愈），重试时直接重新评估当前状态即可。

// loader.js 执行就绪的全局握手（跨扩展共享）：谁注入谁登记，后续调用方直接复用同一个
// Promise——用 Promise 而非 DOM load 事件，避免“事件已触发过后再挂监听”的静默悬挂。
function ensureLoaderExecuted(vsBase: string): Promise<void> {
  const w = window as any;
  if (w.require) return Promise.resolve();
  if (w.__aitiLoaderReady) return w.__aitiLoaderReady;
  w.__aitiLoaderReady = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = vsBase + "/loader.js";
    script.onload = () => resolve();
    script.onerror = () => {
      if ((window as any).__aitiLoaderReady === w.__aitiLoaderReady) delete w.__aitiLoaderReady;
      reject(new Error("Monaco loader.js fetch fail"));
    };
    document.head.appendChild(script);
  });
  return w.__aitiLoaderReady;
}

export function loadMonaco(vsBase: string): Promise<any> {
  const w = window as any;
  if (w.monaco) return Promise.resolve(w.monaco);
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const attempt = () => {
      // 跨扩展安全（修双 loader 竞态）：本扩展与 aiti-editor 共用同一份 vs assets。
      // loader 注入经 ensureLoaderExecuted 全局握手去重（绝不二次注入执行）；
      // AMD 的 require/config/require(["vs/editor/editor.main"]) 幂等，直接复用。
      ensureLoaderExecuted(vsBase).then(() => {
        try {
          if (!w.require) return fail(new Error("loader.js: no require"));
          w.__aitiMonacoOwned = true;
          w.require.config({ paths: { vs: vsBase } });
          w.require(["vs/editor/editor.main"], () => {
            if (w.monaco) { monacoAttempts = 0; resolve(w.monaco); }
            else fail(new Error("editor.main loaded but no monaco"));
          }, (err: unknown) => fail(err || new Error("editor.main load fail")));
        } catch (e) { fail(e); }
      }).catch((e) => fail(e));
    };
    const fail = (err: unknown) => {
      monacoAttempts += 1;
      if (monacoAttempts >= MONACO_MAX_ATTEMPTS) {
        monacoPromise = null; // 不永久毒化
        reject(err);
        return;
      }
      setTimeout(attempt, monacoAttempts * 600); // 600ms / 1200ms 退避
    };
    attempt();
  });
  return monacoPromise;
}
