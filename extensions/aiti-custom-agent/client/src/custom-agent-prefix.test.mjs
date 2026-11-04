/**
 * custom-agent-prefix.test.mjs —— 前缀命令包装纯函数单测（client/src，随 test-web-ext 递归发现）。
 *
 * 覆盖：结构字段 → command/argsPrefix/probe 生成（docker 五种运行方式 / ssh / env / proxychains）、
 * 常用选项追加、已存成员反向解析（docker/ssh/env/proxychains 尽量无损还原）、
 * 开启/切换包装时真实 CLI（含参数）继承不丢。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	applyPrefix, buildPrefixArgs, detectPrefix, emptyPfx, linesOf, prefixToolOf,
	realCliText, switchPrefixKind, PREFIX_TOOLS,
} from "./custom-agent-client.mjs";

/** 表单骨架（未开启包装） */
function baseForm(over = {}) {
	return {
		label: "Claude Code (Docker)", id: "claude-docker", driver: "generic",
		command: "", probe: "", argsPrefixText: "",
		prefixEnabled: false, prefixKind: "docker", pfx: emptyPfx(),
		...over,
	};
}

test("docker：默认模板生成 command/参数前缀/探活（含同路径挂载）", () => {
	const form = applyPrefix(baseForm());
	assert.equal(form.prefixEnabled, true);
	assert.equal(form.command, "docker");
	assert.equal(form.probe, "docker version");
	assert.deepEqual(linesOf(form.argsPrefixText), [
		"run", "--rm", "-i",
		"-v", "${cwd}:${cwd}", "-w", "${cwd}",
	]);
});

test("docker：镜像 + 容器内命令拼在末尾（spawn 语义：可执行文件后依次是参数）", () => {
	const form = baseForm({ probe: "" });
	form.pfx.docker.image = "aiti/aiti:core";
	form.pfx.docker.cli = "claude --verbose";
	const out = applyPrefix(form);
	assert.equal(out.command, "docker");
	assert.deepEqual(linesOf(out.argsPrefixText).slice(-3), ["aiti/aiti:core", "claude", "--verbose"]);
	assert.equal(buildPrefixArgs(out).at(-1), "--verbose");
});

test("docker：常用运行方式下拉切换（--network host / compose / exec）", () => {
	const host = applyPrefix({ ...baseForm(), pfx: { ...emptyPfx(), docker: { ...emptyPfx().docker, mode: "run-host" } } });
	assert.deepEqual(linesOf(host.argsPrefixText).slice(0, 5), ["run", "--rm", "-i", "--network", "host"]);

	const compose = applyPrefix({ ...baseForm(), pfx: { ...emptyPfx(), docker: { ...emptyPfx().docker, mode: "compose-run" } } });
	assert.deepEqual(linesOf(compose.argsPrefixText).slice(0, 3), ["compose", "run", "--rm"]);

	const exec = applyPrefix({ ...baseForm(), pfx: { ...emptyPfx(), docker: { ...emptyPfx().docker, mode: "exec-i", image: "mybox", cli: "sh" } } });
	assert.deepEqual(buildPrefixArgs(exec), ["exec", "-i", "-v", "${cwd}:${cwd}", "-w", "${cwd}", "mybox", "sh"]);
});

test("ssh：目标/端口/远端命令按 ssh 参数序生成", () => {
	const form = baseForm({ prefixKind: "ssh", prefixEnabled: true });
	form.pfx.ssh = { target: "wind@host", port: "2222", opts: "-t", cli: "claude" };
	const out = applyPrefix(form);
	assert.equal(out.command, "ssh");
	assert.equal(out.probe, "ssh -V");
	assert.deepEqual(buildPrefixArgs(out), ["-t", "-p", "2222", "wind@host", "claude"]);
});

test("env / proxychains：变量行与被包装命令、工具可切换", () => {
	const envForm = baseForm({ prefixKind: "env", prefixEnabled: true });
	envForm.pfx.env = { vars: "FOO=bar\nHTTPS_PROXY=$HTTPS_PROXY", cli: "claude" };
	const envOut = applyPrefix(envForm);
	assert.equal(envOut.command, "env");
	assert.deepEqual(buildPrefixArgs(envOut), ["FOO=bar", "HTTPS_PROXY=$HTTPS_PROXY", "claude"]);

	const socksForm = baseForm({ prefixKind: "runsocks", prefixEnabled: true });
	socksForm.pfx.runsocks = { tool: "proxychains4", opts: "-f\n/etc/proxychains.conf", cli: "claude" };
	const socksOut = applyPrefix(socksForm);
	assert.equal(prefixToolOf(socksOut), "proxychains4");
	assert.equal(socksOut.command, "proxychains4");
	assert.deepEqual(buildPrefixArgs(socksOut), ["-f", "/etc/proxychains.conf", "claude"]);
});

