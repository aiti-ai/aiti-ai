/**
 * move-cwd-picker —— 「移动会话目标目录」同款工作区选择器（左栏「项目 / Projects」
 * SidebarCwdPicker 整行复用）。用于 MoveDialog / BatchMoveDialog / WorkspaceManage
 * moving 三处，替换原 text input + datalist 输入。
 *
 * 与侧栏/浮窗同款行为：
 *  - 当前选择按钮 + 全宽下拉（CWD 列表 / activity 圆点 / 过滤（>8 项）/ 使用默认目录 /
 *    管理工作区入口（workspacePickerActions slot，可从此打开管理弹窗））
 *  - 自定义路径 → aiti-folder DirectoryBrowser 真目录浏览器（与浮窗面板同款）
 *  - 隐藏工作区尊重 loadHiddenWorkspaces（与核心隐藏列表契约一致，跨 tab 同步）
 * 数据链与侧栏同构：store.sessions → getRecentProjects / getProjectActivity
 * （unread 无数据源，蓝点只按 running 计——选择器语境下不误导）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "./host-shim";
import {
  getProjectActivity,
  getRecentProjects,
  loadHiddenWorkspaces,
  normalizeWorkspaceKey,
  orderProjects,
  pinnedProjectKeys,
  projectSelection,
  WORKSPACES_CHANGED_EVENT,
  type ProjectSelection,
} from "./sidebar/pure";
import { SidebarCwdPicker } from "./sidebar/picker";
import { DirectoryBrowser } from "../../../aiti-folder/client/src/directory-browser";
import { dedupeFetch } from "../../../_shared/dedupe-fetch";
import { useStore } from "./store";

/** /api/home 的家庭目录缓存（多个 picker 实例共用，避免重复请求；dedupeFetch 再与
 *  其他消费面（侧栏/编辑器/审核 picker 的同窗首拉）合流——开页方案 §10.2 附属收口）。 */
let cachedHomeDir: string | null = null;
async function fetchHomeDir(): Promise<string> {
  if (cachedHomeDir !== null) return cachedHomeDir;
  try {
    const r = await dedupeFetch(apiUrl("/api/home"));
    const d = (await r.json()) as { home?: string };
    cachedHomeDir = d.home ?? "";
  } catch {
    cachedHomeDir = "";
  }
  return cachedHomeDir ?? "";
}

export function MoveCwdPicker(props: { value: string; onChange: (root: string) => void }) {
  const { value, onChange } = props;
  const store = useStore();
  const sessions = useMemo(() => (store.sessions ?? []) as any[], [store.sessions]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [customBrowseOpen, setCustomBrowseOpen] = useState(false);
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<ReadonlySet<string>>(() => loadHiddenWorkspaces());
  const [homeDir, setHomeDir] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // homeDir（路径 ~ 缩写用；与宿主 SessionSidebar 同源 /api/home）
  useEffect(() => {
    void fetchHomeDir().then((h) => setHomeDir(h));
  }, []);

  // 隐藏工作区跨 tab/跨实例同步（核心 workspace-hide 契约事件）
  useEffect(() => {
    const sync = () => setHiddenWorkspaces(loadHiddenWorkspaces());
    window.addEventListener(WORKSPACES_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WORKSPACES_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const recentProjects = useMemo(() => getRecentProjects(sessions), [sessions]);
  // 与侧栏同序：钉住项目排前（只读呈现，本选择器不放钉入口）
  const pinnedKeys = useMemo(() => pinnedProjectKeys(store.tagData), [store.tagData]);

  const selectedProject: ProjectSelection | null = useMemo(() => {
    if (!value) return null;
    const norm = normalizeWorkspaceKey(value);
    const hit = recentProjects.find((p) => normalizeWorkspaceKey(p.root) === norm);
    return hit ? projectSelection(hit.root, hit.key) : projectSelection(value, norm);
  }, [value, recentProjects]);

  const visibleProjects = useMemo(() => {
    const isCurrent = (root: string) => normalizeWorkspaceKey(root) === selectedProject?.root;
    const filt = projectFilter.trim().toLowerCase();
    const list = filt
      ? recentProjects.filter((p) =>
          (isCurrent(p.root) || !hiddenWorkspaces.has(p.root)) &&
          p.root.toLowerCase().includes(filt))
      : recentProjects.filter((p) => isCurrent(p.root) || !hiddenWorkspaces.has(p.root));
    return orderProjects(list, pinnedKeys);
  }, [recentProjects, projectFilter, hiddenWorkspaces, selectedProject, pinnedKeys]);

  // 蓝点：只按 running 计（unread 无数据源，选择器语境不做误导性标注）
  const projectActivity = useMemo(
    () => getProjectActivity(sessions, store.running as Set<string>, new Set<string>()),
    [sessions, store.running],
  );
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(([key, { running }]) => key !== selectedProject?.key && running > 0),
    [projectActivity, selectedProject],
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <SidebarCwdPicker
          dropdownRef={dropdownRef}
          dropdownOpen={dropdownOpen}
          setDropdownOpen={setDropdownOpen}
          projectFilter={projectFilter}
          setProjectFilter={setProjectFilter}
          selectedCwd={value || null}
          homeDir={homeDir}
          selectedProject={selectedProject}
          recentProjects={recentProjects}
          visibleProjects={visibleProjects}
          projectActivity={projectActivity}
          hasOtherWorkspaceActivity={hasOtherWorkspaceActivity}
          customPathOpen={false}
          customPathValue=""
          onSelectProject={onChange}
          onDefaultCwd={() => {
            // 默认目录 = 用户主目录（与侧栏「使用默认目录」同义）；home 未加载完时补齐
            // （选中后收起下拉/清过滤/外点关闭已下沉在 SidebarCwdPicker 本体）
            if (homeDir) { onChange(homeDir); return; }
            void fetchHomeDir().then((h) => { if (h) onChange(h); });
          }}
          onCustomPathClick={() => { setDropdownOpen(false); setCustomBrowseOpen(true); }}
          hiddenWorkspaces={hiddenWorkspaces}
        />
      </div>
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          title="清除目标目录"
          style={{
            flexShrink: 0, background: "none", border: "none", cursor: "pointer",
            color: "var(--text-muted)", fontSize: 11, padding: "2px 4px",
          }}
        >✕</button>
      )}
      {customBrowseOpen && (
        <DirectoryBrowser
          initialPath={value || undefined}
          onSelect={(p) => { setCustomBrowseOpen(false); onChange(p); }}
          onCancel={() => setCustomBrowseOpen(false)}
        />
      )}
    </div>
  );
}
