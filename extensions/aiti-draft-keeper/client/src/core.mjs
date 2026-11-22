/**
 * DraftKeeperCore —— 草稿状态机纯逻辑（唯一所有者）。
 *
 * 设计（composer 契约的收敛）：core（pi-web）只发意图（applyIntent）；
 * 用户输入/清空经 enhancement 回调（onChange/onKeyChange）进同一状态机。
 * 所有槽位读/写/清/搬在本状态机单一顺序内完成——消除此前 core 直接
 * clearDraft/rekeyDraft 与 keeper onChange 清空链交错产生的竞态窗口
 * （已发送消息残留进 crashrestore-<sid>、「切换丢草稿」等均源于此）。
 *
 * 注入依赖（可测性）：
 *   storage  {getItem,setItem,removeItem,keys()}       槽位持久层
 *   timers   {setTimeout,clearTimeout}                 延时（测试可注入假钟）
 *   onRestore(draft) => boolean                        写框回调（壳负责 hydration 门控）
 *   log(msg)                                           调试
 *   delays   {flushMs,scanMs,clearConfirmMs}           各延时（测试调小）
 */

const PREFIX = "crashrestore-";

// ---------- 编码 ----------

export function encodeDraft(draft, encoder) {
  const bytes = encoder.encode(JSON.stringify(draft));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeSlot(raw, decoder) {
  try {
    let ts = 0, b64 = raw;
    const idx = raw.indexOf(":");
    if (idx > 0) { const head = Number(raw.slice(0, idx)); if (Number.isFinite(head)) { ts = head; b64 = raw.slice(idx + 1); } }
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const d = JSON.parse(decoder.decode(bytes));
    if (typeof d?.value !== "string") return null;
    return {
      ts,
      draft: {
        value: d.value,
        images: Array.isArray(d.images) ? d.images.filter((im) => im && typeof im.data === "string" && typeof im.mimeType === "string") : [],
      },
    };
  } catch { return null; }
}

/** 现有草稿与失败提交合并：提交在前、原稿在后（原样重复则不重复加）。 */
export function mergeSubmission(text, images, curText, curImages) {
  const value = curText && !curText.includes(text) ? `${text}\n\n${curText}` : text;
  const mergedImages = [...(images ?? []), ...(curImages ?? [])].slice(0, 10);
  return { value, images: mergedImages };
}

// ---------- 状态机 ----------

export function createKeeperCore(opts) {
  const {
    storage,
    timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (t) => globalThis.clearTimeout(t) },
    onRestore = () => false,
    log = () => {},
    delays = {},
    textEncoder = new TextEncoder(),
    textDecoder = new TextDecoder(),
  } = opts;
  const flushMs = delays.flushMs ?? 300;
  const scanMs = delays.scanMs ?? 120;
  const clearConfirmMs = delays.clearConfirmMs ?? 300;

  // ---- 状态 ----
  const drafts = new Map();      // key -> {value,images} 内存未落盘副本
  const flushTimers = new Map(); // key -> timer
  const known = new Map();       // key -> 本页最后显示/写入的 value（null=未显示过）
  const aliases = new Map();     // provisionalKey(new:…) -> sid   会话提升映射
  const clearTimers = new Map(); // key -> timer（清空确认；回调闭包捕获 key，防误清新 key）
  let currentKey;                // keeper 内部唯一真相（core 的 draftKey prop 只是提示）
  let lastSnap = null;
  let pendingScan = false;
  let stagedRestore = null;      // 已恢复但可能被 hydration 重渲染抹掉（壳负责门控）
  let scanTimer = null;

  const slotKeyOf = (key) => {
    if (typeof key === "string" && key.startsWith("new:")) {
      // draftId 可能自身含冒号（如 ?cwd= 引导的 initial:<cwd>）→ 取最后一个冒号作 cwd 分界
      const ci = key.lastIndexOf(":");
      if (ci > 4) return PREFIX + "new:" + key.slice(ci + 1);
    }
    return PREFIX + key;
  };

  function readSlot(key) {
    try {
      const raw = storage.getItem(slotKeyOf(key));
      if (raw) return decodeSlot(raw, textDecoder);
    } catch { /* ignore */ }
    // 旧 per-tab 槽位迁移（crashrestore-<key>-<tabId> → 共享槽位；new: 族匹配同 cwd 全部旧槽）
    const isNew = typeof key === "string" && key.startsWith("new:");
    const cwdSuffix = isNew ? `:${key.slice(key.lastIndexOf(":") + 1)}-` : null;
    const legacyPrefix = `${PREFIX}${key}-`;
    const familyPrefix = isNew ? `${PREFIX}new:` : null;
    let best = null;
    try {
      for (const k of storage.keys()) {
        if (!k || !k.startsWith(PREFIX)) continue;
        const isFamily = isNew && k.startsWith(familyPrefix) && k.includes(cwdSuffix);
        if (!k.startsWith(legacyPrefix) && !isFamily) continue;
        const parsed = decodeSlot(storage.getItem(k) ?? "", textDecoder);
        if (parsed && (!best || parsed.ts > best.ts)) best = { ...parsed, legacyKey: k };
      }
    } catch { /* ignore */ }
    if (best) {
      try {
        storage.setItem(slotKeyOf(key), `${best.ts}:${encodeDraft(best.draft, textEncoder)}`);
        storage.removeItem(best.legacyKey);
      } catch { /* ignore */ }
      return { ts: best.ts, draft: best.draft };
    }
    return null;
  }

  function writeNow(key) {
    const draft = drafts.get(key);
    if (!draft) return;
    try { storage.setItem(slotKeyOf(key), `${Date.now()}:${encodeDraft(draft, textEncoder)}`); } catch { /* 配额满：内存副本仍在 */ }
  }

  function setDraft(key, draft) {
    drafts.set(key, { value: draft.value, images: (draft.images ?? []).map((im) => ({ ...im })) });
    const t = flushTimers.get(key);
    if (t) timers.clearTimeout(t);
    flushTimers.set(key, timers.setTimeout(() => { flushTimers.delete(key); writeNow(key); }, flushMs));
  }

  function clearSlot(key) {
    drafts.delete(key);
    const t = flushTimers.get(key);
    if (t) { timers.clearTimeout(t); flushTimers.delete(key); }
    try { storage.removeItem(slotKeyOf(key)); } catch { /* ignore */ }
  }

  function readSlotValue(key) {
    const cached = drafts.get(key);
    if (cached) return { ts: 0, draft: cached };
    return readSlot(key);
  }

  function flushAll() {
    for (const key of drafts.keys()) {
      // 清除确认中的槽不回写：用户刚清空/发走，等确认链裁决；回写会让「已清除」
      // 的草稿在切换瞬间重新落盘（确认链到期再删也只是赌链路不中断）
      if (clearTimers.has(key)) continue;
      // 已提升作废的 provisional（sessionCreated 已把它重定向到 sid）：不得再写回。
      // 归一化槽位 crashrestore-new:<cwd> 按 cwd 共享，这里写回会污染共享槽位
      // （「新建会话发送后残留」根因之一）。
      if (aliases.has(key)) continue;
      writeNow(key);
    }
  }

  // ---------- 恢复 ----------

  function applyRestore(key, draft) {
    known.set(key, draft.value); // 恢复不清暂存（known = 恢复值，随后 onChange 一致 → 不写）
    stagedRestore = { value: draft.value, images: draft.images };
    const ok = onRestore({ value: draft.value, images: draft.images });
    log("applyRestore ok=" + ok + " v=" + draft.value.slice(0, 15));
    if (!ok) stagedRestore = null;
    return true;
  }

  function scan(key, snap) {
    // 清空确认窗口否决：本 key 已排定清槽（刚发送/清空，确认链未到期）时不得恢复。
    // 槽里此刻的内容就是刚发走的那条（suppress 被击穿落槽的预填文本、或竞态窗口内
    // 的旧稿），恢复它既把消息填回框，又会污染 lastSnap 快照使确认链失效
    // （「从这里编辑→发送→输入框不空」实测链路）。确认链走完（槽位已清）后恢复不受影响。
    if (clearTimers.has(key)) return false;
    const entry = readSlotValue(key);
    const slotVal = entry ? entry.draft.value : null;
    const knownVal = known.get(key) ?? null;

    if (snap.hasInput) {
      // 框有内容（本页在输入）：仅当存储 ⊇ 本页已知（别的窗口扩展了草稿、本页未分叉）→ 同步进框
      if (knownVal !== null && slotVal !== null && slotVal !== snap.value && slotVal.includes(knownVal) && slotVal.length > knownVal.length) {
        return applyRestore(key, entry.draft);
      }
      return false;
    }
    // 框空：有暂存且非本页已知 → 静默恢复
    if (slotVal && slotVal !== knownVal) return applyRestore(key, entry.draft);
    return false;
  }

  function scheduleScan() {
    if (scanTimer) timers.clearTimeout(scanTimer);
    scanTimer = timers.setTimeout(() => {
      scanTimer = null;
      // 恢复不在定时器里做：这里能拿到的 lastSnap 往往是切换/重挂前的过期快照
      // （清屏 onChange 还没到），拿它扫描要么扫不出来、要么把草稿抢写进即将被
      // 清屏的旧 DOM（「恢复即删」）。真正的清屏快照（onChange ""）到达时由
      // onChange 的 pendingScan 分支负责扫描恢复——known 已在 onKeyChange 失效，
      // 那一刻才是唯一可信的扫描时机。这里只保留 staged 兜底。
      if (stagedRestore && lastSnap && !lastSnap.hasInput) {
        if (onRestore({ value: stagedRestore.value, images: stagedRestore.images })) stagedRestore = null;
      }
    }, scanMs);
  }

  // ---------- enhancement 回调（用户输入/清空/换 key）----------

  function onChange(snap) {
    try {
      lastSnap = snap;
      // 水合窗口补偿：恢复过的文本若被 hydration 重渲染清空（框空），重放
      if (stagedRestore) {
        if (snap.hasInput) {
          stagedRestore = null; // 用户已有输入：本页最大，放弃 stage
        } else if (snap.value !== stagedRestore.value) {
          if (onRestore({ value: stagedRestore.value, images: stagedRestore.images })) stagedRestore = null;
        } else {
          stagedRestore = null; // 框内已是恢复值
        }
      }
      if (pendingScan && currentKey) {
        pendingScan = false;
        // ★ 恢复发生时本轮快照（空框）已过时：applyRestore 已把 known 指向恢复值
        // 且正在写框，若继续落入下方清空分支会在确认延时后把刚恢复的草稿删掉
        //（「恢复即删」——原实现靠写框引发的回流 onChange 侥幸存活，回流失败
        // 即偶发丢失）。直接返回，等写框引发的新 onChange。
        if (scan(currentKey, snap)) return;
      }
      if (!currentKey || snap.suppress) return;
      const knownVal = known.get(currentKey) ?? null;
      if (snap.value === knownVal) return; // ★ 无贡献不回写
      if (snap.value === "") {
        // 清空/发走 → 清暂存（known 非空才清；打开时空框不清）。
        // 延迟确认防陈旧实例空快照误清；回调闭包捕获 key（期间换 key 不误清新 key 槽位）。
        known.set(currentKey, null);
        if (knownVal) {
          const clearedKey = currentKey;
          // ★ 立即删内存副本 + 挂起的 flush 定时器：确认窗口（clearConfirmMs）内任何
          // flushAll（切换/隐藏/键变化）都不得把已清除的草稿写回 —— 否则发送后残留
          // （「新建会话发出后不清理」根因）。期间用户重新输入会经 setDraft 恢复副本。
          drafts.delete(clearedKey);
          const ftt = flushTimers.get(clearedKey);
          if (ftt) { timers.clearTimeout(ftt); flushTimers.delete(clearedKey); }
          const t = clearTimers.get(clearedKey);
          if (t) timers.clearTimeout(t);
          clearTimers.set(clearedKey, timers.setTimeout(() => {
            clearTimers.delete(clearedKey);
            // 裁决看该 key 自己的 known（空值分支置 null；确认窗内同 key 新输入会重新写入非空）：
            // 不能看全局 lastSnap——跨 key 切换后它描述的是别的框，新框有内容会把「已清除
            // 的槽」误判成「仍有输入」而永久保留（清除后切走→切回草稿复活）。
            if (known.get(clearedKey) === null) { clearSlot(clearedKey); log("clear (empty confirmed) " + clearedKey.slice(0, 20)); }
          }, clearConfirmMs));
        }
        return;
      }
      // ★ 有贡献才写（currentKey 已被 sessionCreated 重定向时自然落 sid 槽位）
      setDraft(currentKey, { value: snap.value, images: snap.images ?? [] });
      known.set(currentKey, snap.value);
      log("WRITE v=" + snap.value.slice(0, 15));
    } catch (e) {
      log("onChange ERR: " + (e && e.message));
    }
  }

  function onKeyChange(prev, next) {
    try {
      if (prev) flushAll(); // 切换前把未落盘内容写掉
      // ★ 废弃 draftId（new:*）的内存副本立即清掉：草稿已由 flushAll 落盘到归一化槽位
      // `crashrestore-new:<cwd>`，且同一 draftId 的框不会再现（每次新建是新 draftId）。
      // 保留它会让后续任何 onKeyChange/flushAll 把旧草稿写回共享槽位（残留根因）。
      // 切回（新 draftId）时经 scan 从共享槽位恢复，不丢内容。
      // 若该 key 正处清空确认链（已清空/已发送，clearTimers 挂着），则保留 known=null 与
      // clearTimers，让确认链跑完 clearSlot 删槽位（不得掐断——否则清空失效导致残留）。
      if (prev && typeof prev === "string" && prev.startsWith("new:") && prev !== next) {
        drafts.delete(prev);
        const ft = flushTimers.get(prev);
        if (ft) { timers.clearTimeout(ft); flushTimers.delete(prev); }
        if (!clearTimers.has(prev)) known.delete(prev);
      }
      currentKey = next;
      // 切换/重挂后 ChatInput 的 [draftKey] effect 会清屏（setValue("")）——
      // known 描述的是「上一段 DOM 时代框里显示过什么」，清屏即失效。若保留旧值，
      // 同 key 切回（同一 session 的框）时 scan 的 slotVal !== knownVal 恒假：
      // 既不恢复，又让随后的空快照走清空确认链把槽位删掉（「切换丢草稿」根因）。
      // 置 null：清屏快照到达时槽内草稿视作可恢复；正常发送清槽不受影响
      // （发送不走 onKeyChange，clearTimers 否决 + 空值分支语义不变）。
      if (next) known.set(next, null);
      pendingScan = true; // 等清屏后的第一次 onChange 再扫描
      scheduleScan();
    } catch (e) {
      log("onKeyChange ERR: " + (e && e.message));
    }
  }

  // ---------- 意图（core 唯一写入口）----------

  function applyIntent(intent) {
    try {
      if (intent.type === "sessionCreated") {
        const { provisionalKey: pk, sessionId: sid } = intent;
        if (pk === sid) return;
        aliases.set(pk, sid);
        // ★ 发送即作废该 cwd 的**整族** provisional：归一化槽位 `crashrestore-new:<cwd>`
        // 按 cwd 共享，任何 draftId 的残留内存副本都会经 flushAll 写回该共享槽位
        // （「新建会话发出后残留」根因）。发送后同 cwd 不再有活跃新建草稿，全清。
        const familySlot = slotKeyOf(pk);
        for (const k of [...drafts.keys()]) {
          if (slotKeyOf(k) !== familySlot) continue;
          drafts.delete(k);
          const ft = flushTimers.get(k);
          if (ft) { timers.clearTimeout(ft); flushTimers.delete(k); }
          known.delete(k);
        }
        // provisional 草稿立即作废（消息已落会话；发送后的 onChange("") 清空确认链
        // 稍后跑到也只会对已空的槽位重复清除，无副作用）
        clearSlot(pk);
        known.set(pk, null);
        if (currentKey === pk) {
          // 重定向：promote 后、core 的 draftKey prop 切换前，用户已开始的新输入
          // 自然落 sid 槽位（不再写回 provisional 造成「已发送消息残留」）
          currentKey = sid;
          known.set(sid, known.get(sid) ?? null);
        }
        log("sessionCreated " + pk.slice(0, 24) + " -> " + sid.slice(0, 12));
        return;
      }
      if (intent.type === "rejected") {
        const resolvedKey = aliases.get(intent.key) ?? intent.key;
        const cur = readSlotValue(resolvedKey);
        const curText = cur?.draft.value ?? "";
        const curImages = cur?.draft.images ?? [];
        const merged = mergeSubmission(intent.text, intent.images, curText, curImages);
        setDraft(resolvedKey, merged);
        known.set(resolvedKey, merged.value);
        // 目标是当前框（含经 alias 重定向）→ 写回框内让用户重试
        const effectiveCurrent = aliases.get(currentKey) ?? currentKey;
        if (resolvedKey === effectiveCurrent) {
          onRestore({ value: merged.value, images: merged.images });
        }
        log("rejected -> " + resolvedKey.slice(0, 24));
        return;
      }
      log("unknown intent " + intent.type);
    } catch (e) {
      log("applyIntent ERR: " + (e && e.message));
    }
  }

  // ---------- 对外只读 / 维护 ----------

  function getDraft(key) {
    const e = readSlotValue(aliases.get(key) ?? key);
    return e ? { ...e.draft } : null;
  }

  function clearAllDrafts(sid) {
    clearSlot(sid);
    try {
      for (const k of storage.keys()) {
        if (k && k.startsWith(PREFIX + sid + "-")) storage.removeItem(k); // 旧 per-tab 残留一并清
      }
    } catch { /* ignore */ }
  }

  /** 启动时一次性清理：超过 maxAgeMs 未写入的槽位（含旧 per-tab 残留、已发送
   *  会话的孤儿草稿）自动过期。非轮询——仅 register 时调一次。活跃草稿 ts 新，
   *  不受影响。 */
  function pruneStale(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    try {
      for (const k of storage.keys()) {
        if (!k || !k.startsWith(PREFIX)) continue;
        const raw = storage.getItem(k) ?? "";
        const idx = raw.indexOf(":");
        const ts = idx > 0 ? Number(raw.slice(0, idx)) : NaN;
        // 无 ts 的旧格式槽位视为陈旧一并清理；解析不出 ts 的保守跳过
        if (Number.isFinite(ts) && ts >= cutoff) continue;
        if (!Number.isFinite(ts) && idx > 0) continue;
        storage.removeItem(k);
        removed++;
      }
    } catch { /* ignore */ }
    if (removed) log("pruneStale removed " + removed);
    return removed;
  }

  // ---------- deprecated（v1 兼容：未升级的旧 core 直调；新 core 不再使用）----------

  function saveDraft(key, draft) { setDraft(key, draft); known.set(key, draft.value); }
  function clearDraft(key) { clearSlot(aliases.get(key) ?? key); known.set(key, null); }
  function rekeyDraft(previousKey, nextKey, currentDraft) {
    if (previousKey === nextKey) return currentDraft ?? getDraft(nextKey);
    const prevEntry = currentDraft && (currentDraft.value || currentDraft.images.length)
      ? { ts: 0, draft: currentDraft }
      : readSlotValue(previousKey);
    const nextEntry = readSlotValue(nextKey);
    clearSlot(previousKey);
    if (!prevEntry) return nextEntry ? { ...nextEntry.draft } : null;
    const merged = nextEntry
      ? {
          value: prevEntry.draft.value.includes(nextEntry.draft.value)
            ? prevEntry.draft.value
            : `${nextEntry.draft.value}\n\n${prevEntry.draft.value}`,
          images: [...prevEntry.draft.images, ...nextEntry.draft.images].slice(0, 10),
        }
      : prevEntry.draft;
    setDraft(nextKey, merged);
    known.set(nextKey, merged.value);
    return { ...merged };
  }
  function restoreSubmission(key, text, images) {
    const resolvedKey = aliases.get(key) ?? key;
    const cur = readSlotValue(resolvedKey);
    const merged = mergeSubmission(text, images, cur?.draft.value ?? "", cur?.draft.images ?? []);
    setDraft(resolvedKey, merged);
    known.set(resolvedKey, merged.value);
    return { ...merged };
  }

  function dispose() {
    for (const t of flushTimers.values()) timers.clearTimeout(t);
    for (const t of clearTimers.values()) timers.clearTimeout(t);
    if (scanTimer) timers.clearTimeout(scanTimer);
    flushAll();
  }

  return {
    onChange, onKeyChange, applyIntent,
    getDraft, clearAllDrafts, flushAll, pruneStale,
    saveDraft, clearDraft, rekeyDraft, restoreSubmission, // deprecated
    dispose,
  };
}
