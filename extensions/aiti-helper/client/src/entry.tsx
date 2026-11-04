/**
 * aiti-helper · 薄 entry（[懒加载 v2 拆包] 常驻层，目标 ~15K）
 *
 * 职责 = helper 的「全局接线」，页面加载即装（index.ts clientImmediately: true）：
 *   1. 稳定 invoke 入口：window.__aitiHelperInvoke / __aitiSuggestAiFallback /
 *      services（stub 期受理请求 → 动态 import 重 UI chunk → 真身接管后重放）
 *   2. 全局弹窗 AI 按钮（MutationObserver 注入，见 ./dialog-ai-button.ts）
 *   3. toolbar 🤖 条目（与 index.ts 静态声明 id 对齐 aiti-helper-open）
 *
 * 重 UI（弹窗本体 helper-app.tsx，~60K+）按需：首次 invoke / 点按钮时才拉 chunk；
 * mountHeavyUI() 负责 pages 弹窗注册并把 invoke 真身交回本层接管转发。
 *
 * 拆包动机：懒化期（M3批②）helper 的三组全局副作用只在点过 toolbar 后才生效——
 * 其他扩展弹窗没有 🤖 按钮、__aitiHelperInvoke 未注册、suggest 兜底失效。
 * 全局接线必须常驻，而弹窗 UI 可以按需——故拆两层。
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 */
import { __setCtx, regSvc } from "./host-shim";
import { installDialogAiButton } from "./dialog-ai-button";
// 纯类型导入：编译期完全擦除，不会把重 UI 拉进薄 chunk；invoke 选项类型与重 UI 单源
import type { HelperInvokeOpts } from "./helper-app";

type InvokeOpts = HelperInvokeOpts;

// ==================== 稳定 invoke 转发（stub ↔ 真身） ====================
let realInvoke: ((opts?: InvokeOpts) => boolean) | null = null;
let loadingUI: Promise<void> | null = null;
// stub 期受理的最后一次请求。invoke 语义 = 每次重置弹窗状态，UI 未现期间中间请求无可见
// 意义，只保留最后一次即用户最终意图（真身接管后重放这一次）。
let pendingOpts: InvokeOpts | null = null;

function ensureHeavy(): void {
  if (loadingUI) return;   // 单例：并发 invoke 共享同一次加载（浏览器对同 URL 模块也天然去重）
  loadingUI = import("./helper-app").then((m) => {
    realInvoke = m.mountHeavyUI();   // pages 弹窗注册 + invoke 真身装配
    if (pendingOpts) {
      const o = pendingOpts;
      pendingOpts = null;
      realInvoke!(o);                // 重放 stub 期受理的请求 → 弹窗立即打开
    }
    try { console.log("[aiti-helper] 重 UI chunk 已加载，弹窗就绪"); } catch {}
  }).catch((err) => {
    loadingUI = null;                // 失败复位：下次 invoke 自动重试
    try { console.error("[aiti-helper] 重 UI chunk 加载失败（下次 invoke 重试）：", err); } catch {}
  });
}

function invokeStable(opts: InvokeOpts = {}): boolean {
  if (realInvoke) return realInvoke(opts);
  pendingOpts = opts;
  ensureHeavy();
  return true;   // 已受理：chunk 加载完成后自动打开
}

// suggest AI 兜底（aiti-ai-input 无静态命中时调用）——包装与文案单源在本层，防两处漂移
function suggestStable(q: string): void {
  invokeStable({
    system: "用户在聊天输入框打字但没命中收藏命令/prompt。请根据用户输入生成一条有用的简短建议（命令或 prompt 文本），只输出建议内容本身，不加解释。",
    placeholder: "AI 生成中…（基于「" + q + "」）",
    contextLabel: "suggest 兜底：「" + q + "」",
  });
}

// ==================== register ====================
export default function register(ctx: Record<string, any>) {
  // 重要：必须在任何渲染前调用（host-shim 模块级持 ctx；重 chunk mountHeavyUI 经 hostCtx() 读）
  __setCtx(ctx);

  // toolbar 🤖（AppShell 全局壳；index.ts 有同 id 静态声明作首帧兜底，注册后接管）
  ctx.registerItems?.("toolbar", [{
    id: "aiti-helper-open",
    meta: {
      label: "AI 助手",
      title: "aiti-helper：一句话唤起 AI（帮助点/自由发挥；独立置顶弹窗，可拖拽，有历史）",
      icon: "icons/sparkles.svg",
      onClick: () => window.__aitiHelperInvoke!({ placeholder: "描述你想让 AI 做什么…" }),
    },
  }]);
  // pages 弹窗条目不在此注册——重 UI mountHeavyUI() 装配时按需注册

  // 稳定入口：window 全局 + DI services 双轨。stub 期即注册，消费方（cpu-meter 问 AI、
  // ai-input suggest 兜底、任意 extSvc("aiti-helper.invoke")）无需等待/感知 UI 加载。
  window.__aitiHelperInvoke = invokeStable;
  window.__aitiSuggestAiFallback = suggestStable;
  regSvc?.("aiti-helper.invoke", invokeStable);
  regSvc?.("aiti-helper.suggestFallback", suggestStable);

  // 全局弹窗 AI 按钮（MutationObserver 注入；点击 → 稳定入口 → 按需拉起重 UI）
  const cleanupAiButton = installDialogAiButton();
  try { (window as any).__aitiHelperCleanup = cleanupAiButton; } catch {}

  try { console.log("[aiti-helper] 薄 entry 已挂载：稳定 invoke 入口 + 全局弹窗 AI 按钮（重 UI 按需加载）"); } catch {}
}
