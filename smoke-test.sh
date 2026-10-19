#!/usr/bin/env bash
# Checks /health, MCP auth + tools/list, a Muse-key POST, a Grok reply via MCP,
# then deletes its test thread. Never prints secrets.
. "$(dirname "$0")/scripts/lib.sh"
load_env
: "${MUSE_RELAY_URL:?missing; run setup.sh}" "${MUSE_RELAY_MUSE_KEY:?}" "${MUSE_RELAY_GROK_KEY:?}"
U="$MUSE_RELAY_URL"; pass=0; fail=0
ok()  { log "PASS $*"; pass=$((pass+1)); }
bad() { warn "FAIL $*"; fail=$((fail+1)); }
mcp() { curl -s -m 30 "$U/mcp" -H "Authorization: Bearer $MUSE_RELAY_GROK_KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1"; }
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(String(eval(process.argv[1])??""))}catch{}})' "$1"; }

[ "$(curl -s -m 20 "$U/health" | j o.status)" = ok ] && ok "/health" || bad "/health"
c="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "$U/mcp" -d '{}')"; [ "$c" = 401 ] && ok "MCP rejects missing key" || bad "MCP auth ($c)"
n="$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | j 'o.result.tools.map(t=>t.name).join(",")')"
[[ "$n" == *send_to_muse*check_muse_messages* ]] && ok "MCP tools/list: $n" || bad "MCP tools/list"
r="$(curl -s -m 30 -X POST "$U/api/v1/messages" -H "Authorization: Bearer $MUSE_RELAY_MUSE_KEY" -H 'content-type: application/json' \
  -d '{"subject":"smoke-test","text":"smoke test, ignore","attachments":[{"filename":"lol.txt","content_type":"text/plain","content_base64":"TE9M"}]}')"
TID="$(echo "$r" | j o.message.thread_id)"; AID="$(echo "$r" | j o.message.attachments[0].id)"
[ -n "$TID" ] && ok "Muse POST /api/v1/messages (webhook notified: $(echo "$r" | j o.notified))" || bad "Muse POST: $(echo "$r" | j o.error)"
if [ -n "$TID" ]; then
  [ "$(curl -s -m 20 "$U/api/v1/files/$AID" -H "Authorization: Bearer $MUSE_RELAY_MUSE_KEY")" = LOL ] && ok "file download" || bad "file download"
  s="$(mcp "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"send_to_muse\",\"arguments\":{\"thread_id\":\"$TID\",\"text\":\"smoke reply\"}}}" | j 'o.result&&!o.result.isError')"
  [ "$s" = true ] && ok "MCP send_to_muse" || bad "MCP send_to_muse"
  g="$(curl -s -m 30 "$U/api/v1/messages?thread_id=$TID&wait=5" -H "Authorization: Bearer $MUSE_RELAY_MUSE_KEY" | j 'o.messages.length')"
  [ "${g:-0}" -ge 1 ] && ok "Muse sees Grok reply" || bad "Muse sees Grok reply"
  # cleanup: delete the test thread (cascades to messages + attachments)
  if [ -n "${MUSE_RELAY_DATABASE_URL:-}" ]; then
    ( cd "$REPO_DIR" && TID="$TID" DATABASE_URL="$MUSE_RELAY_DATABASE_URL" node -e '
      import("@neondatabase/serverless").then(async({neon})=>{const sql=neon(process.env.DATABASE_URL);await sql`DELETE FROM threads WHERE id=${process.env.TID}`})' ) \
      && ok "cleaned up test thread" || bad "cleanup"
  fi
fi
log "$pass passed, $fail failed"; [ "$fail" = 0 ]
