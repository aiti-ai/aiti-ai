import { randomUUID } from "node:crypto";
import type {
  InteractionAnswerInput,
  InteractionAnswerOutcome,
  InteractionBrokerEvent,
  InteractionBrokerListener,
  InteractionBrokerOptions,
  InteractionRequest,
  InteractionRequestInput,
  InteractionResult,
  InteractionState,
  InteractionStatus,
  OpenedInteraction,
} from "./types.ts";

interface Entry {
  request: InteractionRequest;
  result: InteractionResult;
  resolve: (result: InteractionResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  done: boolean;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeRequest(input: InteractionRequestInput, id: string, now: number, defaultTimeoutMs: number): InteractionRequest {
  const timeoutValue = input.timeoutMs ?? defaultTimeoutMs;
  const options = (input.options || []).map((option) => typeof option === "string" ? { id: option, label: option } : { ...option });
  const state: InteractionState = input.state ? { ...input.state } : {};
  return {
    id,
    version: 1,
    kind: input.kind,
    title: String(input.title || ""),
    message: String(input.message || ""),
    detail: String(input.detail || ""),
    options,
    actions: Array.isArray(input.actions) ? input.actions.map((action) => ({ ...action })) : [],
    input: { ...(input.input || {}) },
    pick: { ...(input.pick || {}) },
    custom: { ...(input.custom || {}) },
    timeoutMs: Math.max(0, Number.isFinite(Number(timeoutValue)) ? Number(timeoutValue) : 0),
    keepOpen: input.keepOpen === true,
    data: input.data,
    state,
    agent: input.agent ? { ...input.agent } : undefined,
    createdAt: new Date(now).toISOString(),
  };
}

/**
 * Host-owned interaction broker.
 *
 * `ask()` returns a Promise that resolves when a page submits a final answer, a
 * timeout fires, or the host cancels. `open()` exposes the same request with its
 * result Promise for custom/keep-open UI.
 */
export class InteractionBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<InteractionBrokerListener>();
  private readonly defaultTimeoutMs: number;
  private readonly idFactory: () => string
  private readonly now: () => number;
  private closed = false;

  constructor(options: InteractionBrokerOptions = {}) {
    this.defaultTimeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    this.idFactory = options.idFactory || (() => `int_${randomUUID()}`);
    this.now = options.now || (() => Date.now());
  }

  /** Create a request and wait for its final result. */
  ask(input: InteractionRequestInput): Promise<InteractionResult> {
    return this.open(input).result;
  }

  /** Create a request and return its id/request/result without awaiting. */
  open(input: InteractionRequestInput): OpenedInteraction {
    if (this.closed) throw new Error("interaction broker is closed");
    const id = this.idFactory();
    const request = normalizeRequest(input, id, this.now(), this.defaultTimeoutMs);
    let resolve!: (result: InteractionResult) => void;
    const result = new Promise<InteractionResult>((r) => { resolve = r; });
    const entry: Entry = {
      request,
      result: {
        id,
        status: "answered",
        action: undefined,
        value: undefined,
        comment: undefined,
        reason: undefined,
        state: {},
        tookMs: 0,
        timeoutMs: request.timeoutMs,
      },
      resolve,
      timer: null,
      startedAt: this.now(),
      done: false,
    };
    this.entries.set(id, entry);
    if (request.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        this.finish(entry, {
          ...entry.result,
          status: "timeout",
          reason: "timeout",
          tookMs: this.now() - entry.startedAt,
        });
      }, request.timeoutMs);
    }
    this.emit({ type: "request", request: clone(request) });
    return { id, request: clone(request), result };
  }

  /** Submit an answer from a renderer. Late/duplicate answers are rejected. */
  answer(id: string, input: InteractionAnswerInput = {}): InteractionAnswerOutcome {
    const entry = this.entries.get(String(id));
    if (!entry || entry.done) {
      return { ok: false, code: "not_found", error: "no pending interaction with that id" };
    }
    const state = { ...(entry.request.state || {}), ...(input.state || {}) };
    if (input.keepOpen === true) {
      entry.request.state = state;
      state.lastAction = input.action;
      if (input.value !== undefined) state.value = input.value;
      this.emit({ type: "update", id: entry.request.id, request: clone(entry.request), state: clone(state) });
      return { ok: true, code: "keep_open", keepOpen: true, state: clone(state) };
    }
    const status: InteractionStatus = input.action === "cancel" ? "cancelled" : "answered";
    const result: InteractionResult = {
      id: entry.request.id,
      status,
      action: input.action,
      approved: input.approved,
      value: input.value,
      comment: input.comment,
      reason: input.reason,
      state,
      tookMs: this.now() - entry.startedAt,
      timeoutMs: entry.request.timeoutMs,
    };
    this.finish(entry, result);
    return { ok: true, result };
  }

  /** Host-only state update for custom/keep-open UI. */
  update(id: string, state: InteractionState): boolean {
    const entry = this.entries.get(String(id));
    if (!entry || entry.done) return false;
    entry.request.state = { ...(entry.request.state || {}), ...state };
    this.emit({ type: "update", id: entry.request.id, request: clone(entry.request), state: clone(entry.request.state) });
    return true;
  }

  /** Host-only final resolution (used by custom/keep-open flows). */
  resolve(id: string, result: Partial<Omit<InteractionResult, "id" | "tookMs" | "timeoutMs">> = {}): boolean {
    const entry = this.entries.get(String(id));
    if (!entry || entry.done) return false;
    this.finish(entry, {
      id: entry.request.id,
      status: result.status || "answered",
      action: result.action,
      approved: result.approved,
      value: result.value,
      comment: result.comment,
      reason: result.reason,
      state: result.state || entry.request.state,
      tookMs: this.now() - entry.startedAt,
      timeoutMs: entry.request.timeoutMs,
    });
    return true;
  }

  /** Host-only cancellation. */
  cancel(id: string, reason = "cancelled"): boolean {
    const entry = this.entries.get(String(id));
    if (!entry || entry.done) return false;
    this.finish(entry, {
      ...entry.result,
      status: "cancelled",
      reason,
      tookMs: this.now() - entry.startedAt,
    });
    return true;
  }

  /** Snapshot of all pending requests, oldest first. */
  pending(): InteractionRequest[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.done)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((entry) => clone(entry.request));
  }

  has(id: string): boolean {
    return !!this.entries.get(String(id));
  }

  /** SSE/browser subscription. The initial snapshot is delivered synchronously. */
  subscribe(listener: InteractionBrokerListener): () => void {
    this.listeners.add(listener);
    try { listener({ type: "snapshot", requests: this.pending() }); } catch { /* listener errors must not break the broker */ }
    return () => this.listeners.delete(listener);
  }

  /** Close all pending requests and reject future requests. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.entries.values()]) {
      this.finish(entry, {
        ...entry.result,
        status: "cancelled",
        reason: "broker closed",
        tookMs: this.now() - entry.startedAt,
      });
    }
    this.listeners.clear();
  }

  private finish(entry: Entry, result: InteractionResult): void {
    if (entry.done) return;
    entry.done = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.entries.delete(entry.request.id);
    entry.resolve(result);
    this.emit({ type: "resolved", id: entry.request.id, result });
  }

  private emit(event: InteractionBrokerEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* isolate renderer subscribers */ }
    }
  }
}
