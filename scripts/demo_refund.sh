#!/usr/bin/env bash
# FP-300 refunds demo: end to end through the API, then check the money.
#
# Needs: a running API (API_URL, default http://localhost:3000) started with
# WEBHOOK_ALLOW_PRIVATE_TARGETS=true, a seeded DB (DATABASE_URL), and
# curl, jq, psql, openssl, node.
#
#   API_URL=http://localhost:3100 DATABASE_URL=postgres://... scripts/demo_refund.sh
set -uo pipefail

API_URL="${API_URL:-http://localhost:3000}"
: "${DATABASE_URL:?set DATABASE_URL to the seeded database}"
RECEIVER_PORT="${RECEIVER_PORT:-4599}"
MERCHANT_NAME="Alpha Retail Co"
OWNER_EMAIL="owner@alpharetail.example"
PASSWORD="FilsPaySeed!2026" # db/seed/generate.ts SEED_USER_PASSWORD (dev only)
CARD='{"pan":"4242424242424242","expiryMonth":12,"expiryYear":2030,"cvv":"123"}'
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

WORK="$(mktemp -d)"
JAR="$WORK/cookies"
HOOKS="$WORK/hooks"
mkdir -p "$HOOKS"
FAILS=0
RECEIVER_PID=""
cleanup() {
  if [ -n "$RECEIVER_PID" ]; then
    kill "$RECEIVER_PID" 2>/dev/null
    wait "$RECEIVER_PID" 2>/dev/null
  fi
  node -e 'require("fs").rmSync(process.argv[1], { recursive: true, force: true })' "$WORK"
}
trap cleanup EXIT

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
step() { printf '\n== %s\n' "$1"; }
bd() { awk -v f="$1" 'BEGIN { s = f < 0 ? "-" : ""; f = f < 0 ? -f : f; printf "%s%d.%03d BD", s, int(f / 1000), f % 1000 }'; }
sql() { psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "$1"; }

# api METHOD PATH [JSON] [IDEMPOTENCY-KEY] -> sets CODE and BODY
api() {
  local args=(-s -o "$WORK/body" -w '%{http_code}' -X "$1" "$API_URL$2" -b "$JAR" -c "$JAR")
  [ -n "${3:-}" ] && args+=(-H 'Content-Type: application/json' --data "$3")
  [ -n "${4:-}" ] && args+=(-H "Idempotency-Key: $4")
  [ -n "${AUTH_KEY:-}" ] && args+=(-H "Authorization: Bearer $AUTH_KEY")
  CODE="$(curl "${args[@]}")"
  BODY="$(cat "$WORK/body")"
}

# A 502 (acquirer unavailable) leaves the key retryable: retry with the SAME
# key, exactly what a client must do. Never a new key for the same intent.
api_retry() {
  local i
  for i in 1 2 3 4 5; do
    api "$@"
    [ "$CODE" != "502" ] && return
  done
}

key() { node -e 'console.log(crypto.randomUUID())'; }

# Authorize with the API key, capture with the owner session.
new_captured_payment() {
  local amount="$1" i id
  for i in 1 2 3 4 5; do
    AUTH_KEY="$API_KEY" api POST /v1/transactions "{\"amountFils\":$amount,\"card\":$CARD,\"reference\":\"demo-refund\"}" "$(key)"
    [ "$CODE" = "201" ] && break
  done
  [ "$CODE" = "201" ] || { echo "authorize failed: $CODE $BODY" >&2; return 1; }
  id="$(jq -r .id <<<"$BODY")"
  api_retry POST "/v1/transactions/$id/capture" '{}' "$(key)"
  [ "$CODE" = "200" ] || { echo "capture failed: $CODE $BODY" >&2; return 1; }
  echo "$id"
}

refund() { # txn amountFils reason -> CODE/BODY
  api_retry POST "/v1/merchants/$MERCHANT_ID/refunds" \
    "{\"transactionId\":\"$1\",\"amountFils\":$2,\"reason\":\"$3\"}" "$(key)"
}

txn_status() { api GET "/v1/transactions/$1"; jq -r '"\(.status)  captured \(.capturedFils)  refunded \(.refundedFils)"' <<<"$BODY"; }

ledger_check() { # txn -> prints and checks the per-account sums for this payment
  local row payable scheme fee debits credits unbalanced
  row="$(sql "SELECT
      COALESCE(SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END) FILTER (WHERE account_id='merchant_payable'),0),
      COALESCE(SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END) FILTER (WHERE account_id='card_scheme_clearing'),0),
      COALESCE(SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END) FILTER (WHERE account_id='platform_fee_revenue'),0),
      COALESCE(SUM(amount_fils) FILTER (WHERE direction='debit'),0),
      COALESCE(SUM(amount_fils) FILTER (WHERE direction='credit'),0),
      (SELECT COUNT(*) FROM (SELECT 1 FROM ledger_entries WHERE transaction_id='$1' GROUP BY entry_group_id
         HAVING SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END) <> 0) g)
    FROM ledger_entries WHERE transaction_id='$1'")"
  IFS='|' read -r payable scheme fee debits credits unbalanced <<<"$row"
  printf '  ledger %s: debits %s = credits %s | merchant_payable %s | scheme %s | fee revenue %s\n' \
    "${1:0:8}" "$debits" "$credits" "$payable" "$scheme" "$fee"
  check "$debits" "$credits" "ledger balanced (debits = credits)"
  check "$unbalanced" "0" "every entry group nets to 0"
  check "$payable" "0" "merchant payable for the payment is exactly 0 fils"
  check "$fee" "0" "the whole fee was reversed (to the fil)"
}

