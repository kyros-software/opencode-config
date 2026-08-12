---
name: opencode-verify
description: Offload E2E browser verification to a headless OpenCode+Tandem run with a cheap model (glm-5.1, go tier) and read back a JSON digest. Use to smoke-test or verify a module after implementing changes, without loading browser noise into the implementing agent's context.
disable-model-invocation: true
disabled-environments:
  - cloud
---

# OpenCode verify

**You implement. A separate headless OpenCode + Tandem run verifies. You read only the digest.**

The point is context isolation: driving a browser generates snapshots, DOM and
network noise that would bloat whatever agent is doing the actual work. That
noise stays in the headless run; you get one JSON object back.

Scripts live in this skill's `scripts/` (run with `python3`).

## Autonomy

- `/opencode-verify`, `/smoke`, "verifica con OpenCode", "E2E smoke" = run this skill.
- Do **not** drive Tandem yourself for this ritual unless the digest fails and
  the user asks you to dig in.
- Do **not** dump raw OpenCode NDJSON into chat — only the script's JSON.

## Execute

Let `SCRIPTS` = this skill's `scripts/` directory.
Let `CONFIG` = the product config markdown, if the project has one (optional).

### 1. Run

```bash
python3 "$SCRIPTS/verify_run.py" --config "$CONFIG" --mode smoke
```

Module deep check:

```bash
python3 "$SCRIPTS/verify_run.py" --config "$CONFIG" --mode verify --module solicitudes
```

Optional: `--model provider/model`, `--cwd /path`, `--timeout 600`, `--attach http://localhost:4096`, `--dry-run`.

### 2. Read digest JSON

| `state` | Action |
|---------|--------|
| `pass` | Short OK to user; continue work. |
| `fail` | Show `summary` / FAILURES; fix code or re-run once. |
| `error` / `unknown` | Show `error` or `stderr_tail`; check Chrome (`tandem_status`) / stack up. |

Exit codes: `0` pass, `2` fail/unknown, `1` script error.

### 3. Prerequisites (if error)

1. Frontend/backend up (see product config `base_url`).
2. Chrome: no start command needed — `tandem_nav` launches it if it is down.
   `tandem_status` reports reachability.
3. OpenCode loads Tandem as a **plugin**, not an MCP server:
   `~/.config/opencode/plugins/tandem.ts` (registers the 14 `tandem_*` tools).

Optional warm server (avoids plugin cold boot on repeated runs):

```bash
opencode serve --port 4096
# then: verify_run.py ... --attach http://localhost:4096
```

## Output contract

`verify_run.py` prints **one JSON object** to stdout:

- `ok`, `state` (`pass`|`fail`|`error`|`unknown`)
- `mode`, `module`, `model`, `session_id`
- `summary` (capped text; expects `RESULT:` / `SUMMARY:` / `FAILURES:` block)
- `tools[]`, `errors[]`, `exit_code`, `next`

## Product config

Optional markdown file passed with `--config`, holding a key/value table:
`model`, `cwd`, `base_url`, `persona`, `timeout`. Anything not set there falls
back to the script defaults. Put it wherever the project prefers — the path is
just an argument, nothing is hardcoded.

## Anti-goals

- Not a general-purpose browser agent — for interactive navigation use the
  `web` subagent or drive `tandem_*` directly (see the `tandem` skill).
- Not auto-merge or auto-commit from verify results.

## Setup

1. Copy `skills/opencode-verify/` to the agent runtime skills dir.
2. OpenCode CLI installed; model `opencode-go/glm-5.1` available (go tier — zen has no balance).
3. Tandem installed for OpenCode as a plugin (`~/.config/opencode/plugins/tandem.ts`).
4. Optional product config (see above).
