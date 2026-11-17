/**
 * session-manager — enrich layer tests (docs/pi-session-search-enrich-tags-plan.md §4.2/§4.5).
 *
 * Covers enrichForSession (tags tree paths + plan outlet lines + graceful degradation),
 * probePlanSvc (services.get / byId fallback / absent), and writeAgentToolsKillswitch
 * (features.json → config.json, kill-switch for the TUI-side pi-session-search plugin).
 *
 * Run: node --experimental-strip-types --test pi-web-ext/session-manager/server/session-enrich.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { enrichForSession, probePlanSvc, writeAgentToolsKillswitch } = await import("./session-enrich.ts");

// ---------- fixtures ----------

function tagsConfigDir(tags, sessionTags) {
  const dir = join(mkdtempSync(join(tmpdir(), "sm-enrich-")), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session-tags.json"), JSON.stringify({
    version: 1, favoriteIds: [], tags, sessionTags,
  }));
  return dir;
}

const TAGS = [
  { id: "t1", name: "项目A", color: "#ef4444", parentId: null, sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "t2", name: "todo", color: "#f59e0b", parentId: "t1", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "t3", name: "urgent", color: "#ef4444", parentId: null, sortOrder: 1, createdAt: "2026-01-01T00:00:00.000Z" },
];
const noTags = () => ({ version: 0, favoriteIds: [], tags: [], sessionTags: {} });
/** Mocks the real readTagData(configDir) signature: disk-read fixture (throws on missing file, same as real) */
const readTagsFromDisk = (dir) => JSON.parse(readFileSync(join(dir, "session-tags.json"), "utf8"));

// ---------- enrichForSession ----------

test("enrich：leaf id → 树路径（含多级与多 tag 逗号连接）", () => {
  const dir = tagsConfigDir(TAGS, { s1: ["t2"], s2: ["t3"], s3: ["t2", "t3"] });
  const m = enrichForSession(["s1", "s2", "s3"], dir, readTagsFromDisk, null);
  assert.equal(m.get("s1"), "tags: 项目A/todo");
  assert.equal(m.get("s2"), "tags: urgent");
  assert.equal(m.get("s3"), "tags: 项目A/todo, urgent"); // per sessionTags storage order
});

test("enrich：plan 行（fm tags + 状态 tag；无 fm 只路径）", () => {
  const dir = tagsConfigDir([], {});
  const svc = {
    planDocsWithTags: (sids) => sids.map((sid) => sid === "p1"
      ? { sessionId: "p1", path: "/r/docs/a.md", fmTags: ["方案", "workspace-tools"], statusPhase: null }
      : { sessionId: "p2", path: "/r/docs/b.md", fmTags: [], statusPhase: "方案/已实施" }),
  };
  const m = enrichForSession(["p1", "p2"], dir, () => noTags(), svc);
  assert.equal(m.get("p1"), "plan: /r/docs/a.md [方案, workspace-tools]");
  assert.equal(m.get("p2"), "plan: /r/docs/b.md（状态: 方案/已实施）");
});

test("enrich：tags + plan 两行合并（tags 在前；状态项不入方括号）", () => {
  const dir = tagsConfigDir(TAGS, { both: ["t3"] });
  const svc = { planDocsWithTags: () => [{ sessionId: "both", path: "/r/p.md", fmTags: ["方案", "workspace-tools", "方案/评审中"], statusPhase: "方案/评审中" }] };
  const m = enrichForSession(["both"], dir, readTagsFromDisk, svc);
  assert.equal(m.get("both"), "tags: urgent\nplan: /r/p.md [方案, workspace-tools]（状态: 方案/评审中）");
});

test("enrich 降级：configDir 无 tags 文件 / readTagData 抛错 / svc 抛错 / 空 sids → 无行不炸", () => {
  const empty = mkdtempSync(join(tmpdir(), "sm-enrich-empty-")); // no session-tags.json
  assert.deepEqual([...enrichForSession(["s1"], empty, () => { throw new Error("x"); }, null)], []);
  assert.deepEqual([...enrichForSession(["s1"], empty, (d) => d, { planDocsWithTags: () => { throw new Error("boom"); } })], []);
  assert.deepEqual([...enrichForSession([], empty, (d) => d, null)], []);
  assert.deepEqual([...enrichForSession(["", undefined], empty, (d) => d, null)], []);
});

test("enrich：未知 tag id 被过滤，不出空 tags 行", () => {
  const dir = tagsConfigDir(TAGS, { ghost: ["nonexistent"] });
  const m = enrichForSession(["ghost"], dir, readTagsFromDisk, null);
  assert.equal(m.has("ghost"), false);
});

// ---------- probePlanSvc ----------

test("probePlanSvc：servicesGet 命中优先；byId 兜底；缺席 null", () => {
  const svc = { planDocsWithTags: () => [] };
  assert.equal(probePlanSvc(() => svc), svc);
  const reg = (globalThis).__piWebExt;
  try {
    (globalThis).__piWebExt = { byId: () => ({ ext: { services: { plans: svc } } }) };
    assert.equal(probePlanSvc(null), svc); // byId fallback
    assert.equal(probePlanSvc(() => { throw new Error("x"); }), svc); // throwing get falls back
  } finally { (globalThis).__piWebExt = reg; }
  const saved = (globalThis).__piWebExt; delete (globalThis).__piWebExt;
  try { assert.equal(probePlanSvc(null), null); } finally { (globalThis).__piWebExt = saved; }
});

// ---------- writeAgentToolsKillswitch ----------

function killswitchFixture(featuresJson) {
  const dataRoot = mkdtempSync(join(tmpdir(), "sm-ks-"));
  const configDir = join(dataRoot, "session-manager", "config");
  mkdirSync(configDir, { recursive: true });
  if (featuresJson !== undefined) writeFileSync(join(dataRoot, "features.json"), featuresJson);
  return { dataRoot, configDir };
}

test("killswitch：features 显式 false → enabled:false；true/缺键/缺文件 → enabled:true", () => {
  let f = killswitchFixture(JSON.stringify({ "session-manager": { "agentTools.enabled": false } }));
  assert.deepEqual(writeAgentToolsKillswitch(f.configDir), { enabled: false });
  assert.deepEqual(JSON.parse(readFileSync(join(f.configDir, "config.json"), "utf8")), { agentTools: { enabled: false } });
  rmSync(f.dataRoot, { recursive: true, force: true });

  f = killswitchFixture(JSON.stringify({ "session-manager": { "agentTools.enabled": true } }));
  assert.deepEqual(writeAgentToolsKillswitch(f.configDir), { enabled: true });
  rmSync(f.dataRoot, { recursive: true, force: true });

  f = killswitchFixture(JSON.stringify({ "other-ext": {} })); // missing key = on
  assert.deepEqual(writeAgentToolsKillswitch(f.configDir), { enabled: true });
  rmSync(f.dataRoot, { recursive: true, force: true });

  f = killswitchFixture(undefined); // missing features.json = on
  assert.deepEqual(writeAgentToolsKillswitch(f.configDir), { enabled: true });
  rmSync(f.dataRoot, { recursive: true, force: true });
});

test("killswitch：features.json 坏行 → 缺省开；写出后文件存在且可解析", () => {
  const f = killswitchFixture("{not json");
  assert.deepEqual(writeAgentToolsKillswitch(f.configDir), { enabled: true });
  assert.deepEqual(JSON.parse(readFileSync(join(f.configDir, "config.json"), "utf8")), { agentTools: { enabled: true } });
  rmSync(f.dataRoot, { recursive: true, force: true });
});
