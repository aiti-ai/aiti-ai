# Provider template

To add a platform:

1. Copy `providers/_template/` to `providers/<id>/`.
2. Implement `api.ts` mapping your API onto `ForgeProject` / `ForgeWorkItem` / `ForgeRepo` /
   `ForgeBranch` / `ForgeComment` (see `server/contract.ts`).
3. Implement `oauth.ts` if the platform supports OAuth:
   - `mode: "dcr-pkce"` + `discover` + `register` (no client secret), or
   - `mode: "client-credentials"` + `metaFor` (authorize/token endpoints).
4. Export a `ForgeProvider` from `index.ts`:
   - declare `capabilities` (work-item scope + filters, code features, auth, clone);
   - provide `httpFor(cfg)` and `auth.pat.fields` / `auth.pat.validate`;
   - map `web.*` URLs and `format.defaults`.
5. Add it to `providers/index.ts` (`BUILTIN_PROVIDERS`).
6. Add a fixture test under `tests/` (provider conformance + mapping) and run
   `node --test tests/*.test.mjs`.

No UI changes are needed: the panels are driven by `capabilities` + `/providers`.

For third-party providers shipped as their own extension, register at runtime through the
server service `aiti-codehub.provider`:

```ts
ctx.services.provide("aiti-codehub.provider", {
  register(provider) { /* same ForgeProvider shape */ },
});
```

The UI reads `/providers` at open time, so a newly registered provider appears on the next
settings/panel refresh.
