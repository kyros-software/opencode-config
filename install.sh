#!/usr/bin/env bash
# Installs this OpenCode configuration into the current machine.
# Idempotent: re-running it refreshes the config and re-backs-up whatever was there.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
STAMP="$(date +%Y%m%d-%H%M%S)"

# The Claude Code bridge is deliberately NOT copied into $DEST. It is registered
# with Claude Code by absolute path and runs from this clone; a second copy under
# $DEST would be the one nobody runs and everybody edits. The clone has to stay.
MCP_SRC="$SRC/mcp/opencode-mcp.ts"

DRY=0
REGISTER_MCP=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-mcp)  REGISTER_MCP=0 ;;
    *) printf 'usage: install.sh [--dry-run] [--no-mcp]\n' >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn\033[0m %s\n' "$*"; }
run()  { if [[ $DRY -eq 1 ]]; then echo "  [dry] $*"; else "$@"; fi; }

# ---------------------------------------------------------------- preflight
if ! command -v opencode >/dev/null 2>&1; then
  warn "opencode is not on PATH. Install it first:"
  warn "  curl -fsSL https://opencode.ai/install | bash"
  exit 1
fi

OC_VERSION="$(opencode --version 2>/dev/null || echo unknown)"
PKG_VERSION="$(node -e "process.stdout.write(require('$SRC/package.json').dependencies['@opencode-ai/plugin'])" 2>/dev/null || echo unknown)"
say "opencode $OC_VERSION  |  plugin SDK pinned at $PKG_VERSION"
if [[ "$OC_VERSION" != "$PKG_VERSION" && "$PKG_VERSION" != "unknown" ]]; then
  warn "Version mismatch. After install, consider:"
  warn "  cd $DEST && bun add @opencode-ai/plugin@$OC_VERSION"
fi

# The bridge imports `bun:sqlite`, so it runs under bun and under nothing else.
# npm can still install the plugin deps below, which is why this warns rather than
# exiting — but the failure it warns about is silent otherwise: the fleet works,
# the bridge never connects, and the smoke test that would have caught it is
# itself skipped for want of bun. Say it before anything is copied.
if ! command -v bun >/dev/null 2>&1; then
  warn "bun is not on PATH — the Claude Code bridge cannot run (it imports bun:sqlite)."
  warn "  curl -fsSL https://bun.sh/install | bash"
fi

# ---------------------------------------------------------------- backup
# Note: the preflight above runs `opencode --version`, which creates an empty
# $DEST as a side effect. So test for actual content, not mere existence —
# otherwise every fresh machine accumulates empty backup dirs.
if [[ -d "$DEST" ]] && [[ -n "$(ls -A "$DEST" 2>/dev/null)" ]]; then
  BACKUP="$DEST.backup-$STAMP"
  say "Backing up existing config → $BACKUP"
  # Everything except node_modules: it is 63 MB per backup, it is the only
  # large thing in there, and `bun install` below rebuilds it from bun.lock.
  # cp has no --exclude, and copying it to delete it afterwards still pays
  # the I/O — so walk the entries instead.
  run mkdir -p "$BACKUP"
  shopt -s dotglob nullglob
  for entry in "$DEST"/*; do
    [[ "${entry##*/}" == "node_modules" ]] && continue
    run cp -a "$entry" "$BACKUP/"
  done
  shopt -u dotglob nullglob
else
  say "No existing config to back up"
fi

# ---------------------------------------------------------------- install
say "Installing into $DEST"
run mkdir -p "$DEST"

for item in opencode.json AGENTS.md package.json fallback-proxy-lib.ts bun.lock; do
  [[ -e "$SRC/$item" ]] && run cp "$SRC/$item" "$DEST/$item"
done

for dir in agents skills plugins test; do
  [[ -d "$SRC/$dir" ]] || continue
  run rm -rf "$DEST/$dir"
  run cp -a "$SRC/$dir" "$DEST/$dir"
done

