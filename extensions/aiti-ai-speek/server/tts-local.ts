/**
 * tts-local —— OpenAI-compatible local TTS client (extension side).
 *
 * The service speaks the OpenAI `/v1/audio/speech` subset; this module owns everything the
 * browser needs but the service should not care about:
 *   - wire format negotiation: raw PCM (s16le mono @ sampleRate) -> proper WAV container
 *     (streaming headers with dataSize=0xFFFFFFFF break <audio> seek/duration in Chromium)
 *   - WAV length back-fill when a provider streams an unknown-length header
 *   - mp3 passthrough
 *   - error mapping (503 model loading / 400 unknown voice / timeouts)
 *   - a single-flight limiter: local inference is CPU bound, so requests are serialized
 *
 * Speed is intentionally NOT sent (always 1.0): the UI applies playbackRate on <audio>, which
 * keeps the cache key rate-free and works identically for every provider.
 */

export type LocalFormat = "pcm" | "wav" | "mp3";

export interface LocalSynthOptions {
  baseUrl: string;
  text: string;
  voice?: string;
  model?: string;
  format?: LocalFormat;
  sampleRate?: number;
  apiKey?: string;
  timeoutMs?: number;
}

export interface LocalSynthResult {
  buf: Buffer;
  /** Cache file extension (".wav" | ".mp3") */
  ext: ".wav" | ".mp3";
  contentType: string;
  /** Format actually received (after any downgrade) */
  format: LocalFormat;
  sampleRate: number;
}

export type LocalTtsErrorCode =
  | "not-ready" | "unknown-voice" | "timeout" | "unsupported-format" | "http" | "network" | "bad-input";

export class LocalTtsError extends Error {
  code: LocalTtsErrorCode;
  status: number;
  constructor(code: LocalTtsErrorCode, message: string, status = 0) {
    super(message);
    this.name = "LocalTtsError";
    this.code = code;
    this.status = status;
  }
  /** True when retrying later can plausibly succeed (model warming up / service restarting). */
  get retryable(): boolean {
    return this.code === "not-ready" || this.code === "timeout" || this.code === "network";
  }
}

/** Trim trailing slashes; empty value falls back to the documented loopback default. */
export function normalizeBaseUrl(url: string): string {
  const v = String(url || "").trim();
  const base = v || "http://127.0.0.1:8768";
  return base.replace(/\/+$/, "");
}

/** Wrap raw s16le mono PCM into a standard 44-byte RIFF/WAVE container. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);            // PCM chunk size
  header.writeUInt16LE(1, 20);             // format = PCM
  header.writeUInt16LE(1, 22);             // channels = mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32);             // block align
  header.writeUInt16LE(16, 34);            // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Rewrite RIFF + data sizes for buffers with placeholder/zero lengths (streaming WAV). */
export function fixWavHeader(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return buf;
  }
  const out = Buffer.from(buf);
  out.writeUInt32LE(out.length - 8, 4);
  // Walk chunks to find "data" instead of assuming a 44-byte canonical header.
  let off = 12;
  while (off + 8 <= out.length) {
    const id = out.toString("ascii", off, off + 4);
    const size = out.readUInt32LE(off + 4);
    if (id === "data") {
      const real = out.length - (off + 8);
      if (size === 0 || size === 0xffffffff || size > real) out.writeUInt32LE(real, off + 4);
      break;
    }
    off += 8 + size;
    if (size === 0 || off <= 0) break; // malformed header: leave as-is beyond RIFF size
  }
  return out;
}

/** Single-flight queue: local inference runs one request at a time (CPU bound). */
class SerialLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  /** Queue depth guard: a huge burst should fail fast instead of ballooning memory. */
  constructor(private readonly maxPending = 32) {}
  get depth(): number { return this.pending; }
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maxPending) {
      return Promise.reject(new LocalTtsError("network", "local TTS queue is full", 429));
    }
    this.pending++;
    const next = this.tail.then(fn, fn);
    this.tail = next.then(() => undefined, () => undefined).finally(() => { this.pending--; });
    return next as Promise<T>;
  }
}
const limiter = new SerialLimiter();
export function localQueueDepth(): number { return limiter.depth; }

interface SpeechCall {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  text: string;
  voice?: string;
  format: LocalFormat;
  sampleRate: number;
  timeoutMs: number;
}

function mapHttpError(status: number, body: string): LocalTtsError {
  const snippet = (body || "").slice(0, 300);
  if (status === 503) return new LocalTtsError("not-ready", `local TTS not ready (503): ${snippet}`, status);
  if (status === 400) return new LocalTtsError("unknown-voice", `local TTS rejected the request (400): ${snippet}`, status);
  if (status === 415) return new LocalTtsError("unsupported-format", `local TTS unsupported format (415): ${snippet}`, status);
  if (status === 429) return new LocalTtsError("network", `local TTS busy (429): ${snippet}`, status);
  return new LocalTtsError("http", `local TTS http ${status}: ${snippet}`, status);
}

