/**
 * 受理窗口发送（bounded accept window）——POST /api/agent/[id] 的 prompt 族命令
 * 不再同步等整轮结束。
 *
 * 背景：prompt 族的「受理」与「整轮完成」在不同后端差异极大——
 *   - 本地 pi 会话 / CC / qoder / cursor：受理即 resolve（写 stdin / preflight 通过）；
 *   - zcode / codex / acp：send() 要等整轮跑完才 resolve（分钟级）。
 * 第二类把 POST 挂到分钟级，必然撞上 nginx proxy_read_timeout（60s）→ 网关 504，
 * 前端还把 504 误读成「后端正在重启」。而 prompt 的结果本就不靠 POST 响应——
 * 前端发完即走 SSE events 通道（agent_start / message_* / agent_settled）驱动 UI。
 *
 * 语义：窗口内 send 定局（resolve/throw）→ 维持原语义（200/异常进 catch 映射）；
 * 超时仍未决 → 视为已受理（202 {success,accepted,pending}），晚到的失败不再有
 * HTTP 出口，记日志并尽力经 wrapper.emit 补发 prompt_error（pi 词汇，前端已有
 * 消费链路）——与 rpc-manager 异步 prompt 失败、restart-recovery「不 await prompt」
 * 同一收敛模式。
 */

/** 受理窗口只作用于「排队一条消息」语义的命令；其余命令（get_state/set_model/…）
 *  必须同步定局，调用方依赖其返回值。 */
export const PROMPT_FAMILY_TYPES = new Set(["prompt", "steer", "follow_up"]);

/** 窗口取值：同步拒绝（session disposed/stdin closed/capability 缺失）都在毫秒级
 *  抛出，10s 足够把「真失败」和「慢轮次」分开，同时远小于 nginx 60s 网关超时。 */
export const PROMPT_ACCEPT_WINDOW_MS = 10_000;

export type AcceptVerdict =
  | { settled: true; result?: unknown; error?: unknown }
  | { settled: false };

export async function sendWithAcceptWindow(
  wrapper: {
    send(command: Record<string, unknown>): Promise<unknown>;
    /** 受理后晚到失败的补发通道（可选；缺省只记日志）。 */
    emit?(event: Record<string, unknown>): unknown;
  },
  body: Record<string, unknown>,
  windowMs: number = PROMPT_ACCEPT_WINDOW_MS,
): Promise<AcceptVerdict> {
  const sending = wrapper.send(body);
  if (!PROMPT_FAMILY_TYPES.has(String(body.type ?? ""))) {
    try {
      return { settled: true, result: await sending };
    } catch (error) {
      return { settled: true, error };
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const verdict = await Promise.race([
    sending.then(
      (result) => ({ settled: true, result }) as AcceptVerdict,
      (error) => ({ settled: true, error }) as AcceptVerdict,
    ),
    new Promise<AcceptVerdict>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), windowMs);
    }),
  ]);
  clearTimeout(timer);

  if (!verdict.settled) {
    // 吃掉晚到的 rejection（防 unhandledRejection），错误改走事件通道。
    void sending.catch((error) => {
      console.error(
        "[pi-web] prompt accepted (202) but failed afterwards:",
        error instanceof Error ? error.message : error,
      );
      try {
        wrapper.emit?.({
          type: "prompt_error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } catch { /* 补发失败不致命（wrapper 可能已 dispose） */ }
    });
  }
  return verdict;
}
