# @aiti-ai/pi-model-command

Register `/models` so any pi host — TUI, RPC, or an in-process SDK session — can
switch the session model from the composer.

```
/models                        # open a picker
/models anthropic/claude-...   # set one directly
/models opus                   # unique id / name / substring also works
/models claude                 # several matches → lists candidates, sets nothing
```

## Why

pi's TUI has a built-in `/model`, but built-in interactive commands are handled
only in interactive mode: they are not part of `pi.getCommands()`, and
`session.prompt("/model")` sends the text to the model instead of executing it.
Hosts that drive pi over RPC or the SDK therefore have no built-in way to switch
models from their own UI.

This extension registers `/models` through the ordinary extension command
channel, so it behaves exactly like `/vault` or any other extension command:

- `get_commands` lists it in every host's command palette;
- the TUI renders its selector for the `ctx.ui.select` call;
- an RPC host renders its own dialog for the same call;
- hosts without dialogs get the list, and `/models <provider/modelId>` always works.

The name is `models` (plural) on purpose: a command that clashes with a built-in
interactive command is only reachable with a numeric suffix (`/model:1`).

## Install

Add the package path to `packages` in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/path/to/aiti-ai/pi-plugins/pi-model-command"]
}
```

or install it from npm: `npm install -g @aiti-ai/pi-model-command` and add
`npm:@aiti-ai/pi-model-command` to `packages`.

## Test

```bash
node --experimental-strip-types --test test/*.test.mjs
```
