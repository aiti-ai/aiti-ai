/**
 * aiti-containers · port parsing + run argv validation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregatePorts, parsePortMappings } from "./ports.ts";
import { buildRunArgs } from "./ops.ts";

test("parsePortMappings handles IPv4, IPv6 and unpublished ports", () => {
  const rows = parsePortMappings("0.0.0.0:1025->1025/tcp, :::1025->1025/tcp, 1110/tcp");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { hostIp: "0.0.0.0", hostPort: 1025, containerPort: 1025, proto: "tcp", published: true });
  assert.equal(rows[1].hostIp, "::");
  assert.deepEqual(rows[2], { hostIp: "", hostPort: 0, containerPort: 1110, proto: "tcp", published: false });
});

test("parsePortMappings tolerates noise", () => {
  assert.deepEqual(parsePortMappings(""), []);
  assert.deepEqual(parsePortMappings(undefined), []);
  assert.deepEqual(parsePortMappings("garbage"), []);
  assert.equal(parsePortMappings("127.0.0.1:8080->80/udp")[0].proto, "udp");
});

test("aggregatePorts collapses IPv4/IPv6 duplicates and keeps compose refs", () => {
  const rows = aggregatePorts([
    {
      name: "web",
      image: "nginx:alpine",
      portsList: parsePortMappings("0.0.0.0:8080->80/tcp, :::8080->80/tcp"),
      compose: { project: "demo", service: "web" },
    },
    { name: "db", image: "postgres:16", portsList: parsePortMappings("0.0.0.0:5432->5432/tcp"), compose: null },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].port, 5432);
  assert.equal(rows[1].port, 8080);
  assert.equal(rows[1].container, "web");
  assert.equal(rows[1].project, "demo");
  assert.equal(rows[1].service, "web");
});

test("buildRunArgs: detached run builds a plain argv", () => {
  const r = buildRunArgs(
    { reference: "nginx:alpine", name: "web", ports: [{ host: 8080, container: 80 }], env: ["TZ=UTC"], command: "nginx -g daemon off;" },
    { interactive: false },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ["run", "-d", "--name", "web", "-p", "8080:80", "-e", "TZ=UTC", "nginx:alpine", "nginx", "-g", "daemon", "off;"]);
});

test("buildRunArgs: interactive defaults to --rm", () => {
  const r = buildRunArgs({ reference: "alpine" }, { interactive: true, defaultRm: true });
  assert.deepEqual(r.argv, ["run", "-it", "--rm", "alpine"]);
});

test("buildRunArgs rejects invalid input", () => {
  assert.equal(buildRunArgs({ reference: "" }, {}).ok, false);
  assert.equal(buildRunArgs({ reference: "bad ref" }, {}).ok, false);
  assert.equal(buildRunArgs({ reference: "nginx", name: "-bad" }, {}).ok, false);
  assert.equal(buildRunArgs({ reference: "nginx", ports: [{ host: 0, container: 80 }] }, {}).ok, false);
  assert.equal(buildRunArgs({ reference: "nginx", env: ["1BAD=1"] }, {}).ok, false);
  assert.equal(buildRunArgs({ reference: "nginx", command: "x".repeat(501) }, {}).ok, false);
});
