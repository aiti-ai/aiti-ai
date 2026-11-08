# aiti-ai / aiti-ai — release mirror (CN networks)

Gitee mirror of the [aiti-ai/aiti-ai](https://github.com/aiti-ai/aiti-ai) GitHub Releases for
users where GitHub is slow or unreachable. Assets and checksums are identical; the installers
(`install.sh` / `install.ps1`) fall back to this mirror automatically, or force it with
`AITI_MIRROR=gitee`.

This repo hosts release attachments only — source lives upstream on GitHub. Archives above the
Gitee 100 MB per-file cap are published as `.part-N` pieces + a `.split` manifest; the
installers reassemble and sha256-verify them automatically.
