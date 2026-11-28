/**
 * pi-fork-rpc — the minimal carrier-agnostic common layer for RPC spawning of the pi fork family.
 *
 * Split background (docs/aiti-pi-agent-split-plan.md): aiti-pi-agent once used a single PiForkSpec
 * parameterization to carry both the pi and omp backends, and the differences grew large enough
 * that "the shared abstraction became the coupling" — after splitting into two independent
 * extensions, this layer keeps only "wire-protocol parsing + CLI resolution + spawn env + family
 * types", with no fork semantics at all (command mapping / capability surface / lifecycle closeout
 * are each extension's own handle implementation's responsibility).
 *
 * The authoritative source lives in this directory (git-managed); consumer extensions
 * (aiti-pi-agent / aiti-omp-agent) carry **copies** (the fork-rpc/ subdirectory, copied into the
 * deployment directory with the extension at deploy time; syncing via scripts/sync-pi-fork-rpc.mjs).
 * This layer has no host dependencies (does not import pi-web lib) and can be loaded directly by
 * node:test (--experimental-strip-types).
 */
