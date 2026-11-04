/**
 * asr-providers 单测 —— ASR 引擎层的纯逻辑（配置解析 / 脱敏 / 白名单合并 / multipart 编码）。
 *
 * 覆盖 docs/aiti-ai-input-asr-provider-plan.md §3.2/§3.3：
 *   引擎 id 解析与旧配置兼容、按引擎取配置、ready 判定、读回脱敏（key 绝不出现明文）、
 *   写入白名单（只认 fields 声明的键、空串=删除、未知 provider 拒绝）、手写 multipart 报文。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-ai-input/asr-providers.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASR_PROVIDERS,
  asrProviderCfg,
  asrProviderId,
  asrProviderReady,
  asrProviderSpec,
  asrProviderView,
  asrMergeProviderCfg,
  encodeMultipart,
} from "./asr-providers.ts";

const KEY = "sk-abcdefghijklmnop1234";

test("注册表：六个引擎，id 唯一，builtin 居首（旧配置缺省落 builtin）", () => {
  const ids = ASR_PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids, ["builtin", "xfyun", "baidu", "siliconflow", "openai", "azure"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("asrProviderId：无 provider 节/非法值 → builtin（旧配置行为不变）", () => {
  assert.equal(asrProviderId({}), "builtin");
  assert.equal(asrProviderId({ stream_model: "x" }), "builtin");
  assert.equal(asrProviderId({ provider: "nope" }), "builtin");
  assert.equal(asrProviderId({ provider: "xfyun" }), "xfyun");
  assert.equal(asrProviderId({ provider: " xfyun " }), "xfyun");
});

test("asrProviderCfg：取 providers[id]，缺失/非对象 → {}", () => {
  const cfg = { providers: { xfyun: { appId: "2061196f" }, baidu: "bad" } };
  assert.deepEqual(asrProviderCfg(cfg, "xfyun"), { appId: "2061196f" });
  assert.deepEqual(asrProviderCfg(cfg, "baidu"), {});
  assert.deepEqual(asrProviderCfg(cfg, "openai"), {});
  assert.deepEqual(asrProviderCfg({}, "xfyun"), {});
});

test("asrProviderReady：各引擎按必填字段判定", () => {
  assert.equal(asrProviderReady({}, "builtin"), true);
  assert.equal(asrProviderReady({ providers: { siliconflow: { apiKey: KEY } } }, "siliconflow"), true);
  assert.equal(asrProviderReady({ providers: { siliconflow: { apiKey: "  " } } }, "siliconflow"), false);
  assert.equal(asrProviderReady({ providers: { xfyun: { appId: "a", apiKey: "b" } } }, "xfyun"), false); // 缺 apiSecret
  assert.equal(asrProviderReady({ providers: { xfyun: { appId: "a", apiKey: "b", apiSecret: "c" } } }, "xfyun"), true);
  assert.equal(asrProviderReady({ providers: { baidu: { apiKey: "a", secretKey: "b" } } }, "baidu"), true);
  assert.equal(asrProviderReady({ providers: { openai: { baseUrl: "http://x/v1" } } }, "openai"), true);
  assert.equal(asrProviderReady({ providers: { openai: { apiKey: KEY } } }, "openai"), false); // 缺端点
  assert.equal(asrProviderReady({ providers: { azure: { subscriptionKey: "k" } } }, "azure"), false); // 缺 region
  assert.equal(asrProviderReady({ providers: { azure: { subscriptionKey: "k", region: "eastasia" } } }, "azure"), true);
});

test("asrProviderView：key 只回 configured + 尾 4 位，全文序列化不含明文", () => {
  const cfg = {
    provider: "siliconflow",
    providers: { siliconflow: { apiKey: KEY, model: "FunAudioLLM/SenseVoiceSmall" } },
  };
  const view = asrProviderView(cfg);
  assert.equal(view.provider, "siliconflow");
  assert.equal(view.providerReady, true);
  const sf = view.providers.find((p) => p.id === "siliconflow");
  assert.deepEqual(sf.params.apiKey, { configured: true, tail: "1234" });
  assert.equal(sf.params.model.value, "FunAudioLLM/SenseVoiceSmall");
  assert.equal(sf.fields.some((f) => f.key === "apiKey" && f.secret === true), true);
  assert.equal(JSON.stringify(view).includes(KEY), false, "脱敏后不得出现 key 明文");
});

test("asrProviderView：未配置引擎 params 标 configured:false", () => {
  const view = asrProviderView({ provider: "builtin" });
  const xf = view.providers.find((p) => p.id === "xfyun");
  assert.equal(xf.ready, false);
  assert.deepEqual(xf.params.apiKey, { configured: false });          // secret：未配置不给 value
  assert.deepEqual(xf.params.appId, { configured: false, value: "" }); // 非 secret：回空值供表单回填
});

test("asrMergeProviderCfg：切 provider + 白名单写入 + 空串删除 + 未知字段忽略", () => {
  const base = { stream_model: "paraformer-zh-streaming", provider: "builtin" };
  const r1 = asrMergeProviderCfg(base, {
    provider: "xfyun",
    providers: { xfyun: { appId: "2061196f", apiKey: "de33", apiSecret: "NTgx", evil: "x" } },
  });
  assert.equal(r1.error, undefined);
  assert.equal(r1.cfg.provider, "xfyun");
  assert.equal(r1.cfg.stream_model, "paraformer-zh-streaming", "已有字段必须保留");
  assert.deepEqual(r1.cfg.providers.xfyun, { appId: "2061196f", apiKey: "de33", apiSecret: "NTgx" });

  const r2 = asrMergeProviderCfg(r1.cfg, { providers: { xfyun: { apiKey: "" } } });
  assert.equal("apiKey" in r2.cfg.providers.xfyun, false, "空串 = 删除该项");
  assert.equal(r2.cfg.providers.xfyun.appId, "2061196f", "其它键不受影响");
});

test("asrMergeProviderCfg：未知 provider 拒绝（不写盘）", () => {
  const r = asrMergeProviderCfg({ provider: "xfyun" }, { provider: "nope" });
  assert.match(r.error || "", /provider 必须是/);
  assert.equal(r.cfg.provider, "xfyun");
});

test("asrProviderSpec：未知 id 回落 builtin（保证分发不炸）", () => {
  assert.equal(asrProviderSpec("nope").id, "builtin");
  assert.equal(asrProviderSpec("xfyun").timeout.quick > 0, true);
});

test("encodeMultipart：boundary/字段名/二进制长度/contentType 正确", () => {
  const bin = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);
  const mp = encodeMultipart([
    { name: "model", value: "FunAudioLLM/SenseVoiceSmall" },
    { name: "file", filename: "voice.wav", type: "audio/wav", value: bin },
  ]);
  assert.match(mp.contentType, /^multipart\/form-data; boundary=----aitiAsrForm/);
  const text = Buffer.from(mp.body).toString("latin1");
  const boundary = mp.contentType.split("boundary=")[1];
  assert.ok(text.includes(`Content-Disposition: form-data; name="model"`));
  assert.ok(text.includes('Content-Disposition: form-data; name="file"; filename="voice.wav"'));
  assert.ok(text.includes("Content-Type: audio/wav"));
  assert.ok(text.includes("FunAudioLLM/SenseVoiceSmall"));
  assert.ok(text.includes("RIFF"));
  assert.ok(text.endsWith(`--${boundary}--\r\n`));
  assert.equal(mp.body.length > bin.length, true);
});

test("encodeMultipart：文件名含引号/换行被净化（防报文注入）", () => {
  const mp = encodeMultipart([{ name: "file", filename: 'a"b\nc.wav', type: "audio/wav", value: new Uint8Array([1]) }]);
  const text = Buffer.from(mp.body).toString("latin1");
  assert.ok(text.includes('filename="a_b_c.wav"'));
  assert.equal(text.includes('a"b'), false);
});
