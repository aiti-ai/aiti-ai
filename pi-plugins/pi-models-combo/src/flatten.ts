/**
 * 组合成员×key 扁平化抽取（纯函数、零宿主依赖，便于单测）。
 *
 * 把 models.json 的 combo.members 引用解析并扁平化成代理槽位：
 * 每个槽位 = 一把 key + 各自目标地址（成员上游 + 真实模型）。
 * 与普通多 key provider 唯一的区别是槽位自带目标地址——轮转/冷却/rpm/粘性
 * 全部复用 ProxyServer 既有骨架，不另起代理服务（避免代理套代理）。
 */

import { CONTENT_CLASSES, DEFAULT_SLOT_WEIGHT } from "./proxy.ts";
import { t } from "./i18n.ts";
import { resolveProviderModels, normModelId } from "./effective-models.cjs";

export interface MemberResolutionError { modelId: string; error: string }

/** 扁平化后的组合槽位：一把 key + 各自目标地址（成员上游 + 真实模型）。 */
export type ComboSlot = {
  name: string; key: string; rpm?: number;
  upstream: string; model: string; vision: boolean;
  api: string; group: string; member: string;
  weight: number;
  devRole?: boolean;
  /** 成员承接的请求类别白名单（"text"/"vision"/"other"；未配/空 = 全收，与现状等价） */
  types?: string[];
};

/**
 * 把 models.json 的 combo.members 引用解析并扁平化成代理槽位。
 * 与普通多 key provider 唯一的区别：每个槽位自带目标地址——轮转/冷却/rpm/粘性
 * 全部复用 ProxyServer 既有骨架，不另起代理服务（避免代理套代理）。
 */
