/**
 * agent-spawn-env 单测（node --test，直跑 TS：node ≥ 22.6 --experimental-strip-types）。
 *
 * 覆盖 parseEnvList/applyEnvList/resolveEnvList 全分支（含 -NAME 排除）、
 * agentSpawnEnv 合并优先级（白名单 < 自动 bridge < 扩展注册 < 用户列表）、
 * piWebSelfBase 推导（方案 docs/pi-web-ext-agent-spawn-env-plan.md 验证计划 §1）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// 复制同步模式下，测试权威源本体（副本由 sync 检查保证一致）
import {
	piWebSelfBase,
	bridgeEnv,
	parseEnvList,
	applyEnvList,
	resolveEnvList,
	agentSpawnEnv,
	registerSpawnEnvDefaults,
	spawnEnvList,
	spawnEnvFeature,
	captureSpawnEnvFeatures,
	resolveCliLaunch,
} from "./agent-spawn-env.ts";

test("piWebSelfBase：PORT + PI_WEB_BASE_PATH 归一（尾斜杠剥除）", () => {
	assert.equal(piWebSelfBase({ PORT: "3001", PI_WEB_BASE_PATH: "/dev/" }), "http://127.0.0.1:3001/dev");
	assert.equal(piWebSelfBase({ PORT: "3002", PI_WEB_BASE_PATH: "" }), "http://127.0.0.1:3002");
	assert.equal(piWebSelfBase({ PI_WEB_BASE_PATH: "/dev" }), "http://127.0.0.1:3000/dev", "缺 PORT 回落 3000");
});

test("bridgeEnv：端点带扩展路径签名", () => {
	assert.equal(bridgeEnv({ PORT: "3002" }).AITI_BRIDGE_URL, "http://127.0.0.1:3002/api/extensions/aiti-devtools");
});

test("parseEnvList：设置/排除/注释/非法行", () => {
	const { ops, warnings } = parseEnvList("A=1\n -B \n# c\nbroken\n1BAD=x\n-C=x");
	assert.deepEqual(ops, [
		{ key: "A", value: "1" },
		{ key: "B", value: null },
	]);
	assert.equal(warnings.length, 3, "broken / 1BAD=x / -C=x 各一条");
});

test("applyEnvList：$引用查工作 env 再回退 base；移除幂等；移除后可重设", () => {
	const env = { HOME: "/h", GONE: "g" };
	const { ops } = parseEnvList("A=$HOME/1\n-GONE\nB=$GONE\nGONE=again");
	const warnings = [];
	applyEnvList(ops, env, { base: { HOME: "/h" }, onWarning: (w) => warnings.push(w) });
	assert.equal(env.A, "/h/1");
	assert.equal("GONE" in env, true);
	assert.equal(env.GONE, "again", "移除行之后可被后续行重新设置");
	assert.equal(env.B, "", "引用时 GONE 已被移除且 base 无 → 空串 + warning");
	assert.equal(warnings.length, 1);
});

test("resolveEnvList：列表内互引 b=$a 就地解析", () => {
	const { env, warnings } = resolveEnvList("A=hello\nB=$A/world\nC=${A}-${B}");
	assert.deepEqual(env, { A: "hello", B: "hello/world", C: "hello-hello/world" });
	assert.equal(warnings.length, 0);
});

test("resolveEnvList：回退父进程 env，未定义置空并记 warning", () => {
	const { env, warnings } = resolveEnvList("X=$HOME/y\nY=$NOPE_zzz", { HOME: "/home/pi" });
	assert.equal(env.X, "/home/pi/y");
	assert.equal(env.Y, "", "未定义 → 空串，不保留字面量");
	assert.ok(warnings.some((w) => w.includes("$NOPE_zzz")));
});

test("resolveEnvList：-NAME 排除（对空白 env 是无害幂等）", () => {
	const { env, warnings } = resolveEnvList("A=1\n-A\n-A");
	assert.deepEqual(env, {});
	assert.equal(warnings.length, 0, "排除未设置的变量幂等无害");
});

test("resolveEnvList：不做引号剥离/%VAR%/命令替换（按字面量）", () => {
	const { env } = resolveEnvList('Q="quoted"\nP=%PATH%\nC=`date`');
	assert.equal(env.Q, '"quoted"');
	assert.equal(env.P, "%PATH%");
	assert.equal(env.C, "`date`");
});

test("agentSpawnEnv：白名单 < 自动 bridge < 用户列表（可覆盖自动值）", () => {
	const governance = (_cli, extra) => ({ PATH: "/bin", ...(extra || {}) });
	const out = agentSpawnEnv({
		cli: "zcode",
		governance,
		envList: "AITI_BRIDGE_URL=http://override:1/mcp\nUSERV=$UNDEF2",
		processEnv: { PORT: "3002", UNDEF2: "pv" },
		warn: () => {},
	});
	assert.equal(out.PATH, "/bin");
	assert.equal(out.AITI_BRIDGE_URL, "http://override:1/mcp", "用户列表覆盖自动注入");
	assert.equal(out.USERV, "pv", "列表引用回退父进程 env");
});

test("agentSpawnEnv：-NAME 急救——拔掉透传漏进来的变量，也可去掉自动注入", () => {
	const governance = (_cli, extra) => ({ PATH: "/bin", LEAKY: "oops", ...(extra || {}) });
	const out = agentSpawnEnv({
		cli: "zcode",
		governance,
		envList: "-LEAKY\n-AITI_BRIDGE_URL",
		processEnv: { PORT: "3002" },
		warn: () => {},
	});
	assert.equal("LEAKY" in out, false, "排除治理透传变量");
	assert.equal("AITI_BRIDGE_URL" in out, false, "排除自动注入项");
	assert.equal(out.PATH, "/bin", "未排除的照常保留");
});

test("agentSpawnEnv：扩展注册列表 < 用户列表；注册侧排除同样生效", () => {
	registerSpawnEnvDefaults("aiti-test-ext", "REG=1\n-LEAKY");
	try {
		const out = agentSpawnEnv({
			extId: "aiti-test-ext",
			envList: "REG=2",
			processEnv: { LEAKY: "x" },
			warn: () => {},
		});
		assert.equal(out.REG, "2", "用户覆盖注册默认");
		assert.equal("LEAKY" in out, false, "注册侧排除生效");
		assert.match(out.AITI_BRIDGE_URL, /api\/extensions\/aiti-devtools$/);
	} finally {
		registerSpawnEnvDefaults("aiti-test-ext", "");
	}
});

test("agentSpawnEnv：引用可解析治理透传（工作 env 优先于 base）", () => {
	const governance = (_cli, extra) => ({ MARK: "m1", ...(extra || {}) });
	const out = agentSpawnEnv({ cli: "x", governance, envList: "USE=$MARK", processEnv: { MARK: "base" }, warn: () => {} });
	assert.equal(out.USE, "m1", "工作 env（透传值）优先");
});

test("agentSpawnEnv：无 governance 派（cursor/qoder）= processEnv 基底 + bridge + 列表", () => {
	const out = agentSpawnEnv({ envList: "K=1", processEnv: { FOO: "f" }, warn: () => {} });
	assert.equal(out.FOO, "f");
	assert.equal(out.K, "1");
	assert.match(out.AITI_BRIDGE_URL, /api\/extensions\/aiti-devtools$/);
});

test("agentSpawnEnv：warning 不抛错（未传 warn 走 console.warn）", () => {
	assert.doesNotThrow(() => agentSpawnEnv({ envList: "bad line", processEnv: {} }));
});

test("spawnEnvList：ctx.features 优先，非字符串按空列表", () => {
	captureSpawnEnvFeatures({ get: (_e, fid) => (fid === "spawn.env" ? "A=1" : undefined) });
	assert.equal(spawnEnvList("aiti-x"), "A=1");
	captureSpawnEnvFeatures({ get: () => true });
	assert.equal(spawnEnvList("aiti-x"), "", "boolean 值（旧 host）按空列表");
	captureSpawnEnvFeatures(null);
});

test("spawnEnvFeature：声明形状（id/type=textlist，含 -NAME 语法说明）", () => {
	const f = spawnEnvFeature("G");
	assert.equal(f.id, "spawn.env");
	assert.equal(f.type, "textlist");
	assert.equal(f.group, "G");
	assert.ok(f.description.includes("-NAME"));
});

test("resolveCliLaunch：win32 下 .cmd/.bat command → shell:true（lessons §0.1 欠账收口）", () => {
	const r = resolveCliLaunch({ defaultCommand: "cli", command: process.platform === "win32" ? "C:\tools\agent.cmd" : "cli", driverArgs: ["--flag"] });
	if (process.platform === "win32") {
		assert.equal(r.shell, true, ".cmd 必须提示 shell:true");
	} else {
		assert.ok(!r.shell, "POSIX 不设 shell 标记");
	}
	const r2 = resolveCliLaunch({ defaultCommand: "claude", driverArgs: [] });
	assert.ok(!r2.shell, "裸名/无扩展名 command 不设 shell 标记");
});
