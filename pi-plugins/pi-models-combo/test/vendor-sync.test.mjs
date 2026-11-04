// vendored 副本同步守护：src/effective-models.cjs 必须与工作区共享源一致（发布环境无上游时跳过）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = path.join(root, "..", "pi-web-ext", "shared", "effective-models.cjs");
const vendored = path.join(root, "src", "effective-models.cjs");

if (!fs.existsSync(shared)) {
  console.log("[vendor-sync] 共享源不存在（非工作区环境）→ 跳过");
  process.exit(0);
}
const a = fs.readFileSync(shared, "utf8");
const b = fs.readFileSync(vendored, "utf8");
if (a !== b) {
  console.error("✗ src/effective-models.cjs 与 pi-web-ext/shared/effective-models.cjs 不一致——请重新拷贝：\n  cp ../pi-web-ext/shared/effective-models.cjs src/");
  process.exit(1);
}
console.log("✓ vendor-sync：effective-models.cjs 副本与共享源一致");
