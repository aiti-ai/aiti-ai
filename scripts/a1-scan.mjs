// A1 redact scan for the main-package tarball (see .github/workflows/publish.yml).
// Scans every file `npm pack` would include against the PRIV scan patterns
// (internal domains / RFC1918 hosts / usernames / private repo names) from
// AITI_RELEASE_REDACT. Exits 1 on any hit. Requires devDeps? No — uses the
// repo's own npm environment; --ignore-scripts avoids the prepack sanitize
// hook whose stdout would corrupt the --json output.
import fs from "node:fs";
import { execSync } from "node:child_process";

const priv = JSON.parse(
  fs.readFileSync(process.env.AITI_RELEASE_REDACT || process.env.HOME + "/.aiti/release-redact.json", "utf8"),
);
if (!priv || !Array.isArray(priv.scan)) {
  console.error("AITI_RELEASE_REDACT.scan missing (or local config absent)");
  process.exit(1);
}
const patterns = priv.scan.map((r) => [new RegExp(r.pattern, "gm"), r.label || ""]);
const listing = JSON.parse(
  execSync("npm pack --dry-run --json --ignore-scripts", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
);
const files = (listing[0] && listing[0].files || []).map((f) => f.path);
let hits = 0;
for (const rel of files) {
  let text;
  try {
    text = fs.readFileSync(rel, "utf8");
  } catch {
    continue;
  }
  for (const [re, label] of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      console.log(`HIT ${rel}:${line} ${label}`);
      hits++;
      if (hits > 20) process.exit(1);
    }
  }
}
if (hits) process.exit(1);
console.log(`A1 redact scan: ${files.length} files clean`);