test("探活：自动值随类型换，用户手填的一律保留", () => {
	const auto = applyPrefix({ ...baseForm({ probe: "docker version", prefixKind: "ssh", prefixEnabled: true }), pfx: { ...emptyPfx(), ssh: { ...emptyPfx().ssh, target: "wind@host" } } });
	assert.equal(auto.probe, "ssh -V");
	const manual = applyPrefix({ ...baseForm({ probe: "docker ps >/dev/null", prefixKind: "ssh", prefixEnabled: true }), pfx: { ...emptyPfx(), ssh: { ...emptyPfx().ssh, target: "wind@host" } } });
	assert.equal(manual.probe, "docker ps >/dev/null");
});

test("反向解析：已存 docker 成员（§10.1 配方）还原结构与附加参数", () => {
	const stored = {
		command: "docker",
		argsPrefix: [
			"run", "--rm", "-i",
			"-v", "/home/pi/.claude:/home/pi/.claude",
			"-v", "${cwd}:${cwd}", "-w", "${cwd}",
			"--add-host=host.docker.internal:host-gateway",
			"aiti/aiti:core",
		],
	};
	const det = detectPrefix(stored);
	assert.equal(det.prefixEnabled, true);
	assert.equal(det.prefixKind, "docker");
	assert.equal(det.pfx.docker.mode, "run-i");
	assert.equal(det.pfx.docker.image, "aiti/aiti:core");
	assert.deepEqual(linesOf(det.pfx.docker.opts), [
		"-v", "/home/pi/.claude:/home/pi/.claude",
		"-v", "${cwd}:${cwd}", "-w", "${cwd}",
		"--add-host=host.docker.internal:host-gateway",
	]);
	// 还原后重生成：与原参数完全一致（值选项保序、无损）
	const regenerated = buildPrefixArgs({ prefixKind: det.prefixKind, pfx: det.pfx });
	assert.deepEqual(regenerated, stored.argsPrefix);
});

test("反向解析：ssh / env / proxychains 成员", () => {
	const ssh = detectPrefix({ command: "ssh", argsPrefix: ["-t", "-p", "2222", "wind@host", "claude", "-p"] });
	assert.equal(ssh.prefixKind, "ssh");
	assert.equal(ssh.pfx.ssh.target, "wind@host");
	assert.equal(ssh.pfx.ssh.port, "2222");
	assert.equal(ssh.pfx.ssh.opts, "-t");
	assert.equal(ssh.pfx.ssh.cli, "claude -p");

	const env = detectPrefix({ command: "env", argsPrefix: ["FOO=bar", "claude", "--verbose"] });
	assert.equal(env.prefixKind, "env");
	assert.equal(env.pfx.env.vars, "FOO=bar");
	assert.equal(env.pfx.env.cli, "claude --verbose");

	const socks = detectPrefix({ command: "proxychains4", argsPrefix: ["-q", "claude"] });
	assert.equal(socks.prefixKind, "runsocks");
	assert.equal(socks.pfx.runsocks.tool, "proxychains4");
	assert.equal(socks.pfx.runsocks.cli, "claude");
});

test("反向解析：非包装命令（裸 CLI）按未启用处理", () => {
	assert.equal(detectPrefix({ command: "claude", argsPrefix: ["--verbose"] }).prefixEnabled, false);
	assert.equal(detectPrefix({ command: "claude", argsPrefix: ["--verbose"] }).prefixKind, "");
});

