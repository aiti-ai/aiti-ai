/**
 * aiti-custom-agent generic 句柄生命周期单测（spawn mock 注入，docs/aiti-custom-agent-plan.md §7.2）。
 *
 * 覆盖：stdout 流式 → 事件序列（message_start / update* / end / agent_settled）→ settle；
 * spawn error（ENOENT）；abort 杀进程（SIGTERM）；stderr 兜底输出；launch 解析
 * （${cwd} 展开 / 成员 env / bridge=off）；历史 JSONL 持久化与回载。
 *
 * Run: node --test pi-web-ext/aiti-custom-agent/generic-handle.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericAgentHandle } from "./generic-handle.ts";

/** spawn mock：script(child) 在下一个微任务驱动事件流 */
class FakeChild extends EventEmitter {
	constructor(script) {
		super();
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		this.stdin = new PassThrough();
		this.exitCode = null;
		this.signalCode = null;
		this.killed = false;
		this.killSignals = [];
		queueMicrotask(() => script(this));
	}
	kill(sig) {
		this.killed = true;
		this.killSignals.push(sig);
		// 真进程被杀后必发 close——mock 同步模拟（防测试悬挂）
		if (this.exitCode === null && this.signalCode === null) {
			queueMicrotask(() => this.close(null, sig ?? "SIGTERM"));
		}
	}
	close(code = 0, signal = null) {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("close", code, signal);
	}
}

function makeMember(over = {}) {
	return {
		id: "job",
		label: "Job",
		driver: "generic",
		command: "runner",
		argsPrefix: [],
		env: {},
		bridge: "",
		probe: "",
		order: 1000,
		enabled: true,
		...over,
	};
}

function collect(handle) {
	const events = [];
	let endText = "";
	handle.subscribe((e) => {
		events.push(e.type);
		if (e.type === "message_end") endText = String(e.text ?? "");
	});
	return { events, get endText() { return endText; } };
}

const WARN = () => {};

test("happy path：stdout 流式 → 事件序列 → settle；argv/env/cwd 按 launch 解析传递", async () => {
	const captured = {};
	let stdinText = "";
	let child;
	const handle = new GenericAgentHandle({
		member: makeMember({
			argsPrefix: ["-v", "${cwd}:${cwd}", "-w", "${cwd}", "img:latest", "cli"],
			env: { MEMBER_K: "v1", TOKEN: "$PARENT_TOKEN" },
			bridge: "off",
		}),
		cwd: "/tmp/proj-x",
		deps: {
			spawn: (cmd, args, opts) => {
				captured.cmd = cmd;
				captured.args = args;
				captured.opts = opts;
				child = new FakeChild((c) => {
					c.stdin.on("data", (d) => { stdinText += String(d); });
					c.stdout.write("hello ");
					c.stdout.write("world");
					c.stderr.write("noise");
					setTimeout(() => c.close(0), 5);
				});
				return child;
			},
			warn: WARN,
		},
	});
	const t = collect(handle);
	await handle.prompt("do the task");

	assert.equal(captured.cmd, "runner");
	assert.deepEqual(captured.args, ["-v", "/tmp/proj-x:/tmp/proj-x", "-w", "/tmp/proj-x", "img:latest", "cli"]);
	assert.equal(captured.opts.cwd, "/tmp/proj-x");
	assert.equal(captured.opts.env.MEMBER_K, "v1");
	assert.equal(captured.opts.env.TOKEN, process.env.PARENT_TOKEN ?? "");
	assert.equal("AITI_BRIDGE_URL" in captured.opts.env, false, "bridge=off 移除自动注入");
	assert.equal(stdinText, "do the task", "任务文本写进 stdin");
	assert.deepEqual(t.events, ["message_start", "message_update", "message_update", "message_end", "agent_settled"]);
	assert.equal(t.endText, "hello world");
	assert.equal(handle.isRunning(), false);
	assert.equal(handle.getLastActivity() > 0, true);
	const msgs = await handle.getMessages();
	assert.equal(msgs.length, 2);
	assert.equal(msgs[0].role, "user");
	assert.equal(msgs[0].text, "do the task");
	assert.equal(msgs[1].role, "assistant");
	assert.equal(msgs[1].text, "hello world");
	assert.equal(handle.capabilities.getMessages, true);
	assert.equal(handle.capabilities.setModel, false);
	assert.equal(handle.source, "aiti-custom-agent/job");
});

