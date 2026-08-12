"""Shared helpers for /opencode-verify scripts."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# Go tier, not zen: the zen provider has no balance on this account, and
# opencode-go/deepseek-v4-flash is gated behind a China-region opt-in.
DEFAULT_MODEL = "opencode-go/glm-5.1"
MAX_SUMMARY_CHARS = 4000
MAX_TOOL_NAMES = 40

CONFIG_KV_RE = re.compile(
    r"\|\s*\*\*(?P<key>[^*|]+)\*\*\s*\|\s*`?(?P<val>[^`|\n]+?)`?\s*\|",
    re.IGNORECASE,
)

RESULT_RE = re.compile(
    r"^\s*RESULT\s*:\s*(PASS|FAIL|ERROR)\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def emit(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False))


def fail(error: str, **extra: Any) -> None:
    payload = {"ok": False, "error": error, **extra}
    emit(payload)


def truncate(text: str, limit: int = MAX_SUMMARY_CHARS) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def parse_config_md(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    out: dict[str, str] = {}
    for m in CONFIG_KV_RE.finditer(text):
        key = m.group("key").strip().lower().replace(" ", "_")
        out[key] = m.group("val").strip()
    return out


def resolve_cwd(raw: str | None, config: dict[str, str]) -> Path:
    candidate = (raw or config.get("cwd") or ".").strip()
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    else:
        path = path.resolve()
    return path


def classify_result(text: str) -> str:
    m = RESULT_RE.search(text)
    if m:
        return m.group(1).upper()
    upper = text.upper()
    if re.search(r"\bFAIL(ED|URE)?\b", upper) and "RESULT" in upper:
        return "FAIL"
    if re.search(r"\bPASS(ED)?\b", upper) and "RESULT" in upper:
        return "PASS"
    # Heuristic when the model forgot the RESULT line
    if re.search(r"\b(FAIL|FAILED|FAILURE|ERROR|BROKEN)\b", upper):
        return "FAIL"
    if re.search(r"\b(PASS|PASSED|OK|SUCCESS)\b", upper):
        return "PASS"
    return "unknown"


def digest_ndjson(raw: str) -> dict[str, Any]:
    texts: list[str] = []
    tools: list[str] = []
    session_id = ""
    errors: list[str] = []

    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not session_id:
            session_id = str(ev.get("sessionID") or "")
        part = ev.get("part") if isinstance(ev.get("part"), dict) else {}
        etype = ev.get("type") or part.get("type") or ""

        if etype == "text" or part.get("type") == "text":
            t = part.get("text") or ev.get("text") or ""
            if t:
                texts.append(str(t))
        if part.get("type") == "tool" or etype in {"tool_use", "tool-call", "tool"}:
            name = (
                part.get("tool")
                or part.get("name")
                or ev.get("tool")
                or ev.get("name")
                or "tool"
            )
            tools.append(str(name))
        if etype in {"error", "session.error"} or part.get("type") == "error":
            msg = part.get("message") or ev.get("error") or ev.get("message") or line
            errors.append(str(msg))

    # Dedupe consecutive tool names; cap list
    deduped: list[str] = []
    for name in tools:
        if not deduped or deduped[-1] != name:
            deduped.append(name)
    deduped = deduped[:MAX_TOOL_NAMES]

    text = "\n".join(texts).strip()
    return {
        "session_id": session_id,
        "text": truncate(text),
        "tools": deduped,
        "errors": [truncate(e, 500) for e in errors[:10]],
        "result": classify_result(text) if text else ("ERROR" if errors else "unknown"),
    }


def build_prompt(*, mode: str, module: str, base_url: str, persona: str) -> str:
    mode = mode.strip().lower()
    module = module.strip()
    if mode == "smoke":
        scope = (
            "SMOKE: login if needed, reach /app/home, open one sidebar destination "
            "and confirm the shell loads without obvious errors."
        )
    else:
        target = module or "home"
        scope = (
            f"VERIFY module `{target}`: login if needed, navigate to the module route, "
            "exercise the main happy-path UI (list/filters/open detail if present), "
            "and report concrete failures (console/UI/network) if any."
        )

    return f"""You are an E2E verifier. Drive the browser with the tandem_* tools
(an OpenCode plugin, not an MCP server): tandem_nav, tandem_snap, tandem_refs,
tandem_click, tandem_type, tandem_press, tandem_wait, tandem_eval, tandem_cons,
tandem_net, tandem_html, tandem_screenshot, tandem_status, tandem_reset.

Do NOT dump full snapshots into the final answer — distill findings.

Environment:
- Base URL: {base_url}
- Persona: {persona}
- Site map: ~/.local/share/tandem/sites/localhost.md (read if useful)

Operating notes:
- tandem_nav starts Chrome if it is down. There is no separate start command.
  tandem_status reports reachability.
- Tandem already owns its own tab; you cannot and need not manage tabs.
- Actions take a ref (s1, s2, …) from a snapshot, never a CSS selector.
  tandem_wait and tandem_html do take selectors, but for waiting/reading only.
- tandem_refs is free (no page round-trip) — prefer it over re-snapping.
  Narrow snapshots with visible/role/tag instead of raising limit.
- tandem_click already refreshes refs; do not chain a snapshot after it.
- Evidence for PASS/FAIL comes from tandem_cons (exceptions), tandem_net
  (failuresOnly: true) and tandem_eval assertions — not from screenshots.
- If a captcha, 2FA or anti-bot checkpoint blocks the flow, stop and report it
  as ERROR naming the wall and the URL. Do not attempt to defeat it.

Task:
{scope}

When finished, end your reply with exactly this block (no markdown fences):
RESULT: PASS|FAIL|ERROR
SUMMARY: <one short paragraph>
FAILURES: <none | bullet-like short lines>
"""
