import test from "node:test";
import assert from "node:assert/strict";
import {
  dialogExitCode,
  dialogStdout,
  dialogToRequest,
  dialogWindowSize,
} from "../dist/index.js";

const ok = (over) => ({ id: "x", status: "answered", tookMs: 1, timeoutMs: 0, ...over });

test("confirm maps to approve/reject actions with custom labels", () => {
  const request = dialogToRequest({ kind: "confirm", text: "Continue?", okLabel: "Yes", cancelLabel: "No" });
  assert.equal(request.kind, "confirm");
  assert.equal(request.message, "Continue?");
  assert.deepEqual(request.actions.map((a) => a.id), ["approve", "reject"]);
  assert.deepEqual(request.actions.map((a) => a.label), ["Yes", "No"]);
});

test("choose requires options and keeps order", () => {
  const request = dialogToRequest({ kind: "choose", text: "Pick", options: ["A", "B"] });
  assert.deepEqual(request.options.map((o) => o.label), ["A", "B"]);
  assert.throws(() => dialogToRequest({ kind: "choose", text: "Pick" }), /at least one/);
});

test("input carries placeholder/default/secret", () => {
  const request = dialogToRequest({ kind: "input", text: "Name", defaultValue: "foo", placeholder: "type", password: true });
  assert.equal(request.input.defaultValue, "foo");
  assert.equal(request.input.placeholder, "type");
  assert.equal(request.input.secret, true);
});

test("file and directory map to pick_path", () => {
  const file = dialogToRequest({ kind: "file", multiple: true, filters: ["*.png"] });
  assert.equal(file.kind, "pick_path");
  assert.equal(file.pick.mode, "file");
  assert.equal(file.pick.multiple, true);
  assert.deepEqual(file.pick.extensions, ["*.png"]);
  const dir = dialogToRequest({ kind: "directory" });
  assert.equal(dir.pick.mode, "directory");
});

test("zenity-compatible exit codes", () => {
  assert.equal(dialogExitCode(ok({ approved: true, action: "approve" })), 0);
  assert.equal(dialogExitCode(ok({ approved: false, action: "reject" })), 1);
  assert.equal(dialogExitCode(ok({ action: "cancel" })), 1);
  assert.equal(dialogExitCode(ok({ status: "cancelled" })), 1);
  assert.equal(dialogExitCode(ok({ status: "timeout" })), 5);
  assert.equal(dialogExitCode(ok({ status: "error" })), 4);
});

test("stdout prints the chosen/typed value and nothing for confirm/notify", () => {
  assert.equal(dialogStdout(ok({ action: "approve", approved: true }), { kind: "confirm" }), "");
  assert.equal(dialogStdout(ok({ value: { text: "hello" } }), { kind: "input" }), "hello");
  assert.equal(dialogStdout(ok({ value: { label: "B" } }), { kind: "choose" }), "B");
  assert.equal(dialogStdout(ok({ value: { paths: ["/a", "/b"] } }), { kind: "file" }), "/a\n/b");
  assert.equal(dialogStdout(ok({ status: "timeout" }), { kind: "input" }), "");
});

test("window sizes grow with the option count", () => {
  assert.ok(dialogWindowSize({ kind: "choose", options: ["A", "B", "C"] }).height > dialogWindowSize({ kind: "confirm" }).height);
});
