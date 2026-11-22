/**
 * session-manager — ZCode adapter tests（真 sqlite 造库，零外部依赖）。
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/zcode.test.mjs
 * （AITI_ZCODE_HOME 隔离到临时目录；db 由 node:sqlite 按实测 schema 造）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const ROOT = mkdtempSync(join(tmpdir(), "zcode-adapter-test-"));
process.env.AITI_ZCODE_HOME = join(ROOT, "zcode-home");

// zcode-core 读 AITI_ZCODE_HOME；adapter ROOT = $HOME/.zcode/cli → 指向测试目录
const CLI_HOME = join(process.env.AITI_ZCODE_HOME, "cli");
mkdirSync(join(CLI_HOME, "db"), { recursive: true });

/** 按实测 schema 造最小库（session/message/part + data JSON）。 */
function buildDb() {
  const db = new DatabaseSync(join(CLI_HOME, "db", "db.sqlite"));
  db.exec(`
    CREATE TABLE session (id text primary key, project_id text not null, directory text not null,
      title text not null, version text not null, time_created integer not null, time_updated integer not null,
      parent_id text, task_type text);
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text not null, sequence integer);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null, sequence integer);
  `);
  db.prepare("INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?)").run(
    "sess_a1", "p1", "/home/pi/proj", "测试会话标题", "0.16.5", 1788660000000, 1788660500000);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
    "m1", "sess_a1", 1788660010000, 1788660010000,
    JSON.stringify({ role: "user", time: { created: 1788660010000 }, agent: "zcode-agent" }), 0);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa1", "m1", "sess_a1", 1788660010000, 1788660010000,
    JSON.stringify({ type: "text", text: "运行 pwd" }), 0);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
    "m2", "sess_a1", 1788660020000, 1788660020000,
    JSON.stringify({ role: "assistant", time: { created: 1788660020000 }, modelID: "GLM-5.3", providerID: "bigmodel" }), 1);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa2", "m2", "sess_a1", 1788660020000, 1788660020000,
    JSON.stringify({ type: "reasoning", text: "思考…" }), 0);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa3", "m2", "sess_a1", 1788660020000, 1788660020000,
    JSON.stringify({ type: "tool", callID: "c1", tool: "Bash", state: { status: "completed", input: { command: "pwd" }, output: "/home/pi/proj" } }), 1);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa4", "m2", "sess_a1", 1788660020000, 1788660020000,
    JSON.stringify({ type: "text", text: "当前目录是 /home/pi/proj。" }), 2);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa5", "m2", "sess_a1", 1788660020000, 1788660020000,
    JSON.stringify({ type: "step-start" }), 3);
  db.close();
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test("zcode adapter: probe/list/parse 全链（db 同构 schema）", async () => {
  buildDb();
  const { createZcodeAdapter } = await import("./zcode.ts");
  const adapter = createZcodeAdapter();
  assert.equal(adapter.id, "zcode");
  assert.deepEqual(adapter.roots(), [join(CLI_HOME)]);

  const probe = await adapter.probe();
  assert.equal(probe.ok, true);
  assert.equal(probe.count, 1);
  assert.ok(probe.watermarkMs > 0);

  const refs = await adapter.list();
  assert.equal(refs.length, 1);
  assert.equal(refs[0].sid, "sess_a1");
  // 直读改造（2026-09-12）：ref.path 指向源库（不再 /tmp 副本），rev = time_updated
  assert.ok(refs[0].path.startsWith(join(CLI_HOME, "db", "db.sqlite") + "#session:"), "ref.path 指向源库虚拟路径");
  assert.equal(refs[0].rev, 1788660500000, "rev = session.time_updated（per-session 版本水位）");

  const parsed = await adapter.parse(refs[0]);
  assert.ok(parsed, "parse 成功");
  assert.equal(parsed.meta.id, "sess_a1");
  assert.equal(parsed.meta.name, "测试会话标题");
  assert.equal(parsed.meta.cwd, "/home/pi/proj");
  assert.equal(parsed.meta.messageCount, 3, "reasoning/step-start 跳过");

  assert.deepEqual(
    parsed.messages.map((m) => [m.role, m.toolName ?? m.text.slice(0, 12)]),
    [
      ["user", "运行 pwd"],
      ["assistant", "Bash"],
      ["assistant", "当前目录是 /home/"],
    ],
  );
  const withModel = parsed.messages.find((m) => m.role === "assistant" && !m.toolName);
  assert.equal(withModel?.model, "GLM-5.3");
  assert.equal(withModel?.provider, "bigmodel");
  assert.equal(parsed.meta.model, "bigmodel/GLM-5.3", "meta.model = 最近 assistant 的 provider/model ref");
  assert.equal(parsed.meta.firstMessage, "运行 pwd");
  assert.match(parsed.meta.lastMessage, /当前目录/);

  // 结构化工具行（回放成 pi 形状 toolCall/toolResult 用；text 行仍是兜底展示）
  const toolEntry = parsed.messages.find((m) => m.toolName);
  assert.ok(toolEntry?.tool, "tool entry 携带结构化 tool 字段");
  assert.equal(toolEntry.tool.name, "Bash");
  assert.equal(toolEntry.tool.callID, "c1");
  assert.deepEqual(toolEntry.tool.input, { command: "pwd" });
  assert.equal(toolEntry.tool.output, "/home/pi/proj");
  assert.notEqual(toolEntry.tool.isError, true);
  assert.match(toolEntry.text, /^🛠 Bash /, "text 兜底展示行保留");
});

