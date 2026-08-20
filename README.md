# opencode-config

A portable [OpenCode](https://opencode.ai) setup: a fleet of single-purpose
agents, each pinned to the cheapest model that does its job well, behind a
fallback proxy that survives a model outage — plus a bridge that lets Claude
Code hand work down to any of them.

**The problem it solves.** One general-purpose agent on one expensive model pays
premium rates for work that does not need them, and stops entirely when that
model has a bad day. This config splits the work into 16 named specialists,
pins each to a model chosen for its task, routes around outages automatically,
and keeps the whole thing inside a prompt-cache discipline that makes the cheap
models fast as well as cheap.

Everything here is tuned for prefix-caching providers (DeepSeek, GLM, Kimi,
Qwen). That single constraint explains most of the odd-looking decisions in this
file, and it is spelled out under [Why it is built this way](#why-it-is-built-this-way).

## Contents

- [Install](#install)
- [Connecting it to Claude Code](#connecting-it-to-claude-code)
- [What is in here](#what-is-in-here)
- [Why it is built this way](#why-it-is-built-this-way)
- [The fleet](#the-fleet)
- [Fallback proxy](#fallback-proxy)
- [Inbound MCP policy](#inbound-mcp-policy)
- [Traps that cost hours to find](#traps-that-cost-hours-to-find)
- [Maintenance](#maintenance)

## Install

```bash
git clone git@github.com:kyros-software/opencode-config.git ~/opencode-config
cd ~/opencode-config
./install.sh            # --dry-run to preview; --no-mcp to skip the bridge
```

**Requires `bun` on PATH.** OpenCode's own plugins fall back to `npm`, but the
Claude Code bridge imports `bun:sqlite` and runs under nothing else — without
bun you get a working fleet and a bridge that never connects. The script warns
about that before it copies anything.

Private repo: the SSH key on the target machine must belong to an account with
access to the `kyros-software` org.

What the script does, in order:

1. Backs up any existing `~/.config/opencode` to
   `~/.config/opencode.backup-<timestamp>` — everything but `node_modules`,
   which `bun install` rebuilds from `bun.lock`. That is ~360 KB per backup
   instead of 63 MB. It never prunes old backups; delete them yourself.
2. Copies `opencode.json`, `AGENTS.md`, `agents/`, `skills/`, `plugins/`,
   `test/` and the dependency manifests into `~/.config/opencode`.
3. Installs plugin dependencies with bun.
4. Verifies: the config parses, the agent and skill counts are what you expect,
   and the bridge answers a real MCP `initialize` handshake.
5. Registers the bridge with Claude Code (see the next section).

**Not carried, by design:** credentials (`auth.json`) and session history. After
installing:

```bash
opencode auth login
opencode run "say OK"
```

Then confirm every pinned model actually resolves on this account — a model that
404s here is an agent that will fail the first time you reach for it:

```bash
opencode models opencode-go
for m in deepseek-v4-pro kimi-k3 kimi-k2.7-code qwen3.6-plus qwen3.7-plus qwen3.8-max gpt-5.6-luna; do
  printf '%-18s ' "$m"
  opencode run --model "opencode-go/$m" "say OK" 2>&1 | tail -1
done
```

If one 404s or reports a region opt-in, swap it in `opencode.json` and in
`agents/*.md` — every agent pins its own model, so one dead model costs you one
agent, not the fleet.

## Connecting it to Claude Code

`mcp/opencode-mcp.ts` is an MCP server that exposes this fleet **to** Claude
Code, so expensive-model work can be handed down to a cheap specialist.

### Registration

`install.sh` does it for you. It compares the *registered path*, not just the
name, so a clone that has moved gets re-pointed instead of silently leaving a
dead absolute path that still answers to `opencode`.

To do it by hand — or on a machine where Claude Code was not on PATH at install
time:

```bash
claude mcp add opencode -s user -- "$(which bun)" "$PWD/mcp/opencode-mcp.ts"
claude mcp list        # opencode - ✔ Connected
```

The bridge runs from this clone, not from `~/.config/opencode`; the registration
is by absolute path, so keep the clone where it is. `claude mcp remove opencode`
is the whole rollback.

### The two tools

`agents` lists the fleet off disk — names, pinned models, and what each is for —
so the caller picks a real specialist instead of guessing a name. Anything not
reachable through `run` is labelled as such.

`run` takes a `prompt` and optionally `agent`, `model`, `dir`, `session` and
`timeout_s`. It returns the final answer plus one accounting line:

```
LISTO

— ses_fe62b3b6dffeURczN44ov8lDcP · 4.6s · $0.0021 · prompt 8350 · out 6 · ran as fast/gpt-5.6-luna
```

`ran as <agent>/<model>` is read back out of OpenCode's database after the run,
not taken from what was requested — so a delegation reports what it *was*, not
what it was asked to be.

### Why a bridge at all

Claude Code can already call `opencode run` from bash, so by the rule in
[Inbound MCP policy](#inbound-mcp-policy) this server is redundant. What bash
cannot do is come back cheap: a raw run prints its entire tool trace, and the
reason to delegate to a cheap model is to *not* pay for that trace in the
expensive model's window. `run` returns the final text and one line of
accounting, and drops the rest. Two tools, not forty.

Use it for work that is verbose here and cheap there: repo-wide sweeps, running
a test suite and reporting what broke, browser verification, or a second opinion
from a different model family.

### The guard

`opencode run --agent` only starts **primary** agents, and it does not fail when
you name a subagent — it warns on stderr and runs `default_agent` instead. See
[trap 6](#6-a-subagent-is-not-a-primary-and-opencode-does-not-fail-when-you-try)
for what that cost. The bridge refuses before spawning:

```
run failed: agent "zz-canario" is mode: subagent, which `opencode run --agent`
cannot start — it would silently fall back to the default agent. Give it
`mode: all` in its definition to make it reachable from here. Reachable now:
architect, build, commit, council, debug, design, devops, docs, explore, fast,
plan, refactor, reviewer, security, test, web
```

No session, no cost, no answer from a model you did not ask for.

After a run it verifies what actually ran by querying `opencode.db` — the
newest `assistant` row in `message` carries `agent` and `modelID`. That catches
a misroute whatever upstream does to its warning text, and it catches misroutes
that never warn at all. The stderr match stays behind it for when the database
cannot be read; an empty read retries twice before giving up, because an empty
read and "ran as asked" must not look alike.

`run` defaults to the `plan` agent (edit denied) unless an agent is named, and
passes `--auto`, which approves whatever an agent's permission block does not
explicitly *deny* — without it any `ask` kills a non-interactive run outright
([trap 3](#3-reading-a-file-outside-the-project-kills-a-non-interactive-run)).
`--auto` cannot widen a `deny`, so `plan` stays read-only through the tool. But
`bash` is still `ask`-then-approved there, so a determined run could write
through the shell: treat `plan` as "will not edit", not as a sandbox.

## What is in here

| Path | What |
|---|---|
| `opencode.json` | Main config: models, compaction, tool output caps, watcher ignores, provider timeouts |
| `AGENTS.md` | Global rules, loaded into every request. **Keep byte-stable** — see below |
| `agents/` | 13 agent definitions (plus `build`, `plan` and `explore` in `opencode.json`), each pinned to a model chosen for its job |
| `skills/` | 10 on-demand skills |
| `plugins/` | `tandem.ts` (browser control), `fallback-proxy.ts` |
| `mcp/` | The Claude Code bridge. Registered by absolute path, never copied into `~/.config/opencode` — a second copy would be the one nobody runs and everybody edits |
| `test/` | `bun test`: fallback-proxy suite plus agent-routing invariants |

## Why it is built this way

These providers cache prompt prefixes, matched **from token 0, exactly**. A
cache hit skips prefill entirely — that is where the speed comes from. Anything
volatile near the top of the prompt destroys the cache for everything after it.

Three consequences are baked into this config:

- **`AGENTS.md` must stay byte-stable.** No dates, no session ids, no generated
  file trees. A larger stable file beats a smaller mutating one.
- **`compaction.prune` is `false`.** OpenCode's prune rewrites old tool outputs
  after *every* assistant turn once past ~40k tokens of tool output, which
  invalidates the cache continuously. Leave it off.
- **`temperature: 0`** on every code agent. DeepSeek's own guidance is 0.0 for
  code and math. `agents/docs.md` is the deliberate exception — it writes prose.

The `deepseek-context` skill carries the full reasoning.

## The fleet

Every agent pins its own model, so one dead model breaks one agent, not the
fleet. Every agent is `mode: all` — reachable as a primary (`run --agent`, and
the TUI's agent selector) and as a subagent (`task` from inside OpenCode).

| Agent | Model | Temp | For |
|---|---|---|---|
| `build` (default) | `deepseek-v4-pro` | 0 | Writing code. Edits allowed |
| `plan` | `kimi-k3` | 0.1 | Reads and reasons, edit denied |
| `architect` | `kimi-k3` | 0.2 | Shape of a thing before it is written |
| `design` | `qwen3.8-max` | **0.8** | How it looks and feels |
| `explore` | `gpt-5.6-luna` | 0 | Finding things across the repo |
| `debug` | `kimi-k2.7-code` | 0 | Something is failing right now |
| `refactor` | `kimi-k2.7-code` | 0 | Works already, make it better |
| `reviewer` | `kimi-k2.7-code` | 0 | Judge a diff before merge |
| `security` | `kimi-k2.7-code` | 0 | Audit. Read-only |
| `test` | `gpt-5.6-luna` | 0 | Write or run tests |
| `devops` | `qwen3.6-plus` | 0 | Docker, CI, shell, deployment |
| `docs` | `qwen3.7-plus` | default | Prose for humans |
| `council` | `gpt-5.6-luna` | 0.7 | One seat of a panel — **spawn N in parallel** ([trap 5](#5-an-agent-named-after-a-group-is-one-seat-of-it-and-nobody-seats-the-rest)) |
| `commit` | `gpt-5.6-luna` | 0 | Changes into commits. Git only |
| `fast` | `gpt-5.6-luna` | 0 | Small, obvious, one known file |
| `web` | `gpt-5.6-luna` | 0 | Drive the browser |
| `small_model` | `gpt-5.6-luna` | — | OpenCode's own internal calls |

### Model economics

Measured prices per million tokens:

| | input | output | cache_read |
|---|---|---|---|
| `gpt-5.6-luna` | 0.10 | 0.60 | 0.01 |
| `deepseek-v4-pro` | 0.435 | 0.87 | 0.003625 |
| `kimi-k2.7-code` | 0.95 | 4.00 | 0.19 |
| `glm-5.1` | **1.40** | **4.40** | **0.26** |

`glm-5.1` is strictly dominated — worse than `kimi-k2.7-code` on all three axes
and slower than both luna and deepseek on a measured task. It is pinned nowhere
and appears in no fallback chain; `bun test` enforces both.

`kimi-k3` is the priciest model here (3/15/0.3) and is kept only for `plan` and
`architect`, where the output is a design document and there is no cheap oracle
to verify a downgrade against.

### Every pinned model needs a chain

**Every model in that table needs an entry in `CHAINS`**
(`fallback-proxy-lib.ts`). A model with no chain has no fallback, and the
primary having no chain takes the whole session down when it goes. `bun test`
enforces this — it reads the pins straight out of `opencode.json` and
`agents/*.md`, so swapping a model in a hurry and forgetting the chain fails the
suite instead of failing silently at 3am.

Both deepseek models stay out of every chain's *candidate* list: a fallback has
to be more available than the thing it replaces, and these are the two models on
the account with a history of disappearing for a month. Being covered by a chain
is fine; being somebody else's safety net is not. `bun test` enforces it.

Note that the `opencode-go` and `opencode` tiers both carry a `deepseek-v4-pro`.
They are different models — the Go one displays as **"DeepSeek V4 Pro (New)"**,
the Zen one as plain "DeepSeek V4 Pro". This config pins the Go one everywhere.

### The Zen tier is disabled

```json
"disabled_providers": ["opencode"]
```

The Zen tier (Claude, GPT, Gemini) is switched off so the model picker only
shows what this config actually uses, and so a `zen/…` model cannot be picked
onto a tier with no chains behind it. To bring it back, drop the key — the
fallback proxy handles both tiers either way.

## Fallback proxy

`plugins/fallback-proxy.ts` rewrites both providers' `baseURL` to a loopback
server that forwards to the real upstream. When the requested model fails in a
way a different model could cover, it walks that model's chain and serves the
first candidate that answers, with a TUI toast naming what actually replied.

What it routes around is decided in `classifyPrimaryFailure`, on two axes:

- **Status**: `429`, `5xx` — transient, retry elsewhere.
- **Status + error type**: `401`/`403`/`404` carrying `ModelError` or
  `RegionError` — the model is gone for you. The same statuses with any other
  type (`AuthError`, `PermissionError`) are your problem, not the chain's, and
  go straight back so you see them on the first request instead of the fifth.

That second axis is the whole ballgame. It once listed `401`/`ModelError` only;
`deepseek-v4-pro` then went China-only behind `403`/`RegionError`, and the
primary model's outage passed through untouched with a healthy chain sitting
right there unused. **When upstream invents a new way to retire a model, widen
that list — not the chains.**

### The timeout coupling

Two timeouts have to agree or the fallback cannot fire:

| Where | Setting | Value |
|---|---|---|
| Client → proxy | `provider.*.options.headerTimeout` in `opencode.json` | 70000 |
| Proxy → upstream, per hop | `DEFAULT_HEADERS_TIMEOUT_MS` in `fallback-proxy-lib.ts` | 15000 |

`headerTimeout` has to cover the *whole* chain walk — the longest chain is four
hops, so 4 × 15s with margin. It was once 30s against a 60s per-hop budget,
which is backwards twice over: the proxy's own stall detection could never fire,
and the client aborting mid-walk kills the fallback outright, because an aborted
request is indistinguishable from the caller hanging up and the loop rethrows
rather than trying the next candidate.

## Inbound MCP policy

No inbound MCP servers are configured for OpenCode, deliberately. If a server
merely wraps a CLI you already have (`gh`, `git`, `docker`, `npm`), skip it —
bash calls those for free, and a 40-tool server costs ~20k tokens of context
window plus degraded tool selection.

MCP earns its cost only for things with no CLI equivalent. If you add one:

```json
"permission": { "mcp_*": "ask" }
```

The outbound direction — this fleet exposed *to* Claude Code — is
[the bridge](#connecting-it-to-claude-code), and it breaks this rule on purpose
for the reason given there.

## Traps that cost hours to find

None of these are documented upstream. Traps 1–3 make a non-interactive run hang
or die with no useful error; 4–6 produce a wrong result that looks right.

### 1. `permission` in a project `opencode.json` replaces, it does not merge

```jsonc
// This hangs. 'edit' and 'bash' silently revert to "ask", and in a
// non-interactive run there is nobody to answer.
{ "agent": { "build": { "permission": { "skill": "deny" } } } }
```

If you set `permission` on an agent at project level, **enumerate every tool you
need**, including the ones the global config already allowed.

### 2. `--print-logs` with stdout redirected to a file hangs

```bash
opencode run --print-logs "..." > out.log 2>&1   # hangs
opencode run "..." 2>&1 | tail -40 > out.log     # fine
```

Pipe it; do not redirect it. Get the session id from the database instead:
`select id from session order by time_created desc limit 1`.

### 3. Reading a file outside the project kills a non-interactive run

```
! permission requested: external_directory (~/.config/opencode/*); auto-rejecting
✗ Read ~/.config/opencode/AGENTS.md failed
Error: The user rejected permission to use this specific tool call.
```

Eight seconds, empty directory, exit 0. The agent reached for the global
`AGENTS.md`, `external_directory` defaulted to a prompt, nobody was there to
answer, and the rejection aborted the whole run instead of letting the agent
carry on without that file. Found by a benchmark, not by a user — which is the
point: interactively you click yes and never learn it exists.

Every agent that declares a `permission` block now carries
`external_directory: allow`, because of trap 1: the block replaces, so an agent
listing only `edit`/`bash` has no `external_directory` at all.

Two things that do **not** work:

```jsonc
// Hangs. The glob does not match, so it falls through to "ask".
"external_directory": { "**/.config/opencode/**": "allow" }
// Also hangs, for the same reason, with any pattern that misses.
```

Only the bare `"allow"` was verified to work. It is also the honest setting:
`build` already runs `bash: "allow"`, so it can `cat` any file on the machine.
Restricting `external_directory` underneath an unrestricted shell protects
nothing and only costs you runs.

### 4. A subagent pinned to the primary's own model hangs

Delegate to it and the child turn opens, emits zero tokens, and sits there until
something kills the run. In the session database it looks exactly like an
upstream stall — `out=0`, `finish=None`, no completion time — which sends you
hunting in the wrong place. Repin the identical task to any other model and it
finishes in seconds.

Measured twice, then confirmed by a controlled swap: `refactor` on the primary's
model stalled 2 for 2 and produced nothing; moved to another model it did the
refactor immediately. `security` and `council`, both on models different from
the primary, worked first try.

```bash
# the tell — same model on both rows, child never completes
opencode db "SELECT data FROM message WHERE data LIKE '%<run-dir>%'"
#   agent=build     model=deepseek-v4-pro  dur=3.5       out=46
#   agent=refactor  model=deepseek-v4-pro  dur=NEVER     out=0
```

`bun test` enforces the constraint, because nothing else surfaces it: no unit
test delegates, so the collision is invisible until real work hits it. The guard
is about *collision with whatever `model` is set to*, not about any particular
model — change the primary and a previously fine subagent becomes the broken one.

### 5. An agent named after a group is one seat of it, and nobody seats the rest

`council` was written as a single advisor holding a single lens — correct, and
useless on its own. Nothing in the config convened the panel, so "council this"
delegated **once** and came back with one cheap model's opinion wearing the
authority of an arbitrated verdict. The failure is silent: the output looks
exactly like a council output.

Subagents cannot delegate, so a seat can never convene its peers — the panel has
to be orchestrated by the primary. That protocol lives in the `llm-council`
skill (parallel seats → anonymised peer review → synthesis), the delegation
table says *N seats in parallel, never one*, and the agent's own description
leads with it, so a single call is wrong at every layer that could produce it.

Generalises past this one agent: if a subagent's name implies plurality, check
what actually spawns the plurality.

### 6. A subagent is not a primary, and OpenCode does not fail when you try

`opencode run --agent` only starts primary agents. A name in the fleet with
`mode: subagent` does not error — OpenCode warns on stderr ("agent X is a
subagent, not a primary agent. Falling back to default agent") and runs
`default_agent`, which here is `build`: `edit: allow`, `bash: allow`.

All 13 agents in `agents/*.md` had `mode: subagent`, and `explore` declared no
mode (which defaults to subagent). Measured result: asking for `security`,
`fast` or `explore` returned `agent=build model=deepseek-v4-pro` in all three
cases — verified in the OpenCode database, not from what the model claimed about
itself.

That inverts both arguments for delegating. Security: you asked for a read-only
specialist and got the write-enabled primary, with nothing saying so. Cost: the
reason to delegate is to pay less, and asking for `fast` (gpt-5.6-luna) while
getting deepseek-v4-pro meant delegating cost *more* than not delegating.

The fix is in three layers: every agent is now `mode: all`; the bridge
[refuses a non-primary before spawning](#the-guard) and checks the database
afterwards; and `test/agent-routing.test.ts` asserts that every agent declares
`mode: primary` or `all`. That test is an assertion about config on disk — no
model, no network.

One suspicion verified and discarded: resuming a session with `--session` while
also passing `--agent X` *does* change the agent. `--agent` wins. There is no
bypass through there.

### Bonus, for measuring

`sessionID` is a *column* (`session_id`) on `message`, not a field inside its
JSON.

Prompt size is `tokens.input` plus **both** cache counters. `input` alone
compares runs in different cache states and gives nonsense — but so does
`input + cache.read`, which is the half-fix: the first run against a given
prefix *writes* it, so the entire prompt lands in `cache.write` and `read` is
zero. A measured run reported `input: 3, cache.write: 8345` for an 8348-token
prompt. `total - output - reasoning` is the same number and is harder to get
wrong.

## Maintenance

```bash
opencode upgrade                      # autoupdate is set to "notify"
cd ~/.config/opencode && bun test     # proxy suite + routing invariants
opencode db "VACUUM"                  # then: PRAGMA wal_checkpoint(TRUNCATE)
```

Keep the plugin SDK in `package.json` matching your opencode version. Old
`~/.config/opencode.backup-*` directories are never pruned automatically —
delete the ones you do not need.
