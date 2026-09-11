"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

export interface ModelSelectorOption {
  provider: string;
  modelId: string;
  name: string;
  /** 当前可用性（aiti-model-check 探测/运行期）：ok/rl(429)/err/unprobed——仅展示提示 */
  status?: "ok" | "rl" | "err" | "unprobed";
  /** 该 provider 整体限流（全部模型当前 429）——组头提示，不自动禁用 */
  providerRL?: boolean;
}

interface ModelSelectorProps {
  options: ModelSelectorOption[];
  value?: { provider: string; modelId: string } | null;
  onChange: (provider: string, modelId: string) => void;
  onClear?: () => void;
  emptyLabel?: string;
  selectedLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  /** 运行中切换模型后尚未生效（下轮生效）——显示「下轮生效」徽标，不锁选择器 */
  pending?: boolean;
  isAutoSelection?: boolean;
  ariaLabel?: string;
  variant?: "toolbar" | "field";
  placement?: "up" | "auto";
}

const MODEL_FILTER_THRESHOLD = 8;
export const RECENT_MODELS_KEY = "pi-web:recent-models";

// ── 面板几何（fixed 定位基准 = layout viewport，移动端键盘配合的关键）──
// 移动端键盘弹出/收起会改 visualViewport 并触发 useViewportHeight 的根高度重排
// （composer 随之移动），若面板只在打开瞬间算一次几何，就会错位并在后续重渲染时
// 忽大忽小。因此：打开期间监听视口事件触发重渲染，每次渲染重测锚点并按「可视区域」
// 钳制面板（锚点被键盘遮住 → 底边顶到键盘上方；空间/上限按可视高度算）。
export interface PanelViewport {
  /** layout viewport 高度（position:fixed 的基准） */
  layoutHeight: number;
  /** 可视区域上下缘（layout 坐标）：键盘弹出后被压缩 */
  visibleTop: number;
  visibleBottom: number;
}

/** 读取当前视口快照（渲染期调用） */
export function measurePanelViewport(): PanelViewport {
  const layoutHeight = window.innerHeight;
  const viewport = window.visualViewport;
  if (!viewport) return { layoutHeight, visibleTop: 0, visibleBottom: layoutHeight };
  return { layoutHeight, visibleTop: viewport.offsetTop, visibleBottom: viewport.offsetTop + viewport.height };
}

export interface PanelGeometry {
  openAbove: boolean;
  maxHeight: number;
  /** layout 坐标（top 与 bottom 二选一） */
  top?: number;
  bottom?: number;
}

const PANEL_GAP = 6;
const PANEL_MIN_HEIGHT = 120;
const PANEL_MAX_HEIGHT_RATIO = 0.6;

/**
 * 由锚点矩形 + 视口快照计算面板几何（纯函数，输入/输出均为 layout 坐标）。
 * 无键盘时（visibleTop=0/visibleBottom=layoutHeight）与固定锚点上方展开的历史
 * 行为一致；键盘弹出时面板整体压缩进可视区域，不再被键盘遮住或随重排跳变。
 */
export function computePanelGeometry(
  anchor: { top: number; bottom: number },
  viewport: PanelViewport,
  placement: "up" | "auto",
): PanelGeometry {
  const visibleHeight = viewport.visibleBottom - viewport.visibleTop;
  const spaceAbove = anchor.top - viewport.visibleTop - PANEL_GAP;
  const spaceBelow = viewport.visibleBottom - anchor.bottom - PANEL_GAP;
  const openAbove = placement === "up" || spaceAbove > spaceBelow;
  if (openAbove) {
    // 期望底边 = 锚点上方留缝；锚点被键盘遮住（低于可视底）→ 钳到可视底之上；
    // 锚点滚出可视顶（desired ≤ visibleTop）→ 面板贴可视区底部展开。
    const desired = anchor.top - PANEL_GAP;
    const bottomEdge = desired <= viewport.visibleTop
      ? viewport.visibleBottom - PANEL_GAP
      : Math.min(desired, viewport.visibleBottom - PANEL_GAP);
    const maxHeight = Math.max(
      PANEL_MIN_HEIGHT,
      Math.min(bottomEdge - viewport.visibleTop - PANEL_GAP, visibleHeight * PANEL_MAX_HEIGHT_RATIO),
    );
    return { openAbove, maxHeight, bottom: viewport.layoutHeight - bottomEdge };
  }
  const desired = anchor.bottom + PANEL_GAP;
  const topEdge = desired >= viewport.visibleBottom
    ? viewport.visibleTop + PANEL_GAP
    : Math.max(desired, viewport.visibleTop + PANEL_GAP);
  const maxHeight = Math.max(
    PANEL_MIN_HEIGHT,
    Math.min(viewport.visibleBottom - PANEL_GAP - topEdge, visibleHeight * PANEL_MAX_HEIGHT_RATIO),
  );
  return { openAbove, maxHeight, top: topEdge };
}
export const RECENT_MODELS_LIMIT = 8;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface RecentModelEntry {
  provider: string;
  modelId: string;
  at: number;
}

