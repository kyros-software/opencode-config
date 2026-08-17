---
name: llm-council
description: Convenes a panel of advisors on one decision — several `council` subagents in parallel, each pinned to a different lens, then an anonymised peer-review round, then a chairman synthesis. Use on "council this", "war room this", "pressure-test this", "stress-test this", "debate this", and on real either/or decisions with stakes ("should I X or Y", "which option", "I'm torn between"). Not for factual lookups, single-answer questions, or work that just needs doing.
metadata:
  origin: local (Karpathy's LLM Council, adapted to this fleet)
---

# LLM Council

One model answers, you get one answer, and no way to tell whether it is good or
merely fluent. The panel fixes that: independent advisors on fixed lenses, an
anonymous peer-review round, then a synthesis that names where they agree, where
they clash, and what to do.

## The failure this exists to prevent

**One `task` call to `council` is not a council.** `council` is a *seat*, not the
panel. Delegating once and reporting what came back produces a single opinion
from a cheap model, dressed as arbitration — strictly worse than answering
yourself, because it looks like it was contested and it wasn't.

The panel is orchestrated **here**, by the primary agent. Subagents cannot
delegate, so no seat can convene the others.

## When to convene

Convene when being wrong is expensive and there is a genuine fork: two viable
paths, a pivot, a price, an architecture that is hard to reverse, a plan you
want attacked before you commit to it.

Do not convene for: a question with one right answer, a lookup, a task that
just needs doing, or when the user wants validation for a call already made
(the panel will not give it — that is the point, but say so first rather than
burning ten agent calls on it).

If the input is too vague to frame (`council this: my business`), ask **one**
clarifying question, then proceed.

## Step 1 — Frame the question

Write a single neutral prompt that every seat receives. It must carry:

1. the decision, stated as a decision;
2. the context that makes it specific — numbers, constraints, what was already
   tried, what is at stake;
3. nothing of your own opinion, and no steering.

Pull that context from the repo before framing (`AGENTS.md`, the relevant
source, prior decisions in `README.md`) — 30 seconds of it. Advisors given no
grounding return advice that would fit any question, which is the other way a
panel degrades into noise.

## Step 2 — Seat the panel (parallel)

Fire **all seats in a single message**, one `task` call each, `subagent_type:
council`. How many actually run at once is up to the runtime — measured, the
primary keeps about two in flight and starts the next as one lands, so a full
panel takes a couple of minutes. That is fine: what a seat must never see is
another seat's answer, and issuing them together guarantees that. Seats spawned
one at a time across separate turns do not.

Default panel — five lenses, chosen because they pull against each other:

| Seat | Lens |
|---|---|
| Contrarian | Assumes a fatal flaw exists and hunts it. Not a pessimist — the friend who asks the question you are avoiding. |
| First principles | Ignores the surface question. "What are we actually solving?" Often the highest-value output is *you are asking the wrong question*. |
| Expansionist | Upside only. What is being undervalued, what is the adjacent opportunity, what if this works better than expected. Risk is someone else's seat. |
| Outsider | Zero context about the user, the field, the history. Reacts to what is literally in front of them. Catches the curse of knowledge. |
| Executor | Can it be done, and what happens Monday morning. Ignores theory. If a brilliant idea has no first step, says so. |

Three tensions fall out of that set: Contrarian vs Expansionist (downside vs
upside), First principles vs Executor (rethink it vs ship it), Outsider keeping
everyone honest in the middle.

Swap a seat when the domain demands it — for a technical decision, *the
maintainer inheriting this in six months* or *the operator at 3am* usually
beats Outsider. Keep the count and keep the tensions.

Each seat's prompt:

```
Eres [seat] en un panel.

Tu lente: [lens, verbatim from the table]

La pregunta que llega al panel:
---
[framed question]
---

Responde solo desde tu lente. No equilibres, no cubras los otros ángulos —
otro asiento ya los cubre. 150-300 palabras, sin preámbulo.
```

**Quick council** (user says "quick", or the stakes are moderate): three seats —
Contrarian, First principles, Executor — and skip step 3. Say which mode you ran.

## Step 3 — Peer review (parallel, anonymised)

This round is what separates a panel from asking the same thing five times.

Collect the answers, relabel them **A–E in an order that is not seat order**,
and strip every trace of which lens produced which. Then fire **one reviewer per
seat** — five seats, five reviewers — same `council` agent, same single message,
each reviewer seeing all five answers:

```
Revisas la salida de un panel. Cinco consejeros respondieron, de forma
independiente, a esto:
---
[framed question]
---

Respuestas anónimas:
**A:** [...]  **B:** [...]  **C:** [...]  **D:** [...]  **E:** [...]

Responde, citando por letra, en menos de 200 palabras:
1. ¿Cuál es la más fuerte y por qué?
2. ¿Cuál tiene el punto ciego más grande, y cuál es?
3. ¿Qué se les escapó a las cinco?
```

Anonymise properly. A reviewer who knows the Contrarian wrote D evaluates the
lens, not the argument.

## Step 4 — Chairman synthesis

**You** are the chairman. Do not delegate this: you hold the framed question,
all answers, all reviews and the conversation they came from, and a subagent
holds none of it.

Output straight into the chat — no files, no HTML — in this shape:

```
## Council Verdict: {topic in four words}

### Where the council agrees
Points several seats reached independently. High-confidence signal.

### Where the council clashes
The real disagreements. Do not smooth them. Both sides, and why reasonable
advisors land differently.

### Blind spots the council caught
Only what surfaced in review — what one seat missed and another named.

### The recommendation
A call. Not "it depends". You may side with a lone dissenter against four
others if the reasoning is better — say that you are doing it and why.

### The one thing to do first
One concrete next step. One. Not a list.
```

Then stop. Do not act on the verdict unless asked — the panel produces
judgement, the user decides what to do with it.

## What this costs, and its one real limit

Ten `council` calls on `gpt-5.6-luna` (0.10 / 0.60 per M) — cheap enough that
the deciding factor is whether the decision deserves a panel, not the bill.

Every seat runs the **same model**. Diversity here comes from the lenses, not
from model lineage, which is weaker than Karpathy's original (he varies models).
The seat model is pinned in `agents/council.md`, and it is deliberately from a
different lineage than `build`, `plan` and `architect` — the agents the panel
exists to pressure-test. A second lineage on the panel would mean a second seat
agent file; `task` takes no per-call model override.
