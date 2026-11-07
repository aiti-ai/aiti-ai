/**
 * aiti-git-review · 审核工作区（自手写版迁移；逻辑一比一）。
 *
 * 三栏：文件清单 / Monaco diff（并排/合并/纯新/大纲）/ 标注-汇总面板。
 * 行加注：右键或 ✍ 模式点击行 → ComposeBar；标注流水线（站化）在右侧顶部固定表单。
 * 渲染结构（M3 审查后重构，迁移保持不变）：
 *   - effect A [diff, view]：建/销毁 Monaco 编辑器（异步加载）
 *   - effect B [diff, view, fileAnnos]：标注装饰重挂（S1 修复：标注变化即更新）
 *   - contextmenu 监听带 dispose（S3 修复）；侧判定用 getDomNode().contains（S2 修复）
 */
import { useState, useEffect, useRef } from "react";
import { t, apiUrl, extSvc } from "./host-shim";
import { uiAlert } from "../../../_shared/ui-dialogs";
import {
  api, jsonBody, G, getCtx, lastSeg, MONO, SMALL_MQ,
  statusIcon, statusColor, sevColor, sevLabel,
  getSaved, saveConfig, loadTouchedBuckets, buildStops, autoGrow, injectStyles,
  overlay, topBar, bodyRow, fileList, fileRow, panel, allRow, segBtn, segOn, miniBtn, btnPrimary, bottomBar, btn,
  rollbackPartial, hunksForSelection, hunksDelta, rollbackMockOn,
} from "./shared";
import { loadMonaco } from "./monaco-loader";

