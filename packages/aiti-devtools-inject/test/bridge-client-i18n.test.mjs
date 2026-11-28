// Bridge client status text i18n: pi-web locale wins, navigator language is the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../src/mcp/bridge-client.js', import.meta.url), 'utf8');

function disconnectedStatus(piLocale, navLang) {
  const got = [];
  const sandbox = {
    localStorage: { getItem: (k) => (k === 'pi-locale' ? piLocale : null), setItem() {} },
    navigator: { language: navLang },
    document: { documentElement: { lang: '' } },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    fetch: () => new Promise(() => {}),
    EventSource: function () { this.close = () => {}; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SOURCE, sandbox);
  sandbox.BridgeClient.connect({ base: 'http://127.0.0.1:1', onStatus: (text) => got.push(text) });
  sandbox.BridgeClient.disconnect();
  return got[got.length - 1];
}

test('bridge status text: zh-CN locale', () => {
  assert.equal(disconnectedStatus('zh-CN', 'en-US'), '🔗 已断开');
});

test('bridge status text: en locale', () => {
  assert.equal(disconnectedStatus('en', 'zh-CN'), '🔗 Disconnected');
});

test('bridge status text: navigator fallback outside pi-web', () => {
  assert.equal(disconnectedStatus(null, 'zh-TW'), '🔗 已断开');
  assert.equal(disconnectedStatus(null, 'en-US'), '🔗 Disconnected');
});
