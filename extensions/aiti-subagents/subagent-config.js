/**
 * 子代理并发配置纯函数层 —— 读写上游 <agentDir>/extensions/subagent/config.json
 *
 * 归属：aiti-subagents 扩展（配置语义所有者）；UI 消费方 = aiti-extman 详情页（全量表单）
 *      + aiti-agent-manager 面板（简版 4 键），两端共用 GET/PUT /api/extensions/aiti-subagents/config。
 *
 * 配置键全部来自上游 pi-subagents（@aiti-ai/pi-subagents）docs/configuration.md §422-§476：
 *   globalConcurrencyLimit(20) / maxSubagentSpawnsPerRun(64) / maxSubagentSpawnsPerSession(不限) /
 *   maxActiveAsyncRunsPerSession(不限) / capacity.abandonedSlotReleaseAfterMs(1200000) /
 *   parallel.maxTasks(8) / parallel.concurrency(4)
 *
 * 语义红线：
 *   - 只 merge 白名单键，磁盘上的未知键一律原样保留（上游配置键远多于白名单，绝不整文件重写）
 *   - PUT body 里出现白名单外的键 → 400（客户端以为写了实际没写，宁可报错）
 *   - null = 删除该键（回退上游缺省）；0 对 nonNegativeInt 键是合法值（= 不限）
 *   - 写盘原子（tmp + rename），缩进 Tab + 尾换行（对齐上游 saveConfig 风格）
 *   - 磁盘文件 JSON 损坏时 GET 报 readable:false、PUT 拒绝写（不覆盖损坏文件，防丢用户手配）
 *
 * ⚠ jiti 子模块缓存：本文件被 index.ts require，改动不随 POST /reload 生效
 *   （同 upstream-fleet.js 的已知限制）；首次部署生效，后续改动需重启 pi-web 实例。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** 白名单键元数据（label/desc 随 GET API 返回，UI 零文案——文案归本扩展所有）。 */
const KEYS = [
  {
    key: "globalConcurrencyLimit", type: "positiveInt", def: 20,
    label: "单 run 内并发上限",
    desc: "同一 run 内同时运行的子代理数量；超出者在启动处排队，等活跃兄弟完成再启动（排队不耗模型配额）。保护上游 AI 限流。缺省 20；工作流调用可逐 workflow 覆盖。",
  },
  {
    key: "maxSubagentSpawnsPerRun", type: "positiveInt", def: 64,
    label: "单 run 累计 spawn 预算",
    desc: "一个顶层 run 树内累计可启动的子代理总数（含 parallel/chain/count/expand/嵌套）。缺省 64；env PI_SUBAGENT_MAX_SPAWNS_PER_RUN。",
  },
  {
    key: "maxSubagentSpawnsPerSession", type: "nonNegativeInt", def: null,
    label: "会话累计 spawn 预算",
    desc: "一个父会话累计可启动的子代理总数（含已完成/失败的）。不配=不限；0=不限。超限可在根会话用 grant-spawn-budget 手动加额度；env PI_SUBAGENT_MAX_SPAWNS_PER_SESSION。",
  },
  {
    key: "maxActiveAsyncRunsPerSession", type: "nonNegativeInt", def: null,
    label: "并发活跃顶层 async run 数",
    desc: "同一父会话同时活跃的顶层异步 run 数上限（前台与嵌套子代理不占槽）。不配=不限；0=不限。⚠ 跨 run 并发只有这层闸能拦（单 run 并发上限管不到多个独立 run）。建议 4。",
  },
  {
    key: "capacity.abandonedSlotReleaseAfterMs", type: "capacitySlotMs", def: 1200000,
    label: "死进程槽兜底回收",
    desc: "async run 的 runner 进程已死但清理证明缺失时，超过该时长后回收其活跃槽（毫秒，5 分钟 ~ 24 小时，缺省 20 分钟）；false=严格保留不回收。",
  },
  {
    key: "parallel.maxTasks", type: "positiveInt", def: 8,
    label: "parallel 工作流批大小",
    desc: "内置 parallel 工作流单批任务数上限（subagent 调用时 args 可按次覆盖）。缺省 8。",
  },
  {
    key: "parallel.concurrency", type: "positiveInt", def: 4,
    label: "parallel 工作流并发度",
    desc: "内置 parallel 工作流同时运行的子代理数（调用时可按次覆盖；与单 run 并发上限取更严者）。缺省 4。",
  },
];

const CAPACITY_MIN_MS = 5 * 60 * 1000; // 5 min（上游 MIN_ABANDONED_SLOT_RELEASE_AFTER_MS）
const CAPACITY_MAX_MS = 24 * 60 * 60 * 1000; // 24 h（上游 MAX）

