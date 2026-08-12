#!/usr/bin/env python3
"""Run OpenCode headless E2E verify and emit a capped JSON digest."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from _lib import (
    DEFAULT_MODEL,
    build_prompt,
    digest_ndjson,
    emit,
    fail,
    parse_config_md,
    resolve_cwd,
    truncate,
)


def find_opencode() -> str | None:
    return shutil.which("opencode") or (
        str(Path.home() / ".opencode/bin/opencode")
        if (Path.home() / ".opencode/bin/opencode").is_file()
        else None
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--config",
        default="",
        help="Product config markdown with model/cwd/base_url/persona/timeout",
    )
    p.add_argument("--cwd", default="", help="Directory for opencode --dir")
    p.add_argument(
        "--mode",
        choices=("smoke", "verify"),
        default="smoke",
        help="smoke = shell check; verify = module deep check",
    )
    p.add_argument("--module", default="", help="Module name/path for --mode verify")
    p.add_argument("--model", default="", help="Override model (provider/model)")
    p.add_argument(
        "--timeout",
        type=int,
        default=0,
        help="Seconds (0 = use config or 600)",
    )
    p.add_argument(
        "--attach",
        default="",
        help="Optional opencode serve URL (e.g. http://localhost:4096)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the planned command + prompt digest, do not run",
    )
    args = p.parse_args()

    config_path = Path(args.config).expanduser() if args.config else None
    config = parse_config_md(config_path) if config_path else {}

    cwd = resolve_cwd(args.cwd or None, config)
    if not cwd.is_dir():
        fail(f"cwd not found: {cwd}")
        return 1

    model = (args.model or config.get("model") or DEFAULT_MODEL).strip()
    base_url = (config.get("base_url") or "http://localhost:5173").strip()
    persona = (
        config.get("persona")
        or "adviser1@example.com / password (Administrador Asesoría 1)"
    ).strip()
    timeout = args.timeout or int(config.get("timeout_sec") or "600")
    attach = (args.attach or config.get("attach") or "").strip()

    mode = args.mode
    module = args.module.strip()
    if mode == "verify" and not module:
        fail("verify mode requires --module")
        return 1

    prompt = build_prompt(
        mode=mode, module=module, base_url=base_url, persona=persona
    )

    opencode = find_opencode()
    if not opencode:
        fail("opencode binary not found in PATH or ~/.opencode/bin/opencode")
        return 1

    cmd = [
        opencode,
        "run",
        "--format",
        "json",
        "--auto",
        "--model",
        model,
        "--dir",
        str(cwd),
        "--title",
        f"verify:{mode}:{module or 'shell'}",
    ]
    if attach:
        cmd.extend(["--attach", attach])
    cmd.append(prompt)

    if args.dry_run:
        emit(
            {
                "ok": True,
                "dry_run": True,
                "cwd": str(cwd),
                "mode": mode,
                "module": module or None,
                "model": model,
                "timeout_sec": timeout,
                "attach": attach or None,
                "opencode": opencode,
                "prompt_preview": truncate(prompt, 800),
            }
        )
        return 0

    env = os.environ.copy()
    # Ensure tandem bins are reachable for bash tool calls inside OpenCode
    local_bin = str(Path.home() / ".local/bin")
    path = env.get("PATH", "")
    if local_bin not in path.split(":"):
        env["PATH"] = f"{local_bin}:{path}"

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        fail(
            f"opencode timed out after {timeout}s",
            cwd=str(cwd),
            mode=mode,
            module=module or None,
            model=model,
        )
        return 1

    digested = digest_ndjson(proc.stdout or "")
    stderr_tail = truncate((proc.stderr or "").strip(), 800)

    result = digested.get("result") or "unknown"
    # Map to skill-facing state
    if proc.returncode != 0 and result == "unknown":
        state = "error"
    elif result == "PASS":
        state = "pass"
    elif result in {"FAIL", "ERROR"}:
        state = result.lower()
    else:
        state = "unknown"

    ok = state == "pass"
    emit(
        {
            "ok": ok,
            "state": state,
            "result": result,
            "cwd": str(cwd),
            "mode": mode,
            "module": module or None,
            "model": model,
            "session_id": digested.get("session_id") or None,
            "summary": digested.get("text") or "",
            "tools": digested.get("tools") or [],
            "errors": digested.get("errors") or [],
            "exit_code": proc.returncode,
            "stderr_tail": stderr_tail or None,
            "next": (
                "Tell the user pass/fail from summary; fix only if fail."
                if state != "pass"
                else "E2E pass — continue or stop."
            ),
        }
    )

    if state == "pass":
        return 0
    if state in {"fail", "error", "unknown"}:
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
