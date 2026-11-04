/**
 * aiti-ai-input · L2 ASR 录音引擎（懒 chunk，2026-09-14 拆分自 entry.tsx register 内联块；
 * 方案 pi-web-eager-ext-split-plan.md §5.2）。
 *
 * 浏览器录音 → 服务端转写全链路：getUserMedia/MediaRecorder、WS 流式（paraformer）、
 * 服务端 VAD 一体化（/ws/vad）、本地 RMS 切句、2-pass 精修（Qwen3）、声纹波形、候选面板。
 * 安装为 window.__aitiVoiceInputL2（start/stop/cancel/recording/cleanup）——
 * 触发方 = components.tsx VoiceAffixButton 按住说话（首次 press 才 import 本模块，
 * 首屏不加载；共享模块 logic/host-shim 由 rollup 收进 entry chunk，单实例）。
 */
import { AC, acInsertAtCaret } from "./logic";
import { getCtx } from "./host-shim";

/** 安装引擎（幂等：热重载/重复 press 不重复安装）。ctx 取自共享 host-shim（register 时已注入）。 */
export function installVoiceL2(): void {
  if (typeof window !== "undefined" && (window as any).__aitiVoiceInputL2) return;
  const ctx = (getCtx() ?? {}) as Record<string, unknown>;
// L2 ASR 客户端（浏览器录音 → 服务端转写）
try {
  try {
    const style = document.createElement("style");
    style.textContent = `@keyframes aiti-voice-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}@keyframes aiti-voice-wave{0%,100%{height:8px}50%{height:20px}}.aiti-voice-wave{display:inline-flex;align-items:center;gap:4px;vertical-align:middle;margin-right:8px}.aiti-voice-wave span{display:inline-block;width:4px;background:#fff;border-radius:2px;animation:aiti-voice-wave 1s infinite}.aiti-voice-wave span:nth-child(2){animation-delay:.15s}.aiti-voice-wave span:nth-child(3){animation-delay:.3s}.aiti-voice-wave span:nth-child(4){animation-delay:.45s}.aiti-voice-wave span:nth-child(5){animation-delay:.6s}`;
    document.head.appendChild(style);
  } catch {}
// 2-pass / token 精修与兑底统一走 voice-asr2（→ 8767 Qwen3-ASR）与 voice-quick（→ 8767 SenseVoice）；
  // 旧 voice-asr（8765/8766 faster-whisper/Nano 兑底链）已删除。
  const l2ApiUrl2 = (ctx.apiUrl as ((p: string) => string) | undefined)?.(`/api/extensions/aiti-ai-input/voice-asr2`);
  const l2ApiQuick = (ctx.apiUrl as ((p: string) => string) | undefined)?.(`/api/extensions/aiti-ai-input/voice-quick`);
  // ASR 自愈探测：服务未运行 → 服务端经 aiti-cmd 自动拉起（日志在 ⚡命令 面板）
  const l2ApiEnsure = (ctx.apiUrl as ((p: string) => string) | undefined)?.(`/api/extensions/aiti-ai-input/asr/ensure`);
  // WS 地址：从 apiUrl 推导 basePath（多实例 /dev 前缀安全），与 aiti-ui-env 同模式
  let l2WsUrl = "";
  let l2VadWsUrl = "";
  try {
    const _api = new URL(String((ctx.apiUrl as ((p: string) => string))("/x")), location.origin);
    const basePath = _api.pathname.endsWith("/x") ? _api.pathname.slice(0, -2) : "/";
    l2WsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + basePath.replace(/\/+$/, "") + "/aiti-ai-input/asr/ws/stream";
    l2VadWsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + basePath.replace(/\/+$/, "") + "/aiti-ai-input/asr/ws/vad";
  } catch {}
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c as "&"] || c);
  let l2Recording = false;       // 正在录音（recorder 已 start）
  let l2Starting = false;       // getUserMedia 在途
  let l2StopRequested = false;  // 松手/取消已到达
  let l2Canceled = false;       // 本次取消
  let l2MediaRecorder: MediaRecorder | null = null;
  let l2Chunks: Blob[] = [];
  let l2Mime = "audio/webm";
  let l2Visualizer: HTMLCanvasElement | null = null;
  let l2CandPanel: HTMLDivElement | null = null;
  let l2AudioContext: AudioContext | null = null;
  let l2Analyser: AnalyserNode | null = null;
  let l2Processor: ScriptProcessorNode | null = null;
  let l2AnimFrame: number | null = null;
  // 流式状态（WS 实时 + 2-pass）
  let l2Ws: WebSocket | null = null;
  let l2StreamReady = false;
  let l2UseStreaming = false;
  // ---- 服务端 VAD 一体化链路（/ws/vad：分段+识别+精修全在服务端；优先于本地 RMS 切句）----
  let l2VadWs: WebSocket | null = null;
  let l2VadWsOn = false;               // VAD WS 已建立（ready 后置 true）
  let l2VadSegs: Array<{ quick: string; refined: string }> = [];   // 已收到的段（done 时拼接）
  let l2VadDone = false;               // done 已收（防二次处理）
  let l2Pass2Enabled = true;
  let l2PcmChunks: Float32Array[] = [];
  let l2Gen = 0;                // 每一轮录音 +1，旧一轮的异步结果据此作废
  let l2Committed = false;      // 本句是否已写入输入框（防双写）
  let l2DismissTimer: ReturnType<typeof setTimeout> | null = null;
  let l2SafetyTimer: ReturnType<typeof setTimeout> | null = null;
  const L2_MAX_SECONDS = 60;
  const PASS2_DELAY_MS = 0;   // 关掉实时出字后：松手立即调 2-pass（Qwen3）精修，不等 0.6s

  // ---- VAD 自动断句（停顿自动切句，伪实时 SenseVoice 逐句上屏；asr.split 默认开）----
  const L2_VAD_SILENCE_MS = 700;        // 连续静音多久切句
  const L2_VAD_IGNORE_MS = 400;         // 录音开始/切句后前 400ms 不判（防按下瞬间误切）
  const L2_VAD_RMS = 0.005;             // 低于此 RMS 视为静音（默认；feature asr.vad.rms 可覆盖）
  const L2_VAD_MIN_GAP_MS = 1200;       // 两次切句最小间隔（防切句后立刻又切）
  const L2_VAD_MIN_SPEECH_MS = 1500;    // 本句有效语音至少多长才切句（短句不切，留整段 2-pass）
  const L2_QUICK_MIN_WAV_MS = 400;      // quick 提交的最短 wav 时长（防按下空按/白噪）
  // 可 feature 覆盖（面板「通用配置」可调）：静音阈值越小越灵敏；输入增益只作用于送识别的音频
  const l2NumFeat = (k: string, d: number) => {
    const v = Number((AC.feats as Record<string, unknown>)[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const l2VadRmsThr = () => Math.min(0.1, Math.max(0.0005, l2NumFeat("asrVadRms", L2_VAD_RMS)));
  const l2InputGain = () => Math.min(8, Math.max(1, l2NumFeat("asrInputGain", 1)));
  let l2RmsNow = 0;                     // 当前帧 RMS（可视化：让用户看到说话有没有过阈值线）
  let l2VadFired = false;               // 切句防重入（提交在途不重复切）
  let l2VadSilenceMs = 0;               // 累计静音时长
  let l2VadSpeechMs = 0;                // 本句累计有效语音时长（有声帧累加）
  let l2SentStartAt = 0;                // 本句开始时间（用于最小间隔）
  const l2VadOn = () => l2Recording && AC.feats.asrVad !== false && AC.feats.asrSplit !== false && !l2Canceled && !l2UseStreaming;  // VAD 切句（SenseVoice 引擎/非 WS 时）
  // 伪实时分句：本句已提交到的 PCM chunk 索引（l2PcmChunks 里 < l2SentIdx 的已识别完）
  let l2SentIdx = 0;
  let l2SplitEnabled = false;           // 本轮是否分句模式
  let l2QuickBusy = false;              // quick 请求在途（防并发提交同段）
  let l2SentTexts: string[] = [];       // 分句 quick 识别结果（候选展示，不上屏；松手后整段精修再上屏）
  let l2Pass2Texts: string[] = [];      // 分句 2-pass 精修结果（按句序；松手时拼接上屏，优先于 quick）
  let l2SentSeq = 0;                    // 句自增序号（quick 与分句精修共用索引，防乱序）
  let l2Pass2RefillBusy = 0;            // 在途分句精修计数（松手等待拼接）
  let l2SplitFinalizing = false;        // 分句收尾精修在途（safetyTimer 跳过 webm 兑底）
  let l2Pass2Busy = false;              // 2-pass 请求在途（safetyTimer/收尾防重复提交）

  // 是否走实时流式出字（slow 但准的 2-pass 才是主路径；实时出字质量差，默认关）
  const l2StreamingOn = () => AC.feats.asrStreaming === true; // 显式开启才用流式

  // ---- 音频工具：线性重采样到 16k + float32→int16 ----
  const l2Resample16k = (data: Float32Array, fromRate: number): Float32Array => {
    if (fromRate === 16000) return data;
    const ratio = 16000 / fromRate;
    const outLen = Math.round(data.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i / ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, data.length - 1);
      const frac = src - i0;
      out[i] = data[i0] * (1 - frac) + data[i1] * frac;
    }
    return out;
  };
  const l2ToInt16 = (f32: Float32Array): Int16Array => {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  };
  const l2WriteAscii = (dv: DataView, off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  const l2BuildWav = (fromIdx = 0, toIdx?: number): Blob | null => {
    const parts = toIdx !== undefined ? l2PcmChunks.slice(fromIdx, toIdx) : (fromIdx > 0 ? l2PcmChunks.slice(fromIdx) : l2PcmChunks);
    const total = parts.reduce((n, c) => n + c.length, 0);
    if (!total) return null;
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of parts) { pcm.set(c, off); off += c.length; }
    const int16 = l2ToInt16(pcm);
    const bytes = int16.length * 2;
    const buf = new ArrayBuffer(44 + bytes);
    const dv = new DataView(buf);
    l2WriteAscii(dv, 0, "RIFF"); dv.setUint32(4, 36 + bytes, true); l2WriteAscii(dv, 8, "WAVE");
    l2WriteAscii(dv, 12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 16000 * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    l2WriteAscii(dv, 36, "data"); dv.setUint32(40, bytes, true);
    const wav = new Uint8Array(buf);
    wav.set(new Uint8Array(int16.buffer), 44);
    return new Blob([wav], { type: "audio/wav" });
  };

  // 界面语言判定（与 aiti-devtools 同款：localStorage pi-locale 权威，fallback <html lang>；缺省中文）
  const l2UiIsZh = () => {
    try {
      const stored = localStorage.getItem("pi-locale");
      if (stored && stored.trim()) return !String(stored).toLowerCase().startsWith("en");
      const l = (document.documentElement && document.documentElement.lang) || "";
      return !l.toLowerCase().startsWith("en");
    } catch { return true; }
  };
  // 提交文本到输入框（幂等，只有一次）：录入结束补句末标点（中文 。/ 其他语言 .，已带句末标点不重复）；
  // 且不自动换行——在光标处插入（有选区则替换选区），插入完光标落到新文本后面，由用户自己控制分段。
  const l2Commit = (text: string, multi = false) => {
    if (l2Committed && !multi) return;   // 一次性模式：防双写；分句模式（multi）允许多次接续
    const t = String(text || "").trim();
    if (!t) return;
    if (!multi) l2Committed = true;
    const ta = document.querySelector("textarea[data-chat-input]");
    if (!ta) return;
    let out = t;
    // 分句模式：中间句也补句末标点（每句独立成句）；一次性模式同现有
    if (!/[。．！？!?…；;]/.test(out.slice(-1))) out += l2UiIsZh() ? "。" : ".";
    // 必须经 acSetTaValue（原生 prototype setter / 受控写入）：直接 ta.value= 赋值会走 React
    // 装在节点上的 value wrapper setter，把 _valueTracker 同步成新值——随后的 input 事件被
    // ChangeEventPlugin 判为「无变化」而抑制 onChange → React state 不更新 → 发送按钮不亮。
    // （与 pi-web ChatInput.writeTextareaValue 注释同坑；自动补全 acAcceptGhost 同款入口）
    acInsertAtCaret(ta, out); // 光标处插入 + 插入后光标落到新文本末尾（未聚焦时退到文末追加）
  };

  // 声纹波形：低帧率(≈24fps) + try/catch 自保 + 复用缓冲——绝不让 rAF 异常风暴卡死主线程；
  // 下一帧只在绘制成功后排期，异常时自停。
  const l2DrawWaveform = () => {
    if (!l2Visualizer || !l2Analyser) return;
    const canvas = l2Visualizer;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const width = canvas.width;
    const height = canvas.height;
    const buf = new Uint8Array(l2Analyser.fftSize || 2048);
    const freq = new Uint8Array(l2Analyser.frequencyBinCount || 1024);
    let last = 0;
    const draw = (now: number) => {
      if (now - last < 42) { l2AnimFrame = requestAnimationFrame(draw); return; } // 限帧 ≈24fps
      last = now;
      try {
        l2Analyser.getByteTimeDomainData(buf);
        ctx2d.fillStyle = "#111827";
        ctx2d.fillRect(0, 0, width, height);
        ctx2d.lineWidth = 2;
        ctx2d.strokeStyle = "#10b981";
        ctx2d.beginPath();
        const slice = width / buf.length;
        for (let i = 0; i < buf.length; i += 2) { // 步进 2：顶点减半
          const y = (buf[i] / 128.0) * (height / 2);
          const x = i * slice;
          if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
        }
        ctx2d.lineTo(width, height / 2);
        ctx2d.stroke();
        // RMS 条（底部）+ 阈值线（红）：直观看「说话有没有过线」——小声不识别时先瞄这一条
        const thr = l2VadRmsThr();
        const scale = Math.max(0.05, thr * 3);       // 满量程 = 阈值的 3 倍
        ctx2d.fillStyle = "#1f2937";
        ctx2d.fillRect(0, height - 7, width, 7);
        ctx2d.fillStyle = l2RmsNow >= thr ? "#10b981" : "#f59e0b";
        ctx2d.fillRect(0, height - 7, Math.min(1, l2RmsNow / scale) * width, 7);
        ctx2d.fillStyle = "#ef4444";
        ctx2d.fillRect(Math.min(width - 1, (thr / scale) * width), height - 9, 1, 11);
        l2Analyser.getByteFrequencyData(freq);
        const barCount = 12;
        const step = Math.max(1, Math.floor(freq.length / barCount));
        const barWidth = width / barCount;
        for (let i = 0; i < barCount; i++) {
          const value = freq[Math.min(i * step, freq.length - 1)] || 0;
          const p = value / 255;
          const barHeight = p * height * 0.9;
          ctx2d.fillStyle = `rgba(16,185,129,${(0.35 + p * 0.65).toFixed(3)})`;
          ctx2d.fillRect(i * barWidth + 1, height - barHeight, barWidth - 2, barHeight);
        }
      } catch (e) {
        l2AnimFrame = null; // 单帧异常即自停，不风暴
        return;
      }
      l2AnimFrame = requestAnimationFrame(draw);
    };
    l2AnimFrame = requestAnimationFrame(draw);
  };

  // 候选面板内容（实时候选词）：状态圆点 + 文本
  const l2Cand = (html: string) => {
    if (!l2CandPanel) return;
    l2CandPanel.innerHTML = '<div style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block;margin-right:7px;flex:0 0 auto" aria-hidden="true"></div><div style="flex:1 1 auto;min-width:0;line-height:1.45;word-break:break-all">' + html + '</div>';
  };

  // 候选面板 +（可选）声纹窗口锚定在录音按钮上方；无 canvas（小屏）时面板也照常定位
  const l2AnchorVisualizer = () => {
    try {
      // 锚：行内 🎤（大屏输入框尾部 affix 组 / 旧浮层残留）→ 无则底部居中兜底
      const vb = document.getElementById("aiti-voice-affix") || document.getElementById("aiti-voice-inline");
      const r = vb ? vb.getBoundingClientRect() : null;
      const W = window.innerWidth;
      const panH = l2CandPanel ? (l2CandPanel.offsetHeight || 44) : 44;
      if (r && r.width && r.height) {
        if (l2Visualizer) {
          l2Visualizer.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 150, W - 308)) + "px";
          l2Visualizer.style.top = Math.max(12, r.top - 100 - panH) + "px";
          l2Visualizer.style.bottom = "";
          l2Visualizer.style.transform = "";
        }
        if (l2CandPanel) {
          l2CandPanel.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 150, W - 308)) + "px";
          l2CandPanel.style.top = Math.max(12, r.top - panH - 8) + "px";
          l2CandPanel.style.bottom = "";
          l2CandPanel.style.transform = "";
        }
      } else {
        if (l2Visualizer) { l2Visualizer.style.left = "50%"; l2Visualizer.style.top = ""; l2Visualizer.style.bottom = "160px"; l2Visualizer.style.transform = "translateX(-50%)"; }
        if (l2CandPanel) { l2CandPanel.style.left = "50%"; l2CandPanel.style.top = ""; l2CandPanel.style.bottom = "160px"; l2CandPanel.style.transform = "translateX(-50%)"; }
      }
    } catch {}
  };

  const l2StartVisualizer = (stream: MediaStream, streaming: boolean) => {
    // 新轮开始前先清历史残留（防残留/双面板）：旧轮的 dismiss 定时器带 l2Gen 守卫，
    // 新轮 l2Gen++ 后失效；l2CandPanel/l2Visualizer 引用已被旧面板占用——不清理则
    // 旧面板永远挂着（录音结束仍可见）。按 id 清扫不依赖引用链，
    // 即使引用已被替换也能把一切历史节点删干净。
    try {
      if (l2DismissTimer) { clearTimeout(l2DismissTimer); l2DismissTimer = null; }
      if (l2SafetyTimer) { clearTimeout(l2SafetyTimer); l2SafetyTimer = null; }
      document.querySelectorAll("#aiti-voice-candidates, #aiti-voice-visualizer").forEach((n) => n.remove());
      l2Visualizer = null;
      l2CandPanel = null;
    } catch {}
    // 候选词面板：无条件先建（即使音频图失败也有反馈 UI）
    l2CandPanel = document.createElement("div");
    l2CandPanel.id = "aiti-voice-candidates";
    Object.assign(l2CandPanel.style, {
      position: "fixed", width: "300px", minHeight: "42px", boxSizing: "border-box", padding: "10px 12px",
      background: "rgba(17,24,39,.96)", borderRadius: "14px", border: "1px solid #374151", zIndex: "2147483647",
      boxShadow: "0 10px 30px rgba(0,0,0,.35)", color: "#e5e7eb", fontSize: "15px", display: "flex", alignItems: "center",
    } as Partial<CSSStyleDeclaration>);
    l2Cand('<span style="color:#9ca3af">🎙 ' + (streaming ? "实时识别中…" : "识别中…") + '</span>');
    // 音频图：显式锁 16k context（浏览器内部重采样硬件流）——曾依赖默认采样率 + 线性重采样，
    //   16k 原生麦克风设备下 Chrome 回调内容标称错位 → 时长膨胀 3 倍（慢放人声）→ VAD 切不出句/识别全空；
    //   部分手机浏览器对该字典参数抛错 → 回退无参数创建（l2Resample16k 兼容任意 srcRate）。
    let ok = false;
    try {
      try { l2AudioContext = new AudioContext({ sampleRate: 16000 }); }
      catch { l2AudioContext = new (window.AudioContext || (window as any).webkitAudioContext)(); }
      const srcRate = l2AudioContext.sampleRate || 48000;
      const source = l2AudioContext.createMediaStreamSource(stream);
      // PCM 采集无条件进行（2-pass 精修用 l2PcmChunks 建 wav）；streaming 只控制额外发 WS 实时出字
      l2Processor = l2AudioContext.createScriptProcessor(4096, 1, 1);
      const mute = l2AudioContext.createGain(); mute.gain.value = 0;
      source.connect(l2Processor);
      l2Processor.connect(mute);
      mute.connect(l2AudioContext.destination);
      (l2Processor as any).onaudioprocess = (e: any) => {
        const gen = l2Gen;
        const ch = e.inputBuffer.getChannelData(0) as Float32Array;
        const pcm = l2Resample16k(ch, srcRate);
        // 输入增益（feature asr.inputGain，1–8×）：只作用于送识别的音频，小声也能识别；硬削波防溢出
        const gain = l2InputGain();
        if (gain > 1) {
          for (let i = 0; i < pcm.length; i++) { const v = pcm[i] * gain; pcm[i] = v > 1 ? 1 : (v < -1 ? -1 : v); }
        }
        // 必须拷贝：inputBuffer 的通道数组在回调返回后会被浏览器复用，直接存会在 2-pass 时拿错数据
        l2PcmChunks.push(pcm.slice());
        // 服务端 VAD 一体化（/ws/vad）就绪：PCM 实时发服务端，分段/识别/精修全在服务端，本地不再切句
        if (l2VadWs && l2VadWs.readyState === WebSocket.OPEN && gen === l2Gen && !l2Canceled) {
          const int16 = l2ToInt16(pcm);
          try { l2VadWs.send(int16.buffer); } catch {}
          return;   // 服务端负责一切，跳过本地 RMS 切句/HTTP（l2VadOn 分支不再执行）
        }
        // 仅流式（实时出字）时把 PCM 发 WS；非流式只采集供 2-pass，不实时出字
        if (streaming && l2Ws && l2Ws.readyState === WebSocket.OPEN && gen === l2Gen && !l2Canceled) {
          const int16 = l2ToInt16(pcm);
          try { l2Ws.send(int16.buffer); } catch {}
        }
        // ---- VAD 停顿切句（伪实时分句模式）：静音累计超阈值 → 提交本句 → SenseVoice 秒出上屏 ----
        if (l2VadOn() && gen === l2Gen && !l2QuickBusy && !l2VadFired) {
          let rms = 0;
          for (let i = 0; i < pcm.length; i++) { const s = pcm[i]; rms += s * s; }
          rms = Math.sqrt(rms / pcm.length);
          l2RmsNow = rms;
          const frameMs = 4096 / 16000 * 1000;  // 每帧时长（256ms @ 16k）
          if (rms < l2VadRmsThr()) {
            l2VadSilenceMs += frameMs;
            const nowMs = Date.now();
            // 智能切句条件：静音够长 + 本句有效语音≥最小（短句不切，避免短句也发 quick）+ 距上次够久
            if (l2VadSilenceMs >= L2_VAD_SILENCE_MS && l2VadSpeechMs >= L2_VAD_MIN_SPEECH_MS
              && l2SentIdx < l2PcmChunks.length - 1 && (nowMs - l2SentStartAt) >= L2_VAD_MIN_GAP_MS) {
              l2VadFired = true;
              l2VadSilenceMs = 0;
              l2VadSpeechMs = 0;   // 本句已切，语音累计复位
              void l2QuickCommit(gen).then((ok) => { if (gen === l2Gen) { l2VadFired = false; l2SentStartAt = Date.now(); } });
            }
          } else {
            l2VadSilenceMs = 0;  // 有声：重置静音计时
            l2VadSpeechMs += frameMs;  // 累计有效语音时长（判断短句用）
          }
        }
      };
      l2Analyser = l2AudioContext.createAnalyser();
      l2Analyser.fftSize = 2048;
      source.connect(l2Analyser);
      ok = true;
    } catch (e) {
      try { console.warn("[AI input] L2 ASR 音频图初始化失败，改走 webm 兑底", e); } catch {}
      l2UseStreaming = false; // 流式采集不可用 → 松手走 webm 兑底，杜绝「什么都没发生」
    }
    // 声纹 canvas：小屏也显示（已限帧≈24fps + try/catch 自保，不会卡死）；只在音频图成功时建
    if (ok) {
      l2Visualizer = document.createElement("canvas");
      l2Visualizer.id = "aiti-voice-visualizer";
      Object.assign(l2Visualizer.style, {
        position: "fixed", width: "300px", height: "90px", background: "#111827", borderRadius: "16px",
        border: "1px solid #374151", zIndex: "2147483647", boxShadow: "0 10px 30px rgba(0,0,0,.35)", display: "block",
      } as Partial<CSSStyleDeclaration>);
      l2Visualizer.width = 600; l2Visualizer.height = 180;
      document.body.appendChild(l2Visualizer);
    }
    document.body.appendChild(l2CandPanel);
    l2AnchorVisualizer(); // 先挂 DOM 再定位，offsetHeight 才准（不再监听 resize，避免移动端 resize 风暴）
    if (l2Visualizer) l2DrawWaveform();
  };

  const l2CloseWs = () => {
    if (l2Ws) { try { l2Ws.onmessage = l2Ws.onopen = l2Ws.onerror = l2Ws.onclose = null; if (l2Ws.readyState < 2) l2Ws.close(); } catch {} l2Ws = null; }
    if (l2VadWs) { try { l2VadWs.onmessage = l2VadWs.onopen = l2VadWs.onerror = l2VadWs.onclose = null; if (l2VadWs.readyState < 2) l2VadWs.close(); } catch {} l2VadWs = null; }
    l2StreamReady = false;
    l2VadWsOn = false;
  };

  const l2StopVisualizer = () => {
    if (l2AnimFrame) { try { cancelAnimationFrame(l2AnimFrame); } catch {} l2AnimFrame = null; }
    if (l2Visualizer) { try { l2Visualizer.remove(); } catch {} l2Visualizer = null; }
    if (l2CandPanel) { try { l2CandPanel.remove(); } catch {} l2CandPanel = null; }
    // 兜底清扫：引用可能已被下一轮替换（遗留节点用 remove 引用删不掉），按 id 全清
    try { document.querySelectorAll("#aiti-voice-candidates, #aiti-voice-visualizer").forEach((n) => n.remove()); } catch {}
    if (l2Processor) { try { (l2Processor as any).onaudioprocess = null; l2Processor.disconnect(); } catch {} l2Processor = null; }
    if (l2AudioContext && l2AudioContext.state !== "closed") { try { l2AudioContext.close(); } catch {} l2AudioContext = null; l2Analyser = null; }
    l2CloseWs();
    if (l2DismissTimer) { clearTimeout(l2DismissTimer); l2DismissTimer = null; }
    if (l2SafetyTimer) { clearTimeout(l2SafetyTimer); l2SafetyTimer = null; }
  };
  // 兜底：切后台/切走页面且无录音活动 → 面板立即清（后台定时器可能被冻结/延迟，
  // 回来时结果早已上屏，面板还挂着）。录音中切后台不动（回来面板继续显示进度）。
  try {
    document.addEventListener("visibilitychange", () => {
      try { if (document.hidden && !l2Recording && !l2Starting) l2StopVisualizer(); } catch {}
    });
  } catch {}

  // 提交后短暂展示结果再收起面板
  const l2ScheduleDismiss = (gen: number, delay = 1600) => {
    if (l2DismissTimer) { clearTimeout(l2DismissTimer); l2DismissTimer = null; }
    l2DismissTimer = setTimeout(() => { if (gen === l2Gen) l2StopVisualizer(); }, delay);
  };

  // 2-pass 二次识别（离线精修）：全量 PCM → wav → POST /voice-asr2
  const l2RunPass2 = async (gen: number): Promise<string> => {
    if (!l2ApiUrl2 || l2Pass2Busy) return "";
    l2Pass2Busy = true;
    try {
    const wav = l2BuildWav();
    if (!wav) return "";
    return await l2Pass2Fetch(gen, wav);
    } finally { l2Pass2Busy = false; }
  };

  // 分句 2-pass（每句独立精修）：wav 由句级快照构建，各自异步、结果按句序存
  const l2RunPass2Seg = async (gen: number, wav: Blob): Promise<string> => {
    if (!l2ApiUrl2) return "";
    return await l2Pass2Fetch(gen, wav);
  };

  // 2-pass 请求本体（不分句/分句共用）：wav blob → POST /voice-asr2
  const l2Pass2Fetch = async (gen: number, wav: Blob): Promise<string> => {
    try {
      const fd = new FormData();
      fd.append("audio", wav, "voice.wav");
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      // 当前 workspace cwd 走 header（不进 URL/body——access log 不落盘路径）
      const cwd = AC.extra && typeof (AC.extra as any).cwd === "string" ? (AC.extra as any).cwd : "";
      const r = await fetch(l2ApiUrl2, {
        method: "POST", body: fd, signal: ctrl.signal,
        headers: cwd ? { "x-aiti-cwd": cwd } : undefined,
      });
      clearTimeout(to);
      if (!r.ok) return "";
      const d = await r.json();
      return (d && d.text ? String(d.text) : "").trim();
    } catch (e) { return ""; }
  };

  // 伪实时分句提交：把 [l2SentIdx..] 的 PCM 发 /voice-quick（SenseVoice 秒出）→ 接续上屏。
  // 返回是否成功上屏（供 VAD 循环/松手收尾判断）。
  const l2QuickCommit = async (gen: number): Promise<boolean> => {
    if (!l2ApiQuick || l2QuickBusy || gen !== l2Gen) return false;
    if (l2SentIdx >= l2PcmChunks.length) return false; // 无新内容
    const startIdx = l2SentIdx;
    // 快照终点：切句时只提交到当前已采集处；后续新 PCM 留到下一句（防重叠重复识别）
    const endIdx = l2PcmChunks.length;
    const wav = l2BuildWav(startIdx, endIdx);
    if (!wav) return false;
    // 智能保护：极短音频（空按/白噪）不提交 quick——整段留给 2-pass，避免无意义请求
    try {
      const wavMs = (endIdx - startIdx) * 4096 / 16000 * 1000;
      if (wavMs < L2_QUICK_MIN_WAV_MS) return false;
    } catch { /* 时长计算失败不拦截 */ }
    l2QuickBusy = true;
    // 句号自增：quick 结果与分句精修结果都按此句号存（防异步乱序）
    const segIdx = l2SentSeq++;
    l2SentTexts[segIdx] = "";   // 占位（精修/quick 返回后填充）
    // 分句即 2-pass 精修（独立一句，输入短 → 快且准；结果按句序拼接）——不与 quick 抢串行，异步发
    void (async () => {
      try {
        l2Pass2RefillBusy++;
        const text = await l2RunPass2Seg(gen, wav);
        if (gen === l2Gen && text) {
          l2Pass2Texts[segIdx] = text;
          // 分句精修完成：候选从「待精修」更新为「✓ 精修」预览
          const joined = l2SentTexts.map((t, i) => l2Pass2Texts[i] || t).filter(Boolean).join(" ");
          l2Cand('<span style="color:#9ca3af">🎙 已识别（逐句精修）</span><div style="font-size:12.5px;color:#d1d5db;margin-top:4px;white-space:pre-wrap">' + esc(joined) + '</div>');
        }
      } finally { l2Pass2RefillBusy--; }
    })();
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      const cwd = AC.extra && typeof (AC.extra as any).cwd === "string" ? (AC.extra as any).cwd : "";
      const fd = new FormData();
      fd.append("audio", wav, "voice.wav");
      const r = await fetch(l2ApiQuick, {
        method: "POST", body: fd, signal: ctrl.signal,
        headers: cwd ? { "x-aiti-cwd": cwd } : undefined,
      });
      clearTimeout(to);
      if (!r.ok) return false;
      const d = await r.json();
      const text = (d && d.text ? String(d.text) : "").trim();
      if (text && gen === l2Gen) {
        // 不上屏：只进候选（待输入）——断句伪实时预览；精修在途/finished 由分句精修更新
        l2SentTexts[segIdx] = text;
        const joined = l2SentTexts.map((t, i) => l2Pass2Texts[i] || t).filter(Boolean).join(" ");
        l2Cand('<span style="color:#9ca3af">🎙 已识别（待精修）</span><div style="font-size:12.5px;color:#d1d5db;margin-top:4px;white-space:pre-wrap">' + esc(joined) + '</div>');
      }
      // 成功提交：推进到快照终点（不重叠下一句）
      if (gen === l2Gen) l2SentIdx = Math.max(l2SentIdx, endIdx);
      return !!text;
    } catch (e) {
      return false;
    } finally {
      l2QuickBusy = false;
    }
  };

  // 兑底路径：音频 → POST /voice-asr2（WS 未就绪/关流式/流式失败时）
  // 音源优先 WAV（全量 PCM 缓冲拼）：云引擎（硅基流动/百度）不吃 webm，全链 WAV 免转码；
  // PCM 不可用（音频图初始化失败）才退回 MediaRecorder 的 webm 兑底。
  const l2WebmFallback = async (gen: number) => {
    const wavFb = l2BuildWav();
    const blob = wavFb && wavFb.size ? wavFb : new Blob(l2Chunks, { type: l2Mime });
    const fbName = wavFb && wavFb.size ? "voice.wav" : "voice.webm";
    if (!blob.size || !l2ApiUrl2) { if (gen === l2Gen && !l2Committed) l2ScheduleDismiss(gen, 300); return ""; }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12000);
      try {
        const fd = new FormData();
        fd.append("audio", blob, fbName);
        // 兑底路径同样带 cwd（per-ws 热词一致性——否则落到 __default__ 档）
        const cwdF = AC.extra && typeof (AC.extra as any).cwd === "string" ? (AC.extra as any).cwd : "";
        const r = await fetch(l2ApiUrl2, { method: "POST", body: fd, signal: ctrl.signal, headers: cwdF ? { "x-aiti-cwd": cwdF } : undefined });
        clearTimeout(to);
        if (!r.ok) throw new Error("http" + r.status);
        const d = await r.json();
        const text = (d && d.text ? String(d.text) : "").trim();
        if (gen === l2Gen) { l2Commit(text); if (text) l2Cand('<b style="color:#10b981">✓ ' + esc(text) + '</b>'); }
        return text;
      } catch (e) {
        clearTimeout(to);
        if (attempt < 2) await new Promise((res) => setTimeout(res, 500));
      }
    }
    return "";
  };

  const l2OpenWs = (gen: number) => {
    if (!l2WsUrl) { l2UseStreaming = false; return; }
    try {
      l2Ws = new WebSocket(l2WsUrl);
      l2Ws.binaryType = "arraybuffer";
      l2Ws.onopen = () => { /* ready 由服务端控制帧告知 */ };
      l2Ws.onmessage = (ev) => {
        if (gen !== l2Gen || typeof ev.data !== "string") return;
        let m: any; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "ready") {
          l2StreamReady = true;
          l2Cand('<span style="color:#9ca3af">🎙 实时识别中…</span>');
        } else if (m.type === "partial") {
          const t = String(m.text || "").trim();
          if (t) l2Cand('<span style="color:#e5e7eb">' + esc(t) + '<span style="color:#10b981">▌</span></span>');
        } else if (m.type === "final") {
          const t = String(m.text || "").trim();
          l2CloseWs();
          if (t) l2OnStreamFinal(gen, t); else if (gen === l2Gen && !l2Committed) l2ScheduleDismiss(gen, 300);
        } else if (m.type === "error") {
          try { console.warn("[AI input] ASR 流式错误", m.message); } catch {}
        }
      };
      l2Ws.onerror = () => {};
      l2Ws.onclose = () => {};
    } catch (e) { l2UseStreaming = false; }
  };

  // ---- 服务端 VAD 一体化 WS（/ws/vad：分段+识别+精修全服务端；高于本地 RMS 链路）----
  const l2OpenVadWs = (gen: number) => {
    if (!l2VadWsUrl) return false;
    try {
      const ws = new WebSocket(l2VadWsUrl);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        // 上报 workspace cwd → 服务端算 ws key → 取该 workspace 热词（精修 context/hotword 偏置）
        try {
          const cwdS = AC.extra && typeof (AC.extra as any).cwd === "string" ? (AC.extra as any).cwd : "";
          ws.send(JSON.stringify({ type: "init", ws: cwdS }));
        } catch {}
      };   // ready 由服务端控制帧告知
      ws.onmessage = (ev) => {
        if (gen !== l2Gen || typeof ev.data !== "string") return;
        let m: any; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "ready") {
          l2VadWsOn = true;
          l2Cand('<span style="color:#9ca3af">🎙 实时识别中…</span>');
        } else if (m.type === "seg_quick") {
          // VAD 检出句 → 服务端 SenseVoice 秒出（伪实时候选）
          const q = String(m.quick || "").trim();
          if (!q) return;
          const idx = Number(m.idx ?? l2VadSegs.length);
          l2VadSegs[idx] = l2VadSegs[idx] || { quick: "", refined: "" };
          l2VadSegs[idx].quick = q;
          const joined = l2VadSegs.map((s) => s.quick || s.refined || "").filter(Boolean).join(" ");
          l2Cand('<span style="color:#9ca3af">🎙 已识别（服务端精修中）</span><div style="font-size:12.5px;color:#d1d5db;margin-top:4px;white-space:pre-wrap">' + esc(joined) + '</div>');
        } else if (m.type === "seg_refined") {
          // 该句 Qwen3 精修完成 → 更新候选
          const r = String(m.refined || "").trim();
          if (!r) return;
          const idx = Number(m.idx ?? l2VadSegs.length);
          l2VadSegs[idx] = l2VadSegs[idx] || { quick: "", refined: "" };
          l2VadSegs[idx].refined = r;
          const joined = l2VadSegs.map((s) => s.refined || s.quick || "").filter(Boolean).join(" ");
          l2Cand('<span style="color:#9ca3af">🎙 已识别（逐句精修）</span><div style="font-size:12.5px;color:#d1d5db;margin-top:4px;white-space:pre-wrap">' + esc(joined) + '</div>');
        } else if (m.type === "done") {
          try { console.log("[AI input] VAD done 到达：gen匹配=" + (gen === l2Gen) + " 段数=" + (Array.isArray(m.segments) ? m.segments.length : -1)); } catch {}
          if (l2VadDone || gen !== l2Gen) return;
          l2VadDone = true;
          const segs = Array.isArray(m.segments) ? m.segments as Array<{ quick?: string; refined?: string }> : [];
          const final = segs.map((s) => (s.refined || s.quick || "").trim()).filter(Boolean).join(" ");
          if (final) {
            l2Cand('<b style="color:#10b981">✓ ' + esc(final) + '</b>');
            l2Commit(final);
          } else {
            l2ScheduleDismiss(gen, 300);
          }
          l2ScheduleDismiss(gen, 1200);
          try { ws.close(); } catch {}
        } else if (m.type === "error") {
          try { console.warn("[AI input] ASR VAD 错误", m.message); } catch {}
        }
      };
      ws.onerror = () => {};   // 失败不阻塞（录音继续，回退本地 RMS 链路）
      ws.onclose = () => {};
      l2VadWs = ws;
      return true;
    } catch (e) {
      try { console.warn("[AI input] VAD WS 建立失败", e); } catch {}
      return false;
    }
  };

  // 流式 final：作为实时结果即时展示；有 2-pass 则稍延后离线精修再上屏
  const l2OnStreamFinal = (gen: number, text: string) => {
    if (gen !== l2Gen || l2Committed) { l2ScheduleDismiss(gen, 300); return; }
    if (l2Pass2Enabled && text) {
      // 实时开着但 2-pass 精修仍要：松手立即精修（PASS2_DELAY_MS=0），不等流式粗糙文本
      l2Cand('<span style="color:#e5e7eb">' + esc(text) + '</span><div style="font-size:12px;color:#9ca3af;margin-top:3px">✍ 二次识别…</div>');
      l2DismissTimer = setTimeout(async () => {
        if (gen !== l2Gen || l2Committed) return;
        const refined = await l2RunPass2(gen);
        if (gen !== l2Gen) return;
        const final = refined || text;
        l2Cand('<b style="color:#10b981">✓ ' + esc(final) + '</b>');
        l2Commit(final);
        l2ScheduleDismiss(gen, 1600);
      }, PASS2_DELAY_MS);
    } else {
      l2Cand('<b style="color:#10b981">✓ ' + esc(text) + '</b>');
      l2Commit(text);
      l2ScheduleDismiss(gen, 1600);
    }
  };

  const l2StartRecord = async () => {
    if (l2Recording || l2Starting) return;
    l2Starting = true;
    l2StopRequested = false;
    l2Canceled = false;
    l2StreamReady = false;
    // 实时引擎决策：asr.model.stream = SenseVoice（默认）→ 伪实时分句（VAD 切句+秒出），
    // 不开 WS；= paraformer → 老 chunk WS 流式（asr.streaming 开时）。
    const realtimeModel = String((AC.feats as any).asrModelStream || "iic/SenseVoiceSmall");
    const engineSense = realtimeModel.indexOf("SenseVoice") >= 0 || realtimeModel.indexOf("sensevoice") >= 0;
    l2UseStreaming = l2StreamingOn() && !engineSense;   // WS 仅 paraformer 引擎
    l2Pass2Enabled = AC.feats.asrPass2 !== false;
    // 伪实时分句：引擎 SenseVoice 且 asr.split 开（或引擎 paraformer 但 streaming 关且 split 开→兼容旧选）
    l2SplitEnabled = (AC.feats as any).asrSplit !== false && (engineSense || !l2StreamingOn());
    // SenseVoice 引擎永不建 WS（服务端 WS 是 paraformer chunk 流，模型不匹配）
    if (engineSense) l2UseStreaming = false;
    l2PcmChunks = [];
    l2Committed = false;
    l2VadFired = false;
    l2VadSilenceMs = 0;
    l2VadSpeechMs = 0;    // 新一轮：本句有效语音累计复位
    l2SentIdx = 0;
    l2QuickBusy = false;
    l2SentTexts = [];
    l2Pass2Texts = [];
    l2SentSeq = 0;
    l2Pass2RefillBusy = 0;
    l2SplitFinalizing = false;
    l2SentStartAt = Date.now();
    l2Gen++;
    const gen = l2Gen;
    // 自愈探测：异步不阻塞录音——服务未运行则服务端自动拉起，面板提示本次走兑底
    try { void l2EnsureAsr(gen); } catch {}
    const ta = document.querySelector("textarea[data-chat-input]");
    if (!ta) { l2Starting = false; return; }
    let stream: MediaStream | null = null;
    try {
      // 显式开启浏览器内置降噪/回声消除/自动增益（Chrome 桌面端约束生效，手机端部分忽略但无害）
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
    } catch (e) {
      // 部分浏览器/设备不支持约束对象 → 降级无约束录音（保证功能可用）
      try { console.warn("[AI input] L2 ASR 录音权限被拒（带约束），降级重试", e); } catch {}
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e2) {
        try { console.warn("[AI input] L2 ASR 录音权限被拒", e2); } catch {}
        l2Starting = false;
        return;
      }
    }
    if (l2StopRequested) {
      stream?.getTracks().forEach((t) => t.stop());
      l2Starting = false;
      l2Canceled = false;
      return;
    }
    try {
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4");
      l2Mime = mime;
      l2MediaRecorder = new MediaRecorder(stream, { mimeType: mime });
      l2Chunks = [];
      l2MediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) l2Chunks.push(e.data); };
      l2MediaRecorder.onstop = async () => {
        stream?.getTracks().forEach((t) => t.stop());
        const canceled = l2Canceled;
        l2Canceled = false;
        if (canceled) {
          l2Recording = false;
          l2CloseWs();
          if (gen === l2Gen) l2StopVisualizer();
          return;
        }
        l2Recording = false;
        // 服务端 VAD 一体化（/ws/vad）：松手发 stop 后由 done 负责拼接上屏，本地不再走任何 HTTP/分句链（防双路竞争）
        if (l2VadWsOn && gen === l2Gen) {
          return;
        }
        if (l2UseStreaming && l2StreamReady) {
          // 实时开着：流式路径已/将负责提交（final 到达 → 2-pass/直接）；这里不动面板
          return;
        }
        // 伪实时分句模式：句已随停顿逐句上屏；松手仅补提「残余尾句」（未停顿就松手的内容）。
        // 快速结束（无 VAD 停顿切句）→ 不提交尾句 quick，直接整段 2-pass（避免「按一下就发 3 次 quick」）。
        if (l2SplitEnabled && (l2SentTexts.length > 0 || l2SentIdx > 0)) {
          // 尾句：可能 VAD 提交在途或刚完成——短暂让出再提交剩余
          await new Promise((r) => setTimeout(r, l2QuickBusy ? 400 : 50));
          const ok = await l2QuickCommit(gen);  // 尾句：伪实时识别进候选（不进精修——尾句由整段精修兑底？不：尾句也进分句精修）
          if (gen !== l2Gen) return;
          l2SplitFinalizing = true; // 精修在途：safetyTimer 6s 后不再走 webm 兑底（避免二次上屏）
          // 组装最终文本 = 逐句 2-pass 精修结果（按句序），未完成/失败的句用 quick 结果兑底
          // ——与「整段再精修一遍」不同：每句独立精修，输入短 → 快且准；长录音不再整段一次吃满。
          l2Cand('<span style="color:#9ca3af">✍ 2-pass 精修中…</span>');
          // 等所有在途分句精修收尾（每句独立请求，串行 Qwen3）；最多额外等 12s
          const waitt = Date.now() + 12000;
          while (l2Pass2RefillBusy > 0 && Date.now() < waitt) {
            await new Promise((r) => setTimeout(r, 200));
          }
          if (gen !== l2Gen) return;
          // 按句序拼：分句精修优先，缺的句用 quick 结果兑底（保持顺序，不丢句）
          const segs: string[] = [];
          const segCount = Math.max(l2Pass2Texts.length, l2SentTexts.length);
          for (let i = 0; i < segCount; i++) {
            const t = (l2Pass2Texts[i] || l2SentTexts[i] || "").trim();
            if (t) segs.push(t);
          }
          const final = segs.join(" ");
          if (final) {
            l2Cand('<b style="color:#10b981">✓ ' + esc(final) + '</b>');
            l2Commit(final);   // l2Committed 在此才置 true（l2Commit 内部）——真正上屏
            l2ScheduleDismiss(gen, 1600);
          } else {
            l2ScheduleDismiss(gen, 300);
          }
          return;
        }
        // 非分句（或快速结束无切句）：直接走 2-pass（voice-asr2 → 8767 Qwen3），不等流式/旧模型兑底
        // ——实时出字质量差已弃用（asr.streaming 默认关），录音结束即精修上屏。
        const refined = await l2RunPass2(gen);
        const final = refined || (await l2WebmFallback(gen));
        if (!final) { /* 精修失败（服务未起）→ webmFallback 也到旧模型兑底，兜底 */ }
        if (gen === l2Gen && final) {
          l2Cand('<b style="color:#10b981">✓ ' + esc(final) + '</b>');
          l2Commit(final);
          l2ScheduleDismiss(gen, 1600);
        } else if (gen === l2Gen) {
          l2ScheduleDismiss(gen, 300);
        }
      };
      l2Recording = true;
      l2Starting = false;
      l2MediaRecorder.start();
      l2StartVisualizer(stream, l2UseStreaming);
      // 优先服务端 VAD 一体化（/ws/vad）；VAD WS 建立成功 → 服务端分段+识别+精修，本地不再切句
      // 失败/无服务 → 回退 l2OpenWs（paraformer 流式）或本地 RMS+HTTP 链路
      // ⚠ WS 必须先建（不等 ensure）：ensure 含热词懒拉（All Sessions 提取，秒级）——曾 await 后才建 WS，
      //   按住说话的前半段全部丢弃（WS OPEN 前不采发）→ 只剩尾部碎片进 VAD → done segments=[] 全空。
      //   改为 WS 先行 + ensure 并行：热词晚几秒生效（下句/下次会话用上），不阻塞实时链路。
      l2VadWsOn = false;
      l2VadDone = false;
      l2VadSegs = [];
      const vadOk = l2OpenVadWs(gen);
      if (!vadOk) { if (l2UseStreaming) l2OpenWs(gen); }
      void l2EnsureAsr(gen).catch(() => {});   // 并行：服务自愈 + 热词推送（不阻塞录音/WS）
      if (l2StopRequested) { try { l2MediaRecorder.stop(); } catch {} }
      // 60s 上限自动收尾：走完整 stop 流程（发 WS stop → final → 2-pass/兑底），而非只停 recorder
      setTimeout(() => { if (l2Recording && l2MediaRecorder && l2MediaRecorder.state === "recording") l2StopRecord(false); }, L2_MAX_SECONDS * 1000);
    } catch (e) {
      try { console.warn("[AI input] L2 ASR 启动失败", e); } catch {}
      l2Recording = false;
      l2Starting = false;
      l2StopVisualizer();
    }
  };

  // 自愈探测（async fire-and-forget）：running → 正常；starting/failed → 面板提示（录音流程照旧走兑底）
  const l2EnsureAsr = async (gen: number) => {
    if (!l2ApiEnsure) return;
    let d: any = null;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 6000);
      // 当前 workspace cwd 走 POST body（不进 URL/日志；服务端据此派生 ws 哈希 + 路径过滤）
      const cwd = AC.extra && typeof (AC.extra as any).cwd === "string" ? (AC.extra as any).cwd : "";
      const r = await fetch(l2ApiEnsure, {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: cwd ? JSON.stringify({ cwd }) : "{}",
      });
      clearTimeout(to);
      d = await r.json().catch(() => null);
    } catch (e) {
      try { console.warn("[AI input] ASR ensure 失败", e); } catch {}
      return;
    }
    if (gen !== l2Gen || !d || !l2CandPanel) return;
    if (d.running) return; // 服务正常（流式自行建立）
    if (d.starting) {
      l2Cand('<span style="color:#fbbf24">🔄 ASR 服务未运行，已自动拉起…</span>' +
        '<div style="font-size:12px;color:#9ca3af;margin-top:3px">本次走兜底识别；启动日志见 ⚡命令 面板</div>');
    } else {
      l2Cand('<span style="color:#f87171">⚠ ASR 服务不可用（' + esc(d.error || "未知") + '）</span>' +
        '<div style="font-size:12px;color:#9ca3af;margin-top:3px">本次走兜底识别；可在 ⚡命令 面板手动启动</div>');
    }
  };

  const l2StopRecord = (cancel = false) => {
    l2StopRequested = true;
    if (cancel) l2Canceled = true;
    const gen = l2Gen;
    // 服务端 VAD 一体化：stop → 服务端收尾（done 由 onmessage 处理并上屏）；cancel → reset 丢弃。
    // ⚠ 松手必须可靠发 stop——曾因 gen 条件静默跳过，服务端等不到收尾白等 6~10s 才出结果（卡住体感）。
    if (l2VadWs && l2VadWs.readyState === WebSocket.OPEN) {
      try {
        l2VadWs.send(JSON.stringify(cancel ? { type: "reset" } : { type: "stop" }));
        try { console.log("[AI input] VAD stop 已发送（cancel=" + cancel + "）"); } catch {}
      } catch {}
    } else {
      try { console.warn("[AI input] VAD stop 未发：ws 状态=" + (l2VadWs ? l2VadWs.readyState : "null")); } catch {}
    }
    // 流式：stop → 服务端触发 final；cancel → reset 丢弃；松手后仍需 final 到达才收尾
    if (l2Ws && l2Ws.readyState === WebSocket.OPEN) {
      try { l2Ws.send(JSON.stringify(cancel ? { type: "reset" } : { type: "stop" })); } catch {}
    }
    if (l2MediaRecorder && l2MediaRecorder.state === "recording") {
      try { l2MediaRecorder.stop(); } catch {}
    }
    // 兜底：流式 final 迟迟不来（空话/掉线）→ 最多 6s 后走 webm 兑底并收起
    // （VAD 一体化链路由 done 处理；若 done 未到 6s 后本兜底触发——vadDone 未置时才会）
    if (!cancel) {
      if (l2SafetyTimer) { clearTimeout(l2SafetyTimer); l2SafetyTimer = null; }
      l2SafetyTimer = setTimeout(() => {
        // 分句收尾精修在途：跳过兑底（避免与 2-pass 结果二次上屏）
        if (gen === l2Gen && !l2Committed && !l2VadDone && !l2VadWsOn && !l2SplitFinalizing && !l2Pass2Busy && l2Recording === false) {
          l2WebmFallback(gen).then(() => { if (gen === l2Gen) l2ScheduleDismiss(gen, 1600); });
        }
      }, 6000);
    }
  };
  const l2CancelRecord = () => l2StopRecord(true);
  // 强一致力收尾（同步）：立即摘声纹窗口 + 停录音 + 关 WS，不等在途流程（press-to-talk 释放用）
  const l2Cleanup = () => {
    l2StopRequested = true;
    if (l2MediaRecorder && l2MediaRecorder.state === "recording") { try { l2MediaRecorder.stop(); } catch {} }
    l2CloseWs();
    l2StopVisualizer();
  };
  (window as any).__aitiVoiceInputL2 = {
    start: l2StartRecord,
    stop: l2StopRecord,
    cancel: l2CancelRecord,
    recording: () => l2Recording,
    cleanup: l2Cleanup,
  };
} catch (e) {}
}
