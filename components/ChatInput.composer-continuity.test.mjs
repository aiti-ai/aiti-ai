import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { isDraftKeyPromotion } = await jiti.import("./ChatInput.tsx");

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

// 小屏「AI 正在显示时打断输入」第二类根因（与滚动无关）：
//  ① 新建会话提升（provisional `new:…` → 真实 sid）走了「切会话清屏」路径 →
//    用户在 AI 回答期间刚打的下一条输入被 setValue("") 当面吞掉；
//  ② 发送那一刻 composer 从欢迎页搬到消息流底部（两处不同 DOM 位置 → 整棵
//    ChatInput 重挂载）→ 焦点随旧节点销毁，手机键盘收起、IME 组合丢失。
test("a new-session promotion keeps the in-progress composer text", () => {
  // 判定：只有 `new:…` → 非 `new:…` 算提升
  assert.equal(isDraftKeyPromotion("new:abc123:/repo", "1b63f5ac-134c-40b8-9d80-f61288e0039c"), true);
  // 首次挂载（previous undefined）/ 切到另一个新建页 / 清 key 都不是提升 → 照旧清屏
  assert.equal(isDraftKeyPromotion(undefined, "1b63f5ac"), false);
  assert.equal(isDraftKeyPromotion("new:a:/repo", "new:b:/repo"), false);
  assert.equal(isDraftKeyPromotion("1b63f5ac", undefined), false);

  const draftKeyEffectSource = source.slice(
    source.indexOf("  useEffect(() => {\n    const previousDraftKey = draftKeyRef.current;"),
    source.indexOf("// [aiti] 跨会话预填"),
  );
  // 提升时只换 key + 广播，不清值不清图（广播必须在清屏早退之前——keeper 靠它重定向槽位）
  assert.match(draftKeyEffectSource, /emitComposerKeyChange\(previousDraftKey, draftKey\);[\s\S]*?if \(isDraftKeyPromotion\(previousDraftKey, draftKey\)\) return;/);
  const broadcastIdx = draftKeyEffectSource.indexOf("emitComposerKeyChange(previousDraftKey, draftKey);");
  const promoteIdxFirst = draftKeyEffectSource.indexOf("if (isDraftKeyPromotion(");
  assert.ok(broadcastIdx !== -1 && broadcastIdx < promoteIdxFirst, "the key-change broadcast must still fire on a promotion (keeper redirects the slot on it)");
  const clearIdx = draftKeyEffectSource.indexOf('setValue("");');
  const promoteIdx = draftKeyEffectSource.indexOf("if (isDraftKeyPromotion(");
  assert.ok(clearIdx > promoteIdx, "the clear must stay behind the promotion early-return");
});

test("the composer hands focus over across the welcome→composer remount", () => {
  const handoffSource = source.slice(
    source.indexOf("let composerLiveFocused = false;"),
    source.indexOf("const ChatInputInner = forwardRef"),
  );
  assert.match(handoffSource, /let pendingFocusHandoff = false;/);

  const effectSource = source.slice(
    source.indexOf("  // 焦点跨重挂载交接"),
    source.indexOf("// Collapse the Send button label"),
  );
  // 挂载接回 + 销毁记账；preventScroll 防「为还焦点反而滚了页面」
  assert.match(effectSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(effectSource, /ta\.focus\(\{ preventScroll: true \}\)/);
  assert.match(effectSource, /return \(\) => \{\s*pendingFocusHandoff = composerLiveFocused;/);
  // 焦点状态由真实 focus/blur 事件维护（节点被 detach 时浏览器派发的 blur 不经 React
  // 委托，所以销毁前读到的值就是「用户没主动点到别处」）
  assert.match(source, /const handleFocus = useCallback\(\(\) => \{\s*composerLiveFocused = true;/);
  assert.match(source, /const handleBlur = useCallback\(\(\) => \{\s*composerLiveFocused = false;/);
  assert.match(source, /onFocus=\{handleFocus\}\s*onBlur=\{handleBlur\}/);
});
