/**
 * aiti-cmd · pi-web 命令管理器扩展（真 TTY 终端 + 常用命令 + 消息识别命令）
 *
 * 能力：
 *   - 执行引擎：node-pty 真 PTY（实时增量帧走 aiti-event-bus 主题 cmd-<id> 唯一下行；
 *     初始回放/大消息走 REST 快照；POST 上行 input/resize/kill。旧 per-session SSE 已删——
 *     订阅 topics 唯一，禁止兑底，2026-09-09 拍板）
 *   - 常用命令：CRUD + 参数化占位符 {xxx}
 *   - 消息识别：/commands/check 异步校验（与 /api/files 同模式）
 *   - 审计：所有执行 append-only JSONL 落盘（logs/<date>.jsonl）
 *
 * 用法：部署到 ~/.pi/web/extensions/aiti-cmd/（tools/deploy.mjs）后 reload。
 */
import { createAudit } from "./audit.js";
import { createStore, normSandbox } from "./store.js";
import { checkCommand, COMMAND_DICT, describeCommand, extractCommandsFromText, loadUserDict, saveUserDict } from "./recognize.js";
import { createRunner, type RunOptions } from "./runner.js";
import { createPiCommands } from "./pi-commands.js";
import { randomBytes } from "node:crypto";

let audit: ReturnType<typeof createAudit> | null = null;
let store: ReturnType<typeof createStore> | null = null;
let runner: ReturnType<typeof createRunner> | null = null;
let piCommands: ReturnType<typeof createPiCommands> | null = null;
// 数据目录（startup 捕获，api 处统一引用，不裸读 ctx.*）——新旧 core 双轨（过渡期）：
// 新 core = configDir（持久）+ cacheDir（可重建）；旧 core（如 prod 未同步）只有 dataDir。
// 取值序 configDir → dataDir：新 core 上 dataDir 属性「访问即抛」，configDir 在前短路绝不触它。
let dirCfg = "";
let dirCache = "";

// 终端流订阅保活（停推）：type → 最后心跳时刻。前端 15s POST /alive；超 45s 未刷新的
// type 在 publish 包装里停推（页面/面板关闭后源头即断）。未报活过的 type 乐观推。
const aliveMap = new Map<string, number>();
const ALIVE_TIMEOUT_MS = 45_000;

// Server-side exit event fan-out (aiti-ai-schedule process-exit trigger): listeners registered
// via the `aiti-cmd.on-exit` service get every session exit frame published on `cmd-<id>` topics.
const exitListeners = new Set<(info: { sessionId: string; code: number | null; signal: string | null; durationMs?: number; cmd?: string; source?: string; cwd?: string; cancelled?: boolean }) => void>();

// 词库分类展示（/commands/dict）
function COMMAND_DICT_GROUPS() {
  return COMMAND_DICT.map((g) => ({ group: g.group, names: g.names, phrases: g.phrases.slice(0, 30) }));
}

