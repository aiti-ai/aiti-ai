/**
 * subagent-config 纯函数层单测（键校验边界 / merge 保留未知键 / null 删键 / 原子写 / 损坏文件拒写）。
 * 跑法：node scripts/test-web-ext.mjs --only aiti-subagents
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sc = require("./subagent-config.js");

function tmpAgentDir() {
  return mkdtempSync(join(tmpdir(), "subagent-config-test-"));
}

test("configFilePath：显式 agentDir 优先；env / 默认家目录逐级兜底；~ 前缀展开对齐上游 getAgentDir", () => {
  assert.equal(sc.configFilePath("/x/y"), join("/x/y", "extensions", "subagent", "config.json"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  const home = process.env.HOME || "";
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    assert.ok(sc.configFilePath().includes(join(".pi", "agent")));
    // 复刻上游 getAgentDir："~" = 家目录；"~/xxx"、"~\\xxx" = 家目录下拼接（原样使用会读写错位）
    process.env.PI_CODING_AGENT_DIR = "~";
    assert.equal(sc.configFilePath(), join(home, "extensions", "subagent", "config.json"));
    process.env.PI_CODING_AGENT_DIR = "~/myagent";
    assert.equal(sc.configFilePath(), join(home, "myagent", "extensions", "subagent", "config.json"));
    process.env.PI_CODING_AGENT_DIR = "/env/dir";
    assert.equal(sc.configFilePath(), join("/env/dir", "extensions", "subagent", "config.json"));
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("validateValue：positiveInt 拒绝 0/负数/非整数/字符串", () => {
  const m = { label: "X", type: "positiveInt" };
  assert.equal(sc.validateValue(m, 1), null);
  assert.equal(sc.validateValue(m, 64), null);
  assert.ok(sc.validateValue(m, 0));
  assert.ok(sc.validateValue(m, -1));
  assert.ok(sc.validateValue(m, 1.5));
  assert.ok(sc.validateValue(m, "4"));
  assert.ok(sc.validateValue(m, true));
  assert.equal(sc.validateValue(m, null), null); // null=删键，合法
});

test("validateValue：nonNegativeInt 接受 0（=不限），拒绝负数/非整数", () => {
  const m = { label: "Y", type: "nonNegativeInt" };
  assert.equal(sc.validateValue(m, 0), null);
  assert.equal(sc.validateValue(m, 4), null);
  assert.ok(sc.validateValue(m, -1));
  assert.ok(sc.validateValue(m, 2.5));
});

test("validateValue：capacitySlotMs 接受 false 与 5min~24h 整数毫秒，拒绝越界", () => {
  const m = { label: "Z", type: "capacitySlotMs" };
  assert.equal(sc.validateValue(m, false), null);
  assert.equal(sc.validateValue(m, 5 * 60 * 1000), null);
  assert.equal(sc.validateValue(m, 20 * 60 * 1000), null);
  assert.equal(sc.validateValue(m, 24 * 60 * 60 * 1000), null);
  assert.ok(sc.validateValue(m, 4 * 60 * 1000)); // < 5min
  assert.ok(sc.validateValue(m, 25 * 60 * 60 * 1000)); // > 24h
  assert.ok(sc.validateValue(m, 0));
  assert.ok(sc.validateValue(m, "false")); // 字符串 false 不收
});

test("validateAndMerge：合法更新生效；空值跳过；白名单外键报错", () => {
  const r1 = sc.validateAndMerge({ globalConcurrencyLimit: 4 }, { globalConcurrencyLimit: 8 });
  assert.equal(r1.ok, true);
  assert.equal(r1.config.globalConcurrencyLimit, 8);

  const r2 = sc.validateAndMerge({}, { globalConcurrencyLimit: "" });
  assert.equal(r2.ok, true);
  assert.equal(r2.config.globalConcurrencyLimit, undefined); // 空=不改

  const r3 = sc.validateAndMerge({}, { evilKey: 1 });
  assert.equal(r3.ok, false);
  assert.match(r3.errors[0], /未知配置键/);

  const r4 = sc.validateAndMerge({}, { globalConcurrencyLimit: 0 });
  assert.equal(r4.ok, false); // positiveInt 键 0 非法
});

test("validateAndMerge：未知键原样保留（绝不整文件重写）", () => {
  const current = {
    globalConcurrencyLimit: 4,
    asyncByDefault: false,
    forkContext: { mode: "pruned", model: "x" },
    scheduledRuns: { enabled: true },
  };
  const r = sc.validateAndMerge(current, { maxActiveAsyncRunsPerSession: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.config.globalConcurrencyLimit, 4); // 未提到的键保留
  assert.equal(r.config.asyncByDefault, false);
  assert.deepEqual(r.config.forkContext, { mode: "pruned", model: "x" });
  assert.deepEqual(r.config.scheduledRuns, { enabled: true });
  assert.equal(r.config.maxActiveAsyncRunsPerSession, 4);
  // 原 current 不被改写
  assert.equal(current.maxActiveAsyncRunsPerSession, undefined);
});

test("validateAndMerge：嵌套键只动已知子键，兄弟子键保留；空嵌套对象整体删除", () => {
  const current = { parallel: { maxTasks: 8, concurrency: 4, futureKey: "keep" }, capacity: { abandonedSlotReleaseAfterMs: 600000 } };
  const r1 = sc.validateAndMerge(current, { "parallel.concurrency": 2 });
  assert.equal(r1.ok, true);
  assert.equal(r1.config.parallel.concurrency, 2);
  assert.equal(r1.config.parallel.maxTasks, 8);
  assert.equal(r1.config.parallel.futureKey, "keep");

  const r2 = sc.validateAndMerge(current, { "capacity.abandonedSlotReleaseAfterMs": false });
  assert.equal(r2.ok, true);
  assert.equal(r2.config.capacity.abandonedSlotReleaseAfterMs, false);

  // capacity 只有这一个键，删成空后整个 capacity 键消失
  const r3 = sc.validateAndMerge({ capacity: { abandonedSlotReleaseAfterMs: 600000 } }, { "capacity.abandonedSlotReleaseAfterMs": null });
  assert.equal(r3.ok, true);
  assert.equal(r3.config.capacity, undefined);

  // parallel 还有兄弟键，删一个白名单子键后对象与兄弟键仍在（非白名单子键不可经 PUT 删——报错属设计）
  const r4 = sc.validateAndMerge(current, { "parallel.maxTasks": null });
  assert.equal(r4.ok, true);
  assert.equal(r4.config.parallel.maxTasks, undefined);
  assert.equal(r4.config.parallel.futureKey, "keep");
  assert.equal(r4.config.parallel.concurrency, 4);
});

test("validateAndMerge：null 删顶层键；updates 非对象报错", () => {
  const r1 = sc.validateAndMerge({ globalConcurrencyLimit: 4 }, { globalConcurrencyLimit: null });
  assert.equal(r1.ok, true);
  assert.equal(r1.config.globalConcurrencyLimit, undefined);
  const r2 = sc.validateAndMerge({}, null);
  assert.equal(r2.ok, false);
  const r3 = sc.validateAndMerge({}, [1]);
  assert.equal(r3.ok, false);
});

test("readConfig/writeConfigAtomic：不存在=空配置；原子写+读回；损坏文件 readable:false", () => {
  const dir = tmpAgentDir();
  try {
    const file = join(dir, "extensions", "subagent", "config.json");
    // 不存在
    const r0 = sc.readConfig(file);
    assert.equal(r0.readable, true);
    assert.deepEqual(r0.config, {});
    // 原子写（自动建目录）+ 无 tmp 残留
    sc.writeConfigAtomic(file, { globalConcurrencyLimit: 4, note: "keep" });
    assert.ok(existsSync(file));
    assert.equal(existsSync(`${file}.tmp-` + "x"), false);
    const raw = readFileSync(file, "utf8");
    assert.match(raw, /\n$/); // 尾换行
    assert.ok(raw.includes("\t")); // Tab 缩进
    const r1 = sc.readConfig(file);
    assert.deepEqual(r1.config, { globalConcurrencyLimit: 4, note: "keep" });
    // 损坏
    writeFileSync(file, "{ broken");
    const r2 = sc.readConfig(file);
    assert.equal(r2.readable, false);
    assert.match(r2.error, /JSON 解析失败/);
    // 非对象
    writeFileSync(file, "[1,2]");
    const r3 = sc.readConfig(file);
    assert.equal(r3.readable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("meta/defaults：7 个白名单键，缺省与上游一致", () => {
  const m = sc.meta();
  assert.equal(m.length, 7);
  assert.ok(m.every((k) => k.key && k.label && k.desc && k.type));
  const d = sc.defaults();
  assert.equal(d.globalConcurrencyLimit, 20);
  assert.equal(d.maxSubagentSpawnsPerRun, 64);
  assert.equal(d.maxSubagentSpawnsPerSession, null); // 不配=不限
  assert.equal(d.maxActiveAsyncRunsPerSession, null);
  assert.equal(d["capacity.abandonedSlotReleaseAfterMs"], 1200000);
  assert.equal(d["parallel.maxTasks"], 8);
  assert.equal(d["parallel.concurrency"], 4);
});
