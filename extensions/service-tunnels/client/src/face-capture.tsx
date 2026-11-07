/**
 * 人脸 2FA 管理端直接采集弹窗 —— 不启动门户进程，纯数据层。
 *
 * 流程（与门户 /enroll 采集页同一套逻辑，搬进管理 UI）：
 *   1. biometric-assets-ensure → 确保 face-api.js + 模型已下载（首次 ~8.4MB）
 *   2. 动态加载 face-assets/face-api.js + 3 个模型（tinyFaceDetector/
 *      faceLandmark68Net/faceRecognitionNet）
 *   3. getUserMedia 摄像头（可选设备/前摄镜像）→ 150ms 循环 detectSingleFace
 *   4. canvas 叠加人脸虚框 + 68 点 landmark（检测到实时可见）
 *   5. EAR 眨眼检测（动态基线：前 12 帧中位数 ×0.7，下限 0.15）→ 3 次眨眼
 *      各收一帧 128d 描述子
 *   6. POST biometric-enroll-face { samples } → 模板 pending（首验转正）
 *
 * 摄像头细节：
 *   - enumerateDevices 枚举 videoinput → 下拉切换（>1 个时显示）
 *   - getSettings().facingMode：user=前摄 → video+canvas 镜像（scaleX(-1)），
 *     避免“头像左右颠倒”的镜面错觉（face-api 无镜像处理，需自绘侧处理）
 */
import { useEffect, useRef, useState } from "react";
import { apiUrl, BASE_PATH, extSvc } from "./host-shim";
import { dismissOnBack } from "../../../_shared/overlay-back-client";

