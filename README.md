# dsh-t3-bridge

Run [DeepSeek Harness](https://deepseek.com/harness/en/) (`dsh`) as a provider
inside [T3 Code](https://github.com/pingdotgg/t3code) — threads, streaming,
reasoning, tool cards, model picker and reasoning-effort dropdown — on
`deepseek-flash`, with image input.

T3 has no `dsh` driver, and its `BUILT_IN_DRIVERS` array is closed: a driver
kind the build does not know renders as an unavailable provider. But T3's
**Cursor** driver spawns an arbitrary binary and talks standard ACP to it, and
it is the only driver that ships no built-in model list. dsh, meanwhile, already
speaks ACP first-party (`dsh --profile acp`). This bridge is the thin piece in
between: it impersonates the Cursor Agent CLI closely enough to pass T3's health
probe, and translates the handful of gestures the two ends disagree about.

**No fork of t3code is required.**

## T3 Code Orchestrator V2 (nightly 2026-10-03 and later)

Under Orchestrator V2 the `cursor` driver is the official Cursor SDK and no
longer spawns `binaryPath`, so a `cursor_*` instance pointing at this bridge
reports "Sign in with Cursor" and never starts it. Host the bridge on the
generic **ACP Registry** driver instead, with an executable override:

```json
"acp_dsh": {
  "driver": "acpRegistry",
  "displayName": "DeepSeek Harness (ACP bridge)",
  "enabled": true,
  "config": {
    "agentId": "deepagents",
    "commandPath": "/home/you/.local/bin/dsh-t3-bridge",
    "customModels": []
  }
}
```

- `agentId` must be a registry entry whose arguments are empty (`deepagents`
  is); the bridge treats a bare invocation as an ACP session.
- The driver only inspects agents against a cached registry index
  (`~/.t3/caches/acp-registry/registry.json`). T3 writes it when the registry
  browser in Settings is opened; until then the instance reports "No valid
  cached ACP Registry index".
- **The `t3-code` MCP server needs no bridge work.** V2 passes it in
  `session/new` / `session/resume` as a stdio server (`t3 acp-mcp-bridge`,
  absolute command, credentials in env); the proxy forwards it untouched and
  dsh's own ACP layer mounts it (`mountAcpMcpServers`), so the agent sees
  `mcp__t3-code__orchestrator_capabilities`, `delegate_task`, `t3_thread_*`
  and the rest as native tools. T3's orchestration instructions arrive inside
  the first prompt, since ACP has no system-prompt field.

## Install

```bash
# 1. the harness itself
mkdir -p ~/Projects/dsh-harness && cd ~/Projects/dsh-harness
npm init -y && npm i @deepseek-ai/dsh

# 2. the ACP patch (see "The image gate" below)
cat > acp-patch.yml <<'YML'
- id: acp
  name: '@deepseek-ai/dsh-acp'
  inject:
    - acpAppStartup
  config:
    provider: deepseek-official
    model: deepseek-flash
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
YML

# 3. the bridge
cd ~/Projects/dsh-t3-bridge
ln -sf "$PWD/bin/dsh-t3-bridge" ~/.local/bin/dsh-t3-bridge
dsh-t3-bridge about --format json   # sanity check
```

Then add a provider instance to `~/.t3/userdata/settings.json`:

```json
"providerInstances": {
  "cursor_dsh": {
    "driver": "cursor",
    "displayName": "DeepSeek Harness",
    "enabled": true,
    "config": {
      "binaryPath": "/home/you/.local/bin/dsh-t3-bridge",
      "apiEndpoint": "",
      "customModels": ["deepseek-flash"]
    }
  }
}
```

T3 hot-reloads settings. `customModels` is only a fallback — once the bridge
answers `cursor/list_available_models`, the picker lists dsh's real catalog
(`deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`,
`deepseek-v4-flash-vision-exp`).

**T3 caches provider status.** After changing the bridge, flip the instance's
`enabled` to `false`, wait a few seconds, and flip it back: that is what forces
a re-probe. A stale cached failure will otherwise keep failing turns with an
error the current code no longer produces.

If you do not otherwise use Cursor, set `providerInstances.cursor.enabled` to
`false` so T3 stops probing a `cursor-agent` binary you never installed.

## Credentials

The DeepSeek key resolves in this order: `DEEPSEEK_API_KEY` in the launch
environment, then `$DSH_T3_KEY_FILE`, then `~/.pi/agent/deepseek-api-key` — so a
machine that already runs pi needs no second secret. dsh's own credential store
(`~/.dsh/.credentials.yaml`) works too; the launch environment simply wins.

## How it works

```
T3 server ──spawn──> dsh-t3-bridge acp ──ACP/JSON-RPC v1──> dsh --profile acp
          <─about──
```

Two argv shapes, exactly the ones T3's Cursor driver produces:

| Mode | Purpose |
|---|---|
| `about [--format json]` | Health probe. T3 runs this to decide whether the provider is ready |
| `acp` | The ACP session. T3 may prepend `-e <endpoint>`, `--force` or `--auto-review`, so argv is scanned, not matched positionally |

### What the bridge actually translates

Everything else — prompts, streamed text and reasoning, tool calls, permission
requests, terminals, MCP, slash commands — passes through untouched, because
both ends already agree about it.

| T3 sends | The bridge does |
|---|---|
| `initialize` | Forwards it, then adds `cursor_login` to dsh's empty `authMethods` — T3 requires one to consider the provider authenticated |
| `authenticate` | Answers it here. dsh has no auth surface; its credential comes from the harness |
| `cursor/list_available_models` | Answers from the catalog learned from the last `session/new`, cached at `~/.dsh/t3-bridge-models.json`. T3's *status probe* asks this without ever opening a session, hence the cache |
| `session/set_model` / `set_config_option model=<slug>` | Rewrites the value to dsh's provider-qualified form, `["deepseek-official","<slug>"]` |
| `session/load` | Becomes `session/resume`. dsh advertises `resume`, T3's Cursor path uses `load` |
| *(response direction)* | Unwraps the model option's values back to bare slugs |

That last row is the one that is easy to miss. **T3 validates a select value
against the option's own list before it sends anything**
(`AcpSessionRuntime.ts:624` — *"expected one of …"*). If the model option still
advertises `["deepseek-official","deepseek-flash"]` while T3 is selecting
`deepseek-flash`, the request is rejected inside T3 and never reaches the wire —
which looks exactly like an agent that ignores the model picker.

### Reasoning effort needs no translation

T3 finds the effort control by matching a config option whose id or name
mentions "effort" or "reasoning" (`isCursorEffortConfigOption`). dsh publishes
`reasoning_effort` / "Reasoning effort", which matches on name, and its values
are `off` / `low` / `high` / `max`. T3's normalizer keeps `low`, `high` and
`max` and discards `off`, so the dropdown shows three of dsh's four levels and
each one is dsh's own value, passed through unchanged.

### The standing effort

dsh's `acp` plugin row takes only `provider` and `model`, so there is nowhere in
the composition to say "always think hard" — a new session lands on the provider
default, `high`. The bridge therefore sets `reasoning_effort` on every session it
opens (`max` unless `DSH_T3_DEFAULT_EFFORT` says otherwise) and reports that
value in the `session/new` response, so the dropdown shows what is actually
running. A client that picks its own effort — T3 does, from the thread's model
selection — simply overwrites it a moment later.

### The image gate

dsh decides image support **once, at `initialize`**, from the model named in the
`acp` plugin row — not from the session's current model. The shipped row is
`deepseek-v4-flash`, which is not a vision model, so out of the box every image
prompt is refused with *"inline image prompts were not advertised by this
connection"*. The `acp-patch.yml` above points that row at `deepseek-flash`,
which does accept images; verified end to end with a solid-purple PNG.

A consequence: the connection stays image-enabled even if you switch the session
to a model that cannot see. The model, not the protocol, is what will complain.

### Runtimes are resolved explicitly

T3 spawns providers directly rather than through a login shell, so its `PATH`
often lacks `~/.local/bin`. The launcher resolves `bun` itself, and the bridge
spawns dsh through an explicitly resolved `node` against
`node_modules/@deepseek-ai/dsh/lib/bin.js` rather than trusting the shim's
`#!/usr/bin/env node`. Both were real failures: the first shows up as
`AcpProcessExitedError` on `initialize`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DSH_T3_HARNESS_DIR` | `~/Projects/dsh-harness` | Where dsh is installed |
| `DSH_T3_DSH_BIN` | `<harness>/node_modules/.bin/dsh` | Fallback if the JS entry is missing |
| `DSH_T3_NODE` | resolved from PATH, then known locations | The node that runs dsh |
| `DSH_T3_BUN` | resolved by the launcher | The bun that runs the bridge |
| `DSH_T3_PROFILE` | `acp` | The dsh profile to boot |
| `DSH_T3_PATCH` | `<harness>/acp-patch.yml` if present | Patch overlay |
| `DSH_T3_PROVIDER` | `deepseek-official` | The provider half of dsh's model value |
| `DSH_T3_DEFAULT_EFFORT` | `max` | Effort set on every session the bridge opens, for clients that pick none |
| `DSH_T3_KEY_FILE` | `~/.pi/agent/deepseek-api-key` | Where to read the key |
| `DSH_T3_MODEL_CACHE` | `~/.dsh/t3-bridge-models.json` | Learned catalog |
| `DSH_T3_LOG` | unset | Wire log — every frame in both directions |
| `DSH_T3_CLI_VERSION`, `DSH_T3_ACCOUNT` | `2026.09.12`, `deepseek@local` | What the `about` probe reports |

`DSH_T3_LOG` is the first thing to set when a turn fails: T3 reports a bare
"warning" or a closed adapter, and the log says which frame it choked on. Note
that T3's *status probe* does not inherit the instance environment, so the probe
is invisible there — only session spawns are logged.

## Verified

Against T3 Code `0.0.41-nightly.20260915` and dsh `0.1.5-rc.2`:

- provider reports **ready / authenticated**, with all four models in the picker
- a turn streams back and completes (`pong-from-dsh`)
- effort `low` applied through `session/set_config_option reasoning_effort`
- mid-thread switch to `deepseek-v4-pro` accepted
- a bash tool call streams as `tool_call` + `tool_call_update`
- image prompt answered correctly (purple PNG → "Purple")
- `session/load` → `session/resume` in a fresh process recovers the thread's
  context across a restart

One known edge: if the agent process is **killed** mid-thread, T3 marks the
Cursor adapter closed and will not respawn it for that thread — the same
behaviour it has with a real `cursor-agent`. Resume works on T3's own restart
path, not on an abrupt kill.

## Tests

```bash
bun test          # the T3 compat gates, encoded
```

`test/e2e-probe.mjs` drives the whole thing the way T3 does — initialize,
authenticate, model list, session, effort, an image prompt, then a resume in a
second process:

```bash
node test/e2e-probe.mjs
```
