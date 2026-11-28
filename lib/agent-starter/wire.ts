/**
 * Framing protocol between pi-web and a detachable agent wrapper.
 *
 * One connection carries five logical channels over a single byte stream:
 *
 *   ch0  stdin   client → agent   (raw bytes, protocol untouched)
 *   ch1  stdout  agent  → client
 *   ch2  stderr  agent  → client
 *   ch3  control wrapper ⇄ client (JSON frames: hello / exit / spawn_error /
 *                                 kill / superseded / peers)
 *   ch4  peer stdin  wrapper → client (stdin frames written by ANOTHER client;
 *                                 the explicit replacement for terminal echo —
 *                                 conversational protocols do not guarantee an
 *                                 echo of user prompts, so the wrapper mirrors
 *                                 every writer's stdin to the other writers)
 *
 * Frame layout: [1 byte channel][4 byte BE length][payload]
 *
 * The wire protocol of the agent itself (pi RPC JSONL, ACP, …) is never parsed
 * here — this layer only re-frames bytes so a socket can replace a pipe.
 */

import { Buffer } from "node:buffer";

export const CH_STDIN = 0;
export const CH_STDOUT = 1;
export const CH_STDERR = 2;
export const CH_CTRL = 3;
export const CH_PEER_STDIN = 4;

/** Upper bound for one frame payload. A larger frame means a corrupt stream. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export const FRAME_HEADER_BYTES = 5;

export type Frame = { channel: number; payload: Buffer };

export function encodeFrame(channel: number, payload: Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload as Uint8Array);
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  out.writeUInt8(channel & 0xff, 0);
  out.writeUInt32BE(body.length, 1);
  body.copy(out, FRAME_HEADER_BYTES);
  return out;
}

/** Streaming frame decoder: feed socket chunks, get whole frames out. */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  /**
   * Push one chunk, return every complete frame it completed.
   * Throws on an oversized length header (callers must treat this as a
   * protocol corruption and drop the connection).
   */
  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= FRAME_HEADER_BYTES) {
      const channel = this.buffer.readUInt8(offset);
      const length = this.buffer.readUInt32BE(offset + 1);
      if (length > this.maxFrameBytes) {
        throw new Error(`agent-starter: frame length ${length} exceeds limit ${this.maxFrameBytes}`);
      }
      const end = offset + FRAME_HEADER_BYTES + length;
      if (this.buffer.length < end) break;
      frames.push({ channel, payload: this.buffer.subarray(offset + FRAME_HEADER_BYTES, end) });
      offset = end;
    }
    if (offset > 0) this.buffer = this.buffer.subarray(offset);
    return frames;
  }

  /** Bytes buffered but not yet forming a complete frame (diagnostics). */
  pending(): number {
    return this.buffer.length;
  }

  /** Take the incomplete tail (handing a parser over to another owner). */
  drainPending(): Buffer {
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }
}

// ============================================================================
// Control frames (ch3 payloads are UTF-8 JSON)
// ============================================================================

/** wrapper → client: the agent process exists (sent before any journal replay). */
export type HelloFrame = {
  t: "hello";
  /** Agent process pid (as reported by the wrapper's spawn). */
  pid: number;
  /** Wrapper process pid (diagnostics / orphan hunting). */
  wrapperPid: number;
  sessionId?: string;
  agentKey?: string;
  /** Which runner hosted the wrapper ("systemd-run" | "plain"). */
  runner?: string;
  /** Bytes of replayed journal that follow this frame (stdout+stderr payload bytes only; stdin history frames are extra). */
  journalBytes?: number;
  /** Number of journal frames that follow this frame. */
  journalFrames?: number;
  /** Number of currently attached writer clients (multi-writer wrappers). */
  writers?: number;
};

/** wrapper → client: spawning the agent command failed (ENOENT etc.). */
export type SpawnErrorFrame = { t: "spawn_error"; message: string };

/** wrapper → client: the agent process is gone. */
export type ExitFrame = { t: "exit"; code: number | null; signal: string | null };

/**
 * wrapper → client: a newer client took over this session (single writer).
 * Legacy frame: multi-writer wrappers (clients set, no supersede) never send it,
 * but the type stays so hosts keep decoding older wrappers unchanged.
 */
export type SupersededFrame = { t: "superseded" };

/** wrapper → client: the attached-writer count changed (join or leave). */
export type PeersFrame = { t: "peers"; count: number };

/** client → wrapper: terminate the agent (SIGTERM by default, SIGKILL after grace). */
export type KillFrame = { t: "kill"; signal?: string };

/**
 * client → wrapper: this connection is a real host client (sent right after
 * connect). Only an identified socket supersedes the current client — a
 * liveness probe must never steal the single-writer slot (2026-11-23: a probe
 * disconnected the live page, whose event stream then received no more
 * queue_update frames).
 */
export type HelloAckFrame = { t: "hello_ack" };

/** client → wrapper: liveness probe — never a client, never a supersede. */
export type ProbeFrame = { t: "probe" };

/** client → wrapper: read-only writer-count query — answered with a peers frame, never a client. */
export type QueryPeersFrame = { t: "query_peers" };

export type ControlFrame = HelloFrame | SpawnErrorFrame | ExitFrame | SupersededFrame | KillFrame | HelloAckFrame | ProbeFrame | PeersFrame | QueryPeersFrame;

export function encodeControl(frame: ControlFrame): Buffer {
  return encodeFrame(CH_CTRL, Buffer.from(JSON.stringify(frame), "utf8"));
}

export function decodeControl(payload: Buffer): ControlFrame | undefined {
  try {
    const value = JSON.parse(payload.toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return undefined;
    const t = (value as { t?: unknown }).t;
    if (
      t !== "hello" && t !== "spawn_error" && t !== "exit" && t !== "kill" && t !== "superseded"
      && t !== "hello_ack" && t !== "probe" && t !== "peers" && t !== "query_peers"
    ) return undefined;
    return value as ControlFrame;
  } catch {
    return undefined;
  }
}
