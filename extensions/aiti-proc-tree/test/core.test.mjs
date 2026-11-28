/**
 * aiti-proc-tree · pure-logic tests (node --test).
 * Run: node --test test/
 */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import core from "../core.cjs";

test("parseLinuxStat extracts pid/ppid/ticks/starttime", () => {
  const line = "1234 (node (worker)) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 1 0 999 123456 789 0";
  const p = core.parseLinuxStat(line);
  assert.equal(p.pid, 1234);
  assert.equal(p.ppid, 1);
  assert.equal(p.state, "S");
  assert.equal(p.utime, 5);
  assert.equal(p.stime, 6);
  assert.equal(p.starttime, 999);
  assert.equal(core.parseLinuxStat("garbage"), null);
});

test("cpuPercent computes deltas and rejects the first tick", () => {
  assert.equal(core.cpuPercent(null, { utime: 10, stime: 10 }, 2000, 100), null);
  // 100 ticks over 2s at 100 Hz = 50% of one core
  assert.equal(core.cpuPercent({ utime: 0, stime: 0 }, { utime: 60, stime: 40 }, 2000, 100), 50);
  // multi-core can exceed 100
  assert.equal(core.cpuPercent({ utime: 0, stime: 0 }, { utime: 400, stime: 0 }, 2000, 100), 200);
  assert.equal(core.cpuPercent({ utime: 10, stime: 0 }, { utime: 5, stime: 0 }, 2000, 100), null);
});

test("parseEnvMarkers reads the ownership channels", () => {
  const env = "PATH=/bin\0AITI_PROC_TREE_OWNER=aiti-cmd\0AITI_PROC_TREE_KIND=terminal\0AITI_PROC_TREE_ID=s_1\0AITI_PROC_TREE_INSTANCE=42\0";
  const m = core.parseEnvMarkers(env);
  assert.equal(m.owner, "aiti-cmd");
  assert.equal(m.kind, "terminal");
  assert.equal(m.id, "s_1");
  assert.equal(m.instancePid, 42);

  const sub = core.parseEnvMarkers("PI_SUBAGENT_CHILD=1\0PI_SUBAGENT_RUNNER_PID=77\0");
  assert.equal(sub.owner, "pi-subagents");
  assert.equal(sub.kind, "subagent");

  const tunnel = core.parseEnvMarkers("SERVICE_TUNNELS_ROLE=tunnel\0SERVICE_TUNNELS_MARKER=abc\0");
  assert.equal(tunnel.owner, "service-tunnels");
  assert.equal(tunnel.kind, "tunnel");
  assert.equal(tunnel.id, "abc");

  assert.equal(core.parseEnvMarkers("PATH=/bin\0"), null);
});

test("normalizeRegistryRows maps every source and dedupes", () => {
  const rows = core.normalizeRegistryRows({
    cmdHost: [{ sid: "s1", cmd: "bash", pid: 10, wrapperPid: 9, cwd: "/tmp", runner: "systemd-run", createdAt: 1 }],
    agentStarter: [{ sessionId: "a1", agentKey: "pi", pid: 20, wrapperPid: 19, launcherPid: 100, providerType: "x", cwd: "/w" }],
    bridge: { "/s/session.jsonl": { socket: "/tmp/s.sock", pid: 30, startedAt: 2 } },
    tunnels: [{ pid: 40, role: "tunnel", t: 3 }],
    subagents: [{ runId: "r1", state: "running", pid: 50, agent: "worker", startedAt: 4 }],
    services: [{ owner: "aiti-cmd", kind: "terminal", id: "s1", pid: 10, label: "shell" }],
  });
  assert.equal(rows.length, 5);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  assert.equal(byPid.get(10).label, "shell"); // service row wins the dedupe key
  assert.equal(byPid.get(20).kind, "agent");
  assert.equal(byPid.get(30).kind, "agent");
  assert.equal(byPid.get(40).kind, "tunnel");
  assert.equal(byPid.get(50).kind, "subagent");
});

