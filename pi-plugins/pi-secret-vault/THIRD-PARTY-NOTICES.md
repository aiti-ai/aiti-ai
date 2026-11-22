# Third-party notices

`pi-secret-vault` is an independent pi extension. Detection/redaction and the
placeholder engine come from `@aiti-ai/secret-mask-core`; the encrypted store
comes from `@aiti-ai/secret-vault-core`. See those packages' notices.

Design references (ideas only, no code): Claude Platform Vaults (write-only
credential surface), Naïve Vault (host-bound egress placeholders),
agentsecrets (proxy/keychain model), keyshroud and @k3_2o/pi-secrets (pi hook
usage patterns).
