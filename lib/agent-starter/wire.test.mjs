import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  CH_CTRL,
  CH_STDERR,
  CH_STDOUT,
  CH_STDIN,
  FRAME_HEADER_BYTES,
  FrameParser,
  decodeControl,
  encodeControl,
  encodeFrame,
} from "./wire.ts";

test("encodeFrame/decode roundtrip keeps channel and payload", () => {
  const frame = encodeFrame(CH_STDOUT, Buffer.from("hello world"));
  assert.equal(frame.length, FRAME_HEADER_BYTES + 11);
  assert.equal(frame.readUInt8(0), CH_STDOUT);
  assert.equal(frame.readUInt32BE(1), 11);
  const parser = new FrameParser();
  const frames = parser.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].channel, CH_STDOUT);
  assert.equal(frames[0].payload.toString(), "hello world");
});

test("parser reassembles a frame split across chunks (byte by byte)", () => {
  const payload = Buffer.from("split-frame-payload");
  const frame = encodeFrame(CH_STDERR, payload);
  const parser = new FrameParser();
  const out = [];
  for (const byte of frame) {
    out.push(...parser.push(Buffer.from([byte])));
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, CH_STDERR);
  assert.equal(out[0].payload.toString(), "split-frame-payload");
  assert.equal(parser.pending(), 0);
});

test("parser yields several frames from one chunk and keeps the tail", () => {
  const parser = new FrameParser();
  const chunk = Buffer.concat([
    encodeFrame(CH_STDIN, Buffer.from("a")),
    encodeFrame(CH_STDOUT, Buffer.from("bb")),
    encodeFrame(CH_CTRL, Buffer.from("{")), // incomplete JSON, still a whole frame
    Buffer.from([CH_STDOUT, 0, 0]), // partial header of a fourth frame
  ]);
  const frames = parser.push(chunk);
  assert.deepEqual(frames.map((f) => f.channel), [CH_STDIN, CH_STDOUT, CH_CTRL]);
  assert.equal(frames[1].payload.toString(), "bb");
  assert.equal(parser.pending(), 3);
  // Completing the partial header resumes exactly where it stopped.
  const rest = parser.push(Buffer.concat([Buffer.from([0, 1]), Buffer.from("z")]));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].payload.toString(), "z");
});

test("oversized frame length is rejected instead of allocating", () => {
  const parser = new FrameParser(1024);
  const header = Buffer.alloc(5);
  header.writeUInt8(CH_STDOUT, 0);
  header.writeUInt32BE(1025, 1);
  assert.throws(() => parser.push(header), /exceeds limit/);
});

test("drainPending hands the incomplete tail to another owner", () => {
  const parser = new FrameParser();
  const frame = encodeFrame(CH_STDOUT, Buffer.from("abcdef"));
  parser.push(frame.subarray(0, 6)); // header + 1 payload byte
  const tail = parser.drainPending();
  assert.equal(tail.length, 6);
  assert.equal(parser.pending(), 0);
  const resumed = new FrameParser();
  assert.deepEqual(resumed.push(Buffer.concat([tail, frame.subarray(6)]))[0].payload.toString(), "abcdef");
});

test("control frames survive the json roundtrip and unknown frames are ignored", () => {
  const hello = { t: "hello", pid: 42, wrapperPid: 43, sessionId: "s1", agentKey: "pi", runner: "plain" };
  const encoded = encodeControl(hello);
  assert.equal(encoded.readUInt8(0), CH_CTRL);
  const parser = new FrameParser();
  const [frame] = parser.push(encoded);
  assert.deepEqual(decodeControl(frame.payload), hello);
  assert.equal(decodeControl(Buffer.from("not json")), undefined);
  assert.equal(decodeControl(Buffer.from(JSON.stringify({ t: "nope" }))), undefined);
  const kill = encodeControl({ t: "kill", signal: "SIGKILL" });
  assert.deepEqual(decodeControl(parser.push(kill)[0].payload), { t: "kill", signal: "SIGKILL" });
});

test("multi-writer frames: peers roundtrip + hello.writers survives decode", () => {
  const parser = new FrameParser();
  const peers = encodeControl({ t: "peers", count: 3 });
  assert.deepEqual(decodeControl(parser.push(peers)[0].payload), { t: "peers", count: 3 });
  const hello = encodeControl({ t: "hello", pid: 1, wrapperPid: 2, journalBytes: 10, journalFrames: 2, writers: 3 });
  assert.equal(decodeControl(parser.push(hello)[0].payload).writers, 3);
});