test("下拉选「无」：不生成任何东西，用户直填的 command/参数保持不动", () => {
	const plain = baseForm({ prefixKind: "", command: "claude", argsPrefixText: "--verbose" });
	assert.deepEqual(buildPrefixArgs(plain), []);
	const off = switchPrefixKind(plain, "");
	assert.equal(off.prefixEnabled, false);
	assert.equal(off.prefixKind, "");
	assert.equal(off.command, "claude");
	assert.equal(off.argsPrefixText, "--verbose");
	// 已启用 → 选「无」退出包装：当前 command/参数前缀原样留下（用户自改）
	const on = switchPrefixKind(plain, "docker");
	const back = switchPrefixKind(on, "");
	assert.equal(back.prefixEnabled, false);
	assert.equal(back.command, "docker");
	assert.match(back.argsPrefixText, /^run\n--rm\n-i/);
});

test("下拉选包装类型：真实 CLI（含原参数）带进被包装命令且不覆盖手填", () => {
	const plain = baseForm({ command: "claude", argsPrefixText: "--verbose\n-y" });
	const enabled = switchPrefixKind(plain, "docker");
	assert.equal(enabled.prefixEnabled, true);
	assert.equal(enabled.command, "docker");
	assert.equal(enabled.pfx.docker.cli, "claude --verbose -y");
	assert.deepEqual(buildPrefixArgs(enabled).slice(-3), ["claude", "--verbose", "-y"]);

	// docker → ssh：真实 CLI 跟着走
	const toSsh = switchPrefixKind(enabled, "ssh");
	assert.equal(toSsh.prefixKind, "ssh");
	assert.equal(toSsh.command, "ssh");
	assert.equal(toSsh.pfx.ssh.cli, "claude --verbose -y");

	// 目标类型已有手填 → 不覆盖
	const handFilled = { ...enabled, pfx: { ...enabled.pfx, ssh: { ...emptyPfx().ssh, cli: "codex" } } };
	assert.equal(switchPrefixKind(handFilled, "ssh").pfx.ssh.cli, "codex");
});

test("realCliText：只有命令或只有参数时也不丢", () => {
	assert.equal(realCliText("claude", ""), "claude");
	assert.equal(realCliText("", "-e\nconsole.log(1)"), "-e console.log(1)");
	assert.equal(realCliText("", ""), "");
});

test("自定义：任意包装命令（sudo / nix-shell / podman / timeout）顶替 command，探活跟工具走", () => {
	const form = baseForm({ prefixKind: "custom" });
	form.pfx.custom = { tool: "sudo", opts: "-E", cli: "claude" };
	const out = applyPrefix(form);
	assert.equal(out.prefixEnabled, true);
	assert.equal(out.command, "sudo");
	assert.equal(out.probe, "sudo");
	assert.deepEqual(buildPrefixArgs(out), ["-E", "claude"]);

	// 换工具：自动探活跟着换；手填探活保留
	const swapped = applyPrefix({ ...form, command: "sudo", probe: "sudo", pfx: { ...form.pfx, custom: { tool: "nix-shell", opts: "--run", cli: "claude" } } });
	assert.equal(swapped.pfx.custom.tool, "nix-shell");
	assert.equal(swapped.command, "nix-shell");
	assert.equal(swapped.probe, "nix-shell");
	assert.deepEqual(buildPrefixArgs(swapped), ["--run", "claude"]);

	const manual = { ...form, command: "sudo", probe: "sudo -v" };
	manual.pfx.custom.tool = "podman";
	assert.equal(applyPrefix(manual).probe, "sudo -v");
});

test("自定义：工具名还没填时保持选中态（不回落到「无」）", () => {
	const form = switchPrefixKind(baseForm({ prefixKind: "" }), "custom");
	assert.equal(form.prefixEnabled, true);
	assert.equal(form.prefixKind, "custom");
	assert.equal(form.command, "");
	assert.deepEqual(buildPrefixArgs(form), []);
});

test("custom 与 runsocks 同构：工具名就是 command，参数一律来自结构字段", () => {
	assert.deepEqual(
		buildPrefixArgs({ prefixKind: "runsocks", pfx: { runsocks: { tool: "proxychains4", opts: "-q", cli: "claude" } } }),
		buildPrefixArgs({ prefixKind: "custom", pfx: { custom: { tool: "proxychains4", opts: "-q", cli: "claude" } } }),
	);
});

test("PREFIX_TOOLS：每种类型都有默认可执行文件与探活命令", () => {
	for (const kind of ["docker", "ssh", "env", "runsocks"]) {
		assert.match(PREFIX_TOOLS[kind].tool, /\S/, kind);
		assert.match(PREFIX_TOOLS[kind].probe, /\S/, kind);
	}
});
