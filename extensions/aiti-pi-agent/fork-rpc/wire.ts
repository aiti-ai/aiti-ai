/**
 * wire.ts — JSONL RPC 线协议宿主（载体无关）。
 *
 * 拆自 aiti-pi-agent 的 pi-rpc-spawn.ts：子进程管理 / request-response id 关联 /
 * 事件扇出 / 死亡上报 + extension_ui_request ⇄ interaction_request 帧桥接。
 * 本层**不含任何 fork 语义**（命令映射 / 能力面 / 生命周期收口由各扩展 handle 负责）。
 */

import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** 缺省单行字节上限（MCP stdio transport 同款 10MB）：无换行的超长行视为子进程失控。 */
export const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;

/** 控制面命令缺省超时（get_state/set_model/… 等快命令；prompt/compact/bash 等长轮次命令不设）。 */
export const RPC_CTRL_TIMEOUT_MS = 30_000;

export interface LineReaderOptions {
  /** 单行字节上限（换行前累积量），超出触发 onOverflow 并停止处理后续数据。缺省 10MB。 */
  maxLineBytes?: number;
  /** 行超限回调（宿主侧应 markDead——协议流已不可信）。 */
  onOverflow?: (size: number) => void;
}

/**
 * 逐行读取 stdout 流（JSONL）；返回取消函数。
 * 字节累积、按 `\n` 切 Buffer 后整行 utf8 解码（MCP ReadBuffer 同款）——
 * 逐 chunk `Buffer.toString` 会把跨 chunk 的多字节字符解码成 U+FFFD（中文必踩）。
 */
export function lineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  opts?: LineReaderOptions,
): () => void {
  const maxLineBytes = opts?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const onOverflow = opts?.onOverflow;
  let buf: Buffer = Buffer.alloc(0);
  let overflowed = false;
  const onData = (c: Buffer | string) => {
    if (overflowed) return;
    const chunk = typeof c === "string" ? Buffer.from(c, "utf8") : c;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    let idx: number;
    while ((idx = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, idx).toString("utf8").trim();
      buf = buf.subarray(idx + 1);
      if (line) onLine(line);
    }
    if (buf.length > maxLineBytes) {
      overflowed = true;
      onOverflow?.(buf.length);
    }
  };
  stream.on("data", onData);
  return () => {
    stream.off("data", onData);
  };
}

export type HostEventListener = (event: Record<string, unknown>) => void;

interface PendingRequest {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer?: NodeJS.Timeout;
}

/**
 * 载体无关的 RPC 子进程宿主：
 *   - 进程管理（stdin 写帧 / stdout 逐行读 / stderr 日志 / exit·error 杀尾）
 *   - request id 关联（command 附带 `id`，`response` 帧按 id 回拨；控制面命令可带超时）
 *   - 事件扇出（非 response 帧 → onFrame 分发给子类 → emit 给监听者；逐监听器异常隔离）
 *   - 死亡上报（session_backend_dead）
 *
 * 子类通过覆写 onFrame 注入语义（extension_ui / host_tool / ready 握手 / 状态帧…），
 * 通过 protected request / writeRaw 发命令。
 */
export class RpcChildHost {
  protected child: ChildProcess;
  protected pending = new Map<string, PendingRequest>();
  protected seq = 0;
  protected aliveFlag = true;
  private listeners = new Set<HostEventListener>();
  private detachReader: (() => void) | null = null;