async function callSpeech(call: SpeechCall): Promise<{ buf: Buffer; contentType: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), call.timeoutMs);
  try {
    const res = await fetch(`${normalizeBaseUrl(call.baseUrl)}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(call.apiKey ? { authorization: `Bearer ${call.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: call.model || undefined,
        input: call.text,
        voice: call.voice || undefined,
        response_format: call.format,
        speed: 1.0,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw mapHttpError(res.status, body);
    }
    const ab = await res.arrayBuffer();
    return { buf: Buffer.from(ab), contentType: String(res.headers.get("content-type") || "") };
  } catch (e) {
    if (e instanceof LocalTtsError) throw e;
    const msg = String((e as Error)?.message || e);
    if ((e as Error)?.name === "AbortError") {
      throw new LocalTtsError("timeout", `local TTS timed out after ${call.timeoutMs}ms`, 0);
    }
    throw new LocalTtsError("network", `local TTS unreachable: ${msg}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Synthesize one sentence through the local service.
 *
 * Format strategy (plan §3.1): ask for raw PCM first and wrap it here; if the service refuses
 * PCM (400/415) fall back to WAV (header lengths back-filled) and finally to MP3.
 */
export async function synthesizeLocal(opts: LocalSynthOptions): Promise<LocalSynthResult> {
  const text = String(opts.text || "").trim();
  if (!text) throw new LocalTtsError("bad-input", "empty text", 400);
  const sampleRate = Math.max(8000, Math.min(48000, Number(opts.sampleRate) || 24000));
  const requested = (opts.format || "pcm") as LocalFormat;
  const order: LocalFormat[] = requested === "pcm" ? ["pcm", "wav", "mp3"]
    : requested === "wav" ? ["wav", "mp3"]
      : ["mp3"];
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 30000);
  let lastErr: unknown = null;

  for (const format of order) {
    try {
      const { buf, contentType } = await limiter.run(() => callSpeech({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        text,
        voice: opts.voice,
        format,
        sampleRate,
        timeoutMs,
      }));
      if (!buf.length) throw new LocalTtsError("http", "local TTS returned an empty body");
      const isRiff = buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF";
      const looksMp3 = /mpeg|mp3/i.test(contentType) || buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
      if (format === "pcm" && !isRiff) {
        return { buf: pcmToWav(buf, sampleRate), ext: ".wav", contentType: "audio/wav", format: "wav", sampleRate };
      }
      if (isRiff) {
        return { buf: fixWavHeader(buf), ext: ".wav", contentType: "audio/wav", format: "wav", sampleRate };
      }
      if (format === "mp3" || looksMp3) {
        return { buf, ext: ".mp3", contentType: "audio/mpeg", format: "mp3", sampleRate };
      }
      // Unknown container: treat as raw PCM (some OpenAI-compatible shims ignore response_format).
      return { buf: pcmToWav(buf, sampleRate), ext: ".wav", contentType: "audio/wav", format: "wav", sampleRate };
    } catch (e) {
      lastErr = e;
      const err = e as LocalTtsError;
      // Only a format refusal is worth downgrading; readiness/network/voice errors must surface.
      const formatRefusal = err instanceof LocalTtsError
        && (err.code === "unsupported-format"
          || err.status === 415
          || (err.status === 400 && /format|pcm|wav|mp3|codec/i.test(err.message)));
      if (!formatRefusal) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new LocalTtsError("unsupported-format", "no usable audio format");
}

export interface LocalHealth {
  ok: boolean;
  status: string;
  provider?: string;
  providerLabel?: string;
  model?: string;
  model_loaded?: boolean;
  sample_rate?: number;
  supportsClone?: boolean;
  voiceCount?: number;
  idleTimeout?: number;
  rssMb?: number | null;
  rtfLast?: number | null;
  port?: number;
  pid?: number;
  error?: string | null;
}

/** Probe /health (short timeout; callers cache the result — never poll). */
export async function probeLocal(baseUrl: string, timeoutMs = 2500): Promise<LocalHealth | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, timeoutMs));
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as LocalHealth | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the service voice list (used by the settings panel and voice management). */
export async function fetchLocalVoices(baseUrl: string, timeoutMs = 4000): Promise<{
  ok: boolean;
  provider?: string;
  providerLabel?: string;
  supportsClone?: boolean;
  voices: Array<{ id: string; label: string; sample?: string; builtin?: boolean; provider?: string; language?: string }>;
} | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(800, timeoutMs));
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/voices`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