volume_today() { # -> "refundCount refundGrossFils" for today (Asia/Bahrain)
  local today tomorrow
  today="$(TZ=Asia/Bahrain date +%F)"
  tomorrow="$(node -e "const d=new Date('${today}T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);console.log(d.toISOString().slice(0,10))")"
  api GET "/v1/analytics/volumes?from=$today&to=$tomorrow"
  jq -r --arg d "$today" '([.points[] | select(.date == $d)][0] // {refundCount:0, refundGrossFils:0}) | "\(.refundCount) \(.refundGrossFils)"' <<<"$BODY"
}

reporting_catch_up() {
  (cd "$REPO_ROOT" && npx --yes tsx apps/reporting/src/index.ts catch-up >/dev/null 2>&1)
}

echo "FilsPay refunds demo (FP-300) against $API_URL"

# ---------------------------------------------------------------- 1
step "1. Log in as the merchant owner (password + dev OTP)"
MERCHANT_ID="$(sql "SELECT id FROM merchants WHERE display_name = '$MERCHANT_NAME'")"
[ -n "$MERCHANT_ID" ] || { echo "seeded merchant '$MERCHANT_NAME' not found; run npm run seed"; exit 1; }
# Refunds start off for every merchant (migration 0052: NULL = off).
# A finance admin turns them on from the ops console (audited).
MERCHANT_JAR="$JAR"; JAR="$WORK/admin-cookies"
api POST /v1/admin/auth/login '{"email":"finance@filspay.test","password":"FilsPayAdminSeed!2026"}'
ADMIN_OTP="$(jq -r '.devOtpCode // empty' <<<"$BODY")"
api POST /v1/admin/auth/otp/verify "{\"code\":\"$ADMIN_OTP\"}"
api PUT "/v1/admin/merchants/$MERCHANT_ID/refunds-enabled" '{"enabled":true}'
check "$CODE" "200" "finance admin turned refunds on for $MERCHANT_NAME (audited)"
JAR="$MERCHANT_JAR"
api POST /v1/auth/login "{\"merchantId\":\"$MERCHANT_ID\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$PASSWORD\"}"
OTP="$(jq -r '.devOtpCode // empty' <<<"$BODY")"
api POST /v1/auth/otp/verify "{\"code\":\"$OTP\"}"
check "$CODE" "200" "owner $OWNER_EMAIL logged in ($MERCHANT_NAME)"
api POST "/v1/merchants/$MERCHANT_ID/api-keys" '{"label":"refund demo"}'
API_KEY="$(jq -r .rawKey <<<"$BODY")"
check "$CODE" "201" "owner issued an API key (to authorize card payments)"

# Webhook receiver: stores each raw body and its signature header, untouched.
node -e '
  const http = require("http"), fs = require("fs");
  let n = 0;
  http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      n += 1;
      fs.writeFileSync(`${process.argv[1]}/${n}.body`, Buffer.concat(chunks));
      fs.writeFileSync(`${process.argv[1]}/${n}.sig`, String(req.headers["webhook-signature"] || ""));
      res.end("ok");
    });
  }).listen(Number(process.argv[2]), "127.0.0.1");
' "$HOOKS" "$RECEIVER_PORT" &
RECEIVER_PID=$!
HOOK_URL="http://127.0.0.1:$RECEIVER_PORT/hook"
# Disable endpoints a previous demo run left at the same URL (old secrets).
api GET "/v1/merchants/$MERCHANT_ID/webhook-endpoints"
for old in $(jq -r --arg u "$HOOK_URL" '.[] | select(.url == $u and .status == "active") | .id' <<<"$BODY"); do
  api PATCH "/v1/merchants/$MERCHANT_ID/webhook-endpoints/$old" '{"status":"disabled"}'
done
api POST "/v1/merchants/$MERCHANT_ID/webhook-endpoints" "{\"url\":\"$HOOK_URL\"}"
WEBHOOK_SECRET="$(jq -r '.secret // empty' <<<"$BODY")"
check "$CODE" "201" "shop registered a webhook endpoint (local receiver :$RECEIVER_PORT)"

reporting_catch_up
read -r REPORT_COUNT_BEFORE REPORT_FILS_BEFORE <<<"$(volume_today)"

# ---------------------------------------------------------------- 2
step "2. Create and capture a payment of $(bd 10000)"
TXN1="$(new_captured_payment 10000)" || exit 1
echo "  txn $TXN1: $(txn_status "$TXN1")"