/** 配置文件绝对路径（与上游 getAgentDir()+getConfigPath() 语义一致；agentDir 参数仅供测试注入）。
 *  ⚠ 复刻上游 ~ 展开：env 可为 "~" 或 "~/xxx"（相对家目录），原样使用会读写错位（深审 2026-10-17 发现）。
 *  兕底目录名写死 ".pi"——上游 getConfigDirName() 可被 pi 包 package.json piConfig.configDir 改写，
 *  但官方包恒为 ".pi"，jiti 环境拿不到 pi 包根，罕见漂移可接受。 */
function configFilePath(agentDir) {
  let dir = agentDir;
  if (!dir) {
    const configured = process.env.PI_CODING_AGENT_DIR;
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    if (configured === "~") dir = home;
    else if (configured && (configured.startsWith("~/") || configured.startsWith("~\\"))) dir = path.join(home, configured.slice(2));
    else dir = configured || path.join(home, ".pi", "agent");
  }
  return path.join(dir, "extensions", "subagent", "config.json");
}

/** 单值校验。返回 null=合法，否则错误文案。 */
function validateValue(meta, value) {
  if (value === null) return null; // 删键（回退缺省）
  if (meta.type === "positiveInt") {
    if (!Number.isInteger(value) || value < 1) return `${meta.label} 必须是 ≥1 的整数`;
    return null;
  }
  if (meta.type === "nonNegativeInt") {
    if (!Number.isInteger(value) || value < 0) return `${meta.label} 必须是 ≥0 的整数（0=不限）`;
    return null;
  }
  if (meta.type === "capacitySlotMs") {
    if (value === false) return null;
    if (!Number.isInteger(value) || value < CAPACITY_MIN_MS || value > CAPACITY_MAX_MS) {
      return `${meta.label} 必须是 false 或 ${CAPACITY_MIN_MS}~${CAPACITY_MAX_MS} 毫秒间的整数`;
    }
    return null;
  }
  return `${meta.label} 未知类型 ${meta.type}`;
}

function isBlank(v) {
  // 注意：null 不算 blank——它是显式「删键回退缺省」指令；空串/undefined 才是「未改动跳过」
  return v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * 校验并把白名单更新 merge 进当前配置。
 * current: 磁盘现有配置对象（原样不动）；updates: { "顶层键或 a.b 键": value }（null=删键）。
 * 返回 { ok:true, config } 或 { ok:false, errors:[...] }。
 */
function validateAndMerge(current, updates) {
  const byKey = new Map(KEYS.map((k) => [k.key, k]));
  const errors = [];
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return { ok: false, errors: ["updates 必须是对象"] };
  }
  // 深拷贝当前配置（保留未知键），只在白名单范围内改写
  const next = JSON.parse(JSON.stringify(current ?? {}));
  for (const [key, value] of Object.entries(updates)) {
    const meta = byKey.get(key);
    if (!meta) { errors.push(`未知配置键 "${key}"（只允许白名单键）`); continue; }
    if (isBlank(value)) continue; // 空=未改动，跳过（PUT 部分更新）
    const err = validateValue(meta, value);
    if (err) { errors.push(err); continue; }
    if (!key.includes(".")) {
      if (value === null) delete next[key];
      else next[key] = value;
      continue;
    }
    // 嵌套键（capacity.* / parallel.*）：只动已知子键，兄弟子键保留
    const [parent, child] = key.split(".");
    const holder = (typeof next[parent] === "object" && next[parent] !== null && !Array.isArray(next[parent]))
      ? { ...next[parent] } : {};
    if (value === null) delete holder[child];
    else holder[child] = value;
    if (Object.keys(holder).length === 0) delete next[parent];
    else next[parent] = holder;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: next };
}

/** 读磁盘配置。文件不存在 = 空配置 + readable:true；JSON 损坏 = readable:false（PUT 拒绝覆盖）。 */
function readConfig(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e && e.code === "ENOENT") return { config: {}, readable: true, error: null };
    return { config: {}, readable: false, error: `读取失败: ${e && e.message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: {}, readable: false, error: "文件内容不是 JSON 对象" };
    }
    return { config: parsed, readable: true, error: null };
  } catch (e) {
    return { config: {}, readable: false, error: `JSON 解析失败: ${e && e.message}` };
  }
}

/** 原子写盘（tmp + rename；Tab 缩进 + 尾换行，对齐上游 saveConfig）。 */
function writeConfigAtomic(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** GET API 用：键元数据（label/desc/type 给 UI 渲染）。 */
function meta() {
  return KEYS.map(({ key, type, label, desc }) => ({ key, type, label, desc }));
}

/** GET API 用：语义缺省（null=不配=不限，UI 显示「不限」）。 */
function defaults() {
  return Object.fromEntries(KEYS.map((k) => [k.key, k.def]));
}

module.exports = {
  KEYS, CAPACITY_MIN_MS, CAPACITY_MAX_MS,
  configFilePath, validateValue, validateAndMerge, readConfig, writeConfigAtomic, meta, defaults,
};