# ---------------------------------------------------------------- deps
say "Installing plugin dependencies"
if [[ $DRY -eq 0 ]]; then
  if command -v bun >/dev/null 2>&1; then
    # A package-lock.json left by an earlier npm-fallback run is not read by bun
    # and drifts from bun.lock on the next dependency change. Drop it.
    [[ -e "$DEST/package-lock.json" ]] && rm -f "$DEST/package-lock.json"
    (cd "$DEST" && bun install --silent)
  elif command -v npm >/dev/null 2>&1; then
    (cd "$DEST" && npm install --no-audit --no-fund --loglevel=error)
  else
    warn "Neither bun nor npm found — plugins will not load until you install deps."
  fi
fi

# ---------------------------------------------------------------- verify
say "Verifying"
if [[ $DRY -eq 0 ]]; then
  # bun first: it is already required for the bridge, and a machine running this
  # stack on bun alone would otherwise skip this check with a bare
  # "node: command not found" and still reach Done.
  JS_BIN="$(command -v bun || command -v node || true)"
  if [[ -n "$JS_BIN" ]]; then
    "$JS_BIN" -e "JSON.parse(require('fs').readFileSync('$DEST/opencode.json','utf8'))" \
      && echo "  opencode.json parses"
  else
    warn "neither bun nor node on PATH — opencode.json was not validated"
  fi
  echo "  agents: $(find "$DEST/agents" -name '*.md' 2>/dev/null | wc -l)"
  echo "  skills: $(find "$DEST/skills" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)"

  # Speak one line of MCP at the bridge rather than checking the file exists: a
  # server that is present but cannot answer `initialize` shows up in Claude Code
  # as "failed to connect", with nothing here having warned about it.
  if [[ -f "$MCP_SRC" ]] && command -v bun >/dev/null 2>&1; then
    TIMEOUT_BIN="$(command -v timeout || true)"
    if printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install","version":"0"}}}' \
       | ${TIMEOUT_BIN:+$TIMEOUT_BIN 15} bun "$MCP_SRC" 2>/dev/null | grep -q '"serverInfo"'; then
      echo "  mcp bridge answers the MCP handshake"
    else
      warn "mcp/opencode-mcp.ts did not answer an MCP initialize — the bridge will not connect"
    fi
  fi
fi

cat <<'EOF'

Done. Two things this package deliberately does NOT carry:

  1. Credentials. ~/.local/share/opencode/auth.json stays on the old machine.
     Authenticate here with:  opencode auth login

  2. Session history and the local database.

Then check the models resolve on this account:

     opencode models opencode-go
     opencode run "say OK"

If a model 404s or reports a region opt-in, swap it in opencode.json and in
agents/*.md — every agent pins its own model.
EOF

# ---------------------------------------------------------------- mcp bridge
# Installing the config does not expose the fleet to Claude Code — that is a
# separate registration, and leaving it undocumented here is how a fresh machine
# ends up with a complete config and no bridge, with nothing to say why.
BUN_BIN="$(command -v bun || true)"
if [[ ! -f "$MCP_SRC" ]] || [[ $REGISTER_MCP -eq 0 ]]; then
  :
elif ! command -v claude >/dev/null 2>&1; then
  printf '\nClaude Code is not on PATH, so the bridge was not registered. Once it is:\n\n'
  printf '     claude mcp add opencode -s user -- "%s" "%s"\n\n' "${BUN_BIN:-bun}" "$MCP_SRC"
elif [[ -z "$BUN_BIN" ]]; then
  warn "Claude Code bridge not registered: bun is required to run it (see above)."
else
  # Compare the registered path, not merely the name. Re-running this from a moved
  # or re-cloned checkout leaves the old absolute path registered and still
  # answering to `opencode`, so a name-only check reports success while Claude Code
  # points at a file that is no longer there.
  REGISTERED="$(claude mcp get opencode 2>/dev/null | sed -n 's/^ *Args: *//p' | head -1)"
  if [[ "$REGISTERED" == "$MCP_SRC" ]]; then
    say "Claude Code bridge: already registered → $MCP_SRC"
  else
    if [[ -n "$REGISTERED" ]]; then
      say "Claude Code bridge: re-pointing from $REGISTERED"
      run claude mcp remove opencode || true
    fi
    say "Claude Code bridge: registering → $MCP_SRC"
    run claude mcp add opencode -s user -- "$BUN_BIN" "$MCP_SRC"
  fi
  printf 'It runs from this clone, not from %s — so keep %s where it is.\n' "$DEST" "$SRC"
fi
