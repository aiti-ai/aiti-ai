import assert from "node:assert/strict";
import test from "node:test";
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketChild, isDetachableChild } from "./socket-child.ts";
import { CH_STDIN, FrameParser, decodeControl, encodeControl, encodeFrame } from "./wire.ts";

/** Minimal wrapper stand-in: sends a handshake, then relays per test script. */
async function startFakeWrapper(onConnection) {
  const dir = mkdtempSync(join(tmpdir(), "pi-starter-fake-"));
  const path = join(dir, "w.sock");
  const server = createServer((socket) => {
    // Keep the readable side flowing: a paused socket never sees FIN and would
    // keep server.close() waiting forever (test-harness artifact, not the wrapper).
    socket.resume();
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(path, resolve));
  return {
    server,
    path,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function connectAndHandshake(path, frames = []) {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    socket.once("error", reject);
    socket.once("connect", () => {
      // The real client reads hello first, then constructs the facade with the
      // rest of the batch as the prelude — mirror that here.
      const parser = new FrameParser();
      const collected = [];
      const onData = (chunk) => {
        collected.push(...parser.push(chunk));
        const helloFrame = collected.find((f) => f.channel === 3 && decodeControl(f.payload)?.t === "hello");
        if (!helloFrame) return;
        socket.off("data", onData);
        const hello = decodeControl(helloFrame.payload);
        const prelude = collected.filter((f) => f !== helloFrame);
        resolve(
          new SocketChild(
            socket,
            { pid: hello.pid, wrapperPid: hello.wrapperPid, sessionId: hello.sessionId, agentKey: hello.agentKey },
            { frames: prelude },
          ),
        );
      };
      socket.on("data", onData);
      for (const frame of frames) socket.write(encodeFrame(frame.channel, frame.payload));
    });
  });
}

test("facade exposes a ChildProcess-shaped surface and relays output", async () => {
  const wrapper = await startFakeWrapper((socket) => {
    socket.write(encodeControl({ t: "hello", pid: 4242, wrapperPid: 4343, sessionId: "sess-1", agentKey: "pi" }));
    socket.write(encodeFrame(1, Buffer.from("out-1\n")));
    socket.write(encodeFrame(2, Buffer.from("err-1\n")));
    setTimeout(() => {
      socket.write(encodeControl({ t: "exit", code: 3, signal: null }));
      socket.end();
    }, 30);
  });
  const child = await connectAndHandshake(wrapper.path);
  assert.equal(child.pid, 4242);
  assert.equal(child.wrapperPid, 4343);
  assert.equal(isDetachableChild(child), true);

  const stdout = [];
  const stderr = [];
  const events = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  child.on("exit", (code, signal) => events.push(["exit", code, signal]));
  child.on("close", (code) => events.push(["close", code]));

  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(stdout.join(""), "out-1\n");
  assert.equal(stderr.join(""), "err-1\n");
  assert.deepEqual(events, [["exit", 3, null], ["close", 3]]);
  assert.equal(child.exitCode, 3);
  await wrapper.close();
});

test("stdin writes are framed on ch0 and kill sends a control frame", async () => {
  const received = [];
  const wrapper = await startFakeWrapper((socket) => {
    socket.write(encodeControl({ t: "hello", pid: 7, wrapperPid: 8 }));
    const parser = new FrameParser();
    socket.on("data", (chunk) => {
      for (const frame of parser.push(chunk)) {
        if (frame.channel === 3) received.push(decodeControl(frame.payload));
        else received.push([frame.channel, frame.payload.toString()]);
      }
    });
  });
  const child = await connectAndHandshake(wrapper.path);
  child.stdin.write("prompt\n");
  assert.equal(child.kill("SIGKILL"), true);
  assert.equal(child.killed, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(received[0], [CH_STDIN, "prompt\n"]);
  assert.deepEqual(received[1], { t: "kill", signal: "SIGKILL" });
  child.release();
  await wrapper.close();
});

test("release() detaches without an exit event (dispose semantics)", async () => {
  let serverSawClose = false;
  const wrapper = await startFakeWrapper((socket) => {
    socket.write(encodeControl({ t: "hello", pid: 9, wrapperPid: 10 }));
    socket.on("close", () => {
      serverSawClose = true;
    });
  });
  const child = await connectAndHandshake(wrapper.path);
  const events = [];
  child.on("exit", () => events.push("exit"));
  child.on("close", () => events.push("close"));
  child.release();
  child.release(); // idempotent
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(events, ["close"]);
  assert.equal(serverSawClose, true);
  assert.equal(child.exitCode, null);
  await wrapper.close();
});

test("superseded control frame and silent socket close both surface as exit", async () => {
  const wrapper = await startFakeWrapper((socket) => {
    socket.write(encodeControl({ t: "hello", pid: 11, wrapperPid: 12 }));
    setTimeout(() => socket.write(encodeControl({ t: "superseded" })), 20);
  });
  const child = await connectAndHandshake(wrapper.path);
  const dropped = [];
  child.on("dropped", (reason) => dropped.push(reason));
  await new Promise((resolve) => child.once("close", resolve));
  assert.deepEqual(dropped, ["superseded"]);

  const wrapper2 = await startFakeWrapper((socket) => {
    socket.write(encodeControl({ t: "hello", pid: 13, wrapperPid: 14 }));
    setTimeout(() => socket.destroy(), 20);
  });
  const child2 = await connectAndHandshake(wrapper2.path);
  await new Promise((resolve) => child2.once("close", resolve));
  assert.equal(child2.exitCode, null);
  assert.equal(child2.signalCode, null);
  await wrapper.close();
  await wrapper2.close();
});

test("prelude frames (journal replay) are delivered before later live frames", async () => {
  const wrapper = await startFakeWrapper((socket) => {
    socket.write(encodeControl({ t: "hello", pid: 15, wrapperPid: 16 }));
    socket.write(encodeFrame(1, Buffer.from("journal-1\n")));
    socket.write(encodeFrame(1, Buffer.from("journal-2\n")));
    setTimeout(() => socket.write(encodeFrame(1, Buffer.from("live-1\n"))), 20);
  });
  const child = await connectAndHandshake(wrapper.path);
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk.toString()));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(chunks, ["journal-1\n", "journal-2\n", "live-1\n"]);
  child.release();
  await wrapper.close();
});

test("replay_end marks the boundary between journal replay and live frames", async () => {
  const wrapper = await startFakeWrapper((socket) => {
    socket.write(encodeControl({ t: "hello", pid: 21, wrapperPid: 22 }));
    socket.write(encodeFrame(1, Buffer.from("journal\n")));
    setTimeout(() => socket.write(encodeFrame(1, Buffer.from("live\n"))), 40);
  });
  const child = await connectAndHandshake(wrapper.path);
  const events = [];
  child.on("replay_end", (frames) => events.push(["replay_end", frames]));
  child.stdout.on("data", (chunk) => events.push(["out", chunk.toString()]));
  await new Promise((resolve) => setTimeout(resolve, 120));
  // Replay is dispatched before the boundary, live traffic after it.
  assert.deepEqual(events, [["out", "journal\n"], ["replay_end", 1], ["out", "live\n"]]);
  child.release();
  await wrapper.close();
});

test("an empty journal still reports a replay boundary", async () => {
  const wrapper = await startFakeWrapper((socket) => {
    socket.write(encodeControl({ t: "hello", pid: 23, wrapperPid: 24 }));
  });
  const child = await connectAndHandshake(wrapper.path);
  const boundary = await new Promise((resolve) => child.on("replay_end", resolve));
  assert.equal(boundary, 0);
  child.release();
  await wrapper.close();
});
