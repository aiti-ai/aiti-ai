/**
 * row-menu —— 会话行「⋮」菜单共享件（All Sessions 面板 / SidebarDock 左栏行两面同源）。
 *
 * 抽取自 sessions-panel（2026-09-09）：模块级状态 + 常驻宿主模式（同 tag-popover /
 * confirm-dialog——RowMenuHost 挂 dialogs slot 全局一次，行 hover 卸载/面板关闭不断）。
 * 触发面两处：面板 RowMenu 组件、dock 行内 openRowMenu(items, el) 直调。
 *
 * buildLivePiRowMenuItems：活动 pi 会话全量菜单项（重命名/生成名字/移动到…/相关文档/
 * 时间线）——All Sessions 与 dock 默认同一份菜单，内容一致性由本函数唯一保证。
 *  - 生成名字：面板沿用自身 rowBusy 记账（opts.runAutoName 覆写）；dock 走模块级
 *    runAutoNameSession（自带 busy 防重入 + 失败 alert + refreshSessions）。
 *  - 移动到…：模块级 showMoveDialog（move-dialog.tsx 常驻宿主），两面同一弹窗。
 *  - 时间线：aiti-git-trace-open 公开通道（与顶栏行 ⎇ / FileViewer / aiti-git-review 同款；
 *    trace 未装/未启用时事件无人消费，静默无害）。菜单展开面低频 → 长显不接 feature。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t, apiUrl } from "./host-shim";
import { ensureReadability, sessionTitle } from "./helpers";
import { refreshSessions, applySessionNameLocal } from "./store";
import { showRelatedDocs } from "./related-docs";
import { showToast } from "./toast";

export type MenuItem = {
  key: string;
  icon: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

const rowMenuState = {
  open: null as null | { items: MenuItem[]; rect: { top: number; bottom: number; right: number } },
  subs: new Set<() => void>(),
};
export function closeRowMenu() {
  rowMenuState.open = null;
  for (const l of rowMenuState.subs) l();
}

/** 触发「⋮」菜单（面板 RowMenu 组件与 dock 行内按钮共用的打开口）。
 *  rect 取触发按钮视口坐标（top/bottom/right），宿主按它钳位/上翻定位。
 *  触发元素可能是 null（如 React 合成事件在异步回调里 currentTarget 已置空）——
 *  无锚点则直接返回，不抛异常。调用面务必在同步代码里捕获元素再传入。 */
export function openRowMenu(items: MenuItem[], trigger: HTMLElement | null) {
  if (!trigger) return;
  const r = trigger.getBoundingClientRect();
  rowMenuState.open = { items, rect: { top: r.top, bottom: r.bottom, right: r.right } };
  for (const l of rowMenuState.subs) l();
}

/** 「时间线」→ 打开该会话的变更时间线：aiti-git-trace-open 公开通道 */
export function openSessionTimeline(sessionId: string) {
  try {
    window.dispatchEvent(new CustomEvent("aiti-git-trace-open", { detail: { kind: "timeline", data: { sessionId } } }));
  } catch { /* noop */ }
}

// ── 生成名字（模块级）：面板缺省走自身 rowBusy，dock 走这里 ──
const autoNameBusy = new Set<string>();
export function isAutoNameBusy(sessionId: string): boolean {
  return autoNameBusy.has(sessionId);
}

/** 会话是否被 TUI 桥占用——桥占用时 auto-name 无法起本地 runtime（会 409 双写拒绝），
 *  应降级为手动重命名（startRename），而不是弹「生成名字失败」。探测失败视为非桥（走原流程，
 *  服务端仍会兜底 409）。 */
async function sessionIsBridged(sessionId: string): Promise<boolean> {
  try {
    const r = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/state`));
    const d = await r.json().catch(() => ({}));
    return (r.ok && d.bridged === true) || (!r.ok && d.code === "session_bridged_unreachable");
  } catch {
    return false;
  }
}

/** pi-web core auto-name 端点（归档/外部会话不适用）；成功后 refreshSessions 全局刷新。 */
export async function runAutoNameSession(sess: any) {
  if (!sess?.id || autoNameBusy.has(sess.id)) return;
  if (await sessionIsBridged(sess.id)) {
    // 桥占用 → 提示原因并静默跳过（菜单 onClick 已降级为重命名，此处为直调路径兜底）
    showToast(t("sm.autoNameBridged") ?? "该会话正由终端（TUI）占用，无法自动生成名字，请手动命名。");
    return;
  }
  autoNameBusy.add(sess.id);
  try {
    const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sess.id)}/auto-name`), { method: "POST" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.title) window.alert?.(`${t("sm.autoNameFailed") ?? "生成名字失败"}：${d.error ?? res.status}`);
    else {
      applySessionNameLocal(sess.id, d.title); // 就地更新 store（同重命名，不等列表刷新）
      void refreshSessions(); // 后台对齐
    }
  } catch (e) {
    window.alert?.(`${t("sm.autoNameFailed") ?? "生成名字失败"}：${e instanceof Error ? e.message : String(e)}`);
  } finally { autoNameBusy.delete(sess.id); }
}

/** 活动 pi 会话行菜单全量项（重命名/生成名字/移动到…/相关文档/时间线）。
 *  opts.startRename/onMove 由调用面给（面板 = 行内改名 + setMoveSess 语义；dock = 行内改名 +
 *  showMoveDialog）；autoNameBusy/runAutoName 缺省回落模块级实现。
 *  opts.pin 可选：传入则菜单首项插入「置顶/取消置顶」（dock 用；面板不传 → 无此项，行为不变）。 */
