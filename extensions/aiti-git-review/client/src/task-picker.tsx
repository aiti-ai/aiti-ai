/**
 * aiti-git-review · 任务选择器（自手写版迁移；逻辑一比一）。
 *
 * 新建（树形选文件 + 类型反选 + 搜索 + AI 预审选项）/ 打开现有（列表，含标注数/时间/绑定会话）/
 * 其他仓库任务折叠展示。任务是有 ID 的持久产物——不再隐式建任务。
 */
import { useState, useEffect, useRef } from "react";
import { t, apiUrl } from "./host-shim";
import { uiConfirm } from "../../../_shared/ui-dialogs";
import { dedupeFetch } from "../../../_shared/dedupe-fetch";
import { api, jsonBody, G, lastSeg, statusIcon, statusColor, overlay, pickerCard, segBtn, segOn, btnPrimary } from "./shared";
// aiti-folder 工作区切换器（与 session-manager 同法：构建期内联复用同一组件）
import { WorkspaceDropdown } from "../../../aiti-folder/client/src/folder-switcher";
import { displayCwd } from "../../../aiti-folder/client/src/lib";

/** 版本选项（分支/tag/远程） */
type RefOpt = { name: string; kind: string; label?: string };
/** commit 项（date=YYYY-MM-DD，供按天分组） */
type CommitOpt = { id: string; date: string; subject: string };

const refIcon = (k: string) => (k === "tag" ? "🏷" : k === "remote" ? "🌐" : "⎇");

const REF_GROUP_LABEL: Record<string, string> = { branch: "分支", remote: "远程分支", tag: "标签", commit: "提交（按天）" };

function dayLabel(key: string): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  if (key === fmt(now)) return "今天";
  const y = new Date(now.getTime() - 86400000);
  if (key === fmt(y)) return "昨天";
  return key;
}

const itemRowStyle = (sel: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", cursor: "pointer",
  background: sel ? "var(--bg-selected,#eef3ff)" : "transparent",
});

/** 版本输入框（autocomplete 组合框）。
 *  输入过滤 → 平铺命中列表；空值 → 树形分组：分支/远程/tag 可展开收起，commit 按天分组（天也可收起）。
 *  ↑↓/Enter 键盘导航只走可选行（组头/天头用鼠标点）。 */
