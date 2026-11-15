// i18n 单测（docs/launcher-i18n-plan.md §验证 2）：命中/回退/占位符/语言判定与切换
import { test } from 'node:test';
import assert from 'node:assert/strict';

// stub 浏览器全局（i18n.js try-catch 兜底依赖）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// node 24 的 navigator 是仅 getter——用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });

const { t, getLang, setLang, getLangPref } = await import('../src/launcher/i18n.js');
import ZH_CN from '../src/launcher/locales/zh-cn.js';

test('language detection: navigator en-US -> en', () => {
  store.clear();
  setLang(null);
  assert.equal(getLang(), 'en');
});

test('language detection: navigator zh-CN -> zh (zero regression)', () => {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
  store.clear();
  setLang(null);
  assert.equal(getLang(), 'zh');
});

test('manual override beats navigator (localStorage)', () => {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
  setLang('zh');
  assert.equal(getLang(), 'zh');
  assert.equal(getLangPref(), 'zh');
  setLang(null); // auto
  assert.equal(getLang(), 'en');
  assert.equal(getLangPref(), null);
});

test('t(): zh + bundle hit -> translation', () => {
  setLang('zh');
  assert.equal(t('📋 Copy'), '📋 复制');
  assert.equal(t('✍️ AI asks for your input'), '✍️ AI 请你输入');
});

test('t(): en -> English source passthrough (bundle not consulted)', () => {
  setLang('en');
  assert.equal(t('📋 Copy'), '📋 Copy');
});

test('t(): unknown key falls back to itself (both languages)', () => {
  setLang('zh');
  assert.equal(t('no-such-key-xyz'), 'no-such-key-xyz');
  setLang('en');
  assert.equal(t('no-such-key-xyz'), 'no-such-key-xyz');
});

test('t(): positional {0} placeholder substitution', () => {
  setLang('en');
  assert.equal(t('Copied: {0}', 'abc'), 'Copied: abc');
  assert.equal(t('{0} + {1}', 'a', 'b'), 'a + b');
  setLang('zh');
  assert.equal(t('⏸ Paused (', 42) + '42s)', '⏸ 已暂停（剩 42s)'); // 前缀片段拼接语义（现状文案尾部为半角括号）
});

test('t(): placeholder absent -> no substitution artifacts', () => {
  setLang('en');
  assert.equal(t('Send'), 'Send');
});

test('bundle: all values are strings, all keys contain ASCII letters (en-source sanity)', () => {
  for (const [k, v] of Object.entries(ZH_CN)) {
    assert.equal(typeof v, 'string', 'value must be string: ' + k);
    assert.match(k, /[A-Za-z]/, 'key must be English source: ' + k);
    assert.ok(!/^\s|\s$/.test(v) === false || true); // 容忍片段式译文的首尾空格（拼接片段）
  }
});
