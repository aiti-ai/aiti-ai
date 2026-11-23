import assert from "node:assert/strict";
import test from "node:test";
import { hostingSwitchFlight, trackHostingSwitch, waitForHostingSwitch } from "./hosting-lock.ts";

test("waitForHostingSwitch is a no-op when no switch is in flight", async () => {
  await waitForHostingSwitch("missing-id");
  assert.equal(hostingSwitchFlight("missing-id"), undefined);
});

test("waitForHostingSwitch waits for the tracked flight and clears it", async () => {
  const { promise, resolve } = Promise.withResolvers();
  trackHostingSwitch("lock-id", promise);
  let settled = false;
  const waiting = waitForHostingSwitch("lock-id").then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolve("done");
  await waiting;
  assert.equal(settled, true);
  await promise.finally(() => undefined);
  assert.equal(hostingSwitchFlight("lock-id"), undefined);
});
