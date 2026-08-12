---
name: strategic-compact
description: Decide when to compact an OpenCode session manually instead of letting auto-compaction fire at an arbitrary point. Covers phase-transition heuristics and what compaction costs on prefix-caching providers. Use when a session is getting long, before switching tasks, or when responses start losing earlier context.
metadata:
  origin: ECC (rewritten for OpenCode)
---

# Strategic Compact

Auto-compaction fires when the context is nearly full — which is almost never a
good moment. It can cut mid-implementation and throw away the variable names,
file paths and partial state you are actively using. Compacting *deliberately*
at a phase boundary keeps the useful part and drops the bulk.

In OpenCode: `/compact` in the TUI.

## What compaction actually costs

Two costs, and the second is invisible:

1. **Information** — everything before the tail is replaced by a summary.
   `compaction.tail_turns` (default 2) controls how many recent user turns stay
   verbatim.
2. **The prefix cache** — this is the one people miss. On DeepSeek, GLM, Kimi,
   Qwen and Anthropic, cached prefix tokens skip prefill entirely: cheaper and
   much faster. Compaction rewrites the conversation from the top, so the next
   request is a full cache miss and pays full prefill for the whole window.

So compaction is not free even when the context has room. Do it **once, at a
boundary**, rather than repeatedly. This is also why `compaction.prune` should
stay `false` on prefix-caching providers — it rewrites old tool outputs after
every assistant turn, invalidating the cache continuously instead of once.

## When to compact

| Phase transition | Compact? | Why |
|---|---|---|
| Research → Planning | Yes | Research context is bulky; the plan is the distilled output |
| Planning → Implementation | Yes | The plan lives in todos or a file; free the window for code |
| Implementation → Testing | Maybe | Keep if tests reference code just written; compact if focus shifts |
| Debugging → Next feature | Yes | Stack traces and dead ends pollute unrelated work |
| Mid-implementation | **No** | Losing paths, names and partial state costs more than it saves |
| After a failed approach | Yes | Clear the dead-end reasoning before trying again |
| Switching repo/project | Yes | Nothing carries over; start clean |

## Before compacting

Persist anything that must survive:

- Write the plan or decisions to a file — a summary is lossy by definition
- Note exact file paths currently in play
- Record the failing test or repro command verbatim
- Capture any command whose output you will need again

A compaction summary is a paraphrase. Anything you cannot afford to have
paraphrased belongs on disk before you compact.

## Signals it is time

- Responses start contradicting decisions made earlier in the session
- The model re-reads files it already read
- It "forgets" a constraint stated at the start
- Latency climbs steadily turn over turn

The first three mean the summary already happened or is overdue. The fourth
usually means a large window with no cache hits — check for volatile content at
the top of the prompt before blaming size. See `deepseek-context`.

## Related

- `context-budget` — measure fixed overhead per request
- `deepseek-context` — prefix-cache rules that make this matter
