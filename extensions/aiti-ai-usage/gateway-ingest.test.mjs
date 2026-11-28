/**
 * gateway-ingest tests — subject split, dedup idempotency, ms-collision retry.
 *
 * Uses a temp SQLite (node:sqlite) with the same schema fragment gateway-ingest touches
 * (gateway_usage + ext_usage), kept in sync with lib/db.ts by these very fixtures.
 * NOTE: fixture token names deliberately avoid secret-shaped prefixes (masked-write rule).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ingestGatewayUsage, queryGatewayUsage } from "./lib/gateway-ingest.ts";

const T_ALPHA = "token-alpha";
const T_BETA = "token-beta";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "gw-ingest-"));
  const db = new DatabaseSync(join(dir, "usage.sqlite"));
  db.exec(`
    CREATE TABLE ext_usage (
      agent TEXT NOT NULL, session_id TEXT NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER DEFAULT 0, output INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      cache_write INTEGER DEFAULT 0, reasoning INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
      cost_total REAL DEFAULT 0, credits REAL DEFAULT 0,
      PRIMARY KEY (agent, session_id, ts, provider, model)
    );
    CREATE TABLE gateway_usage (
      token TEXT NOT NULL, subject TEXT NOT NULL DEFAULT 'external', ts INTEGER NOT NULL, day TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER DEFAULT 0, output INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      cache_write INTEGER DEFAULT 0, reasoning INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
      cost_total REAL DEFAULT 0,
      PRIMARY KEY (token, ts, provider, model)
    );
  `);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const row = (over = {}) => ({
  token: T_ALPHA,
  subject: "external",
  ts: 1795797000000,
  provider: "zai-coding-cn",
  model: "glm-4.7",
  input: 17,
  output: 21,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 38,
  costTotal: 5.6e-5,
  ...over,
});

test("external subject writes BOTH gateway_usage and ext_usage (counted into totals)", () => {
  const { db, cleanup } = tempDb();
  try {
    const usage = { db };
    const inserted = ingestGatewayUsage(usage, [row()]);
    assert.equal(inserted, 2, "gateway_usage + ext_usage rows");
    assert.equal(db.prepare("SELECT total_tokens FROM gateway_usage").get().total_tokens, 38);
    const ext = db.prepare("SELECT agent, session_id, credits FROM ext_usage").get();
    assert.equal(ext.agent, "gateway");
    assert.equal(ext.session_id, T_ALPHA);
    assert.equal(ext.credits, 0);
  } finally { cleanup(); }
});

test("agent subject writes ONLY gateway_usage (no total-ledger double count)", () => {
  const { db, cleanup } = tempDb();
  try {
    const usage = { db };
    ingestGatewayUsage(usage, [row({ token: "claude-token", subject: "agent" })]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM gateway_usage").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ext_usage").get().n, 0, "agent row must not enter the caliber");
  } finally { cleanup(); }
});

test("idempotent replay: byte-identical row does not duplicate", () => {
  const { db, cleanup } = tempDb();
  try {
    const usage = { db };
    const r = row();
    ingestGatewayUsage(usage, [r]);
    const gatewayCount = () => db.prepare("SELECT COUNT(*) n FROM gateway_usage").get().n;
    const before = gatewayCount();
    // A replay is byte-identical (PK AND full content) — e.g. a gateway-side double push.
    // Same-PK-but-different-content is a *different call* and correctly nudges to a new ts
    // (covered by the collision test below).
    ingestGatewayUsage(usage, [r]);
    assert.equal(gatewayCount(), before);
  } finally { cleanup(); }
});

test("same-millisecond parallel calls do NOT lose rows (collision nudges ts)", () => {
  const { db, cleanup } = tempDb();
  try {
    const usage = { db };
    // 3 identical-PK rows: same token/ts/provider/model — must all survive (ts nudged)
    const inserted = ingestGatewayUsage(usage, [row(), row({ totalTokens: 50 }), row({ totalTokens: 60 })]);
    assert.equal(inserted, 6, "3 gateway_usage + 3 ext_usage rows (ts nudged on collision)");
    const gwRows = db.prepare("SELECT ts, total_tokens FROM gateway_usage ORDER BY ts").all();
    assert.equal(gwRows.length, 3);
    assert.equal(new Set(gwRows.map(r => r.ts)).size, 3, "distinct ts after nudge");
    assert.deepEqual(gwRows.map(r => r.total_tokens).sort((a, b) => a - b), [38, 50, 60]);
  } finally { cleanup(); }
});

test("queryGatewayUsage aggregates per token and per day", () => {
  const { db, cleanup } = tempDb();
  try {
    const usage = { db };
    ingestGatewayUsage(usage, [
      row({ token: T_ALPHA, subject: "external", totalTokens: 10 }),
      row({ token: T_ALPHA, subject: "external", ts: 1795797000001, totalTokens: 20 }),
      row({ token: T_BETA, subject: "agent", totalTokens: 5 }),
    ]);
    const q = queryGatewayUsage(usage, {});
    assert.equal(q.byToken.length, 2);
    const a = q.byToken.find(r => r.token === T_ALPHA);
    assert.equal(a.totalTokens, 30);
    assert.equal(a.subject, "external");
    assert.equal(q.byToken.find(r => r.token === T_BETA).subject, "agent");
    assert.equal(q.byDay.length, 1);
  } finally { cleanup(); }
});
