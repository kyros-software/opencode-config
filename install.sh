#!/usr/bin/env bash
# Installs this OpenCode configuration into the current machine.
# Idempotent: re-running it refreshes the config and re-backs-up whatever was there.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

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

# ---------------------------------------------------------------- backup
# Note: the preflight above runs `opencode --version`, which creates an empty
# $DEST as a side effect. So test for actual content, not mere existence —
# otherwise every fresh machine accumulates empty backup dirs.
if [[ -d "$DEST" ]] && [[ -n "$(ls -A "$DEST" 2>/dev/null)" ]]; then
  BACKUP="$DEST.backup-$STAMP"
  say "Backing up existing config → $BACKUP"
  run cp -a "$DEST" "$BACKUP"
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
  node -e "JSON.parse(require('fs').readFileSync('$DEST/opencode.json','utf8'))" \
    && echo "  opencode.json parses"
  echo "  agents: $(find "$DEST/agents" -name '*.md' 2>/dev/null | wc -l)"
  echo "  skills: $(find "$DEST/skills" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)"
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