test("zcode adapter: listFresh 轻量时间戳快照（直读源 db，零 parse）", async () => {
  // 模拟运行中写入：会话 time_updated 前进 + 标题变更（不全量重 parse 也可见）
  const db = new DatabaseSync(join(CLI_HOME, "db", "db.sqlite"));
  db.prepare("UPDATE session SET time_updated = ?, title = ? WHERE id = ?")
    .run(1788660999999, "运行中新标题", "sess_a1");
  db.close();
  const { createZcodeAdapter } = await import("./zcode.ts");
  const fresh = await createZcodeAdapter().listFresh();
  assert.ok(Array.isArray(fresh), "listFresh 返回数组");
  const a1 = fresh.find((f) => f.sid === "sess_a1");
  assert.ok(a1, "listFresh 含目标会话");
  assert.equal(a1.timeUpdatedMs, 1788660999999, "time_updated 前进可见");
  assert.equal(a1.title, "运行中新标题", "title 变更可见");
});

test("zcode adapter: 工具 error 状态与超长 output 截断", async () => {
  const db = new DatabaseSync(join(CLI_HOME, "db", "db.sqlite"));
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
    "m9", "sess_a1", 1788660090000, 1788660090000,
    JSON.stringify({ role: "assistant", time: { created: 1788660090000 }, modelID: "GLM-5.3", providerID: "bigmodel" }), 9);
  const bigOutput = "x".repeat(25_000);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa9", "m9", "sess_a1", 1788660090000, 1788660090000,
    JSON.stringify({ type: "tool", callID: "c9", tool: "Bash", state: { status: "error", input: { command: "boom" }, output: bigOutput } }), 0);
  db.close();

  const { createZcodeAdapter } = await import("./zcode.ts");
  const parsed = await createZcodeAdapter().parse({ sid: "sess_a1", path: "x" });
  assert.ok(parsed);
  const entry = parsed.messages.find((m) => m.tool?.callID === "c9");
  assert.ok(entry?.tool);
  assert.equal(entry.tool.isError, true, "status=error → isError");
  const out = entry.tool.output ?? "";
  assert.ok(out.length < 25_000, "超长 output 截断");
  assert.match(out, /回放截断/, "截断标注");
});

test("zcode adapter: file part（截图）→ images 带 artifact data URL", async () => {
  // 造 artifact（库已由全链测试建好）（data URL 文本文件，形态同真机）
  const artDir = join(CLI_HOME, "artifacts", "sess_a1");
  mkdirSync(artDir, { recursive: true });
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  writeFileSync(join(artDir, "attachment-1-tool-result-abc123.txt"), dataUrl);
  const db = new DatabaseSync(join(CLI_HOME, "db", "db.sqlite"));
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
    "m3", "sess_a1", 1788660030000, 1788660030000,
    JSON.stringify({ role: "user", time: { created: 1788660030000 } }), 2);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa6", "m3", "sess_a1", 1788660030000, 1788660030000,
    JSON.stringify({ type: "text", text: "收到图片" }), 0);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa7", "m3", "sess_a1", 1788660030000, 1788660030000,
    JSON.stringify({ type: "file", mime: "image/png", filename: "截图.png", url: "zcode-artifact://sess_a1/tool-result-abc123" }), 1);
  db.close();

  const { createZcodeAdapter } = await import("./zcode.ts");
  const adapter = createZcodeAdapter();
  const refs = await adapter.list();
  const parsed = await adapter.parse(refs[0]);
  const imgMsg = parsed.messages.find((m) => m.text === "收到图片");
  assert.ok(imgMsg, "图片消息 entry 存在");
  assert.equal(imgMsg.images?.length, 1);
  assert.equal(imgMsg.images[0].mime, "image/png");
  assert.equal(imgMsg.images[0].filename, "截图.png");
  assert.ok(imgMsg.images[0].dataUrl.startsWith("data:image/png;base64,"), "data URL 完整保留");
  // 缺失 artifact → 占位文本降级
  const db2 = new DatabaseSync(join(CLI_HOME, "db", "db.sqlite"));
  db2.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
    "m4", "sess_a1", 1788660040000, 1788660040000,
    JSON.stringify({ role: "user", time: { created: 1788660040000 } }), 3);
  db2.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pa8", "m4", "sess_a1", 1788660040000, 1788660040000,
    JSON.stringify({ type: "file", mime: "image/png", filename: "丢失.png", url: "zcode-artifact://sess_a1/tool-result-notexist" }), 0);
  db2.close();
  const parsed2 = await adapter.parse((await adapter.list())[0]);
  const missing = parsed2.messages.find((m) => m.text.includes("缺失"));
  assert.ok(missing, "缺失图片降级为占位文本");
});

