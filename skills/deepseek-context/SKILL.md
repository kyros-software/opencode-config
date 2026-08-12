---
name: deepseek-context
description: How to feed context to DeepSeek models (v4-pro/flash) for maximum cache hits, lowest latency and best instruction-following. Covers prefix-cache rules, prompt block ordering, temperature per task type, file/document framing and tool-calling phrasing. Use when writing AGENTS.md, designing prompts or agents, or debugging why DeepSeek ignores instructions or feels slow.
metadata:
  origin: local
---

# Giving context to DeepSeek

DeepSeek is not Claude. Two differences drive everything below:

1. **Prefix caching is automatic and matches from token 0.** Cached prefix
   tokens skip prefill — cheaper and much faster. But the match must be exact
   and contiguous from the very beginning. A partial match mid-prompt is worth
   nothing.
2. **It follows explicit structure better than implied intent.** Vague
   "be helpful, use good judgment" prose underperforms an ordered list of
   constraints and an explicit output format.

## Rule 1 — Stable first, volatile last

This is the single highest-leverage rule. Cache units are formed at request
boundaries and at fixed token intervals. If request A is `S + X` and request B
is `S + Y`, B reuses `S`. If anything inside `S` shifts by one token, the whole
cache after that point is gone.

```
┌─ token 0 ────────────────────────────────────────────┐
│ 1. System: role, hard constraints, output format     │  never changes
│ 2. Tool schemas                                      │  changes on config edit
│ 3. Reference: AGENTS.md, standards, retrieved docs   │  changes rarely
│ 4. Task: what to do this turn                        │  changes per call
│ 5. User input, timestamps, ids, current file state   │  changes always
└──────────────────────────────────────────────────────┘
```

**Never put near the top:** current date/time, session id, git SHA, random
seeds, `Generated at …`, a file tree that mutates, cwd when it changes,
"today the user is working on X".

Practical consequence for OpenCode: keep `AGENTS.md` **byte-stable**. Do not
template a date into it, do not auto-generate it per session. A larger stable
AGENTS.md beats a smaller one that mutates.

Verify with the usage fields the API returns:
`prompt_cache_hit_tokens` vs `prompt_cache_miss_tokens`. A healthy long session
is mostly hits. If hits are near zero on turn 2 of a conversation, something
volatile is sitting at the top.

## Rule 2 — Temperature by task, not one global value

DeepSeek's own recommendation:

| Task | Temperature |
|---|---|
| Code, math, refactors, build fixes | **0.0** |
| Data analysis, extraction | 1.0 |
| General conversation, translation | 1.3 |
| Creative writing | 1.5 |

Coding agents should sit at 0.0–0.1. Anything higher and it starts inventing
API surfaces that do not exist.

## Rule 3 — State the five things

The strongest DeepSeek prompts always define:

1. **Task** — the verb, unambiguous
2. **Context** — only what is needed; do not dump the repo
3. **Constraints** — what it must not do, as a list
4. **Output format** — exact shape (diff / JSON schema / file path + code block)
5. **Verification** — how the result will be checked

Skip 4 and you get mixed formats across calls. Skip 5 and it stops early and
claims success.

## Rule 4 — Frame documents with explicit markers

When injecting file contents or retrieved docs, delimit them and put the
question *after*, never interleaved. This reduces instruction leakage — the
model treating document text as commands to obey.

```
<file path="src/auth.ts">
...contents...
</file>

Question: ...
```

Same pattern for multiple files. Keep the block order stable across calls so
the prefix cache survives.

## Rule 5 — Tool calling needs when + what-next

Do not just describe what a tool does. Describe **when to call it** and **what
to do with its result**. DeepSeek under-calls tools that are documented only by
their capability, and over-calls tools with vague trigger conditions.

Bad:  `search_docs: searches the documentation`
Good: `search_docs: call when the user references a library API you cannot
       verify from the repo. Use the returned snippet verbatim; if it returns
       nothing, say so instead of guessing.`

Use JSON-schema params with strict typing. Keep arg descriptions short — they
are resident in every request.

## Rule 6 — Reasoning models: do not pre-chew

For reasoning variants, do **not** add "think step by step" or supply a
chain-of-thought scaffold. It duplicates internal reasoning and degrades output.
Give the goal and the constraints, then get out of the way. Few-shot examples
also hurt reasoning models more often than they help — prefer a clear spec.

## Checklist for AGENTS.md on DeepSeek

- [ ] No timestamps, no session ids, no generated file trees
- [ ] Constraints as a flat list, not narrative prose
- [ ] Output/format conventions stated explicitly
- [ ] Stable byte-for-byte between sessions
- [ ] Short enough to read, long enough to be unambiguous
- [ ] Project-specific volatile facts live in the conversation, not the file

## Related

- `context-budget` — measure what is actually resident per request
- `strategic-compact` — when to compact so the cached prefix is not destroyed
