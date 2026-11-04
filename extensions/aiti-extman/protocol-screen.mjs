/**
 * aiti-extman · 安装时协议筛查 / 自动升级（**未实现——占位空函数**）。
 *
 * 目标（2026-09-13 用户要求；方案 docs/pi-web-ext-protocol-versioning-plan.md §7）：
 *   安装扩展时读取其 package.json 的 aitiExtProtocol 与目标协议版本，计算迁移跳数；
 *   运行「筛查程序」静态解析扩展 JS/TS（server entry + client bundle），按版本维护的
 *   特征表识别破坏性特征（示例：ctx.dataDir 使用、旧 registerItems 形态、per-session SSE…）；
 *   能确定性改写的用 codemod 自动升级（改写文件 → 重建产物 → 更新声明 → 部署）；
 *   改不了的（跨文件语义/不确定特征）返回 needsAI，交 AI 走 ext-protocol-upgrade skill。
 *
 * 当前状态：空函数占位——**后续上线之后发生 API 不兼容时实现**（第一次 MAJOR bump 时开始写
 * 特征表与 codemod；安装流程已接好调用点，返回值随安装结果返回，当前不影响任何行为）。
 *
 * @param {{
 *   id?: string,
 *   dir?: string,
 *   kind?: string,
 *   fromProtocol?: string,
 *   toProtocol?: string,
 * }} [_ctx] 扩展信息与协议跳数（当前占位实现忽略入参）
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,
 *   autoMigrated?: boolean,
 *   needsAI?: boolean,
 *   reason?: string,
 *   findings?: Array<{ file: string, line?: number, feature: string, autoFixable: boolean }>,
 * }>}
 */
export async function screenAndMigrateOnInstall(_ctx) {
  // TODO(protocol v2+): 上线后发生 API 不兼容时，按文件头设计实现特征表 + codemod + AI 降级。
  return { ok: true, skipped: true, reason: "not_implemented" };
}
