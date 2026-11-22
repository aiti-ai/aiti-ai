/**
 * session-manager — 热词提取库
 *
 * 从 SQLite messages 索引中提取中英文热词（供 aiti-ai-input ASR 链路消费：
 * seaco 模型级 hotword 偏置，docs/aiti-voice-input-realtime-asr-plan.md）。
 *
 * 提取策略（2026-09 重写 v2）：
 *   - 中文：jieba 真分词（@node-rs/jieba，扩展自带 node_modules）+ 停用词过滤 + 长度权重；
 *     jieba 不可用（依赖缺失/加载失败）时降级 n-gram（含停用词淘汰，质量略差但可用）。
 *   - 英文：2-51 字符词（允许连字符/点/下划线——aiti-devtools / pi-web 等术语整体入词），
 *     停用词/编程关键词黑名单；反引号/引号内 token（文件名/标识符）加权 ×3。
 *   - 时间加权（真实现）：消息 ts 分档——1h 内 1.0 / 2h 0.8 / 4h 0.5 / 24h 0.3 /
 *     7d 0.15 / 更早 0.05；none = 全量 1.0。
 *   - 缓存：进程内存 10 分钟 TTL（key = 参数，不含时间戳——旧实现 key 带 ts
 *     导致永不命中，已修）。
 */
import { DatabaseSync } from "node:sqlite";

// jieba 真分词（懒加载失败降级：jiti 扩展依赖解析失败或包缺失时不影响热词链路）
let _jieba: { cut: (text: string, hmm?: boolean) => string[] } | null = null;
try {
  const { Jieba } = await import("@node-rs/jieba");
  const { dict } = await import("@node-rs/jieba/dict.js");
  _jieba = Jieba.withDict(dict);
} catch {
  _jieba = null;
}

// 缓存存储 (进程级内存缓存)
const hotwordCache = new Map<string, {
  cn: string[];
  en: string[];
  timestamp: number;
}>();

// 缓存 TTL (毫秒) - 10 分钟
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 提取行数上限（按 ts 倒序取最近 N 行，命中 idx_messages_ts 索引序截断）。
 *  热词偏置只需要「最近偏好」——2026-09-11 实测：库涨到 2GB（41.8 万条消息）后
 *  无上限全量 stmt.all() 单次取数即 >10s，把消费方（aiti-ai-input 的 10s 竞速）拖超时，
 *  热词链路整体降级空表。2 万行 ≈ 最近文本 ~15MB，提取亚秒级。 */
const HOTWORD_ROW_CAP = 20_000;

// 默认热词数量
const DEFAULT_CN_COUNT = 20;
const DEFAULT_EN_COUNT = 20;

// 生成缓存键（key = 参数序列化，不含时间戳——是缓存有效性判断依据）
function makeCacheKey(params: {
  cnCount?: number;
  enCount?: number;
  timeWeight?: string;
  includeUser?: boolean;
  includeAi?: boolean;
  cwd?: string;
  paths?: string[];
}): string {
  const keyData = {
    cnCount: params.cnCount ?? DEFAULT_CN_COUNT,
    enCount: params.enCount ?? DEFAULT_EN_COUNT,
    timeWeight: params.timeWeight ?? "none",
    includeUser: params.includeUser ?? true,
    includeAi: params.includeAi ?? true,
    cwd: params.cwd ?? null,
    paths: params.paths ?? null,
  };
  return `hotwords_${Buffer.from(JSON.stringify(keyData)).toString("base64")}`;
}