  constructor(child: ChildProcess, opts?: { maxLineBytes?: number }) {
    this.child = child;
    this.detachReader = lineReader(child.stdout!, (line) => this.dispatchLine(line), {
      ...(opts?.maxLineBytes ? { maxLineBytes: opts.maxLineBytes } : {}),
      onOverflow: (size) => this.markDead(`stdout line overflow (${size} bytes > ${opts?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES})`),
    });
    const stderrDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (c: Buffer | string) => {
      const text = (typeof c === "string" ? c : stderrDecoder.write(c)).trim();
      if (text) console.log(`[rpc-child] ${text.slice(0, 500)}`);
    });
    // 三个流都必须挂 error 监听：子进程被杀/管道断裂时流上抛 ECONNRESET/EPIPE，
    // 没有监听器 = unhandled 'error' event = 宿主进程崩溃（MCP stdio transport 同款防御）。
    child.stdout?.on("error", (err: Error) => this.markDead(`stdout error: ${err.message}`));
    child.stderr?.on("error", (err: Error) => console.log(`[rpc-child] stderr error: ${err.message}`));
    child.stdin?.on("error", (err: Error) => console.log(`[rpc-child] stdin error: ${err.message}`));
    child.once("exit", (code) => this.markDead(`process exited (${code ?? "signal"})`));
    child.once("error", (err) => this.markDead(`process error: ${err.message}`));
  }

  emit(event: Record<string, unknown>): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        // 逐监听器隔离：一个订阅者抛错不得漏帧给其余订阅者，更不得沿流 data 回调裸抛崩进程
        console.error(`[rpc-child] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  subscribe(listener: HostEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 发命令并挂 id 关联（写 stdin；帧的 id 由本方法追加，勿重复传）。
   *  opts.timeoutMs：可选超时（控制面快命令用；prompt/compact/bash 等长轮次命令不设——
   *  超时仅解除 pending 并 reject，不影响子进程继续跑）。 */
  protected request<T = unknown>(command: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
    if (!this.aliveFlag || !this.child.stdin?.writable) {
      return Promise.reject(new Error("[rpc-child] not running"));
    }
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { resolve: resolve as (v: unknown) => void, reject };
      const timeoutMs = opts?.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`[rpc-child] timeout: ${String(command.type ?? "?")} after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pending.timer = timer;
      }
      this.pending.set(id, pending);
      try {
        this.child.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new Error(`[rpc-child] write failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /** 原样写帧（不回显追加 request id）——host_tool_result 等须回显请求帧的 id。 */
  protected writeRaw(frame: Record<string, unknown>): void {
    if (!this.aliveFlag || !this.child.stdin?.writable) return;
    try {
      this.child.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      // 写失败（子进程刚死）：exit 事件会收尸 markDead
    }
  }

  /** 行分发：response 按 id 回拨；其余交给子类 onFrame。 */
  protected dispatchLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "response" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.success === true) p.resolve(msg.data);
      else p.reject(new Error(String(msg.error ?? "request failed")));
      return;
    }
    try {
      this.onFrame(msg);
    } catch (e) {
      // 子类 onFrame 异常同样不得沿流 data 回调裸抛（emit 已隔离，此处兜子类自身逻辑）
      console.error(`[rpc-child] onFrame error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 子类覆写：非 response 帧的语义分发（默认原样透传 emit）。 */
  protected onFrame(_msg: Record<string, unknown>): void {
    this.emit(_msg);
  }

  protected markDead(reason: string): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.detachReader?.();
    this.detachReader = null;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`[rpc-child] dead: ${reason}`));
    }
    this.pending.clear();
    this.emit({ type: "session_backend_dead", reason });
  }
}

// ============================================================================
// 子进程收尾（dispose 共用）
// ============================================================================

/** 子进程收尾：SIGTERM → graceMs（缺省 1s）→ SIGKILL → destroy 三流（释放句柄/事件循环；
 *  MCP stdio transport 同款阶梯 + 清理）。已死进程直接跳过信号、仅清流。幂等可重入。 */
export async function shutdownChild(child: ChildProcess, graceMs = 1_000): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); } catch { /* 已死容错 */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* 已死容错 */ }
        resolve();
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

// ============================================================================
// extension_ui_request ⇄ interaction_request 桥接（通用帧转换，无 fork 语义）
// ============================================================================

/** fork 子进程 extension_ui_request 帧（select/confirm/input/editor/notify/...）。 */
export interface ExtensionUIRequest extends Record<string, unknown> {
  type: "extension_ui_request";
  id: string;
  method: string;
}

/** 需要用户作答、要挂 pending 等响应的 UI 方法（其余为单向通知，透传即可）。 */
export const UI_METHODS_NEEDING_ANSWER = new Set(["select", "confirm", "input", "editor"]);

/**
 * 把 extension_ui_request 投影为 pi-web 统一 interaction_request 事件
 * （lib/session/types.ts InteractionRequestEvent）。
 *   select/confirm/input → kind "ask_user"（标准问题卡渲染）；
 *   open_url → kind "open_url"（OAuth 登录专用卡：url/launchUrl 字段，单向无需作答）；
 *   其余（editor/notify/setStatus/...）→ kind "generic"（原始帧进 input）。
 */
