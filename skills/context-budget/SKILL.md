---
name: context-budget
description: Audits OpenCode context window consumption across agents, skills, plugins, MCP servers and instructions. Identifies bloat and produces prioritized token-savings recommendations. Use when the context window fills too fast, the TUI feels sluggish, or before adding new skills/MCP servers.
metadata:
  origin: ECC (adapted for OpenCode)
---

# Context Budget

Analyze token overhead across every component OpenCode loads into the system prompt, and surface actionable ways to reclaim context.

## When to Use

- Session performance feels sluggish or output quality degrades
- You recently added skills, agents, plugins, or MCP servers
- You want to know how much context headroom you actually have
- Before adding more components, to check whether there is room

## Phase 1: Inventory

Scan and estimate token consumption. Config resolution order: global
`~/.config/opencode/opencode.json` → project `opencode.json`/`.opencode/`.

**`instructions` array** (config key) — THE most expensive thing here.
Every file listed loads **in full, on every request**.
```bash
python3 -c "
import json,os,glob
c=json.load(open(os.path.expanduser('~/.config/opencode/opencode.json')))
tot=0
for p in c.get('instructions',[]):
    for f in glob.glob(os.path.expanduser(p)):
        s=os.path.getsize(f); tot+=s; print(f'{s:8d}  {f}')
print(f'TOTAL {tot} bytes ~= {tot//4} tokens PER REQUEST')"
```
Flag: any single file >8 KB, or combined total >20 KB.

**AGENTS.md chain** — global + project + nested. Same cost model as above.
Flag: combined >300 lines.

**Skills** (`~/.config/opencode/skills/*/SKILL.md`, plus `skills.paths`)
Only the frontmatter `name` + `description` enter the system prompt; the body
loads on demand. So skills are cheap *unless* you have hundreds.
```bash
python3 -c "
import glob,re,os
tot=0;n=0
for f in glob.glob(os.path.expanduser('~/.config/opencode/skills/*/SKILL.md')):
    t=open(f,errors='ignore').read()
    m=re.search(r'^---\n(.*?)\n---',t,re.S)
    if m: tot+=len(m.group(1)); n+=1
print(f'{n} skills, {tot} bytes frontmatter ~= {tot//4} tokens per request')"
```
Flag: >100 skills, or any description >60 words.

**Plugins** (`~/.config/opencode/plugins/*.ts`) — each registered tool ships its
name, description and full arg schema in every request.
```bash
grep -oE '^\s*[a-z_]+: tool\(' ~/.config/opencode/plugins/*.ts | wc -l
```
Estimate ~150-500 tokens per tool depending on schema size.

**MCP servers** (`mcp` key in opencode.json) — same cost as plugin tools, but
usually worse: a 30-tool server can outweigh every skill you own.
Flag: >10 tools per server; any server that merely wraps a CLI you already have
(`gh`, `git`, `npm`, `docker`) — bash calls those for free.

**Agents** (`agent` key + `~/.config/opencode/agents/*.md`)
Each subagent's `description` is always present so the primary agent knows when
to delegate. The `prompt` only loads when that agent actually runs.
Flag: description >30 words; agent bodies >200 lines.

## Phase 2: Classify

| Bucket | Criteria | Action |
|--------|----------|--------|
| **Always needed** | Referenced by AGENTS.md, backs an active command, matches current project type | Keep |
| **Sometimes needed** | Domain-specific, not referenced anywhere | Move to on-demand (skill, not `instructions`) |
| **Rarely needed** | No reference, overlapping content, no project match | Remove |

The single highest-leverage move is almost always: **take a file out of
`instructions` and make it a skill instead.** Same knowledge, ~95% less cost,
because only the description stays resident.

## Phase 3: Detect Issues

- **`instructions` bloat** — full documents resident on every request
- **MCP over-subscription** — servers wrapping free CLI tools
- **Bloated descriptions** — skill/agent descriptions written as documentation
- **Redundancy** — a skill duplicating an agent prompt, rules duplicating AGENTS.md
- **Volatile content in stable position** — see below, this is a DeepSeek killer

## Phase 4: Report

```
Context Budget Report
═══════════════════════════════════════
Total fixed overhead: ~XX,XXX tokens/request
Model window: XXXK  →  effective headroom: ~XX%

┌─────────────────┬────────┬───────────┐
│ Component       │ Count  │ Tokens    │
├─────────────────┼────────┼───────────┤
│ instructions    │ N      │ ~XX,XXX   │
│ AGENTS.md       │ N      │ ~X,XXX    │
│ Skills (fm)     │ N      │ ~X,XXX    │
│ Plugin tools    │ N      │ ~X,XXX    │
│ MCP tools       │ N      │ ~XX,XXX   │
│ Agent descs     │ N      │ ~X,XXX    │
└─────────────────┴────────┴───────────┘

Top 3 optimizations, ranked by tokens saved.
```

## Prefix-cache note (DeepSeek, GLM, Kimi, Qwen)

On providers with prefix caching, overhead is not only about size — it is about
**stability**. Cached prefix tokens are far cheaper and skip prefill entirely,
but the match runs from token 0 and must be exact. One volatile line near the
top (timestamp, session id, git SHA, "today is…") invalidates everything after it.

So: a 5 KB **stable** AGENTS.md is cheaper in practice than a 2 KB one that
embeds the current date. Audit for volatility, not just for length.
See the `deepseek-context` skill.

## Best Practices

- Estimate with `chars / 4`; good enough for ranking
- Re-audit after adding any skill, plugin, or MCP server
- `opencode --pure` starts without external plugins — use it to A/B the cost of yours
- Prefer bash over an MCP server whenever the MCP is a thin CLI wrapper
