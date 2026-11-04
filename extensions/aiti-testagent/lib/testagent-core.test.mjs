/**
 * testagent-core 跨平台解析器与机制测试（windows-compat 方案 §5 走向 B）。
 *
 * 外部命令输出用 fixture 钉死格式（Cim TSV / ps / netstat / ss / lsof），
 * 再用「本测试进程自己监听一个端口」做一次真机链路验收（解析 → pid 归属）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const core = require2("./testagent-core.cjs");

// ---------------- 进程表解析 ----------------

test("parseCimRows：Windows Cim TSV（pid⇥ppid⇥name⇥cmdline）", () => {
  const out = [
    "4\t0\tSystem\t",
    "23064\t22000\tjava.exe\tC:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe -jar app.jar",
    "22296\t23064\tjava.exe\t\"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe\" -jar D:\\app\\spring-test-1.0.jar --server.port=8080",
    "5678\t4\tnode.exe\tC:\\nodejs\\node.exe C:\\srv\\index.js",
    "junk line without tabs",
    "abc\tx\ty\tz",
  ].join("\r\n");
  const rows = core.parseCimRows(out);
  assert.deepEqual(rows.map((r) => r.pid), ["4", "23064", "22296", "5678"]);
  assert.deepEqual(rows.map((r) => r.ppid), ["0", "22000", "23064", "4"]);
  assert.equal(rows[0].name, "System");
  assert.equal(rows[0].cmd, "");
  assert.match(rows[2].cmd, /--server\.port=8080/);
});

test("parseCimRows：cmdline 内含制表符时归入 cmd 不丢行", () => {
  const rows = core.parseCimRows("9\t4\tjava.exe\tjava\t-Dfoo=1\t-jar app.jar");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ppid, "4");
  assert.equal(rows[0].cmd, "java\t-Dfoo=1\t-jar app.jar");
});

test("parsePsArgs：Linux/macOS ps -eo pid,ppid,args", () => {
  const rows = core.parsePsArgs([
    "  PID PPID COMMAND",
    "    1    0 /sbin/init",
    " 1234  999 java -javaagent:/home/pi/testagent-1.0.jar=conf=/tmp/testagent-conf -jar app.jar",
    " 2345 1234 /usr/lib/jvm/java-21/bin/jshell",
  ].join("\n"));
  assert.deepEqual(rows.map((r) => r.pid), ["1", "1234", "2345"]);
  assert.deepEqual(rows.map((r) => r.ppid), ["0", "999", "1234"]);
  assert.equal(rows[0].name, "");
  assert.match(rows[1].cmd, /^java /);
});

test("isJavaProc：Windows 靠映像名，Unix 靠命令行首 token，-jar 兜底", () => {
  assert.equal(core.isJavaProc({ name: "java.exe", cmd: "" }), true);
  assert.equal(core.isJavaProc({ name: "Javaw.EXE", cmd: "" }), true);
  assert.equal(core.isJavaProc({ name: "jshell.exe", cmd: "" }), true);
  assert.equal(core.isJavaProc({ name: "node.exe", cmd: "node index.js" }), false);
  assert.equal(core.isJavaProc({ name: "", cmd: "java -jar app.jar" }), true);
  assert.equal(core.isJavaProc({ name: "", cmd: "/usr/lib/jvm/x/bin/java -version" }), true);
  // 包装脚本内部拉起 java：首 token 不是 java，但 -jar 命中
  assert.equal(core.isJavaProc({ name: "", cmd: "bash run.sh -jar spring-test-1.0.jar" }), true);
  assert.equal(core.isJavaProc({ name: "", cmd: "grep javaFoo" }), false);
});

// ---------------- 监听端口表解析 ----------------

test("parseNetstatListening：zh-CN 表头 + TCP/UDP + 状态列混合", () => {
  const out = [
    "活动连接",
    "  协议  本地地址          外部地址        状态           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1840",
    "  TCP    127.0.0.1:8564         0.0.0.0:0              LISTENING       12345",
    "  TCP    [::]:445               [::]:0                 LISTENING       4",
    "  TCP    127.0.0.1:52000        127.0.0.1:6379         ESTABLISHED     12345",
    "  TCP    0.0.0.0:8080           0.0.0.0:0              TIME_WAIT       0",
    "  UDP    0.0.0.0:5353           *:*                                    3620",
  ].join("\r\n");
  assert.deepEqual(core.parseNetstatListening(out), [
    { port: 135, pid: "1840" },
    { port: 8564, pid: "12345" },
    { port: 445, pid: "4" },
  ]);
});

test("parseSsListening：LISTEN 行取本地端口 + users pid", () => {
  const out = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
    "LISTEN 0      4096   127.0.0.1:8564       0.0.0.0:*     users((\"java\",pid=1234,fd=41))",
    "LISTEN 0      100    *:8080               *:*           users((\"java\",pid=4321,fd=10))",
    "ESTAB  0      0      127.0.0.1:8564       127.0.0.1:52000 users((\"java\",pid=1234,fd=52))",
  ].join("\n");
  assert.deepEqual(core.parseSsListening(out), [
    { port: 8564, pid: "1234" },
    { port: 8080, pid: "4321" },
  ]);
});

test("parseLsofListening：只取 (LISTEN) 行，ESTABLISHED 对端端口不漏进来", () => {
  const out = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "java    12345 wind   41u  IPv6 123456      0t0  TCP *:8564 (LISTEN)",
    "java    12345 wind   52u  IPv6 123459      0t0  TCP 127.0.0.1:52000->127.0.0.1:6379 (ESTABLISHED)",
    "node     9999 wind   18u  IPv4 123470      0t0  TCP 127.0.0.1:3000 (LISTEN)",
  ].join("\n");
  assert.deepEqual(core.parseLsofListening(out), [
    { port: 8564, pid: "12345" },
    { port: 3000, pid: "9999" },
  ]);
});

// ---------------- 临时路径与 agent 参数 ----------------

test("conf 目录派生自 os.tmpdir()，agent 参数形态在 Windows 用正斜杠", () => {
  const os = require2("node:os");
  const path = require2("node:path");
  assert.equal(core.DEFAULT_CONF_DIR, path.join(os.tmpdir(), "testagent-conf"));
  assert.ok(!core.DEFAULT_CONF_DIR.startsWith("/tmp") || os.platform() !== "win32");
  if (os.platform() === "win32") {
    assert.ok(!core.CONF_DIR_ARG.includes("\\"), "agent 参数里不得留反斜杠: " + core.CONF_DIR_ARG);
    assert.match(core.CONF_DIR_ARG, /^[A-Za-z]:\//);
  } else {
    assert.equal(core.CONF_DIR_ARG, core.DEFAULT_CONF_DIR);
  }
});

test("jtoSnippet：按平台给出可执行形态，且含 agent jar + conf + 桥地址", () => {
  const s = core.jtoSnippet();
  assert.match(s, /-javaagent:\S*testagent/);
  assert.match(s, /-Dtestagent\.bridge=ws:\/\//);
  assert.match(s, /-Dtestagent\.httpPort=0/);
  if (require2("node:os").platform() === "win32") {
    assert.match(s, /setx JAVA_TOOL_OPTIONS /);
    assert.ok(!s.includes("/tmp/"), "Windows 片段不应出现 /tmp 路径");
    assert.ok(!s.includes(".bashrc"), "Windows 片段不应写 shell rc");
  } else {
    assert.match(s, /case "\$JAVA_TOOL_OPTIONS" in/);
    assert.match(s, /aiti-testagent auto-bridge/);
  }
});

test("stripWinJto：剥掉自家注入段，保留用户其他参数", () => {
  const ours = "-javaagent:D:/a/testagent-1.0.jar=conf=C:/t/testagent-conf -Dtestagent.bridge=ws://127.0.0.1:8667/ta/ws -Dtestagent.httpPort=0";
  assert.equal(core.stripWinJto("-Xmx1g " + ours + " -Dmine=1", ""), "-Xmx1g -Dmine=1");
  assert.equal(core.stripWinJto(ours, ours), "");
  // 桥地址变了（上次的 applied 对不上）→ 正则兜底仍能剥净
  assert.equal(core.stripWinJto("-Dkeep=1 " + ours, "-javaagent:D:/old/testagent-1.0.jar=x"), "-Dkeep=1");
});

// ---------------- 进程树归属（桩启动器另起 JVM） ----------------

test("descendantPids / ownsByPidTree：真机自己 ↔ 父进程", async () => {
  const me = String(process.pid);
  const rows = await core.procTable(true);
  const mine = rows.find((r) => String(r.pid) === me);
  assert.ok(mine, "进程表里应能查到本测试进程 " + me);
  const parent = String(mine.ppid);
  assert.ok((await core.descendantPids(parent, true)).includes(me), "父进程的后代应含自己");
  assert.equal(await core.ownsByPidTree(me, parent, true), true, "端口属主是子进程 → 启动器算持有");
  assert.equal(await core.ownsByPidTree(parent, me, true), false, "反向（父持有子的后代）不成立");
  assert.equal(await core.ownsByPidTree(me, me, true), true, "同一 pid 直接命中");
  assert.equal(await core.ownsByPidTree(null, me, true), false, "查不到属主时不认");
});

// ---------------- 挂载入参与真机链路 ----------------

test("attachJava：非数字 pid 直接拒绝（不 spawn java）", async () => {
  const r = await core.attachJava("12; rm -rf /", "");
  assert.equal(r.ok, false);
  assert.match(r.error, /纯数字/);
});

test("真机链路：自己监听的端口能反查到本进程 pid（表 + 缓存）", async () => {
  const srv = net.createServer();
  await new Promise((res, rej) => { srv.once("error", rej); srv.listen(0, "127.0.0.1", res); });
  const port = srv.address().port;
  try {
    assert.equal(await core.portOwnerPid(port, true), String(process.pid));
    assert.ok((await core.listeningPorts(process.pid)).includes(port),
      "listeningPorts 应包含刚开的 " + port);
    const a = await core.sockTable();
    const b = await core.sockTable();
    assert.equal(a, b, "5s TTL 内应命中同一份缓存");
    const c = await core.sockTable(true);
    assert.notEqual(a, c, "force 应重扫");
    const procs = await core.discoverJavaProcesses();
    assert.ok(Array.isArray(procs));
    for (const p of procs) assert.match(String(p.pid), /^\d+$/);
  } finally {
    srv.close();
  }
});
