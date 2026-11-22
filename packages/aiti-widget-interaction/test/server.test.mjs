import test from "node:test";
import assert from "node:assert/strict";
import { InteractionBroker, startInteractionServer } from "../dist/index.js";

test("serves the interaction page and pending/answer API", async () => {
  const broker = new InteractionBroker({ idFactory: () => "http-1" });
  const handle = await startInteractionServer({ broker, port: 0, token: "test-token" });
  try {
    const page = await fetch(handle.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /widget interaction/i);

    const pending = await fetch(`${handle.baseUrl}interactions/pending`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(pending.status, 200);
    assert.deepEqual((await pending.json()).requests, []);

    const result = broker.ask({ kind: "confirm", title: "Continue?" });
    const body = await fetch(`${handle.baseUrl}interactions/pending?token=test-token`).then((r) => r.json());
    assert.equal(body.requests.length, 1);
    assert.equal(body.requests[0].title, "Continue?");

    const answer = await fetch(`${handle.baseUrl}interactions/http-1/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ action: "approve", approved: true }),
    });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).ok, true);
    const resolved = await result;
    assert.equal(resolved.status, "answered");
    assert.equal(resolved.approved, true);

    const late = await fetch(`${handle.baseUrl}interactions/http-1/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(late.status, 409);
  } finally {
    await handle.close();
    broker.close();
  }
});

test("rejects API requests without the token", async () => {
  const broker = new InteractionBroker();
  const handle = await startInteractionServer({ broker, port: 0, token: "secret" });
  try {
    const response = await fetch(`${handle.baseUrl}interactions/pending`);
    assert.equal(response.status, 401);
  } finally {
    await handle.close();
    broker.close();
  }
});