export function FaceCaptureModal({ name, provider, site, t, mode = "enroll", onClose, onDone }: {
  name: string;
  provider?: string;
  /** 目标站点（认证域）——必须显式传，否则服务端默认落 default 站点！ */
  site?: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** enroll=注册（张嘴 3 次）；verify=验证（张嘴 1 次） */
  mode?: "enroll" | "verify";
  onClose: () => void;
  onDone: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mirroredRef = useRef(true); // 前摄镜像（loop 闭包经此读实时值）
  const streamRef = useRef<MediaStream | null>(null);
  const stRef = useRef({ vectors: [] as number[][], mouthCount: 0, prevClosed: false, baseline: [] as number[], posting: false, diag: { found: false, mar: 0, base: 0, err: "", hist: [] as number[] } });
  const [cams, setCams] = useState<Array<{ id: string; label: string }>>([]);
  const [camId, setCamId] = useState("");
  const [facing, setFacing] = useState("");
  const [progress, setProgress] = useState(0);
  const [diag, setDiag] = useState<{ found: boolean; mar: number; base: number; err: string; hist: number[] }>({ found: false, mar: 0, base: 0, err: "", hist: [] }); // 实时诊断（500ms 同步）
  const [camError, setCamError] = useState("");        // 摄像头错误（独立，避免与模型加载竞态）
  const [modelStatus, setModelStatus] = useState("loading"); // loading | ready | error
  const [modelError, setModelError] = useState("");
  const [saving, setSaving] = useState(false);
  const target = mode === "verify" ? 1 : 3; // 采集目标帧数：enroll=3 / verify=1
  // 小屏系统返回 = 关闭采集弹窗（与 ✕/关闭同款；仅 open 时挂载）
  useEffect(() => dismissOnBack(() => extSvc("pi-web.overlayBack"), onClose), []);

  // —— 摄像头：枚举 + 切换（camId 变化即重启流）——
  useEffect(() => {
    let cancelled = false;
    const startCam = async () => {
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      setCamError("");
      try {
        // 约束退化链：优先前置（镜像语义）→ 任意摄像头（部分笔记本/USB 摄
        // 像头无 facingMode，facingMode:"user" 会 NotFoundError）
        const tryGum = (video: MediaTrackConstraints) =>
          navigator.mediaDevices.getUserMedia({ video, audio: false });
        let stream: MediaStream | null = null;
        let lastErr: unknown = null;
        try {
          stream = await tryGum(camId ? { deviceId: { exact: camId }, width: { ideal: 640 } } : { facingMode: "user", width: { ideal: 640 } });
        } catch (e) {
          lastErr = e;
          if (!camId) {
            try { stream = await tryGum({ width: { ideal: 640 } }); } catch (e2) { lastErr = e2; }
          }
        }
        if (!stream) throw lastErr ?? new Error("no camera");
        if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        streamRef.current = stream;
        const s = stream.getVideoTracks()[0]?.getSettings();
        // facingMode：user=前置（镜像），environment=后置；旧设备可能无此字段
        const f = s?.facingMode === "environment" ? "environment" : "user";
        setFacing(f);
        mirroredRef.current = f === "user";
        const v = videoRef.current;
        if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
      } catch (e) {
        setCamError(t("services.bioFaceCamError") + String((e as Error).message ?? e));
      }
    };
    startCam();
    navigator.mediaDevices.enumerateDevices()
      .then((devs) => {
        const vids = devs
          .filter((d) => d.kind === "videoinput")
          .map((d, i) => ({ id: d.deviceId, label: d.label || `${t("services.bioFaceCam")} ${i + 1}` }));
        setCams(vids);
        // 当前选中设备消失（拔出等）→ 回默认
        if (camId && !vids.some((d) => d.id === camId)) setCamId("");
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camId]);

  // —— face-api 加载 + 检测循环（一次）——
  useEffect(() => {
    let cancelled = false;
    const st = stRef.current;

    const action = mode === "verify" ? "biometric-verify-face" : "biometric-enroll-face";
    const postResult = async () => {
      const res = await fetch(apiUrl("/api/extensions/service-tunnels/status"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name, provider, site, samples: st.vectors }),
      }).then((r) => r.json()) as { pending?: boolean; matched?: boolean; distance?: number; error?: string };
      if (res.error) throw new Error(res.error);
      return res;
    };

    const loop = (faceapi: FaceApiNS) => {
      const tick = async () => {
        if (cancelled || st.posting) return;
        const v = videoRef.current;
        const cv = canvasRef.current;
        if (!v || !cv) { setTimeout(tick, 120); return; }
        try {
          if (v.readyState < 2 || !v.videoWidth) { setTimeout(tick, 120); return; }
          const det = await faceapi
            .detectSingleFace(v, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (det) {
            let drawErr = "";
            try {
              draw(faceapi, cv, det, mirroredRef.current);
            } catch (e) { drawErr = String((e as Error).message ?? e); }
            // MAR（Mouth Aspect Ratio）张嘴检测——嘴部 20 点 landmark，位移大、
            // 不受眼镜/眯眼影响，比眨眼（EAR）可靠得多
            const mar = marOf(det.landmarks.getMouth());
            st.diag.found = true;
            st.diag.mar = mar;
            st.diag.err = drawErr;
            st.diag.hist.push(mar);
            if (st.diag.hist.length > 12) st.diag.hist.shift();
            // 动态闭嘴基线：全帧滑动窗口取 30% 分位（闭嘴帧占多数，张嘴帧被剔除）
            // → 张嘴阈值 = 闭嘴基线 + 0.15（固定加量，避免乘法对高基线放大过度）。
            // 实测用户闭嘴 MAR≈0.60、张嘴≈0.81（嘴部 landmark 尺度大），×1.7 会算出 1.02 永不触发
            st.baseline.push(mar);
            if (st.baseline.length > 30) st.baseline.shift();
            const sorted = [...st.baseline].sort((a, b) => a - b);
            const q = sorted[Math.floor(sorted.length * 0.3)] ?? 0.4;
            const base = Math.max(0.4, q + 0.15);
            st.diag.base = base;
            const closed = mar >= base; // 张嘴 = mar 超阈值
            // 闭嘴→张嘴 记一次张嘴（prevClosed 去抖）
            if (closed && !st.prevClosed) {
              st.mouthCount++;
              st.vectors.push(Array.from(det.descriptor));
              setProgress(st.mouthCount);
              if (st.mouthCount >= target) {
                st.posting = true;
                setSaving(true);
                try {
                  await postResult();
                  streamRef.current?.getTracks().forEach((tr) => tr.stop());
                  onDone();
                } catch (e) {
                  setCamError(String((e as Error).message ?? e));
                  st.posting = false;
                  setSaving(false);
                }
                return;
              }
            }
            st.prevClosed = closed;
          } else {
            st.diag.found = false;
            const ctx = cv.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
          }
        } catch (e) {
          st.diag.err = String((e as Error).message ?? e);
        }
        setTimeout(tick, 60);
      };
      tick();
    };

    const run = async () => {
      try {
        const ensureRes = await fetch(apiUrl("/api/extensions/service-tunnels/status"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "biometric-assets-ensure" }),
        }).then((r) => r.json()) as { error?: string };
        if (ensureRes.error) throw new Error(ensureRes.error);
        const base = `${BASE_PATH}/api/extensions/service-tunnels/face-assets/`;
        await loadScript(base + "face-api.js");
        const faceapi = (window as unknown as { faceapi?: FaceApiNS }).faceapi;
        if (!faceapi) throw new Error("face-api load failed");
        await faceapi.tf.ready();
        await faceapi.nets.tinyFaceDetector.loadFromUri(base + "models/");
        await faceapi.nets.faceLandmark68Net.loadFromUri(base + "models/");
        await faceapi.nets.faceRecognitionNet.loadFromUri(base + "models/");
        if (cancelled) return;
        setModelStatus("ready");
        loop(faceapi);
      } catch (e) {
        setModelStatus("error");
        setModelError(String((e as Error).message ?? e));
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 诊断同步：500ms 从 ref 拉到 state 显示 ——
  useEffect(() => {
    const iv = setInterval(() => {
      const d = stRef.current.diag;
      setDiag({ found: d.found, mar: d.mar, base: d.base, err: d.err, hist: [...d.hist] });
    }, 500);
    return () => clearInterval(iv);
  }, []);

  const mirrored = facing === "user"; // 前置摄像头：镜像显示（与真人照镜子一致）
  const errText = camError || modelError;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 }} onClick={onClose}>
      <div style={{ position: "relative", background: "var(--bg-panel, #1c1c24)", borderRadius: 12, padding: 18, width: "min(92vw, 440px)" }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label={t("services.close")} title={t("services.close")}
          style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", color: "var(--text-muted, #aaa)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text, #eee)", marginBottom: 8 }}>
          🙂 {t("services.bioFaceCaptureTitle")} · {name}
        </div>
        <div style={{ position: "relative", borderRadius: 8, overflow: "hidden", background: "#000" }}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={{
              width: "100%",
              display: "block",
              aspectRatio: "4/3",
              objectFit: "cover",
              transform: mirrored ? "scaleX(-1)" : undefined,
            }}
          />
          {/* 人脸虚框 + landmark 叠加层（与 video 同步镜像，检测坐标仍用原始帧） */}
          <canvas
            ref={canvasRef}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          />
          {modelStatus === "ready" && !camError && (
            <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,.55)", color: progress >= target ? "#4caf50" : "#ffd54f", fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 999 }}>
              {mode === "verify" ? t("services.bioFaceVerifyProgress", { n: progress }) : t("services.bioFaceProgress", { n: progress })}
            </div>
          )}
        </div>
        {/* 摄像头选择（多设备时） */}
        {cams.length > 1 && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--text-dim, #999)", whiteSpace: "nowrap" }}>{t("services.bioFaceCam")}:</span>
            <select
              value={camId}
              onChange={(e) => setCamId(e.target.value)}
              style={{ flex: 1, background: "var(--bg, #141419)", color: "var(--text, #eee)", border: "1px solid var(--border, #444)", borderRadius: 6, padding: "4px 8px", fontSize: 11 }}
            >
              <option value="">{t("services.bioFaceCamAuto")}</option>
              {cams.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>
        )}
        {/* 实时诊断行：定位卡在哪（检测/基线/阈值/错误） */}
        {modelStatus === "ready" && !camError && !saving && (
          <div style={{ fontSize: 10, fontFamily: "var(--font-mono, monospace)", color: diag.err ? "#ff8a80" : "var(--text-dim, #999)", marginTop: 6, lineHeight: 1.5 }}>
            {diag.err
              ? `${diag.err}`
              : `人脸 ${diag.found ? "✓" : "—"} · 嘴开度 ${diag.mar ? diag.mar.toFixed(2) : "--"} · 阈值 ${diag.base ? diag.base.toFixed(2) : "--"} · 张嘴 ${progress}/3`}
            {!diag.err && diag.hist.length > 0 && (
              <span style={{ display: "inline-flex", gap: 2, marginLeft: 6, verticalAlign: "middle" }}>
                {diag.hist.map((h, i) => (
                  <span key={i} style={{ width: 5, height: 12, borderRadius: 1, background: h >= (diag.base || 0.35) ? "#ff8a80" : "#4caf50", display: "inline-block" }} />
                ))}
              </span>
            )}
          </div>
        )}
        <div style={{ fontSize: 11, color: errText ? "#ff8a80" : "var(--text-dim, #999)", marginTop: 8, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
          {saving ? t("services.bioFaceSaving") : errText ? errText : modelStatus === "ready" ? t("services.bioFaceCaptureHint") : t("services.bioFacePreparing")}
        </div>
      </div>
    </div>
  );
}

// —— face-api 类型（最小面）——
interface FaceApiNS {
  tf: { ready: () => Promise<void> };
  nets: {
    tinyFaceDetector: { loadFromUri: (u: string) => Promise<void> };
    faceLandmark68Net: { loadFromUri: (u: string) => Promise<void> };
    faceRecognitionNet: { loadFromUri: (u: string) => Promise<void> };
    faceExpressionNet: { loadFromUri: (u: string) => Promise<void> };
  };
  TinyFaceDetectorOptions: new (o: { inputSize: number; scoreThreshold: number }) => unknown;
  detectSingleFace(v: HTMLVideoElement, opts: unknown): {
    withFaceLandmarks(): {
      withFaceDescriptor(): Promise<Det | undefined>;
    };
  };
  matchDimensions(cv: HTMLCanvasElement, display: { width: number; height: number }): void;
  resizeResults(det: Det, display: { width: number; height: number }): ResizedDet;
  draw: {
    drawDetections(cv: HTMLCanvasElement, dets: ResizedDet, opts?: { withScore?: boolean }): void;
    drawFaceLandmarks(cv: HTMLCanvasElement, dets: ResizedDet): void;
  };
}
interface Det {
  descriptor: Float32Array;
  landmarks: { getLeftEye(): Pt[]; getRightEye(): Pt[]; getMouth(): Pt[] };
}
type ResizedDet = Det & { detection: unknown };
interface Pt { x: number; y: number }

const loadedScripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => { loadedScripts.delete(src); reject(new Error(`load failed: ${src}`)); };
      document.head.appendChild(s);
    }));
  }
  return loadedScripts.get(src)!;
}