export function buildLivePiRowMenuItems(opts: {
  sess: any;
  running: boolean;
  startRename: () => void;
  onMove: () => void;
  autoNameBusy?: boolean;
  runAutoName?: () => void;
  pin?: { pinned: boolean; onToggle: () => void };
}): MenuItem[] {
  const { sess, running, startRename, onMove } = opts;
  const items: MenuItem[] = [];
  if (opts.pin) {
    items.push({
      key: "pin", icon: "📌",
      label: opts.pin.pinned ? (t("sm.unpin") ?? "取消置顶") : (t("sm.pin") ?? "置顶"),
      onClick: opts.pin.onToggle,
    });
  }
  items.push({ key: "rename", icon: "✏️", label: t("sm.rename") ?? "重命名", onClick: startRename });
  if (!running) {
    items.push({
      key: "autoname", icon: "✨", label: t("sm.autoName") ?? "生成名字",
      disabled: opts.autoNameBusy ?? isAutoNameBusy(sess.id),
      onClick: () => {
        void (async () => {
          // 桥占用 → 降级为手动重命名（行内改名，默认名字/首消息），toast 说明原因；否则正常 AI 生成。
          if (await sessionIsBridged(sess.id)) {
            showToast(t("sm.autoNameBridged") ?? "该会话正由终端（TUI）占用，无法自动生成名字，请手动命名。");
            startRename();
            return;
          }
          if (opts.runAutoName) opts.runAutoName(); else void runAutoNameSession(sess);
        })();
      },
    });
    items.push({ key: "move", icon: "📁", label: t("sm.move") ?? "移动到…", onClick: onMove });
  }
  items.push({ key: "related-docs", icon: "📄", label: t("sm.relatedDocs") ?? "相关文档", onClick: () => showRelatedDocs(sess.id, sessionTitle(sess)) });
  items.push({ key: "timeline", icon: "⎇", label: t("sm.timeline") ?? "时间线", onClick: () => openSessionTimeline(sess.id) });
  return items;
}

/** 「⋮」触发按钮（All Sessions 行内用；dock 行内自绘按钮直调 openRowMenu）。 */
export function RowMenu(props: { items: MenuItem[] }) {
  const [open, setOpen] = useState(rowMenuState.open);
  useEffect(() => {
    const l = () => setOpen(rowMenuState.open);
    rowMenuState.subs.add(l);
    return () => { rowMenuState.subs.delete(l); };
  }, []);
  return (
    <span style={{ position: "relative", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
      <button
        title={t("sm.more") ?? "更多操作"}
        data-row-menu-trigger="1"
        onClick={(e) => { openRowMenu(props.items, e.currentTarget); }}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 26, height: 22, padding: 0, flexShrink: 0,
          background: open ? "var(--bg-hover)" : "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6, cursor: "pointer",
          color: open ? "var(--text)" : "var(--text-dim)",
          fontSize: 12, fontWeight: 700, lineHeight: 1,
          opacity: open ? 1 : 0.7,
          transition: "background .12s, color .12s, opacity .12s, border-color .12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = open ? "var(--bg-hover)" : "var(--bg)"; e.currentTarget.style.color = open ? "var(--text)" : "var(--text-dim)"; e.currentTarget.style.opacity = open ? "1" : "0.7"; }}
      >⋮</button>
    </span>
  );
}

/** 常驻「⋮」菜单宿主（entry.tsx dialogs slot 全局挂一次）：position:fixed 视口坐标 +
 *  视口钳位/上翻。z-index 2147483500 高于 aiti-float 抬升上限（2147483000）——
 *  面板点按置前后菜单仍可见；dock（左栏，非浮窗）同样覆盖。 */
export function RowMenuHost() {
  const [open, setOpen] = useState(rowMenuState.open);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const l = () => setOpen(rowMenuState.open);
    rowMenuState.subs.add(l);
    return () => { rowMenuState.subs.delete(l); };
  }, []);
  // 外部点击关闭（mousedown 捕获）：菜单项点击先执行 onClick 再收起；触发按钮保 toggle 语义不放行。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (boxRef.current && boxRef.current.contains(target)) return;
      if (target instanceof Element && target.closest("[data-row-menu-trigger]")) return;
      closeRowMenu();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);
  // 渲染后测量：视口钳位（左右）+ 底部放不下向上翻（顶）。useLayoutEffect 在绘制前同步，无闪烁。
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !open) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    const w = Math.min(r.width, vw - pad * 2);
    let top = open.rect.bottom + 4;
    if (top + r.height > vh - pad) top = Math.max(pad, open.rect.top - r.height - 4);
    const left = Math.max(pad, Math.min(open.rect.right - w, vw - pad - w));
    setPos({ left, top });
  }, [open]);
  if (!open) return null;
  return (
    <div
      ref={boxRef}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed", left: pos?.left, top: pos?.top, zIndex: 2147483500,
        minWidth: 150, background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: 9, boxShadow: "0 8px 30px rgba(0,0,0,0.35)", padding: 4,
        display: "flex", flexDirection: "column", gap: 1,
      }}
    >
      {open.items.map((it) => (
        <button
          key={it.key}
          disabled={it.disabled}
          onClick={(e) => { e.stopPropagation(); closeRowMenu(); it.onClick(); }}
          onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
          style={{
            display: "flex", gap: 7, alignItems: "center", padding: "5px 9px",
            fontSize: 11, border: "none", background: "none", textAlign: "left",
            cursor: it.disabled ? "default" : "pointer", borderRadius: 6,
            color: it.danger ? ensureReadability("#f87171") : "var(--text)", whiteSpace: "nowrap",
            opacity: it.disabled ? 0.4 : 1,
          }}
        >
          <span style={{ width: 14, textAlign: "center" }}>{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}
