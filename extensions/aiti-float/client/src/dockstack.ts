/**
 * aiti-float · DockStack —— 左栏统一 dock 区块栈容器（sidebar 统一 dock 方案 §3.8）。
 *
 * 左栏（sidebarContent 接管态）= 本容器自上而下按序渲染区块：
 *   常驻区块（reserved，编排器经 props.blocks 传入：项目/文件夹×N）
 *   + 可停靠区块（dockable，slot items 经 props.dockSlot 读出：任务/停靠面板；
 *     gate 后并入——presentState 落在 docked:sidebar:* 族即入栈）。
 *
 * 容器职责（状态机管「在哪」、容器管「栈序」）：
 *   · 有效排序 = 用户改序（pi:sidebar-dock:order）∩ 在场键 → priority 稳定补尾
 *   · 折叠态 = pi:sidebar-dock:collapsed:<blockKey>（与 DockBody 头行同一事实源）
 *   · flex 纪律（float-dock-plan §4.4.3 通用化）：主内容（fill）平分剩余空间、
 *     次级限高、折叠只留头行
 *   · 上下移（v1）：SIDEBAR_MOVE_EVENT 请求在此落位（全栈键集只有容器知道）
 *
 * React 契约：本扩展产物零 react 引用——渲染原语（h）由 ctx 注入；hooks（useState/
 * useEffect）经 ctx 委托宿主真 hooks（本文件自绑定的 useBlockCollapsed/useDockOrder
 * 走同一通道，不用 _shared 的 react 版本）；状态读写/迁移/排序全在零 react 的
 * _shared/ext-float-dock-core.ts。经 ctx.registerExtService("aiti-float.dockstack", api)
 * 交付（扩展间通信一律走 ctx.services；编排器 session-manager 消费）。
 */
import {
  SIDEBAR_COLLAPSE_EVENT,
  SIDEBAR_DROP_EVENT,
  SIDEBAR_MOVE_EVENT,
  SIDEBAR_ORDER_EVENT,
  effectiveBlockOrder,
  isSidebarDockState,
  migrateLegacyCollapseKeys,
  moveBlockKey,
  moveBlockTo,
  readBlockCollapsed,
  readDockOrder,
  sidebarZoneOf,
  splitBlockAlign,
  writeBlockCollapsed,
  type BlockAlign,
} from "../../../_shared/ext-float-dock-core";
import { dockPref, presented, present, CHANGE_EVENT } from "./dock";

/** 区块描述（常驻区块；编排器构造）。 */
export interface DockBlockDef {
  /** 稳定区块键（折叠/排序记忆 key）。约定：projects / folder:<cwd> 等。 */
  key: string;
  title: string;
  /** 默认序（用户未改序时）：项目0→任务1→文件2→停靠3+。 */
  priority?: number;
  /** 对齐分组（v4 补录）：top=核心区块钉顶（项目/任务），bottom=次级钉底
   *  （文件夹/停靠面板/消息类）。props.blocks 缺省 top；dockable item 构造期缺省 bottom。 */
  align?: BlockAlign;
  /** @deprecated v5 单展开手风琴（展开即 grow）后不再消费；仅编排器回退态直排分支仍读。
   *  曾为主内容区块：平分剩余空间。 */
  fill?: boolean;
  /** @deprecated v5 起：展开即 grow 占满，百分比限高退役（嵌入面板高度策略在 face 层自身滚动）。 */
  maxHeightPct?: number;
  /** 计数徽标。 */
  count?: number;
  /** 多实例区块「移除本实例」。 */
  onRemove?: () => void;
  /** 内容工厂（返回宿主 React 元素）。 */
  render: () => unknown;
}

/** dockable 区块（slot item 进栈形态）：内容 = renderSlot(only) 保宿主错误边界。
 *  __staticItem：懒扩展的 manifest 静态条目（无 render/bundle）——渲染「静态壳」
 *  （展开/点击时才物化），见 StaticDockFace。 */
interface DockItemDef extends DockBlockDef {
  __dockItemId: string;
  __staticItem?: unknown;
}

/** slot items（dockable 区块）统一进栈的默认优先级（项目0→任务1→文件2→停靠3+）。 */
const DOCK_DEFAULT_PRIORITY = 3;

