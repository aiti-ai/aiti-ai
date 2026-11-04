import test from "node:test";
import assert from "node:assert/strict";
import { execFileAsync, queueRepo } from "./exec-async.ts";

test("execFileAsync resolves stdout", async () => {
  const out = await execFileAsync("echo", ["hello"]);
  assert.equal(out, "hello\n");
});

test("execFileAsync error carries stdout/stderr/status (execFileSync 形态)", async () => {
  try {
    await execFileAsync("sh", ["-c", "echo out; echo err >&2; exit 3"]);
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.status, 3);
    assert.equal(e.stdout, "out\n");
    assert.equal(e.stderr, "err");
    assert.match(e.message, /exit status 3/);
  }
});

test("execFileAsync timeout kills and reports timed out", async () => {
  try {
    await execFileAsync("sleep", ["5"], { timeoutMs: 200 });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e.killed === true);
    assert.match(e.message, /timed out/);
  }
});

test("execFileAsync input writes to stdin", async () => {
  const out = await execFileAsync("cat", [], { input: "from-stdin" });
  assert.equal(out, "from-stdin");
});

test("execFileAsync maxBuffer overflow fails with exceed message", async () => {
  try {
    await execFileAsync("sh", ["-c", "yes x | head -c 1000000"], { maxBuffer: 1024 });
    assert.fail("should throw");
  } catch (e) {
    assert.match(e.message, /maxBuffer/);
  }
});

test("execFileAsync missing binary rejects with error message", async () => {
  await assert.rejects(() => execFileAsync("definitely-not-exist-bin-xyz", ["a"]), /definitely-not-exist-bin-xyz/);
});

test("queueRepo serializes same-key tasks in order", async () => {
  const order = [];
  const mk = (id, delay) => async () => {
    await new Promise((r) => setTimeout(r, delay));
    order.push(id);
    return id;
  };
  const results = await Promise.all([
    queueRepo("k1", mk("a", 30)),
    queueRepo("k1", mk("b", 5)),
    queueRepo("k1", mk("c", 10)),
  ]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(results, ["a", "b", "c"]);
});

test("queueRepo different keys run concurrently", async () => {
  let inside = 0;
  let overlap = false;
  const fn = async () => {
    inside++;
    if (inside > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 20));
    inside--;
  };
  await Promise.all([
    queueRepo("ka", fn),
    queueRepo("kb", fn),
  ]);
  assert.equal(overlap, true);
});

test("queueRepo failure does not block subsequent tasks", async () => {
  await assert.rejects(() => queueRepo("k2", async () => { throw new Error("boom"); }), /boom/);
  const out = await queueRepo("k2", async () => "ok");
  assert.equal(out, "ok");
});
