// aiti-event-bus · 纯内核（零宿主依赖，node --test 直测）
//
// 页面事件总线的两块机制：
//   1. createEventBus —— 多 sink 广播器（帧契约 { type, ...data }，与 core
//      lib/agent-page-events.ts 的 PageFrame 一致）
//   2. installPageEventSlot —— 访问器属性接管全局发布槽（DI 方案 §4-E，
//      docs/pi-web-ext-dependency-injection-plan.md）：
//      - 读取恒得我们的槽（publish = wrapper 双喂：前任 + 本总线）
//      - 赋值（模块再求值/他人重装）被 setter 吸收为「前任更新」——
//        turbopack dev 下 instrumentation 与路由各自求值 agent-page-events、
//        无条件重赋 __piPageEvents，普通「换函数」式接管会被冲掉，本机制免役
//      - restore 守卫：仅当访问器仍是自己装的才卸下并还原前任槽
//
//   （旧版 takeoverPublish 为「直接换函数」式——会被上述重赋值冲掉，已废弃移除。）

export type PageFrame = Record<string, unknown> & { type: string };
export type PublishFn = (type: string, data?: Record<string, unknown>) => void;
export type Sink = (frame: PageFrame) => void;

/** 发布槽对象形态（globalThis.__piPageEvents 及测试桩） */
export interface PublishSlot {
  publish?: PublishFn;
}

export interface EventBus {
  publish: PublishFn;
  addSink: (send: Sink) => () => void;
  readonly sinkCount: number;
}

/**
 * 主题过滤（v0.2 订阅模式，纯函数可直测）：
 * - types === null → 全帧模式（未声明订阅的旧客户端，兼容 v0.1）
 * - 否则白名单：frame.type 命中任一项即投——精确项全等匹配；尾部 `*` 项作前缀通配
 *   （如 `sched:*` 匹配一切 sched: 开头帧，供 type 动态拼接的生产方订阅方使用）。
 *   高频流扩展（aiti-cmd 终端 cmd-<id>）靠它避免无关帧到达订阅方。
 */
export function frameMatches(frame: PageFrame, types: Set<string> | null): boolean {
  if (types === null) return true;
  if (types.has(frame.type)) return true;
  for (const t of types) {
    if (t.length > 1 && t.endsWith("*") && frame.type.startsWith(t.slice(0, -1))) return true;
  }
  return false;
}

export function createEventBus(): EventBus {
  const sinks = new Set<Sink>();
  return {
    publish(type, data = {}) {
      const frame: PageFrame = { type, ...data };
      for (const send of [...sinks]) {
        try { send(frame); } catch { sinks.delete(send); } // 坏 sink 剔除，不拖累其他订阅者
      }
      return frame;
    },
    addSink(send) {
      sinks.add(send);
      return () => { sinks.delete(send); };
    },
    get sinkCount() { return sinks.size; },
  };
}

export interface SlotChain {
  /**
   * 卸下访问器并还原前任槽。仅当访问器仍是自己装的（未被后续接管者替换）才动作。
   * 返回是否真正恢复。
   */
  restore: () => boolean;
  /** 接管时刻捕捉到的前任 publish（供诊断；链式喂帧在 wrapper 内部完成）。 */
  readonly prev: PublishFn | undefined;
}

/**
 * 以访问器属性接管 owner[name] 发布槽：
 *  - get 恒返回稳定 ourSlot（publish = wrapper：先喂当前前任，再喂总线）
 *  - set 吸收后续赋值：`prev` 更新为来者的 publish（模块再求值 / 他人重装都不冲垮链路）
 *  - 前任捕捉：接管时 owner[name] 为数据属性取其值；已是他人访问器则调用其
 *    getter 取当前槽对象（热重载堆叠时链不断）
 */
export function installPageEventSlot(owner: object, name: string, bus: Pick<EventBus, "publish">): SlotChain {
  const startDesc = Object.getOwnPropertyDescriptor(owner, name);
  if (startDesc && !startDesc.configurable) {
    throw new Error(`[aiti-event-bus] 属性 ${String(name)} 不可配置，无法接管`);
  }
  const prevSlot: PublishSlot | undefined = startDesc && "value" in startDesc
    ? (startDesc.value as PublishSlot | undefined)
    : (owner as Record<string, unknown>)[name] as PublishSlot | undefined;
  let prev: PublishFn | undefined = prevSlot?.publish;

  const ourSlot: PublishSlot = {
    publish: (type, data) => {
      try { prev?.(type, data); } catch { /* 前任消费者错误不阻断 */ }
      bus.publish(type, data);
    },
  };
  const getter = function () {
    return ourSlot;
  };
  Object.defineProperty(owner, name, {
    configurable: true,
    enumerable: true,
    get: getter,
    set(v: unknown) {
      // 模块再求值 / 他人重装：吸收为新前任（链路保持，总在wrapper之后喂总线）
      prev = (v && typeof (v as PublishSlot).publish === "function")
        ? (v as PublishSlot).publish
        : undefined;
    },
  });

  return {
    prev,
    restore() {
      const cur = Object.getOwnPropertyDescriptor(owner, name);
      if (!cur || cur.get !== getter) return false; // 已被后来者替换 → 不动（守卫）
      delete (owner as Record<string, unknown>)[name];
      if (prevSlot !== undefined) {
        Object.defineProperty(owner, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: prevSlot,
        });
      }
      return true;
    },
  };
}