const vsBase = () => apiUrl("/api/extensions/aiti-editor/assets/monaco/vs");
const basePathOf = () => {
  const m = location.pathname.match(/^\/([^/]+)\//);
  return ((window as any).__PIBASE__ ? String((window as any).__PIBASE__) : (m ? "/" + m[1] : ""));
};

// AI 预审状态轮询 hook：返回 "running" | "done" | null（boundSessionId 在 running 集里=预审中；转入 done 首次触发 onDone）
function useAiPreStatus(boundSessionId: string | null, onDone?: () => void) {
  const [st, setSt] = useState<string | null>(null); // null=无绑定/未知，"running"，"done"
  const prevRunningRef = useRef(false);
  const doneRef = useRef(false);
  useEffect(() => {
    if (!boundSessionId) { setSt(null); return; }
    let dead = false;
    const tick = () => {
      fetch(location.origin + basePathOf() + "/api/agent/running", { cache: "no-store" }).then((r) => r.json()).then((d) => {
        if (dead) return;
        const running = !!(d && Array.isArray(d.runningSessionIds) && d.runningSessionIds.includes(boundSessionId));
        if (running) { prevRunningRef.current = true; setSt((cur) => (cur !== "running" ? "running" : cur)); }
        else if (prevRunningRef.current && !doneRef.current) {
          // running -> done 转变：触发回调一次
          doneRef.current = true;
          setSt("done");
          try { onDone && onDone(); } catch {}
        }
      }).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => { dead = true; clearInterval(timer); };
  }, [boundSessionId]);
  return st;
}

export function ReviewApp({ onClose, init, onExitToList }: {
  onClose: () => void;
  init: any;
  onExitToList?: () => void;
}) {
  const [task, setTask] = useState<any>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  // 视图：小屏默认「合并」（并排在窄屏不可读）；用户手动选过后不再跟随断点切换
  const [view, setView] = useState(() => (window.matchMedia(SMALL_MQ).matches ? "inline" : "side"));
  const viewTouchedRef = useRef(false);
  const setViewUser = (v: string) => { viewTouchedRef.current = true; setView(v); };
  // 加注模式：点 diff 行加注。触屏无右键 → 小屏默认开；桌面默认关（右键可用）
  const [annoMode, setAnnoMode] = useState(() => window.matchMedia(SMALL_MQ).matches);
  const annoModeRef = useRef(annoMode);
  annoModeRef.current = annoMode;
  // 侧栏开关（桌面）：左文件列表 / 右标注面板——隐藏时 diff 占满整行；小屏用三区切换，不用这两个开关
  const [showFiles, setShowFiles] = useState(true);
  const [showPanel, setShowPanel] = useState(true);
  // 中间 diff 视口开关（桌面）：关掉后右侧面板自动占满整行
  const [showDiff, setShowDiff] = useState(true);
  const [curFile, setCurFile] = useState("");
  const [diff, setDiff] = useState<any>(null);
  const [hunkIdx, setHunkIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [summary, setSummary] = useState("");
  const [composing, setComposing] = useState<any>(null); // { line, side }
  const [panelTab, setPanelTab] = useState("anno"); // anno（流水线标注）| all | summary
  const [annoSev, setAnnoSev] = useState("suggest"); // 流水线 severity（跨块保持上次选择）
  const [annoStop, setAnnoStop] = useState(0); // 流水线站序：0=块默认位，>0=块内已有标注站
  const hunks: any[] = (diff && diff.hunks) || [];
  const curFileAnnos = annotations.filter((a) => a.file === curFile);
  // ── trace 任务源（docs/aiti-git-trace-plan.md §6.3）：仅 source=trace 提供评审内部分回滚 ──
  const isTrace = !!(task && task.source === "trace");
  const [rbSel, setRbSel] = useState<{ start: number; end: number; side: string } | null>(null);
  const [rollExecProgram, setRollExecProgram] = useState(false); // 提交时让程序尝试执行回滚标记（默认关=打包给 AI）
  const [rbBusy, setRbBusy] = useState(false);
  const [rbMsg, setRbMsg] = useState("");
  // file → 已标记回滚的 hunkIdx（[] = 整文件）。标注式回滚：先标记→展示/可取消→提交时程序执行或打包给 AI
  const [rolledBack, setRolledBack] = useState<Record<string, number[]>>({});
  const [rollResults, setRollResults] = useState<Record<string, { status: string; result?: string }>>({});
  const marksRef = useRef<Record<string, number[]>>({});
  marksRef.current = rolledBack;
  // 行号槽 ↩ 点击 handler（每次渲染刷新闭包，防 curFile/diff 过期；Monaco 绑定走一次性 listener）
  const markClickRef = useRef<(e: MouseEvent) => void>(() => {});
  const rollResultsRef = useRef<Record<string, { status: string; result?: string }>>({});
  rollResultsRef.current = rollResults;
  const marksLoaded = useRef(false);
  // 落站 severity 跟随：站上带已有标注（AI/用户）→ severity 选择器切到该标注的值；空站保持上次选择
  useEffect(() => {
    const hk = hunks.length ? hunks[Math.min(hunkIdx, hunks.length - 1)] : null;
    const stops = hk ? buildStops(hk, curFileAnnos) : [];
    const idx = stops.length ? Math.min(Math.max(annoStop, 0), stops.length - 1) : 0;
    const st = stops[idx];
    if (st && st.anno) setAnnoSev(st.anno.severity || "suggest");
  }, [curFile, hunkIdx, annoStop, annotations]);
  const [edReady, setEdReady] = useState(false); // Monaco 编辑器就绪（diff 加载中提示用）
  // 小屏（宽≤640）：单列布局。惰性初始化——首帧即小屏布局，不闪桌面三列
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(SMALL_MQ).matches);
  const [mobilePane, setMobilePane] = useState("diff"); // 小屏三区切换：files|diff|panel
  const revRef = useRef(0);
  // 标注引用：渲染 effect 与标注 effect 共享最新值（S1 修复核心）
  const annosRef = useRef<any[]>([]);
  const fileAnnos = annotations.filter((a) => a.file === curFile);
  annosRef.current = fileAnnos;
  // diff 引用：跳转重试时读最新（闭包 stale 修复）
  const diffRef = useRef<any>(null);
  diffRef.current = diff;
  // ── 响应式布局：按屏幕宽度分桶，每桶独立记忆布局 ──
  // 桶 = Math.floor(innerWidth/200)*200（777→600, 1024→1000, 1440→1400）
  const [widthBucket, setWidthBucket] = useState(() => Math.floor(window.innerWidth / 200) * 200);
  const layoutTouchedBuckets = useRef<Set<number>>(new Set()); // 用户手动改过布局的桶集（跨浏览器会话持久化）
  const viewRef = useRef(view);
  const showFilesRef = useRef(showFiles);
  const showDiffRef = useRef(showDiff);
  const showPanelRef = useRef(showPanel);
  const widthBucketRef = useRef(widthBucket);

  function restoreConfig(cfg: any, bucket: number | null, markTouched?: boolean) {
    setView(cfg.view || "inline");
    viewTouchedRef.current = true; // 已恢复用户配置 → 不再跟随断点自动切换
    setShowFiles(cfg.showFiles !== false);
    setShowDiff(cfg.showDiff !== false);
    setShowPanel(cfg.showPanel !== false);
    // 智能默认不标记已触及（markTouched=false）：与 localStorage 未保存一致，后续断点仍可跟随
    if (bucket && markTouched !== false) layoutTouchedBuckets.current.add(bucket);
  }
  function saveLayoutManual(next?: any) {
    const bucket = widthBucketRef.current;
    if (!bucket) return;
    // 注意：refs 在 render 末尾才更新，onClick 里 setState 后同步调用读到的是旧值；
    // 必须由调用方把 next 值显式传进来，否则每次保存的都是上一次布局
    const cur = {
      view: viewRef.current, showFiles: showFilesRef.current, showDiff: showDiffRef.current, showPanel: showPanelRef.current,
      ...(next || {}),
    };
    saveConfig(bucket, cur);
    layoutTouchedBuckets.current.add(bucket);
  }
  viewRef.current = view;
  showFilesRef.current = showFiles;
  showDiffRef.current = showDiff;
  showPanelRef.current = showPanel;
  widthBucketRef.current = widthBucket;
  // 恢复已触及过的桶集
  useEffect(() => {
    for (const b of loadTouchedBuckets()) layoutTouchedBuckets.current.add(b);
  }, []);

  // 跨文件回退哨兵：true = 下一次 diff 加载后落该文件最后一块最后一站
  const landLastRef = useRef(false);
  // 待定位行：diff 加载/编辑器重建后要 reveal 的行（跨文件导航/标注跳转 → 编辑器随 diff 重建，旧 reveal 引用失效）
  const pendingRevealRef = useRef<number | null>(null);
  // 定位到指定行（modified 侧；单编辑器即其自身）。编辑器未就绪时静默跳过
  function revealLine(ln?: number | null) {
    if (!ln || ln < 1) return;
    const c: any = containerRef.current;
    const ed = c && c._aitiGrEd;
    if (!ed) return;
    const target = ed.getModifiedEditor ? ed.getModifiedEditor() : ed;
    try { target && target.revealPositionInCenter && target.revealPositionInCenter({ lineNumber: Math.max(1, ln), column: 1 }, true); } catch {}
  }

  // 跳到标注所在变更块（全部/汇总索引共用）：切文件→等 diff→定位 hunk→回标注 tab
  function jumpTo(a: any) {
    const ln = a.side === "old" ? a.oldLine : a.newLine;
    if (!a.file || !ln) return;
    setCurFile(a.file);
    const tryLocate = (n: number) => {
      const d = diffRef.current;
      const hs = (d && d.file === a.file && d.hunks) || [];
      const i = hs.findIndex((hk: any) => {
        const s = a.side === "old" ? hk.oldStart : hk.newStart;
        const c = a.side === "old" ? hk.oldLines : hk.newLines;
        return ln >= s && ln < s + Math.max(1, c);
      });
      if (i >= 0) {
        setHunkIdx(i);
        // 落到该标注所在站（预填原文可直接修改）；不在站里则落第 0 站
        const fAnnos = annotations.filter((x) => x.file === a.file && !x.resolved);
        const stops = buildStops(hs[i], fAnnos);
        const si = stops.findIndex((st) => st.anno && st.anno.id === a.id);
        setAnnoStop(si >= 0 ? si : 0);
        setPanelTab("anno");
        // 编辑器已是该文件的 diff → 立即定位；否则（跨文件/编辑器重建中）交给 pendingReveal 落位
        const ed = (containerRef.current as any) && (containerRef.current as any)._aitiGrEd;
        if (ed && ed._aitiGrDiff === diffRef.current) revealLine(ln);
        else pendingRevealRef.current = ln;
        return;
      }
      if (n > 0) setTimeout(() => tryLocate(n - 1), 400);
    };
    tryLocate(6);
  }

  // 加载任务：taskId 直载（选择器打开现有）或 /open 新建
  useEffect(() => {
    let dead = false;
    setBusy(true);
    if (init && init.taskId) {
      // 打开现有任务：拉全量（GET /load?task=）
      api("/load?task=" + encodeURIComponent(init.taskId)).then((r) => r.json()).then((d) => {
        if (dead) return;
        if (!d.ok) { setErr(d.error || "任务不存在"); setBusy(false); return; }
        setTask(d.task); setFiles(d.task.files || []); setAnnotations(d.task.annotations || []);
        setSummary(d.task.summary || ""); revRef.current = d.task.revision || 0;
        if (Array.isArray(d.task.rollmarks)) {
          const m: Record<string, number[]> = {}; const rs: Record<string, { status: string; result?: string }> = {};
          for (const mk of d.task.rollmarks) { m[mk.file] = mk.hunkIdx || []; if (mk.status !== "marked") rs[mk.file] = { status: mk.status, result: mk.result }; }
          setRolledBack(m); setRollResults(rs);
        }
        marksLoaded.current = true; // 无论任务有无 rollmarks 字段，加载完成即可持久化（否则新任务标记永远不上传）
        if (d.task.repo) G.probePath = d.task.repo;
        // 选中第一个文件
        if (d.task.files && d.task.files.length) {
          const f = d.task.files.find((x: any) => x.selected) || d.task.files[0];
          setCurFile(f.path);
        }
        setBusy(false);
        loadMonaco(vsBase()).catch(() => {});
      }).catch((e) => { if (!dead) { setErr(String(e)); setBusy(false); } });
      return () => { dead = true; };
    }
    // 新建（选择器 create 走 /open 后已进工作区；兼容旧路径：直接 scope 建）
    const body: any = { path: init && init.path };
    if (init && init.scope && init.scope.path) {
      body.path = init.scope.kind === "file"
        ? String(init.scope.path).split("/").slice(0, -1).join("/") || "/"
        : init.scope.path;
    }
    if (init && init.scope) body.scope = init.scope;
    api("/open", { method: "POST", ...jsonBody(body) }).then((r) => r.json()).then((d) => {
      if (dead) return;
      if (!d.ok) { setErr(d.error || "打开失败"); setBusy(false); return; }
      setTask(d.task);
      setFiles(d.task.files || []);
      setAnnotations(d.task.annotations || []);
      setSummary(d.task.summary || "");
      revRef.current = d.task.revision || 0;
      if (Array.isArray(d.task.rollmarks)) {
        const m: Record<string, number[]> = {}; const rs: Record<string, { status: string; result?: string }> = {};
        for (const mk of d.task.rollmarks) { m[mk.file] = mk.hunkIdx || []; if (mk.status !== "marked") rs[mk.file] = { status: mk.status, result: mk.result }; }
        setRolledBack(m); setRollResults(rs);
      }
      marksLoaded.current = true; // /open 新建路径同样要允许标记持久化
      if (d.task && d.task.repo) G.probePath = d.task.repo;
      setBusy(false);
      // 预热 Monaco（diff 到时秒建编辑器，避免连接被轮询抢占后 Monaco 饿死）
      loadMonaco(vsBase()).catch(() => {});
    }).catch((e) => { if (!dead) { setErr(String(e)); setBusy(false); } });
    return () => { dead = true; };
  }, []);

  // 拉单文件 diff（按需）
  useEffect(() => {
    if (!task || !curFile) { setDiff(null); return; }
    let dead = false;
    setDiff(null);
    api("/diff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: task.id, file: curFile }) }).then((r) => r.json()).then((d) => {
      if (dead) return;
      if (d.ok) {
        setDiff(d.diff);
        // 跨文件回退（⏮/◀ 在首块）：落该文件最后一块最后一站；否则首块首站
        const back = landLastRef.current;
        landLastRef.current = false;
        const hs = (d.diff && d.diff.hunks) || [];
        const ti = back && hs.length ? hs.length - 1 : 0;
        setHunkIdx(ti);
        setAnnoStop(back ? 9999 : 0); // 9999：渲染/落站 effect 自动钳制到最后站
        // 编辑器随 diff 重建 → 记住目标块首行，编辑器建好后 reveal（否则跨文件只换内容不定位）
        const th = hs.length ? hs[ti] : null;
        pendingRevealRef.current = th ? (th.newStart || th.oldStart || 1) : null;
      }
      else setDiff(null);
    }).catch(() => { if (!dead) setDiff(null); });
    return () => { dead = true; };
  }, [task, curFile]);

  // 首次：选中第一个文件
  useEffect(() => {
    if (task && task.files && task.files.length > 0 && !curFile) {
      const f = task.files.find((x: any) => x.selected);
      setCurFile((f && f.path) || task.files[0].path);
    }
  }, [task]);

  // 小屏判定 + 宽度桶布局恢复：断点跨越时切换单列/三列；宽度跨越桶边界时恢复该桶配置
  useEffect(() => {
    const mq = window.matchMedia(SMALL_MQ);
    let firstRun = true;
    const upd = () => {
      const bw = Math.floor(window.innerWidth / 200) * 200;
      const newIsMobile = mq.matches;
      setIsMobile(newIsMobile);
      // 首次运行也要恢复（初始桶 widthBucketRef 就是当前宽度，不等跨桶）
      if (firstRun || bw !== widthBucketRef.current) {
        firstRun = false;
        if (bw !== widthBucketRef.current) setWidthBucket(bw);
        const cfg = getSaved(bw);
        if (cfg) {
          restoreConfig(cfg, bw, true);
        } else if (layoutTouchedBuckets.current.has(bw)) {
          // 该桶之前触及过但无配置 → 保持当前
        } else {
          // 从未触及的桶 → 应用智能默认（不保存到 localStorage，也不标记已触及）
          if (bw < 750) {
            restoreConfig({ view: "inline", showFiles: false, showDiff: false, showPanel: true }, null, false);
          } else if (bw < 950) {
            restoreConfig({ view: "inline", showFiles: false, showDiff: true, showPanel: true }, null, false);
          }
          // bw ≥ 950：三栏全显（默认，无需 restore）
        }
      }
      // 用户手动选过视图则永远尊重；否则跟随断点默认——放在桶恢复之后，避免桶恢复前闪断点默认
      if (!viewTouchedRef.current && !layoutTouchedBuckets.current.has(bw)) {
        setView(newIsMobile ? "inline" : "side");
      }
    };
    upd();
    mq.addEventListener("change", upd);
    return () => mq.removeEventListener("change", upd);
  }, []);

  // 标注刷新（事件驱动，零轮询）：打开任务拉一次；此后订阅扩展服务端 /events SSE，
  // 服务端 writeTask（AI 预审写回/人工编辑）时广播 revision → 拉一次 /annotations。
  // 不覆盖本地正在编辑/未保存的 summary。
  const summaryRef = useRef("");
  summaryRef.current = summary;
  useEffect(() => {
    if (!task) return;
    let stopped = false;
    const pull = () => {
      // GET /annotations：服务端比对内容哈希，漂移则用 anchor 重映射行号/标 stale
      api("/annotations?task=" + task.id).then((r) => r.json()).then((d) => {
        if (stopped || !d || !d.task) return;
        setAnnotations(d.task.annotations || []);
        revRef.current = d.task.revision || 0;
        // 本地未保存（编辑中或本次会话刚改）时不覆盖；仅当本地为空且服务端有
        if (!summaryRef.current && d.task.summary) setSummary(d.task.summary);
      }).catch(() => {});
    };
    void pull(); // 打开任务立即对齐一次
    // 事件总线 topics 唯一（2026-09-09 拍板）：白名单 gr:task；禁止任何兑底（全帧/core route/自建 SSE 均已删）。
    // topics 服务缺席（event-bus 未启用）→ 不订阅，任务状态靠打开时 pull() 一次性拉取。
    const topicsSvc = extSvc<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
    if (topicsSvc) {
      const off = topicsSvc((f: any) => { if (f && f.type === "gr:task" && f.taskId === task.id) void pull(); }, ["gr:task"]).off;
      return () => { stopped = true; try { off?.(); } catch {} };
    }
    return () => { stopped = true; };
  }, [task]);

  // ── effect A：建/销毁 Monaco 编辑器（diff 或 view 变化） ──
  useEffect(() => {
    if (!diff || !containerRef.current) return;
    let disposed = false;
    let ed: any = null, origM: any = null, modM: any = null;
    setEdReady(false);
    loadMonaco(vsBase()).then((monaco) => {
      if (disposed || !containerRef.current) return;
      const c = containerRef.current as any;
      if (c._aitiGrEd) { try { c._aitiGrEd.dispose(); } catch {} c._aitiGrEd = null; }
      // 防御：dispose 后容器会残留 data-keybinding-context，重建时 ScopedContextKeyService 检测到即
      // console.error("Element already has context attribute")（同 aiti-editor editor-app 的处理）
      c.removeAttribute?.("data-keybinding-context");
      origM = monaco.editor.createModel(diff.original || "", "plaintext");
      modM = monaco.editor.createModel(diff.modified || "", "plaintext");

      if (view === "current") {
        // 纯新：单编辑器只显示 new 侧（工作区内容）
        ed = monaco.editor.create(c, {
          model: modM,
          readOnly: true,
          automaticLayout: true,
          fontSize: 12.5,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          glyphMargin: true,
        });
        ed._aitiGrSide = "new";
      } else {
        ed = monaco.editor.createDiffEditor(c, {
          renderSideBySide: view === "side",
          readOnly: true,
          automaticLayout: true,
          fontSize: 12.5,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          glyphMargin: true,
        });
        ed.setModel({ original: origM, modified: modM });
      }
      ed._aitiGrDiff = diff; // 编辑器 ↔ diff 归属标记（jumpTo 判断能否立即 reveal）
      c._aitiGrEd = ed;
      setEdReady(true);
      applyAnnotations(); // 用 annosRef 最新值（标注可能在编辑器建好前已就绪）
      // 跨文件导航/跳转：消费 pendingReveal，落到目标块首行
      const pr = pendingRevealRef.current;
      pendingRevealRef.current = null;
      if (pr) revealLine(pr);
    }).catch((e) => { if (!disposed) setErr("Monaco 加载失败: " + String(e)); });
    return () => {
      disposed = true;
      try { ed && ed.dispose(); } catch {}
      try { origM && origM.dispose(); modM && modM.dispose(); } catch {}
    };
  }, [diff, view]);

  // ── effect B：标注装饰重挂（fileAnnos 变化即更新；S1 修复） ──
  useEffect(() => {
    const c: any = containerRef.current;
    const ed = c && c._aitiGrEd;
    if (ed) applyAnnotations();
  }, [diff, view, fileAnnos, rolledBack, curFile]);

  // 标注装饰应用（统一函数；读取 annosRef 最新值）
  function applyAnnotations() {
    const c = containerRef.current as any;
    const ed = c && c._aitiGrEd;
    const w = window as any;
    if (!ed || !w.monaco || !diff) return;
    const monaco = w.monaco;
    const annos = annosRef.current || [];
    let targetEd: any = null; // 单编辑器（纯新）或 diff 的 modified
    let origEd: any = null;
    if (ed.getModifiedEditor) { targetEd = ed.getModifiedEditor(); origEd = ed.getOriginalEditor(); }
    else targetEd = ed; // 纯新：单 editor
    const targetModel = targetEd.getModel();
    if (!targetModel) return;
    const deco: any[] = [];
    for (const a of annos) {
      const isOld = a.side === "old";
      // 纯新视图没有 old 侧 → old 标注跳过
      if (isOld && (!origEd || !ed.getModifiedEditor)) continue;
      const model = isOld ? origEd.getModel() : targetModel;
      const line = isOld ? a.oldLine : a.newLine;
      if (!line || !model) continue;
      if (line > model.getLineCount()) continue; // stale 行号超出（内容已删）→ 跳过装饰但面板保留
      const maxCol = model.getLineMaxColumn(line);
      deco.push({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: Math.max(1, maxCol || 1) },
        options: {
          isWholeLine: true,
          className: "aiti-gr-anno-line",
          glyphMarginClassName: "aiti-gr-glyph-" + a.severity + (a.author === "ai" ? "-ai" : ""),
          overviewRuler: { color: sevColor(a.severity), position: monaco.editor.OverviewRulerLane.Full },
          linesDecorationsClassName: "aiti-gr-margin-" + a.severity,
        },
      });
    }
    if (targetEd._aitiGrDecos) targetEd.deltaDecorations(targetEd._aitiGrDecos, deco);
    else targetEd._aitiGrDecos = targetEd.deltaDecorations([], deco);
    if (origEd) {
      const origAnnos = annos.filter((a) => a.side === "old");
      const origDeco: any[] = [];
      for (const a of origAnnos) {
        const line = a.oldLine;
        const m = origEd.getModel();
        if (!line || !m) continue;
        if (line > m.getLineCount()) continue;
        origDeco.push({
          range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: Math.max(1, m.getLineMaxColumn(line) || 1) },
          options: {
            isWholeLine: true,
            className: "aiti-gr-anno-line",
            glyphMarginClassName: "aiti-gr-glyph-" + a.severity + (a.author === "ai" ? "-ai" : ""),
            overviewRuler: { color: sevColor(a.severity), position: monaco.editor.OverviewRulerLane.Full },
            linesDecorationsClassName: "aiti-gr-margin-" + a.severity,
          },
        });
      }
      if (origEd._aitiGrDecos) origEd.deltaDecorations(origEd._aitiGrDecos, origDeco);
      else origEd._aitiGrDecos = origEd.deltaDecorations([], origDeco);
    }
    // ── 回滚标记装饰（§14：marked hunks → 橙色行背景 + 行号槽 ↩；独立 owner 不与标注互踩）──
    try {
      const marks = marksRef.current[diff.file];
      const markTarget: any[] = []; const markOrig: any[] = [];
      if (marks) {
        const whole = marks.length === 0;
        (diff.hunks || []).forEach((hk: any, i: number) => {
          if (!whole && !marks.includes(i)) return;
          const push = (ed2: any, sf: string, lf: string, bucket: any[]) => {
            const m2 = ed2 && ed2.getModel && ed2.getModel(); if (!m2) return;
            const s0 = hk[sf]; const n0 = Math.max(1, hk[lf] || 1);
            if (typeof s0 !== "number") return;
            const hi = Math.min(s0 + n0 - 1, m2.getLineCount());
            for (let ln = s0; ln <= hi; ln++) {
              bucket.push({ range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: Math.max(1, m2.getLineMaxColumn(ln) || 1) }, options: { isWholeLine: true, className: "aiti-gr-mark-line", linesDecorationsClassName: "aiti-gr-mark-deco", overviewRuler: { color: "#b45309", position: monaco.editor.OverviewRulerLane.Full } } });
            }
          };
          push(targetEd, "newStart", "newLines", markTarget);
          if (origEd) push(origEd, "oldStart", "oldLines", markOrig);
        });
      }
      if (targetEd._aitiGrMarkDecos) targetEd.deltaDecorations(targetEd._aitiGrMarkDecos, markTarget);
      else targetEd._aitiGrMarkDecos = targetEd.deltaDecorations([], markTarget);
      if (origEd) {
        if (origEd._aitiGrMarkDecos) origEd.deltaDecorations(origEd._aitiGrMarkDecos, markOrig);
        else origEd._aitiGrMarkDecos = origEd.deltaDecorations([], markOrig);
      }
    } catch { /* 标记装饰失败不影响标注 */ }
    injectStyles();
    bindMarkClicks();
    syncWidgets(targetEd, annos.filter((a: any) => a.side !== "old"), false);
    if (origEd) syncWidgets(origEd, annos.filter((a: any) => a.side === "old"), true);
    hoverWatch();
  }

  // ── 行号槽 ↩ 点击 = 取消该块回滚标记（GUTTER_GLYPH_MARGIN 命中 → 行号反查 hunk → toggle）──
  markClickRef.current = (e: MouseEvent) => {
    const w = window as any;
    const c = containerRef.current as any;
    const eds = c && c._aitiGrEd;
    if (!eds || !w.monaco || !task) return;
    const editors: any[] = eds.getModifiedEditor ? [eds.getModifiedEditor(), eds.getOriginalEditor()] : [eds];
    for (let ei = 0; ei < editors.length; ei++) {
      const ed = editors[ei];
      const t = ed.getTargetAtClientOffset && ed.getTargetAtClientOffset(e.clientX, e.clientY);
      if (!t) continue;
      const tType = t.type;
      const isGlyph = tType === w.monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || tType === w.monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS;
      if (!isGlyph) continue;
      const line = t.position && t.position.lineNumber;
      if (!line) return;
      // 只响应回滚标记的行号槽装饰（标注槽各有自己的交互，不抢）
      const range = new w.monaco.Range(line, 1, line, 1);
      const decos = ed.getDecorationsInRange(range) || [];
      const hasMark = (Array.isArray(decos) ? decos : Array.from(decos as any)).some((d: any) => {
        const o = d && d.options;
        return o && (String(o.linesDecorationsClassName || "").includes("aiti-gr-mark-deco"));
      });
      if (!hasMark) continue;
      const file = diffRef.current && diffRef.current.file;
      if (!file) return;
      const idx = hunksForSelection((diffRef.current && diffRef.current.hunks) || [], line, line, ei === 0 ? "new" : "old");
      if (idx.length === 0) return;
      e.preventDefault(); e.stopPropagation();
      toggleRollMark([{ file, hunkIdx: idx }]);
      return;
    }
  };
  function bindMarkClicks() {
    const c = containerRef.current as any;
    if (!c || c._aitiGrMarkBound) return;
    c._aitiGrMarkBound = true;
    c.addEventListener("mousedown", (e: MouseEvent) => markClickRef.current(e));
  }

  // ── 行 hover 显示气泡：ContentWidget 不在行 DOM 祖先链内（CSS 祖先选择器不可用）——
  // 用容器 mousemove 委托：命中标注行时按行号显示对应 widget，离开隐藏
  function hoverWatch() {
    const c = containerRef.current as any;
    if (!c || c._aitiGrHoverBound) return;
    c._aitiGrHoverBound = true;
    // 反查：鼠标坐标 → 编辑器 + 行号（不依赖装饰 class 是否在行 DOM 上）
    const posAt = (xe: MouseEvent) => {
      const eds = c._aitiGrEd;
      if (!eds) return null;
      const list = [eds.getModifiedEditor ? eds.getModifiedEditor() : eds, eds.getOriginalEditor ? eds.getOriginalEditor() : null].filter(Boolean);
      for (const ed of list) {
        const dom = ed.getDomNode();
        if (!dom.contains(xe.target)) continue;
        const pos = ed.getTargetAtClientPoint(xe.clientX, xe.clientY);
        if (pos && pos.position) return { ed, line: pos.position.lineNumber };
      }
      return null;
    };
    const showFor = (hit: any) => {
      const cc = containerRef.current as any;
      const eds = cc && cc._aitiGrEd;
      if (!eds) return;
      const list = [eds.getModifiedEditor ? eds.getModifiedEditor() : eds, eds.getOriginalEditor ? eds.getOriginalEditor() : null].filter(Boolean);
      for (const ed of list) {
        const widgets = ed._aitiGrWidgets || new Map();
        let targetId: string | null = null;
        if (hit && hit.ed === ed) {
          for (const [id, wd] of widgets) { if ((wd as any)._line === hit.line) { targetId = id; break; } }
        }
        if (ed._aitiGrShown !== targetId) {
          if (ed._aitiGrShown) { try { ed.removeContentWidget(widgets.get(ed._aitiGrShown)); } catch {} }
          if (targetId) { try { ed.addContentWidget(widgets.get(targetId)); } catch {} }
          ed._aitiGrShown = targetId;
        }
      }
    };
    c.addEventListener("mousemove", (e: MouseEvent) => {
      const hit = posAt(e);
      if (!hit) { showFor(null); return; }
      // 该行有标注才显示（annosRef 最新值，双侧都查）
      const annos = annosRef.current || [];
      const hasAnno = annos.some((a: any) => {
        const ln = a.side === "old" ? a.oldLine : a.newLine;
        return ln === hit.line;
      });
      showFor(hasAnno ? hit : null);
    });
    c.addEventListener("mouseleave", () => showFor(null));
  }

  // ── 标注悬浮气泡（行 hover）：ContentWidget 展示 severity/作者/正文。Monaco 接管 domNode 的 display，
  // 故按需 add/remove：Map 存全部 widget（不挂载），hover 命中才 addContentWidget，移开 remove ──
  function syncWidgets(editor: any, annos: any[], isOldSide: boolean) {
    const w = window as any;
    if (!editor || !w.monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const existing = editor._aitiGrWidgets || new Map();
    const keep = new Map(); // id → widget（重建最新内容/行号）
    for (const a of annos) {
      const line = isOldSide ? a.oldLine : a.newLine;
      if (!line || line > model.getLineCount()) continue; // stale：不挂
      const wd = makeWidget(a);
      wd.domNode.appendChild(makeBubbleDom(a));
      wd._line = line;
      keep.set(a.id, wd);
    }
    // 清理：不再存在的 + 当前展示但已失效的
    for (const [id, wd] of existing) {
      if (!keep.has(id)) { try { editor.removeContentWidget(wd); } catch {} }
    }
    if (editor._aitiGrShown && !keep.has(editor._aitiGrShown)) {
      try { editor.removeContentWidget(existing.get(editor._aitiGrShown)); } catch {}
      editor._aitiGrShown = null;
    }
    editor._aitiGrWidgets = keep;
  }
  function makeWidget(a: any) {
    const w = window as any;
    const dom = document.createElement("div");
    const wd: any = {
      domNode: dom,
      getId: () => "aiti-gr-w-" + a.id,
      getDomNode: () => dom,
      getPosition: () => ({ position: { lineNumber: wd._line || 1, column: 1 }, preference: [w.monaco.editor.ContentWidgetPositionPreference.EXACT] }),
      _line: 1,
    };
    dom.className = "aiti-gr-bubble-host";
    return wd;
  }
  function makeBubbleDom(a: any) {
    const el = document.createElement("div");
    el.className = "aiti-gr-bubble";
    const tag = sevLabel(a.severity) + (a.author === "ai" ? "·AI" : "") + (a.stale ? " ·漂移" : "");
    el.innerHTML = '<div class="aiti-gr-bubble-tag" style="border-color:' + sevColor(a.severity) + ';color:' + sevColor(a.severity) + '">' + tag + '</div><div class="aiti-gr-bubble-text"></div>';
    el.querySelector(".aiti-gr-bubble-text")!.textContent = a.text || ""; // textContent 防注入
    return el;
  }

  // ── 加注输入入口：右键 contextmenu + 加注模式点击行（带 dispose；S2 侧判定修复） ──
  useEffect(() => {
    const c = containerRef.current as any;
    if (!c) return;
    const ed = c._aitiGrEd;
    if (!ed) return;
    const modEd = ed.getModifiedEditor ? ed.getModifiedEditor() : ed;
    const origEd = ed.getOriginalEditor ? ed.getOriginalEditor() : null;
    const onCtx = (e: any) => {
      const line = e.target && e.target.position && e.target.position.lineNumber;
      if (!line) return;
      // 侧判定：target.element 是否在 original 编辑器 DOM 内（class 判定不可靠）
      const el = e.target && e.target.element;
      const isOrig = !!(el && origEd && origEd.getDomNode && origEd.getDomNode().contains(el));
      setComposing({ line, side: isOrig ? "old" : "new" });
    };
    // 加注模式：点击（含触屏 tap）diff 行 → 直接打开标注输入
    const onDown = (e: any) => {
      if (!annoModeRef.current) return;
      const line = e.target && e.target.position && e.target.position.lineNumber;
      if (!line) return;
      const el = e.target && e.target.element;
      const isOrig = !!(el && origEd && origEd.getDomNode && origEd.getDomNode().contains(el));
      setComposing({ line, side: isOrig ? "old" : "new" });
    };
    const d1 = modEd.onContextMenu(onCtx);
    const d2 = origEd ? origEd.onContextMenu(onCtx) : null;
    const d3 = modEd.onMouseDown(onDown);
    const d4 = origEd ? origEd.onMouseDown(onDown) : null;
    // 回滚选区捕获（trace）：记录最近非空选区的行区间与所在侧
    const mkSel = (side: string) => (e: any) => {
      const sel = e && e.selection;
      if (!sel || sel.isEmpty()) return;
      setRbSel({ start: Math.min(sel.startLineNumber, sel.endLineNumber), end: Math.max(sel.startLineNumber, sel.endLineNumber), side });
    };
    const d5 = modEd.onDidChangeCursorSelection(mkSel("new"));
    const d6 = origEd ? origEd.onDidChangeCursorSelection(mkSel("old")) : null;
    return () => { try { d1 && d1.dispose(); d2 && d2.dispose(); d3 && d3.dispose(); d4 && d4.dispose(); d5 && d5.dispose(); d6 && d6.dispose(); } catch {} };
  }, [diff, view, fileAnnos]);

  // 提交标注（通用：任意 file/side/line/lineEnd；Monaco 行入口与右侧流水线共用）
  function addAnnoAt(file: string, side: string, line: number, sev: string, text: string, lineEnd?: number) {
    if (!line || !text || !text.trim()) return;
    const op = { op: "add", file, side: side === "old" ? "old" : "new", line, lineEnd: lineEnd && lineEnd > line ? lineEnd : undefined, severity: sev, text: text.trim() };
    api("/annotations", { method: "POST", ...jsonBody({ taskId: task.id, revision: revRef.current, ops: [op] }) }).then((r) => r.json()).then((d) => {
      if (d.ok) { setAnnotations(d.task.annotations || []); revRef.current = d.revision; }
      else if (d.conflict) { setAnnotations(d.task.annotations || []); revRef.current = d.revision; } // 乐观锁冲突：以服务端为准
    }).catch(() => {});
  }
  function addAnnotation(sev: string, text: string) { // Monaco 右键/✍ 模式（composing 定位）
    if (!composing || !text || !text.trim()) return;
    addAnnoAt(curFile, composing.side || "new", composing.line, sev, text);
    setComposing(null);
  }
  function updateAnnotation(id: string, patch: any) {
    api("/annotations", { method: "POST", ...jsonBody({ taskId: task.id, revision: revRef.current, ops: [{ op: "update", id, ...patch }] }) }).then((r) => r.json()).then((d) => {
      if (d.ok) { setAnnotations(d.task.annotations || []); revRef.current = d.revision; }
      else if (d.conflict) { setAnnotations(d.task.annotations || []); revRef.current = d.revision; }
    }).catch(() => {});
  }
  function deleteAnnotation(id: string) {
    api("/annotations", { method: "POST", ...jsonBody({ taskId: task.id, revision: revRef.current, ops: [{ op: "delete", id }] }) }).then((r) => r.json()).then((d) => {
      if (d.ok) { setAnnotations(d.task.annotations || []); revRef.current = d.revision; }
      else if (d.conflict) { setAnnotations(d.task.annotations || []); revRef.current = d.revision; }
    }).catch(() => {});
  }

  // ── 回滚标记（trace 专属，§6.3 标注式）：点击=标记/取消标记（不执行）；提交时按开关执行或打包给 AI ──
  function toggleRollMark(entries: { file: string; hunkIdx: number[] }[]) {
    if (!isTrace || !task) return;
    setRolledBack((m0) => {
      const next: Record<string, number[]> = { ...m0 };
      for (const en of entries) {
        const cur = next[en.file];
        if (en.hunkIdx.length === 0) {
          if (cur) delete next[en.file]; else next[en.file] = []; // [] = 整文件
        } else {
          const curList = cur || [];
          const allMarked = en.hunkIdx.every((i) => curList.includes(i));
          const merged = allMarked ? curList.filter((i) => !en.hunkIdx.includes(i)) : Array.from(new Set([...curList, ...en.hunkIdx]));
          if (merged.length) next[en.file] = merged; else delete next[en.file];
        }
      }
      return next;
    });
  }
  // 持久化标记（rolledBack 变化即同步；执行结果随 marks 一起存）
  useEffect(() => {
    if (!task || !isTrace || !marksLoaded.current) return;
    const marks = Object.entries(marksRef.current).map(([file, hunkIdx]) => ({ file, hunkIdx, status: rollResultsRef.current[file]?.status || "marked", result: rollResultsRef.current[file]?.result }));
    // 持久化完成后再拉汇总（避免 GET 先于 POST 返回拿到旧内容）
    api("/rollmarks", { method: "POST", ...jsonBody({ taskId: task.id, marks }) })
      .then(() => api("/summary?task=" + task.id).then((x) => x.json()))
      .then((d) => { if (d && d.ok) { setSrvSummary(d.summary || ""); } })
      .catch(() => {});
  }, [rolledBack, task && task.id]);

  function askRollbackSelection() {
    if (!rbSel) return;
    const idx = hunksForSelection(hunks, rbSel.start, rbSel.end, rbSel.side);
    if (idx.length === 0) { setRbMsg("选区未命中任何变更块"); return; }
    toggleRollMark([{ file: curFile, hunkIdx: idx }]);
  }
  // 提交时程序尝试执行：逐文件转发 aiti-git-trace /rollback-partial；结果落状态 + 刷新服务端汇总
  async function executeRollMarks(): Promise<{ done: number; failed: number }> {
    if (!task) return { done: 0, failed: 0 };
    const entries = Object.entries(marksRef.current);
    let done = 0, failed = 0;
    const out: any[] = [];
    for (const [file, hunkIdx] of entries) {
      try {
        // [P0-1] 契约对齐：files 是字符串数组（单文件），hunkIdx 平铺数字数组（空 = 该文件全部 hunk）
        const d = await rollbackPartial({ storeRoot: task.storeRoot || task.repo, sessionId: task.sessionId || "", base: task.base || "", target: task.ref2 || "", files: [file], hunkIdx });
        if (d && d.ok) { done++; out.push({ file, hunkIdx, status: "executed", result: d.mock ? "mock 模拟" : "逆 patch 已应用" }); }
        else { failed++; out.push({ file, hunkIdx, status: "failed", result: (d && d.error) || "未知错误" }); }
      } catch (e: any) { failed++; out.push({ file, hunkIdx, status: "failed", result: String(e) }); }
    }
    setRollResults(Object.fromEntries(out.map((o) => [o.file, { status: o.status, result: o.result }])));
    rollResultsRef.current = Object.fromEntries(out.map((o) => [o.file, { status: o.status, result: o.result }]));
    setRbMsg(failed ? "程序回滚失败 " + failed + "/" + out.length + " 个文件（详见汇总回滚标记区）" : done ? "程序回滚完成 " + done + " 个文件（结果已写入汇总）" : "");
    await api("/rollmarks", { method: "POST", ...jsonBody({ taskId: task.id, marks: out }) }).catch(() => {});
    const r = await api("/summary?task=" + task.id).then((x) => x.json()).catch(() => null);
    if (r && r.ok) { setSummary(r.summary || ""); setSrvSummary(r.summary || ""); }
    return { done, failed };
  }
  async function beforeSendRollback(): Promise<string> {
    if (!rollExecProgram || !isTrace) return "";
    if (Object.keys(marksRef.current).length === 0) return "";
    const r = await executeRollMarks();
    return (r.done || r.failed) ? "\n\n【程序回滚结果】成功 " + r.done + " 个，失败 " + r.failed + " 个（详见回滚标记区状态）" : "";
  }

  // 生成汇总（跟随最新行号）；server 版为准（numstat 全量 +N/-M），拉不到时本地拼接兜底
  const [srvSummary, setSrvSummary] = useState<string | null>(null);
  useEffect(() => {
    if (!task) return;
    let dead = false;
    api("/summary?task=" + task.id).then((r) => r.json()).then((d) => { if (!dead && d && d.ok) setSrvSummary(d.summary || ""); }).catch(() => {});
    return () => { dead = true; };
  }, [task && task.id, annotations.length, Object.keys(rolledBack).length]);
  function genSummary(over?: string) {
    if (over) return over;
    if (srvSummary) return srvSummary;
    const annos = annotations.filter((a) => !a.resolved);
    const lines = annos.map((a) => {
      const ln = a.side === "old" ? a.oldLine : a.newLine;
      const end = a.side === "old" ? a.oldLineEnd : a.newLineEnd;
      return (a.file || "") + "#L" + (end && end > ln ? ln + "-" + end : (ln || "?")) + " [" + sevLabel(a.severity) + "] " + (a.text || "") + (a.author === "ai" ? "（AI）" : "");
    });
    const repoName = task ? (task.repo.split("/").slice(-2).join("/") || task.repo) : "";
    const rangeLabel = task && task.ref2 ? ((task.base || "HEAD") + " → " + task.ref2) : task && task.base ? ("工作区 vs " + task.base) : "未提交变更";
    // 增删行统计（勾选文件，从 diff hunks 累计；无 diff 数据时退化为文件数）
    let adds2 = 0, dels2 = 0;
    if (diff && diff.hunks) for (const hk of diff.hunks) for (const sg of (hk.segments || [])) { if (sg.type === "add") adds2++; else if (sg.type === "del") dels2++; }
    const markKeys = Object.keys(rolledBack);
    return [
      "# 审核结论 " + repoName + "（" + rangeLabel + "）",
      "## 变更概览（文件数 " + files.filter((f) => f.selected).length + " / +" + adds2 + "/-" + dels2 + " / 标注 " + annos.length + (markKeys.length ? " / 回滚标记 " + markKeys.length : "") + "）",
      "",
      ...lines,
      ...(markKeys.length ? ["", "## 回滚标记（" + markKeys.length + " 个文件；状态以服务端汇总为准）", ...markKeys.map((f) => "↩ " + f + "（" + (rolledBack[f].length === 0 ? "整文件" : rolledBack[f].length + " 块") + "）[待执行]")] : []),
      "",
      "## 整体结论",
      "（用户未补充整体结论）",
    ].join("\n");
  }
  function saveSummary(txt: string) {
    setSummary(txt);
    api("/save", { method: "POST", ...jsonBody({ taskId: task.id, summary: txt }) }).catch(() => {});
  }

  // 两按钮
  async function beforeSendRoll() {
    if (!rollExecProgram || !isTrace) return "";
    if (Object.keys(marksRef.current).length === 0) return "";
    const r = await executeRollMarks();
    return (r.done || r.failed) ? "\n\n【程序回滚结果】成功 " + r.done + " 个，失败 " + r.failed + " 个（详见回滚标记区状态）" : "";
  }
  function sendCurrent() {
    void (async () => {
      const note = await beforeSendRoll();
      const txt = (summary || genSummary()) + note;
      try { getCtx().sendChatMessage(txt, "steer"); } catch (e) { void uiAlert({ message: "发送失败: " + e, kind: "error" }); }
    })();
  }
  function sendNew() {
    void (async () => {
      const note = await beforeSendRoll();
      const txt = (summary || genSummary()) + note;
      setBusy(true);
    const origin = location.origin;
    const basePath = basePathOf();
    api("/launch-session", { method: "POST", ...jsonBody({ taskId: task.id, origin, basePath, summary: txt }) }).then((r) => r.json()).then((d) => {
      setBusy(false);
      if (d.ok && d.sessionId) {
        const sid = d.sessionId;
        try {
          if ((window as any).__aitiSelectSession) (window as any).__aitiSelectSession(sid);
          else { window.location.href = origin + basePath + "/?session=" + sid; }
        } catch { window.location.href = origin + basePath + "/?session=" + sid; }
      } else { setErr((d && d.error) || "开启新会话失败"); }
    }).catch((e) => { setBusy(false); setErr(String(e)); });
    })();
  }

  // 导航
  function navigate(delta: number) {
    if (hunks.length === 0) return;
    setPanelTab("anno"); // 导航后右侧标注视图跟随当前块
    setAnnoStop(0); // 块级导航落第 0 站；块内标注站由 advance 逐站推进
    let idx = hunkIdx + delta;
    if (idx < 0) {
      const prevFile = prevChangedFile();
      if (prevFile) { landLastRef.current = true; setCurFile(prevFile); return; } // 跨文件回退：落上一文件最后一块最后一站
      idx = 0;
    }
    if (idx >= hunks.length) {
      const nextFile = nextChangedFile();
      if (nextFile) { setCurFile(nextFile); return; }
      idx = hunks.length - 1;
    }
    setHunkIdx(idx);
    const hk = hunks[idx];
    const line = hk ? hk.newStart : 1;
    const ed = (containerRef.current as any) && (containerRef.current as any)._aitiGrEd;
    try { ed && ed.revealPositionInCenter ? ed.revealPositionInCenter({ lineNumber: Math.max(1, line), column: 1 }, true) : null; } catch {}
  }
  // 流水线推进（⏭/⏮/回车）：当前块内还有标注站就先走完，走完再跨块
  function advance(delta: number) {
    if (hunks.length === 0) return;
    const curHk = hunks[Math.min(hunkIdx, hunks.length - 1)];
    const stops = buildStops(curHk, fileAnnos);
    const idx = annoStop + delta;
    if (idx >= 0 && idx < stops.length) { setAnnoStop(idx); return; }
    const target = hunkIdx + delta;
    navigate(delta); // 跨块/跨文件（内部落第 0 站）
    if (delta < 0 && target >= 0 && target < hunks.length) {
      const backStops = buildStops(hunks[target], fileAnnos);
      if (backStops.length) setAnnoStop(backStops.length - 1);
    }
  }
  // 大纲：直接跳到指定 hunk（reveal 到 hunk 行内中间）
  function jumpToHunk(hk: any) {
    if (!hk) return;
    const line = hk.newStart || 1;
    const ed = (containerRef.current as any) && (containerRef.current as any)._aitiGrEd;
    try { ed && ed.revealPositionInCenter ? ed.revealPositionInCenter({ lineNumber: Math.max(1, line), column: 1 }, true) : null; } catch {}
  }
  // ── 键盘快捷键（M4）：▸ F7/Shift+F7 上下条 diff 变更；▸ Alt+↑/↓ 跨文件导航；▸ Esc 关闭标注气泡 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setComposing(null); return; }
      // F7 / Shift+F7（VS Code 惯例：diff 上/下一条）
      if (e.key === "F7") { e.preventDefault(); navigate(e.shiftKey ? -1 : 1); return; }
      // Alt+↓ / Alt+↑（跨文件上/下一条）
      if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); navigate(1); return; }
      if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); navigate(-1); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [diff, view, hunks, hunkIdx, files, curFile]);
  function prevChangedFile(dir?: string): string | null {
    const list = files.filter((f) => f.selected);
    if (list.length === 0) return null;
    const i = list.findIndex((f) => f.path === curFile);
    if (i < 0) return list[0].path;
    if (dir === "next") return i + 1 < list.length ? list[i + 1].path : null;
    return i - 1 >= 0 ? list[i - 1].path : null;
  }
  function nextChangedFile() { return prevChangedFile("next"); }
  function toggleFile(p: string) {
    // 勾选即持久化：同步到任务 JSON（服务端汇总/AI 工具都按 selected 过滤）——不再是本地态
    setFiles((fs) => {
      const next = fs.map((f) => (f.path === p ? { ...f, selected: !f.selected } : f));
      if (task) api("/save", { method: "POST", ...jsonBody({ taskId: task.id, files: next }) }).catch(() => {});
      return next;
    });
  }

  // 未解决标注（tab 计数 + 变更内容行下展示）
  const allAnnos = annotations.filter((a) => !a.resolved);

  if (busy) return <div style={overlay}><div style={{ color: "var(--text)" }}>正在打开审核任务…</div></div>;
  if (err) return <div style={overlay}><div style={{ position: "relative", color: "var(--danger, #f87171)", maxWidth: 420, padding: "10px 36px 10px 12px", borderRadius: 8, background: "var(--bg-panel)", border: "1px solid var(--border)" }}>{"❌ " + err}<button onClick={onClose} aria-label="关闭" title="关闭" style={{ position: "absolute", top: 6, right: 6, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button></div></div>;

  const hi = hunks.length ? Math.min(hunkIdx, hunks.length - 1) : 0;

  return (
    <div style={overlay}>
      {/* 顶栏（两簇布局，窄屏自适应）：左簇=标题/标识/块导航（flex:1 可收缩，标题省略号兜底）；
          右簇=工具（flexShrink:0 不收缩）。宽度够时单行（同旧版）；放不下时右簇整簇折到第二行右侧
          （flexWrap 换行工具条，同模型向导做法）——✕ 关闭在右簇簇尾，任何宽度都可见，不再被挤出视口 */}
      <div style={{ ...topBar, ...(isMobile ? { padding: "6px 8px", gap: "4px 6px" } : {}) }}>
        {/* minWidth 下限（标识+导航的最小宽度）：换行判定用它——窄屏时右簇整簇折行，而不是把左簇挤癌/裁剪；
            标题在簇内自有 minWidth:0 可缩到省略号，故下限不含标题 */}
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 4 : 6, flex: 1, minWidth: isMobile ? 250 : 400, overflow: "hidden" }}>
        <span title={task ? task.repo : ""} style={{ fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1, minWidth: 0 }}>
          {"👁️ " + (task ? lastSeg(task.repo) : "审核") + (task && task.scope && task.scope.path ? " / " + lastSeg(task.scope.path) : "")}
        </span>
        {/* 版本对比标识：两版本（base→ref2）/ 指定基线（⇋base） */}
        {task && (task.ref2 || task.base) && (
          <span
            title={task.ref2 ? (task.base || "HEAD") + " → " + task.ref2 : "工作区 vs " + task.base}
            style={{ fontFamily: MONO, fontSize: 10, color: "#7c3aed", border: "1px solid rgba(124,58,237,.35)", borderRadius: 4, padding: "1px 5px", flexShrink: 0, maxWidth: isMobile ? 96 : 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {task.ref2 ? ((task.base || "HEAD") + "→" + task.ref2) : ("⇋" + task.base)}
          </span>
        )}
        {/* trace 任务源标识（§6.3）：审的是 aiti-git-trace 编外仓 op 区间 */}
        {isTrace && (
          <span title="AI 变更追踪（aiti-git-trace 编外仓 op 区间）" style={{ fontSize: 10, color: "#0d9488", border: "1px solid rgba(13,148,136,.4)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>
            {isMobile ? "AI" : "AI 变更"}
          </span>
        )}
        {/* 导航（核心操作，紧跟标题；chevron 线稿图标，与 dock 图标规范一致） */}
        <button onClick={() => navigate(-1)} title={t("gr.nav.prev")} aria-label={t("gr.nav.prev")} style={{ ...segBtn, padding: "3px 9px", display: "inline-flex", alignItems: "center" }}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{(hunks.length ? hunkIdx + 1 : 0) + "/" + hunks.length}</span>
        <button onClick={() => navigate(1)} title={t("gr.nav.next")} aria-label={t("gr.nav.next")} style={{ ...segBtn, padding: "3px 9px", display: "inline-flex", alignItems: "center" }}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
        </button>
        </div>
        {/* 右簇：小屏三区切换/视图/加注/视口开关/列表/关闭（不收缩；窄屏整簇折到第二行右侧，簇内 flexWrap 极窄兑底） */}
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 4 : 6, flexWrap: "wrap", justifyContent: "flex-end", flexShrink: 0, marginLeft: "auto", rowGap: 4 }}>
        {/* 小屏：三区切换（files/diff/panel）下拉版 */}
        {isMobile && (
          <select
            value={mobilePane}
            onChange={(e) => setMobilePane(e.target.value)}
            title="小屏三区切换：文件清单 / 变更视图 / 标注汇总"
            style={{ ...segBtn, fontSize: 11, padding: "3px 4px", height: 26, color: "var(--text,#333)", background: "var(--bg,#fff)" }}
          >
            <option key="files" value="files">文件</option>
            <option key="diff" value="diff">视图</option>
            <option key="panel" value="panel">标注</option>
          </select>
        )}
        {/* diff 视图下拉（并排/合并/纯新/大纲）——只作用于中间视口 */}
        {(isMobile ? mobilePane === "diff" : showDiff) && (
          <select
            value={view}
            onChange={(e) => { setViewUser(e.target.value); saveLayoutManual({ view: e.target.value }); }}
            title={t("gr.view.mode")}
            style={{ ...segBtn, fontSize: isMobile ? 11 : 12, padding: "3px 4px", height: 26, color: "var(--text,#333)", background: "var(--bg,#fff)" }}
          >
            <option key="side" value="side">并排</option>
            <option key="inline" value="inline">合并</option>
            <option key="current" value="current">纯新</option>
            <option key="outline" value="outline">大纲</option>
          </select>
        )}
        {/* ↩ 标记回滚（trace 专属）：点击=标记/取消标记（不执行）；提交时按开关执行或打包给 AI */}
        {isTrace && (
          <button
            onClick={askRollbackSelection}
            disabled={!rbSel || rbSel.end < rbSel.start}
            style={{ ...segBtn, fontSize: 12, padding: "3px 8px", color: "#b45309", borderColor: "rgba(180,83,9,.5)", ...(!rbSel ? { opacity: 0.45 } : {}) }}
            title={rbSel
              ? "标记/取消标记选中改动（选区 " + rbSel.start + "-" + rbSel.end + (rbSel.side === "old" ? " old" : " new") + " 侧）——仅标记不执行；提交时统一处理"
              : "先在 diff 里选中至少一行，再标记回滚（trace 任务专属）"}
          >{(isMobile ? "↩" : "↩ 标记回滚")}</button>
        )}
        {isTrace && Object.keys(rolledBack).length > 0 && (
          <span style={{ ...segBtn, fontSize: 11, padding: "3px 8px", color: "#fff", background: "#b45309", borderColor: "#b45309", cursor: "default" }}
            title="已标记待回滚的文件数（文件清单 ↩ / 汇总回滚标记区可取消）">↩ {Object.keys(rolledBack).length}</span>
        )}
        {/* ✍ 加注模式（点行加注；触屏唯一入口） */}
        <button
          onClick={() => setAnnoMode((v0) => !v0)}
          style={{ ...segBtn, ...(annoMode ? { background: "var(--warn, #f59e0b)", borderColor: "var(--warn, #f59e0b)", color: "#fff" } : {}), fontSize: 13, padding: "3px 8px" }}
          title={annoMode ? "加注模式已开：点击 diff 行加注（点此关闭）" : "加注模式：点击 diff 行加注（触屏用；桌面也可右键）"}
        >✍</button>
        {/* 视口开关（桌面）：高亮 = 显示中；隐藏时其余区域占满 */}
        {!isMobile && (
          <button
            onClick={() => { const v = !showDiffRef.current; setShowDiff(v); saveLayoutManual({ showDiff: v }); }}
            style={{ ...segBtn, ...(showDiff ? segOn : {}), fontSize: 13, padding: "3px 8px" }}
            title={showDiff ? "隐藏中间 diff 视口（右侧面板自动占满）" : "显示中间 diff 视口"}
          >◫</button>
        )}
        {!isMobile && (
          <button
            onClick={() => { const v = !showFilesRef.current; setShowFiles(v); saveLayoutManual({ showFiles: v }); }}
            style={{ ...segBtn, ...(showFiles ? segOn : {}), fontSize: 13, padding: "3px 8px" }}
            title={showFiles ? "隐藏文件列表" : "显示文件列表"}
          >▤</button>
        )}
        {!isMobile && (
          <button
            onClick={() => { const v = !showPanelRef.current; setShowPanel(v); saveLayoutManual({ showPanel: v }); }}
            style={{ ...segBtn, ...(showPanel ? segOn : {}), fontSize: 13, padding: "3px 8px" }}
            title={showPanel ? "隐藏标注/汇总面板" : "显示标注/汇总面板"}
          >☰</button>
        )}
        {/* 📤 提交：确保标注/汇总面板打开并切到汇总页——一步到位进入总结视图，编辑后发送/复制 */}
        <button
          onClick={() => {
            if (isMobile) setMobilePane("panel");
            else if (!showPanelRef.current) { setShowPanel(true); saveLayoutManual({ showPanel: true }); }
            setPanelTab("summary");
          }}
          style={{ ...segBtn, fontSize: 12, padding: "3px 9px", color: "#fff", background: "#16a34a", borderColor: "#16a34a" }}
          title="打开标注/汇总面板并切到汇总页：核对汇总内容 → 📨 添加到当前会话 / 🚀 开启新会话 / 📋 复制"
        >{isMobile ? "📤" : "提交"}</button>
        {/* ☰ 列表：返回任务选择器（切任务/新建） */}
        <button onClick={() => { try { onExitToList && onExitToList(); } catch {} }} style={{ ...segBtn, fontSize: 13, padding: "3px 8px" }} title="返回任务列表（新建/切换任务；当前任务已保存）">{isMobile ? "☰" : "列表"}</button>
        <button onClick={onClose} style={{ ...segBtn, color: "var(--danger, #f87171)", fontSize: 13, padding: "3px 8px" }} title="关闭">✕</button>
        </div>
      </div>

      <div style={{ ...bodyRow, flexDirection: isMobile ? ("column" as const) : ("row" as const) }}>
        {/* 左：文件清单 */}
        <div
          style={{
            ...fileList,
            ...(isMobile ? { borderRight: "none", borderBottom: "1px solid var(--border,#e0e0e0)" } : {}),
            display: (isMobile ? mobilePane === "files" : showFiles) ? "flex" : "none",
            width: isMobile ? "100%" : 240,
            flex: isMobile ? 1 : undefined,
            minHeight: isMobile ? 0 : undefined,
          }}
        >
          <div style={{ padding: "6px 10px", fontSize: 11, fontWeight: 600, color: "var(--text-dim,#888)" }}>{"变更文件 (" + files.length + ")"}</div>
          {files.map((f) => {
            const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) + "/" : "";
            const base = lastSeg(f.path);
            return (
              <div
                key={f.path}
                onClick={() => { setCurFile(f.path); }}
                style={{ ...fileRow, ...(f.path === curFile ? { background: "var(--bg-selected,#eef3ff)" } : {}) }}
                title={f.path}
              >
                <input type="checkbox" checked={!!f.selected} onClick={(e) => e.stopPropagation()} onChange={() => toggleFile(f.path)} style={{ margin: 0, flexShrink: 0 }} title="选中参与导航/汇总（取消可跳过此文件）" />
                <span style={{ color: statusColor(f.status), fontWeight: 700, width: 12, flexShrink: 0, fontSize: 11 }}>{statusIcon(f.status)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1, color: "var(--text,#222)", fontFamily: MONO, fontSize: 11.5, fontWeight: 600 }}>{base}</span>
                {isTrace && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleRollMark([{ file: f.path, hunkIdx: [] }]); }}
                    title={rolledBack[f.path] ? "已标记回滚（点击取消标记）" : "标记回滚此文件全部变更（仅标记；提交时统一执行）"}
                    style={{ ...miniBtn, flexShrink: 0, fontSize: 12, ...(rolledBack[f.path] ? { background: "#b45309", borderColor: "#b45309", color: "#fff" } : { color: "#b45309" }) }}
                  >↩</button>
                )}
                {dir && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 999, color: "var(--text-dim,#999)", fontFamily: MONO, fontSize: 10 }}>{dir}</span>}
              </div>
            );
          })}
        </div>

        {/* 中：diff 视口 */}
        <div style={{ flex: 1, position: "relative", minWidth: 0, display: (isMobile ? mobilePane === "diff" : showDiff) ? "block" : "none" }}>
          <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
          {!diff && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted,#888)", fontSize: 13 }}>
              {curFile ? "加载 diff…" : "选择左侧文件查看变更"}
            </div>
          )}
          {diff && !edReady && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted,#888)", fontSize: 13, background: "var(--bg,#fff)", zIndex: 10 }}>
              正在加载编辑器…（首次稍慢）
            </div>
          )}
          {hunks.length === 0 && diff && (
            <div style={{ position: "absolute", top: 8, right: 8, color: "var(--warn, #f59e0b)", fontSize: 11, background: "var(--bg,#fff)", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--border)" }}>
              无变更行（纯新/删除文件）
            </div>
          )}
          {view === "outline" && diff && (
            <div style={{ position: "absolute", top: 6, left: 6, bottom: 6, width: 240, overflowY: "auto", background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,.12)", zIndex: 20, padding: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim,#888)", padding: "4px 6px" }}>
                {"大纲 · " + hunks.length + " 个变更区"}
              </div>
              {hunks.length === 0 && <div style={{ color: "var(--text-muted,#999)", fontSize: 12, padding: 8 }}>纯新增/删除文件无 hunk（整文件变更）</div>}
              {hunks.map((hk, i) => (
                <div
                  key={i}
                  onClick={() => { setHunkIdx(i); setAnnoStop(0); jumpToHunk(hk); }}
                  style={{
                    padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontFamily: MONO,
                    color: i === hunkIdx ? "var(--accent,#2563eb)" : "var(--text,#333)",
                    background: i === hunkIdx ? "var(--bg-selected,#eef3ff)" : "transparent", marginBottom: 2,
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{"@@ +" + hk.newStart + "," + (hk.newLines || 0) + " @@"}</div>
                  {hunks[i] && hk.header && (
                    <div style={{ color: "var(--text-dim,#888)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {String(hk.header || "").trim().replace(/^func.*/, "")}
                    </div>
                  )}
                  <div style={{ color: "var(--text-dim,#888)", fontSize: 10 }}>
                    {(hk.segments && hk.segments.filter((s: any) => s.type === "add").length) + "+ / " + ((hk.segments && hk.segments.filter((s: any) => s.type === "del").length)) + "-"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右：标注/汇总面板 */}
        <div
          style={{
            ...panel,
            display: (isMobile ? mobilePane === "panel" : showPanel) ? "flex" : "none",
            width: (isMobile || !showDiff) ? "100%" : 320,
            flex: (isMobile || !showDiff) ? 1 : undefined,
            minHeight: (isMobile || !showDiff) ? 0 : undefined,
          }}
        >
          <div style={{ display: "flex", gap: 4, padding: "0 0 8px", borderBottom: "1px solid var(--border,#eee)", marginBottom: 8, flexWrap: "wrap" }}>
            {[["anno", t("gr.tabs.anno") + " (" + allAnnos.length + ")"], ["all", t("gr.tabs.all")], ["summary", t("gr.tabs.summary")]].map(([k, label]) => (
              <button key={k} onClick={() => setPanelTab(k)} style={{ ...segBtn, ...(panelTab === k ? segOn : {}), fontSize: 11, padding: "3px 8px" }}>{label}</button>
            ))}
          </div>

          {panelTab === "anno" && (() => {
            const curHunk = hunks[hi] || null;
            if (!curHunk) return <div style={{ color: "var(--text-muted,#999)", fontSize: 12, padding: 8 }}>无变更区（二进制/空文件）</div>;
            const segs = curHunk.segments || [];
            // 站点列表：第 0 站=块默认标注位，之后=块内已有标注按行序
            const stops = buildStops(curHunk, fileAnnos);
            const sIdx = stops.length ? Math.min(Math.max(annoStop, 0), stops.length - 1) : 0;
            const stop = stops[sIdx] || { side: null, line: null, lineEnd: null, anno: null };
            const unresolvedN = fileAnnos.filter((a) => !a.resolved).length;
            const newEnd = curHunk.newStart + Math.max(0, curHunk.newLines - 1);
            // 变更内容：只显示变更行 ±3 上下文（大块裁剪，小块全量）
            const isChg = (s: any) => s.type === "add" || s.type === "del";
            const CUT = 3;
            let show: boolean[] = segs.map(() => true);
            if (segs.length > 24) {
              show = segs.map(() => false);
              segs.forEach((s: any, i: number) => { if (isChg(s)) { for (let j = i - CUT; j <= i + CUT; j++) if (j >= 0 && j < segs.length) show[j] = true; } });
            }
            const nodes: any[] = [];
            segs.forEach((s: any, i: number) => {
              if (!show[i]) return;
              if (i > 0 && !show[i - 1]) nodes.push(<div key={"e" + i} style={{ padding: "0 2px", color: "var(--text-dim,#888)", userSelect: "none", textAlign: "center" }}>⋯</div>);
              const isDel = s.type === "del", isAdd = s.type === "add";
              const side = isDel ? "old" : "new";
              const line = isDel ? s.oldLine : s.newLine;
              const annosHere = line ? fileAnnos.filter((a) => !a.resolved && a.side === side && (side === "old" ? a.oldLine === line : a.newLine === line)) : [];
              nodes.push(
                <div key={"r" + i} style={{ display: "flex", alignItems: "flex-start", gap: 5, padding: "1px 4px 1px 6px", background: isAdd ? "color-mix(in srgb, var(--ok, #4ade80) 9%, transparent)" : isDel ? "color-mix(in srgb, var(--danger, #f87171) 9%, transparent)" : "transparent" }}>
                  <span style={{ width: 26, flexShrink: 0, textAlign: "right", color: "var(--text-dim,#888)", userSelect: "none" }}>{line || ""}</span>
                  <span style={{ width: 8, flexShrink: 0, color: isAdd ? "var(--ok, #4ade80)" : isDel ? "var(--danger, #f87171)" : "var(--text-dim,#888)", fontWeight: 700, userSelect: "none" }}>{isAdd ? "+" : isDel ? "−" : " "}</span>
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text,#333)" }}>{s.text == null ? "" : String(s.text)}</span>
                </div>
              );
              // 已有标注：行下小字（severity 色条 + 内容）
              for (const a of annosHere) nodes.push(
                <div
                  key={"a" + i + "-" + a.id}
                  style={{ padding: "1px 6px 3px 40px", fontSize: 10.5, lineHeight: 1.4, color: "var(--text,#444)", borderLeft: "3px solid " + sevColor(a.severity), background: "rgba(255,200,0,.05)", wordBreak: "break-word", whiteSpace: "pre-wrap", marginBottom: 2 }}
                >
                  <span style={{ color: sevColor(a.severity), fontWeight: 700, marginRight: 4 }}>
                    {(() => { const st = a.side === "old" ? a.oldLine : a.newLine; const en = a.side === "old" ? a.oldLineEnd : a.newLineEnd; return "L" + st + (typeof en === "number" && en > st ? "-" + en : "") + " " + sevLabel(a.severity) + (a.author === "ai" ? "·AI" : ""); })()}
                  </span>
                  {a.text}
                </div>
              );
            });
            return (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                {/* 顶部固定：当前块信息 + 流水线标注表单（站化：编辑/新建） */}
                <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border,#eee)", paddingBottom: 8, marginBottom: 4 }}>
                  <div title={curFile} style={{ fontSize: 10.5, color: "var(--text-dim,#888)", display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                    <span style={{ color: "var(--accent,#2563eb)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lastSeg(curFile)}</span>
                    <span style={{ flexShrink: 0, fontSize: 10, color: "#d97706", background: "rgba(217,119,6,.12)", borderRadius: 4, padding: "0 4px" }} title={"本文件共 " + fileAnnos.length + " 条标注（未解决 " + unresolvedN + "）"}>
                      {fileAnnos.length ? fileAnnos.length + " 标注" : ""}
                    </span>
                    <span style={{ flexShrink: 0 }}>{"L" + curHunk.newStart + "-" + newEnd}</span>
                    <span style={{ flex: 1, textAlign: "right" }}>{(hi + 1) + "/" + hunks.length + (stops.length > 1 ? " · 站" + (sIdx + 1) + "/" + stops.length : "")}</span>
                  </div>
                  <AnnoForm
                    key={curFile + ":" + hi + ":" + sIdx + ":" + (stop.anno ? stop.anno.id : "new")}
                    side={stop.side} line={stop.line} lineEnd={stop.lineEnd}
                    editing={stop.anno || null} sev={annoSev} setSev={setAnnoSev}
                    onSubmitDone={(sev, text) => { addAnnoAt(curFile, stop.side, stop.line, sev, text, stop.lineEnd); }}
                    onUpdateDone={(anno, sev, text) => { updateAnnotation(anno.id, { severity: sev, text }); }}
                    onNext={() => { advance(1); }}
                    onPrev={() => { advance(-1); }}
                  />
                </div>
                {/* 下方滚动：当前块变更内容 */}
                <div style={{ flex: 1, overflowY: "auto", minHeight: 0, fontFamily: MONO, fontSize: 11, lineHeight: 1.45 }}>{nodes}</div>
              </div>
            );
          })()}

          {panelTab === "all" && (() => {
            // 全部标注列表（时间序）：跳转 / 解决 / 删除
            return (
              <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
                {allAnnos.length === 0 && <div style={{ color: "var(--text-muted,#999)", fontSize: 12, padding: 8 }}>暂无标注</div>}
                {allAnnos.map((a) => {
                  const ln = a.side === "old" ? a.oldLine : a.newLine;
                  const end = a.side === "old" ? a.oldLineEnd : a.newLineEnd;
                  return (
                    <div key={a.id} style={{ ...allRow, opacity: a.resolved ? 0.45 : 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => jumpTo(a)} title="跳到该标注所在变更块">
                        <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--accent,#2563eb)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{lastSeg(a.file || "")}</span>
                        <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--text-dim,#888)", flexShrink: 0 }}>
                          {"L" + (ln || "?") + (end && end > ln ? "-" + end : "") + (a.side === "old" ? "旧" : "")}
                        </span>
                        {a.stale && <span style={{ color: "var(--warn, #f59e0b)", fontSize: 10, border: "1px solid var(--warn, #f59e0b)", borderRadius: 4, padding: "0 3px", flexShrink: 0 }} title="原文已删/行号已漂移，未找到适配行">漂移</span>}
                        <span style={{ flex: 1 }} />
                        <span style={{ color: sevColor(a.severity), fontSize: 10, border: "1px solid " + sevColor(a.severity), borderRadius: 4, padding: "0 4px", flexShrink: 0 }}>
                          {sevLabel(a.severity) + (a.author === "ai" ? "·AI" : "")}
                        </span>
                      </div>
                      <div style={{ color: "var(--text,#333)", fontSize: 12, lineHeight: 1.5, marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{a.text}</div>
                      <div style={{ display: "flex", gap: 4, marginTop: 3 }}>
                        {!a.resolved && <button onClick={() => updateAnnotation(a.id, { resolved: true })} style={miniBtn} title="标记解决">解决</button>}
                        <button onClick={() => deleteAnnotation(a.id)} style={{ ...miniBtn, color: "var(--danger, #f87171)" }} title="删除标注">删除</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {panelTab === "summary" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
              <textarea
                value={summary || genSummary()}
                onChange={(e) => setSummary(e.target.value)}
                onBlur={(e) => saveSummary(e.target.value)}
                style={{ flex: 1, resize: "none", font: "11.5px/1.6 ui-monospace, monospace", padding: 8, border: "1px solid var(--border,#ddd)", borderRadius: 8, background: "var(--bg,#fff)", color: "var(--text,#333)", outline: "none" }}
              />
              {isTrace && Object.keys(rolledBack).length > 0 && (
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "#b45309" }}
                  title="开启后：发送前先对工作区执行回滚标记（trace 逆 patch，先 safety 存档）；结果写入汇总——成功条目标「程序已执行✓」，失败条目明确标注原因，AI 不会重复操作">
                  <input type="checkbox" checked={rollExecProgram} onChange={(e) => setRollExecProgram(e.target.checked)} />
                  让程序尝试执行回滚标记（{Object.keys(rolledBack).length} 个文件）
                </label>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button onClick={sendCurrent} style={btnPrimary} title="把汇总发进当前会话预审">添加到当前会话</button>
                <button onClick={sendNew} style={btnPrimary} title="开启独立预审会话（自动跳转）">开启新会话</button>
                <button onClick={() => { const txt = summary || genSummary(); try { navigator.clipboard.writeText(txt); } catch {} }} style={segBtn} title="复制汇总">复制</button>
              </div>
              {/* 回滚标记清单（点击取消标记） */}
              {isTrace && Object.keys(rolledBack).length > 0 && (
                <div style={{ borderTop: "1px solid var(--border,#eee)", paddingTop: 6 }}>
                  <div style={{ fontSize: 10.5, color: "#b45309", marginBottom: 4 }}>↩ 回滚标记 · 点击取消</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {Object.entries(rolledBack).map(([f, hix]) => (
                      <button key={f} onClick={() => toggleRollMark([{ file: f, hunkIdx: hix }])}
                        title={f + "（点击取消标记）" + (rollResults[f] ? "｜" + rollResults[f].status + (rollResults[f].result ? "：" + rollResults[f].result : "") : "")}
                        style={{ ...segBtn, fontSize: 10.5, padding: "2px 7px", color: "#b45309", borderColor: "rgba(180,83,9,.5)" }}>
                        <span style={{ fontFamily: MONO }}>{lastSeg(f)}</span>
                        <span style={{ marginLeft: 4 }}>{hix.length === 0 ? "整文件" : hix.length + " 块"}{rollResults[f] ? (rollResults[f].status === "executed" ? "·已执行✓" : "·执行✗") : ""}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* 标注索引（点击跳回对应变更块） */}
              {allAnnos.length > 0 && (
                <div style={{ borderTop: "1px solid var(--border,#eee)", paddingTop: 6, minHeight: 0, overflowY: "auto" }}>
                  <div style={{ fontSize: 10.5, color: "var(--text-dim,#888)", marginBottom: 4 }}>标注索引 · 点击跳转</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {allAnnos.map((a) => {
                      const ln = a.side === "old" ? a.oldLine : a.newLine;
                      const end = a.side === "old" ? a.oldLineEnd : a.newLineEnd;
                      return (
                        <button
                          key={a.id}
                          onClick={() => jumpTo(a)}
                          title={(a.text || "") + "（点击跳到对应变更块）"}
                          style={{ ...segBtn, fontSize: 10.5, padding: "2px 7px", borderColor: sevColor(a.severity), color: "var(--text,#333)" }}
                        >
                          <span style={{ fontFamily: MONO }}>{lastSeg(a.file || "") + "·L" + (ln || "?") + (end && end > ln ? "-" + end : "")}</span>
                          <span style={{ color: sevColor(a.severity), fontWeight: 600, marginLeft: 4 }}>{sevLabel(a.severity) + (a.author === "ai" ? "·AI" : "")}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>


      {composing && (
        <ComposeBar
          line={composing.line} side={composing.side} file={curFile}
          onSubmit={addAnnotation} onCancel={() => setComposing(null)}
        />
      )}

      <div style={bottomBar}>
        {(annoMode ? "加注模式：点击 diff 行加注" : isMobile ? "点 ✍ 开加注模式 → 点行评论" : "右键行加注（或 ✍ 加注模式）")
          + "（必须/建议/疑问） · 标注自动保存 · " + annotations.length + " 条标注"}
      </div>
    </div>
  );
}

// 流水线标注表单（右侧顶部固定，站化）：severity 3 选 + 输入框；确定 ⏭ = 提交并下一站（回车默认）；⏮ = 提交并上一站。
// editing 非空 = 站上带已有标注：预填原文可直接修改，提交 = 修订原标注；留空提交 = 保持原样只过站
function AnnoForm({ side, line, lineEnd, sev, setSev, editing, onSubmitDone, onUpdateDone, onNext, onPrev }: {
  side: string | null;
  line: number | null;
  lineEnd: number | null;
  sev: string;
  setSev: (s: string) => void;
  editing: any;
  onSubmitDone: (sev: string, text: string) => void;
  onUpdateDone: (anno: any, sev: string, text: string) => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const [text, setText] = useState(editing ? String(editing.text || "") : "");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { taRef.current && taRef.current.focus(); }, []);
  // 自动增高：预填（挂载）/输入/粘贴都跟随内容撑开
  useEffect(() => { autoGrow(taRef.current, 300); }, [text]);
  const submit = (delta: number) => {
    if (!line) return;
    const v = text.trim();
    if (v) {
      if (editing && onUpdateDone) onUpdateDone(editing, sev, v); // 修订既有标注
      else onSubmitDone(sev, v); // 新建标注（落在本站位置）
    }
    setText("");
    // 有内容才提交；空 = 本站无新增/不动原文，直接过站
    if (delta === -1 && onPrev) onPrev(); else onNext();
  };
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11 }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
        {[["must", "必须"], ["suggest", "建议"], ["question", "疑问"]].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setSev(k)}
            style={{ ...segBtn, flex: 1, ...(sev === k ? { background: sevColor(k), borderColor: sevColor(k), color: "#fff" } : {}), padding: "2px 0", fontSize: 10.5 }}
          >{l}</button>
        ))}
      </div>
      {editing && (
        <div title="正在编辑已有标注：提交 = 修订原文（severity 一并保存，锚点行不变）；留空提交 = 保持原样直接过站" style={{ fontSize: 10, color: "var(--text-dim,#888)", marginBottom: 3, display: "flex", gap: 4, alignItems: "center" }}>
          <span>✎</span>
          <span style={{ color: sevColor(editing.severity), fontWeight: 600 }}>{(editing.author === "ai" ? "AI 标注" : "已有标注") + " L" + line + (lineEnd && lineEnd > line ? "-" + lineEnd : "")}</span>
          <span>可直接修改</span>
        </div>
      )}
      <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => { setText(e.target.value); autoGrow(e.target, 300); }}
          disabled={!line}
          placeholder={editing ? "修改这条标注…（Enter 保存并下一站）" : (line ? t("gr.anno.placeholder", { pos: (side === "old" ? "旧" : "新") + "行 " + line + (lineEnd && lineEnd > line ? "-" + lineEnd : "") }) : t("gr.anno.noLine"))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(1); }
          }}
          style={{ flex: 1, minHeight: 48, padding: "5px 6px", border: "1px solid var(--border,#ddd)", borderRadius: 6, fontSize: 11, fontFamily: "inherit", outline: "none", resize: "none", overflowY: "auto", background: "var(--bg,#fff)", color: "var(--text,#333)" }}
        />
        {/* ⏮ 提交并上一站：小号纯图标 */}
        <button onClick={() => submit(-1)} style={{ ...segBtn, padding: "4px 5px", fontSize: 12, lineHeight: 1 }} disabled={!line} title="提交并上一站（编辑站留空 = 保持原样直接上一站）">⏮</button>
        <button onClick={() => submit(1)} style={{ ...btnPrimary, padding: "4px 8px", fontSize: 11 }} disabled={!line} title={editing ? "修订标注并下一站（留空 = 保持原样直接过站）" : "提交标注并下一站（留空 = 本站无问题，直接过站）"}>{t("gr.anno.submit")}</button>
      </div>
    </div>
  );
}

// 标注输入气泡（Monaco 右键/✍模式用：根级 fixed 浮层，中间视口隐藏时仍可见）
function ComposeBar({ line, side, file, onSubmit, onCancel }: {
  line: number;
  side: string;
  file: string;
  onSubmit: (sev: string, text: string) => void;
  onCancel: () => void;
}) {
  const [sev, setSev] = useState("suggest");
  const [text, setText] = useState("");
  const cbTaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { autoGrow(cbTaRef.current, 300); }, [text]);
  return (
    <div
      style={{
        // fixed 浮层：左/中侧栏全关时仍可见，不随中间视口隐藏
        position: "fixed", top: 64, right: 16, zIndex: 130,
        width: 300, background: "var(--bg,#fff)", border: "1px solid var(--border,#d0d0d0)",
        borderRadius: 10, boxShadow: "0 8px 30px rgba(0,0,0,.18)", padding: 10, fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{"加注 @" + (side === "old" ? "旧" : "新") + "行 " + line + (file ? " · " + lastSeg(file) : "")}</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => onSubmit(sev, text)} style={{ ...miniBtn, color: "#4f8ef7", fontWeight: 600 }} title="提交">提交</button>
        <button onClick={onCancel} style={miniBtn} title="取消">✕</button>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {[["must", "必须"], ["suggest", "建议"], ["question", "疑问"]].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSev(k)}
            style={{ ...segBtn, flex: 1, ...(sev === k ? { background: sevColor(k), borderColor: sevColor(k), color: "#fff" } : {}), padding: "3px 0", textAlign: "center" }}
          >{label}</button>
        ))}
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => { setText(e.target.value); autoGrow(e.target, 300); }}
        ref={cbTaRef}
        placeholder="评论内容…（Enter 提交 / Esc 取消）"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(sev, text); }
          if (e.key === "Escape") onCancel();
        }}
        style={{ width: "100%", boxSizing: "border-box", minHeight: 60, padding: 6, border: "1px solid var(--border,#ddd)", borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none", resize: "none", overflowY: "auto" }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
        <button onClick={onCancel} style={segBtn} title="取消">取消</button>
        <button onClick={() => onSubmit(sev, text)} style={btnPrimary} title="提交标注" disabled={!text.trim()}>提交</button>
      </div>
    </div>
  );
}

// useAiPreStatus 当前未被 ReviewApp 直接消费（保留 hook：AI 预审状态后续接入点）
void useAiPreStatus;
