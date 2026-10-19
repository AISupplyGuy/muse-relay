# Shared helpers. Sourced by the other scripts. Never prints secret values.
set -euo pipefail
ENV_FILE="${MUSE_RELAY_ENV_FILE:-$HOME/secrets/muse-relay.env}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log()  { printf '\033[1;36m[muse-relay]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[muse-relay] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[muse-relay] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
VSCOPE=()
[ -n "${VERCEL_SCOPE:-}" ] && VSCOPE=(--scope "$VERCEL_SCOPE")
load_env() { if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi; }
# write_env KEY VALUE  (upsert into $ENV_FILE, chmod 600)
write_env() {
  mkdir -p "$(dirname "$ENV_FILE")"; chmod 700 "$(dirname "$ENV_FILE")" 2>/dev/null || true
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  local tmp; tmp="$(mktemp)"; grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$tmp"; cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
# vset NAME VALUE : set a production env var on Vercel via stdin (value never echoed)
vset() {
  ( cd "$REPO_DIR" && vercel env rm "$1" production --yes "${VSCOPE[@]}" >/dev/null 2>&1 || true
    printf '%s' "$2" | vercel env add "$1" production "${VSCOPE[@]}" >/dev/null 2>&1 ) \
    || die "could not set $1 on Vercel"
  log "set Vercel env $1 (value hidden)"
}
vdeploy() {
  log "deploying to Vercel production..."
  local out; out="$(cd "$REPO_DIR" && vercel deploy --prod --yes "${VSCOPE[@]}" 2>&1)" || { echo "$out" | tail -20 >&2; die "deploy failed"; }
  echo "$out" | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | tail -1
}