/** 读最近使用的模型（localStorage 持久化；损坏/非法条目静默忽略） */
export function readRecentModels(): RecentModelEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentModelEntry =>
      !!entry && typeof entry === "object"
      && typeof (entry as RecentModelEntry).provider === "string"
      && typeof (entry as RecentModelEntry).modelId === "string"
    );
  } catch {
    return [];
  }
}

/** 记录一次模型使用：置顶 + 去重 + 截断（LRU） */
export function rememberRecentModel(provider: string, modelId: string) {
  try {
    const rest = readRecentModels().filter((entry) => entry.provider !== provider || entry.modelId !== modelId);
    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(
      [{ provider, modelId, at: Date.now() }, ...rest].slice(0, RECENT_MODELS_LIMIT),
    ));
  } catch {
    /* 隐私模式等 localStorage 不可用 → 静默降级为无最近使用 */
  }
}

/**
 * 最近使用 → 面板分组条目：仅面板打开且非搜索态；按记录时间倒序；
 * 只保留当前仍可用的模型（已删除/下架自动消失）；去重；截断 RECENT_MODELS_LIMIT。
 * provider/modelId 分字段拼接作 Map key，从不切分——含 "/" 的模型 id 安全。
 */
export function pickRecentOptions(
  recentList: RecentModelEntry[],
  sortedOptions: ModelSelectorOption[],
  opts: { open: boolean; filter: string },
): ModelSelectorOption[] {
  if (!opts.open || opts.filter.trim()) return [];
  const byKey = new Map(sortedOptions.map((option) => [`${option.provider}/${option.modelId}`, option] as const));
  const picked: ModelSelectorOption[] = [];
  for (const entry of recentList) {
    if (picked.length >= RECENT_MODELS_LIMIT) break;
    const option = byKey.get(`${entry.provider}/${entry.modelId}`);
    if (option && !picked.includes(option)) picked.push(option);
  }
  return picked;
}

