/**
 * Draft Keeper（aiti-draft-keeper）—— 草稿持久化 + 恢复接管扩展。
 *
 * 去 fork 化 P2：把 pi-web core 的草稿簇（draft-store + ChatWindow 扫描/静默恢复/
 * 恢复对话框合成）迁到外围。消费 composer 增强契约（docs/composer-enhancement-contract.md）：
 *   - onChange → 300ms 防抖落槽位（含图片）；清空且本挂载期编辑过 → 清槽位
 *   - onKeyChange → 换 key 扫描残留；条件满足静默恢复进输入框
 *   - registerRecoveryItemsProvider → 残留项并入恢复对话框（"ext:draft:" 前缀）
 *
 * localStorage key 与 core draft-store 完全同格式（crashrestore-<key>-<tabId>，
 * payload <ts>:<base64>）—— 双写过渡期两套实现可安全并存，切换零迁移成本。
 *
 * ⚠ 切换期约定（见 docs/pi-web-defork-roadmap.md §3.B）：
 *   keeper.enabled 默认 false。开启前 core 侧必须同时关闭内置草稿扫描
 *   （否则恢复对话框重复项）。当前版本与 core 并存时仅持久化等价，恢复行为以 core 为准。
 */
export default {
  id: "aiti-draft-keeper",
  name: "Draft Keeper",
  client: "dist/aiti-draft-keeper-client.mjs",
};