// 检查缓存是否有效
function isCacheValid(cacheKey: string): boolean {
  const entry = hotwordCache.get(cacheKey);
  if (!entry) return false;
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// 设置缓存
function setCache(cacheKey: string, cn: string[], en: string[]): void {
  hotwordCache.set(cacheKey, {
    cn,
    en,
    timestamp: Date.now(),
  });
}

/** 时间权重：消息 ts 分档（1h 1.0 → 7d+ 0.05）；none / 无 ts → 1.0 */
function timeWeightOf(ts: string | null | undefined, timeWeight: string): number {
  if (timeWeight === "none" || !ts) return 1;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 1;
  const hours = (Date.now() - t) / 3600e3;
  if (hours <= 1) return 1.0;
  if (hours <= 2) return 0.8;
  if (hours <= 4) return 0.5;
  if (hours <= 24) return 0.3;
  if (hours <= 24 * 7) return 0.15;
  return 0.05;
}

/** 消息行（text + ts 一起拉，时间加权用） */
interface MsgRow { text: string | null; ts: string | null; }

/** 提取范围：includeUser=用户消息（role=user）；includeAi=AI 消息（role=assistant）；
 *  路径过滤二选一：paths=关注路径集合（git-trace watchPaths，多路径，路径前缀匹配）；cwd=单路径（兼容）；默认全包含 */
interface HotwordScope { includeUser?: boolean; includeAi?: boolean; cwd?: string; paths?: string[]; }

function fetchMessages(db: DatabaseSync, scope: HotwordScope = {}): MsgRow[] {
  const includeUser = scope.includeUser !== false;
  const includeAi = scope.includeAi !== false;
  const paths = (Array.isArray(scope.paths) ? scope.paths.filter((p) => p && String(p).trim()).map((p) => String(p).trim()) : []);
  const cwd = !paths.length && scope.cwd ? String(scope.cwd) : null;
  // 按范围组装 role 过滤；两者都不提取 → 返回空（提取端降级）
  const roles: string[] = [];
  if (includeUser) roles.push("user");
  if (includeAi) roles.push("assistant");
  if (!roles.length) return [];
  // 路径条件：paths（关注路径集合，前缀匹配：路径本身或其子目录）或单 cwd；均无 → 全局
  let pathSql = "";
  const pathArgs: string[] = [];
  if (paths.length) {
    pathSql = "AND (" + paths.map(() => "(s.cwd = ? OR s.cwd LIKE ?)").join(" OR ") + ")";
    for (const pth of paths) pathArgs.push(pth, pth.replace(/\/+$/, "") + "/%");
  } else if (cwd) {
    pathSql = "AND (s.cwd = ? OR s.cwd LIKE ?)";
    pathArgs.push(cwd, cwd.replace(/\/+$/, "") + "/%");
  }
  // ORDER BY ts DESC + LIMIT：最近优先（热词语义），索引序截断不再全表捞取
  const stmt = db.prepare(`
    SELECT m.text, m.ts
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE s.archived = 0
    AND m.role IN (${roles.map(() => "?").join(",")})
    AND m.text IS NOT NULL AND m.text != ''
    ${pathSql}
    ORDER BY m.ts DESC
    LIMIT ?
  `);
  return stmt.all(...roles, ...pathArgs, HOTWORD_ROW_CAP) as MsgRow[];
}

// 中文停用词（n-gram 无词边界，2-3 字碎片大量是普通短语/虚词；含停用词子的片段无纠偏价值，直接丢弃）
const CN_STOP = new Set([
  // 虚词/代词/介词（必杀）
  "这个", "那个", "这些", "那些", "什么", "怎么", "怎样", "为什么", "一个", "一种", "一些", "一下", "可以", "需要", "进行", "我们", "你们", "他们", "她们", "自己", "大家", "可能", "如果", "然后", "因为", "所以", "但是", "还是", "或者", "而且", "并且", "以及", "已经", "没有", "就是", "不是", "不会", "不要", "不能", "应该", "必须", "真的", "其实", "当然", "现在", "今天", "明天", "昨天", "之前", "之后", "以后", "目前", "首先", "其次", "最后", "通过", "对于", "关于", "按照", "根据", "由于", "是否", "如何", "无非", "比如", "例如", "这样", "那样", "这里", "那里", "哪里", "这个", "觉得", "感觉", "知道", "认为", "发现", "看到", "用到", "用到", "能够", "想要", "打算", "继续", "保持", "确认", "检查", "验证", "修复", "解决", "处理", "测试", "运行", "启动", "停止", "重启", "更新", "修改", "添加", "删除", "创建", "调用", "返回", "显示", "保存", "保留", "记录", "回复", "建议", "注意", "说明", "直接", "先看", "同时", "其实", "问题", "情况", "时候", "地方", "东西", "任务", "工作", "用户说",
  // 功能类通用词（会话/产品语境高频，但模型识别稳定、无纠偏价值——占名额不如留给术语）
  "页面", "消息", "用户", "文件", "扩展", "当前", "磁盘", "状态", "失败", "提交", "匹配", "代码", "完整", "真实", "按钮", "路径", "方案", "部署", "渲染", "加载", "实现", "全部", "自动", "完成", "内容", "文档", "恢复", "工具", "逻辑", "浏览器", "朗读", "错误", "刷新", "目录", "触发", "配置", "正常", "实际", "提示", "支持", "使用", "方式", "信息", "数据", "系统", "服务", "命令", "手机", "电脑",
  // 通用动词/数量词/虚词性实词（高频但无领域辨识度，识别本身稳定）
  "打开", "关闭", "点击", "找到", "存在", "出现", "不再", "还有", "所有", "其他", "只有", "开始", "一次", "一条", "两个", "一行", "每句", "正确", "成功", "关键", "默认", "手动", "同步", "一致", "覆盖", "重试", "模拟", "残留", "可见", "空白", "截图", "导航", "设置", "跟读", "滚动", "播放", "窗口", "重新", "除非", "无论如何", "重点", "简单", "基本", "直接说", "不行", "可以吗"
]);

// 英文停用词 + 编程通用词黑名单（语音场景高频但无纠偏价值；避免污染热词库）
const EN_STOP = new Set([
  // 通用停用词
  "the", "a", "an", "and", "or", "but", "for", "with", "of", "to", "in", "on", "at", "is", "are", "was", "were", "be", "been", "it", "this", "that", "these", "those", "as", "by", "from", "into", "its", "we", "you", "they", "he", "she", "not", "no", "yes", "can", "could", "will", "would", "should", "may", "might", "must", "do", "does", "did", "have", "has", "had", "then", "than", "so", "if", "else", "when", "where", "what", "which", "who", "how", "why", "all", "any", "some", "one", "two", "just", "more", "most", "also", "only", "very", "get", "set", "use", "new", "like", "make", "need", "want", "have", "over", "out", "up", "down", "off", "about", "after", "before", "between", "same", "such", "both", "each", "few", "own", "other", "again", "here", "there", "too", "yet", "much", "many", "ok", "okay", "good", "well", "yes", "hi", "hello", "thanks", "thank", "please", "sorry", "done", "ok", "sure", "right", "way", "time", "day", "now",
  // 编程语言关键词/限定符（口语场景无需热词）
  "const", "let", "var", "function", "return", "null", "undefined", "true", "false", "string", "number", "boolean", "object", "array", "void", "async", "await", "import", "export", "default", "class", "extends", "interface", "type", "enum", "try", "catch", "finally", "throw", "switch", "case", "break", "continue", "while", "for", "foreach", "instanceof", "typeof", "delete", "static", "public", "private", "protected", "readonly", "abstract", "implements", "yield", "super", "this", "self", "require", "module", "exports", "process", "console", "select", "insert", "update", "delete", "create", "table", "index", "where", "order", "group", "limit", "offset", "join", "left", "right", "inner", "from", "into", "values", "set", "nan", "none", "nil", "true", "false", "def", "print", "input", "output", "error", "warning", "info", "debug", "assert", "test", "mock", "fake", "use", "render", "mount", "unmount", "state", "props", "hooks", "effect", "ref", "memo", "context", "store", "router", "route", "fetch", "axios", "event", "target", "value", "length", "index", "key", "map", "filter", "reduce", "push", "pop", "shift", "unshift", "slice", "split", "join", "concat", "include", "find", "findindex", "some", "every", "sort", "reverse", "stringify", "parse", "promise", "resolve", "reject", "catch", "then", "chain", "await", "sleep", "timeout", "callback", "promise",
]);

function cnHotwordWeight(fragment: string): number {
  // 中文碎片权重：长度辨识度加权 + 停用词淘汰。
  // 无词边界 n-gram 下，2-3 字碎片大量是普通短语（用户说/已经/这个），
  // 4-6 字连续串更有领域辨识度（热词偏置本质是子串匹配，长串更精准）。
  if (fragment.length < 2) return 0;
  // 完全由停用词组成（或等于某停用词）→ 直接丢弃
  if (CN_STOP.has(fragment)) return 0;
  if (fragment.length === 2) {
    // 2 字碎片：只留「不含停用词子串」的（多数 2 字词无纠偏价值，压低占坑）
    for (const s of CN_STOP) if (fragment.length > s.length && fragment.includes(s)) return 0;
    return 0.4;
  }
  if (fragment.length === 3) {
    for (const s of CN_STOP) if (fragment.includes(s)) return 0;
    return 0.8;
  }
  // 4-6 字：含停用词核心的夹层碎片（“如果这个”“现在需要”）剔除，其余高权重
  for (const s of CN_STOP) if (fragment.includes(s)) return 0;
  return 2.0;
}

// 中文词频累加（分块调用：每块处理后让出事件循环，不阻塞 Node 主线程）
function accumulateChinese(rows: MsgRow[], scores: Map<string, number>, tw: string): void {
  // jieba 真分词：真词（2-8 字）+ 停用词剔除 + 长度权重（4+ 字术语/专名优先）
  if (_jieba) {
    for (const row of rows) {
      const text = row.text || "";
      if (!text) continue;
      const w = timeWeightOf(row.ts, tw);
      const words = _jieba.cut(text, false);
      for (const word of words) {
        if (word.length < 2 || word.length > 8) continue;          // 单字/超长排除
        if (!/^[\u4e00-\u9fff]+$/.test(word)) continue;              // 纯汉字
        if (CN_STOP.has(word)) continue;                             // 停用词直接丢
        let bad = false;
        for (const s of CN_STOP) {
          if (s.length >= 2 && word.length > s.length && word.includes(s)) { bad = true; break; }
        }
        if (bad) continue;                                           // 含停用词核心（“讨论一下”含“一下”）
        const boost = word.length >= 4 ? 1.5 : word.length === 3 ? 1.0 : 0.8;
        scores.set(word, (scores.get(word) || 0) + w * boost);
      }
    }
    return;
  }
  // 降级：n-gram（无分词器时的兜底；停用词淘汰 + 长度权重）
  for (const row of rows) {
    const text = row.text || "";
    const matches = text.match(/[\u4e00-\u9fff]{2,6}/g);
    if (!matches) continue;
    const w = timeWeightOf(row.ts, tw);
    for (const match of matches) {
      const boost = cnHotwordWeight(match);
      if (boost > 0) scores.set(match, (scores.get(match) || 0) + w * boost);
    }
  }
}

// 英文词频累加（允许连字符/点/下划线的术语整体入词：aiti-devtools / pi-web / api.ts 等——
// 原来是 [a-zA-Z]{3,30} 会把 aiti-devtools 拆成 aiti+devtools 两个碎片，术语辨识度下降）
function accumulateEnglish(rows: MsgRow[], scores: Map<string, number>, tw: string): void {
  const englishWordRegex = /[A-Za-z][A-Za-z0-9_.-]{1,50}/g;
  const codeTokenRegex = /[`"'][^`"'\n]{2,80}[`"']/g;
  for (const row of rows) {
    const text = row.text || "";
    const w = timeWeightOf(row.ts, tw);
    // 代码片段（反引号/引号内 token：文件名/模块名/标识符）→ 领域术语高价值，先加权
    const codeMatches = text.match(codeTokenRegex);
    if (codeMatches) {
      for (const seg of codeMatches) {
        const inner = seg.replace(/^[`"']|[`"']$/g, "");
        const words = inner.match(/[A-Za-z][A-Za-z0-9_.-]{1,50}/g);
        if (!words) continue;
        for (const match of words) {
          const lowerWord = match.toLowerCase();
          if (EN_STOP.has(lowerWord) || !/^[a-z0-9][a-z0-9_.-]{1,50}$/.test(lowerWord)) continue;
          scores.set(lowerWord, (scores.get(lowerWord) || 0) + w * 3.0);
        }
      }
    }
    const matches = text.match(englishWordRegex);
    if (!matches) continue;
    for (const match of matches) {
      const lowerWord = match.toLowerCase();
      if (EN_STOP.has(lowerWord)) continue; // 停用词/编程关键词不进热词（无纠偏价值且高频污染）
      // 词形白名单：纯字母数字/连字符/点/下划线；剔除 <s> / 纯符号残留
      if (!/^[a-z0-9][a-z0-9_.-]{1,50}$/.test(lowerWord)) continue;
      scores.set(lowerWord, (scores.get(lowerWord) || 0) + w);
    }
  }
}

/** 词频 top-N（过滤长尾 2.5 + 同频长词优先） */
function topWords(scores: Map<string, number>, n: number, locale: string): string[] {
  const filtered = [...scores.entries()].filter(([, s]) => s >= 2.5);
  filtered.sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length) || a[0].localeCompare(b[0], locale));
  return filtered.slice(0, n).map(([word]) => word);
}

/** 统计中英文句子数（按句末标点/换行拆分；消费方展示用） */
function countSentences(rows: MsgRow[]): { zh: number; en: number } {
  let zh = 0;
  let en = 0;
  for (const row of rows) {
    const sents = String(row.text || "").split(/[。！？!?\n；;]+/);
    for (const s of sents) {
      const t = s.trim();
      if (!t) continue;
      if (/[\u4e00-\u9fff]/.test(t)) zh++;
      if (/[a-zA-Z]{2,}/.test(t)) en++;
    }
  }
  return { zh, en };
}

// 应用时间加权（保留导出兼容；加权已在提取时逐条应用，此处仅透传）
function applyTimeWeight(
  wordsWithFreq: Map<string, number>,
  _timeWeight: "1h" | "24h" | "7d" | "none"
): Map<string, number> {
  return wordsWithFreq;
}

// 主要导出函数
export interface HotwordsResult {
  cn: string[];
  en: string[];
  stats: {
    totalMessages: number;
    analyzedSessions: number;
    /** 中文句子数（按句末标点/换行拆分，含中文字符） */
    zhSentences: number;
    /** 英文句子数（含 2+ 字母英文词） */
    enSentences: number;
    timeRange: string;
  };
}

/**
 * 从 session-manager SQLite 中提取热词
 * @param cnCount 中文热词数量上限
 * @param enCount 英文热词数量上限
 * @param timeWeight 时间权重: "1h", "24h", "7d", "none"
 * @returns 包含中英文热词和统计信息的结果
 */
export async function extractHotwords(
  params: {
    cnCount?: number;
    enCount?: number;
    timeWeight?: string;
    includeUser?: boolean;
    includeAi?: boolean;
  } = {}
): Promise<HotwordsResult> {
  // 无 ctx 的解耦入口：需要 DB 路径的调用方改用 extractHotwordsFromDB（HTTP/服务出口路径）
  const { cnCount, enCount, timeWeight, includeUser, includeAi } = params;
  const ck = makeCacheKey({ cnCount, enCount, timeWeight, includeUser, includeAi });
  if (isCacheValid(ck)) {
    const entry = hotwordCache.get(ck)!;
    return {
      cn: entry.cn,
      en: entry.en,
      stats: { totalMessages: 0, analyzedSessions: 0, zhSentences: 0, enSentences: 0, timeRange: timeWeight || "none" },
    };
  }
  return { cn: [], en: [], stats: { totalMessages: 0, analyzedSessions: 0, zhSentences: 0, enSentences: 0, timeRange: timeWeight || "none" } };
}

// 分块大小：每块处理后让出事件循环（Node 主线程不被热词提取卡住——16 万消息全量正则统计若同步跑会阻塞数秒）
const EXTRACT_CHUNK = 4000;

/**
 * 带数据库路径的热词提取（异步分块版——后台补，不阻塞请求/事件循环）
 * @param dbPath SQLite 数据库路径
 * @param params 参数
 * @returns 热词结果
 */
export async function extractHotwordsFromDBAsync(
  dbPath: string,
  params: {
    cnCount?: number;
    enCount?: number;
    timeWeight?: string;
    /** 提取范围：含用户消息（role=user，默认 true） */
    includeUser?: boolean;
    /** 提取范围：含 AI 消息（role=assistant，默认 true） */
    includeAi?: boolean;
    /** 只取该 workspace（sessions.cwd 精确匹配）；缺省全局 */
    cwd?: string;
    /** 关注路径集合（git-trace watchPaths；多路径前缀匹配，优先于 cwd） */
    paths?: string[];
  } = {}
): Promise<HotwordsResult> {
  const {
    cnCount = DEFAULT_CN_COUNT,
    enCount = DEFAULT_EN_COUNT,
    timeWeight = "none",
    includeUser,
    includeAi,
    cwd,
    paths,
  } = params;
  const tw = timeWeight as "1h" | "24h" | "7d" | "none";

  // 1. 检查缓存（key 含范围参数）
  const cacheKey = makeCacheKey({ cnCount, enCount, timeWeight, includeUser, includeAi, cwd, paths });
  if (isCacheValid(cacheKey)) {
    const entry = hotwordCache.get(cacheKey)!;
    return {
      cn: entry.cn,
      en: entry.en,
      stats: { totalMessages: 0, analyzedSessions: 0, zhSentences: 0, enSentences: 0, timeRange: timeWeight || "none" },
    };
  }

  const db = new DatabaseSync(dbPath);
  try {
    // 2. 一次拉取消息行（SQL 快，毫秒级）→ 分块提取（每块结束 setImmediate 让出事件循环）
    const rows = fetchMessages(db, { includeUser, includeAi, cwd, paths });
    const cnScores = new Map<string, number>();
    const enScores = new Map<string, number>();
    let zhSent = 0;
    let enSent = 0;
    for (let i = 0; i < rows.length; i += EXTRACT_CHUNK) {
      const chunk = rows.slice(i, i + EXTRACT_CHUNK);
      accumulateChinese(chunk, cnScores, tw);
      accumulateEnglish(chunk, enScores, tw);
      const s = countSentences(chunk);
      zhSent += s.zh;
      enSent += s.en;
      await new Promise((r) => setImmediate(r)); // 让出事件循环：其它请求不被阻塞
    }
    const cnWords = topWords(cnScores, cnCount, "zh");
    const enWords = topWords(enScores, enCount, "en");

    // 3. 设置缓存
    setCache(cacheKey, cnWords, enWords);

    // 4. 统计信息
    const totalMessagesStmt = db.prepare("SELECT COUNT(*) as count FROM messages");
    const totalMessagesRow = totalMessagesStmt.get() as { count: number };
    const totalMessages = totalMessagesRow?.count || 0;

    const activeSessionsStmt = db.prepare(
      "SELECT COUNT(DISTINCT session_id) as cnt FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE archived = 0)"
    );
    const activeSessionsRow = activeSessionsStmt.get() as { cnt: number };
    const analyzedSessions = activeSessionsRow?.cnt || 0;

    return {
      cn: cnWords,
      en: enWords,
      stats: { totalMessages, analyzedSessions, zhSentences: zhSent, enSentences: enSent, timeRange: timeWeight || "none" },
    };
  } finally {
    try { db.close(); } catch { /* 关闭失败可忽略 */ }
  }
}

/** 兼容导出（旧名）：同异步分块版 */
export const extractHotwordsFromDB = extractHotwordsFromDBAsync;
