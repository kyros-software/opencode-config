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
before writing — everything but `node_modules`, which `bun install` rebuilds from
`bun.lock`. That is 356 KB per backup instead of 63 MB.

**Not included, by design:** credentials (`auth.json`) and session history.
After installing, run `opencode auth login`.

## What is in here

| Path | What |
|---|---|
| `opencode.json` | Main config: models, compaction, tool output caps, watcher ignores, provider timeouts |
| `AGENTS.md` | Global rules, loaded into every request. **Keep byte-stable** — see below |
| `agents/` | 13 subagents (plus build/plan/explore in the config), each pinned to a model chosen for its job |
| `skills/` | 10 on-demand skills |
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
| build (primary) | `deepseek-v4-pro` | 0 |
| architect | `kimi-k3` | 0.2 |
| design | `qwen3.8-max` | **0.8** |
| plan | `kimi-k3` | 0.1 |
| explore | `gpt-5.6-luna` | 0 |
| test | `gpt-5.6-luna` | 0 |
| debug, reviewer | `kimi-k2.7-code` | 0 |
| refactor | `kimi-k2.7-code` | 0 |
| security | `kimi-k2.7-code` | 0 |
| council | `gpt-5.6-luna` | 0.7 |
| devops | `qwen3.6-plus` | 0 |
| docs | `qwen3.7-plus` | default |
| commit, fast, web | `gpt-5.6-luna` | 0 |
| `small_model` | `gpt-5.6-luna` | — |

### kimi-k3 held five roles on one argument

At 3/15/0.3 it is the priciest model here — 12× the primary on a timed task, 19×
on a longer one. It was pinned to `plan`, `architect`, `refactor`, `security` and
`council`, and the case for keeping it was made once, for all five at once. Those
five are not one question:

| role | why it left, or stayed |
|---|---|
| `refactor` | Behaviour-preserving by definition, so the existing suite *is* the oracle. Verification is free, which caps the downside of a cheaper model. Went to the primary's model first and hung every time — see trap 4 — so it sits with `reviewer` instead. → `kimi-k2.7-code` |
| `security` | Detection, not generation, and it has a textbook oracle: seed known vulnerabilities, count what gets found. Moved alongside `reviewer`, its nearest sibling. → `kimi-k2.7-code` |
| `council` | Its value is *disagreement diversity*, not quality — and it shared a model with `architect` and `plan`, the very agents it exists to pressure-test. A cheap model from a different lineage beats an expensive one that thinks like the thing under review. → `gpt-5.6-luna` |
| `plan`, `architect` | Genuinely contested. A design document has no oracle; a design *under a known subsequent change* does. Until that harness exists, the premium stays. |

The three that moved cost nothing to reverse — one line each — and none of them
needed the contested argument to justify the move.

### The cheap tier is `gpt-5.6-luna`, not glm-5.1

`glm-5.1` used to hold `small_model`, `explore`, `commit`, `fast` and `web` — the
whole cheap tier — and sat in 8 of the 9 fallback chains. Measured prices per
million tokens say that was backwards:

| | input | output | cache_read |
|---|---|---|---|
| `gpt-5.6-luna` | 0.10 | 0.60 | 0.01 |
| `deepseek-v4-pro` | 0.435 | 0.87 | 0.003625 |
| `kimi-k2.7-code` | 0.95 | 4.00 | 0.19 |
| `glm-5.1` | **1.40** | **4.40** | **0.26** |

glm-5.1 is strictly dominated — worse than `kimi-k2.7-code` on all three axes —
and it was slower than both luna and deepseek on a measured task. It was the most
expensive model on the account doing the work labelled "cheap and fast", and the
failover target for almost every chain, so every outage funnelled traffic into it
at the moment nobody was watching the bill. It is now pinned nowhere and appears
in no chain; `bun test` enforces both.

`explore` was the expensive half of that mistake: `AGENTS.md` routes every
cross-file search there, so it is the highest-volume caller in the fleet.

**Every model in that table needs an entry in `CHAINS`** (`fallback-proxy-lib.ts`).
A model with no chain has no fallback, and the primary having no chain takes the
whole session down when it goes. `bun test` enforces this — it reads the pins
straight out of `opencode.json` and `agents/*.md`, so swapping a model in a hurry
and forgetting the chain fails the suite instead of failing silently at 3am.

Verify they all resolve on a new machine:

