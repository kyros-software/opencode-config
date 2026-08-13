# opencode-config

Portable OpenCode setup. Tuned for prefix-caching providers (DeepSeek, GLM,
Kimi, Qwen) with a per-task subagent fleet.

## Install

```bash
git clone git@github.com:kyros-software/opencode-config.git ~/opencode-config
cd ~/opencode-config
./install.sh            # --dry-run to preview
```

Private repo — the SSH key on the target machine must belong to an account with
access to the `kyros-software` org.

Backs up any existing `~/.config/opencode` to `~/.config/opencode.backup-<timestamp>`
before writing.

**Not included, by design:** credentials (`auth.json`) and session history.
After installing, run `opencode auth login`.

## What is in here

| Path | What |
|---|---|
| `opencode.json` | Main config: models, compaction, tool output caps, watcher ignores, provider timeouts |
| `AGENTS.md` | Global rules, loaded into every request. **Keep byte-stable** — see below |
| `agents/` | 13 subagents (plus build/plan/explore in the config), each pinned to a model chosen for its job |
| `skills/` | 9 on-demand skills |
| `plugins/` | `tandem.ts` (browser control), `fallback-proxy.ts` |
| `test/` | Test suite for the fallback proxy (`bun test`) |

## The one thing to understand

These providers cache prompt prefixes, matched **from token 0, exactly**. A
cache hit skips prefill entirely — that is where the speed comes from. Anything
volatile near the top of the prompt destroys it for everything after.

Consequences baked into this config:

- **`AGENTS.md` must stay byte-stable.** No dates, no session ids, no generated
  file trees. A larger stable file beats a smaller mutating one.
- **`compaction.prune` is `false`.** OpenCode's prune rewrites old tool outputs
  after *every* assistant turn once past ~40k tokens of tool output. That
  invalidates the cache continuously. Leave it off.
- **`temperature: 0`** on every code agent. DeepSeek's own guidance is 0.0 for
  code and math. `agents/docs.md` is the deliberate exception — it writes prose.

See the `deepseek-context` skill for the full reasoning.

## Model layout

Every agent pins its own model, so one dead model breaks one agent, not the fleet.

| Agent | Model | Temp |
|---|---|---|
| build (primary) | `gpt-5.6-luna` | 0 |
| architect | `kimi-k3` | 0.2 |
| design | `qwen3.8-max` | **0.8** |
| plan | `kimi-k3` | 0.1 |
| explore | `glm-5.1` | 0 |
| test | `gpt-5.6-luna` | 0 |
| debug, reviewer | `kimi-k2.7-code` | 0 |
| refactor, security, council | `kimi-k3` | 0 / 0.7 |
| devops | `qwen3.6-plus` | 0 |
| docs | `qwen3.7-plus` | default |
| commit, fast, web | `glm-5.1` | 0 |
| `small_model` | `glm-5.1` | — |

**Every model in that table needs an entry in `CHAINS`** (`fallback-proxy-lib.ts`).
A model with no chain has no fallback, and the primary having no chain takes the
whole session down when it goes. `bun test` enforces this — it reads the pins
straight out of `opencode.json` and `agents/*.md`, so swapping a model in a hurry
and forgetting the chain fails the suite instead of failing silently at 3am.

Verify they all resolve on a new machine:

```bash
opencode models opencode-go
for m in gpt-5.6-luna kimi-k3 kimi-k2.7-code glm-5.1 qwen3.6-plus qwen3.7-plus qwen3.8-max; do
  printf '%-18s ' "$m"
  opencode run --model "opencode-go/$m" "say OK" 2>&1 | tail -1
done
```

Known dead as of Aug 2026: `deepseek-v4-pro` and `deepseek-v4-flash` (both
China-region opt-in required — 403 `RegionError`), `kimi-k2.6`
(`invalid_request`). Nothing chains to them; they keep chains of their own so a
request for one routes away instead of failing.

## Fallback proxy

`plugins/fallback-proxy.ts` rewrites both providers' `baseURL` to a loopback
server that forwards to the real upstream. When the requested model fails in a
way a different model could cover, it walks that model's chain and serves the
first candidate that answers, with a TUI toast naming what actually replied.

What it can route around is decided in `classifyPrimaryFailure`, on two axes:

- **Status**: `429`, `5xx` — transient, retry elsewhere.
- **Status + error type**: `401`/`403`/`404` carrying `ModelError` or
  `RegionError` — the model is gone for you. Same statuses with any other type
  (`AuthError`, `PermissionError`) are your problem, not the chain's, and go
  straight back so you see them on the first request instead of the fifth.

That second axis is the whole ballgame. In Aug 2026 it listed `401`/`ModelError`
only; `deepseek-v4-pro` went China-only behind `403`/`RegionError`, and the
primary model's outage passed through untouched with a healthy chain sitting
right there unused. **When upstream invents a new way to retire a model, widen
that list — not the chains.**

### The timeout coupling

Two timeouts have to agree or the fallback cannot fire:

| Where | Setting | Value |
|---|---|---|
| Client → proxy | `provider.*.options.headerTimeout` in `opencode.json` | 70000 |
| Proxy → upstream, per hop | `DEFAULT_HEADERS_TIMEOUT_MS` in `fallback-proxy-lib.ts` | 15000 |

`headerTimeout` has to cover the *whole* chain walk — longest chain is four hops,
so 4 × 15s with margin. It was 30s against a 60s per-hop budget, which is
backwards twice over: the proxy's own stall detection could never fire, and the
client aborting mid-walk kills the fallback outright, because an aborted request
is indistinguishable from the caller hanging up and the loop rethrows rather than
trying the next candidate.

## MCP

None configured, deliberately. If an MCP server merely wraps a CLI you already
have (`gh`, `git`, `docker`, `npm`), skip it — bash calls those for free, and a
40-tool server costs ~20k tokens of window plus degraded tool selection.

MCP earns its cost only for things with no CLI equivalent. If you add one:

```json
"permission": { "mcp_*": "ask" }
```

## Two traps that cost hours to find

Both make a non-interactive run hang until it times out, with no error and no
session in the database. Neither is documented upstream.

**1. `permission` in a project `opencode.json` replaces, it does not merge.**

```jsonc
// This hangs. 'edit' and 'bash' silently revert to "ask", and in a
// non-interactive run there is nobody to answer.
{ "agent": { "build": { "permission": { "skill": "deny" } } } }
```

If you set `permission` on an agent at project level, **enumerate every tool you
need**, including the ones the global config already allowed.

**2. `--print-logs` with stdout redirected to a file hangs.**

```bash
opencode run --print-logs "..." > out.log 2>&1   # hangs
opencode run "..." 2>&1 | tail -40 > out.log     # fine
```

Pipe it; do not redirect it. Get the session id from the database instead:
`select id from session order by time_created desc limit 1`.

**Bonus, for measuring:** `sessionID` is a *column* (`session_id`) on `message`,
not a field inside its JSON. And prompt size is `tokens.input + tokens.cache.read`
— reading `input` alone compares runs with different cache states and gives
nonsense.

## Maintenance

```bash
opencode upgrade                      # autoupdate is set to "notify"
cd ~/.config/opencode && bun test     # fallback-proxy suite
opencode db "VACUUM"                  # then: PRAGMA wal_checkpoint(TRUNCATE)
```

Keep the plugin SDK in `package.json` matching your opencode version.