# ---------------------------------------------------------------- 3
step "3. Refund part, then the rest"
refund "$TXN1" 4000 "customer returned 2 items"
check "$CODE" "200" "refund $(bd 4000): $(jq -r '"status \(.transactionStatus), fee reversed \(.feeReversedFils) fils"' <<<"$BODY")"
check "$(jq -r .transactionStatus <<<"$BODY")" "partially_refunded" "status after partial refund"
refund "$TXN1" 6000 "customer returned the rest"
check "$CODE" "200" "refund $(bd 6000): $(jq -r '"status \(.transactionStatus), fee reversed \(.feeReversedFils) fils"' <<<"$BODY")"
check "$(jq -r .transactionStatus <<<"$BODY")" "refunded" "status after final refund"
echo "  txn $TXN1: $(txn_status "$TXN1")"

# ---------------------------------------------------------------- 4
step "4. Try to refund 1 fil more"
refund "$TXN1" 1 "one fil too many"
if [ "$CODE" = "409" ] || [ "$CODE" = "422" ]; then
  pass "rejected with $CODE: $(jq -c . <<<"$BODY")"
else
  fail "1 fil over-refund was not rejected ($CODE $BODY)"
fi

# ---------------------------------------------------------------- 5
step "5. Two full refunds at the same time on a fresh $(bd 5000) payment"
TXN2="$(new_captured_payment 5000)" || exit 1
RACE_PIDS=()
for i in 1 2; do
  curl -s -o "$WORK/race$i" -w '%{http_code}' -X POST "$API_URL/v1/merchants/$MERCHANT_ID/refunds" -b "$JAR" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
    --data "{\"transactionId\":\"$TXN2\",\"amountFils\":5000,\"reason\":\"race $i\"}" >"$WORK/race$i.code" &
  RACE_PIDS+=($!)
done
wait "${RACE_PIDS[@]}"
OKS=0
for i in 1 2; do
  c="$(cat "$WORK/race$i.code")"
  echo "  request $i -> $c $(jq -c '{transactionStatus, code, error} | with_entries(select(.value != null))' "$WORK/race$i" 2>/dev/null)"
  [ "$c" = "200" ] && OKS=$((OKS + 1))
done
check "$OKS" "1" "exactly one concurrent refund succeeded"
check "$(sql "SELECT refunded_fils FROM transactions WHERE id = '$TXN2'")" "5000" "refunded_fils = captured, never more"

# ---------------------------------------------------------------- 6
step "6. Ledger sum check (every fil) and timeline"
ledger_check "$TXN1"
ledger_check "$TXN2"
api GET "/v1/transactions/$TXN1/events"
echo "  timeline $TXN1:"
jq -r '.[] | "    \(.occurredAt[11:19])  \(.eventType | .+ (" " * (16 - length)))  \(.amountFils // "-")"' <<<"$BODY"
check "$(jq -r '[.[].eventType] | join(",")' <<<"$BODY")" "authorized,captured,refund_partial,refunded" "timeline order"
check "$(jq -r '[.[] | select(.eventType | startswith("refund")) | .amountFils] | join(",")' <<<"$BODY")" "-4000,-6000" "timeline refund amounts"

# ---------------------------------------------------------------- 7
step "7. The shop got signed refund.succeeded webhooks"
for _ in $(seq 1 30); do
  n="$(grep -l '"refund.succeeded"' "$HOOKS"/*.body 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" -ge 3 ] && break
  sleep 1
done
GOOD=0
for f in $(grep -l '"refund.succeeded"' "$HOOKS"/*.body 2>/dev/null); do
  sig="$(cat "${f%.body}.sig")"; t="${sig#t=}"; t="${t%%,*}"; v1="${sig##*v1=}"
  mine="$( { printf '%s.' "$t"; cat "$f"; } | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1)"
  if [ "$mine" = "$v1" ]; then GOOD=$((GOOD + 1)); fi
  jq -r '"    \(.type)  txn \(.data.transactionId[0:8])  amount \(.data.amountFils)  fee reversed \(.data.feeReversedFils)  status \(.data.status)"' "$f"
done
check "$GOOD" "3" "3 refund.succeeded webhooks, each HMAC-SHA256 verified over the raw body"

# ---------------------------------------------------------------- 8
step "8. Reporting: today's row shows the refunds"
reporting_catch_up
read -r REPORT_COUNT_AFTER REPORT_FILS_AFTER <<<"$(volume_today)"
echo "  today: refunds $REPORT_COUNT_AFTER, refunded $(bd "$REPORT_FILS_AFTER") (before this run: $REPORT_COUNT_BEFORE, $(bd "$REPORT_FILS_BEFORE"))"
check "$((REPORT_COUNT_AFTER - REPORT_COUNT_BEFORE))" "3" "report counts the 3 refunds"
check "$((REPORT_FILS_AFTER - REPORT_FILS_BEFORE))" "15000" "report adds $(bd 15000) refunded"

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL PASS"; else echo "RESULT: $FAILS FAIL"; fi
exit "$FAILS"
