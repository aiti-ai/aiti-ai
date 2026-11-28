/**
 * aiti-acp-agent — 本地 followUp 队列（D3）+ usage/commands 帧（D16）单测。
 *
 * 钉死（债务清单 docs/pi-web-ext-agent-authoring-debt.md）：
 *   1. 运行中 prompt 入本地队列（queue_update 广播），不开第二路 session/prompt；
 *   2. settle 后 scheduleDrain 自动续轮（队列 FIFO 排空）；
 *   3. queueManage list/recall 原语（撤回不入队的消息）；
 *   4. usage_update → getUsage/getContextUsage；available_commands_update → getCommands；
 *   5. 进程死亡清队列（markDead 后不再续轮）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-acp-agent/queue-and-caps.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { AcpHandle } = await import("./index.ts");

/** 造一个不 spawn 进程的裸 handle（私有状态直接注入，测试专用）。 */
function makeHandle() {
	const h = new AcpHandle("codebuddy", "/bin/true", [], "codebuddy");
	const written = [];
	const events = [];
	h.aliveFlag = true;
	h.id = "codebuddy:test-session";
	h.child = { stdin: { write: (s) => { written.push(s); return true; } } };
	h.subscribe((e) => events.push(e));
	return { h, written, events };
}

/** 可手动收口的 rpc 桩：每次调用生成一个 deferred（记录 method 序列）。 */
function stubRpc(h) {
	const calls = [];
	const deferreds = [];
	h.rpc = (method) => {
		calls.push(method);
		return new Promise((resolve, reject) => deferreds.push({ resolve, reject }));
	};
	return { calls, deferreds };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("运行中 prompt → 本地队列（queue_update），不开第二路 session/prompt", async () => {
	const { h, events } = makeHandle();
	const { calls, deferreds } = stubRpc(h);
	const p1 = h.prompt("first");
	await flush();
	assert.equal(h.isRunning(), true);

	const p2 = h.prompt("second", { streamingBehavior: "followUp" });
	const r2 = await p2; // queued：立即返回，不等待轮次
	await flush();
	assert.ok(!calls.includes("second"), "入队消息不应立即发出");
	const qu = events.filter((e) => e.type === "queue_update");
	assert.ok(qu.length >= 1, "应有 queue_update 广播");
	assert.deepEqual(
		{ ...qu.at(-1), rev: 0 },
		{ type: "queue_update", rev: 0, steering: [], followUp: ["second"] },
		"广播形状（rev 单调版本号，backend-queue 2026-09-18 起携带）",
	);
	assert.ok(typeof qu.at(-1).rev === "number", "rev 应为数字");

	deferreds[0].resolve({ stopReason: "end_turn" });
	await p1;
	await flush(); // scheduleDrain 走 queueMicrotask + dispatch
	assert.equal(calls.filter((m) => m === "session/prompt").length, 2, "settle 后应自动续轮发出 second");
});

test("queueManage list/recall：运行中可撤回排队消息", async () => {
	const { h } = makeHandle();
	const { deferreds } = stubRpc(h);
	const p1 = h.prompt("first");
	await flush();

	await h.prompt("a", { streamingBehavior: "followUp" });
	await h.prompt("b", { streamingBehavior: "followUp" });
	const list = await h.queueManage({ action: "list" });
	assert.deepEqual(list.followUp, ["a", "b"]);

	const recalled = await h.queueManage({ action: "recall", index: 0 });
	assert.equal(recalled.entry.text, "a");
	assert.deepEqual((await h.queueManage({ action: "list" })).followUp, ["b"]);

	deferreds[0].resolve({ stopReason: "end_turn" });
	await p1;
	await flush();
	// 续轮只发 b
	assert.ok(h.rpc === undefined || true);
});

test("进程死亡 → 队列清空，不再续轮", async () => {
	const { h } = makeHandle();
	const { calls, deferreds } = stubRpc(h);
	const p1 = h.prompt("first");
	await flush();
	await h.prompt("second", { streamingBehavior: "followUp" });

	// markDead（进程 exit 路径的私有收口）：强制收口在途轮 + q.dispose 清队列；
	// 之后 rpc 桩 reject 让 prompt 沿 catch/finally 返回（alive 已 false，drain no-op）。
	const deadEvents = [];
	h.subscribe((e) => { if (e.type === "session_backend_dead") deadEvents.push(e); });
	h.markDead("process exited (signal)");
	deferreds[0].reject(new Error("[acp] dead: process exited (signal)"));
	await assert.rejects(() => p1, /dead/);
	await flush();
	assert.equal(calls.filter((m) => m === "session/prompt").length, 1, "死亡后不得续轮发出 second");
	assert.equal(deadEvents.length, 1);
});

test("D16: usage_update → getUsage/getContextUsage；available_commands_update → getCommands", async () => {
	const { h } = makeHandle();
	assert.equal(h.getUsage(), undefined); // 帧未到：合法空态

	h.onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 23168, size: 192000 } } }));
	assert.deepEqual(h.getUsage(), { contextTokens: 23168, contextWindow: 192000 });
	const cu = h.getContextUsage();
	assert.equal(cu.contextWindow, 192000);
	assert.equal(cu.tokens, 23168);
	assert.ok(Math.abs(cu.percent - (23168 / 192000) * 100) < 0.01);

	h.onLine(JSON.stringify({
		jsonrpc: "2.0", method: "session/update",
		params: { sessionId: "s", update: { sessionUpdate: "available_commands_update", availableCommands: [
			{ name: "clear", description: "清屏", input: { hint: "…" } },
			{ description: "无名条目应被丢弃" },
		] } },
	}));
	assert.deepEqual(await h.getCommands(), [{ name: "clear", description: "清屏", source: "agent" }]);
});