function compareModelOptions(a: ModelSelectorOption, b: ModelSelectorOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

export function filterModelOptions(options: ModelSelectorOption[], query: string): ModelSelectorOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  // provider 参与匹配：行内已展示 provider 后缀，搜 provider 名应能命中其下模型
  return options.filter((option) => (
    `${option.provider} ${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

export function ModelSelector({
  options,
  value,
  onChange,
  onClear,
  emptyLabel,
  selectedLabel,
  disabled = false,
  busy = false,
  pending = false,
  isAutoSelection = false,
  ariaLabel,
  variant = "toolbar",
  placement = "up",
}: ModelSelectorProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // 面板打开期间的视口变化计数：只触发重渲染，几何在渲染时用实时值重算（见下方 effect）
  const [viewportTick, setViewportTick] = useState(0);
  const [filter, setFilter] = useState("");
  const [recentList, setRecentList] = useState<RecentModelEntry[]>([]);
  const locked = disabled || busy;
  const sortedOptions = useMemo(() => [...options].sort(compareModelOptions), [options]);
  const filteredOptions = filterModelOptions(sortedOptions, filter);
  const showFilter = sortedOptions.length > MODEL_FILTER_THRESHOLD;

  // 面板每次打开时重读最近使用（其他窗口/其他 ModelSelector 实例可能已更新）
  useEffect(() => {
    if (open) setRecentList(readRecentModels());
  }, [open]);

  // 面板打开期间跟踪可视视口：移动端键盘弹出/收起（visualViewport resize/scroll +
  // 焦点变化）会压缩可视区并触发根高度重排，rAF 合并后重渲染 → 面板实时重锚。
  useEffect(() => {
    if (!open) return;
    let frameId: number | null = null;
    const schedule = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        setViewportTick((tick) => tick + 1);
      });
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
    };
  }, [open]);

  // 最近使用 → 按使用时间倒序，仅保留当前仍可用的模型（已删除/已下架的自动消失）
  const recentOptions = useMemo(
    () => pickRecentOptions(recentList, sortedOptions, { open, filter }),
    [open, filter, sortedOptions, recentList],
  );
  const modelsByProvider: { provider: string; options: ModelSelectorOption[] }[] = [];

  for (const option of filteredOptions) {
    const group = modelsByProvider.find((item) => item.provider === option.provider);
    if (group) group.options.push(option);
    else modelsByProvider.push({ provider: option.provider, options: [option] });
  }

  const currentName = selectedLabel ?? (value
    ? sortedOptions.find((option) => option.modelId === value.modelId && option.provider === value.provider)?.name ?? value.modelId
    : emptyLabel ?? (sortedOptions.length > 0 ? "Select model" : "No models"));

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        rootRef.current && !rootRef.current.contains(event.target as Node)
        && panelRef.current && !panelRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!locked) return;
    setOpen(false);
    setFilter("");
  }, [locked]);

  const buttonStyle: CSSProperties = variant === "field"
    ? {
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        minWidth: 0,
        height: 34,
        padding: "0 9px",
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: locked ? "var(--bg-panel)" : "var(--bg)",
        color: locked ? "var(--text-dim)" : "var(--text)",
        cursor: locked ? "default" : "pointer",
        fontSize: 12,
        textAlign: "left",
      }
    : {
        display: "flex",
        alignItems: "center",
        justifyContent: isMobile ? "flex-start" : undefined,
        gap: 6,
        width: isMobile ? "100%" : undefined,
        maxWidth: isMobile ? "100%" : 220,
        height: 32,
        padding: isMobile ? "8px 10px" : "8px 12px",
        overflow: "hidden",
        border: "none",
        borderRadius: 9,
        background: open ? "var(--bg-hover)" : "none",
        color: "var(--text-muted)",
        cursor: locked ? "not-allowed" : "pointer",
        fontSize: 12,
        opacity: locked ? 0.5 : 1,
        transition: "background 0.12s, color 0.12s",
      };

  const choose = (option: ModelSelectorOption) => {
    const active = option.modelId === value?.modelId && option.provider === value?.provider;
    rememberRecentModel(option.provider, option.modelId);
    setOpen(false);
    setFilter("");
    if (!active || isAutoSelection) onChange(option.provider, option.modelId);
  };

  return (
    <div
      ref={rootRef}
      className={`model-selector is-${variant}${locked ? " is-disabled" : ""}`}
      style={{ position: "relative", width: variant === "field" || isMobile ? "100%" : undefined, minWidth: 0, flex: variant === "toolbar" && isMobile ? "1 1 auto" : undefined }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setFilter("");
        setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={locked}
        title={busy ? "Switching model" : locked ? currentName : sortedOptions.length > 0 || onClear ? "Change model" : "No available models"}
        style={buttonStyle}
        onClick={() => {
          setOpen((current) => {
            if (current) setFilter("");
            return !current;
          });
        }}
        onMouseEnter={(event) => {
          if (locked) return;
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          if (locked) {
            event.currentTarget.style.background = variant === "field" ? "var(--bg-panel)" : "none";
            event.currentTarget.style.color = variant === "field" ? "var(--text-dim)" : "var(--text-muted)";
            return;
          }
          event.currentTarget.style.background = open ? "var(--bg-hover)" : variant === "field" ? "var(--bg)" : "none";
          event.currentTarget.style.color = variant === "field" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {busy ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
          </svg>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentName}</span>
        {pending && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, marginLeft: 4, fontSize: 10, color: "#d97706", whiteSpace: "nowrap", fontWeight: 600 }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            {t("chat.modelSwitchPendingBadge")}
          </span>
        )}
        {variant === "field" && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {open && (() => {
        void viewportTick; // 视口变化 → 上方 effect 触发重渲染，此处每次重测锚点/视口
        const anchor = buttonRef.current?.getBoundingClientRect();
        if (!anchor) return null;
        // v4 七审（用户拍板）：小屏模型面板全屏全高——锚定弹层在小屏被 maxHeight 压扁没法用；
        // 桌面（!isMobile）保持原锚定几何不变。
        const geometry = computePanelGeometry(anchor, measurePanelViewport(), placement);
        const horizontalPosition: CSSProperties = { left: anchor.left, width: "max-content", minWidth: anchor.width, maxWidth: Math.max(anchor.width, (window.visualViewport?.width ?? window.innerWidth) - anchor.left - 8) };

        return (
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel}
            data-input-overlay="1"
            style={isMobile ? {
              position: "fixed",
              inset: 0,
              zIndex: 500,
              display: "flex",
              flexDirection: "column",
              background: "var(--bg)",
              overflow: "hidden",
            } : {
              position: "fixed",
              ...(geometry.top !== undefined ? { top: geometry.top } : { bottom: geometry.bottom }),
              ...horizontalPosition,
              zIndex: 500,
              display: "flex",
              flexDirection: "column",
              maxHeight: geometry.maxHeight,
              overflow: "hidden",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: geometry.openAbove ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)",
            }}
          >
            {isMobile && (
              <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{ariaLabel ?? t("chat.sheetModel")}</span>
                <button
                  type="button"
                  aria-label={t("chat.collapseControls")}
                  onClick={() => setOpen(false)}
                  style={{ marginLeft: "auto", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 8, color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>
            )}
            {showFilter && (
              <div style={{ flexShrink: 0, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t("chat.filterModels")}
                  aria-label={t("chat.filterModels")}
                  // 移动端不自动聚焦：自动聚焦会立刻弹键盘压缩可视区，把刚打开的列表
                  // 顶得只剩一条缝；让用户先浏览，点筛选框时再弹（弹出由几何跟踪接住）
                  autoFocus={!isMobile}
                  autoComplete="off"
                  spellCheck={false}
                  style={{
                    boxSizing: "border-box",
                    width: "100%",
                    minWidth: isMobile ? 0 : 220,
                    padding: "5px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                />
              </div>
            )}
            <div style={{ minHeight: 0, overflowY: "auto", ...(isMobile ? { flex: 1 } : null) }}>
              {onClear && !filter.trim() && (
                <ModelOptionButton active={!value} label={emptyLabel ?? "Default"} onClick={() => {
                  setOpen(false);
                  setFilter("");
                  onClear();
                }} />
              )}
              {recentOptions.length > 0 && (
                <div key="recent">
                  <div style={{ padding: "6px 12px 4px", borderTop: onClear ? "1px solid var(--border)" : "none", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, letterSpacing: 0, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 5 }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                    {t("chat.recentModels")}
                  </div>
                  {recentOptions.map((option) => (
                    <ModelOptionButton
                      key={`recent:${option.provider}:${option.modelId}`}
                      active={option.modelId === value?.modelId && option.provider === value?.provider}
                      label={option.name}
                      hint={isMobile ? undefined : option.provider}
                      status={option.status}
                      onClick={() => choose(option)}
                    />
                  ))}
                </div>
              )}
              {modelsByProvider.length === 0 ? (
                <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                  {filter.trim() ? t("chat.noMatchingModels") : "No available models"}
                </div>
              ) : modelsByProvider.map((group, index) => (
                <div key={group.provider}>
                  {modelsByProvider.length > 1 && (
                    <div style={{ padding: "6px 12px 4px", borderTop: index > 0 || onClear || recentOptions.length > 0 ? "1px solid var(--border)" : "none", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, letterSpacing: 0, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
                      {group.provider}
                      {group.options.some((o) => o.providerRL) && (
                        <span style={{ color: "#d97706", fontSize: 9, fontWeight: 700, textTransform: "none", letterSpacing: 0, padding: "0 6px", borderRadius: 999, border: "1px solid rgba(245,158,11,.55)", background: "rgba(245,158,11,.12)", whiteSpace: "nowrap" }} title="该 provider 全部模型当前都 429 限流——仅提示，不会自动禁用">⛔ 整体限流</span>
                      )}
                    </div>
                  )}
                  {group.options.map((option) => (
                    <ModelOptionButton
                      key={`${option.provider}:${option.modelId}`}
                      active={option.modelId === value?.modelId && option.provider === value?.provider}
                      label={option.name}
                      hint={isMobile ? undefined : option.provider}
                      status={option.status}
                      onClick={() => choose(option)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function ModelOptionButton({ active, label, hint, status, onClick }: { active: boolean; label: string; hint?: string; status?: ModelSelectorOption["status"]; onClick: () => void }) {
  const statusMark = status === "rl"
    ? <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, color: "#b45309", padding: "0 6px", borderRadius: 999, border: "1px solid rgba(245,158,11,.55)", background: "rgba(245,158,11,.14)" }} title="当前限流（429）——选中可能被冷却拒发，仅提示不会自动禁用">429</span>
    : status === "err"
      ? <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, color: "#dc2626", padding: "0 6px", borderRadius: 999, border: "1px solid rgba(239,68,68,.5)", background: "rgba(239,68,68,.1)" }} title="当前探测异常（非限流错误）——仅提示不会自动禁用">✗ 异常</span>
      : status === "unprobed"
        ? <span style={{ flexShrink: 0, fontSize: 9, color: "var(--text-dim)", padding: "0 6px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-subtle,#f5f5f5)" }} title="尚未探测可用性（模型检查未跑过）">未测</span>
        : null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", border: "none", background: active ? "var(--bg-selected)" : "none", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400, textAlign: "left", whiteSpace: "nowrap" }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = "none"; }}
    >
      {active
        ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
        : <span style={{ width: 10, flexShrink: 0 }} />}
      <span title={label} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {statusMark}
      {hint && hint !== label ? (
        <span style={{ marginLeft: "auto", flexShrink: 0, paddingLeft: 14, fontSize: 10, fontWeight: 400, color: "var(--text-dim)", opacity: 0.8 }} title={hint}>{hint}</span>
      ) : null}
    </button>
  );
}