test("zcode adapter: subagent_child 父子标识 → meta.parentSid（无父会话不带字段）", async () => {
  // 父会话（interactive）+ 子会话（subagent_child，parent_id 指父）
  const db = new DatabaseSync(join(CLI_HOME, "db", "db.sqlite"));
  db.prepare("INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated, parent_id, task_type) VALUES (?,?,?,?,?,?,?,?,?)").run(
    "sess_child", "p1", "/home/pi/proj", "子代理任务", "0.16.5", 1788660600000, 1788660700000,
    "sess_a1", "subagent_child");
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
    "mc1", "sess_child", 1788660610000, 1788660610000,
    JSON.stringify({ role: "user", time: { created: 1788660610000 } }), 0);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pc1", "mc1", "sess_child", 1788660610000, 1788660610000,
    JSON.stringify({ type: "text", text: "子代理执行调研" }), 0);
  db.close();

  const { createZcodeAdapter } = await import("./zcode.ts");
  const adapter = createZcodeAdapter();
  const refs = await adapter.list();
  assert.equal(refs.length, 2);
  const child = await adapter.parse({ sid: "sess_child", path: `db#session:sess_child` });
  assert.ok(child);
  assert.equal(child.meta.parentSid, "sess_a1", "subagent_child 的 parent_id 进 meta.parentSid");
  const parent = await adapter.parse({ sid: "sess_a1", path: `db#session:sess_a1` });
  assert.ok(parent);
  assert.equal(parent.meta.parentSid, undefined, "无 parent_id → 不带字段（interactive 根会话）");
});

test("zcode adapter: 3.16.3+ 新键名 modelId/providerId 与 account: provider 值（旧键双兼容）", async () => {
  // 2026-10-30 真机 3.16.3 实测：会话 id 前缀 session_<hex32>；message.data 只写
  // modelId/providerId（旧版双写 modelID/providerID）；provider 值新形态 account:bigmodel-start-plan
  const db = new DatabaseSync(join(CLI_HOME, "db", "db.sqlite"));
  db.prepare("INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?)").run(
    "session_3f9a2b7c", "p1", "/home/pi/proj", "新版键名会话", "3.16.3", 1788660800000, 1788660900000);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
    "mn1", "session_3f9a2b7c", 1788660810000, 1788660810000,
    JSON.stringify({ role: "user", time: { created: 1788660810000 } }), 0);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
    "mn2", "session_3f9a2b7c", 1788660820000, 1788660820000,
    JSON.stringify({ role: "assistant", time: { created: 1788660820000 }, modelId: "GLM-5.3-Flash", providerId: "account:bigmodel-start-plan" }), 1);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "pn1", "mn2", "session_3f9a2b7c", 1788660820000, 1788660820000,
    JSON.stringify({ type: "text", text: "新版键名回复" }), 0);
  db.close();

  const { createZcodeAdapter } = await import("./zcode.ts");
  const parsed = await createZcodeAdapter().parse({ sid: "session_3f9a2b7c", path: "db#session:session_3f9a2b7c" });
  assert.ok(parsed);
  const assistant = parsed.messages.find((m) => m.role === "assistant" && !m.toolName);
  assert.equal(assistant?.model, "GLM-5.3-Flash", "新键 modelId 读取");
  assert.equal(assistant?.provider, "account:bigmodel-start-plan", "新键 providerId 读取");
  assert.equal(parsed.meta.model, "bigmodel/GLM-5.3-Flash", "account: 前缀 + -start-plan 后缀归一 → bigmodel");
});

test("zcode adapter: 缺 db → probe false / list 抛错（fail-loud，防空 refs 触发 GC）/ parse null", async () => {
  rmSync(join(CLI_HOME, "db", "db.sqlite"), { force: true });
  const { createZcodeAdapter } = await import("./zcode.ts");
  const adapter = createZcodeAdapter();
  assert.equal((await adapter.probe()).ok, false);
  assert.throws(() => adapter.list(), /zcode db unreadable/);
  assert.equal(await adapter.parse({ sid: "sess_x", path: "p" }), null);
});

test("zcode adapter: 直读不产生 /tmp 副本（copyDb 已删除）", async () => {
  // 重建库 + 全链跑一遍，断言 /tmp/sm-zcode-cache 不存在（首次直读成功后清残留）
  mkdirSync(join(CLI_HOME, "db"), { recursive: true });
  buildDb();
  const { createZcodeAdapter } = await import("./zcode.ts");
  const adapter = createZcodeAdapter();
  const refs = await adapter.list();
  await adapter.parse(refs[0]);
  assert.equal(existsSync(join("/tmp", "sm-zcode-cache")), false, "无副本目录残留");
});
