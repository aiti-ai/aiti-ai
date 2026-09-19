/**
 * placeholder.ts unit tests — the full lifecycle of external session placeholder files.
 * Run: node --experimental-strip-types --test lib/session/placeholder.test.mjs
 * (or npm test at the repo root). HOME/PI_WEB_DATA_DIR point at temp dirs for full isolation.
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

test("ensurePlaceholder writes the placeholder file + registry, header carries the markers", () => {
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

test("ensurePlaceholder is idempotent: same extId does not write again, a rename rewrites", () => {
  const a = ensurePlaceholder({ extId: "cursor:abc-123", agent: "cursor", cwd: "/tmp/proj" });
  const b = ensurePlaceholder({ extId: "cursor:abc-123", agent: "cursor", cwd: "/tmp/proj", name: "自定义名" });
  assert.equal(a.uuid, b.uuid);
  assert.equal(b.name, "自定义名");
  const info = JSON.parse(readFileSync(b.path, "utf8").split("\n")[1]);
  assert.equal(info.name, "自定义名");
});

test("cwd falls back to ~/external-<agent> when absent", () => {
  const p = ensurePlaceholder({ extId: "claude:new-9", agent: "claude" });
  assert.ok(p);
  assert.ok(p.cwd.endsWith("external-claude"), p.cwd);
  assert.ok(existsSync(p.path));
});

test("rebindPlaceholder: key migration + header rebinding, uuid identity unchanged; the old key stays as an alias", () => {
  const p = ensurePlaceholder({ extId: "cursor:new-xyz", agent: "cursor", cwd: "/tmp/proj" });
  const real = "cursor:3f39cfd9-7796-420a-8793-705c3d156e3d";
  const moved = rebindPlaceholder("cursor:new-xyz", real);
  assert.equal(moved.uuid, p.uuid);
  // the old placeholder key is kept as an alias → same record (a browser's ?session=agent:new-… still resolves)
  assert.equal(hasPlaceholder("cursor:new-xyz"), true);
  assert.equal(getPlaceholder("cursor:new-xyz").extId, real);
  assert.equal(getPlaceholder("cursor:new-xyz").uuid, p.uuid);
  assert.equal(getPlaceholder(real).uuid, p.uuid);
  assert.equal(headerOf(p).extId, real);
  assert.equal(placeholderByUuid(p.uuid).extId, real);
});

test("aliasPlaceholder: fresh rebinding back-fills the alias (missing target rejected, idempotent writes)", () => {
  assert.equal(aliasPlaceholder("zcode:new-1-1788781214193", "zcode:sess_real-1"), null); // target placeholder does not exist
  const p = ensurePlaceholder({ extId: "zcode:sess_real-1", agent: "zcode", cwd: "/tmp/proj", name: "hi" });
  const aliased = aliasPlaceholder("zcode:new-1-1788781214193", "zcode:sess_real-1");
  assert.equal(aliased.uuid, p.uuid);
  assert.equal(getPlaceholder("zcode:new-1-1788781214193").extId, "zcode:sess_real-1");
  // idempotent: a repeated alias does not rewrite
  assert.equal(aliasPlaceholder("zcode:new-1-1788781214193", "zcode:sess_real-1").uuid, p.uuid);
  // ensurePlaceholder on an alias key: returns the existing record unchanged, no rename (write semantics belong to the real key only)
  const touched = ensurePlaceholder({ extId: "zcode:new-1-1788781214193", agent: "zcode", cwd: "/tmp/proj", name: "错误名" });
  assert.equal(touched.uuid, p.uuid);
  assert.equal(getPlaceholder("zcode:sess_real-1").name, "hi");
  assert.notEqual(getPlaceholder("zcode:sess_real-1").name, "错误名");
});

test("isProvisionalExtSid: new- placeholder shapes across backend extensions, real ids not misjudged", () => {
  assert.equal(isProvisionalExtSid("new-1-1788781214193"), true); // zcode/codex new-<n>-<ts>
  assert.equal(isProvisionalExtSid("1788781214193"), false);
  assert.equal(isProvisionalExtSid("sess_f5c5a318-df65-4fad-86c8-edb6a9dab4db"), false);
  assert.equal(isProvisionalExtSid("3f39cfd9-7796-420a-8793-705c3d156e3d"), false); // uuid
  assert.equal(isProvisionalExtSid(""), false);
});

test("stampExternalSessions stamps placeholder rows with the agent label", () => {
  const p = placeholderByUuid(Array.from({ length: 0 }) && "") || getPlaceholder("cursor:3f39cfd9-7796-420a-8793-705c3d156e3d");
  const rows = [{ id: "unrelated" }, { id: p.uuid }];
  stampExternalSessions(rows);
  assert.equal(rows[0].agent, undefined);
  assert.equal(rows[1].agent, "cursor");
});

test("parentSessionFile: subagent placeholder header carries parentSession; an existing placeholder can be linked later", () => {
  const created = ensurePlaceholder({ extId: "cursor:child-1", agent: "cursor", cwd: "/tmp/proj" });
  let header = JSON.parse(readFileSync(created.path, "utf8").split("\n")[0]);
  assert.equal(header.parentSession, undefined);
  // finalize back-fills the parent link (idempotent path)
  const linked = ensurePlaceholder({ extId: "cursor:child-1", agent: "cursor", cwd: "/tmp/proj", parentSessionFile: "/home/x/.pi/agent/sessions/--tmp--/a_b.jsonl" });
  assert.equal(linked.uuid, created.uuid);
  header = JSON.parse(readFileSync(linked.path, "utf8").split("\n")[0]);
  assert.equal(header.parentSession, "/home/x/.pi/agent/sessions/--tmp--/a_b.jsonl");
  assert.equal(linked.parentSessionFile, "/home/x/.pi/agent/sessions/--tmp--/a_b.jsonl");
  // created directly with the parent link
  const direct = ensurePlaceholder({ extId: "cursor:child-2", agent: "cursor", cwd: "/tmp/proj", parentSessionFile: "/p/q.jsonl" });
  assert.equal(JSON.parse(readFileSync(direct.path, "utf8").split("\n")[0]).parentSession, "/p/q.jsonl");
});

test("removePlaceholderByUuid: deletes the file + clears the registry (including alias keys), no external keys left behind", () => {
  const p = getPlaceholder("cursor:3f39cfd9-7796-420a-8793-705c3d156e3d");
  assert.equal(removePlaceholderByUuid(p.uuid), true);
  assert.equal(existsSync(p.path), false);
  assert.equal(placeholderByUuid(p.uuid), undefined);
  assert.equal(hasPlaceholder("cursor:3f39cfd9-7796-420a-8793-705c3d156e3d"), false);
  assert.equal(hasPlaceholder("cursor:new-xyz"), false); // the alias left by rebind is cleared too
  assert.equal(removePlaceholderByUuid("nonexistent"), false);
});

test("registry lost → rebuilt on demand after the process cache resets (the header-marker fallback boundary: an emptied cache means amnesia; recovery relies on routing-side header lookups)", () => {
  rmSync(join(dataDir, "external-session-placeholders.json"), { force: true });
  resetPlaceholderCacheForTest();
  assert.equal(hasPlaceholder("cursor:abc-123"), false);
  // after amnesia, writing the same extId again → a new placeholder (the old file becomes an orphan; acceptable: a lost registry is itself an abnormal state)
  const p = ensurePlaceholder({ extId: "cursor:abc-123", agent: "cursor", cwd: "/tmp/proj" });
  assert.ok(p);
});

test.after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
