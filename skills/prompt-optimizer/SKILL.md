---
name: prompt-optimizer
description: Turns a vague request into a well-scoped one and routes it to the right subagent in this setup. Use when a task is ambiguous, when unsure which agent should handle it, or before kicking off multi-step work that would be expensive to redo.
metadata:
  origin: ECC (rewritten for this fleet)
---

# Prompt Optimizer

Two jobs: sharpen the request, then send it to the agent that should own it.

## Phase 1 — Find what is missing

A request is ready when all five are answerable. Ask only about what is
genuinely missing; do not interrogate.

1. **Task** — the verb. Fix, add, review, explain, migrate?
2. **Scope** — which files, modules, or repo. "The auth flow" is not scope.
3. **Constraints** — what must not change. Public API? Schema? Behaviour?
4. **Output** — a diff, a written answer, a passing test, a report?
5. **Done** — how success is checked. Which test, which command, what output.

Missing 1 or 2 → ask. Missing 3, 4 or 5 → state an assumption and proceed;
blocking on those wastes more time than a wrong guess costs.

## Phase 2 — Route to an agent

This setup runs a fleet where every agent pins its own model. Delegate by
*task shape*, not by topic.

| Signal in the request | Agent | Why |
|---|---|---|
| Stack trace, exception, "it broke" | `debug` | Symptom → root cause → fix |
| "Is this good?", pre-merge, a diff to judge | `reviewer` | Reads only, never edits |
| Working code, wants it cleaner | `refactor` | Behaviour-preserving, runs tests |
| Needs tests written or run | `test` | Knows the project's framework |
| Injection, auth, secrets, deps, CVEs | `security` | Read-only audit |
| Dockerfile, CI, Actions, shell, env | `devops` | Everything that is not app code |
| README, guides, JSDoc, prose | `docs` | The only agent tuned for prose |
| Diff → commit message → commit | `commit` | Conventional commits, git only |
| One obvious edit in a known file | `fast` | Cheap model, no over-analysis |
| "Where is X?", search across the repo | `explore` | Cheap, read-only sweep |
| Multi-file feature, real implementation | `build` | The primary, keep it here |

Routing rules that matter:

- **A broken thing goes to `debug`, not `reviewer`.** Reviewer judges healthy
  code; it will not chase a live failure.
- **`refactor` and `debug` are not interchangeable.** Refactor assumes the code
  works. Debug assumes it does not.
- **Do not delegate to `fast` anything needing more than one step.** It is
  prompted to bail out and say so, which costs a round-trip.
- **`subagent_depth` is 1.** A subagent cannot spawn another. If work needs two
  specialists, the primary orchestrates both — do not chain them.
- **Delegation is not free.** A subagent starts with a cold context and re-reads
  what the primary already has. For a small task inside a file already open,
  doing it inline is faster than any handoff.

## Phase 3 — Write the delegation

When handing off, pass the five things from Phase 1 explicitly. The subagent
sees none of the conversation — only what is written in the prompt.

```
Task:        <verb + object>
Files:       <exact paths, already located>
Constraints: <what must not change>
Output:      <diff | report | passing test>
Verify:      <exact command to run>
```

Omitting `Files:` is the most common failure: the subagent burns its budget
re-discovering what the primary already knew.

## Phase 4 — Model-specific phrasing

The models here (DeepSeek, Kimi, GLM, Qwen) reward explicit structure more than
Claude does, and punish vagueness harder.

- State the output format. Without it, formats drift between calls.
- State the verification step, or work gets reported as done unverified.
- Do not add "think step by step" — it duplicates internal reasoning.
- Keep stable framing at the top of the prompt; volatile detail last.

See `deepseek-context` for the reasoning.

## Anti-patterns

| Instead of | Write |
|---|---|
| "Fix the login" | "Login throws `TypeError: undefined` at `auth.ts:42` on empty password. Fix and add a regression test." |
| "Make it better" | "Extract the 200-line `handleRequest` into named functions. Behaviour unchanged, `bun test` still green." |
| "Review my code" | "Review the diff on this branch for auth bypasses and unhandled rejections. Report only, no edits." |

## Related

- `deepseek-context` — how these models want their context
- `verification-loop` — the checklist before calling something done
- `context-budget` — what all this costs per request
