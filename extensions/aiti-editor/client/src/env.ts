/**
 * aiti-editor · 跨模块共享状态（自单文件手写版拆分）。
 *
 * 原实现里这些都活在 register(ctx) 闭包作用域；拆模块后收敛到这里，
 * registry.ts（_getEditor 闭包）与 editor-app.tsx（挂载时写入）双向共享。
 */
import { apiUrl } from "./host-shim.ts";

type AnyRecord = Record<string, any>;

let _ctx: AnyRecord | null = null;
export function setCtx(ctx: AnyRecord): void { _ctx = ctx; }
export function getCtx(): AnyRecord | null { return _ctx; }

/** 扩展 API base（原：const base = ctx.apiUrl("/api/extensions/aiti-editor")）。 */
export function getBase(): string {
  return apiUrl("/api/extensions/aiti-editor");
}

/** 当前编辑器 ref（EditorApp 挂载后同步——_getEditor 调试/集成用）。 */
export const editorRefHolder: { ref: AnyRecord | null } = { ref: null };
