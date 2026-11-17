import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("new-session startup sends only explicit browser overrides", () => {
  // 合并注：v0.17 把新会话的 model/thinking 采纳逻辑抽成 applyNewSessionStartState
  // （ensureNewSession 调用它），切片改为覆盖该 helper 全体。
  const ensureSource = source.slice(
    source.indexOf("const applyNewSessionStartState"),
    source.indexOf("const loadSlashCommands"),
  );

  assert.match(ensureSource, /const selectedModel = newSessionModelOverrideRef\.current;/);
  assert.doesNotMatch(ensureSource, /newSessionModel \?\? newSessionDefaultModel/);
  assert.match(ensureSource, /const selectedThinkingLevel = thinkingLevelOverrideRef\.current;/);
  assert.doesNotMatch(ensureSource, /thinkingLevel !== "auto"/);
});

test("new-session startup adopts server state only while explicit overrides are unchanged", () => {
  // 合并注：v0.17 把 model/thinking 采纳逻辑抽成 applyNewSessionStartState，切片覆盖该 helper。
  const ensureSource = source.slice(
    source.indexOf("const applyNewSessionStartState"),
    source.indexOf("const loadSlashCommands"),
  );

  assert.match(
    ensureSource,
    /state\.model && newSessionModelOverrideRef\.current === selectedModel/,
  );
  assert.match(ensureSource, /setPendingModel\(state\.model\)/);
  assert.match(ensureSource, /setNewSessionDefaultModel\(state\.model\)/);
  assert.match(
    ensureSource,
    /thinkingLevelOverrideRef\.current === selectedThinkingLevel/,
  );
  assert.match(ensureSource, /setLiveThinkingLevel\(asConcreteThinkingLevel\(state\.thinkingLevel\)\)/);
  assert.match(ensureSource, /setNewSessionDefaultThinkingLevel\(asConcreteThinkingLevel\(state\.thinkingLevel\)\)/);
});

test("model-list refresh does not overwrite a live session or explicit thinking override", () => {
  // Applying the pinned thinking level has been extracted into applyModelsResponse (cache replay and
  // network results share the same mapping); the contract assertions cover the whole applyModelsResponse → loadModels span.
  const loadModelsSource = source.slice(
    source.indexOf("const applyModelsResponse = useCallback"),
    source.indexOf("const handleBuiltinSlashCommand"),
  );

  assert.match(loadModelsSource, /if \(isNew && !sessionIdRef\.current\)/);
  assert.match(
    loadModelsSource,
    /thinkingLevelOverrideRef\.current === null/,
  );
  assert.match(loadModelsSource, /setNewSessionDefaultThinkingLevel\(/);
  assert.doesNotMatch(loadModelsSource, /setThinkingLevel\(/);
});
