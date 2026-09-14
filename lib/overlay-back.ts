"use client";

/**
 * 小屏「系统返回」关闭浮层的统一退栈器（overlay back stack）。
 *
 * 场景：手机上打开抽屉/浮窗/弹窗（左栏、右栏、设置、扩展浮窗…）时，按系统返回
 * （Android 返回键 / iOS 侧滑）第一步应只关闭最上面那层浮层、露出主页面，
 * 而不是直接退站/退出 PWA；再按一次才真正返回。
 *
 * 机制：浮层打开时 push 一条同 URL 历史条目（state 里带本机制 token）；popstate 时
 * 关闭「离开的那条浮层条目」对应的层。**历史只有一个写入口**——宿主独占本模块，
 * 扩展经 `ctx.getExtService("pi-web.overlayBack")` 的 acquire() 参与，不允许各自
 * 监听 popstate（两套栈会互相踩条目）。
 *
 * 设计要点：
 *  - 是否启用由调用方决定（宿主 hook 用 `isMobile`；扩展消费方自己判小屏断点），
 *    本模块只管历史退栈这一件事。
 *  - 用户点 ✕ 关闭（release()）时，若当前历史条目还是本层 → `history.back()`
 *    把条目清掉，避免反复开/关后在历史里堆一串空条目（否则要按多次返回才能退站）。
 *    该自身回退用 selfBacks 计数吞掉对应的 popstate，竞态窗口里绝不误关活性层。
 *  - 系统返回落到「已 UI 关闭但条目尚在」的空条目时继续自动回退一格——用户只感到
 *    一次返回就回到非浮层页面。
 *  - 前进导航（极少）落到失效条目 → replaceState 抹标记归一化，不做任何关闭。
 *  - pushState 只带 state 不带 URL（`pushState(state, "")`），路径/查询串零污染；
 *    state 经展开保留 Next App Router 的 `__NA`/内部树（Next 的重载判定依赖它）。
 */

const KEY = "__piWebOverlayBack";
const POS_KEY = "__piWebOverlayBackPos";

export interface OverlayBackHandle {
  /** 释放本层（浮层关闭时调用；幂等）。 */
  release(): void;
}

interface Layer {
  token: number;
  close: () => void;
}

let installed = false;
let seq = 0;
let pos = 0;
const layers: Layer[] = [];
let lastToken: number | null = null;
let lastPos = 0;
/** release() 自身回退计数：其 popstate 只同步状态、不关闭任何层。 */
let selfBacks = 0;
let selfBackTimer: ReturnType<typeof setTimeout> | null = null;

function readEntry(state: unknown): { token: number | null; pos: number } {
  const o = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  return {
    token: typeof o[KEY] === "number" ? (o[KEY] as number) : null,
    pos: typeof o[POS_KEY] === "number" ? (o[POS_KEY] as number) : 0,
  };
}

function currentEntry(): { token: number | null; pos: number } {
  return readEntry(window.history.state);
}

function isActiveToken(token: number | null): boolean {
  return token !== null && layers.some((l) => l.token === token);
}

/** 落到「UI 关闭后残留的空条目」→ 继续回退一格（用户视角仍是一次返回）。 */
function skipVacantEntry(token: number | null): void {
  if (token !== null && !isActiveToken(token)) {
    try {
      window.history.back();
    } catch {
      /* 沙箱环境禁用 history：忽略 */
    }
  }
}

function onPopState(event: PopStateEvent): void {
  const from = lastToken;
  const fromPos = lastPos;
  const to = readEntry(event.state);
  lastToken = to.token;
  lastPos = to.pos;
  if (selfBacks > 0) {
    selfBacks -= 1;
    if (selfBackTimer) {
      clearTimeout(selfBackTimer);
      selfBackTimer = null;
    }
    // 自身清理回退：不关任何层——竞态窗口里即便吞掉了刚打开的新层条目，也绝不误关活性层
    return;
  }
  if (to.pos >= fromPos) {
    // 前进（或宿主重写了 state）：落到失效浮层条目就抹标记归一化，不做关闭
    if (to.token !== null && !isActiveToken(to.token)) {
      try {
        window.history.replaceState({ ...(event.state ?? {}), [KEY]: null, [POS_KEY]: to.pos }, "");
      } catch {
        /* ignore */
      }
      lastToken = null;
    }
    return;
  }
  const idx = from === null ? -1 : layers.findIndex((l) => l.token === from);
  if (idx >= 0) {
    const [layer] = layers.splice(idx, 1);
    try {
      layer.close();
    } catch {
      /* 关闭回调异常不阻断回退链 */
    }
  }
  skipVacantEntry(to.token);
}

function ensureInstalled(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const entry = currentEntry();
  lastToken = entry.token;
  lastPos = entry.pos;
  window.addEventListener("popstate", onPopState);
}

/**
 * 注册一个「系统返回时关闭」的浮层。在小屏浮层打开的那一刻调用（React effect）；
 * 返回 handle，浮层关闭时 release()。非浏览器环境返回 no-op handle。
 */
export function acquireOverlayBack(close: () => void): OverlayBackHandle {
  if (typeof window === "undefined" || typeof window.history?.pushState !== "function") {
    return { release() {} };
  }
  ensureInstalled();
  const token = ++seq;
  const layer: Layer = { token, close };
  layers.push(layer);
  const cur = currentEntry();
  // 当前条目是本机制留下的空槽（此前已 UI 关闭）→ 复用该条目（replaceState），
  // 不让历史堆积空条目；否则新压一条。
  const reuse = cur.token !== null && !isActiveToken(cur.token);
  const base = (window.history.state && typeof window.history.state === "object"
    ? window.history.state
    : {}) as Record<string, unknown>;
  if (reuse) {
    pos = cur.pos;
    try {
      window.history.replaceState({ ...base, [KEY]: token, [POS_KEY]: pos }, "");
    } catch {
      /* ignore */
    }
  } else {
    pos = Math.max(pos, cur.pos) + 1;
    try {
      window.history.pushState({ ...base, [KEY]: token, [POS_KEY]: pos }, "");
    } catch {
      /* 某些环境禁用 history：本层降级为无返回关闭能力 */
    }
  }
  lastToken = token;
  lastPos = pos;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const idx = layers.findIndex((l) => l.token === token);
      if (idx >= 0) layers.splice(idx, 1);
      // 当前条目还是本层 → 自身回退清掉；已被系统返回带离场则 token 不匹配，跳过。
      // 关键：回退推迟到微任务——同一 commit 里「关旧开新」（如小屏点侧栏文件：收
      // 侧栏 + 开右栏同时发生）时，新层的 acquire 会先把本条空槽 replaceState 复用
      // 掉；此时回退必须取消，否则会把新层的历史条目一起退回，返回键就关不掉新层。
      if (currentEntry().token === token) {
        queueMicrotask(() => {
          if (currentEntry().token !== token) return; // 空槽已被新层复用 / 已被带离场
          selfBacks += 1;
          if (selfBackTimer) clearTimeout(selfBackTimer);
          // 防御计时：极端环境下回退没有产生 popstate 时，复位计数避免吞掉后续真实返回
          selfBackTimer = setTimeout(() => {
            selfBackTimer = null;
            selfBacks = 0;
          }, 2000);
          try {
            window.history.back();
          } catch {
            selfBacks = Math.max(0, selfBacks - 1);
          }
        });
      }
    },
  };
}

/** 测试/调试出口：当前活跃层数。 */
export function overlayBackDepth(): number {
  return layers.length;
}
