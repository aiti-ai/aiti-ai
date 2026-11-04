/**
 * claude-code turn-ack 探针（债务 D11）——stream-json 长连接「result 后 0ms 写入」是否被吞。
 *
 * 方法（对齐 codebuddy turn-ack 方案 §1.2 裸 CLI 复现链）：
 *   spawn `claude -p --output-format=stream-json --input-format=stream-json
 *          --include-partial-messages --verbose --dangerously-skip-permissions`
 *   轮 1: "Reply with exactly: ONE" → 等 result 帧
 *   轮 2: result 后 **0ms** 立即写 "Reply with exactly: TWO" → 45s 等第二个 result
 *   判定：第二个 result 到达且文本含 TWO → 健康（followUp 可开）；
 *         超时 / result 复读 ONE（无 assistant 帧） → 吞输入（同 cbc 病）。
 *
 * Run: node pi-web-ext/aiti-claude-code-agent/tools/turn-ack-probe.mjs [--delay <ms>]
 * 输出：JSON 一行结论 { healthy, delayMs, turn2, evidence }
 */

import { spawn } from "node:child_process";

const delayMs = Number(process.argv[process.argv.indexOf("--delay") + 1] ?? 0) || 0;
const bin = process.env.CLAUDE_CLI_PATH || "claude";

const child = spawn(bin, [
	"-p",
	"--output-format", "stream-json",
	"--input-format", "stream-json",
	"--include-partial-messages",
	"--verbose",
	"--dangerously-skip-permissions",
], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });

const frames = [];
let buffer = "";
let turn = 0;
let resultCount = 0;
let assistantTexts = ["", ""];

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	for (;;) {
		const idx = buffer.indexOf("\n");
		if (idx === -1) break;
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		const type = String(msg.type ?? "");
		if (type === "assistant") {
			const c = msg.message?.content ?? [];
			for (const b of c) if (b.type === "text" && b.text) assistantTexts[turn] += b.text;
		}
		if (type === "result") {
			resultCount++;
			frames.push({ t: Date.now(), type, subtype: msg.subtype, result: String(msg.result ?? "").slice(0, 120) });
			if (resultCount === 1) {
				// result 后 0ms（可调 --delay）写入第二轮
				setTimeout(() => {
					child.stdin.write(JSON.stringify({
						type: "user",
						message: { role: "user", content: [{ type: "text", text: "Reply with exactly: TWO" }] },
					}) + "\n");
					turn = 1;
					frames.push({ t: Date.now(), type: "PROBE_WRITE_TURN2", delayAfterResultMs: delayMs });
				}, delayMs);
			} else if (resultCount === 2) {
				finish(true);
			}
		}
		if (type === "system" && msg.subtype === "init") frames.push({ t: Date.now(), type: "init", session_id: msg.session_id });
	}
});

child.stderr.on("data", (c) => process.stderr.write(`[stderr] ${c}`));
child.on("exit", (code) => {
	if (resultCount < 2) finish(false, `process exited (code=${code}) before turn2 result`);
});

const timer = setTimeout(() => finish(false, "timeout 120s waiting for turn2 result"), 120_000);

function finish(turned, why) {
	clearTimeout(timer);
	try { child.kill("SIGKILL"); } catch { /* already dead */ }
	const t2 = (assistantTexts[1] || "").trim();
	const r2 = frames.filter((f) => f.type === "result")[1];
	const replayed = r2 && !t2 && String(r2.result ?? "").includes("ONE");
	const out = {
		healthy: Boolean(turned && t2.includes("TWO")),
		delayMs,
		turn2AssistantText: t2.slice(0, 200) || null,
		turn2Result: r2 ? String(r2.result ?? "").slice(0, 200) : null,
		replaySuspect: replayed || undefined,
		why: why || undefined,
		frames: frames.map((f) => ({ ...f, t: undefined })),
	};
	console.log(JSON.stringify(out, null, 2));
	process.exit(0);
}

// 启动：stream-json 输入模式下 CLI 懒初始化——init 帧在首条消息后才出现（扩展实测），
// 所以不等 init，spawn 后直接写第一轮。
setTimeout(() => {
	child.stdin.write(JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "text", text: "Reply with exactly: ONE" }] },
	}) + "\n");
	turn = 0;
}, 500);
