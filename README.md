# opencode-config

Portable OpenCode setup. Tuned for prefix-caching providers (DeepSeek, GLM,
Kimi, Qwen) with a per-task subagent fleet.

## Install

```bash
git clone <this-repo> ~/opencode-config
cd ~/opencode-config
./install.sh            # --dry-run to preview
```

Backs up any existing `~/.config/opencode` to `~/.config/opencode.backup-<timestamp>`
before writing.

**Not included, by design:** credentials (`auth.json`) and session history.
After installing, run `opencode auth login`.

## What is in here

| Path | What |
|---|---|
| `opencode.json` | Main config: models, compaction, tool output caps, watcher ignores, provider timeouts |
| `AGENTS.md` | Global rules, loaded into every request. **Keep byte-stable** — see below |
| `agents/` | 9 subagents, each pinned to a model chosen for its job |
| `skills/` | 7 on-demand skills |
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
| plan | `kimi-k3` | 0.1 |
| explore | `glm-5.1` | 0 |
| test | `deepseek-v4-pro` | 0 |
| debug, reviewer | `kimi-k2.7-code` | 0 |
| refactor, security | `kimi-k3` | 0 |
| devops | `qwen3.6-plus` | 0 |
| docs | `qwen3.7-plus` | default |
| commit, fast | `glm-5.1` | 0 |
| `small_model` | `glm-5.1` | — |

Verify they all resolve on a new machine:

```bash
opencode models opencode-go
for m in deepseek-v4-pro kimi-k3 kimi-k2.7-code glm-5.1 qwen3.6-plus qwen3.7-plus; do
  printf '%-18s ' "$m"
  opencode run --model "opencode-go/$m" "say OK" 2>&1 | tail -1
done
```

Known dead as of Aug 2026: `deepseek-v4-flash` (China-region opt-in required),
`kimi-k2.6` (`invalid_request`).

## MCP

None configured, deliberately. If an MCP server merely wraps a CLI you already
have (`gh`, `git`, `docker`, `npm`), skip it — bash calls those for free, and a
40-tool server costs ~20k tokens of window plus degraded tool selection.

MCP earns its cost only for things with no CLI equivalent. If you add one:

```json
"permission": { "mcp_*": "ask" }
```

## Maintenance

```bash
opencode upgrade                      # autoupdate is set to "notify"
cd ~/.config/opencode && bun test     # fallback-proxy suite
opencode db "VACUUM"                  # then: PRAGMA wal_checkpoint(TRUNCATE)
```

Keep the plugin SDK in `package.json` matching your opencode version.
