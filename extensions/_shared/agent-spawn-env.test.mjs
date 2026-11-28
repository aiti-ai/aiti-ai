/**
 * agent-spawn-env unit tests (node --test, runs TS directly: node ≥ 22.6 --experimental-strip-types).
 *
 * Covers all branches of parseEnvList/applyEnvList/resolveEnvList (incl. -NAME exclusion),
 * agentSpawnEnv merge priority (whitelist < auto bridge < extension registration < user list),
 * piWebSelfBase derivation (plan docs/pi-web-ext-agent-spawn-env-plan.md verification plan §1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Copy-sync mode: the tests run against the authoritative source itself (copy consistency is guaranteed by the sync check)
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
	spawnDisplayEnvFeature,
	captureSpawnEnvFeatures,
	resolveCliLaunch,
	readUiEnvSnapshot,
	uiEnvDataRoot,
} from "./agent-spawn-env.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------- aiti-ui-env session-env snapshot ----------------

function makeSnapshotRoot(target, envOverrides = {}) {
	const root = mkdtempSync(join(tmpdir(), "ui-env-snap-test-"));
	mkdirSync(join(root, "aiti-ui-env", "cache"), { recursive: true });
	writeFileSync(
		join(root, "aiti-ui-env", "cache", "session-env.json"),
		JSON.stringify({
			target,
			mode: "prefer-headless",
			rationale: "test",
			env: { DISPLAY: ":154", XAUTHORITY: "/tmp/ui-env-154/Xauthority", PATH: "/usr/bin", ...envOverrides },
			updatedAt: new Date().toISOString(),
		}),
	);
	return root;
}

test("uiEnvDataRoot: PI_WEB_DATA_DIR takes priority, dev/prod isolation", () => {
	assert.equal(uiEnvDataRoot({ PI_WEB_DATA_DIR: "/x" }), "/x");
	assert.match(uiEnvDataRoot({ PI_WEB_DEV_DIST: "1", HOME: tmpdir() }), /web-dev/);
	assert.match(uiEnvDataRoot({ HOME: tmpdir() }), /\.pi.web..?data|\.pi\/web\/data|\.pi\/web-dev\/data/);
});

test("piWebSelfBase: PORT + PI_WEB_BASE_PATH normalized (trailing slash stripped)", () => {
	assert.equal(piWebSelfBase({ PORT: "3001", PI_WEB_BASE_PATH: "/dev/" }), "http://127.0.0.1:3001/dev");
	assert.equal(piWebSelfBase({ PORT: "3002", PI_WEB_BASE_PATH: "" }), "http://127.0.0.1:3002");
	assert.equal(piWebSelfBase({ PI_WEB_BASE_PATH: "/dev" }), "http://127.0.0.1:3000/dev", "falls back to 3000 without PORT");
});

test("bridgeEnv: endpoint carries the extension path signature", () => {
	assert.equal(bridgeEnv({ PORT: "3002" }).AITI_BRIDGE_URL, "http://127.0.0.1:3002/api/extensions/aiti-devtools");
});

test("parseEnvList: set/exclude/comment/invalid lines", () => {
	const { ops, warnings } = parseEnvList("A=1\n -B \n# c\nbroken\n1BAD=x\n-C=x");
	assert.deepEqual(ops, [
		{ key: "A", value: "1" },
		{ key: "B", value: null },
	]);
	assert.equal(warnings.length, 3, "one each for broken / 1BAD=x / -C=x");
});

test("applyEnvList: $refs look up the working env then fall back to base; removal idempotent; removal then re-set", () => {
	const env = { HOME: "/h", GONE: "g" };
	const { ops } = parseEnvList("A=$HOME/1\n-GONE\nB=$GONE\nGONE=again");
	const warnings = [];
	applyEnvList(ops, env, { base: { HOME: "/h" }, onWarning: (w) => warnings.push(w) });
	assert.equal(env.A, "/h/1");
	assert.equal("GONE" in env, true);
	assert.equal(env.GONE, "again", "can be re-set by a later line after the removal");
	assert.equal(env.B, "", "at reference time GONE was already removed and base lacks it → empty string + warning");
	assert.equal(warnings.length, 1);
});

test("resolveEnvList: in-list cross reference b=$a resolved in place", () => {
	const { env, warnings } = resolveEnvList("A=hello\nB=$A/world\nC=${A}-${B}");
	assert.deepEqual(env, { A: "hello", B: "hello/world", C: "hello-hello/world" });
	assert.equal(warnings.length, 0);
});

test("resolveEnvList: falls back to the parent process env; undefined becomes empty with a warning", () => {
	const { env, warnings } = resolveEnvList("X=$HOME/y\nY=$NOPE_zzz", { HOME: "/home/pi" });
	assert.equal(env.X, "/home/pi/y");
	assert.equal(env.Y, "", "undefined → empty string, literal not kept");
	assert.ok(warnings.some((w) => w.includes("$NOPE_zzz")));
});

test("resolveEnvList: -NAME exclusion (harmless idempotent no-op on a blank env)", () => {
	const { env, warnings } = resolveEnvList("A=1\n-A\n-A");
	assert.deepEqual(env, {});
	assert.equal(warnings.length, 0, "excluding an unset variable is idempotent and harmless");
});

test("resolveEnvList: no quote stripping / %VAR% / command substitution (kept as literals)", () => {
	const { env } = resolveEnvList('Q="quoted"\nP=%PATH%\nC=`date`');
	assert.equal(env.Q, '"quoted"');
	assert.equal(env.P, "%PATH%");
	assert.equal(env.C, "`date`");
});

test("agentSpawnEnv: whitelist < auto bridge < user list (can override the auto value)", () => {
	const governance = (_cli, extra) => ({ PATH: "/bin", ...(extra || {}) });
	const out = agentSpawnEnv({
		cli: "zcode",
		governance,
		envList: "AITI_BRIDGE_URL=http://override:1/mcp\nUSERV=$UNDEF2",
		processEnv: { PORT: "3002", UNDEF2: "pv" },
		warn: () => {},
	});
	assert.equal(out.PATH, "/bin");
	assert.equal(out.AITI_BRIDGE_URL, "http://override:1/mcp", "the user list overrides the auto injection");
	assert.equal(out.USERV, "pv", "a list reference falls back to the parent process env");
});

test("agentSpawnEnv: -NAME emergency escape — pull out a variable leaked through passthrough, or drop the auto injection", () => {
	const governance = (_cli, extra) => ({ PATH: "/bin", LEAKY: "oops", ...(extra || {}) });
	const out = agentSpawnEnv({
		cli: "zcode",
		governance,
		envList: "-LEAKY\n-AITI_BRIDGE_URL",
		processEnv: { PORT: "3002" },
		warn: () => {},
	});
	assert.equal("LEAKY" in out, false, "excludes the governance passthrough variable");
	assert.equal("AITI_BRIDGE_URL" in out, false, "excludes the auto-injected item");
	assert.equal(out.PATH, "/bin", "non-excluded entries are kept as usual");
});

test("agentSpawnEnv: extension registered list < user list; registration-side exclusion works too", () => {
	registerSpawnEnvDefaults("aiti-test-ext", "REG=1\n-LEAKY");
	try {
		const out = agentSpawnEnv({
			extId: "aiti-test-ext",
			envList: "REG=2",
			processEnv: { LEAKY: "x" },
			warn: () => {},
		});
		assert.equal(out.REG, "2", "the user overrides the registered default");
		assert.equal("LEAKY" in out, false, "registration-side exclusion takes effect");
		assert.match(out.AITI_BRIDGE_URL, /api\/extensions\/aiti-devtools$/);
	} finally {
		registerSpawnEnvDefaults("aiti-test-ext", "");
	}
});

test("agentSpawnEnv: references can resolve governance passthrough (working env before base)", () => {
	const governance = (_cli, extra) => ({ MARK: "m1", ...(extra || {}) });
	const out = agentSpawnEnv({ cli: "x", governance, envList: "USE=$MARK", processEnv: { MARK: "base" }, warn: () => {} });
	assert.equal(out.USE, "m1", "the working env (passthrough value) wins");
});

test("agentSpawnEnv: no-governance camp (cursor/qoder) = processEnv base + bridge + list", () => {
	const out = agentSpawnEnv({ envList: "K=1", processEnv: { FOO: "f" }, warn: () => {} });
	assert.equal(out.FOO, "f");
	assert.equal(out.K, "1");
	assert.match(out.AITI_BRIDGE_URL, /api\/extensions\/aiti-devtools$/);
});

test("agentSpawnEnv: warnings do not throw (console.warn when warn is not passed)", () => {
	assert.doesNotThrow(() => agentSpawnEnv({ envList: "bad line", processEnv: {} }));
});

test("spawnEnvList: ctx.features first, non-string treated as an empty list", () => {
	captureSpawnEnvFeatures({ get: (_e, fid) => (fid === "spawn.env" ? "A=1" : undefined) });
	assert.equal(spawnEnvList("aiti-x"), "A=1");
	captureSpawnEnvFeatures({ get: () => true });
	assert.equal(spawnEnvList("aiti-x"), "", "boolean value (old host) treated as an empty list");
	captureSpawnEnvFeatures(null);
});

test("spawnEnvFeature: declaration shape (id/type=textlist, includes the -NAME syntax note)", () => {
	const f = spawnEnvFeature("G");
	assert.equal(f.id, "spawn.env");
	assert.equal(f.type, "textlist");
	assert.equal(f.group, "G");
	assert.ok(f.description.includes("-NAME"));
});

test("readUiEnvSnapshot: whitelist key filtering + bad snapshot returns null", () => {
	const root = makeSnapshotRoot("headless");
	const snap = readUiEnvSnapshot({ PI_WEB_DATA_DIR: root });
	assert.ok(snap);
	assert.equal(snap.target, "headless");
	assert.equal(snap.env.DISPLAY, ":154");
	assert.equal(snap.env.XAUTHORITY, "/tmp/ui-env-154/Xauthority");
	assert.equal("PATH" in snap.env, false, "keys outside the whitelist (PATH) are not injected");
	// corrupt JSON / bad target → null
	writeFileSync(join(root, "aiti-ui-env", "cache", "session-env.json"), "{broken");
	assert.equal(readUiEnvSnapshot({ PI_WEB_DATA_DIR: root }), null);
	writeFileSync(join(root, "aiti-ui-env", "cache", "session-env.json"), JSON.stringify({ target: "bogus", env: {} }));
	assert.equal(readUiEnvSnapshot({ PI_WEB_DATA_DIR: root }), null);
	assert.equal(readUiEnvSnapshot({ PI_WEB_DATA_DIR: join(root, "missing") }), null, "missing file → null");
	rmSync(root, { recursive: true, force: true });
});

test("agentSpawnEnv: snapshot injected by default (auto), off disables, target filter switch works", () => {
	const root = makeSnapshotRoot("headless");
	const pe = { PI_WEB_DATA_DIR: root, FOO: "f" };
	captureSpawnEnvFeatures(null); // no feature → default auto
	const out = agentSpawnEnv({ extId: "aiti-pi-agent", envList: "K=1", processEnv: pe, warn: () => {} });
	assert.equal(out.DISPLAY, ":154", "default auto: snapshot DISPLAY injected");
	assert.equal(out.K, "1");
	captureSpawnEnvFeatures({ get: (_e, fid) => (fid === "spawn.displayEnv" ? "off" : undefined) });
	const outOff = agentSpawnEnv({ extId: "aiti-pi-agent", processEnv: pe, warn: () => {} });
	assert.equal("DISPLAY" in outOff, false, "off: not injected");
	captureSpawnEnvFeatures({ get: (_e, fid) => (fid === "spawn.displayEnv" ? "desktop" : undefined) });
	const outMismatch = agentSpawnEnv({ extId: "aiti-pi-agent", processEnv: pe, warn: () => {} });
	assert.equal("DISPLAY" in outMismatch, false, "desktop switch + headless snapshot → not injected");
	const rootD = makeSnapshotRoot("desktop", { DISPLAY: ":1" });
	const outMatch = agentSpawnEnv({ extId: "aiti-pi-agent", processEnv: { PI_WEB_DATA_DIR: rootD }, warn: () => {} });
	assert.equal(outMatch.DISPLAY, ":1", "desktop switch + desktop snapshot → injected");
	captureSpawnEnvFeatures(null);
	// no snapshot → zero behavior change (PI_WEB_DATA_DIR points at an empty dir so
	// the test never reads the real ~/.pi snapshot written by a running instance)
	const emptyRoot = mkdtempSync(join(tmpdir(), "ui-env-snap-empty-"));
	const outNone = agentSpawnEnv({ extId: "aiti-pi-agent", envList: "K=1", processEnv: { PI_WEB_DATA_DIR: emptyRoot, FOO: "f" }, warn: () => {} });
	assert.equal("DISPLAY" in outNone, false, "no snapshot → zero change");
	rmSync(root, { recursive: true, force: true });
	rmSync(rootD, { recursive: true, force: true });
	rmSync(emptyRoot, { recursive: true, force: true });
});

test("agentSpawnEnv: user spawn.env still highest priority (override / -DISPLAY removes snapshot injection)", () => {
	const root = makeSnapshotRoot("headless");
	const pe = { PI_WEB_DATA_DIR: root };
	const outOv = agentSpawnEnv({ extId: "aiti-pi-agent", envList: "DISPLAY=:0", processEnv: pe, warn: () => {} });
	assert.equal(outOv.DISPLAY, ":0", "the user list overrides the snapshot");
	const outRm = agentSpawnEnv({ extId: "aiti-pi-agent", envList: "-DISPLAY", processEnv: pe, warn: () => {} });
	assert.equal("DISPLAY" in outRm, false, "-DISPLAY removes the snapshot injection");
	rmSync(root, { recursive: true, force: true });
});

test("spawnDisplayEnvFeature: declaration shape (id/type=string)", () => {
	const f = spawnDisplayEnvFeature("G");
	assert.equal(f.id, "spawn.displayEnv");
	assert.equal(f.type, "string");
	assert.equal(f.group, "G");
	assert.ok(f.description.includes("headless"));
});

test("resolveCliLaunch: .cmd/.bat command on win32 → shell:true (closes the lessons §0.1 debt)", () => {
	const r = resolveCliLaunch({ defaultCommand: "cli", command: process.platform === "win32" ? "C:\tools\agent.cmd" : "cli", driverArgs: ["--flag"] });
	if (process.platform === "win32") {
		assert.equal(r.shell, true, ".cmd must hint shell:true");
	} else {
		assert.ok(!r.shell, "POSIX does not set the shell flag");
	}
	const r2 = resolveCliLaunch({ defaultCommand: "claude", driverArgs: [] });
	assert.ok(!r2.shell, "bare name / extension-less command does not set the shell flag");
});
