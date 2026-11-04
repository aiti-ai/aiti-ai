/**
 * aiti-ai-speek · client 入口（D2 拆包薄壳版，docs/aiti-ext-lazy-loading-plan.md D2）
 *
 * register(ctx) 装配（薄壳 ~4K，启动物理）：
 *   - toolbar 唯一常驻入口：🔊 跟读开关（薄壳版）
 *   - 点击开启 → toggleFollow()（speaker 状态置 followOn=true，零网络）→
 *     按需 import 重 chunk → initHeavySlots 重注册全部插槽 → 重 chunk 的
 *     HeavyFollowToggle 渲染时读同一 speaker store（followOn=true）→ 自动完成
 *     会话订阅 + 上次位置恢复 + 入播。
 *
 * 状态共享原理：薄壳与重 chunk import 同一 speaker.js URL——浏览器模块去重，
 * 两者拿到同一 store 实例，无任何状态桥。
 *
 * 降级说明：跟读关闭时本来就零请求——薄壳不损失任何关闭态功能。
 *
 * 构建：npm run build:client；部署：node tools/deploy.mjs（拷主 bundle + 分块）
 */
import { __setCtx } from "./host-shim";
import { installSessionService } from "./session-svc";

// 薄壳内联最小状态（点击后与重 chunk 的 speaker.store 经 loadHeavy 同步）
const shell = { followOn: false, pendingOn: false, apiUrlSet: false, features: {} };
let heavyPromise = null;
async function loadHeavy(ctx) {
  if (!heavyPromise) {
    heavyPromise = import("./speaker").then((sp) => {
      // apiUrl/features 透传到真实 store（薄壳期收集）
      if (!shell.apiUrlSet) sp.setApiUrl(typeof ctx.apiUrl === "function" ? ctx.apiUrl : (p) => p);
      sp.setSettings(shell.features);
      // 引擎初始判定（auto/browser 升级、edge 可用性收敛）在重 chunk 内执行——
      // 薄壳期 register 只做零依赖 /voices 预热探测（见 register 尾部），判定本体不前移
      void sp.autoSelectEngine();
      return sp;
    }).then((sp) => import("./components").then((m) => {
      m.initHeavySlots(ctx); // 重注册：HeavyFollowToggle 接管 + bar/settings/read 就位
      return { sp, m };
    }));
  }
  return heavyPromise;
}

export default function register(ctx) {
  __setCtx(ctx);
  // 统一会话状态服务订阅（pi-web.session）：组件取 root id 仅限 active（禁 URL 未验证直读）。
  installSessionService(ctx);

  // features：薄壳期收集（重 chunk 加载时经 setSettings 透传）
  const syncFeatures = () => {
    const feats = typeof ctx.getFeatures === "function" ? ctx.getFeatures() : {};
    if (typeof feats["minChars"] === "string" && feats["minChars"] !== "") {
      shell.features.minChars = Math.max(0, parseInt(feats["minChars"], 10) || 0);
    }
  };
  syncFeatures();
  if (typeof ctx.onFeatureChange === "function") ctx.onFeatureChange(syncFeatures);

  // 薄壳开关：点击 = toggleFollow（followOn=true）→ 加载重 chunk → initHeavySlots
  // 重注册「follow」条目为 HeavyFollowToggle（同 id 覆盖）→ 它渲染时读 followOn=true
  // 并执行订阅/恢复/入播（原跟随 effect 语义不变）。
  function ShellToggle() {
    const h = ctx.h;
    const on = shell.followOn || shell.pendingOn;
    return h("button", {
      className: "aisp-btn-tb" + (shell.followOn || shell.pendingOn ? " on" : ""),
      title: shell.followOn || shell.pendingOn
        ? "跟读模式：开启中（引擎模块加载后接管播放条）"
        : "跟读模式：AI 回复自动朗读（点按开启）",
      "aria-pressed": (shell.followOn || shell.pendingOn) ? "true" : "false",
      onClick: () => {
        if (shell.followOn || shell.pendingOn) return; // 已开：接管后的真实开关管理
        shell.pendingOn = true;
        loadHeavy(ctx)
          .then(({ sp }) => {
            // 薄壳期开启意图 → speaker store followOn = true
            // HeavyFollowToggle 接管后读 followOn=true 自动开始订阅/恢复
            sp.setFollow(true);
            shell.followOn = true;
            shell.pendingOn = false;
          })
          .catch(() => { shell.pendingOn = false; });
      },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
        // 宿主 topbar 条目外壳 align-items:stretch + 行高 36px——固定交叉尺寸会退化成
        // flex-start 顶对齐（图标偏上 4px）。与重 chunk 版 .aisp-btn-tb 同款 36×36 填满居中。
        width: 36, height: 36, border: "none", borderRadius: 8,
        background: "transparent",
        color: on ? "var(--accent,#3b82f6)" : "var(--text-muted,#777)",
        cursor: "pointer", transition: "background .12s,color .12s",
        outline: "none",
      },
    },
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: on ? "currentColor" : "none",
        stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M11 5 6 9H2v6h4l5 4V5z" }),
        h("path", { d: "M15.5 8.5a5 5 0 0 1 0 7" }),
        h("path", { d: "M19 5a9 9 0 0 1 0 14" })
      )
    );
  }

  ctx.registerItems?.("toolbar", [
    { id: "follow", render: ShellToggle, meta: { label: "跟读模式", title: "跟读模式：AI 回复自动朗读", icon: "icons/volume-2.svg" } },
  ]);

  try { console.log("[aiti-ai-speek] 薄壳已挂载（🔊 开关；跟读引擎首次开启时按需加载）"); } catch {}

  // 注：原「edge-tts 可用性预热」在 register 时拉一次 /voices（触发服务端 autoEnableEdge）——
  // 已移除：开页不再打这个请求。重 chunk 首次加载（用户开启跟读/打开设置）时
  // autoSelectEngine 会拉 /voices 并完成同一判定，语义不变、时机变成「用到才拉」。
  // 薄壳绝不引用重 chunk 导出——D2 拆包回潮防护。
}
