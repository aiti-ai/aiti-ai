/**
 * aiti-custom-agent index 级测试 —— startup 配置→provider 注册、API CRUD 热生效、
 * 探活跳过、注销（fake 宿主 sessionProviders；探活用本机 node 真实 spawn）。
 *
 * Run: node --test pi-web-ext/aiti-custom-agent/index.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT_ID = "aiti-custom-agent";
const NODE_BIN = process.execPath;

// ── fake 宿主 sessionProviders（记录注册/注销） ──
const registry = new Map(); // key → provider
const slot = {
	register(provider) {
		const key = `${EXT_ID}/${provider.type}`;
		registry.set(key, provider);
		return key;
	},
	remove(type) {
		return registry.delete(type);
	},
};

const configDir = mkdtempSync(join(tmpdir(), "aiti-custom-agent-idx-"));
const otherDir = mkdtempSync(join(tmpdir(), "aiti-custom-agent-other-"));

const { default: ext } = await import("./index.ts");

function api(method, segs, body) {
	return ext.server.api(new Request("http://local/" + segs.join("/"), {
		method,
		...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
	}), { path: segs, method, searchParams: new URLSearchParams() });
}

test("startup：配置 → provider 注册；探活失败成员跳过；enabled=false 不注册", async () => {
	writeFileSync(join(configDir, "agents.json"), JSON.stringify({
		agents: [
			{ id: "good-job", label: "Good Job", command: NODE_BIN,
				probe: `${NODE_BIN} -e "0"`, argsPrefix: ["-e", "process.stdout.write('ok from good-job')"], order: 50 },
			{ id: "dead-job", label: "Dead Job", command: "definitely-missing-bin-xyz" },
			{ id: "paused", label: "Paused", command: NODE_BIN, enabled: false },
		],
	}));
	await ext.server.startup({ id: EXT_ID, dir: ".", configDir, sessionProviders: slot });
	assert.deepEqual([...registry.keys()].sort(), [`${EXT_ID}/good-job`]);
	const p = registry.get(`${EXT_ID}/good-job`);
	assert.equal(p.label, "Good Job");
	assert.equal(p.order, 50);
	assert.equal(p.maxCapabilities.getMessages, true);
	assert.equal(p.maxCapabilities.setModel, false);
	const res = await api("GET", ["agents"]);
	const d = await res.json();
	assert.equal(d.agents.length, 3);
	const dead = d.agents.find((a) => a.id === "dead-job");
	assert.equal(dead.registered, false);
	assert.equal(dead.probe.ok, false);
	assert.ok(d.agents.find((a) => a.id === "paused").registered === false);
});

test("createSession：handle 事件流冒烟（真实 spawn node -e）", async () => {
	const p = registry.get(`${EXT_ID}/good-job`);
	const handle = await p.createSession({ cwd: otherDir });
	const events = [];
	let text = "";
	handle.subscribe((e) => {
		events.push(e.type);
		if (e.type === "message_update") text += String(e.delta ?? "");
		if (e.type === "message_end") text = String(e.text ?? "");
	});
	await handle.prompt("smoke task");
	const msgs = await handle.getMessages();
	assert.equal(events[0], "message_start");
	assert.equal(events[events.length - 1], "agent_settled");
	assert.ok(events.includes("message_update"));
	assert.equal(text, "ok from good-job");
	assert.equal(msgs[0].text, "smoke task");
	await handle.dispose();
});

test("POST /agents：创建 → 热注册（探活通过）", async () => {
	const res = await api("POST", ["agents"], {
		label: "Echo Docker", command: NODE_BIN, probe: `${NODE_BIN} -e "0"`,
		argsPrefix: ["-e", "process.stdout.write('hi from custom')"],
	});
	const d = await res.json();
	assert.equal(d.error, undefined);
	const key = `${EXT_ID}/echo-docker`;
	assert.ok(registry.has(key), "保存即热注册");
	const handle = await registry.get(key).createSession({ cwd: otherDir });
	const events = [];
	let text = "";
	handle.subscribe((e) => {
		events.push(e.type);
		if (e.type === "message_update") text += String(e.delta ?? "");
		if (e.type === "message_end") text = String(e.text ?? "");
	});
	await handle.prompt("x");
	assert.equal(text, "hi from custom");
	await handle.dispose();
	assert.equal(d.agents.find((a) => a.id === "echo-docker").registered, true);
});

test("POST /agents：重复 id 409；非法输入 400", async () => {
	const dup = await api("POST", ["agents"], { label: "Echo Docker", command: NODE_BIN });
	assert.equal(dup.status, 409);
	const bad = await api("POST", ["agents"], { label: "No Command" });
	assert.equal(bad.status, 400);
	const badId = await api("POST", ["agents"], { label: "X", command: NODE_BIN, id: "a/b" });
	assert.equal(badId.status, 400);
});

test("PUT /agents/<id>：更新 label 热生效；改名 = 原位替换 id", async () => {
	const upd = await api("PUT", ["agents", "echo-docker"], { label: "Echo Docker II", command: NODE_BIN });
	const d = await upd.json();
	assert.equal(d.error, undefined);
	assert.equal(registry.get(`${EXT_ID}/echo-docker`).label, "Echo Docker II");
	assert.ok(d.agents.find((a) => a.id === "echo-docker").registered, "同 id 原位更新后仍注册");

	const ren = await api("PUT", ["agents", "echo-docker"], { label: "Echo Docker III", command: NODE_BIN, id: "echo-docker3" });
	const d2 = await ren.json();
	assert.equal(d2.error, undefined);
	assert.ok(registry.has(`${EXT_ID}/echo-docker3`));
	assert.ok(!registry.has(`${EXT_ID}/echo-docker`), "旧 id 键已注销");
	assert.equal(d2.agents.find((a) => a.id === "echo-docker"), undefined);
	assert.ok(d2.agents.find((a) => a.id === "echo-docker3").registered);
});

test("DELETE /agents/<id>：删除 → 注销；PUT 不存在 404", async () => {
	const miss = await api("PUT", ["agents", "nope"], { label: "N", command: NODE_BIN });
	assert.equal(miss.status, 404);
	const del = await api("DELETE", ["agents", "echo-docker3"]);
	const d = await del.json();
	assert.equal(d.error, undefined);
	assert.ok(!registry.has(`${EXT_ID}/echo-docker3`));
	assert.ok(d.agents.find((a) => a.id === "good-job"), "其他成员不受影响");
});

test("POST /probe：临场探测（存在/缺失二态）+ { id } 重探", async () => {
	const ok = await (await api("POST", ["probe"], { command: NODE_BIN, probe: `${NODE_BIN} -e "0"` })).json();
	assert.equal(ok.ok, true);
	const fail = await (await api("POST", ["probe"], { command: "definitely-missing-bin-xyz" })).json();
	assert.equal(fail.ok, false);
	const re = await (await api("POST", ["probe"], { id: "good-job" })).json();
	assert.equal(re.ok, true);
	const miss = await api("POST", ["probe"], { id: "nope" });
	assert.equal(miss.status, 404);
});

test("POST /reload：全量重建注册表；POST /selftest：generic 句柄事件序列", async () => {
	assert.ok(registry.has(`${EXT_ID}/good-job`));
	registry.clear(); // 模拟外部清空
	const rel = await (await api("POST", ["reload"], {})).json();
	assert.ok(registry.has(`${EXT_ID}/good-job`), "reload 恢复注册");
	assert.equal(rel.ok, true);

	const st = await (await api("POST", ["selftest"], {})).json();
	assert.equal(st.ok, true);
	assert.deepEqual(st.events, ["message_start", "message_update", "message_end", "agent_settled"]);
	assert.equal(st.text, "hello from generic");
});

test("未知端点 404；agents.json 落盘与 UI 回读一致", async () => {
	const nf = await api("GET", ["bogus"]);
	assert.equal(nf.status, 404);
	const raw = JSON.parse(await import("node:fs").then((m) => m.readFileSync(join(configDir, "agents.json"), "utf8")));
	assert.ok(raw.agents.some((a) => a.id === "good-job"));
	const list = await (await api("GET", ["agents"])).json();
	assert.equal(list.agents.length, raw.agents.length);
});

test("shutdown 语义：宿主 unregisterExtensionProviders 不需要扩展配合（remove 幂等）", () => {
	assert.equal(slot.remove(`${EXT_ID}/good-job`), true);
	assert.equal(slot.remove(`${EXT_ID}/good-job`), false, "幂等");
});

// ============================================================================
// P2 协议委托（driver=claude 等 → 基础扩展 <extId>.launch 服务）
// ============================================================================

const fakeServices = new Map(); // key → launch service
const delegations = []; // { launch, options }
const fakeHandle = {
	id: "claude:delegated-fake",
	source: "aiti-claude-code-agent/claude-code",
	capabilities: { getMessages: true, setModel: true },
	cwd: otherDir,
	prompt: async () => {},
	abort: async () => {},
	subscribe: () => () => {},
	dispose: async () => {},
	alive: () => true,
	isRunning: () => false,
	getModel: () => ({ id: "m1", provider: "claude" }),
	getMessages: async () => [],
};
fakeServices.set("aiti-claude-code-agent.launch", {
	agentKey: "claude",
	capabilities: { steer: false, followUp: true, getMessages: true, setModel: true },
	listModels: async () => [{ id: "m1", provider: "claude", label: "M1" }],
	members: [{ name: "claude-code", agentKey: "claude", label: "Claude Code" }],
	createSessionFromLaunch: (launch, options) => {
		delegations.push({ launch, options });
		return fakeHandle;
	},
});

test("P2：服务缺席 → 保存成功但不注册（fail-loud：problems + serviceOk=false）", async () => {
	// 无服务 ctx 重启（清掉注册表）
	await ext.server.startup({ id: EXT_ID, dir: ".", configDir, sessionProviders: slot, services: { get: () => undefined } });
	const res = await api("POST", ["agents"], {
		label: "Alias Claude", driver: "claude", command: "",
		env: { ANTHROPIC_MODEL: "glm-5.3" }, bridge: "off",
	});
	const d = await res.json();
	assert.equal(d.error, undefined, "保存本身成功");
	assert.ok((d.problems ?? []).some((p) => p.includes("launch 服务不可用")), `problems fail-loud: ${JSON.stringify(d.problems)}`);
	const a = d.agents.find((x) => x.id === "alias-claude");
	assert.equal(a.registered, false);
	assert.equal(a.serviceOk, false);
	assert.equal(a.serviceKey, "aiti-claude-code-agent.launch");
	assert.equal([...registry.keys()].filter((k) => k.endsWith("alias-claude")).length, 0);
});

test("P2：服务在场 → 注册（agentKey/capabilities 来自服务）+ createSession 委托透传 launch/options", async () => {
	// 提供 fake 服务的 ctx 重启 → registerAll 应注册 alias-claude
	await ext.server.startup({
		id: EXT_ID, dir: ".", configDir, sessionProviders: slot,
		services: { get: (key) => fakeServices.get(key) },
	});
	const key = `${EXT_ID}/alias-claude`;
	assert.ok(registry.has(key), "launch 服务在场即注册");
	const p = registry.get(key);
	assert.equal(p.agentKey, "claude", "agentKey 来自服务");
	assert.equal(p.maxCapabilities.setModel, true, "能力模板来自服务");
	assert.equal(p.priority, 5, "低于基础扩展自家 provider（直连优先）");
	const models = await p.listModels();
	assert.deepEqual(models, [{ id: "m1", provider: "claude", label: "M1" }], "listModels 委托");

	assert.equal(registry.get(`${EXT_ID}/alias-claude`).agentKey, "claude");
	const list = await (await api("GET", ["agents"])).json();
	assert.deepEqual(list.driverMembers.claude, [{ name: "claude-code", agentKey: "claude", label: "Claude Code" }],
		"driverMembers 供 UI 委托目标下拉");
	const handle = await p.createSession({ cwd: otherDir });
	assert.equal(handle.id, "claude:delegated-fake");
	assert.equal(delegations.length, 1);
	// 成员无 command/argsPrefix/bridge → launch 只带 env；options 原样透传
	assert.deepEqual(delegations[0].launch, { env: { ANTHROPIC_MODEL: "glm-5.3" }, bridge: "off" });
	assert.deepEqual(delegations[0].options, { cwd: otherDir });
});

test("P2：成员包装字段（command/argsPrefix/bridge/target 语义）逐项透传到 launch", async () => {
	const res = await api("POST", ["agents"], {
		label: "Alias Claude Docker", driver: "claude",
		command: "docker", argsPrefix: ["run", "--rm"],
		env: { MARK: "x" }, bridge: "host.docker.internal", target: "claude-code",
		probe: `${NODE_BIN} -e "0"`,
	});
	const d = await res.json();
	assert.equal(d.error, undefined);
	const p = registry.get(`${EXT_ID}/alias-claude-docker`);
	assert.ok(p, "有探活命令 → 探活通过 → 注册");
	await p.createSession({ cwd: otherDir, sessionId: "native-1" });
	const last = delegations[delegations.length - 1];
	assert.deepEqual(last.launch, {
		command: "docker", argsPrefix: ["run", "--rm"],
		env: { MARK: "x" }, bridge: "host.docker.internal", target: "claude-code",
	});
	assert.deepEqual(last.options, { cwd: otherDir, sessionId: "native-1" });
});

test.after?.(() => {
	rmSync(configDir, { recursive: true, force: true });
	rmSync(otherDir, { recursive: true, force: true });
});
