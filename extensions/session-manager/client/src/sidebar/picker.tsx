/**
 * sidebar/picker —— CWD picker（宿主 SessionSidebar「CWD picker」区块 1:1 复制）。
 * 按钮（当前项目 + 其他工作区 activity 蓝点）+ 下拉（项目过滤/最近项目/activity 徽标/
 * 默认目录/自定义路径/workspacePickerActions 扩展插槽经宿主 renderSlot 渲染）。
 * 状态与回调全部由 SidebarDock 持有（与宿主组件内 state 同构）。
 */
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { t, renderSlot } from "../host-shim";
import { displayCwd, type RecentProject } from "./pure";
import { AnimatedDropdown, PathLabel, showProjectActivity, isSmallScreen } from "./parts";
import { SIc } from "../helpers";

export interface PickerProps {
  /** 右端插槽（如分支指示；点击冒泡由插槽内容自行阻断，不触发项目下拉） */
  rightSlot?: ReactNode;
  dropdownRef: RefObject<HTMLDivElement>;
  dropdownOpen: boolean;
  setDropdownOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  projectFilter: string;
  setProjectFilter: (v: string) => void;
  selectedCwd: string | null;
  homeDir: string;
  selectedProject: { key: string; root: string } | null;
  recentProjects: RecentProject[];
  visibleProjects: RecentProject[];
  projectActivity: Map<string, { running: number; unread: number }>;
  hasOtherWorkspaceActivity: boolean;
  customPathOpen: boolean;
  customPathValue: string;
  onSelectProject: (root: string) => void;
  onDefaultCwd: () => void;
  onCustomPathClick: () => void;
  hiddenWorkspaces: ReadonlySet<string>;
  /** 项目钉住：钉内顺序（visibleProjects 已按此排好）+ 钉/拔回调。都不传 = 只读列表（无 📌）。 */
  pinnedKeys?: readonly string[];
  onTogglePinProject?: (key: string) => void;
}

export function SidebarCwdPicker(p: PickerProps) {
  const showProjectFilter = p.recentProjects.length > 8;

  // 选中/默认目录后的收起 + 清过滤 + 外点关闭——交互胶水统一在本体（原先散在各宿主，
  // 弹窗侧接入时漏写导致「点击 workspace 不自动关闭」，2026-09-17 下沉至此，宿主只留业务 onChange）
  useEffect(() => {
    if (!p.dropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (p.dropdownRef.current && !p.dropdownRef.current.contains(e.target as Node)) {
        p.setDropdownOpen(false);
        p.setProjectFilter("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [p.dropdownOpen]);

  const pickProject = (root: string) => {
    p.onSelectProject(root);
    p.setProjectFilter("");
    p.setDropdownOpen(false);
  };
  return (
    <div ref={p.dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={() => p.setDropdownOpen((v) => !v)}
        title={p.selectedProject?.root ?? p.selectedCwd ?? ""}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          padding: "6px 10px",
          background: p.selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
          border: p.selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
          borderRadius: 7,
          cursor: "pointer",
          fontSize: 12,
          color: "var(--text)",
          textAlign: "left",
          transition: "border-color 0.15s, background 0.15s",
        }}
      >
        {p.selectedCwd ? (
          <PathLabel
            text={displayCwd(p.selectedProject?.root ?? p.selectedCwd, p.homeDir)}
            style={{
              flex: 1,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text)",
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-dim)",
            }}
          >
            {t("sidebar.selectProject")}
          </span>
        )}
        {p.hasOtherWorkspaceActivity && (
          <span
            title={t("sidebar.newActivity")}
            aria-label={t("sidebar.newActivity")}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              flexShrink: 0,
              marginLeft: 6,
              background: "var(--accent)",
            }}
          />
        )}
        {p.rightSlot ? (
          <span
            style={{ marginLeft: "auto", flexShrink: 0, display: "inline-flex" }}
            onClick={(e) => e.stopPropagation()}
          >
            {p.rightSlot}
          </span>
        ) : null}
      </button>

      <AnimatedDropdown
        open={p.dropdownOpen}
        fixedAnchor
        style={{
          zIndex: 100,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
          overflow: "hidden",
        }}
      >
        {showProjectFilter && (
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <input
              value={p.projectFilter}
              onChange={(e) => p.setProjectFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  p.setProjectFilter("");
                  p.setDropdownOpen(false);
                }
              }}
              placeholder={t("sidebar.filterProjects")}
              autoFocus={!isSmallScreen()}
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "5px 8px",
                border: "1px solid var(--border)",
                borderRadius: 5,
                outline: "none",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}
        <div style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
          {p.visibleProjects.map((project) => (
            <ProjectRow
              key={project.key}
              project={project}
              selected={project.key === p.selectedProject?.key}
              pinned={!!p.pinnedKeys?.includes(project.key)}
              activity={p.projectActivity.get(project.key)}
              homeDir={p.homeDir}
              onPick={pickProject}
              onTogglePin={p.onTogglePinProject}
            />
          ))}
          {p.visibleProjects.length === 0 && p.projectFilter.trim() && (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div>
          )}
        </div>

        {/* Default cwd shortcut */}
        {!p.customPathOpen && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              p.onDefaultCwd();
              p.setProjectFilter("");
              p.setDropdownOpen(false);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "8px 10px",
              background: "none",
              borderLeft: "none",
              borderBottom: "none",
              borderTop: p.visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
            </svg>
            <span>{t("sidebar.useDefaultDirectory")}</span>
          </button>
        )}

        {/* Custom path directory picker */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            p.onCustomPathClick();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            padding: "8px 10px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
            <line x1="5" y1="1" x2="5" y2="9" />
            <line x1="1" y1="5" x2="9" y2="5" />
          </svg>
          <span>{t("sidebar.customPath")}</span>
        </button>

        {/* Workspace management actions（session-manager 工作区管理弹窗入口——同宿主插槽） */}
        {renderSlot("workspacePickerActions", {
          extra: {
            projects: p.visibleProjects.map((x) => ({ key: x.key, root: x.root })),
            allProjects: p.recentProjects.map((x) => ({ key: x.key, root: x.root })),
            selectedCwd: p.selectedCwd,
            hiddenWorkspaces: p.hiddenWorkspaces,
            onSelect: p.onSelectProject,
            onClose: () => p.setDropdownOpen(false),
          } as never,
        })}
      </AnimatedDropdown>
    </div>
  );
}