// 危险命令一次性确认 token（用后即弃 + 3s 过期，防重放）
const confirmTokens = new Map<string, number>(); // token -> expires
export function issueConfirmToken(): string {
  const t = "ct_" + randomBytes(16).toString("hex");
  confirmTokens.set(t, Date.now() + 3000);
  return t;
}
export function consumeConfirmToken(t: string): boolean {
  const exp = confirmTokens.get(t);
  if (!exp) return false;
  confirmTokens.delete(t);
  return Date.now() < exp;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// source 规范收口（aiti-cmd-exec-integration-plan.md §3.1）：枚举开放语义，这里只列基线值——
// POST /run 传基线外的新值照记（开放），传未知值归 "unknown"（防拼错不可归因）；缺 source 兜底
// manual + 审计标 sourceDefaulted（不再静默吞）。
const KNOWN_SOURCES = new Set([
  "manual", "message", "shell", "favorite", "asr-selfheal",
  "schedule", "suggest", "ai-helper", "codebuddy", "service", "unknown",
]);

// ---------- suggest 静态 provider（处理器：ai-input 进程内聚合优先；HTTP 端点同逻辑兑底） ----------
// 后端扩展点：本扩展启动时把查询处理器注册进 globalThis 注册表，ai-input /suggest 免 HTTP 自环直接调用
try {
  const g = globalThis as Record<string, unknown>;
  const reg = (g.__aitiSuggestHandlers ?? (g.__aitiSuggestHandlers = new Map())) as Map<
    string, (q: string, limit: number) => Promise<unknown[]> | unknown[]>;
  reg.set("aiti-cmd", (q: string, limit: number) => commandSuggest(store, q, limit));
} catch { /* 注册失败不影响主流程 */ }

// 命令 suggest 查询（api /commands/suggest 与进程内聚合共用）
// 排序：匹配度（name 前缀>name 子串>cmd/tags） > runCount > lastRunAt > 名称
function commandSuggest(store: ReturnType<typeof createStore> | null, q: string, limit: number): unknown[] {
  if (!store) return [];
  // 关闭了智能提示（suggest:false）的命令不参与联想（aiti-ai-input L0 本地层 / /suggest 聚合 / HTTP 端点同一函数全覆盖）
  let items = store.list().filter((c) => c.suggest !== false);
  const lq = q.trim().toLowerCase();
  if (lq) items = items.filter((c) =>
    c.name.toLowerCase().includes(lq) || c.cmd.toLowerCase().includes(lq) ||
    (c.tags || []).some((t) => t.toLowerCase().includes(lq)));
  const rank = (c: (typeof items)[number]): number => {
    if (!lq) return 0;
    if (c.name.toLowerCase().startsWith(lq)) return 3;
    if (c.name.toLowerCase().includes(lq)) return 2;
    if (c.cmd.toLowerCase().includes(lq) || (c.tags || []).some((t) => t.toLowerCase().includes(lq))) return 1;
    return 0;
  };
  items.sort((a, b) => {
    const d = rank(b) - rank(a); if (d) return d;
    const du = (b.runCount || 0) - (a.runCount || 0); if (du) return du;
    const dt = (b.lastRunAt || 0) - (a.lastRunAt || 0); if (dt) return dt;
    return a.name.localeCompare(b.name, "zh");
  });
  return items.slice(0, Math.max(1, Math.min(limit || 6, 20))).map((c) => ({
    id: c.id, kind: "cmd", name: c.name, cmd: c.cmd,
    params: c.params || [], groupId: c.groupId || null, confirm: !!c.confirm,
    runCount: c.runCount || 0, lastRunAt: c.lastRunAt || null,
  }));
}

export default {
  id: "aiti-cmd",
  name: "aiti 命令管理器（真 TTY 终端 + 常用命令）",
  icon: "icon.svg",
  client: "dist/aiti-cmd-client.mjs",

  // 声明本扩展是 suggest 静态 provider（ai-input 聚合；命中命令直接填/执行，不走 AI——docs/aiti-ai-helper-plan.md §3.5）
  suggest: { label: "命令", rank: 0, path: "commands/suggest" },

  // AI 自管理清单（docs/aiti-ai-helper-plan.md §3.2）：告诉 AI 怎么管理本扩展
  ai: {
    manage: true,
    intro: "AI 能帮我写命令（描述需求 → JSON → 校验 → 入库）；命令、运行态势、终端是三个独立窗口",
    skills: "skills",
  },

  // 功能管理（extman 逐项启停）：agent 工具门控——core per-tool 约定 feature.id = "tool.<注入后的工具名>"
  features: [
    { id: "tool.aiti_cmd_run", label: "agent 工具：aiti_cmd_run（AI 会话内经后端 runner 执行命令；危险命令二次确认）", group: "agent-tools", default: true, description: "关闭后新 agent 会话不再注入该工具（已注入会话即时拒绝）。" },
  ],

  ui: {
    // Always-on: the composerTools run-status entry must be visible before the first open,
    // which a lazy client cannot provide (static slot items carry no render). Bundle ~600KB raw
    // / ~136KB gzip (xterm included) — accepted trade-off, see docs/aiti-cmd-three-apps-split-plan.md §2.4.
    clientImmediately: true,
    // 懒加载 v2 M3批②：静态条目与 client 注册 id/icon 对齐
    toolbar: [{ id: "aiti-cmd-open", label: "i18n:cmd.open.label", title: "i18n:cmd.open.title", icon: "icons/terminal.svg" }],
    i18n: {
      "zh-CN": {
        "cmd.k1": " · ⚠ 危险: ",
        "cmd.k2": " · 参数: {",
        "cmd.k3": " · 已安装（PATH/项目 bin）",
        "cmd.k4": " · 已执行 ",
        "cmd.k5": " · 截断",
        "cmd.k6": " · 无沙箱",
        "cmd.k7": " · 点行看详情",
        "cmd.k8": " · 耗时 ",
        "cmd.k9": " · 输出已截断",
        "cmd.k10": " · 🖥 终端 ",
        "cmd.k11": " 个在跑",
        "cmd.k12": " 个未显示）",
        "cmd.k13": " 个未显示），点开列表切换",
        "cmd.k14": " 命令名 / 识别时全文扫描",
        "cmd.k15": " 已在 aiti-cmd 窗口打开",
        "cmd.k16": " 并发）",
        "cmd.k17": " 排队）",
        "cmd.k18": " 未安装（PATH/项目 bin 中找不到）",
        "cmd.k19": " 条",
        "cmd.k20": " 条 · 点击执行",
        "cmd.k21": " 条哈希",
        "cmd.k22": " 条在跑",
        "cmd.k23": " 条，失败 ",
        "cmd.k24": " 次",
        "cmd.k25": " 终止）",
        "cmd.k26": " 终止） · ",
        "cmd.k27": "%），最近 ",
        "cmd.k28": "ABC 全键",
        "cmd.k29": "AI 助手",
        "cmd.k30": "AITI 调试器",
        "cmd.k31": "ASR 自愈",
        "cmd.k32": "Alt 锁：点一次锁定，再按字母/符号键发 Alt+键（ESC 前缀）、按方向键发 Alt+方向",
        "cmd.k33": "CTRL/SHIFT/ALT/WIN 锁 + 键 = 组合键",
        "cmd.k34": "Ctrl 锁：点一次锁定，再按字母键发 Ctrl+字母、按方向键发 Ctrl+方向（按词移动）",
        "cmd.k35": "JSX 示例",
        "cmd.k36": "JSX 示例面板",
        "cmd.k37": "SHIFT 锁：点一次锁定，再按字母=大写（如 grep -E）、数字=上档符号、方向键=Shift+方向（选择）",
        "cmd.k38": "WIN/Meta 锁：点一次锁定，再按键=ESC 前缀（终端 Meta 键，同 ALT 语义；部分程序区分绑定）",
        "cmd.k39": "agent 会话",
        "cmd.k40": "agent 命令",
        "cmd.k41": "aiti-cmd：运行中 / 命令收藏 / 终端",
        "cmd.k42": "cwd（缺省=当前会话目录）",
        "cmd.k43": "demo 标记",
        "cmd.k44": "demo 横幅测试",
        "cmd.k45": "demo 自检",
        "cmd.k46": "demo 自检面板",
        "cmd.k47": "demo 自检页面",
        "cmd.k48": "demo-lazy：点击时才加载 bundle（懒加载 v2 样板）",
        "cmd.k49": "shell 由 aiti-cmd 承载 · 24h 会话",
        "cmd.k50": "… 还有 ",
        "cmd.k51": "… 连接中",
        "cmd.k52": "← 返回: ",
        "cmd.k53": "← 返回总览",
        "cmd.k54": "↓底",
        "cmd.k55": "↻ 刷新",
        "cmd.k56": "⇱ 转到页签",
        "cmd.k57": "⇲ 拉回窗口",
        "cmd.k58": "▶ 单独执行",
        "cmd.k59": "▶ 执行此命令",
        "cmd.k60": "● 运行中",
        "cmd.k61": "⟳ 回放中",
        "cmd.k62": "。点击查看/收藏（不会直接执行）",
        "cmd.k63": "」及其子分组？组内命令将移入未分组",
        "cmd.k64": "」标记为危险命令。\n创建定时计划后到点将不经确认直接执行，确认继续？",
        "cmd.k65": "」（默认每天9点，到 ⏰调度 页修改并批准）",
        "cmd.k66": "一次性环境：系统只读，/tmp、$HOME 可写但退出即丢",
        "cmd.k67": "上/下翻（终端）",
        "cmd.k68": "上一条 / 下一条命令历史",
        "cmd.k69": "上一条历史/上移",
        "cmd.k70": "上级分组",
        "cmd.k71": "上翻",
        "cmd.k72": "上翻 / 下翻一页",
        "cmd.k73": "下一条历史/下移",
        "cmd.k74": "下翻",
        "cmd.k75": "不参与智能提示",
        "cmd.k76": "不隔离文件系统/网络，仅限可信命令",
        "cmd.k77": "中断",
        "cmd.k78": "中断当前命令（SIGINT）",
        "cmd.k79": "临时可写盘（退出即丢）",
        "cmd.k80": "临时盘",
        "cmd.k81": "任务",
        "cmd.k82": "会话 ",
        "cmd.k83": "会话已停止（被 ",
        "cmd.k84": "会话已结束",
        "cmd.k85": "会话已结束（退出码 ",
        "cmd.k86": "位于：",
        "cmd.k87": "作为 aiti-ai-input 智能提示（输入联想/补全）的来源；关掉后输入时不再提示此命令",
        "cmd.k88": "作为 aiti-ai-input 输入联想/补全的来源（默认开）",
        "cmd.k89": "保存",
        "cmd.k90": "保存修改",
        "cmd.k91": "保存后出现在命令列表对应分组",
        "cmd.k92": "保存失败",
        "cmd.k93": "保存自定义命令词到词库（消息识别立即生效）",
        "cmd.k94": "保存词库",
        "cmd.k95": "停靠示例",
        "cmd.k96": "停靠示例（浮窗态）",
        "cmd.k97": "光标到行尾",
        "cmd.k98": "光标到行首",
        "cmd.k99": "光标到行首 / 行尾",
        "cmd.k100": "光标左 / 右移",
        "cmd.k101": "全屏",
        "cmd.k102": "全屏 / 退出全屏",
        "cmd.k103": "全屏 / 退出全屏 (Ctrl+Shift+F)",
        "cmd.k104": "全屏 / 退出全屏（Ctrl+Shift+F）",
        "cmd.k105": "全部",
        "cmd.k106": "全部会话",
        "cmd.k107": "全部：取消标签过滤",
        "cmd.k108": "全键盘：字母 / 数字 / 符号 / 空格 —— Ctrl 锁 + 字母键 = Ctrl+字母",
        "cmd.k109": "关闭",
        "cmd.k110": "关闭 (Esc)",
        "cmd.k111": "关闭虚拟键盘 (Esc)",
        "cmd.k112": "关闭词库",
        "cmd.k113": "关闭面板",
        "cmd.k114": "内置 ",
        "cmd.k115": "出错/被终止",
        "cmd.k116": "分组",
        "cmd.k117": "分组名",
        "cmd.k118": "切换终端全屏",
        "cmd.k119": "切换虚拟键盘",
        "cmd.k120": "创建",
        "cmd.k121": "创建失败：",
        "cmd.k122": "创建终端失败",
        "cmd.k123": "删到行首",
        "cmd.k124": "删词",
        "cmd.k125": "删除分组",
        "cmd.k126": "删除分组「",
        "cmd.k127": "删除分组时组内命令自动移入未分组",
        "cmd.k128": "删除到行首 / 删除到行尾",
        "cmd.k129": "删除前一个单词",
        "cmd.k130": "删除此命令",
        "cmd.k131": "到命令页管理（新建/编辑/分组/标签）",
        "cmd.k132": "刷新历史记录",
        "cmd.k133": "功能键 F1",
        "cmd.k134": "功能键 F10",
        "cmd.k135": "功能键 F11",
        "cmd.k136": "功能键 F12",
        "cmd.k137": "功能键 F2",
        "cmd.k138": "功能键 F3",
        "cmd.k139": "功能键 F4",
        "cmd.k140": "功能键 F5",
        "cmd.k141": "功能键 F6",
        "cmd.k142": "功能键 F7",
        "cmd.k143": "功能键 F8",
        "cmd.k144": "功能键 F9",
        "cmd.k145": "加载中…",
        "cmd.k146": "危险命令执行前确认",
        "cmd.k147": "危险命令：",
        "cmd.k148": "历史",
        "cmd.k149": "历史：执行审计（append-only 留存）",
        "cmd.k150": "参与智能提示",
        "cmd.k151": "参数 ",
        "cmd.k152": "参考 Termux extra-keys",
        "cmd.k153": "反向搜索历史",
        "cmd.k154": "反向搜索命令历史",
        "cmd.k155": "取消",
        "cmd.k156": "取消 / 进入 vi 模式",
        "cmd.k157": "取消排队",
        "cmd.k158": "只终止这条 bash 命令（agent 收到错误后继续思考；同会话并发 bash 会一起终止）",
        "cmd.k159": "只终止这条命令（不 abort 整个 turn）",
        "cmd.k160": "只读",
        "cmd.k161": "只读 + 断网",
        "cmd.k162": "只读+断网",
        "cmd.k163": "右移",
        "cmd.k164": "右键 / Ctrl+Shift+C / Ctrl+Insert",
        "cmd.k165": "同类:",
        "cmd.k166": "名称",
        "cmd.k167": "命令",
        "cmd.k168": "命令 / 路径补全",
        "cmd.k169": "命令/参数/输出/退出码/时间/来源——安全审计",
        "cmd.k170": "命令「",
        "cmd.k171": "命令内容为空，无法收藏",
        "cmd.k172": "命令可识别",
        "cmd.k173": "命令已停止（出错/被终止）",
        "cmd.k174": "命令已完成",
        "cmd.k175": "命令管理",
        "cmd.k176": "命令：常用命令列表（执行/复制/编辑/删除）",
        "cmd.k177": "回车",
        "cmd.k178": "图片预览",
        "cmd.k179": "在新窗口/新标签页中打开（外部网站）",
        "cmd.k180": "在此分组下新建命令",
        "cmd.k181": "在此分组下新建子分组",
        "cmd.k182": "复制",
        "cmd.k183": "复制命令内容到剪贴板并打开「新建命令」预填（可改后另存）",
        "cmd.k184": "复制选中的终端文本（Ctrl+C 是中断，不能用来复制）",
        "cmd.k185": "外部会话",
        "cmd.k186": "如：构建 / 部署",
        "cmd.k187": "子",
        "cmd.k188": "安装建议：",
        "cmd.k189": "完成",
        "cmd.k190": "定时",
        "cmd.k191": "定时命令",
        "cmd.k192": "定时执行：创建调度计划（预填本条命令）",
        "cmd.k193": "工作区页签 · ",
        "cmd.k194": "工作目录",
        "cmd.k195": "工作目录：",
        "cmd.k196": "工具条按钮",
        "cmd.k197": "左移",
        "cmd.k198": "已停止",
        "cmd.k199": "已创建待确认计划「",
        "cmd.k200": "已加入队列，等待执行（位置 ",
        "cmd.k201": "已收藏",
        "cmd.k202": "已清理",
        "cmd.k203": "已结束",
        "cmd.k204": "已结束（服务器已清理记录）",
        "cmd.k205": "已退出",
        "cmd.k206": "常用",
        "cmd.k207": "常用:",
        "cmd.k208": "常用命令",
        "cmd.k209": "常用命令词库（消息识别用）",
        "cmd.k210": "常用快捷键",
        "cmd.k211": "常用快捷键帮助",
        "cmd.k212": "常用键：方向 / 编辑 / Ctrl 组合 / 常用符号",
        "cmd.k213": "开启中…",
        "cmd.k214": "引用",
        "cmd.k215": "归档查看器",
        "cmd.k216": "当前：",
        "cmd.k217": "当前：🤖 agent 在跑 / 🖥 终端在跑",
        "cmd.k218": "循环终端窗口大小",
        "cmd.k219": "总览",
        "cmd.k220": "总览：agent 运行中命令 / 终端会话一览",
        "cmd.k221": "懒加载示例小组件",
        "cmd.k222": "手动",
        "cmd.k223": "打开",
        "cmd.k224": "打开链接？",
        "cmd.k225": "执行",
        "cmd.k226": "执行以下命令并汇报结果",
        "cmd.k227": "执行前弹窗确认",
        "cmd.k228": "执行前是否弹窗确认（危险命令建议开启）",
        "cmd.k229": "执行审计（append-only 留存）",
        "cmd.k230": "执行确认",
        "cmd.k231": "拉回窗口",
        "cmd.k232": "拉回窗口：终端视图移回 aiti-cmd 弹窗（页签显示占位）",
        "cmd.k233": "拉回窗口：终端视图移回 aiti-cmd 弹窗（页签显示占位；仅页签模式有）",
        "cmd.k234": "挂起",
        "cmd.k235": "挂起当前任务（后台）",
        "cmd.k236": "按词移动光标（readline）",
        "cmd.k237": "排队中",
        "cmd.k238": "排队中 (",
        "cmd.k239": "排队中（并发已满，可在「运行中」列表关闭旧终端）",
        "cmd.k240": "接管到页签",
        "cmd.k241": "提示词",
        "cmd.k242": "搜索会话",
        "cmd.k243": "搜索命令…",
        "cmd.k244": "支持 {参数} 占位符，执行时填入",
        "cmd.k245": "收藏",
        "cmd.k246": "收藏到哪个分组",
        "cmd.k247": "收藏名称（默认=命令文本）",
        "cmd.k248": "收藏后可在 ⚡ 命令面板随时一键调用（不依赖 AI）；执行记录全部写入审计日志。",
        "cmd.k249": "收藏命令",
        "cmd.k250": "收藏完整命令到常用命令",
        "cmd.k251": "收藏库",
        "cmd.k252": "收藏选中的文本（可只收藏命令片段）",
        "cmd.k253": "收起虚拟键盘",
        "cmd.k254": "改动即时生效",
        "cmd.k255": "文件系统只读且无网络——最高隔离，适合不信任命令",
        "cmd.k256": "文件系统只读，改动不落盘；工作目录真实可写",
        "cmd.k257": "文档",
        "cmd.k258": "文档中心",
        "cmd.k259": "新会话",
        "cmd.k260": "新增词后，消息识别会立即用新词扫描",
        "cmd.k261": "新建 pi-web 会话",
        "cmd.k262": "新建 pi-web 会话失败：宿主新会话通道不可用",
        "cmd.k263": "新建 pi-web 会话失败：当前终端会话没有工作目录",
        "cmd.k264": "新建 pi-web 会话：打开新 agent 会话并 @ 当前终端实时路径",
        "cmd.k265": "新建 shell",
        "cmd.k266": "新建分组",
        "cmd.k267": "新建命令",
        "cmd.k268": "新建：再开一个 shell（目录 = 当前终端 📁 实时路径）",
        "cmd.k269": "无沙箱",
        "cmd.k270": "无沙箱（完全信任）· 默认",
        "cmd.k271": "显示环境",
        "cmd.k272": "智能提示",
        "cmd.k273": "智能提示参与",
        "cmd.k274": "更多终端",
        "cmd.k275": "更多终端/命令（还有 ",
        "cmd.k276": "服务",
        "cmd.k277": "未分组",
        "cmd.k278": "未知",
        "cmd.k279": "未知错误",
        "cmd.k280": "本帮助面板",
        "cmd.k281": "来源分布",
        "cmd.k282": "查看 / 收藏 / 编辑，不会直接执行",
        "cmd.k283": "标签",
        "cmd.k284": "校验失败",
        "cmd.k285": "校验审计链完整性（哈希链）",
        "cmd.k286": "校验链",
        "cmd.k287": "桥探针",
        "cmd.k288": "桥连接探针（临时诊断：采集 SSE/生命周期事件）",
        "cmd.k289": "模型可用性",
        "cmd.k290": "模型向导",
        "cmd.k291": "模型检查",
        "cmd.k292": "模型管理",
        "cmd.k293": "模型配置导入",
        "cmd.k294": "正在创建终端会话…",
        "cmd.k295": "正在启动 shell…",
        "cmd.k296": "正在查看相关命令",
        "cmd.k297": "此终端已在工作区页签打开（右侧文件区）",
        "cmd.k298": "此面板用于 查看 / 收藏 / 编辑 命令，不会直接执行。",
        "cmd.k299": "沙箱",
        "cmd.k300": "消息识别",
        "cmd.k301": "清屏",
        "cmd.k302": "滚动到底部",
        "cmd.k303": "滚动到底部：跳到最新输出（上翻阅读时不会打扰）",
        "cmd.k304": "点击查看/收藏此命令（不会直接执行）",
        "cmd.k305": "点击查看/管理此命令",
        "cmd.k306": "点选元素",
        "cmd.k307": "用量",
        "cmd.k308": "直接执行",
        "cmd.k309": "看板",
        "cmd.k310": "确定",
        "cmd.k311": "确认执行危险命令",
        "cmd.k312": "示例小组件",
        "cmd.k313": "空格",
        "cmd.k314": "管理 →",
        "cmd.k315": "管理模型",
        "cmd.k316": "篡改于 ",
        "cmd.k317": "粘贴剪贴板到终端",
        "cmd.k318": "系统只读（工作目录可写）",
        "cmd.k319": "终止",
        "cmd.k320": "终止中…",
        "cmd.k321": "终止中（已发 SIGTERM，最多 3s 后强制 KILL）",
        "cmd.k322": "终止信号已发送，等待进程退出…",
        "cmd.k323": "终止命令",
        "cmd.k324": "终止命令（杀进程）",
        "cmd.k325": "终端",
        "cmd.k326": "终端会话",
        "cmd.k327": "终端功能键（虚拟键盘「常用/全键」底部一行，mc / htop 等 TUI 用）",
        "cmd.k328": "终端同时只能在一处显示；接管后窗口内该终端变为占位",
        "cmd.k329": "终端同时只能在一处显示；页签内已变为占位",
        "cmd.k330": "终端窗口大小（列×行）：自适应容器，或固定标准尺寸——小屏也能看到完整终端，超出可滚动",
        "cmd.k331": "编辑分组",
        "cmd.k332": "编辑命令",
        "cmd.k333": "编辑命令（名称/命令/cwd/标签/分组/沙箱/执行确认/智能提示）",
        "cmd.k334": "缺省 = 命令文本",
        "cmd.k335": "缺省 = 当前会话目录",
        "cmd.k336": "网络错误",
        "cmd.k337": "耗时 ",
        "cmd.k338": "联想",
        "cmd.k339": "聚合 / 多key运行状态",
        "cmd.k340": "自动·切换前",
        "cmd.k341": "自动·登出前",
        "cmd.k342": "自动·登录前",
        "cmd.k343": "自定义命令词（每行一个，如：mytool / just get / pnpm-dlx）",
        "cmd.k344": "自适应",
        "cmd.k345": "虚拟键盘",
        "cmd.k346": "虚拟键盘有「⌨ 常用 / ABC 全键」两档：常用 = 方向/编辑/Ctrl 组合；全键 = 完整字母数字符号键盘（含空格，可输入命令全文）。CTRL/SHIFT/ALT/WIN 四把锁，点一次锁定、再按任意键自动解锁（与物理键盘同感）：CTRL 锁 + 字母 = Ctrl+字母（如 a→Ctrl+A 行首）、+ 方向键 = 按词移动（readline）；SHIFT 锁 + 字母 = 大写（grep -E 必需）、+ 数字 = 上档符号、+ 方向键 = Shift+方向（选择）；ALT/WIN 锁 + 字母/符号 = ESC 前缀（Meta 键），+ 方向键 = Alt+方向（xterm \x1b[1;3x 序列，程序可区分是否带 Alt）。注意：终端转义协议不区分左右 Shift/Alt（只有 GUI 程序能区分），所以只有一把 SHIFT/ALT 锁。终端聚焦时 Ctrl+Shift+F 全屏、Ctrl+Shift+K 键盘、Ctrl+Shift+S 循环窗口大小。",
        "cmd.k347": "虚拟键盘：方向 / Tab / Esc / Ctrl / 常用符号（Ctrl+Shift+K）",
        "cmd.k348": "虚拟键盘：方向键 / Tab / Esc / Ctrl / 常用符号 (Ctrl+Shift+K)",
        "cmd.k349": "行尾",
        "cmd.k350": "行首",
        "cmd.k351": "行首 / 行尾",
        "cmd.k352": "补全",
        "cmd.k353": "设备互连",
        "cmd.k354": "设备互连面板",
        "cmd.k355": "词库",
        "cmd.k356": "词库：常用命令名（AI 消息识别用，全文扫描）",
        "cmd.k357": "语音流量",
        "cmd.k358": "语音识别引擎",
        "cmd.k359": "调试",
        "cmd.k360": "转到工作区页签",
        "cmd.k361": "转到页签失败：",
        "cmd.k362": "转到页签失败：宿主建页签能力缺席（pi-web.ui.onOpenTerminal）",
        "cmd.k363": "转到页签失败：此终端会话没有工作目录，无法定位到项目页签",
        "cmd.k364": "转到页签：终端移到右侧文件区的工作区终端页签（弹窗内变占位）",
        "cmd.k365": "运行中",
        "cmd.k366": "运行失败",
        "cmd.k367": "运行总览",
        "cmd.k368": "运行总览 · 常用命令 · 执行审计",
        "cmd.k369": "返回原命令",
        "cmd.k370": "连接中断，重连中…",
        "cmd.k371": "追加系统提示词",
        "cmd.k372": "退出 ",
        "cmd.k373": "退出 shell / EOF",
        "cmd.k374": "退出/EOF",
        "cmd.k375": "退出码 ",
        "cmd.k376": "退格",
        "cmd.k377": "逗号分隔，如 build, fe",
        "cmd.k378": "邮件",
        "cmd.k379": "部分命令未安装。点击查看安装建议",
        "cmd.k380": "配置",
        "cmd.k381": "重命名/移动",
        "cmd.k382": "重连中…",
        "cmd.k383": "链完整 · ",
        "cmd.k384": "顶层分组",
        "cmd.k385": "（共 ",
        "cmd.k386": "（危险命令，执行前弹窗确认）",
        "cmd.k387": "（危险命令，执行前确认）",
        "cmd.k388": "（含参数，执行时逐一填写）",
        "cmd.k389": "（工作目录：",
        "cmd.k390": "（当前）",
        "cmd.k391": "（无命令——从 AI 消息识别收藏，或点「＋ 新建命令」）",
        "cmd.k392": "（无活跃会话——点「＋ 新终端」开一个 shell，或执行一条命令）",
        "cmd.k393": "（无输出）",
        "cmd.k394": "（暂无执行记录）",
        "cmd.k395": "（更多终端/命令，还有 ",
        "cmd.k396": "（未分组）",
        "cmd.k397": "（没有在跑的 bash 命令；agent 会话执行命令时自动出现）",
        "cmd.k398": "（点击切换）",
        "cmd.k399": "（订阅前已开始）",
        "cmd.k400": "（顶层）",
        "cmd.k401": "＋ 收藏",
        "cmd.k402": "＋ 收藏到常用命令",
        "cmd.k403": "＋ 新分组",
        "cmd.k404": "＋ 新建",
        "cmd.k405": "＋ 新建分组（树形分组整理命令）",
        "cmd.k406": "＋ 新建命令",
        "cmd.k407": "＋ 新建命令（保存后出现在命令列表对应分组）",
        "cmd.k408": "＋ 新终端",
        "cmd.k409": "＋ 新终端：再开一个 shell（目录 = 当前终端 📁 实时路径）",
        "cmd.k410": "＋ 新终端：开一个交互式 shell（无沙箱）",
        "cmd.k411": "＋命令",
        "cmd.k412": "＋子组",
        "cmd.k413": "：共 ",
        "cmd.k414": "：按标签过滤（再点取消）",
        "cmd.k415": "🧩 停靠示例",
        "cmd.k1": " · ⚠ 危险: ",
        "cmd.k2": " · 参数: {",
        "cmd.k3": " · 已安装（PATH/项目 bin）",
        "cmd.k4": " · 已执行 ",
        "cmd.k5": " · 截断",
        "cmd.k6": " · 无沙箱",
        "cmd.k7": " · 点行看详情",
        "cmd.k8": " · 耗时 ",
        "cmd.k9": " · 输出已截断",
        "cmd.k10": " · 🖥 终端 ",
        "cmd.k11": " 个在跑",
        "cmd.k12": " 个未显示）",
        "cmd.k13": " 个未显示），点开列表切换",
        "cmd.k14": " 命令名 / 识别时全文扫描",
        "cmd.k15": " 已在 aiti-cmd 窗口打开",
        "cmd.k16": " 并发）",
        "cmd.k17": " 排队）",
        "cmd.k18": " 未安装（PATH/项目 bin 中找不到）",
        "cmd.k19": " 条",
        "cmd.k20": " 条 · 点击执行",
        "cmd.k21": " 条哈希",
        "cmd.k22": " 条在跑",
        "cmd.k23": " 条，失败 ",
        "cmd.k24": " 次",
        "cmd.k25": " 终止）",
        "cmd.k26": " 终止） · ",
        "cmd.k27": "%），最近 ",
        "cmd.k28": "ABC 全键",
        "cmd.k29": "AI 助手",
        "cmd.k30": "AITI 调试器",
        "cmd.k31": "ASR 自愈",
        "cmd.k32": "Alt 锁：点一次锁定，再按字母/符号键发 Alt+键（ESC 前缀）、按方向键发 Alt+方向",
        "cmd.k33": "CTRL/SHIFT/ALT/WIN 锁 + 键 = 组合键",
        "cmd.k34": "Ctrl 锁：点一次锁定，再按字母键发 Ctrl+字母、按方向键发 Ctrl+方向（按词移动）",
        "cmd.k35": "JSX 示例",
        "cmd.k36": "JSX 示例面板",
        "cmd.k37": "SHIFT 锁：点一次锁定，再按字母=大写（如 grep -E）、数字=上档符号、方向键=Shift+方向（选择）",
        "cmd.k38": "WIN/Meta 锁：点一次锁定，再按键=ESC 前缀（终端 Meta 键，同 ALT 语义；部分程序区分绑定）",
        "cmd.k39": "agent 会话",
        "cmd.k40": "agent 命令",
        "cmd.k41": "aiti-cmd：运行中 / 命令收藏 / 终端",
        "cmd.k42": "cwd（缺省=当前会话目录）",
        "cmd.k43": "demo 标记",
        "cmd.k44": "demo 横幅测试",
        "cmd.k45": "demo 自检",
        "cmd.k46": "demo 自检面板",
        "cmd.k47": "demo 自检页面",
        "cmd.k48": "demo-lazy：点击时才加载 bundle（懒加载 v2 样板）",
        "cmd.k49": "shell 由 aiti-cmd 承载 · 24h 会话",
        "cmd.k50": "… 还有 ",
        "cmd.k51": "… 连接中",
        "cmd.k52": "← 返回: ",
        "cmd.k53": "← 返回总览",
        "cmd.k54": "↓底",
        "cmd.k55": "↻ 刷新",
        "cmd.k56": "⇱ 转到页签",
        "cmd.k57": "⇲ 拉回窗口",
        "cmd.k58": "▶ 单独执行",
        "cmd.k59": "▶ 执行此命令",
        "cmd.k60": "● 运行中",
        "cmd.k61": "⟳ 回放中",
        "cmd.k62": "。点击查看/收藏（不会直接执行）",
        "cmd.k63": "」及其子分组？组内命令将移入未分组",
        "cmd.k64": "」标记为危险命令。\n创建定时计划后到点将不经确认直接执行，确认继续？",
        "cmd.k65": "」（默认每天9点，到 ⏰调度 页修改并批准）",
        "cmd.k66": "一次性环境：系统只读，/tmp、$HOME 可写但退出即丢",
        "cmd.k67": "上/下翻（终端）",
        "cmd.k68": "上一条 / 下一条命令历史",
        "cmd.k69": "上一条历史/上移",
        "cmd.k70": "上级分组",
        "cmd.k71": "上翻",
        "cmd.k72": "上翻 / 下翻一页",
        "cmd.k73": "下一条历史/下移",
        "cmd.k74": "下翻",
        "cmd.k75": "不参与智能提示",
        "cmd.k76": "不隔离文件系统/网络，仅限可信命令",
        "cmd.k77": "中断",
        "cmd.k78": "中断当前命令（SIGINT）",
        "cmd.k79": "临时可写盘（退出即丢）",
        "cmd.k80": "临时盘",
        "cmd.k81": "任务",
        "cmd.k82": "会话 ",
        "cmd.k83": "会话已停止（被 ",
        "cmd.k84": "会话已结束",
        "cmd.k85": "会话已结束（退出码 ",
        "cmd.k86": "位于：",
        "cmd.k87": "作为 aiti-ai-input 智能提示（输入联想/补全）的来源；关掉后输入时不再提示此命令",
        "cmd.k88": "作为 aiti-ai-input 输入联想/补全的来源（默认开）",
        "cmd.k89": "保存",
        "cmd.k90": "保存修改",
        "cmd.k91": "保存后出现在命令列表对应分组",
        "cmd.k92": "保存失败",
        "cmd.k93": "保存自定义命令词到词库（消息识别立即生效）",
        "cmd.k94": "保存词库",
        "cmd.k95": "停靠示例",
        "cmd.k96": "停靠示例（浮窗态）",
        "cmd.k97": "光标到行尾",
        "cmd.k98": "光标到行首",
        "cmd.k99": "光标到行首 / 行尾",
        "cmd.k100": "光标左 / 右移",
        "cmd.k101": "全屏",
        "cmd.k102": "全屏 / 退出全屏",
        "cmd.k103": "全屏 / 退出全屏 (Ctrl+Shift+F)",
        "cmd.k104": "全屏 / 退出全屏（Ctrl+Shift+F）",
        "cmd.k105": "全部",
        "cmd.k106": "全部会话",
        "cmd.k107": "全部：取消标签过滤",
        "cmd.k108": "全键盘：字母 / 数字 / 符号 / 空格 —— Ctrl 锁 + 字母键 = Ctrl+字母",
        "cmd.k109": "关闭",
        "cmd.k110": "关闭 (Esc)",
        "cmd.k111": "关闭虚拟键盘 (Esc)",
        "cmd.k112": "关闭词库",
        "cmd.k113": "关闭面板",
        "cmd.k114": "内置 ",
        "cmd.k115": "出错/被终止",
        "cmd.k116": "分组",
        "cmd.k117": "分组名",
        "cmd.k118": "切换终端全屏",
        "cmd.k119": "切换虚拟键盘",
        "cmd.k120": "创建",
        "cmd.k121": "创建失败：",
        "cmd.k122": "创建终端失败",
        "cmd.k123": "删到行首",
        "cmd.k124": "删词",
        "cmd.k125": "删除分组",
        "cmd.k126": "删除分组「",
        "cmd.k127": "删除分组时组内命令自动移入未分组",
        "cmd.k128": "删除到行首 / 删除到行尾",
        "cmd.k129": "删除前一个单词",
        "cmd.k130": "删除此命令",
        "cmd.k131": "到命令页管理（新建/编辑/分组/标签）",
        "cmd.k132": "刷新历史记录",
        "cmd.k133": "功能键 F1",
        "cmd.k134": "功能键 F10",
        "cmd.k135": "功能键 F11",
        "cmd.k136": "功能键 F12",
        "cmd.k137": "功能键 F2",
        "cmd.k138": "功能键 F3",
        "cmd.k139": "功能键 F4",
        "cmd.k140": "功能键 F5",
        "cmd.k141": "功能键 F6",
        "cmd.k142": "功能键 F7",
        "cmd.k143": "功能键 F8",
        "cmd.k144": "功能键 F9",
        "cmd.k145": "加载中…",
        "cmd.k146": "危险命令执行前确认",
        "cmd.k147": "危险命令：",
        "cmd.k148": "历史",
        "cmd.k149": "历史：执行审计（append-only 留存）",
        "cmd.k150": "参与智能提示",
        "cmd.k151": "参数 ",
        "cmd.k152": "参考 Termux extra-keys",
        "cmd.k153": "反向搜索历史",
        "cmd.k154": "反向搜索命令历史",
        "cmd.k155": "取消",
        "cmd.k156": "取消 / 进入 vi 模式",
        "cmd.k157": "取消排队",
        "cmd.k158": "只终止这条 bash 命令（agent 收到错误后继续思考；同会话并发 bash 会一起终止）",
        "cmd.k159": "只终止这条命令（不 abort 整个 turn）",
        "cmd.k160": "只读",
        "cmd.k161": "只读 + 断网",
        "cmd.k162": "只读+断网",
        "cmd.k163": "右移",
        "cmd.k164": "右键 / Ctrl+Shift+C / Ctrl+Insert",
        "cmd.k165": "同类:",
        "cmd.k166": "名称",
        "cmd.k167": "命令",
        "cmd.k168": "命令 / 路径补全",
        "cmd.k169": "命令/参数/输出/退出码/时间/来源——安全审计",
        "cmd.k170": "命令「",
        "cmd.k171": "命令内容为空，无法收藏",
        "cmd.k172": "命令可识别",
        "cmd.k173": "命令已停止（出错/被终止）",
        "cmd.k174": "命令已完成",
        "cmd.k175": "命令管理",
        "cmd.k176": "命令：常用命令列表（执行/复制/编辑/删除）",
        "cmd.k177": "回车",
        "cmd.k178": "图片预览",
        "cmd.k179": "在新窗口/新标签页中打开（外部网站）",
        "cmd.k180": "在此分组下新建命令",
        "cmd.k181": "在此分组下新建子分组",
        "cmd.k182": "复制",
        "cmd.k183": "复制命令内容到剪贴板并打开「新建命令」预填（可改后另存）",
        "cmd.k184": "复制选中的终端文本（Ctrl+C 是中断，不能用来复制）",
        "cmd.k185": "外部会话",
        "cmd.k186": "如：构建 / 部署",
        "cmd.k187": "子",
        "cmd.k188": "安装建议：",
        "cmd.k189": "完成",
        "cmd.k190": "定时",
        "cmd.k191": "定时命令",
        "cmd.k192": "定时执行：创建调度计划（预填本条命令）",
        "cmd.k193": "工作区页签 · ",
        "cmd.k194": "工作目录",
        "cmd.k195": "工作目录：",
        "cmd.k196": "工具条按钮",
        "cmd.k197": "左移",
        "cmd.k198": "已停止",
        "cmd.k199": "已创建待确认计划「",
        "cmd.k200": "已加入队列，等待执行（位置 ",
        "cmd.k201": "已收藏",
        "cmd.k202": "已清理",
        "cmd.k203": "已结束",
        "cmd.k204": "已结束（服务器已清理记录）",
        "cmd.k205": "已退出",
        "cmd.k206": "常用",
        "cmd.k207": "常用:",
        "cmd.k208": "常用命令",
        "cmd.k209": "常用命令词库（消息识别用）",
        "cmd.k210": "常用快捷键",
        "cmd.k211": "常用快捷键帮助",
        "cmd.k212": "常用键：方向 / 编辑 / Ctrl 组合 / 常用符号",
        "cmd.k213": "开启中…",
        "cmd.k214": "引用",
        "cmd.k215": "归档查看器",
        "cmd.k216": "当前：",
        "cmd.k217": "当前：🤖 agent 在跑 / 🖥 终端在跑",
        "cmd.k218": "循环终端窗口大小",
        "cmd.k219": "总览",
        "cmd.k220": "总览：agent 运行中命令 / 终端会话一览",
        "cmd.k221": "懒加载示例小组件",
        "cmd.k222": "手动",
        "cmd.k223": "打开",
        "cmd.k224": "打开链接？",
        "cmd.k225": "执行",
        "cmd.k226": "执行以下命令并汇报结果",
        "cmd.k227": "执行前弹窗确认",
        "cmd.k228": "执行前是否弹窗确认（危险命令建议开启）",
        "cmd.k229": "执行审计（append-only 留存）",
        "cmd.k230": "执行确认",
        "cmd.k231": "拉回窗口",
        "cmd.k232": "拉回窗口：终端视图移回 aiti-cmd 弹窗（页签显示占位）",
        "cmd.k233": "拉回窗口：终端视图移回 aiti-cmd 弹窗（页签显示占位；仅页签模式有）",
        "cmd.k234": "挂起",
        "cmd.k235": "挂起当前任务（后台）",
        "cmd.k236": "按词移动光标（readline）",
        "cmd.k237": "排队中",
        "cmd.k238": "排队中 (",
        "cmd.k239": "排队中（并发已满，可在「运行中」列表关闭旧终端）",
        "cmd.k240": "接管到页签",
        "cmd.k241": "提示词",
        "cmd.k242": "搜索会话",
        "cmd.k243": "搜索命令…",
        "cmd.k244": "支持 {参数} 占位符，执行时填入",
        "cmd.k245": "收藏",
        "cmd.k246": "收藏到哪个分组",
        "cmd.k247": "收藏名称（默认=命令文本）",
        "cmd.k248": "收藏后可在 ⚡ 命令面板随时一键调用（不依赖 AI）；执行记录全部写入审计日志。",
        "cmd.k249": "收藏命令",
        "cmd.k250": "收藏完整命令到常用命令",
        "cmd.k251": "收藏库",
        "cmd.k252": "收藏选中的文本（可只收藏命令片段）",
        "cmd.k253": "收起虚拟键盘",
        "cmd.k254": "改动即时生效",
        "cmd.k255": "文件系统只读且无网络——最高隔离，适合不信任命令",
        "cmd.k256": "文件系统只读，改动不落盘；工作目录真实可写",
        "cmd.k257": "文档",
        "cmd.k258": "文档中心",
        "cmd.k259": "新会话",
        "cmd.k260": "新增词后，消息识别会立即用新词扫描",
        "cmd.k261": "新建 pi-web 会话",
        "cmd.k262": "新建 pi-web 会话失败：宿主新会话通道不可用",
        "cmd.k263": "新建 pi-web 会话失败：当前终端会话没有工作目录",
        "cmd.k264": "新建 pi-web 会话：打开新 agent 会话并 @ 当前终端实时路径",
        "cmd.k265": "新建 shell",
        "cmd.k266": "新建分组",
        "cmd.k267": "新建命令",
        "cmd.k268": "新建：再开一个 shell（目录 = 当前终端 📁 实时路径）",
        "cmd.k269": "无沙箱",
        "cmd.k270": "无沙箱（完全信任）· 默认",
        "cmd.k271": "显示环境",
        "cmd.k272": "智能提示",
        "cmd.k273": "智能提示参与",
        "cmd.k274": "更多终端",
        "cmd.k275": "更多终端/命令（还有 ",
        "cmd.k276": "服务",
        "cmd.k277": "未分组",
        "cmd.k278": "未知",
        "cmd.k279": "未知错误",
        "cmd.k280": "本帮助面板",
        "cmd.k281": "来源分布",
        "cmd.k282": "查看 / 收藏 / 编辑，不会直接执行",
        "cmd.k283": "标签",
        "cmd.k284": "校验失败",
        "cmd.k285": "校验审计链完整性（哈希链）",
        "cmd.k286": "校验链",
        "cmd.k287": "桥探针",
        "cmd.k288": "桥连接探针（临时诊断：采集 SSE/生命周期事件）",
        "cmd.k289": "模型可用性",
        "cmd.k290": "模型向导",
        "cmd.k291": "模型检查",
        "cmd.k292": "模型管理",
        "cmd.k293": "模型配置导入",
        "cmd.k294": "正在创建终端会话…",
        "cmd.k295": "正在启动 shell…",
        "cmd.k296": "正在查看相关命令",
        "cmd.k297": "此终端已在工作区页签打开（右侧文件区）",
        "cmd.k298": "此面板用于 查看 / 收藏 / 编辑 命令，不会直接执行。",
        "cmd.k299": "沙箱",
        "cmd.k300": "消息识别",
        "cmd.k301": "清屏",
        "cmd.k302": "滚动到底部",
        "cmd.k303": "滚动到底部：跳到最新输出（上翻阅读时不会打扰）",
        "cmd.k304": "点击查看/收藏此命令（不会直接执行）",
        "cmd.k305": "点击查看/管理此命令",
        "cmd.k306": "点选元素",
        "cmd.k307": "用量",
        "cmd.k308": "直接执行",
        "cmd.k309": "看板",
        "cmd.k310": "确定",
        "cmd.k311": "确认执行危险命令",
        "cmd.k312": "示例小组件",
        "cmd.k313": "空格",
        "cmd.k314": "管理 →",
        "cmd.k315": "管理模型",
        "cmd.k316": "篡改于 ",
        "cmd.k317": "粘贴剪贴板到终端",
        "cmd.k318": "系统只读（工作目录可写）",
        "cmd.k319": "终止",
        "cmd.k320": "终止中…",
        "cmd.k321": "终止中（已发 SIGTERM，最多 3s 后强制 KILL）",
        "cmd.k322": "终止信号已发送，等待进程退出…",
        "cmd.k323": "终止命令",
        "cmd.k324": "终止命令（杀进程）",
        "cmd.k325": "终端",
        "cmd.k326": "终端会话",
        "cmd.k327": "终端功能键（虚拟键盘「常用/全键」底部一行，mc / htop 等 TUI 用）",
        "cmd.k328": "终端同时只能在一处显示；接管后窗口内该终端变为占位",
        "cmd.k329": "终端同时只能在一处显示；页签内已变为占位",
        "cmd.k330": "终端窗口大小（列×行）：自适应容器，或固定标准尺寸——小屏也能看到完整终端，超出可滚动",
        "cmd.k331": "编辑分组",
        "cmd.k332": "编辑命令",
        "cmd.k333": "编辑命令（名称/命令/cwd/标签/分组/沙箱/执行确认/智能提示）",
        "cmd.k334": "缺省 = 命令文本",
        "cmd.k335": "缺省 = 当前会话目录",
        "cmd.k336": "网络错误",
        "cmd.k337": "耗时 ",
        "cmd.k338": "联想",
        "cmd.k339": "聚合 / 多key运行状态",
        "cmd.k340": "自动·切换前",
        "cmd.k341": "自动·登出前",
        "cmd.k342": "自动·登录前",
        "cmd.k343": "自定义命令词（每行一个，如：mytool / just get / pnpm-dlx）",
        "cmd.k344": "自适应",
        "cmd.k345": "虚拟键盘",
        "cmd.k346": "虚拟键盘有「⌨ 常用 / ABC 全键」两档：常用 = 方向/编辑/Ctrl 组合；全键 = 完整字母数字符号键盘（含空格，可输入命令全文）。CTRL/SHIFT/ALT/WIN 四把锁，点一次锁定、再按任意键自动解锁（与物理键盘同感）：CTRL 锁 + 字母 = Ctrl+字母（如 a→Ctrl+A 行首）、+ 方向键 = 按词移动（readline）；SHIFT 锁 + 字母 = 大写（grep -E 必需）、+ 数字 = 上档符号、+ 方向键 = Shift+方向（选择）；ALT/WIN 锁 + 字母/符号 = ESC 前缀（Meta 键），+ 方向键 = Alt+方向（xterm \x1b[1;3x 序列，程序可区分是否带 Alt）。注意：终端转义协议不区分左右 Shift/Alt（只有 GUI 程序能区分），所以只有一把 SHIFT/ALT 锁。终端聚焦时 Ctrl+Shift+F 全屏、Ctrl+Shift+K 键盘、Ctrl+Shift+S 循环窗口大小。",
        "cmd.k347": "虚拟键盘：方向 / Tab / Esc / Ctrl / 常用符号（Ctrl+Shift+K）",
        "cmd.k348": "虚拟键盘：方向键 / Tab / Esc / Ctrl / 常用符号 (Ctrl+Shift+K)",
        "cmd.k349": "行尾",
        "cmd.k350": "行首",
        "cmd.k351": "行首 / 行尾",
        "cmd.k352": "补全",
        "cmd.k353": "设备互连",
        "cmd.k354": "设备互连面板",
        "cmd.k355": "词库",
        "cmd.k356": "词库：常用命令名（AI 消息识别用，全文扫描）",
        "cmd.k357": "语音流量",
        "cmd.k358": "语音识别引擎",
        "cmd.k359": "调试",
        "cmd.k360": "转到工作区页签",
        "cmd.k361": "转到页签失败：",
        "cmd.k362": "转到页签失败：宿主建页签能力缺席（pi-web.ui.onOpenTerminal）",
        "cmd.k363": "转到页签失败：此终端会话没有工作目录，无法定位到项目页签",
        "cmd.k364": "转到页签：终端移到右侧文件区的工作区终端页签（弹窗内变占位）",
        "cmd.k365": "运行中",
        "cmd.k366": "运行失败",
        "cmd.k367": "运行总览",
        "cmd.k368": "运行总览 · 常用命令 · 执行审计",
        "cmd.k369": "返回原命令",
        "cmd.k370": "连接中断，重连中…",
        "cmd.k371": "追加系统提示词",
        "cmd.k372": "退出 ",
        "cmd.k373": "退出 shell / EOF",
        "cmd.k374": "退出/EOF",
        "cmd.k375": "退出码 ",
        "cmd.k376": "退格",
        "cmd.k377": "逗号分隔，如 build, fe",
        "cmd.k378": "邮件",
        "cmd.k379": "部分命令未安装。点击查看安装建议",
        "cmd.k380": "配置",
        "cmd.k381": "重命名/移动",
        "cmd.k382": "重连中…",
        "cmd.k383": "链完整 · ",
        "cmd.k384": "顶层分组",
        "cmd.k385": "（共 ",
        "cmd.k386": "（危险命令，执行前弹窗确认）",
        "cmd.k387": "（危险命令，执行前确认）",
        "cmd.k388": "（含参数，执行时逐一填写）",
        "cmd.k389": "（工作目录：",
        "cmd.k390": "（当前）",
        "cmd.k391": "（无命令——从 AI 消息识别收藏，或点「＋ 新建命令」）",
        "cmd.k392": "（无活跃会话——点「＋ 新终端」开一个 shell，或执行一条命令）",
        "cmd.k393": "（无输出）",
        "cmd.k394": "（暂无执行记录）",
        "cmd.k395": "（更多终端/命令，还有 ",
        "cmd.k396": "（未分组）",
        "cmd.k397": "（没有在跑的 bash 命令；agent 会话执行命令时自动出现）",
        "cmd.k398": "（点击切换）",
        "cmd.k399": "（订阅前已开始）",
        "cmd.k400": "（顶层）",
        "cmd.k401": "＋ 收藏",
        "cmd.k402": "＋ 收藏到常用命令",
        "cmd.k403": "＋ 新分组",
        "cmd.k404": "＋ 新建",
        "cmd.k405": "＋ 新建分组（树形分组整理命令）",
        "cmd.k406": "＋ 新建命令",
        "cmd.k407": "＋ 新建命令（保存后出现在命令列表对应分组）",
        "cmd.k408": "＋ 新终端",
        "cmd.k409": "＋ 新终端：再开一个 shell（目录 = 当前终端 📁 实时路径）",
        "cmd.k410": "＋ 新终端：开一个交互式 shell（无沙箱）",
        "cmd.k411": "＋命令",
        "cmd.k412": "＋子组",
        "cmd.k413": "：共 ",
        "cmd.k414": "：按标签过滤（再点取消）",
        "cmd.k415": "🧩 停靠示例",
        "cmd.app.favorites": "命令收藏",
        "cmd.app.running": "运行中",
        "cmd.app.terminal": "终端",
        "cmd.app.favorites.title": "命令库：分组 / 标签 / 词库 / 一键执行",
        "cmd.app.running.title": "运行态势：终端会话 / agent 命令 / 执行记录",
        "cmd.app.terminal.title": "真终端：交互输入 / 多会话 / 收藏命令",
        "cmd.app.switch": "切换到该应用",
        "cmd.app.close": "关闭窗口",
        "cmd.app.saveFavorite": "收藏当前命令",
        "cmd.app.reopen": "重新执行",
        "cmd.app.terminal.empty": "还没有打开终端——新建一个 shell，或从「运行中」/「命令收藏」里点开",
        "cmd.app.running.all": "全部",
        "cmd.app.running.subtitle": "运行中 / 全部 / 记录",
        "cmd.app.missing": "会话已不存在",
        "cmd.app.missingTitle": "这个终端会话已不存在",
        "cmd.app.missingHint": "常见原因：扩展热重载 / pi-web 重启会重建执行引擎（所有 PTY 会话随之结束），或会话已超期清理。新开一个终端即可。",
        "cmd.app.entry.title": "命令运行态势（有运行中命令时高亮，点击查看）",
        "cmd.app.sink.label": "命令收藏",
        "cmd.app.sink.saved": "已收藏为命令：",
        "cmd.app.openFavorites": "打开命令收藏",
        "it.aiti-cmd-favorites.label": "aiti-cmd 命令收藏",
        "it.aiti-cmd-running.label": "aiti-cmd 运行中",
        "it.aiti-cmd-terminal.label": "aiti-cmd 运行终端",
        "it.aiti-cmd-detail.label": "aiti-cmd 命令详情",
        "ext.displayName": "命令面板",      "cmd.open.label": "命令",
      "cmd.open.title": "aiti-cmd：运行中 / 命令收藏 / 终端",
      },
      en: {
        "cmd.k1": "· ⚠ Dangerous: ",
        "cmd.k2": "· args: {",
        "cmd.k3": "· installed (PATH/project bin)",
        "cmd.k4": "· ran ",
        "cmd.k5": "· truncated",
        "cmd.k6": "· no sandbox",
        "cmd.k7": "· click a row for details",
        "cmd.k8": "· took ",
        "cmd.k9": "· output truncated",
        "cmd.k10": "· 🖥 terminal ",
        "cmd.k11": "running",
        "cmd.k12": " hidden)",
        "cmd.k13": " hidden), open the list to switch",
        "cmd.k14": " command names / full-text scan for recognition",
        "cmd.k15": "already opened in the aiti-cmd window",
        "cmd.k16": "concurrency)",
        "cmd.k17": "queued)",
        "cmd.k18": "not installed (not found on PATH/project bin)",
        "cmd.k19": "entries",
        "cmd.k20": "entries · click to run",
        "cmd.k21": "hash entries",
        "cmd.k22": "running",
        "cmd.k23": "entries, failed ",
        "cmd.k24": "times",
        "cmd.k25": "killed) · ",
        "cmd.k26": "killed) · ",
        "cmd.k27": "%), last ",
        "cmd.k28": "ABC full keyboard",
        "cmd.k29": "AI Helper",
        "cmd.k30": "AITI debugger",
        "cmd.k31": "ASR self-heal",
        "cmd.k32": "ALT lock: tap once to latch, then letters/symbols send Alt+key (ESC prefix), arrows send Alt+arrow",
        "cmd.k33": "CTRL/SHIFT/ALT/WIN lock + key = combo",
        "cmd.k34": "CTRL lock: tap once to latch, then letters send Ctrl+letter, arrows send Ctrl+arrow (word-wise move)",
        "cmd.k35": "JSX demo",
        "cmd.k36": "JSX demo panel",
        "cmd.k37": "SHIFT lock: tap once to latch, then letters = uppercase (e.g. grep -E), digits = shifted symbols, arrows = Shift+arrow (selection)",
        "cmd.k38": "WIN/Meta lock: tap once to latch, then keys send ESC prefix (terminal Meta key, same semantics as ALT; some programs bind it differently)",
        "cmd.k39": "agent sessions",
        "cmd.k40": "agent commands",
        "cmd.k41": "aiti-cmd: running / saved commands / terminal",
        "cmd.k42": "cwd (defaults to the current session directory)",
        "cmd.k43": "demo flag",
        "cmd.k44": "demo banner test",
        "cmd.k45": "demo self-check",
        "cmd.k46": "demo self-check panel",
        "cmd.k47": "demo self-check page",
        "cmd.k48": "demo-lazy: bundle loads on click (lazy-load v2 sample)",
        "cmd.k49": "shell hosted by aiti-cmd · 24h session",
        "cmd.k50": "… and ",
        "cmd.k51": "… connecting",
        "cmd.k52": "← Back: ",
        "cmd.k53": "← Back to overview",
        "cmd.k54": "↓End",
        "cmd.k55": "↻ Refresh",
        "cmd.k56": "⇱ To tab",
        "cmd.k57": "⇲ Pull back",
        "cmd.k58": "▶ Run standalone",
        "cmd.k59": "▶ Run this command",
        "cmd.k60": "● Running",
        "cmd.k61": "⟳ Replaying",
        "cmd.k62": ". Click to view/save (never runs directly)",
        "cmd.k63": "\" and its subgroups? Commands inside will move to Ungrouped",
        "cmd.k64": "\" as a dangerous command.\nScheduled plans will run it at trigger time without confirmation. Continue?",
        "cmd.k65": "\" (default daily 9am; edit and approve on the ⏰ Schedule page)",
        "cmd.k66": "Ephemeral environment: read-only system; /tmp and $HOME writable but discarded on exit",
        "cmd.k67": "scroll up/down (terminal)",
        "cmd.k68": "previous / next command in history",
        "cmd.k69": "prev history / move up",
        "cmd.k70": "Parent group",
        "cmd.k71": "scroll up",
        "cmd.k72": "page up / down",
        "cmd.k73": "next history / move down",
        "cmd.k74": "scroll down",
        "cmd.k75": "Exclude from smart suggestions",
        "cmd.k76": "No fs/network isolation — trusted commands only",
        "cmd.k77": "interrupt",
        "cmd.k78": "interrupt the current command (SIGINT)",
        "cmd.k79": "Tmp writable disk (discarded on exit)",
        "cmd.k80": "Tmp disk",
        "cmd.k81": "Subagent tasks",
        "cmd.k82": "session ",
        "cmd.k83": "session stopped (by ",
        "cmd.k84": "session finished",
        "cmd.k85": "session finished (exit code ",
        "cmd.k86": "located at:",
        "cmd.k87": "Source for aiti-ai-input smart suggestions (input hints/completion); when off, this command is no longer suggested while typing",
        "cmd.k88": "Source for aiti-ai-input input hints/completion (on by default)",
        "cmd.k89": "Save",
        "cmd.k90": "Save changes",
        "cmd.k91": "After saving it appears in the command list under its group",
        "cmd.k92": "Save failed",
        "cmd.k93": "Save custom command words to the lexicon (message recognition picks them up immediately)",
        "cmd.k94": "Save lexicon",
        "cmd.k95": "🧩 Dock demo",
        "cmd.k96": "Dock demo (floating)",
        "cmd.k97": "cursor to line end",
        "cmd.k98": "cursor to line start",
        "cmd.k99": "cursor to line start / end",
        "cmd.k100": "cursor left / right",
        "cmd.k101": "Fullscreen",
        "cmd.k102": "Toggle fullscreen",
        "cmd.k103": "Toggle fullscreen (Ctrl+Shift+F)",
        "cmd.k104": "Toggle fullscreen (Ctrl+Shift+F)",
        "cmd.k105": "All",
        "cmd.k106": "All Sessions",
        "cmd.k107": "All: clear tag filter",
        "cmd.k108": "Full keyboard: letters / digits / symbols / space — CTRL lock + letter = Ctrl+letter",
        "cmd.k109": "Close",
        "cmd.k110": "Close (Esc)",
        "cmd.k111": "Hide virtual keyboard (Esc)",
        "cmd.k112": "Close lexicon",
        "cmd.k113": "Close panel",
        "cmd.k114": "built-in ",
        "cmd.k115": "error/killed",
        "cmd.k116": "Group",
        "cmd.k117": "Group name",
        "cmd.k118": "Toggle terminal fullscreen",
        "cmd.k119": "Toggle virtual keyboard",
        "cmd.k120": "Create",
        "cmd.k121": "Create failed: ",
        "cmd.k122": "Failed to create terminal",
        "cmd.k123": "delete to line start",
        "cmd.k124": "delete word",
        "cmd.k125": "Delete group",
        "cmd.k126": "Delete group \"",
        "cmd.k127": "Commands in a deleted group move to Ungrouped automatically",
        "cmd.k128": "delete to line start / end",
        "cmd.k129": "delete previous word",
        "cmd.k130": "Delete this command",
        "cmd.k131": "Manage on the commands page (new/edit/groups/tags)",
        "cmd.k132": "Refresh execution history",
        "cmd.k133": "Function key F1",
        "cmd.k134": "Function key F10",
        "cmd.k135": "Function key F11",
        "cmd.k136": "Function key F12",
        "cmd.k137": "Function key F2",
        "cmd.k138": "Function key F3",
        "cmd.k139": "Function key F4",
        "cmd.k140": "Function key F5",
        "cmd.k141": "Function key F6",
        "cmd.k142": "Function key F7",
        "cmd.k143": "Function key F8",
        "cmd.k144": "Function key F9",
        "cmd.k145": "Loading…",
        "cmd.k146": "Confirm before running dangerous commands",
        "cmd.k147": "Dangerous command: ",
        "cmd.k148": "History",
        "cmd.k149": "History: execution audit (append-only)",
        "cmd.k150": "Include in smart suggestions",
        "cmd.k151": "args ",
        "cmd.k152": "See Termux extra-keys",
        "cmd.k153": "reverse-search history",
        "cmd.k154": "reverse-search command history",
        "cmd.k155": "Cancel",
        "cmd.k156": "cancel / enter vi mode",
        "cmd.k157": "Unqueue",
        "cmd.k158": "Kill only this bash command (the agent sees the error and keeps thinking; concurrent bashes in the same session are killed too)",
        "cmd.k159": "Kill only this command (does not abort the whole turn)",
        "cmd.k160": "Read-only",
        "cmd.k161": "Read-only + offline",
        "cmd.k162": "Read-only+offline",
        "cmd.k163": "cursor right",
        "cmd.k164": "Right-click / Ctrl+Shift+C / Ctrl+Insert",
        "cmd.k165": "Similar: ",
        "cmd.k166": "Name",
        "cmd.k167": "Commands",
        "cmd.k168": "command / path completion",
        "cmd.k169": "command/args/output/exit code/time/source — security audit",
        "cmd.k170": "command \"",
        "cmd.k171": "Command text is empty — nothing to save",
        "cmd.k172": "commands recognizable",
        "cmd.k173": "Command stopped (error/killed)",
        "cmd.k174": "Command finished",
        "cmd.k175": "Command manager",
        "cmd.k176": "Commands: saved command list (run/copy/edit/delete)",
        "cmd.k177": "Enter",
        "cmd.k178": "Image preview",
        "cmd.k179": "Open in a new window/tab (external site)",
        "cmd.k180": "New command in this group",
        "cmd.k181": "New subgroup in this group",
        "cmd.k182": "Copy",
        "cmd.k183": "Copy the command to the clipboard and open \"New command\" prefilled (edit then save as new)",
        "cmd.k184": "Copy selected terminal text (Ctrl+C interrupts — it does not copy)",
        "cmd.k185": "External Sessions",
        "cmd.k186": "e.g. build / deploy",
        "cmd.k187": "sub",
        "cmd.k188": "Install suggestion: ",
        "cmd.k189": "done",
        "cmd.k190": "Schedule",
        "cmd.k191": "Scheduled commands",
        "cmd.k192": "Schedule: create a plan (prefilled with this command)",
        "cmd.k193": "workspace tab · ",
        "cmd.k194": "Working directory",
        "cmd.k195": "Working directory: ",
        "cmd.k196": "Toolbar buttons",
        "cmd.k197": "cursor left",
        "cmd.k198": "stopped",
        "cmd.k199": "Created plan pending approval: \"",
        "cmd.k200": "Queued for execution (position ",
        "cmd.k201": "Saved",
        "cmd.k202": "cleaned up",
        "cmd.k203": "finished",
        "cmd.k204": "finished (server cleaned up the record)",
        "cmd.k205": "exited",
        "cmd.k206": "Frequent",
        "cmd.k207": "Saved: ",
        "cmd.k208": "Saved commands",
        "cmd.k209": "Saved-command lexicon (for message recognition)",
        "cmd.k210": "Common shortcuts",
        "cmd.k211": "Common shortcuts help",
        "cmd.k212": "Frequent keys: arrows / editing / Ctrl combos / common symbols",
        "cmd.k213": "Starting…",
        "cmd.k214": "Quote reply",
        "cmd.k215": "Archived Viewer",
        "cmd.k216": "Current: ",
        "cmd.k217": "Current: 🤖 agent running / 🖥 terminal running",
        "cmd.k218": "Cycle terminal window size",
        "cmd.k219": "Overview",
        "cmd.k220": "Overview: agent commands / terminal sessions at a glance",
        "cmd.k221": "Lazy sample widget",
        "cmd.k222": "Manual",
        "cmd.k223": "Open",
        "cmd.k224": "Open link?",
        "cmd.k225": "Run",
        "cmd.k226": "Run the following command and report the result",
        "cmd.k227": "Confirm with a dialog before running",
        "cmd.k228": "Whether to confirm with a dialog before running (recommended for dangerous commands)",
        "cmd.k229": "Execution audit (append-only)",
        "cmd.k230": "Run confirmation",
        "cmd.k231": "Pull back",
        "cmd.k232": "Pull back: move the terminal view back into the aiti-cmd window (the tab shows a placeholder)",
        "cmd.k233": "Pull back: move the terminal view back into the aiti-cmd window (the tab shows a placeholder; tab mode only)",
        "cmd.k234": "suspend",
        "cmd.k235": "suspend the current task (background)",
        "cmd.k236": "move cursor by word (readline)",
        "cmd.k237": "queued",
        "cmd.k238": "queued (",
        "cmd.k239": "queued (concurrency full — close old terminals in Running)",
        "cmd.k240": "Take over to tab",
        "cmd.k241": "Prompts",
        "cmd.k242": "Search sessions",
        "cmd.k243": "Search commands…",
        "cmd.k244": "Supports {param} placeholders, filled in at run time",
        "cmd.k245": "Favorite",
        "cmd.k246": "Which group to save to",
        "cmd.k247": "Save name (defaults to the command text)",
        "cmd.k248": "Once saved, run it anytime from the ⚡ commands panel (no AI needed); all runs are written to the audit log.",
        "cmd.k249": "Favorite command",
        "cmd.k250": "Favorite the full command to saved commands",
        "cmd.k251": "Snippet library",
        "cmd.k252": "Favorite the selected text (a command fragment is fine)",
        "cmd.k253": "Hide virtual keyboard",
        "cmd.k254": "Changes take effect immediately",
        "cmd.k255": "Read-only filesystem with no network — maximum isolation, for untrusted commands",
        "cmd.k256": "Read-only filesystem, changes not persisted; the working directory is genuinely writable",
        "cmd.k257": "Docs",
        "cmd.k258": "Doc Center",
        "cmd.k259": "New session",
        "cmd.k260": "After adding words, message recognition scans with them immediately",
        "cmd.k261": "New pi-web session",
        "cmd.k262": "New pi-web session failed: the host's new-session channel is unavailable",
        "cmd.k263": "New pi-web session failed: the current terminal session has no working directory",
        "cmd.k264": "New pi-web session: open a new agent session and @ the terminal's live path",
        "cmd.k265": "New shell",
        "cmd.k266": "New group",
        "cmd.k267": "New command",
        "cmd.k268": "New: open another shell (directory = the current terminal's 📁 live path)",
        "cmd.k269": "No sandbox",
        "cmd.k270": "No sandbox (fully trusted) · default",
        "cmd.k271": "Display env",
        "cmd.k272": "Smart suggestions",
        "cmd.k273": "Smart suggestion participation",
        "cmd.k274": "More terminals",
        "cmd.k275": "More terminals/commands (also ",
        "cmd.k276": "Service",
        "cmd.k277": "Ungrouped",
        "cmd.k278": "Unknown",
        "cmd.k279": "Unknown error",
        "cmd.k280": "this help panel",
        "cmd.k281": "Source distribution",
        "cmd.k282": "view / save / edit — never runs directly",
        "cmd.k283": "Tags",
        "cmd.k284": "Verification failed",
        "cmd.k285": "Verify audit-chain integrity (hash chain)",
        "cmd.k286": "Verify chain",
        "cmd.k287": "Bridge probe",
        "cmd.k288": "Bridge probe (temporary diagnostics: captures SSE/lifecycle events)",
        "cmd.k289": "Model availability",
        "cmd.k290": "Model wizard",
        "cmd.k291": "Model check",
        "cmd.k292": "Model management",
        "cmd.k293": "Model config import",
        "cmd.k294": "Creating terminal session…",
        "cmd.k295": "Starting shell…",
        "cmd.k296": "Viewing related commands",
        "cmd.k297": "This terminal is already open in a workspace tab (right file area)",
        "cmd.k298": "This panel is for viewing / saving / editing commands — it never runs them directly.",
        "cmd.k299": "Sandbox",
        "cmd.k300": "Message recognition",
        "cmd.k301": "clear screen",
        "cmd.k302": "Scroll to bottom",
        "cmd.k303": "Scroll to bottom: jump to the latest output (doesn't disturb while reading back)",
        "cmd.k304": "Click to view/save this command (never runs directly)",
        "cmd.k305": "Click to view/manage this command",
        "cmd.k306": "Pick element",
        "cmd.k307": "Usage report",
        "cmd.k308": "Run directly",
        "cmd.k309": "Board",
        "cmd.k310": "Delete group confirmation",
        "cmd.k311": "Confirm running a dangerous command",
        "cmd.k312": "Sample widget",
        "cmd.k313": "space",
        "cmd.k314": "Manage →",
        "cmd.k315": "Manage models",
        "cmd.k316": "tampered at ",
        "cmd.k317": "paste clipboard into terminal",
        "cmd.k318": "System read-only (working directory writable)",
        "cmd.k319": "kill",
        "cmd.k320": "killing…",
        "cmd.k321": "killing (SIGTERM sent, forced KILL after at most 3s)",
        "cmd.k322": "Termination signal sent, waiting for the process to exit…",
        "cmd.k323": "Kill command",
        "cmd.k324": "Kill command (kills the process)",
        "cmd.k325": "Terminal",
        "cmd.k326": "Terminal sessions",
        "cmd.k327": "Terminal function keys (bottom row of the \"⌨ Frequent / ABC\" virtual keyboard, for mc / htop and other TUIs)",
        "cmd.k328": "A terminal can only show in one place; after take-over the window shows a placeholder",
        "cmd.k329": "A terminal can only show in one place; the tab now shows a placeholder",
        "cmd.k330": "Terminal window size (cols×rows): fit the container, or a fixed standard size — the full terminal stays visible on small screens, overflow scrolls",
        "cmd.k331": "Edit group",
        "cmd.k332": "Edit command",
        "cmd.k333": "Edit command (name/command/cwd/tags/group/sandbox/run confirmation/smart suggestions)",
        "cmd.k334": "defaults to the command text",
        "cmd.k335": "defaults to the current session directory",
        "cmd.k336": "network error",
        "cmd.k337": "took ",
        "cmd.k338": "Suggestions",
        "cmd.k339": "Aggregation / multi-key status",
        "cmd.k340": "auto · pre-switch",
        "cmd.k341": "auto · pre-logout",
        "cmd.k342": "auto · pre-login",
        "cmd.k343": "Custom command words (one per line, e.g. mytool / just get / pnpm-dlx)",
        "cmd.k344": "Auto-fit",
        "cmd.k345": "Virtual keyboard",
        "cmd.k346": "The virtual keyboard has two tiers, \"⌨ Frequent / ABC full\": Frequent = arrows/editing/Ctrl combos; full = complete letters/digits/symbols keyboard (with space, so you can type full commands). The four locks CTRL/SHIFT/ALT/WIN latch on one tap and auto-unlock on the next key (same feel as a physical keyboard): CTRL lock + letter = Ctrl+letter (a→Ctrl+A for line start), + arrow = word-wise move (readline); SHIFT lock + letter = uppercase (needed for grep -E), + digit = shifted symbol, + arrow = Shift+arrow (selection); ALT/WIN lock + letter/symbol = ESC prefix (Meta key), + arrow = Alt+arrow (xterm \x1b[1;3x sequences, so programs can tell Alt is held). Note: the terminal escape protocol can't tell left/right Shift/Alt apart (only GUI programs can), so there is a single SHIFT/ALT lock. While the terminal is focused: Ctrl+Shift+F fullscreen, Ctrl+Shift+K keyboard, Ctrl+Shift+S cycle window size.",
        "cmd.k347": "Virtual keyboard: arrows / Tab / Esc / Ctrl / common symbols (Ctrl+Shift+K)",
        "cmd.k348": "Virtual keyboard: arrows / Tab / Esc / Ctrl / common symbols (Ctrl+Shift+K)",
        "cmd.k349": "line end",
        "cmd.k350": "line start",
        "cmd.k351": "line start / end",
        "cmd.k352": "completion",
        "cmd.k353": "Device pairing",
        "cmd.k354": "Device pairing panel",
        "cmd.k355": "Lexicon",
        "cmd.k356": "Lexicon: saved command names (for AI message recognition, full-text scan)",
        "cmd.k357": "Voice traffic stats",
        "cmd.k358": "Speech engines",
        "cmd.k359": "Debug",
        "cmd.k360": "Move to workspace tab",
        "cmd.k361": "Move to tab failed: ",
        "cmd.k362": "Move to tab failed: the host's tab-creation capability is missing (pi-web.ui.onOpenTerminal)",
        "cmd.k363": "Move to tab failed: this terminal session has no working directory, cannot locate a project tab",
        "cmd.k364": "Move to tab: move the terminal into a workspace terminal tab in the right file area (the dialog shows a placeholder)",
        "cmd.k365": "running",
        "cmd.k366": "run failed",
        "cmd.k367": "Run overview",
        "cmd.k368": "Run overview · saved commands · execution audit",
        "cmd.k369": "Back to original command",
        "cmd.k370": "Connection lost, reconnecting…",
        "cmd.k371": "Append system prompt",
        "cmd.k372": "exit ",
        "cmd.k373": "exit shell / EOF",
        "cmd.k374": "exit/EOF",
        "cmd.k375": "exit code ",
        "cmd.k376": "backspace",
        "cmd.k377": "comma-separated, e.g. build, fe",
        "cmd.k378": "Mail",
        "cmd.k379": "Some commands are not installed. Click for install suggestions",
        "cmd.k380": "Configs",
        "cmd.k381": "Rename / move",
        "cmd.k382": "reconnecting…",
        "cmd.k383": "chain intact · ",
        "cmd.k384": "Top-level group",
        "cmd.k385": "(total ",
        "cmd.k386": "(dangerous command, confirms with a dialog before running)",
        "cmd.k387": "(dangerous command, confirmed before running)",
        "cmd.k388": "(with args, filled in one by one at run time)",
        "cmd.k389": "(working directory: ",
        "cmd.k390": "(current)",
        "cmd.k391": "(no commands — favorite from AI message recognition, or click \"＋ New command\")",
        "cmd.k392": "(no active sessions — click \"＋ New terminal\" to open a shell, or run a command)",
        "cmd.k393": "(no output)",
        "cmd.k394": "(no execution records yet)",
        "cmd.k395": "(more terminals/commands, also ",
        "cmd.k396": "(ungrouped)",
        "cmd.k397": "(no bash commands running; they appear automatically when an agent session runs one)",
        "cmd.k398": "(click to switch)",
        "cmd.k399": "(started before subscribing)",
        "cmd.k400": "(top level)",
        "cmd.k401": "＋ Save",
        "cmd.k402": "＋ Save to saved commands",
        "cmd.k403": "＋ New group",
        "cmd.k404": "＋ New",
        "cmd.k405": "＋ New group (organize commands in a tree)",
        "cmd.k406": "＋ New command",
        "cmd.k407": "＋ New command (appears in its group in the command list after saving)",
        "cmd.k408": "＋ New terminal",
        "cmd.k409": "＋ New terminal: open another shell (directory = the current terminal's 📁 live path)",
        "cmd.k410": "＋ New terminal: open an interactive shell (no sandbox)",
        "cmd.k411": "＋cmd",
        "cmd.k412": "＋subgroup",
        "cmd.k413": ": total ",
        "cmd.k414": ": filtering by tag (click again to clear)",
        "cmd.k415": "🧩 Dock demo",
        "cmd.k1": "· ⚠ Dangerous: ",
        "cmd.k2": "· args: {",
        "cmd.k3": "· installed (PATH/project bin)",
        "cmd.k4": "· ran ",
        "cmd.k5": "· truncated",
        "cmd.k6": "· no sandbox",
        "cmd.k7": "· click a row for details",
        "cmd.k8": "· took ",
        "cmd.k9": "· output truncated",
        "cmd.k10": "· 🖥 terminal ",
        "cmd.k11": "running",
        "cmd.k12": " hidden)",
        "cmd.k13": " hidden), open the list to switch",
        "cmd.k14": " command names / full-text scan for recognition",
        "cmd.k15": "already opened in the aiti-cmd window",
        "cmd.k16": "concurrency)",
        "cmd.k17": "queued)",
        "cmd.k18": "not installed (not found on PATH/project bin)",
        "cmd.k19": "entries",
        "cmd.k20": "entries · click to run",
        "cmd.k21": "hash entries",
        "cmd.k22": "running",
        "cmd.k23": "entries, failed ",
        "cmd.k24": "times",
        "cmd.k25": "killed) · ",
        "cmd.k26": "killed) · ",
        "cmd.k27": "%), last ",
        "cmd.k28": "ABC full keyboard",
        "cmd.k29": "AI Helper",
        "cmd.k30": "AITI debugger",
        "cmd.k31": "ASR self-heal",
        "cmd.k32": "ALT lock: tap once to latch, then letters/symbols send Alt+key (ESC prefix), arrows send Alt+arrow",
        "cmd.k33": "CTRL/SHIFT/ALT/WIN lock + key = combo",
        "cmd.k34": "CTRL lock: tap once to latch, then letters send Ctrl+letter, arrows send Ctrl+arrow (word-wise move)",
        "cmd.k35": "JSX demo",
        "cmd.k36": "JSX demo panel",
        "cmd.k37": "SHIFT lock: tap once to latch, then letters = uppercase (e.g. grep -E), digits = shifted symbols, arrows = Shift+arrow (selection)",
        "cmd.k38": "WIN/Meta lock: tap once to latch, then keys send ESC prefix (terminal Meta key, same semantics as ALT; some programs bind it differently)",
        "cmd.k39": "agent sessions",
        "cmd.k40": "agent commands",
        "cmd.k41": "aiti-cmd: running / saved commands / terminal",
        "cmd.k42": "cwd (defaults to the current session directory)",
        "cmd.k43": "demo flag",
        "cmd.k44": "demo banner test",
        "cmd.k45": "demo self-check",
        "cmd.k46": "demo self-check panel",
        "cmd.k47": "demo self-check page",
        "cmd.k48": "demo-lazy: bundle loads on click (lazy-load v2 sample)",
        "cmd.k49": "shell hosted by aiti-cmd · 24h session",
        "cmd.k50": "… and ",
        "cmd.k51": "… connecting",
        "cmd.k52": "← Back: ",
        "cmd.k53": "← Back to overview",
        "cmd.k54": "↓End",
        "cmd.k55": "↻ Refresh",
        "cmd.k56": "⇱ To tab",
        "cmd.k57": "⇲ Pull back",
        "cmd.k58": "▶ Run standalone",
        "cmd.k59": "▶ Run this command",
        "cmd.k60": "● Running",
        "cmd.k61": "⟳ Replaying",
        "cmd.k62": ". Click to view/save (never runs directly)",
        "cmd.k63": "\" and its subgroups? Commands inside will move to Ungrouped",
        "cmd.k64": "\" as a dangerous command.\nScheduled plans will run it at trigger time without confirmation. Continue?",
        "cmd.k65": "\" (default daily 9am; edit and approve on the ⏰ Schedule page)",
        "cmd.k66": "Ephemeral environment: read-only system; /tmp and $HOME writable but discarded on exit",
        "cmd.k67": "scroll up/down (terminal)",
        "cmd.k68": "previous / next command in history",
        "cmd.k69": "prev history / move up",
        "cmd.k70": "Parent group",
        "cmd.k71": "scroll up",
        "cmd.k72": "page up / down",
        "cmd.k73": "next history / move down",
        "cmd.k74": "scroll down",
        "cmd.k75": "Exclude from smart suggestions",
        "cmd.k76": "No fs/network isolation — trusted commands only",
        "cmd.k77": "interrupt",
        "cmd.k78": "interrupt the current command (SIGINT)",
        "cmd.k79": "Tmp writable disk (discarded on exit)",
        "cmd.k80": "Tmp disk",
        "cmd.k81": "Subagent tasks",
        "cmd.k82": "session ",
        "cmd.k83": "session stopped (by ",
        "cmd.k84": "session finished",
        "cmd.k85": "session finished (exit code ",
        "cmd.k86": "located at:",
        "cmd.k87": "Source for aiti-ai-input smart suggestions (input hints/completion); when off, this command is no longer suggested while typing",
        "cmd.k88": "Source for aiti-ai-input input hints/completion (on by default)",
        "cmd.k89": "Save",
        "cmd.k90": "Save changes",
        "cmd.k91": "After saving it appears in the command list under its group",
        "cmd.k92": "Save failed",
        "cmd.k93": "Save custom command words to the lexicon (message recognition picks them up immediately)",
        "cmd.k94": "Save lexicon",
        "cmd.k95": "🧩 Dock demo",
        "cmd.k96": "Dock demo (floating)",
        "cmd.k97": "cursor to line end",
        "cmd.k98": "cursor to line start",
        "cmd.k99": "cursor to line start / end",
        "cmd.k100": "cursor left / right",
        "cmd.k101": "Fullscreen",
        "cmd.k102": "Toggle fullscreen",
        "cmd.k103": "Toggle fullscreen (Ctrl+Shift+F)",
        "cmd.k104": "Toggle fullscreen (Ctrl+Shift+F)",
        "cmd.k105": "All",
        "cmd.k106": "All Sessions",
        "cmd.k107": "All: clear tag filter",
        "cmd.k108": "Full keyboard: letters / digits / symbols / space — CTRL lock + letter = Ctrl+letter",
        "cmd.k109": "Close",
        "cmd.k110": "Close (Esc)",
        "cmd.k111": "Hide virtual keyboard (Esc)",
        "cmd.k112": "Close lexicon",
        "cmd.k113": "Close panel",
        "cmd.k114": "built-in ",
        "cmd.k115": "error/killed",
        "cmd.k116": "Group",
        "cmd.k117": "Group name",
        "cmd.k118": "Toggle terminal fullscreen",
        "cmd.k119": "Toggle virtual keyboard",
        "cmd.k120": "Create",
        "cmd.k121": "Create failed: ",
        "cmd.k122": "Failed to create terminal",
        "cmd.k123": "delete to line start",
        "cmd.k124": "delete word",
        "cmd.k125": "Delete group",
        "cmd.k126": "Delete group \"",
        "cmd.k127": "Commands in a deleted group move to Ungrouped automatically",
        "cmd.k128": "delete to line start / end",
        "cmd.k129": "delete previous word",
        "cmd.k130": "Delete this command",
        "cmd.k131": "Manage on the commands page (new/edit/groups/tags)",
        "cmd.k132": "Refresh execution history",
        "cmd.k133": "Function key F1",
        "cmd.k134": "Function key F10",
        "cmd.k135": "Function key F11",
        "cmd.k136": "Function key F12",
        "cmd.k137": "Function key F2",
        "cmd.k138": "Function key F3",
        "cmd.k139": "Function key F4",
        "cmd.k140": "Function key F5",
        "cmd.k141": "Function key F6",
        "cmd.k142": "Function key F7",
        "cmd.k143": "Function key F8",
        "cmd.k144": "Function key F9",
        "cmd.k145": "Loading…",
        "cmd.k146": "Confirm before running dangerous commands",
        "cmd.k147": "Dangerous command: ",
        "cmd.k148": "History",
        "cmd.k149": "History: execution audit (append-only)",
        "cmd.k150": "Include in smart suggestions",
        "cmd.k151": "args ",
        "cmd.k152": "See Termux extra-keys",
        "cmd.k153": "reverse-search history",
        "cmd.k154": "reverse-search command history",
        "cmd.k155": "Cancel",
        "cmd.k156": "cancel / enter vi mode",
        "cmd.k157": "Unqueue",
        "cmd.k158": "Kill only this bash command (the agent sees the error and keeps thinking; concurrent bashes in the same session are killed too)",
        "cmd.k159": "Kill only this command (does not abort the whole turn)",
        "cmd.k160": "Read-only",
        "cmd.k161": "Read-only + offline",
        "cmd.k162": "Read-only+offline",
        "cmd.k163": "cursor right",
        "cmd.k164": "Right-click / Ctrl+Shift+C / Ctrl+Insert",
        "cmd.k165": "Similar: ",
        "cmd.k166": "Name",
        "cmd.k167": "Commands",
        "cmd.k168": "command / path completion",
        "cmd.k169": "command/args/output/exit code/time/source — security audit",
        "cmd.k170": "command \"",
        "cmd.k171": "Command text is empty — nothing to save",
        "cmd.k172": "commands recognizable",
        "cmd.k173": "Command stopped (error/killed)",
        "cmd.k174": "Command finished",
        "cmd.k175": "Command manager",
        "cmd.k176": "Commands: saved command list (run/copy/edit/delete)",
        "cmd.k177": "Enter",
        "cmd.k178": "Image preview",
        "cmd.k179": "Open in a new window/tab (external site)",
        "cmd.k180": "New command in this group",
        "cmd.k181": "New subgroup in this group",
        "cmd.k182": "Copy",
        "cmd.k183": "Copy the command to the clipboard and open \"New command\" prefilled (edit then save as new)",
        "cmd.k184": "Copy selected terminal text (Ctrl+C interrupts — it does not copy)",
        "cmd.k185": "External Sessions",
        "cmd.k186": "e.g. build / deploy",
        "cmd.k187": "sub",
        "cmd.k188": "Install suggestion: ",
        "cmd.k189": "done",
        "cmd.k190": "Schedule",
        "cmd.k191": "Scheduled commands",
        "cmd.k192": "Schedule: create a plan (prefilled with this command)",
        "cmd.k193": "workspace tab · ",
        "cmd.k194": "Working directory",
        "cmd.k195": "Working directory: ",
        "cmd.k196": "Toolbar buttons",
        "cmd.k197": "cursor left",
        "cmd.k198": "stopped",
        "cmd.k199": "Created plan pending approval: \"",
        "cmd.k200": "Queued for execution (position ",
        "cmd.k201": "Saved",
        "cmd.k202": "cleaned up",
        "cmd.k203": "finished",
        "cmd.k204": "finished (server cleaned up the record)",
        "cmd.k205": "exited",
        "cmd.k206": "Frequent",
        "cmd.k207": "Saved: ",
        "cmd.k208": "Saved commands",
        "cmd.k209": "Saved-command lexicon (for message recognition)",
        "cmd.k210": "Common shortcuts",
        "cmd.k211": "Common shortcuts help",
        "cmd.k212": "Frequent keys: arrows / editing / Ctrl combos / common symbols",
        "cmd.k213": "Starting…",
        "cmd.k214": "Quote reply",
        "cmd.k215": "Archived Viewer",
        "cmd.k216": "Current: ",
        "cmd.k217": "Current: 🤖 agent running / 🖥 terminal running",
        "cmd.k218": "Cycle terminal window size",
        "cmd.k219": "Overview",
        "cmd.k220": "Overview: agent commands / terminal sessions at a glance",
        "cmd.k221": "Lazy sample widget",
        "cmd.k222": "Manual",
        "cmd.k223": "Open",
        "cmd.k224": "Open link?",
        "cmd.k225": "Run",
        "cmd.k226": "Run the following command and report the result",
        "cmd.k227": "Confirm with a dialog before running",
        "cmd.k228": "Whether to confirm with a dialog before running (recommended for dangerous commands)",
        "cmd.k229": "Execution audit (append-only)",
        "cmd.k230": "Run confirmation",
        "cmd.k231": "Pull back",
        "cmd.k232": "Pull back: move the terminal view back into the aiti-cmd window (the tab shows a placeholder)",
        "cmd.k233": "Pull back: move the terminal view back into the aiti-cmd window (the tab shows a placeholder; tab mode only)",
        "cmd.k234": "suspend",
        "cmd.k235": "suspend the current task (background)",
        "cmd.k236": "move cursor by word (readline)",
        "cmd.k237": "queued",
        "cmd.k238": "queued (",
        "cmd.k239": "queued (concurrency full — close old terminals in Running)",
        "cmd.k240": "Take over to tab",
        "cmd.k241": "Prompts",
        "cmd.k242": "Search sessions",
        "cmd.k243": "Search commands…",
        "cmd.k244": "Supports {param} placeholders, filled in at run time",
        "cmd.k245": "Favorite",
        "cmd.k246": "Which group to save to",
        "cmd.k247": "Save name (defaults to the command text)",
        "cmd.k248": "Once saved, run it anytime from the ⚡ commands panel (no AI needed); all runs are written to the audit log.",
        "cmd.k249": "Favorite command",
        "cmd.k250": "Favorite the full command to saved commands",
        "cmd.k251": "Snippet library",
        "cmd.k252": "Favorite the selected text (a command fragment is fine)",
        "cmd.k253": "Hide virtual keyboard",
        "cmd.k254": "Changes take effect immediately",
        "cmd.k255": "Read-only filesystem with no network — maximum isolation, for untrusted commands",
        "cmd.k256": "Read-only filesystem, changes not persisted; the working directory is genuinely writable",
        "cmd.k257": "Docs",
        "cmd.k258": "Doc Center",
        "cmd.k259": "New session",
        "cmd.k260": "After adding words, message recognition scans with them immediately",
        "cmd.k261": "New pi-web session",
        "cmd.k262": "New pi-web session failed: the host's new-session channel is unavailable",
        "cmd.k263": "New pi-web session failed: the current terminal session has no working directory",
        "cmd.k264": "New pi-web session: open a new agent session and @ the terminal's live path",
        "cmd.k265": "New shell",
        "cmd.k266": "New group",
        "cmd.k267": "New command",
        "cmd.k268": "New: open another shell (directory = the current terminal's 📁 live path)",
        "cmd.k269": "No sandbox",
        "cmd.k270": "No sandbox (fully trusted) · default",
        "cmd.k271": "Display env",
        "cmd.k272": "Smart suggestions",
        "cmd.k273": "Smart suggestion participation",
        "cmd.k274": "More terminals",
        "cmd.k275": "More terminals/commands (also ",
        "cmd.k276": "Service",
        "cmd.k277": "Ungrouped",
        "cmd.k278": "Unknown",
        "cmd.k279": "Unknown error",
        "cmd.k280": "this help panel",
        "cmd.k281": "Source distribution",
        "cmd.k282": "view / save / edit — never runs directly",
        "cmd.k283": "Tags",
        "cmd.k284": "Verification failed",
        "cmd.k285": "Verify audit-chain integrity (hash chain)",
        "cmd.k286": "Verify chain",
        "cmd.k287": "Bridge probe",
        "cmd.k288": "Bridge probe (temporary diagnostics: captures SSE/lifecycle events)",
        "cmd.k289": "Model availability",
        "cmd.k290": "Model wizard",
        "cmd.k291": "Model check",
        "cmd.k292": "Model management",
        "cmd.k293": "Model config import",
        "cmd.k294": "Creating terminal session…",
        "cmd.k295": "Starting shell…",
        "cmd.k296": "Viewing related commands",
        "cmd.k297": "This terminal is already open in a workspace tab (right file area)",
        "cmd.k298": "This panel is for viewing / saving / editing commands — it never runs them directly.",
        "cmd.k299": "Sandbox",
        "cmd.k300": "Message recognition",
        "cmd.k301": "clear screen",
        "cmd.k302": "Scroll to bottom",
        "cmd.k303": "Scroll to bottom: jump to the latest output (doesn't disturb while reading back)",
        "cmd.k304": "Click to view/save this command (never runs directly)",
        "cmd.k305": "Click to view/manage this command",
        "cmd.k306": "Pick element",
        "cmd.k307": "Usage report",
        "cmd.k308": "Run directly",
        "cmd.k309": "Board",
        "cmd.k310": "Delete group confirmation",
        "cmd.k311": "Confirm running a dangerous command",
        "cmd.k312": "Sample widget",
        "cmd.k313": "space",
        "cmd.k314": "Manage →",
        "cmd.k315": "Manage models",
        "cmd.k316": "tampered at ",
        "cmd.k317": "paste clipboard into terminal",
        "cmd.k318": "System read-only (working directory writable)",
        "cmd.k319": "kill",
        "cmd.k320": "killing…",
        "cmd.k321": "killing (SIGTERM sent, forced KILL after at most 3s)",
        "cmd.k322": "Termination signal sent, waiting for the process to exit…",
        "cmd.k323": "Kill command",
        "cmd.k324": "Kill command (kills the process)",
        "cmd.k325": "Terminal",
        "cmd.k326": "Terminal sessions",
        "cmd.k327": "Terminal function keys (bottom row of the \"⌨ Frequent / ABC\" virtual keyboard, for mc / htop and other TUIs)",
        "cmd.k328": "A terminal can only show in one place; after take-over the window shows a placeholder",
        "cmd.k329": "A terminal can only show in one place; the tab now shows a placeholder",
        "cmd.k330": "Terminal window size (cols×rows): fit the container, or a fixed standard size — the full terminal stays visible on small screens, overflow scrolls",
        "cmd.k331": "Edit group",
        "cmd.k332": "Edit command",
        "cmd.k333": "Edit command (name/command/cwd/tags/group/sandbox/run confirmation/smart suggestions)",
        "cmd.k334": "defaults to the command text",
        "cmd.k335": "defaults to the current session directory",
        "cmd.k336": "network error",
        "cmd.k337": "took ",
        "cmd.k338": "Suggestions",
        "cmd.k339": "Aggregation / multi-key status",
        "cmd.k340": "auto · pre-switch",
        "cmd.k341": "auto · pre-logout",
        "cmd.k342": "auto · pre-login",
        "cmd.k343": "Custom command words (one per line, e.g. mytool / just get / pnpm-dlx)",
        "cmd.k344": "Auto-fit",
        "cmd.k345": "Virtual keyboard",
        "cmd.k346": "The virtual keyboard has two tiers, \"⌨ Frequent / ABC full\": Frequent = arrows/editing/Ctrl combos; full = complete letters/digits/symbols keyboard (with space, so you can type full commands). The four locks CTRL/SHIFT/ALT/WIN latch on one tap and auto-unlock on the next key (same feel as a physical keyboard): CTRL lock + letter = Ctrl+letter (a→Ctrl+A for line start), + arrow = word-wise move (readline); SHIFT lock + letter = uppercase (needed for grep -E), + digit = shifted symbol, + arrow = Shift+arrow (selection); ALT/WIN lock + letter/symbol = ESC prefix (Meta key), + arrow = Alt+arrow (xterm \x1b[1;3x sequences, so programs can tell Alt is held). Note: the terminal escape protocol can't tell left/right Shift/Alt apart (only GUI programs can), so there is a single SHIFT/ALT lock. While the terminal is focused: Ctrl+Shift+F fullscreen, Ctrl+Shift+K keyboard, Ctrl+Shift+S cycle window size.",
        "cmd.k347": "Virtual keyboard: arrows / Tab / Esc / Ctrl / common symbols (Ctrl+Shift+K)",
        "cmd.k348": "Virtual keyboard: arrows / Tab / Esc / Ctrl / common symbols (Ctrl+Shift+K)",
        "cmd.k349": "line end",
        "cmd.k350": "line start",
        "cmd.k351": "line start / end",
        "cmd.k352": "completion",
        "cmd.k353": "Device pairing",
        "cmd.k354": "Device pairing panel",
        "cmd.k355": "Lexicon",
        "cmd.k356": "Lexicon: saved command names (for AI message recognition, full-text scan)",
        "cmd.k357": "Voice traffic stats",
        "cmd.k358": "Speech engines",
        "cmd.k359": "Debug",
        "cmd.k360": "Move to workspace tab",
        "cmd.k361": "Move to tab failed: ",
        "cmd.k362": "Move to tab failed: the host's tab-creation capability is missing (pi-web.ui.onOpenTerminal)",
        "cmd.k363": "Move to tab failed: this terminal session has no working directory, cannot locate a project tab",
        "cmd.k364": "Move to tab: move the terminal into a workspace terminal tab in the right file area (the dialog shows a placeholder)",
        "cmd.k365": "running",
        "cmd.k366": "run failed",
        "cmd.k367": "Run overview",
        "cmd.k368": "Run overview · saved commands · execution audit",
        "cmd.k369": "Back to original command",
        "cmd.k370": "Connection lost, reconnecting…",
        "cmd.k371": "Append system prompt",
        "cmd.k372": "exit ",
        "cmd.k373": "exit shell / EOF",
        "cmd.k374": "exit/EOF",
        "cmd.k375": "exit code ",
        "cmd.k376": "backspace",
        "cmd.k377": "comma-separated, e.g. build, fe",
        "cmd.k378": "Mail",
        "cmd.k379": "Some commands are not installed. Click for install suggestions",
        "cmd.k380": "Configs",
        "cmd.k381": "Rename / move",
        "cmd.k382": "reconnecting…",
        "cmd.k383": "chain intact · ",
        "cmd.k384": "Top-level group",
        "cmd.k385": "(total ",
        "cmd.k386": "(dangerous command, confirms with a dialog before running)",
        "cmd.k387": "(dangerous command, confirmed before running)",
        "cmd.k388": "(with args, filled in one by one at run time)",
        "cmd.k389": "(working directory: ",
        "cmd.k390": "(current)",
        "cmd.k391": "(no commands — favorite from AI message recognition, or click \"＋ New command\")",
        "cmd.k392": "(no active sessions — click \"＋ New terminal\" to open a shell, or run a command)",
        "cmd.k393": "(no output)",
        "cmd.k394": "(no execution records yet)",
        "cmd.k395": "(more terminals/commands, also ",
        "cmd.k396": "(ungrouped)",
        "cmd.k397": "(no bash commands running; they appear automatically when an agent session runs one)",
        "cmd.k398": "(click to switch)",
        "cmd.k399": "(started before subscribing)",
        "cmd.k400": "(top level)",
        "cmd.k401": "＋ Save",
        "cmd.k402": "＋ Save to saved commands",
        "cmd.k403": "＋ New group",
        "cmd.k404": "＋ New",
        "cmd.k405": "＋ New group (organize commands in a tree)",
        "cmd.k406": "＋ New command",
        "cmd.k407": "＋ New command (appears in its group in the command list after saving)",
        "cmd.k408": "＋ New terminal",
        "cmd.k409": "＋ New terminal: open another shell (directory = the current terminal's 📁 live path)",
        "cmd.k410": "＋ New terminal: open an interactive shell (no sandbox)",
        "cmd.k411": "＋cmd",
        "cmd.k412": "＋subgroup",
        "cmd.k413": ": total ",
        "cmd.k414": ": filtering by tag (click again to clear)",
        "cmd.k415": "🧩 Dock demo",
        "cmd.app.favorites": "Saved commands",
        "cmd.app.running": "Running",
        "cmd.app.terminal": "Terminal",
        "cmd.app.favorites.title": "Command library: groups / tags / dictionary / one-click run",
        "cmd.app.running.title": "Runtime: terminal sessions / agent commands / execution log",
        "cmd.app.terminal.title": "Real terminal: interactive input / multiple sessions / save command",
        "cmd.app.switch": "Switch to this app",
        "cmd.app.close": "Close window",
        "cmd.app.saveFavorite": "Save this command",
        "cmd.app.reopen": "Run again",
        "cmd.app.terminal.empty": "No terminal yet — open a shell, or pick one from Running / Saved commands",
        "cmd.app.running.all": "All",
        "cmd.app.running.subtitle": "Running / All / Records",
        "cmd.app.missing": "session gone",
        "cmd.app.missingTitle": "This terminal session no longer exists",
        "cmd.app.missingHint": "Typical causes: an extension hot-reload / pi-web restart rebuilds the runner (all PTY sessions end), or the session expired. Open a new terminal to continue.",
        "cmd.app.entry.title": "Command runtime (highlighted while something is running)",
        "cmd.app.sink.label": "Save as command",
        "cmd.app.sink.saved": "Saved as command: ",
        "cmd.app.openFavorites": "Open saved commands",
        "it.aiti-cmd-favorites.label": "aiti-cmd saved commands",
        "it.aiti-cmd-running.label": "aiti-cmd running",
        "it.aiti-cmd-terminal.label": "aiti-cmd terminal",
        "feat.tool.aiti_cmd_run.desc": "When off, new agent sessions no longer get this tool (already-injected sessions refuse immediately)",
        "it.aiti-cmd-detail.label": "aiti-cmd command detail",
        "ext.displayName": "Command Palette",
        "ext.description": "Runs a shell command in the aiti-cmd backend PTY runner, creating a persistent interactive session (output streams into the ⚡ commands panel, fully audited).",
        "feat.tool.aiti_cmd_run": "Agent tool: aiti_cmd_run (run commands in-session via the backend runner; dangerous ones confirmed twice)",
        "feat.aiti-cmd-detail": "aiti-cmd command detail",
        "feat.workspace-terminal": "Workspace terminal",
      "cmd.open.label": "Commands",
      "cmd.open.title": "aiti-cmd: running / saved commands / terminal",
      },
    },

    // Three dialog apps (same extension, independent windows) + the message-recognition card.
    // Static ids MUST match client registerItems("dialogs", …) ids (double-button guard).
    dialogs: [
      { id: "aiti-cmd-favorites", label: "i18n:it.aiti-cmd-favorites.label" },
      { id: "aiti-cmd-running", label: "i18n:it.aiti-cmd-running.label" },
      { id: "aiti-cmd-terminal", label: "i18n:it.aiti-cmd-terminal.label" },
      { id: "aiti-cmd-detail", label: "i18n:it.aiti-cmd-detail.label" },
    ],
    // terminalDock 槽位声明（懒加载适配修复 2026-09-09）：declaredSlots 收集自 ui 的键——
    // 缺此声明时 pendingForSlot("terminalDock") 恒空，TerminalPanelBridge 查槽不触发本扩展
    // 物化 → fallback 再查 __aitiCmd 也无（client 未加载）→ 误报「未检测到 aiti-cmd 扩展」。
    // id 与 client registerItems("terminalDock",[{id:"workspace-terminal",…}]) 对齐；
    // 静态条目无 render，接管判定 hasExtRender 自动跳过，物化后同 id 覆盖（同 aiti-editor fileViewer 模式）。
    terminalDock: [{ id: "workspace-terminal", label: "工作区终端", title: "aiti-cmd：工作区终端页签接管（xterm）" }],
  },

  server: {
    startup(ctx) {
      dirCfg = (ctx.configDir as string) || "";
      dirCache = (ctx.cacheDir as string) || (dirCfg ? dirCfg + "/cache" : "");
      audit = createAudit(dirCache);
      store = createStore(dirCfg);
      // aiti-event-bus 发布出口（aiti-cmd 自管理是否发送；惰性现取——event-bus 晚加载/缺席均安全）。
      // 终端帧是高频大流量 → 走 publish-local（直连总线，不双喂 core route）；
      // local 缺席（旧版 event-bus）时退回全局 publish 出口。
      const publish = (type: string, data: Record<string, unknown>) => {
        try {
          const last = aliveMap.get(type);
          if (last !== undefined && Date.now() - last > ALIVE_TIMEOUT_MS) return; // 订阅已停止：停推
          // exit frame → server-side listeners (aiti-cmd.on-exit service; the alive/stop-push gate does not affect this fan-out)
          if (data && (data as { evt?: string }).evt === "exit" && type.startsWith("cmd-")) {
            const d = data as { code?: number | null; signal?: string | null; durationMs?: number; cmd?: string; source?: string; cwd?: string; cancelled?: boolean };
            for (const l of exitListeners) {
              try { l({ sessionId: type.slice(4), code: d.code ?? null, signal: d.signal ?? null, durationMs: d.durationMs, cmd: d.cmd, source: d.source, cwd: d.cwd, cancelled: d.cancelled === true }); } catch {}
            }
          }
          const svc = (ctx.services as { get?: (n: string) => { publish?: (t: string, d: Record<string, unknown>) => void } | undefined } | undefined);
          (svc?.get?.("aiti-event-bus.publish-local") ?? svc?.get?.("aiti-event-bus.publish"))?.publish?.(type, data);
        } catch {}
      };
      runner = createRunner(audit, store, dirCache, publish);
      // Sessions hosted by a detached pty-host survive a reload / restart — reattach them and
      // let the host replay its journal so the terminal snapshot comes back.
      if (typeof (runner as { reattach?: () => Promise<number> }).reattach === "function") {
        void runner.reattach().then((n) => { if (n) console.log("[aiti-cmd] 重新接管 " + n + " 个 detached 终端会话"); }).catch(() => {});
      }
      piCommands = createPiCommands(publish);
      piCommands.lateCatchUp(); // 扩展加载晚于 wrapper 创建：扫 registry 补订阅存量会话

      // 统一集成锚点（aiti-cmd-exec-integration-plan.md §3.2，对齐 codebuddy §9.3）：进程内共享
      // runner——跨扩展「后端建会话」的唯一出口（消费方：aiti-ai-input ASR 自愈 / aiti-codebuddy-agent
      // 登录 PTY 等）。services 版返回纯数据（非 REST 的 Response）；REST 端点保持原样作前端本体通道。
      // 方法集 = runner.ts 返回值；惰性引模块级 runner（reload 后自然指向新实例）。
      try {
        const unwrap = async (r: unknown) => {
          if (!(r instanceof Response)) return r;
          const b = await r.json().catch(() => ({}));
          return { status: r.status, ...b };
        };
        (ctx.services as { provide?: (n: string, s: unknown) => void } | undefined)?.provide?.("aiti-cmd.runner", {
          // services 通道缺省 source="service"（§3.6：services 会话同进审计）；消费方显式传值优先
          run: (opts: Partial<RunOptions> = {}) => {
            const r = runner!.run({ ...opts, source: opts.source || "service" });
            // queued/position 透传（ASR 自愈等消费方依赖排队语义，行为等价）
            return r.ok ? { ok: true, sessionId: r.sessionId, queued: r.queued === true, position: r.position } : r;
          },
          input: (id: string, data: string) => unwrap(runner!.input(id, data)),
          resize: (id: string, cols: number, rows: number) => unwrap(runner!.resize(id, cols, rows)),
          kill: (id: string) => unwrap(runner!.kill(id)),
          list: () => runner!.list(),
          getInfo: (id: string) => runner!.getInfo(id),
          diag: () => runner!.diag(),
          buffered: (id: string) => runner!.buffered(id),
          sessions: () => runner!.list(), // 与 list 同源（codebuddy 清单二者并列，保持兼容）
        });
        // Server-side exit subscription (schedule process-exit trigger; event/callback, zero polling)
        (ctx.services as { provide?: (n: string, s: unknown) => void } | undefined)?.provide?.("aiti-cmd.on-exit", {
          subscribe: (fn: (info: { sessionId: string; code: number | null; signal: string | null; durationMs?: number; cmd?: string; source?: string; cwd?: string; cancelled?: boolean }) => void) => {
            if (typeof fn !== "function") return () => {};
            exitListeners.add(fn);
            return () => { exitListeners.delete(fn); };
          },
        });
        console.log("[aiti-cmd] services 已注册：aiti-cmd.runner（跨扩展后端建会话统一出口）+ aiti-cmd.on-exit（进程退出事件）");
      } catch (e) {
        console.warn("[aiti-cmd] services.provide(aiti-cmd.runner) 失败（旧 core 无 services？）", e);
      }

      // 事件总线侧注册回放数据源？不需要——终端大消息（初始回放）不走总线，
      // 客户端直接 REST 拉 /sessions/{id}/buffered 与 /pi-commands/{id}（见下方端点）。

      // 保留策略：启动清理一次 + 每日清理（按天分片超期删除）
      try { const removed = audit.cleanupRetention(); if (removed) console.log("[aiti-cmd] 清理超期日志 " + removed + " 个"); } catch {}
      const daily = setInterval(() => { try { audit?.cleanupRetention(); } catch {} }, 24 * 3600 * 1000);
      (daily as unknown as { unref?: () => void }).unref?.();
      console.log("[aiti-cmd] 就绪：node-pty=" + (runner.diag().nodePty ? "可用" : "降级 script") + " · 保留 " + audit.retentionDays + " 天 · configDir=" + dirCfg);
    },
    shutdown() {
      try { piCommands?.dispose(); } catch {}
      audit = null; store = null; runner = null; piCommands = null;
    },

    // 方案 M agent 会话钩子：新会话即订阅（官方 subscribeEvent；旧 pi-web 自动兑底 globalThis）
    agent: {
      onAgentSession(info) {
        try { piCommands?.attach(info as { sessionId: string; cwd?: string; subscribeEvent?: (l: (e: unknown) => void) => () => void; abortBash?: () => void }); } catch {}
      },
      onAgentSessionEnd({ sessionId }) {
        try { piCommands?.detach(sessionId); } catch {}
      },
      // M4b「执行命令」agent 工具（aiti-cmd-exec-integration-plan.md §4-M4/§3.5）：AI 会话内
      // 构造的命令走 §3.2 services 同款进程内 runner 执行——命令不落前端（符合 §0 判据
      // 「命令在后端不传前端」）；危险命令（checkCommand 命中）二次确认：AI 必须先向用户展示
      // 命令原文并获明确同意，才能 confirm:true 重调。门控：feature tool.aiti_cmd_run（默认开）。
      agentTools(info) {
        const sessionId = (info as { sessionId?: string } | undefined)?.sessionId;
        return [{
          name: "aiti_cmd_run",
          label: "aiti_cmd_run",
          description:
            "在 aiti-cmd 后端 PTY runner 执行一条 shell 命令，创建常驻可交互会话（输出实时进 ⚡命令 面板，全程审计）。" +
            "适合长驻/交互式/需要用户在面板围观的任务（如 dev server、watch、登录 PTY）；需要立刻拿输出的一次性命令请用自带 bash。" +
            "危险命令必须先向用户展示命令原文、获得明确同意后才可置 confirm:true 重调。",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "要执行的 shell 命令（必填）" },
              cwd: { type: "string", description: "工作目录（可选）" },
              name: { type: "string", description: "会话显示名（可选，默认取命令前缀）" },
              ttlMs: { type: "number", description: "会话保留时长毫秒（可选，默认 1h；长驻任务可传 86400000）" },
              confirm: { type: "boolean", description: "危险命令二次确认：仅在用户明确同意后置 true" },
            },
            required: ["command"],
          },
          async execute(_toolCallId: unknown, params: Record<string, unknown>) {
            const p = params || {};
            const command = String(p.command || "").trim();
            if (!command) {
              return { content: [{ type: "text", text: "缺少 command" }], isError: true } as never;
            }
            let danger: string[] = [];
            try { danger = (await checkCommand(command)).danger || []; } catch { /* 词库异常按非危险放行 */ }
            if (danger.length && p.confirm !== true) {
              return {
                content: [{ type: "text", text: "危险命令需二次确认：命中 " + danger.join(" / ") + "。请把命令原文完整展示给用户，获得明确同意后以 confirm:true 重调本次调用；未获同意则停止执行。" }],
              } as never;
            }
            if (!runner) {
              return { content: [{ type: "text", text: "runner 未初始化" }], isError: true } as never;
            }
            const r = runner.run({
              command,
              cwd: p.cwd ? String(p.cwd) : undefined,
              name: p.name ? String(p.name) : undefined,
              source: "ai-helper",
              piSessionId: sessionId ? String(sessionId) : undefined,
              danger: danger.length ? danger : undefined,
              confirm: danger.length > 0,
              ttlMs: Number.isFinite(Number(p.ttlMs)) && Number(p.ttlMs) > 0 ? Number(p.ttlMs) : undefined,
            });
            if (!r.ok) {
              return { content: [{ type: "text", text: "执行失败：" + (r.error || "未知错误") }], isError: true } as never;
            }
            return {
              content: [{ type: "text", text: "已创建会话 " + r.sessionId + (r.queued ? "（并发已满，排队中 位置 " + r.position + "；可用 GET /api/extensions/aiti-cmd/sessions 列出会话，POST /api/extensions/aiti-cmd/sessions/{id}/kill 关闭不再使用的终端释放并发）" : "") + "。输出实时进 ⚡命令 面板；快照接口 GET /api/extensions/aiti-cmd/sessions/" + r.sessionId + "/buffered 可拉取当前回放。" }],
            } as never;
          },
        }];
      },
    },

    async api(req, ctx) {
      const p = ctx.path || [];
      if (!runner || !store || !audit) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });

      // POST /alive {types:["cmd-s_x", ...]} —— 终端流订阅保活（前端 15s 一次；
      // 45s 未刷新的 type 在发布侧停推）。全量语义：仅刷新所列 type，缺失项交给超时判定
      //（多 tab 并存时各 tab 全量心跳互不干扰）。
      if (p[0] === "alive" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !Array.isArray(body.types)) return json({ ok: false, error: "types 必须是数组" }, 400);
        const now = Date.now();
        let n = 0;
        for (const t of body.types) {
          if (typeof t !== "string" || t.length <= 4 || !t.startsWith("cmd-")) continue; // 拒绝非 cmd- 前缀与空 id
          aliveMap.set(t, now);
          n++;
        }
        // 顺带回收：超时 1h 的陈旧条目（会话早已结束/页面早已关闭）
        for (const [t, ts] of aliveMap) if (now - ts > 3600_000) aliveMap.delete(t);
        return json({ ok: true, count: n });
      }

      // ---------- 执行引擎 ----------
      // POST /run { command, cwd?, env?, name?, source?, piSessionId?, params?, danger?, confirm?, confirmToken?, commandId?, ttlMs? }
      if (p[0] === "run" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.command) return json({ ok: false, error: "缺少 command" }, 400);
        const cmd = String(body.command);
        // 危险命令强制确认（服务端兜底）：check 命中危险模式 或 命令标记 confirm:true
        const danger = (await checkCommand(cmd)).danger;
        const isDanger = danger.length > 0 || body.confirm === true;
        const confirmToken = body.confirmToken ? String(body.confirmToken) : null;
        if (isDanger && !confirmToken) {
          return json({ ok: false, needConfirm: true, confirmToken: issueConfirmToken(), danger, reason: "危险命令需确认" }, 403);
        }
        if (confirmToken && !consumeConfirmToken(confirmToken)) {
          return json({ ok: false, error: "确认 token 无效或已过期，请重新确认" }, 403);
        }
        // source 收口（§3.1）：未知归 unknown；缺省兜底 manual + sourceDefaulted 审计标记
        const rawSource = body.source ? String(body.source) : "";
        const source = rawSource ? (KNOWN_SOURCES.has(rawSource) ? rawSource : "unknown") : "manual";
        const r = runner.run({
          command: cmd,
          cwd: body.cwd ? String(body.cwd) : undefined,
          env: body.env && typeof body.env === "object" ? body.env : undefined,
          name: body.name ? String(body.name) : undefined,
          source,
          sourceDefaulted: rawSource ? undefined : true,
          piSessionId: body.piSessionId ? String(body.piSessionId) : undefined,
          danger: danger.length ? danger : undefined,
          confirm: isDanger,
          commandId: body.commandId ? String(body.commandId) : undefined,
          ttlMs: body.ttlMs ? Number(body.ttlMs) : undefined,
          sandbox: normSandbox(body.sandbox),
        });
        if (!r.ok) return json(r, 400);
        return json({ ok: true, sessionId: r.sessionId });
      }

      // POST /shell { cwd?, name?, source? } —— 后端建交互 shell 会话（§3.3 前端「打开终端」下沉：
      // core 侧栏/工作区页签/folder·editor 查看窗/本体面板统一走这里拿 sid 渲染，命令文本不落前端；
      // "$SHELL" 与本体面板「＋ 新终端」同语义：win32 映射默认 shell 交互启动，POSIX 经 -c 内层交互）
      if (p[0] === "shell" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const rawSource = body.source ? String(body.source) : "shell";
        const ttl = Number(body.ttlMs);
        // Always record a concrete cwd: the UI needs one for "move to workspace tab" (which is
        // project-scoped) and for the session row's 📁 hint. Falls back to this process's cwd,
        // which is exactly where the shell would start anyway.
        const shellCwd = body.cwd ? String(body.cwd) : process.cwd();
        const r = runner.run({
          command: "$SHELL",
          cwd: shellCwd,
          name: body.name ? String(body.name) : "终端",
          source: KNOWN_SOURCES.has(rawSource) ? rawSource : "unknown",
          ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
          sandbox: "none",
        });
        if (!r.ok) return json(r, 400);
        return json({ ok: true, sessionId: r.sessionId, cwd: shellCwd, name: body.name ? String(body.name) : "终端" });
      }

      // GET /sessions
      if (p[0] === "sessions" && p.length === 1 && req.method === "GET") {
        return json({ ok: true, sessions: runner.list() });
      }

      // GET /sessions/{id}
      if (p[0] === "sessions" && p.length === 2 && req.method === "GET") {
        const info = runner.getInfo(p[1]);
        if (!info) return json({ ok: false, error: "unknown session" }, 404);
        return json({ ok: true, ...info });
      }

      // GET /sessions/{id}/buffered → 初始快照（大消息不走 event-bus：订阅方先订阅
      // 总线 cmd-<id>，再拉这个；seq 去重衔接实时流）
      if (p[0] === "sessions" && p.length === 3 && p[2] === "buffered" && req.method === "GET") {
        const snap = runner.buffered(p[1]);
        if (!snap) return json({ ok: false, error: "unknown session" }, 404);
        return json({ ok: true, ...snap });
      }
      // GET /sessions/{id}/cwd → shell 实时目录（Linux/macOS 读交互 shell 进程当前 pwd；
      // win32 不支持 / 会话未运行 → 404，前端降级会话创建时 cwd）。「＋ 新建」/「新 pi-web 会话」用它
      if (p[0] === "sessions" && p.length === 3 && p[2] === "cwd" && req.method === "GET") {
        const cwd = runner.liveCwd(p[1]);
        if (!cwd) return json({ ok: false, error: "cwd 不可用（会话未运行 / 平台不支持）" }, 404);
        return json({ ok: true, cwd });
      }
      // POST /sessions/{id}/input { data }
      if (p[0] === "sessions" && p.length === 3 && p[2] === "input" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.data !== "string") return json({ ok: false, error: "缺少 data" }, 400);
        return runner.input(p[1], body.data);
      }
      // POST /sessions/{id}/resize { cols, rows }
      if (p[0] === "sessions" && p.length === 3 && p[2] === "resize" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad body" }, 400);
        return runner.resize(p[1], Number(body.cols), Number(body.rows));
      }
      // POST /sessions/{id}/kill
      if (p[0] === "sessions" && p.length === 3 && p[2] === "kill" && req.method === "POST") {
        return runner.kill(p[1]);
      }

      // ---------- agent 运行中命令（pi-web 会话 bash 实时视图） ----------
      // GET /pi-commands → 列表（running + 近期 done）
      if (p[0] === "pi-commands" && p.length === 1 && req.method === "GET") {
        if (!piCommands) return json({ ok: false, error: "扩展未初始化" }, 500);
        piCommands.lateCatchUp();
        return json({ ok: true, commands: piCommands.list() });
      }
      // GET /pi-commands/{id} → 初始快照（大消息不走 event-bus：text=publishedText + seq）；
      // ?meta=1 → 轻量摘要（无 text）——状态定案用，已结束命令免拉全量文本
      if (p[0] === "pi-commands" && p.length === 2 && req.method === "GET") {
        const snap = piCommands.get(p[1], ctx.searchParams.get("meta") === "1");
        if (!snap) return json({ ok: false, error: "unknown pi-command" }, 404);
        return json({ ok: true, ...snap });
      }
      // POST /pi-commands/{id}/kill → abortBash（只杀命令，不 abort turn）
      if (p[0] === "pi-commands" && p.length === 3 && p[2] === "kill" && req.method === "POST") {
        if (!piCommands) return json({ ok: false, error: "扩展未初始化" }, 500);
        return piCommands.kill(p[1]);
      }

      // ---------- 常用命令 ----------
      // GET /commands → { commands, groups }（含分组树）
      if (p[0] === "commands" && p.length === 1 && req.method === "GET") {
        return json({ ok: true, commands: store.list(), groups: store.listGroups() });
      }
      // GET /commands/suggest?q=<前缀>&limit=n → 输入联想静态 provider（契约：供 ai-helper 聚合；排序：匹配度 > 运行频次 > 最近运行 > 名称）
      if (p[0] === "commands" && p[1] === "suggest" && p.length === 2 && req.method === "GET") {
        return json({ ok: true, q: ctx.searchParams.get("q") || "", results: commandSuggest(store, ctx.searchParams.get("q") || "", parseInt(String(ctx.searchParams.get("limit") || "6"), 10)) });
      }
      // POST /commands
      if (p[0] === "commands" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        // name 可选（UI「名称（默认=命令）」；store.create 已支持缺省用 cmd）——只校验命令内容
        if (!body || !body.cmd || !String(body.cmd).trim()) return json({ ok: false, error: "缺少命令内容（cmd）" }, 400);
        return json({ ok: true, command: store.create({
          name: body.name ? String(body.name) : undefined,
          cmd: String(body.cmd),
          cwd: body.cwd ? String(body.cwd) : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
          env: body.env && typeof body.env === "object" ? body.env : undefined,
          confirm: body.confirm === true,
          groupId: body.groupId ? String(body.groupId) : null,
          sandbox: normSandbox(body.sandbox),
          // suggest 缺省按 source 判定（store：manual 开 / ai-message·clipboard 关）；显式传才覆盖
          suggest: body.suggest === undefined ? undefined : (body.suggest === true || body.suggest === "true"),
          source: body.source || "manual",
        }) }, 201);
      }
      // POST /commands/check {text, cwd?} （消息识别：词库全文扫描 + 有效性校验 → 命中命令）
      if (p[0] === "commands" && p[1] === "check" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const text = String(body.text || "");
        const cwd = body.cwd ? String(body.cwd) : undefined;
        if (!text.trim()) return json({ ok: false, error: "缺少 text" }, 400);
        const commands = await extractCommandsFromText(dirCfg, text, cwd);
        return json({ ok: true, commands, single: commands.length === 1 ? commands[0] : null });
      }
      // GET /commands/describe?text=…  （命令管理面板：识别首命令 → 分类/描述/相关短语）
      if (p[0] === "commands" && p[1] === "describe" && p.length === 2 && req.method === "GET") {
        const text = ctx.searchParams.get("text") || "";
        if (!text.trim()) return json({ ok: false, error: "缺少 text" }, 400);
        return json({ ok: true, ...describeCommand(text) });
      }
      // GET /commands/dict  → 查看词库（内置类别 + 用户自定义）
      if (p[0] === "commands" && p[1] === "dict" && p.length === 2 && req.method === "GET") {
        return json({ ok: true, groups: COMMAND_DICT_GROUPS(), user: loadUserDict(dirCfg) });
      }
      // PUT /commands/dict { extra: ["mytool", ...] }  → 保存用户自定义词库
      if (p[0] === "commands" && p[1] === "dict" && p.length === 2 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body || !Array.isArray(body.extra)) return json({ ok: false, error: "需要 extra 数组" }, 400);
        return json({ ok: true, user: saveUserDict(dirCfg, body.extra.map(String)) });
      }
      // ---- 分组管理 ----
      // POST /commands/groups { name, parentId? }
      if (p[0] === "commands" && p[1] === "groups" && p.length === 2 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.name) return json({ ok: false, error: "缺少 name" }, 400);
        return json({ ok: true, group: store.createGroup(String(body.name), body.parentId ? String(body.parentId) : null) }, 201);
      }
      // PUT /commands/groups/{id} { name?, parentId? }
      if (p[0] === "commands" && p[1] === "groups" && p.length === 3 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad body" }, 400);
        const updated = store.updateGroup(p[2], {
          name: body.name !== undefined ? String(body.name) : undefined,
          parentId: body.parentId !== undefined ? (body.parentId ? String(body.parentId) : null) : undefined,
        });
        if (!updated) return json({ ok: false, error: "unknown group" }, 404);
        return json({ ok: true, group: updated });
      }
      // DELETE /commands/groups/{id}（级联删子孙，命令移入未分组）
      if (p[0] === "commands" && p[1] === "groups" && p.length === 3 && req.method === "DELETE") {
        return json({ ok: store.removeGroup(p[2]) });
      }
      // PUT/DELETE /commands/{id}
      if (p[0] === "commands" && p.length === 2 && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad body" }, 400);
        // suggest 规范化布尔（防字符串 "false" 穿透存储）
        if (body.suggest !== undefined) body.suggest = body.suggest === true || body.suggest === "true";
        const updated = store.update(p[1], body);
        if (!updated) return json({ ok: false, error: "unknown command" }, 404);
        return json({ ok: true, command: updated });
      }
      if (p[0] === "commands" && p.length === 2 && req.method === "DELETE") {
        return json({ ok: store.remove(p[1]) });
      }

      // ---------- 审计历史 ----------
      // GET /history?from&to&source&exit&cmd&limit | groupBy=source（按来源汇总：数量/最近/失败率，§3.1）
      if (p[0] === "history" && p.length === 1 && req.method === "GET") {
        if (ctx.searchParams.get("groupBy") === "source") {
          return json({ ok: true, groupBy: "source", groups: audit.summarizeBySource() });
        }
        return json({ ok: true, records: audit.query({
          from: ctx.searchParams.get("from") ? Number(ctx.searchParams.get("from")) : undefined,
          to: ctx.searchParams.get("to") ? Number(ctx.searchParams.get("to")) : undefined,
          source: ctx.searchParams.get("source") || undefined,
          exit: ctx.searchParams.get("exit") || undefined,
          cmd: ctx.searchParams.get("cmd") || undefined,
          limit: ctx.searchParams.get("limit") ? Number(ctx.searchParams.get("limit")) : undefined,
        }) });
      }
      // GET /history/verify（哈希链校验——防篡改）——必须在 /{id} 之前
      if (p[0] === "history" && p[1] === "verify" && p.length === 2 && req.method === "GET") {
        return json({ ok: true, ...audit.verify() });
      }
      // GET /history/{id}（含输出）
      if (p[0] === "history" && p.length === 2 && req.method === "GET") {
        const rec = audit.getById(p[1]);
        if (!rec) return json({ ok: false, error: "unknown record" }, 404);
        const output = audit.readOutput(p[1]);
        return json({ ok: true, record: rec, output });
      }

      // ---------- 诊断 ----------
      // GET /diag
      if (p[0] === "diag") {
        return json({ ok: true, ...runner.diag(), pi: piCommands?.diag() ?? null, retentionDays: audit.retentionDays, configDir: dirCfg });
      }

      return json({ ok: false, error: "not found: " + p.join("/") }, 404);
    },
  },
};
