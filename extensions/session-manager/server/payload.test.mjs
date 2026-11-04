/**
 * /sessions v2 传输编码 round-trip 测试（payload 方案 §9.4）。
 * Run: node --experimental-strip-types --test <repo>/pi-web-ext/session-manager/server/payload.test.mjs
 *
 * 背景：patch 形态曾因客户端误判（Array.isArray）导致增量响应清空 store——
 * 编码/解码映射必须有单测钉死，不靠「上线看一眼」。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { encodeSessionsV2, decodeRowV2, decodeSessionsPayload, decodeArchivedPayload } = await import("./payload.ts");

const ISO = (s) => new Date(s).toISOString();

test("encode → decode round-trip 还原标准行（cwd/projectRoot/ISO 时间戳逐字段相等）", () => {
  const rows = [
    {
      id: "a1", cwd: "/home/pi/workspace/aiti-ai", projectRoot: "/home/pi/workspace/aiti-ai",
      created: "2026-09-07T02:04:14.183Z", modified: "2026-09-07T02:05:14.039Z",
      messageCount: 12, firstMessage: "你好".repeat(30) + "截断", lastMessage: "hi",
      name: undefined, parentSessionId: undefined, agent: "pi", lastRole: "assistant",
      model: "glm-4.7", archived: false, extId: undefined, planFirst: true,
    },
    {
      id: "b2", cwd: "/home/pi/workspace/pi-web", projectRoot: "/home/pi/workspace/aiti-ai",
      created: "2026-09-01T00:00:00.000Z", modified: "2026-09-06T10:00:00.000Z",
      messageCount: 0, firstMessage: "", lastMessage: "",
    },
  ];
  const enc = encodeSessionsV2(rows);
  assert.equal(enc.fmt, 2);
  // 枚举表去重：aiti-ai 与 pi-web 两个 cwd + projectRoot 复用 aiti-ai
  assert.deepEqual([...enc.cwds].sort(), ["/home/pi/workspace/pi-web", "/home/pi/workspace/aiti-ai"].sort());
  // 紧凑行不再携带长键/长值
  const r0 = enc.sessions[0];
  assert.equal(r0.c, 0); // 第一行的 cwd 先入表
  assert.equal(typeof r0.ct, "number");
  assert.equal(r0.cwd, undefined);
  assert.equal(r0.created, undefined);
  // 其余字段原样
  assert.equal(r0.model, "glm-4.7");
  assert.equal(r0.planFirst, true);

  // decode 逐字段还原
  const back = enc.sessions.map((r) => decodeRowV2(r, enc.cwds));
  for (let i = 0; i < rows.length; i++) {
    const orig = rows[i], got = back[i];
    assert.equal(got.cwd, orig.cwd);
    assert.equal(got.projectRoot, orig.projectRoot);
    assert.equal(got.created, ISO(orig.created));
    assert.equal(got.modified, ISO(orig.modified));
    assert.equal(got.id, orig.id);
    assert.equal(got.model, orig.model);
    assert.equal(got.messageCount, orig.messageCount);
    // 短键已删（消费方看不到残留）
    assert.equal("c" in got, false);
    assert.equal("r" in got, false);
    assert.equal("ct" in got, false);
    assert.equal("mt" in got, false);
  }
});

test("非 ISO/缺失时间戳与缺失 cwd 防御性透传（不炸、不留错值）", () => {
  const enc = encodeSessionsV2([
    { id: "x", cwd: "", created: undefined, modified: "not-a-date" },
    { id: "y", created: 1699999999999 }, // 已是 ms 的异常源
  ]);
  assert.equal(enc.sessions[0].cwd, ""); // 空 cwd 走 spread 原样透传
  assert.equal(enc.sessions[0].created, undefined);
  assert.equal(enc.sessions[0].modified, "not-a-date");
  const back = enc.sessions.map((r) => decodeRowV2(r, enc.cwds));
  assert.equal(back[0].modified, "not-a-date");
  assert.equal(back[0].cwd, "");
});

test("decodeSessionsPayload：v2 全量解码 / 旧形态原样透传 / 异常 body 不炸", () => {
  const rows = [{ id: "a", cwd: "/p", created: "2026-09-07T00:00:00.000Z", modified: "2026-09-07T00:00:00.000Z" }];
  const enc = encodeSessionsV2(rows);
  const decoded = decodeSessionsPayload({ ...enc, rev: "r1" });
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].cwd, "/p");
  assert.equal(decoded[0].created, "2026-09-07T00:00:00.000Z");

  // 旧形态（fmt 缺失）→ 原样返回 sessions
  const legacy = decodeSessionsPayload({ sessions: rows, rev: "r1" });
  assert.equal(legacy, rows);

  // null / 空 body → undefined（调用方 ?? [] 兑底）
  assert.equal(decodeSessionsPayload(null), undefined);
  assert.equal(decodeSessionsPayload({}), undefined);

  // fmt=2 但 cwds 缺失（异常服务端）→ 走旧形态分支返回原 sessions
  const broken = decodeSessionsPayload({ fmt: 2, sessions: rows });
  assert.equal(broken, rows);
});

test("patch 形态映射约定：up 行经同一 decode 还原（客户端 store 同款调用路径）", () => {
  const rows = [{ id: "live1", cwd: "/home/x", projectRoot: "/home/x", created: "2026-09-07T01:00:00.000Z", modified: "2026-09-07T02:00:00.000Z", lastMessage: "进度" }];
  const enc = encodeSessionsV2(rows);
  const body = { rev: "r2", ...enc, patch: { up: enc.sessions, rm: ["gone1"] } };
  // 客户端判定：patch 是对象、d.sessions 是紧凑数组（非标准判定面）——
  // store 按 v2cwds 解码 up 行，逐字段还原
  const v2cwds = body.cwds;
  const up = body.patch.up.map((r) => decodeRowV2(r, v2cwds));
  assert.equal(up[0].cwd, "/home/x");
  assert.equal(up[0].created, "2026-09-07T01:00:00.000Z");
  assert.deepEqual(body.patch.rm, ["gone1"]);
});

test("微秒精度 ISO 不编码（无损约束）：保留原串，round-trip 恒等", () => {
  const us = "2026-08-30T12:51:19.043205Z";
  const enc = encodeSessionsV2([{ id: "u", cwd: "/p", created: us, modified: "2026-09-07T00:00:00.000Z" }]);
  assert.equal(enc.sessions[0].created, us); // 原串透传
  assert.equal(enc.sessions[0].modified, undefined); // 毫秒精度正常编码
  assert.equal(typeof enc.sessions[0].mt, "number");
  const back = decodeRowV2(enc.sessions[0], enc.cwds);
  assert.equal(back.created, us);
  assert.equal(back.modified, "2026-09-07T00:00:00.000Z");
});

test("归档拆分：encodeSessionsV2 第二参数独立 archived 数组，共享 cwds 枚举表", () => {
  const live = [{ id: "live1", cwd: "/home/x/proj", projectRoot: "/home/x/proj", created: "2026-09-07T01:00:00.000Z", modified: "2026-09-07T02:00:00.000Z" }];
  const archived = [{ id: "arch1", cwd: "/home/x/proj", projectRoot: "/home/x/proj", created: "2026-09-01T00:00:00.000Z", modified: "2026-09-02T00:00:00.000Z", archived: true }];
  const enc = encodeSessionsV2(live, archived);
  // 两桶分离，互不混装（dock 拿 sessions 即纯 live）
  assert.equal(enc.sessions.length, 1);
  assert.equal(enc.archived.length, 1);
  assert.equal(enc.archived[0].archived, true);
  assert.equal(enc.sessions[0].archived, undefined);
  // 共享枚举表：同 cwd 只入表一次
  assert.deepEqual(enc.cwds, ["/home/x/proj"]);
  assert.equal(enc.sessions[0].c, 0);
  assert.equal(enc.archived[0].c, 0);
  // decode round-trip 逐字段还原
  const backA = decodeRowV2(enc.archived[0], enc.cwds);
  assert.equal(backA.cwd, "/home/x/proj");
  assert.equal(backA.created, "2026-09-01T00:00:00.000Z");
  assert.equal(backA.archived, true);
  // 不传第二参数 → 无 archived 字段（向后兼容）
  const solo = encodeSessionsV2(live);
  assert.equal(solo.archived, undefined);
});

test("decodeArchivedPayload：v2 解码 / 无 archived 字段返回 undefined / 旧形态原样透传", () => {
  const archived = [{ id: "a", cwd: "/p", created: "2026-09-07T00:00:00.000Z", modified: "2026-09-07T00:00:00.000Z", archived: true }];
  const enc = encodeSessionsV2([], archived);
  const body = { ...enc, rev: "r1" };
  const decoded = decodeArchivedPayload(body);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].id, "a");
  assert.equal(decoded[0].cwd, "/p");
  assert.equal(decoded[0].archived, true);

  // patch 响应 / 旧服务端无 archived → undefined（调用方 keep last）
  assert.equal(decodeArchivedPayload({ rev: "r", fmt: 2, cwds: [], patch: { up: [], rm: [] } }), undefined);
  assert.equal(decodeArchivedPayload(null), undefined);

  // 无 fmt 旧形态 → 原样返回 archived 数组
  const legacy = decodeArchivedPayload({ sessions: [], archived, rev: "r1" });
  assert.equal(legacy, archived);
});
