#!/usr/bin/env bash
# End-to-end setup for your own Muse <-> Grok Bot relay.
# Non-interactive except for browser sign-ins (Neon, Vercel). Re-runnable.
#
# Optional env overrides:
#   PROJECT_NAME   Vercel + Neon project name      (default: muse-relay)
#   NEON_REGION    Neon region                     (default: aws-us-east-2)
#   VERCEL_SCOPE   Vercel team/user slug           (default: your personal scope)
#   DATABASE_URL   Use an existing Postgres URL and skip Neon entirely
#   MUSE_RELAY_ENV_FILE  where to write secrets   (default: ~/secrets/muse-relay.env)
. "$(dirname "$0")/scripts/lib.sh"
PROJECT_NAME="${PROJECT_NAME:-muse-relay}"
NEON_REGION="${NEON_REGION:-aws-us-east-2}"
cd "$REPO_DIR"
load_env   # reuse values from a previous run

# --- (a) CLIs ------------------------------------------------------------
command -v node >/dev/null || die "Node.js 20+ is required (https://nodejs.org)"
NPM_PREFIX="${NPM_PREFIX:-$HOME/.local}"; export PATH="$NPM_PREFIX/bin:$PATH"
need() { command -v "$1" >/dev/null || { log "installing $2..."; npm i -g --prefix "$NPM_PREFIX" "$2" >/dev/null 2>&1 || die "could not install $2"; }; }
need vercel vercel
[ -z "${DATABASE_URL:-}${MUSE_RELAY_DATABASE_URL:-}" ] && need neonctl neonctl
[ -d node_modules ] || npm install --silent >/dev/null 2>&1

# --- (b) sign-ins ---------------------------------------------------------
if ! vercel whoami >/dev/null 2>&1; then
  log "Vercel sign-in needed. A URL will be printed below: OPEN IT IN A BROWSER and approve (free Hobby account; GitHub/Google/email all work)."
  vercel login || die "vercel login failed"
fi
log "Vercel user: $(vercel whoami 2>/dev/null | tail -1)"

# --- (c) Neon database ----------------------------------------------------
DB_URL="${DATABASE_URL:-${MUSE_RELAY_DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  if ! neonctl me >/dev/null 2>&1; then
    log "Neon sign-in needed. A URL will be printed below: OPEN IT IN A BROWSER. No account? Sign up free at https://neon.tech (GitHub/Google work)."
    neonctl auth || die "neonctl auth failed"
  fi
  PID="$(neonctl projects list --output json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=(j.projects||j);const p=a.find(p=>p.name===process.argv[1]);process.stdout.write(p?p.id:"")})' "$PROJECT_NAME")"
  if [ -z "$PID" ]; then
    log "creating Neon project $PROJECT_NAME in $NEON_REGION (free tier)..."
    PID="$(neonctl projects create --name "$PROJECT_NAME" --region-id "$NEON_REGION" --output json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).project.id))')" || die "Neon project create failed"
  else log "Neon project $PROJECT_NAME already exists ($PID), reusing"; fi
  DB_URL="$(neonctl connection-string --project-id "$PID" --pooled 2>/dev/null)" || die "could not get Neon connection string"
fi
[[ "$DB_URL" == postgres* ]] || die "database URL looks wrong"
write_env MUSE_RELAY_DATABASE_URL "$DB_URL"

# --- (d) keys -------------------------------------------------------------
gen() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'; }
MUSE_KEY="${MUSE_RELAY_MUSE_KEY:-$(gen)}"; GROK_KEY="${MUSE_RELAY_GROK_KEY:-$(gen)}"; WSEC="${MUSE_RELAY_WEBHOOK_SECRET:-$(gen)}"
write_env MUSE_RELAY_MUSE_KEY "$MUSE_KEY"; write_env MUSE_RELAY_GROK_KEY "$GROK_KEY"; write_env MUSE_RELAY_WEBHOOK_SECRET "$WSEC"
log "keys ready in $ENV_FILE (chmod 600)"

# --- (e) Vercel project, env, deploy -----------------------------------------
if [ ! -f .vercel/project.json ] || ! grep -q "\"projectName\":\"$PROJECT_NAME\"" .vercel/project.json 2>/dev/null; then
  vercel project add "$PROJECT_NAME" "${VSCOPE[@]}" >/dev/null 2>&1 || true   # no-op if it exists
  vercel link --yes --project "$PROJECT_NAME" "${VSCOPE[@]}" >/dev/null 2>&1 || die "vercel link failed"
fi
log "linked Vercel project $PROJECT_NAME"
vset DATABASE_URL "$DB_URL"; vset MUSE_KEY "$MUSE_KEY"; vset GROK_KEY "$GROK_KEY"; vset WEBHOOK_SECRET "$WSEC"
vdeploy >/dev/null
URL="https://$PROJECT_NAME.vercel.app"
# Prefer the stable production alias Vercel actually assigned.
ALIAS="$(vercel project inspect "$PROJECT_NAME" "${VSCOPE[@]}" 2>&1 | grep -Eo '[a-z0-9.-]+\.vercel\.app' | head -1 || true)"
code() { curl -s -o /dev/null -w '%{http_code}' -m 20 "$1/health"; }
if [ "$(code "$URL")" != 200 ] && [ -n "$ALIAS" ]; then URL="https://$ALIAS"; fi

# Deployment Protection (Vercel Authentication) blocks public API calls with 401/302.
c="$(code "$URL")"
if [ "$c" != 200 ]; then
  log "/health returned $c - turning off Vercel Deployment Protection (Vercel Authentication)..."
  vercel project protection disable "$PROJECT_NAME" --sso "${VSCOPE[@]}" >/dev/null 2>&1 || warn "CLI could not disable protection. Do it by hand: Vercel dashboard > $PROJECT_NAME > Settings > Deployment Protection > Vercel Authentication: Disabled"
  for i in 1 2 3 4 5 6; do sleep 5; c="$(code "$URL")"; [ "$c" = 200 ] && break; done
fi
[ "$c" = 200 ] || die "$URL/health still returns $c. Check Deployment Protection in the Vercel dashboard, then re-run."
vset PUBLIC_BASE_URL "$URL"; vdeploy >/dev/null
write_env MUSE_RELAY_URL "$URL"
log "relay live at $URL (health OK)"

# --- done ----------------------------------------------------------------
cat >&2 <<MSG

Done. Secrets are in $ENV_FILE (never paste them in chat).
Next:
  1. Grok Bot: add the MCP connector (see README "Grok side").
  2. Grok Bot: create a webhook routine, then run:
       GROK_WEBHOOK_URL=... GROK_WEBHOOK_AUTH=... ./set-webhook.sh
  3. Give Muse the instruction block from the README plus its key
     (MUSE_RELAY_MUSE_KEY in $ENV_FILE) and the URL $URL
  4. ./smoke-test.sh
MSG
