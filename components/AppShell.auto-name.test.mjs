import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("compacted sessions still get a title from the persisted message count", () => {
  assert.match(
    source,
    /\(sessionStats\?\.userMessages \?\? 0\) > 0 \|\| selectedSession\.messageCount > 0/,
  );
});

test("sessions not yet persisted do not trigger JSONL-dependent auto naming", () => {
  assert.match(
    source,
    /const disabled = !selectedSession \|\| selectedSession\.transient \|\| !hasMessages/,
  );
});

test("once persisted, the session clears transient state via the server record", () => {
  assert.match(source, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  assert.match(source, /if \(selectedSession\) hydrateSelectedSession\(selectedSession\.id\)/);
});
