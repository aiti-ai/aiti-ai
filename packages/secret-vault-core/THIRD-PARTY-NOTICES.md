# Third-party notices

This package is an independent implementation for the pi ecosystem. It vendors no
third-party source code.

Cryptography uses only the Node.js standard library (`node:crypto`, AES-256-GCM).
The encrypted-store file shape (plaintext metadata + encrypted values, per-entry IV)
follows the publicly documented design of [getsops/sops](https://github.com/getsops/sops)
(Mozilla Public License 2.0) as an idea only — no code is shared or copied.

Detection/redaction is delegated to `@aiti-ai/secret-mask-core` (same license); the
attributions listed in that package's THIRD-PARTY-NOTICES.md apply transitively.