test("spawn error（ENOENT 模拟）→ message_end 启动失败 + agent_settled（不悬挂）", async () => {
	const handle = new GenericAgentHandle({
		member: makeMember({ command: "no-such-bin-xyz" }),
		deps: {
			spawn: () => new FakeChild((c) => {
				const e = new Error("spawn no-such-bin-xyz ENOENT");
				e.code = "ENOENT";
				c.emit("error", e);
				c.close();
			}),
			warn: WARN,
		},
	});
	const t = collect(handle);
	await handle.prompt("x");
	assert.ok(t.endText.startsWith("启动失败："));
	assert.ok(t.endText.includes("ENOENT"));
	assert.deepEqual(t.events, ["message_start", "message_end", "agent_settled"]);
});

test("abort：kill(SIGTERM) → close 后收口（已中断）+ settled", async () => {
	let child;
	const handle = new GenericAgentHandle({
		member: makeMember(),
		deps: {
			spawn: () => {
				child = new FakeChild((c) => {
					c.stdout.write("partial");
					// 不主动 close——等 abort 杀
				});
				return child;
			},
			warn: WARN,
		},
	});
	const t = collect(handle);
	const p = handle.prompt("long task");
	await new Promise((r) => setTimeout(r, 10));
	await handle.abort();
	await p;
	assert.ok(child.killSignals.includes("SIGTERM"));
	assert.ok(t.endText.includes("已中断"));
	assert.ok(t.endText.includes("partial"), "中断前已产出的输出保留");
	assert.deepEqual(t.events, ["message_start", "message_update", "message_end", "agent_settled"]);
});

test("无 stdout 时 stderr 兜底为结果；有 stdout 时不混入", async () => {
	const stderrOnly = new GenericAgentHandle({
		member: makeMember(),
		deps: {
			spawn: () => new FakeChild((c) => {
				c.stderr.write("task done via stderr");
				c.close(0);
			}),
			warn: WARN,
		},
	});
	const t1 = collect(stderrOnly);
	await stderrOnly.prompt("x");
	assert.equal(t1.endText, "task done via stderr");

	const bothOut = new GenericAgentHandle({
		member: makeMember(),
		deps: {
			spawn: () => new FakeChild((c) => {
				c.stdout.write("main output");
				c.stderr.write("warn line");
				c.close(0);
			}),
			warn: WARN,
		},
	});
	const t2 = collect(bothOut);
	await bothOut.prompt("x");
	assert.equal(t2.endText, "main output", "有 stdout 时 stderr 不混入正文");
});

test("历史 JSONL 持久化 + 构造时回载（resume 语义）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aiti-custom-agent-handle-"));
	try {
		const deps = () => ({
			spawn: () => new FakeChild((c) => {
				c.stdout.write("ok");
				c.close(0);
			}),
			warn: WARN,
		});
		const h1 = new GenericAgentHandle({ member: makeMember({ id: "persist" }), configDir: dir, id: "custom-abc123", deps: deps() });
		await h1.prompt("round one");
		const fp = join(dir, "sessions", "custom-abc123.jsonl");
		assert.ok(existsSync(fp));
		const lines = readFileSync(fp, "utf8").trim().split("\n");
		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[0]).role, "user");

		// 新 handle 同 id 构造 → 回载历史
		const h2 = new GenericAgentHandle({ member: makeMember({ id: "persist" }), configDir: dir, id: "custom-abc123", deps: deps() });
		const msgs = await h2.getMessages();
		assert.equal(msgs.length, 2);
		assert.equal(msgs[1].text, "ok");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("防线：空 prompt / 并发 prompt / disposed 后 prompt 抛错", async () => {
	const handle = new GenericAgentHandle({
		member: makeMember(),
		deps: { spawn: () => new FakeChild((c) => c.close(0)), warn: WARN },
	});
	await assert.rejects(() => handle.prompt("   "), /empty prompt/);
	let release;
	const gate = new Promise((r) => { release = r; });
	const slow = new GenericAgentHandle({
		member: makeMember(),
		deps: {
			spawn: () => new FakeChild((c) => { void gate.then(() => c.close(0)); }),
			warn: WARN,
		},
	});
	const p = slow.prompt("first");
	await assert.rejects(() => slow.prompt("second"), /one-shot/);
	release();
	await p;
	await slow.dispose();
	await assert.rejects(() => slow.prompt("third"), /disposed/);
	assert.equal(slow.alive(), false);
});