function RefInput({ value, onChange, options, commits, placeholder, title }: {
  value: string;
  onChange: (v: string) => void;
  options: RefOpt[];
  commits: CommitOpt[];
  placeholder?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [grpOpen, setGrpOpen] = useState<Set<string>>(() => new Set(["branch", "remote"])); // 默认开分支/远程；tag/commit 收起
  const [dayOpen, setDayOpen] = useState<Set<string>>(new Set());
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const q = value.trim().toLowerCase();
  const matchRefs = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : [];
  const matchCommits = q ? commits.filter((c) => c.id.toLowerCase().includes(q) || c.subject.toLowerCase().includes(q)) : [];

  // commit 按天分组（日期降序；同天内保持 git log 新→旧顺序）
  const dayMap = new Map<string, CommitOpt[]>();
  for (const c of commits) {
    const d = c.date || "?";
    if (!dayMap.has(d)) dayMap.set(d, []);
    dayMap.get(d)!.push(c);
  }
  const dayKeys = [...dayMap.keys()].sort().reverse();

  // 可选行平铺（视觉顺序一致）：键盘导航/高亮都走这份
  type Row = { key: string; kind: "ref" | "commit"; opt?: RefOpt; com?: CommitOpt };
  let flat: Row[] = [];
  if (q) {
    flat = [
      ...matchRefs.map((o): Row => ({ key: o.kind + ":" + o.name, kind: "ref", opt: o })),
      ...matchCommits.map((c): Row => ({ key: "commit:" + c.id, kind: "commit", com: c })),
    ];
  } else {
    for (const g of ["branch", "remote", "tag"] as const) {
      if (!grpOpen.has(g)) continue;
      for (const o of options.filter((x) => x.kind === g)) flat.push({ key: o.kind + ":" + o.name, kind: "ref", opt: o });
    }
    if (grpOpen.has("commit")) {
      for (const k of dayKeys) {
        if (!dayOpen.has(k)) continue;
        for (const c of dayMap.get(k)!) flat.push({ key: "commit:" + c.id, kind: "commit", com: c });
      }
    }
  }
  // 派生值鲉制（禁止 render 期间 setState）：flat 收缩后高亮自动回落
  const hiEff = Math.min(hi, Math.max(flat.length - 1, 0));

  const pick = (row: Row) => { onChange(row.kind === "ref" ? row.opt!.name : row.com!.id); setOpen(false); };
  const toggleGrp = (g: string) => setGrpOpen((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; });
  const toggleDay = (k: string) => setDayOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // 高亮行滚动进可视区
  useEffect(() => {
    if (!open) return;
    const el = boxRef.current?.querySelector('[data-hi="1"]');
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [hi, open, grpOpen, dayOpen]);

  const renderItem = (row: Row, idx: number) => {
    const icon = row.kind === "ref" ? refIcon(row.opt!.kind) : "◆";
    const name = row.kind === "ref" ? row.opt!.name : row.com!.id;
    const label = row.kind === "ref" ? row.opt!.label || "" : row.com!.subject;
    return (
      <div
        key={row.key}
        data-hi={idx === hiEff ? "1" : undefined}
        onMouseDown={(e) => { e.preventDefault(); pick(row); }}
        onMouseEnter={() => setHi(idx)}
        style={itemRowStyle(idx === hiEff)}
      >
        <span style={{ fontSize: 10, flexShrink: 0 }}>{icon}</span>
        <span style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 11, color: "var(--text,#222)", whiteSpace: "nowrap" }}>{name}</span>
        {label ? <span style={{ fontSize: 10.5, color: "var(--text-dim,#999)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{label}</span> : null}
      </div>
    );
  };

  const groupHeader = (g: string, count: number) => (
    <div
      key={"g:" + g}
      onMouseDown={(e) => { e.preventDefault(); toggleGrp(g); }}
      style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", cursor: "pointer", userSelect: "none",
        fontSize: 10.5, fontWeight: 700, color: "var(--text-dim,#888)", borderTop: "1px solid var(--border,#eee)" }}
    >
      <span style={{ width: 9, flexShrink: 0 }}>{grpOpen.has(g) ? "▾" : "▸"}</span>
      <span>{(g === "commit" ? "◆" : refIcon(g)) + " " + REF_GROUP_LABEL[g]}</span>
      <span style={{ fontWeight: 400 }}>{count}</span>
    </div>
  );

  return (
    <div ref={boxRef} style={{ position: "relative", flex: 1, minWidth: 130, display: "flex", alignItems: "center" }}>
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { setOpen(true); e.preventDefault(); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(i + 1, Math.max(flat.length - 1, 0))); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter") { if (open && flat[hiEff]) { e.preventDefault(); pick(flat[hiEff]); } }
          else if (e.key === "Escape") { setOpen(false); }
        }}
        placeholder={placeholder}
        title={title}
        style={{ width: "100%", minWidth: 0, fontSize: 11, padding: "3px 7px", border: "1px solid var(--border,#ddd)", borderRadius: 5, background: "var(--bg,#fff)", color: "var(--text,#333)", outline: "none", fontFamily: "var(--font-mono,monospace)" }}
      />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="从分支 / tag / commit 中选择"
        style={{ ...miniBtnStyle, marginLeft: -20, zIndex: 1, padding: "2px 4px", fontSize: 9, color: "var(--text-dim,#888)" }}
      >▼</button>
      {open && (() => {
        const empty = q ? flat.length === 0 : options.length === 0 && commits.length === 0;
        if (empty) return null;
        return (
          <div
            style={{ position: "absolute", top: "calc(100% + 3px)", left: 0, right: 0, zIndex: 80, background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)", borderRadius: 6, boxShadow: "0 6px 20px rgba(0,0,0,.14)", maxHeight: 260, overflowY: "auto" }}
          >
            {q ? (
              flat.map((row, idx) => renderItem(row, idx))
            ) : (
              <>
                {["branch", "remote", "tag"].map((g) => {
                  const items = options.filter((x) => x.kind === g);
                  if (items.length === 0) return null;
                  return (
                    <div key={g}>
                      {groupHeader(g, items.length)}
                      {grpOpen.has(g) && items.map((o) => renderItem({ key: o.kind + ":" + o.name, kind: "ref", opt: o }, flat.findIndex((r) => r.key === o.kind + ":" + o.name)))}
                    </div>
                  );
                })}
                {commits.length > 0 && groupHeader("commit", commits.length)}
                {grpOpen.has("commit") && dayKeys.map((k) => (
                  <div key={k}>
                    <div
                      onMouseDown={(e) => { e.preventDefault(); toggleDay(k); }}
                      style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 8px 3px 22px", cursor: "pointer", userSelect: "none",
                        fontSize: 10.5, fontWeight: 600, color: "var(--text-muted,#999)", background: "var(--bg-subtle,#f7f7f9)" }}
                      title={k}
                    >
                      <span style={{ width: 9, flexShrink: 0 }}>{dayOpen.has(k) ? "▾" : "▸"}</span>
                      <span>{dayLabel(k)}</span>
                      <span style={{ fontWeight: 400 }}>{dayMap.get(k)!.length}</span>
                    </div>
                    {dayOpen.has(k) && dayMap.get(k)!.map((c) => renderItem({ key: "commit:" + c.id, kind: "commit", com: c }, flat.findIndex((r) => r.key === "commit:" + c.id)))}
                  </div>
                ))}
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export function TaskPicker({ onClose, onOpenTask, presetRepo, fallbackRepo, onDock }: {
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  /** 停靠到右栏（aiti-float dock v0.5.0 审查 tab；提供方渲染 ⇱ 钮，缺省不显示） */
  onDock?: () => void;
  presetRepo: string;
  fallbackRepo?: string; // 当前工作区（pages activeCwd/sessionCwd）——无显式预设时的默认仓库
}) {
  const [tasks, setTasks] = useState<any[] | null>(null); // null=加载中 []=无
  const [repo, setRepo] = useState(presetRepo || fallbackRepo || G.probePath || "");
  const [files, setFiles] = useState<any[]>([]);   // 新建时探测到的变更文件
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const [aiPre, setAiPre] = useState(false); // 新建时是否先 AI 预审
  const [creating, setCreating] = useState(false);
  // 版本对比：wt=工作区 vs 基线（base，留空 HEAD）；range=两版本互比（base → ref2）
  const [mode, setMode] = useState<"wt" | "range">("wt");
  const [base, setBase] = useState("");
  const [ref2, setRef2] = useState("");
  const [refOpts, setRefOpts] = useState<RefOpt[]>([]); // 分支/tag/远程分支
  const [commitOpts, setCommitOpts] = useState<CommitOpt[]>([]); // 最近 commit（带日期，按天分组）
  const [home, setHome] = useState(""); // ~ 缩略显示用
  const [wsOpen, setWsOpen] = useState(false); // 工作区切换器弹出态
  const wsBoxRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    dedupeFetch(apiUrl("/api/home")).then((r) => r.json()).then((d: any) => { if (d && d.home) setHome(d.home); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!wsOpen) return;
    const h = (e: MouseEvent) => { if (wsBoxRef.current && !wsBoxRef.current.contains(e.target as Node)) setWsOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [wsOpen]);
  const [extFilter, setExtFilter] = useState(""); // 文件类型高亮态（仅视觉提示最近反选过的类型；不做显示过滤）
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // 树展开目录集
  const [search, setSearch] = useState(""); // 路径关键词过滤（全路径包含即中；子串不分大小写）

  const probe = () => {
    setErr("");
    // 文件探测仅在有仓库时；任务列表始终拉（空仓库 = 全部任务）
    if (repo) {
      setFiles([]); setSel(new Set());
      setProbeTick((n) => n + 1); // 强制重拉文件清单（deps 未变时 effect 不会自触发）
      api("/hasChanges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo }) }).catch(() => {});
    }
    api("/tasks", { method: "POST" }).then((r) => r.json()).then((d) => {
      if (d && d.ok) setTasks(d.tasks || []);
    }).catch(() => setTasks([]));
  };
  useEffect(() => { probe(); }, []);
  // 可选版本清单（autocomplete）：POST /refs { path }（分支+tag+远程+最近 commit）
  // 换仓后旧版本参数大概率无效：repo 变更即清空 base/ref2（切换器/手输/自定义路径三条路统一覆盖）
  const prevRepoRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevRepoRef.current !== null && prevRepoRef.current !== repo) {
      setBase("");
      setRef2("");
    }
    prevRepoRef.current = repo;
  }, [repo]);
  useEffect(() => {
    if (!repo) { setRefOpts([]); return; }
    let dead = false;
    api("/refs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo }) }).then((r) => r.json()).then((d) => {
      if (dead) return;
      setRefOpts(d && d.ok ? d.refs || [] : []);
      setCommitOpts(d && d.ok ? d.commits || [] : []);
    }).catch(() => {});
    return () => { dead = true; };
  }, [repo]);
  // 探测文件清单（新建区）：POST /files { path, base?, ref2? }（版本切换即重探；输入防抖 300ms）
  const [probeTick, setProbeTick] = useState(0); // 「探测」按钮强制重拉文件清单
  useEffect(() => {
    if (!repo) { setFiles([]); return; }
    let dead = false;
    const timer = setTimeout(() => {
      api("/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, base: base.trim() || undefined, ref2: mode === "range" && ref2.trim() ? ref2.trim() : undefined }) }).then((r) => r.json()).then((d) => {
        if (dead) return;
        setFiles(d && d.ok ? d.files || [] : []);
        if (d && d.ok) setSel(new Set((d.files || []).map((f: any) => f.path)));
      }).catch(() => {});
    }, 300);
    return () => { dead = true; clearTimeout(timer); };
  }, [repo, mode, base, ref2, probeTick]);

  const toggle = (p: string) => setSel((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const create = () => {
    if (!repo || sel.size === 0) { setErr(t("gr.picker.needRepo")); return; }
    if (mode === "range" && !ref2.trim()) { setErr(t("gr.picker.needRef2")); return; }
    setCreating(true); setErr("");
    const paths = [...sel];
    // 版本参数：wt 模式只传 base（留空 = 默认 HEAD）；range 模式传 base + ref2
    const refsPayload: any = {};
    if (base.trim()) refsPayload.base = base.trim();
    if (mode === "range" && ref2.trim()) refsPayload.ref2 = ref2.trim();
    // AI 预审建会话需要 origin/basePath（与 sendNew 同法：从 location 推导）
    const origin = location.origin;
    const m = location.pathname.match(/^\/([^/]+)\//);
    const basePath = ((window as any).__PIBASE__ ? String((window as any).__PIBASE__) : (m ? "/" + m[1] : ""));
    api("/open", { method: "POST", ...jsonBody({ path: repo, files: paths, aiPre, origin, basePath, ...refsPayload }) }).then((r) => r.json()).then((d) => {
      setCreating(false);
      if (!d.ok) { setErr(d.error || "创建失败"); return; }
      onOpenTask(d.task.id);
    }).catch((e) => { setCreating(false); setErr(String(e)); });
  };
  const repoTasks = (tasks || []).filter((x) => !repo || x.repo === repo);
  const otherTasks = (tasks || []).filter((x) => repo && x.repo !== repo);
  const fmtTime = (ts: number) => { const d = new Date(ts); const p = (n: number) => String(n).padStart(2, "0"); return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };

  // 类型统计（扩展名→数）
  const extOf = (p: string) => { const b = lastSeg(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : "(无后缀)"; };
  const exts: Record<string, number> = {};
  for (const f of files) exts[extOf(f.path)] = (exts[extOf(f.path)] || 0) + 1;
  const extList = Object.keys(exts).sort((a, b) => exts[b] - exts[a] || a.localeCompare(b));
  // 可见文件：仅搜索词过滤（类型 chips 是「反选」操作不做显示过滤——树始终全量，点类型 = 该类型选中态翻转）
  const q = search.trim().toLowerCase();
  const visible = files.filter((f) => !q || f.path.toLowerCase().includes(q));
  // 类型反选：选中↔取消（不动其他类型；搜索态下仅作用于可见命中集）
  const toggleExt = (e: string) => {
    setExtFilter(extFilter === e ? "" : e);
    const targets = visible.filter((f) => extOf(f.path) === e).map((f) => f.path);
    if (!targets.length) return;
    setSel((s) => {
      const n = new Set(s);
      const allSel = targets.every((p) => n.has(p));
      for (const p of targets) { if (allSel) n.delete(p); else n.add(p); }
      return n;
    });
  };
  // 树构建：目录→子目录/文件（只含 visible）
  type TNode = { __dir?: boolean; __file?: boolean; path?: string; status?: string; children?: Record<string, TNode> };
  const tree: Record<string, TNode> = {};
  for (const f of visible) {
    const parts = f.path.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || !node[parts[i]].__dir) node[parts[i]] = { __dir: true, children: {} };
      node = node[parts[i]].children!;
    }
    const base = parts[parts.length - 1];
    if (!node[base] || !node[base].__dir) node[base] = { __file: true, path: f.path, status: f.status };
  }
  // 目录下文件集（递归；供目录级勾选）。children 兜底（树构建期间目录被同名文件覆盖等异常不崩）
  const filesUnder = (node: Record<string, TNode> | undefined, out: string[]): string[] => {
    if (!node) return out;
    for (const k of Object.keys(node)) {
      const c = node[k] || ({} as TNode);
      if (c.__file) out.push(c.path!);
      else if (c.children) filesUnder(c.children, out);
    }
    return out;
  };
  // 目录三态：全选/部分/无
  const dirState = (dirNode: TNode): "all" | "part" | "none" => {
    const all = filesUnder(dirNode.children, []);
    const n = all.filter((p) => sel.has(p)).length;
    return n === 0 ? "none" : n === all.length ? "all" : "part";
  };
  const toggleDir = (dirNode: TNode) => {
    const all = filesUnder(dirNode.children, []);
    const state = dirState(dirNode);
    setSel((s) => {
      const n = new Set(s);
      for (const p of all) { if (state === "all") n.delete(p); else n.add(p); }
      return n;
    });
  };
  // 搜索时自动展开含命中文件的目录；无搜索时手动展开态
  const effExpanded: Set<string> = q
    ? (() => {
        const s = new Set(expanded);
        for (const f of visible) {
          const parts = f.path.split("/");
          for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
        }
        return s;
      })()
    : expanded;
  // 树渲染（递归；展开态在 expanded Set，路径为 key）
  const renderTree = (node: Record<string, TNode>, prefix: string, depth: number): any[] => {
    const keys = Object.keys(node).sort((a, b) => {
      const da = !!(node[a] && node[a].__dir), db = !!(node[b] && node[b].__dir);
      return da !== db ? (da ? -1 : 1) : a.localeCompare(b);
    });
    const out: any[] = [];
    for (const k of keys) {
      const c = node[k];
      const p = prefix ? prefix + "/" + k : k;
      if (c.__dir) {
        const st = dirState(c);
        const n = filesUnder(c.children, []).length;
        const open = effExpanded.has(p);
        out.push(
          <div key={"d" + p}>
            <div
              onClick={() => setExpanded((s) => { const n2 = new Set(s); n2.has(p) ? n2.delete(p) : n2.add(p); return n2; })}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 4px 2px " + (depth * 14 + 4) + "px", cursor: "pointer", borderRadius: 4 }}
              title={p + " · " + n + " 个文件（点击勾选整树，箭头展开/收起）"}
            >
              <span style={{ width: 10, color: "var(--text-dim,#888)", fontSize: 10, userSelect: "none", flexShrink: 0 }}>{open ? "▼" : "▶"}</span>
              <input
                type="checkbox"
                checked={st === "all"}
                ref={(r: HTMLInputElement | null) => { if (r) r.indeterminate = st === "part"; }}
                onClick={(e) => { e.stopPropagation(); toggleDir(c); }}
                onChange={() => {}}
                style={{ margin: 0, flexShrink: 0 }}
              />
              <span style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 11.5, fontWeight: 600, color: "var(--text,#444)" }}>{k}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim,#999)" }}>{n}</span>
            </div>
            {open && renderTree(c.children!, p, depth + 1)}
          </div>
        );
      } else {
        out.push(
          <div
            key={"f" + p}
            onClick={() => toggle(c.path!)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 2px " + (depth * 14 + 18) + "px", cursor: "pointer", borderRadius: 4 }}
            title={c.path}
          >
            <input type="checkbox" checked={sel.has(c.path!)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(c.path!)} style={{ margin: 0, flexShrink: 0 }} />
            <span style={{ color: statusColor(c.status!), fontWeight: 700, width: 12, fontSize: 11 }}>{statusIcon(c.status!)}</span>
            <span style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 11.5, fontWeight: 600, color: "var(--text,#222)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1 }}>{k}</span>
          </div>
        );
      }
    }
    return out;
  };

  return (
    <div style={overlay}>
      <div style={pickerCard}>
        {/* 头：仓库 + 关闭 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{t("gr.title")}</span>
          <span style={{ flex: 1 }} />
          {onDock && (
            <button onClick={onDock} style={{ ...segBtn }} title="停靠到右栏（审查 tab）">⇱ 右栏</button>
          )}
          <button onClick={onClose} style={{ ...segBtn, color: "var(--danger, #f87171)" }} title="关闭">✕</button>
        </div>
        {/* 工作区：手输框在前，文件夹切换器在后（完整版 WorkspaceDropdown：历史项目 + 使用默认目录 + 自定义路径浏览）。
            默认 = 当前工作区（pages activeCwd/sessionCwd）或打开来源预设；下拉宽度独立于按钮、长路径显示全 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder={t("gr.picker.repo")}
            title="仓库路径（也可从右侧切换器选）"
            style={{ flex: 1, minWidth: 80, padding: "6px 10px", border: "1px solid var(--border,#ddd)", borderRadius: 6, fontFamily: "var(--font-mono,monospace)", fontSize: 12, background: "var(--bg,#fff)", color: "var(--text,#333)", outline: "none" }}
          />
          <span ref={wsBoxRef} style={{ position: "relative", flexShrink: 0, display: "inline-flex" }}>
            <button
              onClick={() => setWsOpen((v) => !v)}
              title="切换工作区（最近项目 / 默认目录 / 自定义路径）"
              style={{ display: "inline-flex", alignItems: "center", gap: 5, alignSelf: "stretch", minHeight: 30, padding: "0 9px", border: "1px solid var(--border,#ddd)", borderRadius: 6, background: "var(--bg,#fff)", color: "var(--text,#333)", cursor: "pointer", fontSize: 11.5, maxWidth: 170, minWidth: 64 }}
            >
              <span>📁</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {repo ? (displayCwd(repo, home) || lastSeg(repo)) : t("gr.picker.pickWs")}
              </span>
              <span style={{ fontSize: 8, opacity: 0.7 }}>▼</span>
            </button>
            {wsOpen && (
              <WorkspaceDropdown
                selected={repo || undefined}
                showUseDefault={true}
                align="right"
                width="min(480px,90vw)"
                onSelect={(p: string) => {
                  setWsOpen(false);
                  if (p) { setRepo(p); G.probePath = p; } // 换仓清残留版本参数由 [repo] effect 统一处理
                }}
                onClose={() => setWsOpen(false)}
              />
            )}
          </span>
          <button onClick={probe} style={segBtn} title="重新探测变更文件">{t("gr.picker.probe")}</button>
        </div>
        {/* 版本对比模式：工作区 vs 基线 / 两版本互比（branch/tag/commitid 均可；切换即重探文件） */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setMode("wt")} style={{ ...segBtn, ...(mode === "wt" ? segOn : {}), fontSize: 11, padding: "2px 8px" }} title="审未提交变更：基线（默认 HEAD）vs 工作区">{t("gr.picker.wt")}</button>
          <button onClick={() => setMode("range")} style={{ ...segBtn, ...(mode === "range" ? segOn : {}), fontSize: 11, padding: "2px 8px" }} title="两版本互比：branch/tag/commitid → branch/tag/commitid">{t("gr.picker.range")}</button>
          {mode === "wt" && (
            <>
              <span style={{ fontSize: 11, color: "var(--text-dim,#888)", flexShrink: 0 }}>vs</span>
              <RefInput
                value={base}
                onChange={setBase}
                options={refOpts}
                commits={commitOpts}
                placeholder={t("gr.picker.basePh")}
                title="基线版本：输入过滤或下拉选择分支 / tag / commitid；留空 = HEAD"
              />
            </>
          )}
          {mode === "range" && (
            <>
              <RefInput
                value={base}
                onChange={setBase}
                options={refOpts}
                commits={commitOpts}
                placeholder={t("gr.picker.basePh")}
                title="旧侧版本：输入过滤或下拉选择分支 / tag / commitid；留空 = HEAD"
              />
              <span style={{ color: "var(--text-dim,#888)", flexShrink: 0, fontWeight: 700 }}>→</span>
              <RefInput
                value={ref2}
                onChange={setRef2}
                options={refOpts}
                commits={commitOpts}
                placeholder={t("gr.picker.ref2Ph")}
                title="新侧版本：输入过滤或下拉选择分支 / tag / commitid"
              />
              <button onClick={() => { const b = base; setBase(ref2); setRef2(b); }} style={{ ...segBtn, fontSize: 11, padding: "2px 6px", flexShrink: 0 }} title={t("gr.picker.swapRefs")}>⇄</button>
            </>
          )}
        </div>
        {err && <div style={{ color: "var(--danger, #f87171)", fontSize: 12, marginBottom: 8 }}>❌ {err}</div>}
        {/* 新建区：文件选择（树形 + 类型过滤 + 全选） + AI 预审选项 */}
        <div style={{ border: "1px solid var(--border,#eee)", borderRadius: 8, padding: 8, marginBottom: 10, maxHeight: "46%", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim,#888)" }}>
              {"新建审查 · 选文件（" + sel.size + "/" + files.length + (q ? " · 搜中 " + visible.length : "") + "）"}
            </span>
            <span style={{ flex: 1 }} />
            {/* 搜索框（路径子串） */}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("gr.picker.search")}
              style={{ width: 110, fontSize: 11, padding: "2px 7px", border: "1px solid var(--border,#ddd)", borderRadius: 5, background: "var(--bg,#fff)", color: "var(--text,#333)", outline: "none", fontFamily: "var(--font-mono,monospace)" }}
            />
            {/* 类型 chips：点击反选该类型全部文件 */}
            {extList.length > 1 && extList.slice(0, 8).map((e) => (
              <button
                key={e}
                onClick={() => toggleExt(e)}
                style={{ ...segBtn, ...(extFilter === e ? segOn : {}), fontSize: 10, padding: "1px 6px" }}
                title={"反选 " + e + "（" + exts[e] + " 个）：选中的取消，未选的选中"}
              >
                {e + " " + exts[e]}
              </button>
            ))}
            {/* 全选/清空 */}
            <button onClick={() => setSel(new Set(visible.map((f) => f.path)))} style={{ ...segBtn, fontSize: 10, padding: "1px 6px" }} title="全选当前可见文件">{t("gr.picker.all")}</button>
            <button onClick={() => setSel(new Set())} style={{ ...segBtn, fontSize: 10, padding: "1px 6px" }} title="清空选择">{t("gr.picker.clear")}</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {files.length === 0 && (
              <div style={{ color: "var(--text-muted,#999)", fontSize: 12, padding: 4 }}>
                {repo ? (mode === "range" && ref2.trim() ? "该范围无变更（检查版本号是否正确）" : mode === "wt" && base.trim() ? "相对基线无变更（或仓库路径不存在）" : "无未提交变更（或仓库路径不存在）") : "输入仓库路径后探测"}
              </div>
            )}
            {files.length > 0 && renderTree(tree, "", 0)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, borderTop: "1px solid var(--border,#eee)", paddingTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer", color: "var(--text,#333)" }} title="勾选后新建任务同时启动 AI 预审会话（后台读 diff 标问题）">
              <input type="checkbox" checked={aiPre} onChange={() => setAiPre((v) => !v)} />
              {t("gr.picker.aiPre")}
            </label>
            <span style={{ flex: 1 }} />
            <button onClick={create} style={btnPrimary} disabled={creating || !repo || sel.size === 0}>{creating ? t("gr.picker.creating") : t("gr.picker.create")}</button>
          </div>
        </div>
        {/* AI 变更追踪（trace 任务源，docs/aiti-git-trace-plan.md §6.2） */}
        <TraceSection onOpenTask={onOpenTask} fallbackRepo={repo} />
        {/* 现有任务列表 */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim,#888)", marginBottom: 4 }}>
            {"打开现有审查 · " + (tasks === null ? "加载中…" : repoTasks.length + " 个任务" + (otherTasks.length ? "（其他仓库 " + otherTasks.length + "）" : ""))}
          </div>
          {repoTasks.map((task) => (
            <div
              key={task.id}
              onClick={() => onOpenTask(task.id)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: "1px solid var(--border,#eee)", borderRadius: 8, marginBottom: 4, cursor: "pointer", background: "var(--bg,#fff)" }}
              title={task.repo + " · 点击打开"}
            >
              <span style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 11, color: "var(--accent,#2563eb)", fontWeight: 600 }}>#{task.id}</span>
              <span style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 11.5, fontWeight: 600, color: "var(--text,#222)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {lastSeg(task.repo) + (task.scope && task.scope.path ? " / " + lastSeg(task.scope.path) : "")}
              </span>
              {(task.ref2 || task.base) && (
                <span
                  style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 10, color: "#7c3aed", background: "rgba(124,58,237,.08)", border: "1px solid rgba(124,58,237,.35)", borderRadius: 4, padding: "0 5px", flexShrink: 0, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={(task.ref2 ? (task.base || "HEAD") + " → " + task.ref2 : "工作区 vs " + task.base)}
                >
                  {task.ref2 ? ((task.base || "HEAD") + "→" + task.ref2) : ("⇋" + task.base)}
                </span>
              )}
              {task.boundSessionId && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    try { window.dispatchEvent(new CustomEvent("aiti-git-trace-open", { detail: { kind: "timeline", data: { sessionId: task.boundSessionId } } })); } catch { /* noop */ }
                  }}
                  style={{ ...miniBtnStyle, color: "#f59e09", fontSize: 12, flexShrink: 0, padding: "1px 5px" }}
                  title="打开该审查会话的 op 时间线（aiti-git-trace）"
                >⎇</button>
              )}
              {task.boundSessionId && <span style={{ fontSize: 10, color: "var(--ok, #4ade80)", border: "1px solid var(--ok, #4ade80)", borderRadius: 4, padding: "0 4px", flexShrink: 0 }}>AI</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "var(--text-dim,#888)", flexShrink: 0 }}>{task.files + " 文件 · " + task.annotations + " 标注 · " + fmtTime(task.createdAt)}</span>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!(await uiConfirm({ message: "删除审查 #" + task.id + "？（" + task.files + " 文件 / " + task.annotations + " 标注，不可恢复）", danger: true }))) return;
                  api("/task?id=" + encodeURIComponent(task.id), { method: "DELETE" }).then((r) => r.json()).then((d) => {
                    if (d && d.ok) setTasks((ts) => (ts || []).filter((x) => x.id !== task.id));
                  }).catch(() => {});
                }}
                style={{ ...miniBtnStyle, color: "var(--danger, #f87171)", fontSize: 12, flexShrink: 0, padding: "1px 5px" }}
                title="删除此审查任务（标注库随任务删除）"
              >🗑</button>
            </div>
          ))}
          {otherTasks.length > 0 && otherTasks.slice(0, 3).map((ot) => (
            <div
              key={ot.id}
              onClick={() => onOpenTask(ot.id)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", border: "1px dashed var(--border,#eee)", borderRadius: 8, marginBottom: 4, cursor: "pointer", opacity: 0.75 }}
            >
              <span style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 11, color: "var(--text-dim,#888)" }}>#{ot.id}</span>
              <span style={{ fontSize: 11.5, color: "var(--text,#555)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{lastSeg(ot.repo)}</span>
              <span style={{ fontSize: 10.5, color: "var(--text-dim,#999)", flexShrink: 0 }}>{ot.annotations + " 标注"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


const miniBtnStyle: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 12, padding: "1px 3px", color: "var(--text-dim,#888)" };

// ── AI 变更追踪（trace 任务源）：sessionId → 台账「消息→操作」两级分组 → 选两节点 = base/target ──
// 台账读取在对端（aiti-git-review /trace-revisions：真实 cache/aiti-git-trace/ops/<sid>.jsonl 优先，
// 缺省回落 fixture configDir/aiti-git-review/fixtures/trace-<sid>.jsonl）。
function TraceSection({ onOpenTask, fallbackRepo }: { onOpenTask: (taskId: string) => void; fallbackRepo: string }) {
  const [sid, setSid] = useState("");
  const [msgs, setMsgs] = useState<any[] | null>(null);
  const [info, setInfo] = useState("");
  const [picked, setPicked] = useState<string[]>([]); // after sha，按点击顺序：[base, target]
  const load = () => {
    const id = sid.trim();
    if (!id) { setInfo("先输入 sessionId"); return; }
    setMsgs(null); setInfo("加载中…"); setPicked([]);
    api("/trace-revisions", { method: "POST", ...jsonBody({ sessionId: id, storeRoot: G.probePath || fallbackRepo || undefined }) })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok) { setMsgs(d.messages || []); setInfo(d.ledger === "fixture" ? "（fixture 数据）" : ""); }
        else setInfo("❌ " + ((d && d.error) || "加载失败"));
      })
      .catch(() => setInfo("加载失败"));
  };
  const toggle = (after: string) => {
    setPicked((p) => (p.includes(after) ? p.filter((x) => x !== after) : [...p, after].slice(-2)));
  };
  const openRange = () => {
    if (picked.length !== 2) { setInfo("先点选两个节点（先 base 后 target）"); return; }
    setInfo("打开中…");
    api("/open", { method: "POST", ...jsonBody({ source: "trace", storeRoot: G.probePath || fallbackRepo || undefined, sessionId: sid.trim(), base: picked[0], target: picked[1] }) })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok && d.task) onOpenTask(d.task.id);
        else setInfo("❌ " + ((d && d.error) || "打开失败"));
      })
      .catch(() => setInfo("打开失败"));
  };
  return (
    <details style={{ border: "1px solid var(--border,#eee)", borderRadius: 8, padding: "6px 8px", marginBottom: 10 }}>
      <summary style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim,#888)", cursor: "pointer" }}>AI 变更追踪（trace · 审编外仓 op 区间）</summary>
      <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={sid}
          onChange={(e) => setSid(e.target.value)}
          placeholder="aiti-git-trace sessionId"
          style={{ flex: 1, minWidth: 160, fontSize: 11, padding: "3px 7px", border: "1px solid var(--border,#ddd)", borderRadius: 5, background: "var(--bg,#fff)", color: "var(--text,#333)", outline: "none", fontFamily: "var(--font-mono,monospace)" }}
        />
        <button onClick={load} style={{ ...segBtn, fontSize: 11, padding: "3px 8px" }}>拉取操作清单</button>
        <button onClick={openRange} disabled={picked.length !== 2}
          style={{ ...btnPrimary, fontSize: 11, padding: "3px 8px", ...(picked.length !== 2 ? { opacity: 0.5 } : {}) }}>打开对比</button>
      </div>
      {info && <div style={{ fontSize: 11, color: "var(--text-muted,#888)", marginTop: 4 }}>{info}</div>}
      {msgs && (
        <div style={{ marginTop: 6, maxHeight: 180, overflowY: "auto" }}>
          {msgs.length === 0 && <div style={{ fontSize: 11, color: "var(--text-muted,#999)", padding: 4 }}>台账为空</div>}
          {msgs.map((m) => (
            <div key={m.msgSeq} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text,#333)" }}>{m.label}</div>
              {m.ops.map((o: any) => (
                <div
                  key={o.op}
                  onClick={() => o.after && toggle(o.after)}
                  title={o.after ? "点击选为 base/target 节点（先 base 后 target）" : "无 after commit"}
                  style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 6px", borderRadius: 5, cursor: o.after ? "pointer" : "default", fontSize: 11, fontFamily: "var(--font-mono,monospace)", background: picked.includes(o.after) ? "var(--bg-selected,#eef3ff)" : "transparent" }}
                >
                  <span style={{ color: "var(--accent,#2563eb)", fontWeight: 700, width: 32 }}>#{o.op}</span>
                  <span style={{ color: "var(--text-dim,#888)", width: 44 }}>{o.tool}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text,#333)" }}>{o.summary}</span>
                  <span style={{ color: "var(--text-dim,#999)", flexShrink: 0 }}>{o.filesCount} 文件{o.partial ? " · partial" : ""}</span>
                  <span style={{ color: "#7c3aed", flexShrink: 0 }}>{(o.after || "").slice(0, 7)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
