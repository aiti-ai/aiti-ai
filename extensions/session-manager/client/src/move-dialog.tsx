/**
 * move-dialog —— 「移动会话」模块级常驻宿主（自 sessions-panel 迁出 + 模块态化）。
 *
 * All Sessions 行菜单与 SidebarDock 行菜单共用同一弹窗：showMoveDialog(sess) 触发，
 * entry.tsx dialogs slot 挂一次 MoveDialogHost；面板 Esc 守卫经 useMoveDialogOpen() 订阅。
 *
 * 层级：overlay z 2147483010 —— 高于 aiti-float 抬升上限（2147483000）：迁移前面板内嵌
 * 渲染天然随面板抬升，迁移后独立挂载必须自己越过上限，否则面板点按置前后弹窗被盖。
 */
import { useEffect, useState } from "react";
import { t } from "./host-shim";
import { displayCwd, moveSession, detectSessionCwd } from "./store";
import { ensureReadability, sessionTitle, ghostBtn, miniBtn } from "./helpers";
import { MoveCwdPicker } from "./move-cwd-picker";

const moveState = { sess: null as any, subs: new Set<() => void>() };
export function showMoveDialog(sess: any) {
  moveState.sess = sess;
  for (const l of moveState.subs) l();
}
function closeMoveDialog() {
  moveState.sess = null;
  for (const l of moveState.subs) l();
}
/** 面板 Esc 守卫用：弹窗打开期间 Esc 归弹窗（面板 handler 跳过关闭）。 */
export function useMoveDialogOpen(): boolean {
  const [sess, setSess] = useState(moveState.sess);
  useEffect(() => {
    const l = () => setSess(moveState.sess);
    moveState.subs.add(l);
    return () => { moveState.subs.delete(l); };
  }, []);
  return !!sess;
}

/** 移动会话对话框：目标目录选择（「项目/Projects」同款工作区选择器）+ 确认。 */
function MoveDialog(props: { sess: any; onClose: () => void }) {
  const [cwd, setCwd] = useState(props.sess.cwd ?? "");
  const [busy, setBusy] = useState(false);
  // 识别真实 CWD：打开时请求 server /session-cwd（依据会话操作过的文件推断最可能项目目录）
  const [realCwd, setRealCwd] = useState<{ candidates: Array<{ root: string; count: number }>; current: string } | null>(null);
  const [cwdLoading, setCwdLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setCwdLoading(true);
    void detectSessionCwd(props.sess.id)
      .then((r) => { if (alive && r) setRealCwd(r); })
      .finally(() => { if (alive) setCwdLoading(false); });
    return () => { alive = false; };
  }, [props.sess.id]);
  // 已知 cwd 建议改由 MoveCwdPicker 内部同款数据链提供（store.sessions → getRecentProjects）
  const submit = async () => {
    const target = cwd.trim();
    if (!target || busy) return;
    setBusy(true);
    const err = await moveSession(props.sess.id, target);
    setBusy(false);
    if (err) window.alert?.(`${t("sm.moveFailed") ?? "移动失败"}：${err}`);
    else props.onClose();
  };
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 2147483010, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1" data-ext-float-w={520} data-ext-float-h={340} data-ext-float-full="1"
        style={{
          width: "min(520px, 94vw)", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
          overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)", padding: 16,
        }}
      >
        {/* 标题栏行：标题 + 右上角 ✕ 关闭（首个子元素 = aiti-float 拖拽把手；⛶ 自动插在 ✕ 左侧） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <strong style={{ fontSize: 13, flex: 1 }}>📁 {t("sm.moveTitle") ?? "移动会话"}</strong>
          <button onClick={props.onClose} disabled={busy} aria-label={t("sm.close") ?? "关闭"} title={t("sm.close") ?? "关闭"}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sessionTitle(props.sess)} · {displayCwd(props.sess.cwd ?? "")}
        </div>
        {/* 检测到的真实 CWD：候选目录点选填入（依据会话操作过的文件） */}
        {cwdLoading && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8 }}>{t("sm.detectCwd") ?? "识别该会话的真实项目目录…"}</div>
        )}
        {!cwdLoading && realCwd && realCwd.candidates.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
            {realCwd.candidates.slice(0, 3).map((c) => {
              const isCurrent = c.root === realCwd.current;
              const selected = c.root === cwd.trim();
              return (
                <button key={c.root} type="button" onClick={() => setCwd(c.root)}
                  title={`${c.root} · ${t("sm.detectFiles", { n: c.count }) ?? `${c.count} 个文件`}`}
                  style={{
                    ...miniBtn, cursor: "pointer", maxWidth: "100%",
                    color: selected ? "#fff" : isCurrent ? "var(--text-muted)" : "var(--text)",
                    background: selected ? "var(--accent)" : isCurrent ? "var(--bg-hover)" : "transparent",
                    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                  } as React.CSSProperties}
                >{`${isCurrent ? "当前 " : "检测 "}${displayCwd(c.root)}${isCurrent ? "" : ` (${c.count})`}`}</button>
              );
            })}
          </div>
        )}
        <label style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
          {t("sm.moveTarget") ?? "目标目录（cwd）"}
        </label>
        <MoveCwdPicker value={cwd} onChange={setCwd} />
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>{t("sm.moveHint") ?? ""}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={props.onClose} disabled={busy} style={ghostBtn}>{t("sm.close") ?? "关闭"}</button>
          <button
            onClick={() => void submit()}
            disabled={busy || !cwd.trim()}
            style={{ ...ghostBtn, color: ensureReadability("var(--ok, #22c55e)"), borderColor: "#22c55e66" } as React.CSSProperties}
          >{busy ? "…" : `${t("sm.moveConfirm") ?? "移动"}`}</button>
        </div>
      </div>
    </div>
  );
}

/** dialogs slot 常驻宿主：模块态订阅渲染（closed → null，零占位）。 */
export function MoveDialogHost() {
  const [sess, setSess] = useState(moveState.sess);
  useEffect(() => {
    const l = () => setSess(moveState.sess);
    moveState.subs.add(l);
    return () => { moveState.subs.delete(l); };
  }, []);
  if (!sess) return null;
  return <MoveDialog sess={sess} onClose={closeMoveDialog} />;
}
