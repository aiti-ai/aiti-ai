/**
 * aiti-containers · server tests (pure parsing / policy, no docker needed).
 *
 * Run: node --test server/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explainError,
  firstVersion,
  mergedOutput,
  parseContainers,
  parseImages,
  parseLabels,
  parseNetworks,
  parseSystemUsage,
  parseVolumes,
  parseJsonLines,
} from "./runtime.ts";
import { MAX_TAIL, deriveComposeProjects, isKnownAction, needsConfirm } from "./ops.ts";

test("firstVersion picks the first dotted version", () => {
  assert.equal(firstVersion("Docker version 26.1.3, build 26.1.3-0ubuntu1~24.04.1"), "26.1.3");
  assert.equal(firstVersion("podman version 4.9.3"), "4.9.3");
  assert.equal(firstVersion("no version here"), "");
});

test("parseLabels keeps the first '=' and tolerates empty input", () => {
  assert.deepEqual(parseLabels("a=b,c=d=e,broken"), { a: "b", c: "d=e" });
  assert.deepEqual(parseLabels(""), {});
  assert.deepEqual(parseLabels(undefined), {});
});

test("parseJsonLines skips malformed lines and expands arrays", () => {
  const rows = parseJsonLines('{"a":1}\nnot json\n\n[{"b":2},{"b":3}]');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].a, 1);
  assert.equal(rows[2].b, 3);
});

test("parseContainers normalizes docker (no State) and podman (State) shapes", () => {
  const docker = parseContainers(
    JSON.stringify({
      ID: "abc123def4567890",
      Names: "web",
      Image: "nginx:alpine",
      Status: "Up 2 hours",
      Ports: "0.0.0.0:80->80/tcp",
      Labels: "com.docker.compose.project=demo,com.docker.compose.service=web,com.docker.compose.project.working_dir=/tmp/demo",
      CreatedAt: "2026-01-01 00:00:00 +0000 UTC",
    }),
  );
  assert.equal(docker.length, 1);
  assert.equal(docker[0].running, true);
  assert.equal(docker[0].name, "web");
  assert.equal(docker[0].shortId, "abc123def456");
  assert.deepEqual(docker[0].compose, {
    project: "demo",
    service: "web",
    workingDir: "/tmp/demo",
    configFiles: "",
  });

  const podman = parseContainers(JSON.stringify({ ID: "ff00", Names: "job", State: "exited", Status: "Exited (0)", Labels: "" }));
  assert.equal(podman[0].running, false);
  assert.equal(podman[0].compose, null);
});

test("parseContainers drops empty rows and splits multi-name output", () => {
  const rows = parseContainers(JSON.stringify({ ID: "x", Names: "a,b" }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "a");
});

test("parseImages flags dangling rows and builds refs", () => {
  const rows = parseImages(
    [
      JSON.stringify({ ID: "sha256:111", Repository: "nginx", Tag: "alpine", Size: "40MB" }),
      JSON.stringify({ ID: "sha256:222", Repository: "<none>", Tag: "<none>", Size: "10MB" }),
    ].join("\n"),
  );
  assert.equal(rows[0].ref, "nginx:alpine");
  assert.equal(rows[0].dangling, false);
  assert.equal(rows[1].dangling, true);
  assert.equal(rows[1].ref, "sha256:222");
});

test("parseVolumes / parseNetworks / parseSystemUsage map fields", () => {
  const vols = parseVolumes(JSON.stringify({ Name: "data", Driver: "local", Mountpoint: "/var/lib/docker/volumes/data/_data" }));
  assert.equal(vols[0].name, "data");
  assert.equal(vols[0].driver, "local");

  const nets = parseNetworks(JSON.stringify({ ID: "net1", Name: "bridge", Driver: "bridge", Scope: "local", IPv6: "false" }));
  assert.equal(nets[0].ipv6, false);

  const usage = parseSystemUsage(JSON.stringify({ Type: "Images", TotalCount: "133", Active: "8", Size: "165GB", Reclaimable: "165GB (95%)" }));
  assert.deepEqual(usage[0], { type: "Images", totalCount: 133, active: 8, size: "165GB", reclaimable: "165GB (95%)" });
});

test("mergedOutput joins both streams", () => {
  assert.equal(mergedOutput({ code: 0, stdout: "out\n", stderr: "err\n", timedOut: false }), "out\nerr");
  assert.equal(mergedOutput({ code: 0, stdout: "", stderr: "", timedOut: false }), "");
});

test("explainError returns actionable messages", () => {
  assert.match(explainError("permission denied while trying to connect to the docker.sock"), /docker 组/);
  assert.match(explainError("Cannot connect to the Docker daemon"), /daemon/);
  assert.match(explainError("No such container: abc"), /不存在/);
  assert.equal(explainError(""), "未知错误");
});

test("deriveComposeProjects aggregates per project", () => {
  const containers = [
    { running: true, compose: { project: "demo", service: "web", workingDir: "/d", configFiles: "" } },
    { running: false, compose: { project: "demo", service: "db", workingDir: "/d", configFiles: "" } },
    { running: true, compose: null },
  ];
  const projects = deriveComposeProjects(containers);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].project, "demo");
  assert.equal(projects[0].total, 2);
  assert.equal(projects[0].running, 1);
  assert.deepEqual(projects[0].services.sort(), ["db", "web"]);
});

test("action whitelist and danger policy", () => {
  assert.equal(isKnownAction("containers", "start"), true);
  assert.equal(isKnownAction("containers", "nuke"), false);
  assert.equal(isKnownAction("compose", "up"), true);
  assert.equal(isKnownAction("system", "prune"), true);
  assert.equal(isKnownAction("system", "rm"), false);

  assert.equal(needsConfirm("containers", "remove"), true);
  assert.equal(needsConfirm("containers", "stop"), false);
  assert.equal(needsConfirm("compose", "down"), true);
  assert.equal(needsConfirm("compose", "up"), false);
  assert.equal(needsConfirm("system", "prune"), true);
});

test("MAX_TAIL caps at 2000", () => {
  assert.equal(MAX_TAIL, 2000);
});
