/**
 * service-tunnels 注入注册点 —— 任意扩展可注册「HTML 响应注入片段」。
 *
 * 机制（软依赖：无注册者时零开销，行为不变）：
 *   globalThis.__stInjectRegistry = {
 *     register(id, provider)  → 注销函数（dispose）
 *     providers(): Map<id, provider>
 *   }
 *
 * provider 契约（软字段）：
 *   {
 *     label: string           // UI 显示名（如 "AITI 调试器"）
 *     scriptFor(port, url, method) → string | { html, position? } | null
 *     // 返回 null = 该端口不注入；多注册者各自独立判定，各自结果都注入
 *   }
 *
 * 兼容：旧 __aitiInject（aiti-devtools 单实例注册）自动包装为 id="aiti-devtools"
 * 的 provider —— aiti-devtools 不改代码也能继续工作；新代码应改用 registry。
 *
 * 端口登记（vhost 可达 + basePath）归 service-tunnels 自管：
 *   GET  /api/extensions/service-tunnels/inject-ports → { ports: [{port, basePath?}] }
 *   PUT  同路径 { ports } → 保存 + 同步 open binding（enroll/unenroll）
 * （原 aiti-devtools 的 inject-ports API 保留转发，数据迁移见下）
 */
declare global {
  var __stInjectRegistry: StInjectRegistry | undefined;
  /** @deprecated 旧单实例注册（兼容包装）；新代码用 __stInjectRegistry.register */
  var __aitiInject: unknown;
}

export interface StInjectResult {
  html: string;
  position?: "head" | "prepend";
}

export interface StInjectProvider {
  /** UI 显示名 */
  label: string;
  /** 用途说明（配置 UI 里显示，告知用户这是哪个扩展/干什么用） */
  description?: string;
  /** 该请求是否注入及注入内容（null = 不注入） */
  scriptFor(port: number, url: string, method: string): string | StInjectResult | null;
}

export interface StInjectRegistry {
  /** 注册注入源；返回注销函数。重复 id 覆盖（热重载语义）。 */
  register(id: string, provider: StInjectProvider): () => void;
  /** 全部注册者 */
  providers(): Map<string, StInjectProvider>;
}

export function getInjectRegistry(): StInjectRegistry {
  if (!globalThis.__stInjectRegistry) {
    const providers = new Map<string, StInjectProvider>();
    globalThis.__stInjectRegistry = {
      register(id, provider) {
        providers.set(id, provider);
        return () => { providers.delete(id); };
      },
      providers: () => { sync(); return providers; },
    };
    // 兼容桥：旧 __aitiInject 赋值时自动包装成 registry provider。
    // 注意：aiti-devtools shutdown 会 delete globalThis.__aitiInject（删掉属性时
    // defineProperty 拦截器一并消失）——因此不能只靠拦截，每次读注册表时
    // 都要比对当前引用（syncAitiBridge），delete/重赋值都能跟上。
    let bridged: unknown = undefined;
    try { bridged = (globalThis as Record<string, unknown>).__aitiInject; } catch { /* ignore */ }
    // 创建时直接注册当前值（sync 靠引用比对跳过相等，不会补注册首次值）
    if (bridged && typeof (bridged as Record<string, unknown>).scriptFor === "function") {
      providers.set("aiti-devtools", bridged as unknown as StInjectProvider);
    }
    const sync = () => {
      let v: unknown = undefined;
      try { v = (globalThis as Record<string, unknown>).__aitiInject; } catch { return; }
      if (v === bridged) return;
      bridged = v;
      if (v && typeof (v as Record<string, unknown>).scriptFor === "function") {
        providers.set("aiti-devtools", v as unknown as StInjectProvider);
      } else {
        providers.delete("aiti-devtools");
      }
    };
    // 注册表读取前的同步钩子（aggregateInjections / /status 调用）
    (globalThis.__stInjectRegistry as unknown as { __syncAiti?: () => void }).__syncAiti = sync;
    // 辅助拦截（不依赖：同步钩子兜底；reload 后 delete 消失也能工作）
    Object.defineProperty(globalThis, "__aitiInject", {
      configurable: true,
      get: () => bridged,
      set: (v) => { bridged = v; sync(); },
    });
  }
  return globalThis.__stInjectRegistry;
}

/** 读注册表前同步兼容桥（旧 __aitiInject 可能被 reload delete/重赋值）。 */
function syncAitiBridge(): void {
  const reg = globalThis.__stInjectRegistry as (StInjectRegistry & { __syncAiti?: () => void }) | undefined;
  try { reg?.__syncAiti?.(); } catch { /* ignore */ }
}

/** middleware/transformResponse 共用：聚合所有注册者的注入片段。
 *  多注册者各自返回的片段全部注入（prepend 拼接在前、head 拼接在后），
 *  两者可同时存在——返回 { prepend?, head? } 两段，由调用方分别插入。
 *  （旧单段契约的调用方用 resolveInjection 取兼容结果：prepend 优先。） */
export function aggregateInjections(
  port: number,
  url: string,
  method: string,
  /** 允许注入的源 id 白名单（该公开通道配置的注入；缺省 = 全部） */
  allowedIds?: string[],
): { prepend?: string; head?: string } | null {
  syncAitiBridge();
  const reg = globalThis.__stInjectRegistry;
  if (!reg) return null;
  const prependParts: string[] = [];
  const headParts: string[] = [];
  for (const [id, provider] of reg.providers().entries()) {
    if (allowedIds && !allowedIds.includes(id)) continue;
    if (typeof provider.scriptFor !== "function") continue;
    let r: string | StInjectResult | null = null;
    try { r = provider.scriptFor(port, url, method); } catch { continue; }
    if (!r) continue;
    if (typeof r === "string") headParts.push(r);
    else if (r.position === "prepend") prependParts.push(r.html);
    else headParts.push(r.html);
  }
  const out: { prepend?: string; head?: string } = {};
  if (prependParts.length) out.prepend = prependParts.join("\n");
  if (headParts.length) out.head = headParts.join("\n");
  return out.prepend || out.head ? out : null;
}

/** 聚合结果 → 旧单段契约（prepend 优先，无则 head；tunnel nginx 注入兼容）。 */
export function resolveInjection(
  r: { prepend?: string; head?: string } | null,
): { html: string; position: "head" | "prepend" } | null {
  if (!r) return null;
  if (r.prepend) return { html: r.prepend, position: "prepend" };
  if (r.head) return { html: r.head, position: "head" };
  return null;
}
