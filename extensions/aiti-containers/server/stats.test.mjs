/**
 * aiti-containers · live stats tests (pure parsing, no docker needed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STATS_TOPIC, collectSamples, parseStatsLine } from "./stats.ts";

test("parseStatsLine maps docker stats JSON rows", () => {
  const s = parseStatsLine(
    JSON.stringify({
      BlockIO: "0B / 0B",
      CPUPerc: "0.12%",
      Container: "abc",
      ID: "abc123",
      MemPerc: "1.50%",
      MemUsage: "12MiB / 15.6GiB",
      Name: "web",
      NetIO: "1kB / 2kB",
      PIDs: "5",
    }),
  );
  assert.deepEqual(s, {
    id: "abc123",
    name: "web",
    cpu: "0.12%",
    mem: "12MiB / 15.6GiB",
    memPerc: "1.50%",
    net: "1kB / 2kB",
    block: "0B / 0B",
    pids: "5",
  });
});

test("parseStatsLine strips the ANSI clear sequence docker prepends to each tick", () => {
  const s = parseStatsLine("\x1b[2J\x1b[H" + JSON.stringify({ Name: "web", CPUPerc: "0.5%" }));
  assert.equal(s.name, "web");
  assert.equal(s.cpu, "0.5%");
});

test("parseStatsLine rejects noise", () => {
  assert.equal(parseStatsLine(""), null);
  assert.equal(parseStatsLine("CONTAINER   CPU %"), null);
  assert.equal(parseStatsLine("{not json"), null);
  assert.equal(parseStatsLine(JSON.stringify({ CPUPerc: "1%" })), null); // no Name
});

test("collectSamples keeps the newest row per container name", () => {
  const lines = [
    JSON.stringify({ Name: "a", CPUPerc: "1%" }),
    JSON.stringify({ Name: "b", CPUPerc: "2%" }),
    JSON.stringify({ Name: "a", CPUPerc: "3%" }),
  ];
  const out = collectSamples(lines);
  assert.equal(Object.keys(out).length, 2);
  assert.equal(out.a.cpu, "3%");
  assert.equal(out.b.cpu, "2%");
});

test("stats topic name is stable", () => {
  assert.equal(STATS_TOPIC, "containers-stats");
});
