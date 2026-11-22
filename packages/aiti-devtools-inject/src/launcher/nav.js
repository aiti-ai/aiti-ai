// nav 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）


export function initNav(ctx) {
  ctx.doNav = function (dir) {
      ctx.navHoldT = Date.now() + 400; // 导航后 400ms 内的选区更新保持位置（连续点击导航不跳动）
      // 阶段 2：按选区来源定向（host 经 window.postMessage loopback → self client 消息监听 stepSelection；
      //          iframe 走 postToFrame 带 _f）。注：window.__dbg 未暴露 step，不能直调 selfClient.step
      ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_step', payload: { dir: dir } });
      }
}