export function toInteractionRequest(req: ExtensionUIRequest): Record<string, unknown> {
  const method = req.method;
  if (method === "open_url") {
    // fork 真实帧：{url, launchUrl, instructions}（instructions = 给用户的操作说明）
    const promptText = [req.title, req.instructions].find((s) => typeof s === "string");
    return {
      type: "interaction_request",
      requestId: req.id,
      kind: "open_url",
      toolName: "extension_ui.open_url",
      ...(promptText ? { prompt: promptText } : {}),
      ...(typeof req.url === "string" ? { url: req.url } : {}),
      ...(typeof req.launchUrl === "string" ? { launchUrl: req.launchUrl } : {}),
      input: req,
    };
  }
  if (method === "select") {
    const options = Array.isArray(req.options) ? req.options : [];
    const details = Array.isArray(req.optionDetails) ? req.optionDetails : [];
    return {
      type: "interaction_request",
      requestId: req.id,
      kind: "ask_user",
      toolName: "extension_ui.select",
      prompt: typeof req.title === "string" ? req.title : undefined,
      questions: [
        {
          question: typeof req.title === "string" ? req.title : "Select an option",
          options: options.map((o, i) => ({
            label: String(o),
            ...(typeof (details[i] as { description?: unknown })?.description === "string"
              ? { description: (details[i] as { description: string }).description }
              : {}),
          })),
        },
      ],
      input: req,
    };
  }
  if (method === "confirm") {
    return {
      type: "interaction_request",
      requestId: req.id,
      kind: "ask_user",
      toolName: "extension_ui.confirm",
      prompt: typeof req.title === "string" ? req.title : undefined,
      questions: [
        {
          question: [req.title, req.message].filter((s) => typeof s === "string").join("\n") || "Confirm?",
          options: [{ label: "确认" }, { label: "取消" }],
        },
      ],
      input: req,
    };
  }
  if (method === "input") {
    return {
      type: "interaction_request",
      requestId: req.id,
      kind: "ask_user",
      toolName: "extension_ui.input",
      prompt: typeof req.title === "string" ? req.title : undefined,
      questions: [{ question: typeof req.title === "string" ? req.title : "Input" }],
      input: req,
    };
  }
  return {
    type: "interaction_request",
    requestId: req.id,
    kind: "generic",
    toolName: `extension_ui.${method}`,
    input: req,
  };
}

/**
 * 把用户作答（InteractionAnswer）编回 extension_ui_response 帧
 * （omp RpcExtensionUIResponse：{value} | {confirmed} | {cancelled:true}）。
 * 返回 null 表示该请求无需作答（单向通知类）。
 */
export function toExtensionUIResponse(
  req: ExtensionUIRequest,
  answer: { action: "accept" | "decline"; answers?: Record<string, string | string[]>; message?: string },
): Record<string, unknown> | null {
  const method = req.method;
  if (method === "select") {
    if (answer.action === "decline") return { type: "extension_ui_response", id: req.id, cancelled: true };
    const q = typeof req.title === "string" ? req.title : "Select an option";
    const v = answer.answers?.[q];
    return v === undefined
      ? { type: "extension_ui_response", id: req.id, cancelled: true }
      : { type: "extension_ui_response", id: req.id, value: Array.isArray(v) ? v[0] : v };
  }
  if (method === "input" || method === "editor") {
    if (answer.action === "decline") return { type: "extension_ui_response", id: req.id, cancelled: true };
    const q = typeof req.title === "string" ? req.title : method === "input" ? "Input" : "";
    const v = answer.answers?.[q];
    const value = (Array.isArray(v) ? v[0] : v) ?? answer.message ?? "";
    return { type: "extension_ui_response", id: req.id, value };
  }
  if (method === "confirm") {
    if (answer.action === "decline") return { type: "extension_ui_response", id: req.id, cancelled: true };
    // select 卡渲染的确认/取消：按所选 label 判断；accept + 未选「取消」= confirmed
    const q = [req.title, req.message].filter((s) => typeof s === "string").join("\n") || "Confirm?";
    const v = answer.answers?.[q];
    const picked = Array.isArray(v) ? v[0] : v;
    // 防御（fail-closed）：answers 非空但未命中问题 key（title 渲染漂移等）→ 视为未确认；
    // 完全无 answers（前端批准按钮路径）保持 confirmed:true，不破坏既有契约。
    const hasAnswers = !!answer.answers && Object.keys(answer.answers).length > 0;
    const confirmed = picked !== undefined ? picked !== "取消" : !hasAnswers;
    return { type: "extension_ui_response", id: req.id, confirmed };
  }
  return null; // notify/setStatus/setWidget/setTitle/open_url/... 单向，无需响应
}