export function flattenComboSlots(
  models: any[],
  providers: Record<string, any>,
  normalizeApiKeys: (raw: any[], providerId: string) => { name: string; key: string; rpm?: number }[],
  store?: Record<string, any> | null,
  runtimeModelsOrProviders?: Array<{ provider: string; id: string; api?: string; baseUrl?: string; reasoning?: boolean; input?: string[] }> | Record<string, any> | null,
): { slots: ComboSlot[]; api: string; errors: MemberResolutionError[] } {
  const slots: ComboSlot[] = [];
  const errors: MemberResolutionError[] = [];
  let commonApi = "";
  const seenIds = new Set<string>();

  // 合并运行时注册的 provider 到 providers 中（如 pi-freeflow 的 freeflow provider）
  const mergedProviders = { ...providers };
  if (runtimeModelsOrProviders && typeof runtimeModelsOrProviders === "object") {
    // 处理两种格式：数组（模型列表）或对象（provider 配置映射）
    if (Array.isArray(runtimeModelsOrProviders)) {
      // 格式1: 数组 - 从模型列表构建 provider
      const runtimeByPid = new Map<string, any[]>();
      for (const rm of runtimeModelsOrProviders) {
        if (!rm.provider) continue;
        if (!runtimeByPid.has(rm.provider)) runtimeByPid.set(rm.provider, []);
        runtimeByPid.get(rm.provider)!.push(rm);
      }
      for (const [pid, rtModels] of runtimeByPid) {
        if (mergedProviders[pid]) continue; // 已有定义则跳过
        mergedProviders[pid] = {
          name: pid,
          api: rtModels[0]?.api || "openai-completions",
          baseUrl: rtModels[0]?.baseUrl || "",
          apiKey: "runtime-registered",
          models: rtModels.map((m) => ({
            id: m.id,
            api: m.api || "openai-completions",
            baseUrl: m.baseUrl || "",
            reasoning: !!m.reasoning,
            input: m.input || [],
          })),
          _runtimeRegistered: true,
        };
      }
    } else {
      // 格式2: 对象 - 直接是 provider 配置映射
      for (const [pid, pCfg] of Object.entries(runtimeModelsOrProviders)) {
        if (mergedProviders[pid]) continue; // 已有定义则跳过
        mergedProviders[pid] = { ...pCfg, _runtimeRegistered: true };
      }
    }
  }

  for (const md of models) {
    const spec = md?.combo;
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.members) || spec.members.length === 0) continue;
    const id = String(md.id || "");
    if (!id) { errors.push({ modelId: "(无 id)", error: "模型缺 id" }); continue; }
    if (seenIds.has(id)) { errors.push({ modelId: id, error: "重复的组合模型 id" }); continue; }
    // 虚拟模型级禁用（enabled:false）：临时停用不删除——整个模型不参与
    if (md.enabled === false) continue;
    seenIds.add(id);

    // 任一成员失败 → 整个模型的槽位全部不收（严禁部分组合上线）
    let failed = false;
    const modelSlots: ComboSlot[] = [];
    const fail = (error: string) => { errors.push({ modelId: id, error }); failed = true; };
    const resolved = resolveProviderModels({ providers: mergedProviders, store: store || null });
    const seenMembers = new Set<string>();
    for (const ref of spec.members) {
      const pid = String(ref?.provider || "");
      const mid = String(ref?.model || "");
      // 成员引用级禁用（enabled:false）：临时停用不删除——跳过该成员，其余成员照常组队
      if (ref?.enabled === false) continue;
      if (seenMembers.has(`${pid}/${mid}`)) {
        // 冗余配置：仅忽略该成员（不叠加权重/槽位），不影响整个模型
        console.warn(t("combo.dupRef", { id, ref: `${pid}/${mid}` }));
        continue;
      }
      seenMembers.add(`${pid}/${mid}`);
      // 生效模型清单（显式 models > pi 模型 store 补全）——工作区共享实现（vendored 副本，勿改）
      const pcfg = mergedProviders[pid];
      if (!pcfg || pcfg.combo === true) {
        fail(`成员 provider 不存在或非法: ${pid}`); continue;
      }
      // 成员 provider 被禁用（enabled:false）→ 临时停用不删除：跳过该成员（不 fail 整个虚拟模型）
      if (pcfg.enabled === false) continue;
      const entry = resolved.get(pid);
      if (!entry || entry.models.length === 0) {
        fail(`成员模型清单为空: ${pid}`); continue;
      }
      const nmId = normModelId(mid);
      const mdef = entry.models.find((x) => normModelId(x.id) === nmId);
      if (!mdef || mdef.combo) {
        fail(`成员模型不存在: ${pid}/${mid}`); continue;
      }
      // 成员模型级禁用（models[i].enabled === false）→ 临时停用不删除：跳过该成员（与 provider 级禁用独立）
      if (mdef.enabled === false) continue;
      const api = mdef.api;
      if (!commonApi) commonApi = api;
      else if (api !== commonApi) {
        fail(`跨协议成员（${commonApi} vs ${api}: ${pid}/${mid}）—— v1 仅支持同协议组合`); continue;
      }
      const upstream = String(mdef.baseUrl || entry.baseUrl || "");
      if (!upstream) {
        fail(`成员无 baseUrl: ${pid}/${mid}`); continue;
      }
      // 成员 key 池：apiKeys 优先，回退单 apiKey；combo provider 自己的 key 不参与
      let keys: Array<{ name: string; key: string; rpm?: number; minIntervalMs?: number }> = [];
      if (Array.isArray(pcfg.apiKeys) && pcfg.apiKeys.length > 0) {
        keys = normalizeApiKeys(pcfg.apiKeys, pid).map((e) => ({ name: `${pid}/${e.name}`, key: e.key, rpm: e.rpm, minIntervalMs: e.minIntervalMs }));
      } else if (typeof pcfg.apiKey === "string" && pcfg.apiKey) {
        keys = [{ name: `${pid}/primary`, key: pcfg.apiKey }];
      }
      if (keys.length === 0) {
        fail(`成员无可用 key: ${pid}/${mid}`); continue;
      }
      const vision = mdef.input.includes("image");
      // 成员 supportsDeveloperRole（代理按模型 compat 决定 developer→system 改写用）：
      // 模型级 compat 优先，回退 provider 级；无显式值则 undefined（不参与改写判定）。
      const rawMdef = (Array.isArray(pcfg.models) ? pcfg.models : []).find((x: any) => x && typeof x === "object" && normModelId(x.id ?? x.model) === nmId);
      const memberDev = rawMdef?.compat?.supportsDeveloperRole !== undefined ? rawMdef.compat.supportsDeveloperRole
        : pcfg.compat?.supportsDeveloperRole;
      const devRole = typeof memberDev === "boolean" ? memberDev : undefined;
      // 成员权重：默认 10；初始选点/切换重选时按权重占比随机（排序+累计区间+随机数落点）。
      // 权重是成员级语义：各槽位都带完整成员权重，代理端按成员分组加权（多 key 不放大占比）
      let weight = DEFAULT_SLOT_WEIGHT;
      const wRaw = (ref as any)?.weight;
      if (wRaw != null && wRaw !== "") {
        const w = Number(wRaw);
        // 上限 1e9：防极端值令累计总权重溢出为 Infinity（加权随机静默退化）
        if (Number.isFinite(w) && w >= 1 && w <= 1e9) weight = w;
        else console.warn(t("combo.badWeight", { id, member: `${pid}/${mid}`, v: wRaw, d: DEFAULT_SLOT_WEIGHT }));
      }
      // 成员承接类别（types）：白名单数组，未配/空 = 全收（现状行为）。非法值过滤 + 警告。
      let types: string[] | undefined;
      const rawTypes = (ref as any)?.types;
      if (Array.isArray(rawTypes) && rawTypes.length > 0) {
        const valid = rawTypes.filter((x: any) => CONTENT_CLASSES.includes(String(x)));
        const bad = rawTypes.filter((x: any) => !CONTENT_CLASSES.includes(String(x)));
        if (bad.length > 0) console.warn(t("combo.badTypes", { id, member: `${pid}/${mid}`, v: bad.join(",") }));
        if (valid.length > 0) types = [...new Set(valid)];
      }
      // types 含 vision 但模型 input 未声明 image → warn（带图请求仍会被能力过滤排除，声明永不生效）
      if (types?.includes("vision") && !vision) {
        console.warn(t("combo.visionNoCap", { id, member: `${pid}/${mid}` }));
      }
      for (const k of keys) {
        modelSlots.push({
          name: k.name, key: k.key, rpm: k.rpm, minIntervalMs: k.minIntervalMs,
          upstream, model: mid, vision, api,
          group: id, member: `${pid}/${mid}`,
          weight, devRole,
          ...(types ? { types } : {}),
        });
      }
    }
    // 成员全部被禁用/跳过 → 该虚拟模型无槽位：记 error（配置保留，临时禁用；引擎不构建）
    if (!failed && modelSlots.length === 0) {
      errors.push({ modelId: id, error: "虚拟模型的所有成员已禁用（enabled:false）——需至少保留一个启用的成员" });
      continue;
    }
    if (!failed && modelSlots.length > 0) slots.push(...modelSlots);
  }
  return { slots, api: commonApi, errors };
}