```bash
opencode models opencode-go
for m in deepseek-v4-pro kimi-k3 kimi-k2.7-code glm-5.1 qwen3.6-plus qwen3.7-plus qwen3.8-max; do
  printf '%-18s ' "$m"
  opencode run --model "opencode-go/$m" "say OK" 2>&1 | tail -1
done
```

**Nothing is known dead right now.** `deepseek-v4-pro`, `deepseek-v4-flash` and
`kimi-k2.6` all answered 200 on the last probe — the deepseek region gate that
took out Aug 2026 has been lifted.

Both deepseek models stay out of every chain's *candidate* list anyway. A
fallback has to be more available than the thing it replaces, and these are the
two models on the account with a history of disappearing for a month. Primary is
fine — a chain covers the primary. Being somebody else's safety net is not.
`bun test` enforces it.

Note that the `opencode-go` and `opencode` tiers both carry a `deepseek-v4-pro`.
They are different models: the Go one is displayed as **"DeepSeek V4 Pro (New)"**,
the Zen one as plain "DeepSeek V4 Pro". This config pins the Go one everywhere.

## Zen tier is disabled

```json
"disabled_providers": ["opencode"]
```

The Zen tier (Claude, GPT, Gemini) is switched off so the model picker only shows
what this config actually uses. It also removes the whole class of accident where
a `zen/…` model gets picked and lands on a tier with no chains behind it.

To bring it back, drop the key — the fallback proxy still handles both tiers and
needs no change either way.

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

## Five traps that cost hours to find

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

**3. Reading a file outside the project kills a non-interactive run.**

```
! permission requested: external_directory (~/.config/opencode/*); auto-rejecting
✗ Read ~/.config/opencode/AGENTS.md failed
Error: The user rejected permission to use this specific tool call.
```

Eight seconds, empty directory, exit 0. The agent reached for the global
`AGENTS.md`, `external_directory` defaulted to a prompt, nobody was there to
answer, and the rejection aborted the whole run instead of letting the agent
carry on without that file. Found by a benchmark, not by a user — which is the
point: interactively you just click yes and never learn it exists.

Every agent that declares a `permission` block now carries
`external_directory: allow`, because of trap 1: the block replaces, so an agent
listing only `edit`/`bash` has no `external_directory` at all.

Two things that do **not** work:

```jsonc
// Hangs. The glob does not match, so it falls through to "ask" — trap 2.
"external_directory": { "**/.config/opencode/**": "allow" }

// Also hangs, for the same reason, with any pattern that misses.
```

Only the bare `"allow"` was verified to work. It is also the honest setting:
`build` already runs `bash: "allow"`, so it can `cat` any file on the machine.
Restricting `external_directory` underneath an unrestricted shell protects
nothing and only costs you runs.

**4. A subagent pinned to the primary's own model hangs.**

Delegate to it and the child turn opens, emits zero tokens, and sits there until
something kills the run. In the session database it looks exactly like an upstream
stall — `out=0`, `finish=None`, no completion time — which sends you hunting in the
wrong place. Repin the identical task to any other model and it finishes in
seconds.

Measured twice, then confirmed by a controlled swap: `refactor` on the primary's
model stalled 2 for 2 and produced nothing; moved to another model it did the
refactor immediately. `security` and `council`, both on models different from the
primary, worked first try.

```bash
# the tell — same model on both rows, child never completes
opencode db "SELECT data FROM message WHERE data LIKE '%<run-dir>%'"
#   agent=build     modelo=deepseek-v4-pro  dur=3.5  out=46
#   agent=refactor  modelo=deepseek-v4-pro  dur=SIN COMPLETAR  out=0
```

`bun test` enforces the constraint now, because nothing else surfaces it: no unit
test delegates, so the collision is invisible until real work hits it. Note the
guard is about *collision with whatever `model` is set to*, not about any
particular model — change the primary and a previously fine subagent becomes the
broken one.

**5. An agent named after a group is one seat of it, and nobody seats the rest.**

`council` was written as a single advisor holding a single lens — correct, and
useless on its own. Nothing in the config convened the panel, so "council this"
delegated **once** and came back with one cheap model's opinion wearing the
authority of an arbitrated verdict. The failure is silent: the output looks
exactly like a council output.

Subagents cannot delegate, so a seat can never convene its peers — the panel has
to be orchestrated by the primary. That protocol now lives in the `llm-council`
skill (parallel seats → anonymised peer review → synthesis here), the delegation
table says *N seats in parallel, never one*, and the agent's own description
leads with it, so a single call is wrong at every layer that could produce it.

Generalises past this one agent: if a subagent's name implies plurality, check
what actually spawns the plurality.

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