/** 人脸虚框 + 68 点 landmark 画到叠加 canvas。
 * 镜像分歧处理：video 用 CSS scaleX(-1) 翻转显示（照镜子），但 canvas 不翻转——
 * 否则方框/标注文字也跟着翻转成镜像字。canvas 保持正向，坐标上把 x 做镜像
 * 变换（displayW - x），框/点仍贴在镜像后的画面上、文字正读。
 * 注意：face-api Box 字段是 _x/_y/_width/_height（getter x/y/width/height），
 * 必须原地修改（spread 重建会丢 getter 且 x 变 undefined → NaN 画不出来）。 */
function draw(faceapi: FaceApiNS, cv: HTMLCanvasElement, det: Det, mirrored: boolean): void {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const display = { width: cv.clientWidth, height: cv.clientHeight };
  faceapi.matchDimensions(cv, display);
  const resized: any = faceapi.resizeResults(det, display);
  if (mirrored && resized) {
    const W = display.width;
    const box = resized?.detection?.box;
    if (box && typeof box._x === "number") box._x = W - box._x - box._width;
    // Point 类的 x 是只读 getter（无 setter）——不能 p.x = …（TypeError），
    // 替换数组元素（_positions 数组可变、元素可换新对象）
    const pts: Pt[] | undefined = resized?.landmarks?.positions;
    if (pts && Array.isArray(pts)) {
      for (let i = 0; i < pts.length; i++) pts[i] = { x: W - pts[i].x, y: pts[i].y };
    }
  }
  ctx.clearRect(0, 0, cv.width, cv.height);
  faceapi.draw.drawDetections(cv, resized, { withScore: false });
  faceapi.draw.drawFaceLandmarks(cv, resized);
}

/** MAR（Mouth Aspect Ratio）——张嘴检测。face-api getMouth() 返回 20 点
 * （48-67）；标准 MAR 用外唇 6 点：竖 (51,59)+(53,57) / 横 (49,55)。张嘴
 * 时 MAR 显著增大（~0.2 → 0.6+）。 */
function marOf(pts: Pt[]): number {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(pts[3], pts[11]) + d(pts[5], pts[9])) / (2 * d(pts[1], pts[7]));
}
