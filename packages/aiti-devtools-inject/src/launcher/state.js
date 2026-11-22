// state 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { DBG_STATE_KEY } from './constants.js';
import { lsGetJSON, lsSetJSON } from './storage.js';

export function initState(ctx) {
  ctx.loadDbgState = function () { return lsGetJSON(DBG_STATE_KEY, {});   }

  ctx.saveDbgState = function () { lsSetJSON(DBG_STATE_KEY, { aiOpen: ctx.aiOpen, aiWin: ctx.aiState ? { left: ctx.aiState.left, top: ctx.aiState.top, width: ctx.aiState.width, height: ctx.aiState.height } : null, targetUrl: ctx.url, profile: ctx.currentProfile, optState: ctx.optState });   }
}
