// 消息信封（__dbg 协议标记）
export function dbgMsg(extra) { return { __dbg: 1, ...extra }; }