test("buildTree keeps only the ecosystem closure and links detached roots", () => {
  const raw = new Map([
    [100, { pid: 100, ppid: 1, state: "S", utime: 0, stime: 0, starttime: 1 }],
    [101, { pid: 101, ppid: 100, state: "S", utime: 0, stime: 0, starttime: 2 }],
    [102, { pid: 102, ppid: 101, state: "S", utime: 0, stime: 0, starttime: 3 }],
    [200, { pid: 200, ppid: 1, state: "S", utime: 0, stime: 0, starttime: 4 }],
    [201, { pid: 201, ppid: 200, state: "S", utime: 0, stime: 0, starttime: 5 }],
    [300, { pid: 300, ppid: 1, state: "S", utime: 0, stime: 0, starttime: 6 }],
  ]);
  const rows = [
    { owner: "aiti-cmd", kind: "terminal", id: "s1", label: "shell", pid: 102, source: "aiti-cmd-host" },
    { owner: "agent-starter", kind: "agent", id: "a1", label: "pi", pid: 201, wrapperPid: 200, launcherPid: 100, source: "agent-starter", instance: "external" },
  ];
  const tree = core.buildTree({ raw, rows, selfPid: 101, cliPid: 100, mode: "dev" });
  const pids = tree.nodes.map((n) => n.pid).sort((a, b) => a - b);
  assert.deepEqual(pids, [100, 101, 102, 200, 201]); // 300 (unrelated) never appears
  const host = tree.nodes.find((n) => n.pid === 100);
  assert.equal(host.kind, "host");
  assert.equal(host.canKill, false);
  assert.equal(host.hasChildren, true); // 101 lives under 100
  const server = tree.nodes.find((n) => n.pid === 101);
  assert.equal(server.hasChildren, true); // 102 lives under 101
  const terminal0 = tree.nodes.find((n) => n.pid === 102);
  assert.equal(terminal0.hasChildren, false);
  const terminal = tree.nodes.find((n) => n.pid === 102);
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.parentPid, 101);
  const wrapper = tree.nodes.find((n) => n.pid === 200);
  assert.equal(wrapper.kind, "helper");
  assert.equal(wrapper.parentPid, 100); // detached root reattached to the launcher
  const agent = tree.nodes.find((n) => n.pid === 201);
  assert.equal(agent.kind, "agent");
  assert.equal(agent.parentPid, 200);
});

test("killPlan enforces uid/protected/owned rules and expands subtrees", () => {
  const raw = new Map([
    [100, { pid: 100, ppid: 1, state: "S", utime: 0, stime: 0, starttime: 1 }],
    [101, { pid: 101, ppid: 100, state: "S", utime: 0, stime: 0, starttime: 2 }],
    [102, { pid: 102, ppid: 101, state: "S", utime: 0, stime: 0, starttime: 3 }],
    [103, { pid: 103, ppid: 102, state: "S", utime: 0, stime: 0, starttime: 4 }],
    [300, { pid: 300, ppid: 1, state: "S", utime: 0, stime: 0, starttime: 5 }],
  ]);
  const owned = new Set([100, 101, 102, 103]);
  const base = { raw, uid: 1000, selfPid: 101, cliPid: 100, owned, uidOf: () => 1000 };

  const sub = core.killPlan({ ...base, targets: [102], mode: "subtree" });
  assert.deepEqual(sub.allowed.map((a) => a.pid).sort((a, b) => a - b), [102, 103]);

  const single = core.killPlan({ ...base, targets: [102], mode: "single" });
  assert.deepEqual(single.allowed.map((a) => a.pid), [102]);

  const host = core.killPlan({ ...base, targets: [100], mode: "single" });
  assert.equal(host.allowed.length, 0);
  assert.equal(host.denied[0].reason, "host");

  const hostAllowed = core.killPlan({ ...base, targets: [100], mode: "single", allowHost: true });
  assert.deepEqual(hostAllowed.allowed.map((a) => a.pid), [100]);

  const self = core.killPlan({ ...base, targets: [101], mode: "single" });
  assert.equal(self.denied[0].reason, "self");

  const foreign = core.killPlan({ ...base, targets: [300], mode: "single" });
  assert.equal(foreign.denied[0].reason, "not-owned");

  const otherUid = core.killPlan({ ...base, targets: [102], mode: "single", uidOf: () => 0 });
  assert.equal(otherUid.denied[0].reason, "other-user");

  // subtree never includes a protected host node
  const subHost = core.killPlan({ ...base, targets: [100], mode: "subtree", allowHost: true });
  assert.ok(!subHost.allowed.some((a) => a.pid === 101));
});

test("formatters degrade safely", () => {
  assert.equal(core.fmtBytes(null), "—");
  assert.equal(core.fmtBytes(1024), "1.0 KB");
  assert.equal(core.fmtCpu(null), "—");
  assert.equal(core.fmtCpu(12.34), "12.3%");
  assert.equal(core.fmtDuration(null), "—");
  assert.equal(core.fmtDuration(90000), "1m 30s");
});
