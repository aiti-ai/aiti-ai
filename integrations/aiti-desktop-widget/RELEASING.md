# Releasing aiti-desktop-widget

The Rust shell and the npm launcher share one version. The release workflow is
`.github/workflows/aiti-desktop-widget-release.yml` (aiti-ai repo).

## 1. Bump the version

```bash
cd integrations/aiti-desktop-widget
node scripts/version.mjs --bump patch   # or --set X.Y.Z
```

This updates `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `Info.plist` and `npm/package.json`.
The tag format is `aiti-desktop-widget-vX.Y.Z` (plain semver; the app release uses `vX.Y.Z-aiti.N`, so
the two never collide).

## 2. Verify locally

```bash
cargo test
node scripts/check-capabilities.mjs           # capability allow-list vs the Tauri ACL manifest
npm install --prefix npm --no-audit --no-fund --ignore-scripts --registry https://registry.npmjs.org
node --test npm/test/download.test.mjs scripts/publish-gitee.test.mjs
cargo build --release
DISPLAY=:0 node --test tests/shell.test.mjs   # optional GUI checks (includes the capability probe)
```

`scripts/check-capabilities.mjs` diffs `capabilities/widget-page-control.json` against the ACL
manifest Tauri generates in `target/**.json` (written by `cargo test`/`cargo build`). After a Tauri
upgrade run it again; `--fix` rewrites the permission list, and the release workflow runs the
check in its `test` job.

### Dev-machine install / cache (23/24/48)

```bash
cd integrations/aiti-desktop-widget/npm && npm pack
npm install -g ./aiti-ai-aiti-desktop-widget-0.2.0.tgz --ignore-scripts --registry https://registry.npmjs.org
# Windows: recreate shims if npm skipped them for the local tarball
npm rebuild -g @aiti-ai/aiti-desktop-widget
```

Pre-seed the native cache (checksums line uses the release asset name):

| OS | Cache | Asset name |
|---|---|---|
| Linux | `~/.cache/aiti-desktop-widget/<ver>/linux-x64/aiti-desktop-widget` | `aiti-desktop-widget-linux-x64` |
| macOS | `~/Library/Caches/aiti-desktop-widget/<ver>/darwin-x64/aiti-desktop-widget` | `aiti-desktop-widget-darwin-x64` |
| Windows | `%LOCALAPPDATA%\aiti-desktop-widget\cache\<ver>\win32-x64\aiti-desktop-widget.exe` | `aiti-desktop-widget-win32-x64.exe` |

`checksums.txt` next to the cached binary must contain `<sha256>  <asset name>`. The launcher then
skips the network entirely; `aiti-desktop-widget --version` is the smoke test.

## 3. Optional: build-only validation on GitHub

Before tagging, the workflow can compile all four targets without publishing:

```bash
gh workflow run aiti-desktop-widget-release.yml --ref main -f dry_run=true
```

`dry_run=true` skips `release`, `gitee` and `npm`; only `validate`, `test` and the
four-platform `build` matrix run. This is the recommended first run after changing the
workflow or the build matrix.

## 4. Tag and push

```bash
cd ../..
git add integrations/aiti-desktop-widget
git commit -m "release(widget): vX.Y.Z"
git tag aiti-desktop-widget-vX.Y.Z
git push origin main --tags
```

Pushing the tag runs the workflow:

| Job | What it does |
|---|---|
| `validate` | tag == Cargo/npm/plist/tauri versions |
| `test` | `cargo fmt --check`, `cargo test`, npm launcher tests (no GUI) |
| `build` | Linux x64/arm64, Windows x64/arm64, macOS x64 (`macos-15-intel`) + arm64 (`macos-15`) |
| `release` | names artifacts `aiti-desktop-widget-<platform>[.exe]`, adds `checksums.txt`, creates/updates the GitHub Release |
| `gitee` | mirrors the same assets to `gitee.com/aiti-ai/aiti-ai` (non-blocking) |
| `npm` | publishes `@aiti-ai/aiti-desktop-widget@X.Y.Z` (skips if already published) |

Required repository secrets: `NPM_TOKEN` (npmjs publish), `AITI_GITEE_TOKEN` (Gitee API).
`GITHUB_TOKEN` is provided by Actions.

## 5. Manual recovery

- **GitHub assets**: re-run the workflow from the tag (`workflow_dispatch` on that ref), or
  `gh release upload aiti-desktop-widget-vX.Y.Z dist/* --clobber`.
- **Gitee**: `AITI_GITEE_TOKEN=... node integrations/aiti-desktop-widget/scripts/publish-gitee.mjs --tag aiti-desktop-widget-vX.Y.Z --assets-dir dist`
- **npm**: the workflow skips an existing version; for a new version, bump and re-tag.

## Asset contract (npm launcher depends on it)

| Platform | Asset |
|---|---|
| Linux x64 | `aiti-desktop-widget-linux-x64` |
| Linux arm64 | `aiti-desktop-widget-linux-arm64` |
| Windows x64 | `aiti-desktop-widget-win32-x64.exe` |
| Windows arm64 | `aiti-desktop-widget-win32-arm64.exe` |
| macOS Intel | `aiti-desktop-widget-darwin-x64` |
| macOS Apple Silicon | `aiti-desktop-widget-darwin-arm64` |

`checksums.txt` uses `sha256sum` format (`<hash>  <asset>`). The launcher refuses to run a
binary whose checksum is missing or mismatched.

## Notes

- macOS binaries are ad-hoc signed in CI (`codesign --force --sign -`) and embed
  `Info.plist` (`__TEXT,__info_plist`) for the ATS localhost exception; no `.app` bundle is
  required for the npm launcher.
- macOS deployment target: **10.15 (x64)** / **11.0 (arm64)**. Building on a newer macOS runner
  does not raise that floor; `Info.plist` `LSMinimumSystemVersion` must match. `--zoom` needs
  macOS 11+.
- Linux binaries are built on Ubuntu 22.04 (glibc 2.35 baseline) and require WebKitGTK 4.1 at
  runtime.
- Windows binaries are unsigned; sign them in a future release if SmartScreen matters.
- Gitee has a 1 GB repository attachment quota. Widget assets are small (~40 MB total per
  release), but prune old widget releases if the quota gets tight.
