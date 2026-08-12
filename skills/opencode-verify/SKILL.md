---
name: opencode-verify
description: Offload E2E browser verify to OpenCode+Tandem (glm-5.1, go tier); digest JSON (/opencode-verify).
disable-model-invocation: true
disabled-environments:
  - cloud
---

# OpenCode verify

**Cursor implements. OpenCode (+ Tandem) verifies in headless with a cheap model. Cursor only reads the digest.**

Does **not** remove Tandem from Cursor — this is the recommended path when Tandem would bloat the implementing agent.

Scripts in this skill's `scripts/` (run with `python3`). Product config: workspace `.cursor/opencode-verify.md`.

## Autonomy

- `/opencode-verify`, `/smoke`, “verifica con OpenCode”, “E2E smoke” = run this skill.
- Do **not** drive Tandem yourself for this ritual unless the digest fails and the user asks you to dig in-Cursor.
- Do **not** dump raw OpenCode NDJSON into chat — only the script JSON.

## Execute

Let `SCRIPTS` = this skill's `scripts/` directory.  
Let `CONFIG` = `<workspace>/.cursor/opencode-verify.md` (optional but preferred).

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

## Anti-goals

- Not a second Cursor / not MCP parity.
- Not Engram/Slack/Plane inside OpenCode.
- Not auto-merge or auto-commit from verify results.

## Setup

1. Copy `skills/opencode-verify/` to the agent runtime skills dir.
2. OpenCode CLI installed; model `opencode-go/glm-5.1` available (go tier — zen has no balance).
3. Tandem install for OpenCode: `plugins/tandem/install.sh --opencode`.
4. Product: `.cursor/opencode-verify.md` (model, cwd, base_url, persona, timeout).