/**
 * 项目行（原 `<button>`；钉住引入行内 📌 后改 `div role="button"`——button 嵌 button
 * 是非法 HTML，且嵌套后点击会一并触发选项目）。键盘等价：Tab 聚焦 + Enter/Space 选中
 * （📌 自身的 Enter 由原生 button 处理，靠 `e.target === currentTarget` 防双触发）。
 */
function ProjectRow(props: {
  project: RecentProject;
  selected: boolean;
  pinned: boolean;
  activity: { running: number; unread: number } | undefined;
  homeDir: string;
  onPick: (root: string) => void;
  onTogglePin?: (key: string) => void;
}) {
  const { project, selected, pinned, onPick, onTogglePin } = props;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const highlight = hovered || focused;
  return (
    <div
      role="button"
      tabIndex={0}
      title={project.root}
      onClick={() => onPick(project.root)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onPick(project.root);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        padding: "8px 10px",
        background: highlight ? "var(--bg-hover)" : "var(--bg)",
        borderLeft: "none", borderRight: "none", borderTop: "none",
        borderBottom: "1px solid var(--border)",
        outline: focused ? "1px solid var(--accent)" : "none",
        color: selected ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {selected && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="1.5 5 4 7.5 8.5 2.5" />
        </svg>
      )}
      {!selected && <span style={{ width: 10, flexShrink: 0 }} />}
      <PathLabel text={displayCwd(project.root, props.homeDir)} style={{ flex: 1 }} />
      {showProjectActivity(props.activity)}
      {onTogglePin && (
        <button
          type="button"
          title={pinned ? t("sm.unpinProject") : t("sm.pinProject")}
          aria-label={pinned ? t("sm.unpinProject") : t("sm.pinProject")}
          onClick={(e) => { e.stopPropagation(); onTogglePin(project.key); }}
          style={{
            // 未钉且未 hover：仍占位（visibility 不缩列宽，避免 hover 时行内内容抖动）
            visibility: pinned || highlight ? "visible" : "hidden",
            flexShrink: 0, padding: "0 2px", fontSize: 11, lineHeight: 1.2,
            background: "none", border: "none", cursor: "pointer",
            color: pinned ? "var(--accent)" : "var(--text-dim)",
          }}
        ><SIc name="pin" size={12} /></button>
      )}
    </div>
  );
}
