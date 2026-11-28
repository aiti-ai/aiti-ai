/**
 * agent-launch unit tests — the P0 launch resolution layer of _shared/agent-spawn-env.ts
 * (resolveCliLaunch / parseArgsLines / parseCustomAgents / spawn.command / spawn.argsPrefix).
 *
 * Covers docs/aiti-custom-agent-plan.md §3.3 merge rules:
 *   command override, argv assembly, $VAR/${cwd} expansion (undefined = empty string + warning),
 *   env merge priority (base < auto bridge < member env), the four bridge rewrite modes,
 *   agents.json validation (invalid entries skipped / dedup / line-style env compat).
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

test("resolveCliLaunch: default command=defaultCommand, args=[...prefix, ...driverArgs]", () => {
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

test("resolveCliLaunch: command override takes effect (driverArgs excluding the original CLI name is the caller's guarantee)", () => {
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

test("resolveCliLaunch: generic path auto-injects AITI_BRIDGE_URL (derived from the local instance)", () => {
	const r = resolveCliLaunch({ defaultCommand: "job", processEnv: PROC_ENV });
	assert.equal(r.env.AITI_BRIDGE_URL, "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools");
});

test("resolveCliLaunch: explicit env already carrying AITI_BRIDGE_URL is kept (no duplicate injection)", () => {
	const r = resolveCliLaunch({
		defaultCommand: "claude",
		env: { AITI_BRIDGE_URL: "http://10.0.0.9:1/x", ONLY_THIS: "1" },
		processEnv: PROC_ENV,
	});
	assert.equal(r.env.AITI_BRIDGE_URL, "http://10.0.0.9:1/x");
	assert.equal(r.env.ONLY_THIS, "1");
	assert.equal(r.env.PORT, undefined, "the explicit env is the base; processEnv is not mixed in");
});

test("resolveCliLaunch: $VAR / ${cwd} expansion (argsPrefix + memberEnv; working env first)", () => {
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

test("resolveCliLaunch: member env overrides the base env (highest priority)", () => {
	const r = resolveCliLaunch({
		defaultCommand: "x",
		env: { A: "base", B: "base" },
		memberEnv: { A: "member", REF: "$B/2" },
		processEnv: PROC_ENV,
	});
	assert.equal(r.env.A, "member");
	assert.equal(r.env.B, "base");
	assert.equal(r.env.REF, "base/2", "a member env reference takes the working env's current value first");
});

test("resolveCliLaunch: undefined reference → empty string + warning (one entry each for argsPrefix and memberEnv)", () => {
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

test("resolveCliLaunch: bridge=host.docker.internal replaces the host, keeping port and path", () => {
	const r = resolveCliLaunch({
		defaultCommand: "claude",
		env: { AITI_BRIDGE_URL: "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools" },
		bridge: "host.docker.internal",
		processEnv: PROC_ENV,
	});
	assert.equal(r.env.AITI_BRIDGE_URL, "http://host.docker.internal:3001/dev/api/extensions/aiti-devtools");
});

test("resolveCliLaunch: bridge=off removes; explicit URL adopted directly (supports ${cwd})", () => {
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
		"the member env expands before the bridge rewrite, seeing the pre-rewrite value (auto-injected default)");
});

test("resolveCliLaunch: invalid bridge mode falls back to inherit + warning; warn callback and return value are dual channels", () => {
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

test("parseArgsLines: one argument per line, comments/blank lines ignored, $VAR not expanded here", () => {
	const { args, warnings } = parseArgsLines("run\n  --rm  \n# comment\n\n-i\n$HOME");
	assert.deepEqual(args, ["run", "--rm", "-i", "$HOME"]);
	assert.equal(warnings.length, 0);
});

test("parseCustomAgents: valid entry normalizes all fields (defaults filled + target passthrough)", () => {
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
		"the default target is an empty string");
});

test("parseCustomAgents: JSON string input + line-style env compat (KEY=VALUE / -NAME)", () => {
	const { agents, warnings } = parseCustomAgents(JSON.stringify({
		agents: [{ id: "a1", label: "A", command: "cmd", env: "K=1\n-BAD\n# c" }],
	}));
	assert.equal(warnings.length, 0);
	assert.deepEqual(agents[0].env, { K: "1" });
});

test("parseCustomAgents: invalid id / duplicate id / missing label / generic missing command / invalid driver each skipped; protocol-backed missing command is legal", () => {
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
	assert.equal(agents[0].label, "first", "duplicate ids: first wins");
	assert.equal(agents[1].id, "ok");
	assert.equal(agents[2].id, "proto", "protocol-backed driver accepted, command may be empty (parsability is the registration side's call)");
	assert.equal(warnings.length, 5);
});

test("parseCustomAgents: bad JSON / agents missing / not an array → empty config + warning, no throw", () => {
	assert.deepEqual(parseCustomAgents("{broken").agents, []);
	assert.equal(parseCustomAgents("{broken").warnings.length, 1);
	assert.deepEqual(parseCustomAgents({}).agents, []);
	assert.deepEqual(parseCustomAgents({ agents: "nope" }).warnings.length, 1);
	assert.deepEqual(parseCustomAgents(null).agents, []);
});

test("parseCustomAgents: invalid var name ignored + enabled:false kept + argsPrefix array form", () => {
	const { agents, warnings } = parseCustomAgents({
		agents: [{ id: "e1", label: "E", command: "c", env: { GOOD: "1", "1BAD": "x" }, enabled: false, argsPrefix: ["a", "b"] }],
	});
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes("1BAD"));
	assert.equal(agents[0].enabled, false);
	assert.deepEqual(agents[0].argsPrefix, ["a", "b"]);
});

test("extman feature reads: after captureSpawnEnvFeatures, spawnCommand/spawnArgsPrefix take effect", () => {
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

test("extman feature declarations: spawn.command=string / spawn.argsPrefix=textlist, ids aligned with the readers", () => {
	const cmd = spawnCommandFeature("Launch wrapper");
	const pre = spawnArgsPrefixFeature("Launch wrapper");
	assert.equal(cmd.id, "spawn.command");
	assert.equal(cmd.type, "string");
	assert.equal(cmd.group, "Launch wrapper");
	assert.equal(pre.id, "spawn.argsPrefix");
	assert.equal(pre.type, "textlist");
	assert.ok(pre.description.includes("${cwd}"));
});

test("parseEnvList regression: existing semantics unaffected by the launch-layer additions", () => {
	const { ops } = parseEnvList("A=$B");
	assert.deepEqual(ops, [{ key: "A", value: "$B" }]);
});