export function createDockStackApi(ctx: Record<string, any>) {
  const h = ctx.h as (...a: unknown[]) => unknown;
  const useState = ctx.useState as (init: any) => [any, (v: any) => void];
  const useEffect = ctx.useEffect as (fn: () => unknown, deps?: unknown[]) => unknown;

  /** 折叠态（ctx hooks 自绑定版）：localStorage 单一事实源 + 变更事件/跨 tab 订阅。 */
  function useBlockCollapsedCtx(blockKey: string): [boolean, (next: boolean) => void] {
    const [collapsed, setCollapsed] = useState<boolean>(() => readBlockCollapsed(blockKey));
    useEffect(() => {
      const sync = () => setCollapsed(readBlockCollapsed(blockKey));
      sync();
      window.addEventListener(SIDEBAR_COLLAPSE_EVENT, sync);
      window.addEventListener("storage", sync);
      return () => { window.removeEventListener(SIDEBAR_COLLAPSE_EVENT, sync); window.removeEventListener("storage", sync); };
    }, [blockKey]);
    return [collapsed, () => { /* 写入由 DockBody 头行负责（同一事实源 + 事件广播回灌本 hook） */ }];
  }

  /** 排序持久化：readDockOrder + 变更事件/跨 tab 订阅。 */
  function useDockOrderCtx(): string[] {
    const [order, setOrder] = useState<string[]>(() => readDockOrder());
    useEffect(() => {
      const sync = () => setOrder(readDockOrder());
      sync();
      window.addEventListener(SIDEBAR_ORDER_EVENT, sync);
      window.addEventListener("storage", sync);
      return () => { window.removeEventListener(SIDEBAR_ORDER_EVENT, sync); window.removeEventListener("storage", sync); };
    }, []);
    return order;
  }

  /** [开页方案 §1 F4，2026-09-12] 静态条目区块壳：懒扩展的 sidebarExplorerDock 声明
   *  （manifest 静态条目，无 bundle）先占位渲染，用户**展开或点击**时才 ensureMaterialized
   *  → 注册条目同 key 覆盖静态条目 → 真 face（自带 DockBody 头行）无缝接管。
   *  目的：session-manager 侧栏不再需要在挂载时 ensureMaterialized 拉起
   *  aiti-subagents / aiti-ai-schedule（二者合计 ~200KB 解码）；区块默认折叠 → 开页零请求。 */
  function StaticDockFace(props: { item: Record<string, any>; shell?: any }) {
    const item = props.item;
    const blockKey = String(item.id);
    const title = String(item.meta?.title ?? item.meta?.label ?? item.extId ?? item.id);
    const collapsed = useBlockCollapsedCtx(blockKey)[0];
    const [phase, setPhase] = useState<string>("idle");
    const load = () => {
      if (!ctx.ensureMaterialized) return;
      setPhase((p: string) => (p === "idle" ? "loading" : p));
      Promise.resolve(ctx.ensureMaterialized(item.extId)).catch(() => {}).then(() => setPhase("done"));
    };
    useEffect(() => { if (!collapsed) load(); }, [collapsed]);
    // 与真 face 同款头行（编排器经 staticShell 注入自己 bundle 的 DockBody）：
    // 折叠态即标准头行（箭头+标题+⇱ detach+⋮ 区块操作），零简易占位字样；
    // 仍然不预加载——展开才 ensureMaterialized（children 只给加载提示占位）。
    if (props.shell) {
      const zones = [sidebarZoneOf(blockKey)];
      return h(props.shell, {
        itemKey: blockKey,
        blockKey,
        title,
        chrome: "section",
        kind: "dockable",
        zones,
        defaultZone: sidebarZoneOf(blockKey),
        children: h("div", { style: { padding: "10px 12px", fontSize: 12, color: "var(--text-dim, #888)" } },
          phase === "loading" ? "正在加载扩展…" : ""),
      });
    }
    return h("div",
      { "data-ext-dock-static": blockKey, style: { display: "flex", flexDirection: "column", minHeight: 0 } },
      h("div",
        {
          onClick: () => writeBlockCollapsed(blockKey, !collapsed),
          style: { display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", cursor: "pointer", userSelect: "none", fontSize: 12, color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" },
        },
        h("span", { style: { transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.12s", fontSize: 10 } }, "▼"),
        h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, title),
        h("span", { style: { opacity: 0.75, fontSize: 11, textTransform: "none", letterSpacing: 0 } }, collapsed ? "点击加载" : (phase === "loading" ? "加载中…" : "")),
      ),
      collapsed ? null : h("div", { style: { padding: "2px 12px 10px", fontSize: 12, color: "var(--text-dim, #888)", textTransform: "none" } }, phase === "loading" ? "正在加载扩展…" : ""),
    );
  }

  /** 单个栈格：折叠态（决定 flex）+ 内容。dockable item 的头行由其自带 DockBody
   *  渲染（_shared 同源升级，全位置一套头行）；reserved 区块内容自带 DockBody
   *  （编排器经 render 给出，chrome="section" kind="reserved"）。 */
  function StackCell(props: { block: DockBlockDef; dockItemId?: string; slotName?: string; slotExtra?: Record<string, unknown>; staticItem?: any; staticShell?: any }) {
    const { block } = props;
    const collapsed = useBlockCollapsedCtx(block.key)[0];
    const expanded = !collapsed;
    // flex 纪律（v5 单展开手风琴）：折叠只留头（0 0 auto）；展开即 grow（1 1 0）——吃掉栈内
    // 全部空白「占满整个」（用户拍板 2026-09-16：对齐只决定折叠态空白的**位置**，不切分
    // 空间；展开者不困在自己对齐段里）。height 链由此确定（cell grow → DockBody 100% →
    // 体 flex:1），嵌入内容内部滚动真正生效；minHeight 保底防 basis 0 被压扁。
    // maxHeightPct 百分比限高随之退役（grow 后无意义）。
    const style: Record<string, unknown> = {
      display: "flex", flexDirection: "column",
      flex: expanded ? "1 1 0" : "0 0 auto",
      minHeight: expanded ? 96 : 0,
      overflow: "hidden",
    };
    return h("div", { "data-ext-dock-cell": block.key, style },
      props.dockItemId
        ? // dockable：item 自带头行（DockBody section）；宿主 ExtSlot 渲染保错误边界+身份标注。
          // 静态条目（懒扩展，无 render）→ 渲染静态壳，展开时物化后真 face 接管。
          h("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" } },
            props.staticItem
              ? h(StaticDockFace, { item: props.staticItem, shell: props.staticShell })
              : (ctx.renderSlot as (n: string, p?: any) => unknown)(props.slotName ?? "sidebarExplorerDock", { only: props.dockItemId, extra: props.slotExtra }))
        : block.render(),
    );
  }

  /** 常驻自动入栈（once-per-mount）：dockpref 已是 sidebar 族且从未打开过（closed）的
   *  面板 → 注册后自动 present(open) 入栈（方案 §3.1「常驻区块默认存在」——任务区块
   *  等懒扩展 provider 物化后即落位；用户本会话关闭不回弹，刷新/重启用后恢复默认存在）。
   *  seen 守卫 Set 由 DockStack 实例（ref）持有——重挂载即重置，语义 = 每次接管生效期一次。 */
  function autoDockSidebarOnce(items: any[], seen: Set<string>): void {
    for (const it of items) {
      const key = String(it.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const pref = dockPref(key);
      if (pref && isSidebarDockState(`docked:${pref}`) && presented(key) === "closed") {
        present(key, "open", { auto: true });
      }
    }
  }

  /** DockStack 容器（session-manager SidebarContentDock 消费）。
   *  props: { blocks: DockBlockDef[]; dockSlot?: string; slotExtra?: Record<string,unknown>;
   *          autoDock?: boolean; filler?: () => unknown }
   *  filler（应用中心，docs/aiti-app-center-plan.md）：全折叠时空白区的填充物——编排器经
   *  跨 bundle 服务传入的组件工厂；任一区块展开（anyExpanded）或 filler 缺席时零渲染。 */
  function DockStack(props: { blocks?: DockBlockDef[]; dockSlot?: string; slotExtra?: Record<string, unknown>; autoDock?: boolean; staticShell?: any; filler?: () => unknown }) {
    const autoDockedRef = (ctx.useRef as (v: any) => { current: Set<string> })(new Set<string>());
    const blocks = props.blocks ?? [];
    const dockSlot = props.dockSlot ?? "sidebarExplorerDock";
    // 旧折叠 key 一次性迁移（四旧 key → pi:sidebar-dock:collapsed:*；模块级 once 守卫）
    useEffect(() => { migrateLegacyCollapseKeys(); }, []);
    // dockable 区块 = slot items（render 可选条目滤除；meta.priority 进默认序）。
    // 只收「当前停靠在 sidebar 族」的面板（gate 语义一致）：closed/floating/右栏面板
    // 不留 0 高空格、不污染上下移邻居序；present 变化（⋮ 菜单换位/拉回）→ 重渲染跟随。
    const rawItems = (ctx.useSlotItems as (slot: string) => any[])?.(dockSlot) ?? [];
    // render 可选化（懒加载 v2）+ 静态条目（开页方案 §1 F4）：无 render 但 static 的条目
    // 也要进栈——先渲染静态壳，展开时物化后由注册条目接管（同 key 覆盖）。
    const items = rawItems.filter((it: any) => typeof it?.render === "function" || it?.static === true);
    const [, bumpPresent] = useState(0);
    useEffect(() => {
      const onPresent = (e: Event) => {
        const key = (e as CustomEvent<{ key?: string }>).detail?.key;
        if (!key || isSidebarDockState(presented(key)) || presented(key) === "closed") bumpPresent((v) => v + 1);
      };
      window.addEventListener(CHANGE_EVENT, onPresent);
      return () => window.removeEventListener(CHANGE_EVENT, onPresent);
    }, []);
    const dockedItems = items.filter((it: any) => isSidebarDockState(presented(String(it.id))));
    // 常驻自动入栈（autoDock；present 触发 CHANGE_EVENT → 上方订阅 bump → 重渲染入栈）
    useEffect(() => {
      if (props.autoDock) autoDockSidebarOnce(items, autoDockedRef.current);
    }, [props.autoDock, items, autoDockedRef]);
    const order = useDockOrderCtx();
    // 上下移/拖拽落位：全栈键集 = 常驻键 + 在栈 dockable 复合 id。
    useEffect(() => {
      // 全栈键集（真实有效序 + 对齐标注）：上下移/拖拽只在同对齐组内生效——
      // 组界 = 硬边界（v4 对齐分组），跨组移动 no-op（不写无意义的 order 残留）。
      // ⚠ 必须传「真实有效序」（priority 参与排序后的键序）——moveBlockKey/moveBlockTo
      // 对裸 key 数组按传入序 tie-break，传无序数组会搅乱未参与区块的相对序。
      const stackEntries = () => {
        const entries: Array<{ key: string; priority?: number; align?: BlockAlign }> = [
          ...blocks.map((b) => ({ key: b.key, priority: b.priority, align: (b.align ?? "top") as BlockAlign })),
          ...dockedItems.map((it: any) => ({ key: String(it.id), priority: typeof it.meta?.priority === "number" ? it.meta.priority : DOCK_DEFAULT_PRIORITY, align: (it.meta?.align === "top" ? "top" : "bottom") as BlockAlign })),
        ];
        return effectiveBlockOrder(entries, readDockOrder());
      };
      const alignOf = (list: Array<{ key: string; align?: BlockAlign }>, key: string) => list.find((e2) => e2.key === key)?.align ?? "top";
      const onMove = (e: Event) => {
        const d = (e as CustomEvent<{ key: string; delta: number }>).detail;
        if (!d || typeof d.key !== "string" || !d.delta) return;
        const list = stackEntries();
        const idx = list.findIndex((e2) => e2.key === d.key);
        const neighbor = idx >= 0 ? list[idx + d.delta] : undefined;
        if (!neighbor) return;
        if (alignOf(list, d.key) !== (neighbor.align ?? "top")) return; // 组界钳制
        moveBlockKey(d.key, d.delta, list.map((e2) => e2.key));
      };
      const onDrop = (e: Event) => {
        const d = (e as CustomEvent<{ key: string; target: string; before: boolean }>).detail;
        if (!d || typeof d.key !== "string" || typeof d.target !== "string") return;
        const list = stackEntries();
        if (alignOf(list, d.key) !== alignOf(list, d.target)) return; // 组界钳制
        moveBlockTo(d.key, d.target, list.map((e2) => e2.key), d.before !== false);
      };
      window.addEventListener(SIDEBAR_MOVE_EVENT, onMove);
      window.addEventListener(SIDEBAR_DROP_EVENT, onDrop);
      return () => {
        window.removeEventListener(SIDEBAR_MOVE_EVENT, onMove);
        window.removeEventListener(SIDEBAR_DROP_EVENT, onDrop);
      };
    }, [blocks, dockedItems, order]);
    const entries: DockBlockDef[] = [
      ...blocks.map((b) => ({ ...b, align: (b.align ?? "top") as BlockAlign })),
      ...dockedItems.map((it: any): DockItemDef => ({
        key: String(it.id),
        title: (it.meta?.title as string) ?? String(it.id),
        priority: typeof it.meta?.priority === "number" ? it.meta.priority : DOCK_DEFAULT_PRIORITY,
        // 对齐分组（v4）：dockable 默认下对齐（重要性次级）；meta.align="top" 显式声明核心区块
        align: (it.meta?.align === "top" ? "top" : "bottom") as BlockAlign,
        fill: false,
        maxHeightPct: typeof it.meta?.maxHeightPct === "number" ? it.meta.maxHeightPct : 45,
        render: () => null, // 渲染走 StackCell 的 dockItem 分支（占位）
        __dockItemId: String(it.id),
        ...(it.static === true ? { __staticItem: it } : {}),
      })),
    ];
    const ordered = effectiveBlockOrder(entries, order);
    // 对齐分组（v4）：组内保持有效序；组界 = 排序硬边界（上移/下移/拖拽跨组 no-op）。
    // 布局语义（v5 修正，用户拍板 2026-09-16）：对齐**不切分空间**——只决定「都折叠时
    // 空白的位置」：上对齐头行贴顶、下对齐头行贴底、空白居中；任一区块展开则吃掉
    // 全部空白占满（单展开互斥见下方容器监听），spacer 仅在全折叠时撑开空白。
    const { top, bottom } = splitBlockAlign(ordered, "top");
    // 折叠态感知：折叠事件/跨 tab 同步 → 重算（展开者 grow / spacer 收放）。
    const [, bumpCollapsed] = useState(0);
    useEffect(() => {
      const sync = () => bumpCollapsed((v) => v + 1);
      window.addEventListener(SIDEBAR_COLLAPSE_EVENT, sync);
      window.addEventListener("storage", sync);
      return () => { window.removeEventListener(SIDEBAR_COLLAPSE_EVENT, sync); window.removeEventListener("storage", sync); };
    }, []);
    // 单展开互斥（手风琴，用户拍板 2026-09-16「每次只能显示一个」）：任一区块展开
    // → 折叠全栈其他展开者（localStorage 单一事实源 + 广播，各 DockBody 订阅跟随；
    // 被折叠者再广播 collapsed=true 不触发本 handler——只响应展开动作，无递归；
    // 跨 tab storage 事件无 detail 自动跳过，互斥仅在当前页生效）。
    useEffect(() => {
      const onCollapse = (e: Event) => {
        const d = (e as CustomEvent<{ key: string; collapsed: boolean }>).detail;
        if (!d || typeof d.key !== "string" || d.collapsed) return;
        for (const b of ordered) {
          if (b.key === d.key || readBlockCollapsed(b.key)) continue;
          writeBlockCollapsed(b.key, true);
        }
      };
      window.addEventListener(SIDEBAR_COLLAPSE_EVENT, onCollapse);
      return () => window.removeEventListener(SIDEBAR_COLLAPSE_EVENT, onCollapse);
    }, [ordered]);
    const anyExpanded = ordered.some((b) => !readBlockCollapsed(b.key));
    const cell = (b: DockBlockDef) => h(StackCell, {
      key: b.key,
      block: b,
      dockItemId: (b as DockItemDef).__dockItemId,
      staticItem: (b as DockItemDef).__staticItem,
      staticShell: props.staticShell,
      slotName: dockSlot,
      slotExtra: props.slotExtra,
    });
    return h("div",
      {
        "data-ext-float-dock-stack": "1",
        // 拖拽入位落点（drag-drop-unify §3.2）：通配标记——aiti-float 拖拽吸附命中后
        // 经 resolveDropZone 解析为拖拽面板自己的 sidebar:<itemKey>，present 入栈。
        "data-ext-float-dock-zone": "sidebar",
        style: { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, overflow: "hidden" },
      },
      ...top.map(cell),
      // 空白区（对齐语义本体）：只在全折叠时存在（居中）；有展开者时 0 高——空白由展开者 grow 吃掉。
      // filler（v2 应用中心）：全折叠时空白的填充物（组件工厂由编排器传入）；内容自身内部滚动。
      h("div", { "data-ext-float-dock-stack-spacer": "1", style: { flex: anyExpanded ? "0 0 0" : "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" } },
        !anyExpanded && typeof props.filler === "function" ? props.filler() : null),
      ...bottom.map(cell),
    );
  }

  return {
    /** 容器组件（ctx.h 渲染元素树内使用：h(api.DockStack, { blocks, dockSlot })） */
    DockStack,
    /** 版本（消费方降级判断）：2 = 支持 filler prop（应用中心）。 */
    version: 2,
  };
}
