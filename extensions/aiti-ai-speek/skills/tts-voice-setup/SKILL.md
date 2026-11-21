---
name: tts-voice-setup
title: 本地语音音色：内置音色、克隆音色、试听
title.en: "Local voices: built-in, cloning, preview"
placeholder: 本地语音怎么换音色 / 怎么用我自己的声音朗读？
placeholder.en: "How do I change the local voice / make it read in my own voice?"
summary: 本地引擎的音色设置：Hojo 40M 的 17 个内置音色、80M/Qwen3 的克隆音色（3-30 秒参考音频 + 转录）、试听与删除、常见失败（转录不一致、webm 录音、切 provider 后失效）
summary.en: "Voice setup for the local engine: the 17 built-in Hojo 40M voices, cloning for 80M/Qwen3 (3-30s reference + transcript), preview/delete, and common failures (bad transcript, webm recording, stale ids after a provider switch)"
outputs:
  format: text
---

# tts-voice-setup · 本地语音音色

> 音色存在扩展的 state 目录（`voices.json` + 参考音频），**跨 provider 复用**；内置音色由
> provider 直接提供，不可删除。所有操作都在面板「音色管理」里，用户不用碰文件。

## 0. 结论先行（按用户想要的效果给路径）

| 用户想要 | 怎么做 |
|---|---|
| 换个声音就行 | 引擎=**本地** + provider=**Hojo 40M** → 音色下拉挑一个（中文 4 个：女声 1/2、男声 1/2） |
| 用我自己的声音 | provider=**Hojo 80M**（或 Qwen3）→ **音色管理 → ＋新建克隆音色** → 上传或录 3-30 秒 → 填这段音频的**逐字转录** → 保存 → 在音色下拉选中它 |
| 批量管理/删除 | 音色管理里每行有「▶ 试听」和「🗑」（内置音色没有 🗑） |

面板路径：**跟读设置 → 本地 TTS 服务 → 音色管理**。

## 1. 内置音色（仅 Hojo 40M，17 个）

| 语言 | 数量 | 音色 id 形如 | 面板显示 |
|---|---|---|---|
| 中文 | 4 | `hojo_zh_f_01` / `hojo_zh_f_02` / `hojo_zh_m_01` / `hojo_zh_m_02` | 中文 · 女声 1 / 中文 · 男声 1 … |
| 英文 | 13 | `hojo_en_f_01..08` / `hojo_en_m_01..05` | English · Female 1 … |

- 40M **不能**克隆；80M / Qwen3 **没有内置音色**（切过去音色列表会变空，这是正常的，不是坏掉）。
- 拼音纠正：文本里可写 `<zh_tian1>` 之类的 token 强制读音（高级用法，不需要提给普通用户）。

## 2. 克隆音色（80M / Qwen3）

**要求**：3-30 秒单人、安静、无明显底噪的语音；上传 wav/mp3/webm（webm 需服务端有 ffmpeg）；
≤10MB；**转录必须与音频逐字一致**（ICL 克隆的硬要求）。

步骤（面板）：
1. provider 选 `Hojo 80M`（会自动弹出音色管理；没有音色时服务无法朗读）；
2. 「＋ 新建克隆音色」→ 音色名（会生成稳定 id）；
3. 参考音频：上传文件 或 🎙 录音（最长 15 秒自动停）；
4. **参考文本**：把音频里说的话原样打进去（标点可省，字不能错）；
5. 语言：中文 / English / 自动（Qwen3 另有「仅音色向量」= 不需要转录，音质相似度略低）；
6. 保存 → 列表出现新音色（标「克隆」）→ ▶ 试听 → 在音色下拉选中。

**AI 可代建**（同一套后端接口，multipart）：

```bash
curl -X POST http://127.0.0.1:30142/dev/api/extensions/aiti-ai-speek/tts/voices \
  -F "name=我的声音" -F "refText=<逐字转录>" -F "language=Chinese" \
  -F "provider=hojo-80m" -F "audio=@/path/to/ref.wav;type=audio/wav"
# 删除（内置音色会被 409 拒绝）：DELETE .../tts/voices/<id>
# 列表：GET .../tts/voices
```

## 3. 试听与切换

- 音色下拉里选中即试听一句（本地引擎走 `/tts?engine=local`，秒回缓存）。
- 声音在服务端缓存（key = provider|model|voice|text），换回同一音色同一句不会再合成。
- 删除克隆音色后，若当前选中就是它，会自动回到默认（列表变化时前端会清理失效 id）。

## 4. 排障

| 症状 | 原因/处理 |
|---|---|
| 切到 80M 后没声音 | 80M 没有内置音色。面板会提示「当前 provider 没有可用音色」并自动打开音色管理 → 新建即可 |
| 试听报 400 / 提示音色不存在 | 音色 id 属于另一个 provider（比如 40M 的内置音色在 80M 下不可用），或已删除 → 重新选 |
| 克隆出来“不像” | 参考音频底噪大/时长太短/多人说话；转录与音频不一致是最常见原因 |
| 上传 webm 失败 | 服务端没有 ffmpeg（`sudo apt install ffmpeg`），或改用 wav |
| 录音按钮点不了 | 非 https/回环页面拿不到麦克风（面板会提示），改用上传 |
| 时长被拒 | 服务端限制 3-30 秒（实测 <2.5s 或 >35s 会拒绝并提示） |

## 5. 校验

```bash
curl -s .../tts/voices           # { provider, supportsClone, voices:[{id,label,builtin}] }
curl -s .../voices               # 合并视图：edge 音色 + engines.local + localVoices
```
