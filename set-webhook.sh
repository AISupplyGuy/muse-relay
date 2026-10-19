#!/usr/bin/env bash
# Point the relay at your Grok Bot webhook routine. Reads GROK_WEBHOOK_URL and
# GROK_WEBHOOK_AUTH (the full Authorization header value) from the environment.
. "$(dirname "$0")/scripts/lib.sh"
[ -n "${GROK_WEBHOOK_URL:-}" ] || die "export GROK_WEBHOOK_URL first"
[[ "$GROK_WEBHOOK_URL" == https://* ]] || die "GROK_WEBHOOK_URL must start with https://"
[ -f "$REPO_DIR/.vercel/project.json" ] || die "run ./setup.sh first (project not linked)"
vset GROK_WEBHOOK_URL "$GROK_WEBHOOK_URL"
if [ -n "${GROK_WEBHOOK_AUTH:-}" ]; then vset GROK_WEBHOOK_AUTH "$GROK_WEBHOOK_AUTH"; else warn "GROK_WEBHOOK_AUTH not set; webhook will carry only X-Relay-* headers"; fi
vdeploy >/dev/null
log "webhook configured and redeployed. Run ./smoke-test.sh; its Muse message should wake your routine."
