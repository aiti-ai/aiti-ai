import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * GET /api/sessions/[id] — read-path occupancy handling.
 *
 * A detached (single-client) wrapper can be held by another web instance; adopting it
 * from here dies mid-handshake ("pi started and exited at once: superseded"). The read route must
 * answer the disk view instead of a 409: the history is perfectly readable, and the
 * console error was the only thing the user got.
 *
 * The fixture fakes the occupancy the way the runtime sees it: a live listener on the
 * wrapper socket + a registry entry with no installed backend to drive it (the exact
 * "no backend could adopt the detached pi session" branch), so attachIfBridged raises
 * the real BridgeOccupiedError without spawning anything.
 */

const starterDir = await mkdtemp(join(tmpdir(), "pi-web-session-route-starter-"));
const sessionDir = await mkdtemp(join(tmpdir(), "pi-web-session-route-files-"));
const previousStarter = process.env.PI_AGENT_STARTER_DIR;
process.env.PI_AGENT_STARTER_DIR = starterDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });

const servers = [];
after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  if (previousStarter === undefined) delete process.env.PI_AGENT_STARTER_DIR;
  else process.env.PI_AGENT_STARTER_DIR = previousStarter;
  await rm(starterDir, { recursive: true, force: true });
  await rm(sessionDir, { recursive: true, force: true });
});

async function writeSession(uuid, entries) {
  const filePath = join(sessionDir, `2026-11-23T00-00-00-000Z_${uuid}.jsonl`);
  const header = { type: "session", version: 3, id: uuid, timestamp: "2026-11-23T00:00:00.000Z", cwd: sessionDir };
  await writeFile(filePath, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const { cacheSessionPath } = await jiti.import("@/lib/session-reader.ts");
  cacheSessionPath(uuid, filePath);
  return filePath;
}

/** Publish a wrapper registry entry whose socket accepts connections (alive) but no backend can drive it. */
async function claimDetached(uuid) {
  await mkdir(join(starterDir, "registry"), { recursive: true });
  await mkdir(join(starterDir, "run"), { recursive: true });
  const socket = join(starterDir, "run", `pi-${uuid}.sock`);
  const ready = join(starterDir, "run", `pi-${uuid}.ready`);
  await writeFile(ready, String(Date.now()));
  const server = createServer(() => { /* accept and stay silent: the probe reads "alive" */ });
  await new Promise((resolve) => server.listen(socket, resolve));
  servers.push(server);
  await writeFile(join(starterDir, "registry", `pi-${uuid}.json`), JSON.stringify({
    sessionId: uuid,
    agentKey: "pi",
    key: `pi-${uuid}`,
    socket,
    ready,
    log: join(starterDir, "run", `pi-${uuid}.log`),
    runner: "plain",
    createdAt: Date.now() - 60_000,
    providerType: "aiti-pi-agent/spawn",
    cwd: sessionDir,
    wrapperPid: process.pid,
    pid: process.pid,
  }));
}

test("a session held by another instance answers the disk view instead of 409", async () => {
  const uuid = "77777777-7777-4777-8777-777777777777";
  await writeSession(uuid, [
    { type: "message", id: "um-1", parentId: null, timestamp: "2026-11-23T00:00:01.000Z", message: { role: "user", content: "hello" } },
    { type: "message", id: "as-1", parentId: "um-1", timestamp: "2026-11-23T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ]);
  await claimDetached(uuid);

  const { GET } = await jiti.import("./route.ts");
  const res = await GET(
    new Request(`http://localhost/api/sessions/${uuid}?deferThinking=1&deferMedia=1&tree=summary`),
    { params: Promise.resolve({ id: uuid }) },
  );
  assert.equal(res.status, 200, "occupancy is not a read failure");
  const body = await res.json();
  assert.equal(body.sessionId, uuid);
  assert.deepEqual(body.context.entryIds, ["um-1", "as-1"], "real pi entry ids, straight from the file");
  assert.deepEqual(body.context.messages.map((m) => m.role), ["user", "assistant"]);
});

test("state answers idle instead of 409 while another instance drives the session", async () => {
  const uuid = "88888888-8888-4888-8888-888888888888";
  await writeSession(uuid, [
    { type: "message", id: "um-2", parentId: null, timestamp: "2026-11-23T00:00:01.000Z", message: { role: "user", content: "hello" } },
  ]);
  await claimDetached(uuid);

  const { GET } = await jiti.import("./state/route.ts");
  const res = await GET(
    new Request(`http://localhost/api/sessions/${uuid}/state`),
    { params: Promise.resolve({ id: uuid }) },
  );
  assert.equal(res.status, 200, "state must not surface the occupancy as a fault");
  assert.deepEqual(await res.json(), { running: false });
});

test("history paging keeps working from the disk view while another instance drives the session", async () => {
  const uuid = "99999999-9999-4999-8999-999999999999";
  await writeSession(uuid, [
    { type: "message", id: "um-3", parentId: null, timestamp: "2026-11-23T00:00:01.000Z", message: { role: "user", content: "first" } },
    { type: "message", id: "as-3", parentId: "um-3", timestamp: "2026-11-23T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
    { type: "message", id: "um-4", parentId: "as-3", timestamp: "2026-11-23T00:00:03.000Z", message: { role: "user", content: "second" } },
  ]);
  await claimDetached(uuid);

  const { GET } = await jiti.import("./context/route.ts");
  const res = await GET(
    new Request(`http://localhost/api/sessions/${uuid}/context?tail=20`),
    { params: Promise.resolve({ id: uuid }) },
  );
  assert.equal(res.status, 200, "paging is a read: occupancy must not break it");
  const body = await res.json();
  assert.deepEqual(body.context.entryIds, ["um-3", "as-3", "um-4"]);
  assert.deepEqual(body.context.messages.map((m) => m.role), ["user", "assistant", "user"]);
});
