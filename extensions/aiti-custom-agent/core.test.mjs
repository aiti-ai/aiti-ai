/**
 * aiti-custom-agent core 单测 —— agents.json 读写/规整纯逻辑（core.cjs）。
 *
 * Run: node --test pi-web-ext/aiti-custom-agent/core.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("./core.cjs");

test("slugify：中文/空格/大写折 -；含中文追加稳定哈希防碰撞；空串回退 agent", () => {
	assert.equal(core.slugify("Claude Code (Docker)"), "claude-code-docker");
	const zh = core.slugify("  我的 Agent  ");
	assert.match(zh, /^agent(-[0-9a-z]+)?$/, "中文剥离后保底 agent 前缀");
	assert.notEqual(core.slugify("我的 1"), core.slugify("你的 1"), "纯中文/同尾词不同标签不碰撞");
	assert.equal(core.slugify("!!!"), "agent");
	assert.equal(core.slugify(""), "agent");
	assert.equal(core.slugify("我的 Agent"), core.slugify("我的 Agent"), "同输入稳定输出");
});

test("validId：字母数字开头 + 仅字母数字-_，拒绝 / 与 . 开头空", () => {
	assert.equal(core.validId("claude-docker"), true);
	assert.equal(core.validId("A1_b"), true);
	assert.equal(core.validId("a/b"), false);
	assert.equal(core.validId("a.b"), false);
	assert.equal(core.validId(""), false);
	assert.equal(core.validId("-lead"), false);
});

test("normalizeInput：id 缺省 slug(label)、argsPrefix 字符串拆行、env 对象/行串两态", () => {
	const a = core.normalizeInput({ label: "My Docker Job", command: "docker" }).agent;
	assert.equal(a.id, "my-docker-job");
	assert.equal(a.driver, "generic");
	assert.equal(a.enabled, true);
	assert.equal(a.order, 1000);

	const b = core.normalizeInput({
		label: "X", command: "c", argsPrefix: "run\n# comment\n--rm\n",
		env: "K=1\n-BAD\nJ=$HOME", bridge: "off", order: "50",
	}).agent;
	assert.deepEqual(b.argsPrefix, ["run", "--rm"]);
	assert.deepEqual(b.env, { K: "1", J: "$HOME" }, "排除行在对象形态丢弃");
	assert.equal(b.bridge, "off");
	assert.equal(b.order, 50);

	const c = core.normalizeInput({ label: "Y", command: "c", argsPrefix: ["-i"], env: { A: "1" } }).agent;
	assert.deepEqual(c.argsPrefix, ["-i"]);
	assert.deepEqual(c.env, { A: "1" });
});

test("normalizeInput：缺 label / 缺 command / 非法 id / 命令含空格 → error", () => {
	assert.ok(core.normalizeInput({ command: "c" }).error);
	assert.ok(core.normalizeInput({ label: "L" }).error);
	assert.ok(core.normalizeInput({ label: "L", command: "c", id: "bad/id" }).error);
	assert.ok(!core.normalizeInput({ label: "L", command: "c" }).error);
	const spaced = core.normalizeInput({ label: "L", command: "docker run" });
	assert.ok(spaced.error && spaced.error.includes("空格"), "generic 命令含空格防呆（参数应进参数前缀）");
	assert.ok(!core.normalizeInput({ label: "L", driver: "claude", command: "" }).error, "协议型空命令合法");
});

test("saveAgents → loadAgents 往返 + 原子写（无 .tmp 残留）+ 字段规整", () => {
	const dir = mkdtempSync(join(tmpdir(), "aiti-custom-agent-test-"));
	try {
		core.saveAgents(dir, [
			{ id: "a1", label: "A", command: "c", argsPrefix: ["run"], env: { K: "1" }, extra: "drop-me" },
			{ id: "a2", label: "B", command: "c2", enabled: false, order: "7" },
		]);
		assert.equal(existsSync(join(dir, "agents.json.tmp")), false, "原子写后 tmp 已 rename");
		const raw = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"));
		assert.equal(raw.version, 1);
		assert.equal(raw.agents.length, 2);
		assert.equal(raw.agents[0].extra, undefined, "未知字段不落盘");
		assert.equal(raw.agents[1].enabled, false);
		assert.equal(raw.agents[1].order, 7);

		const loaded = core.loadAgents(dir);
		assert.equal(loaded.agents.length, 2);
		assert.equal(loaded.agents[0].id, "a1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadAgents：缺失文件 → 空配置；坏 JSON → __parseError（交 parseCustomAgents 记 warning）", () => {
	const dir = mkdtempSync(join(tmpdir(), "aiti-custom-agent-test-"));
	try {
		assert.deepEqual(core.loadAgents(dir), { agents: [] });
		const { writeFileSync } = require("node:fs");
		writeFileSync(join(dir, "agents.json"), "{broken");
		const loaded = core.loadAgents(dir);
		assert.ok(loaded.__parseError);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
