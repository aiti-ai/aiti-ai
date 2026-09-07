/**
 * placeholder.ts 单测——外部会话站位文件的完整生命周期。
 * 运行：node --experimental-strip-types --test lib/session/placeholder.test.mjs
 * （或仓库根 npm test）。HOME/PI_WEB_DATA_DIR 指向临时目录做全隔离。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ph-home-"));
const dataDir = mkdtempSync(join(tmpdir(), "ph-data-"));
process.env.HOME = home;
process.env.PI_WEB_DATA_DIR = dataDir;

const ph = await import("./placeholder.ts");
const { ensurePlaceholder, rebindPlaceholder, aliasPlaceholder, getPlaceholder, hasPlaceholder, placeholderByUuid, removePlaceholderByUuid, stampExternalSessions, isProvisionalExtSid, resetPlaceholderCacheForTest } = ph;

function headerOf(p) {
  return JSON.parse(readFileSync(p.path, "utf8").split("\n")[0]);
}

test("ensurePlaceholder 写站位文件 + 注册表，header 带标记", () => {
  const p = ensurePlaceholder({ extId: "cursor:abc-123", agent: "cursor", cwd: "/tmp/proj" });
  assert.ok(p);
  assert.match(p.path, /\.jsonl$/);
  assert.ok(existsSync(p.path));
  const header = headerOf(p);
  assert.equal(header.type, "session");
  assert.equal(header.id, p.uuid);
  assert.equal(header.cwd, "/tmp/proj");
  assert.equal(header.agent, "cursor");
  assert.equal(header.extId, "cursor:abc-123");
  const info = JSON.parse(readFileSync(p.path, "utf8").split("\n")[1]);
  assert.equal(info.type, "session_info");
  assert.equal(info.importedFrom, "cursor:abc-123");
  assert.equal(info.external, true);
  assert.ok(getPlaceholder("cursor:abc-123"));
  assert.equal(hasPlaceholder("cursor:abc-123"), true);
  assert.equal(placeholderByUuid(p.uuid)?.extId, "cursor:abc-123");
});

test("ensurePlaceholder 幂等：同 extId 不重复落文件，改名会重写", () => {
  const a = ensurePlaceholder({ extId: "cursor:abc-123", agent: "cursor", cwd: "/tmp/proj" });
  const b = ensurePlaceholder({ extId: "cursor:abc-123", agent: "cursor", cwd: "/tmp/proj", name: "自定义名" });
  assert.equal(a.uuid, b.uuid);
  assert.equal(b.name, "自定义名");
  const info = JSON.parse(readFileSync(b.path, "utf8").split("\n")[1]);
  assert.equal(info.name, "自定义名");
});

test("cwd 缺省回落 ~/external-<agent>", () => {
  const p = ensurePlaceholder({ extId: "claude:new-9", agent: "claude" });
  assert.ok(p);
  assert.ok(p.cwd.endsWith("external-claude"), p.cwd);
  assert.ok(existsSync(p.path));
});

test("rebindPlaceholder：键迁移 + header 换绑，uuid 身份不变；旧键留别名", () => {
  const p = ensurePlaceholder({ extId: "cursor:new-xyz", agent: "cursor", cwd: "/tmp/proj" });
  const real = "cursor:3f39cfd9-7796-420a-8793-705c3d156e3d";
  const moved = rebindPlaceholder("cursor:new-xyz", real);
  assert.equal(moved.uuid, p.uuid);
  // 旧占位键保留为别名 → 同一记录（浏览器里的 ?session=agent:new-… 仍可解析）
  assert.equal(hasPlaceholder("cursor:new-xyz"), true);
  assert.equal(getPlaceholder("cursor:new-xyz").extId, real);
  assert.equal(getPlaceholder("cursor:new-xyz").uuid, p.uuid);
  assert.equal(getPlaceholder(real).uuid, p.uuid);
  assert.equal(headerOf(p).extId, real);
  assert.equal(placeholderByUuid(p.uuid).extId, real);
});

test("aliasPlaceholder：fresh 换绑补别名（目标缺失拒绝，幂等不重复写盘）", () => {
  assert.equal(aliasPlaceholder("zcode:new-1-1788781214193", "zcode:sess_real-1"), null); // 目标站位不存在
  const p = ensurePlaceholder({ extId: "zcode:sess_real-1", agent: "zcode", cwd: "/tmp/proj", name: "hi" });
  const aliased = aliasPlaceholder("zcode:new-1-1788781214193", "zcode:sess_real-1");
  assert.equal(aliased.uuid, p.uuid);
  assert.equal(getPlaceholder("zcode:new-1-1788781214193").extId, "zcode:sess_real-1");
  // 幂等：重复 alias 不改写
  assert.equal(aliasPlaceholder("zcode:new-1-1788781214193", "zcode:sess_real-1").uuid, p.uuid);
  // 别名键上 ensurePlaceholder：原样返回既有记录，不改名（写入语义只属真实键）
  const touched = ensurePlaceholder({ extId: "zcode:new-1-1788781214193", agent: "zcode", cwd: "/tmp/proj", name: "错误名" });
  assert.equal(touched.uuid, p.uuid);
  assert.equal(getPlaceholder("zcode:sess_real-1").name, "hi");
  assert.notEqual(getPlaceholder("zcode:sess_real-1").name, "错误名");
});

test("isProvisionalExtSid：各后端扩展的 new- 占位形状，真实 id 不误判", () => {
  assert.equal(isProvisionalExtSid("new-1-1788781214193"), true); // zcode/codex new-<n>-<ts>
  assert.equal(isProvisionalExtSid("1788781214193"), false);
  assert.equal(isProvisionalExtSid("sess_f5c5a318-df65-4fad-86c8-edb6a9dab4db"), false);
  assert.equal(isProvisionalExtSid("3f39cfd9-7796-420a-8793-705c3d156e3d"), false); // uuid
  assert.equal(isProvisionalExtSid(""), false);
});

test("stampExternalSessions 给站位行补 agent 标签", () => {
  const p = placeholderByUuid(Array.from({ length: 0 }) && "") || getPlaceholder("cursor:3f39cfd9-7796-420a-8793-705c3d156e3d");
  const rows = [{ id: "unrelated" }, { id: p.uuid }];
  stampExternalSessions(rows);
  assert.equal(rows[0].agent, undefined);
  assert.equal(rows[1].agent, "cursor");
});

test("parentSessionFile：子代理站位 header 带 parentSession，已有站位可补链接", () => {
  const created = ensurePlaceholder({ extId: "cursor:child-1", agent: "cursor", cwd: "/tmp/proj" });
  let header = JSON.parse(readFileSync(created.path, "utf8").split("\n")[0]);
  assert.equal(header.parentSession, undefined);
  // finalize 补父链接（幂等路径）
  const linked = ensurePlaceholder({ extId: "cursor:child-1", agent: "cursor", cwd: "/tmp/proj", parentSessionFile: "/home/x/.pi/agent/sessions/--tmp--/a_b.jsonl" });
  assert.equal(linked.uuid, created.uuid);
  header = JSON.parse(readFileSync(linked.path, "utf8").split("\n")[0]);
  assert.equal(header.parentSession, "/home/x/.pi/agent/sessions/--tmp--/a_b.jsonl");
  assert.equal(linked.parentSessionFile, "/home/x/.pi/agent/sessions/--tmp--/a_b.jsonl");
  // 创建时直接带父链接
  const direct = ensurePlaceholder({ extId: "cursor:child-2", agent: "cursor", cwd: "/tmp/proj", parentSessionFile: "/p/q.jsonl" });
  assert.equal(JSON.parse(readFileSync(direct.path, "utf8").split("\n")[0]).parentSession, "/p/q.jsonl");
});

test("removePlaceholderByUuid：删文件 + 清注册表（含别名键），外部键不残留", () => {
  const p = getPlaceholder("cursor:3f39cfd9-7796-420a-8793-705c3d156e3d");
  assert.equal(removePlaceholderByUuid(p.uuid), true);
  assert.equal(existsSync(p.path), false);
  assert.equal(placeholderByUuid(p.uuid), undefined);
  assert.equal(hasPlaceholder("cursor:3f39cfd9-7796-420a-8793-705c3d156e3d"), false);
  assert.equal(hasPlaceholder("cursor:new-xyz"), false); // rebind 留下的别名一并清除
  assert.equal(removePlaceholderByUuid("nonexistent"), false);
});

test("注册表丢失 → 进程缓存重置后按需重建（header 标记兜底的边界：缓存清空即失忆，靠路由侧 header 反查）", () => {
  rmSync(join(dataDir, "external-session-placeholders.json"), { force: true });
  resetPlaceholderCacheForTest();
  assert.equal(hasPlaceholder("cursor:abc-123"), false);
  // 失忆后重新写同名 extId → 新站位（旧文件成孤儿，可接受：注册表丢失本身是异常态）
  const p = ensurePlaceholder({ extId: "cursor:abc-123", agent: "cursor", cwd: "/tmp/proj" });
  assert.ok(p);
});

test.after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
