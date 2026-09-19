import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidateModelsCache,
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
} from "./models-cache.ts";

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    defaultThinkingLevel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
  };
}

test("caches model data independently for each cwd", async () => {
  invalidateModelsCache();
  let firstLoads = 0;
  let secondLoads = 0;

  const first = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("first");
  });
  await loadModelsWithCache("/second", async () => {
    secondLoads += 1;
    return modelsData("second");
  });
  const firstAgain = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("replacement");
  });

  assert.deepEqual(firstAgain, first);
  assert.equal(firstLoads, 1);
  assert.equal(secondLoads, 1);
});

test("shares one loader between concurrent requests for the same cwd", async () => {
  invalidateModelsCache();
  let loads = 0;
  let finishLoad;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { finishLoad = resolve; });
  };

  const first = loadModelsWithCache("/shared", loader);
  const second = loadModelsWithCache("/shared", loader);
  await Promise.resolve();

  assert.equal(loads, 1);
  finishLoad(modelsData("shared"));
  assert.deepEqual(await second, await first);
});

test("does not cache a stale load that finishes after invalidation", async () => {
  invalidateModelsCache();
  let finishOldLoad;
  const oldLoad = loadModelsWithCache("/stale", () => new Promise((resolve) => { finishOldLoad = resolve; }));
  await Promise.resolve();

  invalidateModelsCache();
  let freshLoads = 0;
  const fresh = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("fresh");
  });
  finishOldLoad(modelsData("stale"));
  await oldLoad;

  const cached = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("unexpected");
  });
  assert.deepEqual(cached, fresh);
  assert.equal(freshLoads, 1);
});

test("retries after a model load fails", async () => {
  invalidateModelsCache();
  await assert.rejects(
    loadModelsWithCache("/failed", async () => { throw new Error("load failed"); }),
    /load failed/,
  );

  let retries = 0;
  const fresh = await loadModelsWithCache("/failed", async () => {
    retries += 1;
    return modelsData("fresh");
  });
  assert.deepEqual(fresh, modelsData("fresh"));
  assert.equal(retries, 1);
});

test("adds runtime errors without discarding available models", () => {
  const data = modelsData("builtin");
  const result = withModelRuntimeError(data, "Invalid models.json schema");

  assert.deepEqual(result, {
    ...data,
    modelError: "Invalid models.json schema",
  });
});

test("uses a safe error for unexpected model load failures", () => {
  const data = {
    ...modelsData("builtin"),
    modelError: "Failed to load /Users/example/.pi/agent/models.json with token secret",
  };
  const result = withSafeModelLoadFailure(data);

  assert.deepEqual(result, {
    ...data,
    modelError: "Model list is temporarily unavailable. Check your configuration and try again.",
  });
});

// ── Disk snapshot layer (stale-while-revalidate) ──────────────────────────────────

import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setModelsSnapshotDirForTest } from "./models-cache.ts";

function tempSnapshotDir() {
  return mkdtempSync(join(tmpdir(), "models-cache-test-"));
}

/** Load once to obtain the real disk snapshot file name (first 16 hex of sha1(cwd)); afterwards its contents/timestamp can be overwritten. */
async function loadOnceAndFindSnapshotFile(dir, cwd) {
  invalidateModelsCache();
  await loadModelsWithCache(cwd, async () => modelsData("seed"));
  const name = readdirSync(dir).find((f) => f.endsWith(".json"));
  assert.ok(name, "seed load should persist a snapshot");
  return name;
}

test("disk snapshot: fresh snapshot answers immediately without re-running the loader", async () => {
  const dir = tempSnapshotDir();
  const restore = setModelsSnapshotDirForTest(dir);
  try {
    const name = await loadOnceAndFindSnapshotFile(dir, "/fresh-cwd");
    invalidateModelsCache(); // simulate restart: memory empty
    // Place a "fresh" snapshot (savedAt=now)
    writeFileSync(join(dir, name), JSON.stringify({ savedAt: Date.now(), data: modelsData("snap") }));
    let loads = 0;
    const second = await loadModelsWithCache("/fresh-cwd", async () => {
      loads += 1;
      return modelsData("loaded-again");
    });
    assert.equal(loads, 0); // fresh snapshot hits directly, loader not run
    assert.equal(second.modelList[0].id, "snap");
  } finally {
    restore();
    invalidateModelsCache();
  }
});

test("disk snapshot: invalidateModelsCache deletes persisted snapshots", async () => {
  const dir = tempSnapshotDir();
  const restore = setModelsSnapshotDirForTest(dir);
  try {
    const name = await loadOnceAndFindSnapshotFile(dir, "/gone-cwd");
    assert.ok(existsSync(join(dir, name)));
    invalidateModelsCache();
    assert.equal(existsSync(join(dir, name)), false);
  } finally {
    restore();
    invalidateModelsCache();
  }
});

test("disk snapshot: stale snapshot answers immediately and refreshes in background", async () => {
  const dir = tempSnapshotDir();
  const restore = setModelsSnapshotDirForTest(dir);
  try {
    const name = await loadOnceAndFindSnapshotFile(dir, "/stale-cwd");
    const savedAt = Date.now() - 15 * 60_000; // > FRESH 10min, < MAX_AGE 7d
    invalidateModelsCache(); // simulate restart
    writeFileSync(join(dir, name), JSON.stringify({ savedAt, data: modelsData("stale") }));

    let loads = 0;
    const immediate = await loadModelsWithCache("/stale-cwd", async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 20));
      return modelsData("refreshed");
    });
    assert.equal(immediate.modelList[0].id, "stale"); // return the stale snapshot immediately (no waiting for the refresh)
    await new Promise((r) => setTimeout(r, 80)); // wait for the background refresh to land
    assert.equal(loads, 1); // loader ran exactly once
    const snap = JSON.parse(readFileSync(join(dir, name), "utf8"));
    assert.equal(snap.data.modelList[0].id, "refreshed"); // snapshot overwritten by the background refresh
    assert.ok(snap.savedAt > savedAt);
  } finally {
    restore();
    invalidateModelsCache();
  }
});

test("disk snapshot: expired snapshot (over max age) is ignored", async () => {
  const dir = tempSnapshotDir();
  const restore = setModelsSnapshotDirForTest(dir);
  try {
    const name = await loadOnceAndFindSnapshotFile(dir, "/old-cwd");
    const savedAt = Date.now() - 8 * 24 * 60 * 60_000; // 8 days ago > MAX_AGE 7d
    invalidateModelsCache();
    writeFileSync(join(dir, name), JSON.stringify({ savedAt, data: modelsData("ancient") }));
    let loads = 0;
    const data = await loadModelsWithCache("/old-cwd", async () => {
      loads += 1;
      return modelsData("loaded-fresh");
    });
    assert.equal(loads, 1); // too old -> load synchronously
    assert.equal(data.modelList[0].id, "loaded-fresh");
  } finally {
    restore();
    invalidateModelsCache();
  }
});

test("disk snapshot: corrupted snapshot file is ignored", async () => {
  const dir = tempSnapshotDir();
  const restore = setModelsSnapshotDirForTest(dir);
  try {
    const name = await loadOnceAndFindSnapshotFile(dir, "/bad-cwd");
    invalidateModelsCache();
    writeFileSync(join(dir, name), "{not-json");
    let loads = 0;
    await loadModelsWithCache("/bad-cwd", async () => {
      loads += 1;
      return modelsData("loaded-fresh");
    });
    assert.equal(loads, 1); // corrupt snapshot silently skipped
  } finally {
    restore();
    invalidateModelsCache();
  }
});
