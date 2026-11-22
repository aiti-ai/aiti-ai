/**
 * agent-launch 单测 —— _shared/agent-spawn-env.ts 的 P0 launch 解析层
 * （resolveCliLaunch / parseArgsLines / parseCustomAgents / spawn.command / spawn.argsPrefix）。
 *
 * 覆盖 docs/aiti-custom-agent-plan.md §3.3 合并规则：
 *   command 覆盖、argv 拼装、$VAR/${cwd} 展开（未定义=空串+warning）、
 *   env 合并优先级（基底 < 自动 bridge < 成员 env）、bridge 四档重写、
 *   agents.json 校验（非法跳过/去重/行式 env 兼容）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/agent-launch.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	resolveCliLaunch,
	parseArgsLines,
	parseCustomAgents,
	parseEnvList,
	spawnCommand,
	spawnArgsPrefix,
	spawnCommandFeature,
	spawnArgsPrefixFeature,
	captureSpawnEnvFeatures,
} from "./agent-spawn-env.ts";

const PROC_ENV = { PORT: "3001", PI_WEB_BASE_PATH: "/dev", HOME: "/home/pi", PATH: "/usr/bin" };

test("resolveCliLaunch：缺省 command=defaultCommand，args=[...prefix, ...driverArgs]", () => {
	const r = resolveCliLaunch({
		defaultCommand: "claude",
		argsPrefix: ["wrap", "-i"],
		driverArgs: ["-p", "--verbose"],
		processEnv: PROC_ENV,
	});
	assert.equal(r.command, "claude");
	assert.deepEqual(r.args, ["wrap", "-i", "-p", "--verbose"]);
	assert.equal(r.warnings.length, 0);
});

test("resolveCliLaunch：command 覆盖生效（driverArgs 不含原 CLI 名由调用方保证）", () => {
	const r = resolveCliLaunch({
		defaultCommand: "claude",
		command: "docker",
		argsPrefix: ["run", "--rm"],
		driverArgs: ["-p"],
		processEnv: PROC_ENV,
	});
	assert.equal(r.command, "docker");
	assert.deepEqual(r.args, ["run", "--rm", "-p"]);
	assert.equal(r.warnings.length, 0);
});

test("resolveCliLaunch：generic 路径自动注入 AITI_BRIDGE_URL（本机实例推导）", () => {
	const r = resolveCliLaunch({ defaultCommand: "job", processEnv: PROC_ENV });
	assert.equal(r.env.AITI_BRIDGE_URL, "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools");
});

test("resolveCliLaunch：显式 env 已带 AITI_BRIDGE_URL 则保持（不重复注入）", () => {
	const r = resolveCliLaunch({
		defaultCommand: "claude",
		env: { AITI_BRIDGE_URL: "http://10.0.0.9:1/x", ONLY_THIS: "1" },
		processEnv: PROC_ENV,
	});
	assert.equal(r.env.AITI_BRIDGE_URL, "http://10.0.0.9:1/x");
	assert.equal(r.env.ONLY_THIS, "1");
	assert.equal(r.env.PORT, undefined, "显式 env 是基底，不混入 processEnv");
});

test("resolveCliLaunch：$VAR / ${cwd} 展开（argsPrefix + memberEnv；工作 env 优先）", () => {
	const r = resolveCliLaunch({
		defaultCommand: "docker",
		argsPrefix: ["-v", "${cwd}:${cwd}", "-w", "${cwd}", "-e", "K=$PORT"],
		memberEnv: { WORK: "${cwd}/x", FROM_ENV: "$HOME/y" },
		processEnv: PROC_ENV,
		cwd: "/tmp/proj",
	});
	assert.deepEqual(r.args, ["-v", "/tmp/proj:/tmp/proj", "-w", "/tmp/proj", "-e", "K=3001"]);
	assert.equal(r.env.WORK, "/tmp/proj/x");
	assert.equal(r.env.FROM_ENV, "/home/pi/y");
	assert.equal(r.warnings.length, 0);
});

test("resolveCliLaunch：成员 env 覆盖基底 env（最高优先）", () => {
	const r = resolveCliLaunch({
		defaultCommand: "x",
		env: { A: "base", B: "base" },
		memberEnv: { A: "member", REF: "$B/2" },
		processEnv: PROC_ENV,
	});
	assert.equal(r.env.A, "member");
	assert.equal(r.env.B, "base");
	assert.equal(r.env.REF, "base/2", "成员 env 引用先取工作 env 当前值");
});

test("resolveCliLaunch：未定义引用 → 空串 + warning（argsPrefix 与 memberEnv 各记一条）", () => {
	const r = resolveCliLaunch({
		defaultCommand: "x",
		argsPrefix: ["$NOPE_1"],
		memberEnv: { E: "$NOPE_2" },
		processEnv: PROC_ENV,
	});
	assert.equal(r.args[0], "");
	assert.equal(r.env.E, "");
	assert.equal(r.warnings.length, 2);
	assert.ok(r.warnings.some((w) => w.includes("$NOPE_1")));
	assert.ok(r.warnings.some((w) => w.includes("$NOPE_2")));
});

test("resolveCliLaunch：bridge=host.docker.internal 替换主机保留端口路径", () => {
	const r = resolveCliLaunch({
		defaultCommand: "claude",
		env: { AITI_BRIDGE_URL: "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools" },
		bridge: "host.docker.internal",
		processEnv: PROC_ENV,
	});
	assert.equal(r.env.AITI_BRIDGE_URL, "http://host.docker.internal:3001/dev/api/extensions/aiti-devtools");
});

test("resolveCliLaunch：bridge=off 移除；显式 URL 直接采用（支持 ${cwd}）", () => {
	const off = resolveCliLaunch({ defaultCommand: "x", bridge: "off", processEnv: PROC_ENV });
	assert.equal("AITI_BRIDGE_URL" in off.env, false);
	const url = resolveCliLaunch({
		defaultCommand: "x",
		bridge: "http://bridge.local:8777",
		memberEnv: { HINT: "$AITI_BRIDGE_URL" },
		processEnv: PROC_ENV,
	});
	assert.equal(url.env.AITI_BRIDGE_URL, "http://bridge.local:8777");
	assert.equal(url.env.HINT, "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools",
		"成员 env 在 bridge 重写前展开，看到的是重写前值（自动注入默认）");
});

test("resolveCliLaunch：非法 bridge 模式按 inherit + warning；warn 回调与返回值双通道", () => {
	const viaCb = [];
	const r = resolveCliLaunch({
		defaultCommand: "x",
		bridge: "kubernetes",
		processEnv: PROC_ENV,
		warn: (m) => viaCb.push(m),
	});
	assert.equal(r.env.AITI_BRIDGE_URL, "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools");
	assert.equal(r.warnings.length, 1);
	assert.equal(viaCb.length, 1);
});

test("parseArgsLines：每行一个参数，注释/空行忽略，$VAR 不在此展开", () => {
	const { args, warnings } = parseArgsLines("run\n  --rm  \n# comment\n\n-i\n$HOME");
	assert.deepEqual(args, ["run", "--rm", "-i", "$HOME"]);
	assert.equal(warnings.length, 0);
});

test("parseCustomAgents：合法条目全字段规整（默认值补齐 + target 透传）", () => {
	const { agents, warnings } = parseCustomAgents({
		agents: [
			{
				id: "claude-docker",
				label: "Claude Code (Docker)",
				command: "docker",
				argsPrefix: "run\n--rm\n-i",
				env: { FOO: "bar" },
				bridge: "host.docker.internal",
				target: "claude-code",
				order: "50",
			},
		],
	});
	assert.equal(warnings.length, 0);
	assert.deepEqual(agents, [{
		id: "claude-docker",
		label: "Claude Code (Docker)",
		driver: "generic",
		command: "docker",
		argsPrefix: ["run", "--rm", "-i"],
		env: { FOO: "bar" },
		bridge: "host.docker.internal",
		target: "claude-code",
		probe: "",
		order: 50,
		enabled: true,
	}]);
	assert.deepEqual(parseCustomAgents({ agents: [{ id: "t2", label: "T", command: "c" }] }).agents[0].target, "",
		"缺省 target 空串");
});

test("parseCustomAgents：JSON 字符串输入 + 行式 env 兼容（KEY=VALUE / -NAME）", () => {
	const { agents, warnings } = parseCustomAgents(JSON.stringify({
		agents: [{ id: "a1", label: "A", command: "cmd", env: "K=1\n-BAD\n# c" }],
	}));
	assert.equal(warnings.length, 0);
	assert.deepEqual(agents[0].env, { K: "1" });
});

test("parseCustomAgents：非法 id / 重复 id / 缺 label / generic 缺 command / 非法 driver 逐条跳过；协议型缺 command 合法", () => {
	const { agents, warnings } = parseCustomAgents({
		agents: [
			{ id: "bad/slash", label: "X", command: "c" },
			{ id: "dup", label: "first", command: "c1" },
			{ id: "dup", label: "second", command: "c2" },
			{ id: "nolabel", command: "c" },
			{ id: "nocmd", label: "N" },
			{ id: "ok", label: "OK", command: "c" },
			{ id: "proto", label: "P", driver: "claude", command: "" },
			{ id: "baddriver", label: "B", command: "c", driver: "claude code!" },
		],
	});
	assert.equal(agents.length, 3);
	assert.equal(agents[0].label, "first", "重复 id 先到先得");
	assert.equal(agents[1].id, "ok");
	assert.equal(agents[2].id, "proto", "协议型 driver 接受、command 可空（可解析性由注册侧裁决）");
	assert.equal(warnings.length, 5);
});

test("parseCustomAgents：坏 JSON / agents 缺失 / 非数组 → 空配置 + warning 不抛错", () => {
	assert.deepEqual(parseCustomAgents("{broken").agents, []);
	assert.equal(parseCustomAgents("{broken").warnings.length, 1);
	assert.deepEqual(parseCustomAgents({}).agents, []);
	assert.deepEqual(parseCustomAgents({ agents: "nope" }).warnings.length, 1);
	assert.deepEqual(parseCustomAgents(null).agents, []);
});

test("parseCustomAgents：非法变量名忽略 + enabled:false 保留 + argsPrefix 数组形态", () => {
	const { agents, warnings } = parseCustomAgents({
		agents: [{ id: "e1", label: "E", command: "c", env: { GOOD: "1", "1BAD": "x" }, enabled: false, argsPrefix: ["a", "b"] }],
	});
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes("1BAD"));
	assert.equal(agents[0].enabled, false);
	assert.deepEqual(agents[0].argsPrefix, ["a", "b"]);
});

test("extman feature 读取：captureSpawnEnvFeatures 后 spawnCommand/spawnArgsPrefix 生效", () => {
	captureSpawnEnvFeatures({
		get: (extId, fid) => {
			if (extId === "aiti-x-agent" && fid === "spawn.command") return "docker";
			if (extId === "aiti-x-agent" && fid === "spawn.argsPrefix") return "run\n--rm";
			return undefined;
		},
	});
	try {
		assert.equal(spawnCommand("aiti-x-agent"), "docker");
		assert.equal(spawnArgsPrefix("aiti-x-agent"), "run\n--rm");
		assert.equal(spawnCommand("aiti-other"), "");
	} finally {
		captureSpawnEnvFeatures(null);
	}
});

test("extman feature 声明：spawn.command=string / spawn.argsPrefix=textlist，id 与读取对齐", () => {
	const cmd = spawnCommandFeature("启动包装");
	const pre = spawnArgsPrefixFeature("启动包装");
	assert.equal(cmd.id, "spawn.command");
	assert.equal(cmd.type, "string");
	assert.equal(cmd.group, "启动包装");
	assert.equal(pre.id, "spawn.argsPrefix");
	assert.equal(pre.type, "textlist");
	assert.ok(pre.description.includes("${cwd}"));
});

test("parseEnvList 回归：既有语义不受 launch 层新增影响", () => {
	const { ops } = parseEnvList("A=$B");
	assert.deepEqual(ops, [{ key: "A", value: "$B" }]);
});
