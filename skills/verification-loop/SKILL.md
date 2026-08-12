---
name: verification-loop
description: Checklist to run before claiming work is complete — build, types, lint, tests, diff review — with the commands discovered from the project rather than assumed. Use after finishing a change, before opening a PR, or whenever about to report something as done.
license: MIT
metadata:
  origin: ECC (rewritten)
---

# Verification Loop

"Should work" is not a result. This is the gate between doing the work and
saying it is done.

## Step 0 — Find the real commands

Do not assume npm. Detect, then run what the project actually uses.

```bash
ls package.json bun.lock pnpm-lock.yaml yarn.lock Cargo.toml go.mod \
   pyproject.toml Makefile 2>/dev/null
```

- `package.json` → read its `scripts` block. That is the source of truth for
  build/test/lint, whatever the runner underneath is.
- Lockfile decides the runner: `bun.lock` → bun, `pnpm-lock.yaml` → pnpm,
  `yarn.lock` → yarn, otherwise npm.
- `Cargo.toml` → `cargo build` / `cargo test` / `cargo clippy`
- `go.mod` → `go build ./...` / `go test ./...` / `go vet ./...`
- `pyproject.toml` → check for pytest, ruff, mypy/pyright in its config
- `Makefile` → grep its targets before inventing anything

If the project has a CI workflow, read it: `.github/workflows/*.yml` states
exactly which commands must pass. Match those, not your habits.

## The phases

Run in order. A failure at one stage makes later stages meaningless — stop and
fix rather than collecting a list of downstream noise.

1. **Build** — must compile before anything else means anything.
2. **Types** — `tsc --noEmit`, `mypy`, `pyright`, or whatever the project uses.
3. **Lint** — only if the project has it configured. Do not introduce a linter
   as part of a verification run.
4. **Tests** — run them. Report the real numbers: passed, failed, skipped.
   Only mention coverage if the project enforces a threshold; inventing an "80%
   target" the project never set is noise.
5. **Diff review** — `git diff` (or `git diff --cached`). Read every hunk and
   look for: changes you did not intend, debug output left behind, error paths
   that got dropped, a case the change now silently misses.

Use `set -o pipefail` when piping to `head`/`tail`, or a failure exits 0 and you
report a pass that never happened.

## Report

```
Build:   PASS | FAIL
Types:   PASS | FAIL  (N errors)
Lint:    PASS | FAIL | n/a
Tests:   PASS | FAIL  (X passed, Y failed, Z skipped)
Diff:    N files

Verdict: READY | NOT READY

Outstanding:
- ...
```

**Do not fill in a phase you did not run.** `n/a` and "not run" are honest;
a fabricated PASS is the single worst outcome this skill can produce. If a
phase could not run — no test script, build needs credentials you lack — say
that plainly and say why.

## What this is not

It does not scan for vulnerabilities. Grepping for `sk-` and `api_key` finds
almost nothing real and gives false confidence — use the `security-review`
skill or the `security` subagent for that.

It is a checklist you run deliberately, not an automated gate, and not
something to fire on a timer.

## Related

- `security-review` — actual security checklist
- `opencode-verify` — E2E browser verification in a separate headless run
