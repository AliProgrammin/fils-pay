#!/usr/bin/env bash
# FP-300 refunds demo: end to end through the API, then check the money.
# Section 9 closes and pays a past day with the Go settlement CLI and checks
# the payout and the reconciliation endpoint for that day.
#
# Needs: a running API (API_URL, default http://localhost:3000) started with
# WEBHOOK_ALLOW_PRIVATE_TARGETS=true, a seeded DB (DATABASE_URL), and
# curl, jq, psql, openssl, node, go.
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
  check "$fee" "0" "the whole fee was reversed (to the last fils)"
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
# Refunds work unless support puts a merchant on hold (migration 0052:
# NULL = no hold, false = on hold). A finance admin releases any hold from
# the ops console (audited), so the demo starts from a known state.
MERCHANT_JAR="$JAR"; JAR="$WORK/admin-cookies"
api POST /v1/admin/auth/login '{"email":"finance@filspay.test","password":"FilsPayAdminSeed!2026"}'
ADMIN_OTP="$(jq -r '.devOtpCode // empty' <<<"$BODY")"
api POST /v1/admin/auth/otp/verify "{\"code\":\"$ADMIN_OTP\"}"
api PUT "/v1/admin/merchants/$MERCHANT_ID/refunds-enabled" '{"enabled":true}'
check "$CODE" "200" "finance admin released any refunds hold on $MERCHANT_NAME (audited)"
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
step "4. Try to refund 1 fils more"
refund "$TXN1" 1 "one fils too many"
if [ "$CODE" = "409" ] || [ "$CODE" = "422" ]; then
  pass "rejected with $CODE: $(jq -c . <<<"$BODY")"
else
  fail "1 fils over-refund was not rejected ($CODE $BODY)"
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
step "6. Ledger sum check (every fils) and timeline"
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

# ---------------------------------------------------------------- 9
step "9. Settlement: close and pay a past day with the Go CLI, then reconcile"
TODAY="$(TZ=Asia/Bahrain date +%F)"
settle() { (cd "$REPO_ROOT/apps/settlement" && DATABASE_URL="$DATABASE_URL" go run ./cmd/settlement run-batch "$@" 2>&1); }
if settle --date="$TODAY" --merchant="$MERCHANT_ID" >/dev/null; then
  fail "run-batch closed today ($TODAY), which has not ended in Bahrain"
else
  pass "run-batch refuses today ($TODAY): the payments above cannot be paid out until tomorrow"
fi

# SETUP (SQL, not the API). The API stamps every capture, refund and ledger
# leg with now(), and ledger_entries is append-only, so a payment made above
# cannot be moved to a closed day. Instead this writes, for a past day, the
# same rows capture.ts and processRefund.ts write (the Go and TS settlement
# tests use the same SQL): one capture of 8.000 BD and a 4.000 BD refund.
# The day is the latest past Bahrain day with no batch for this merchant yet,
# so the demo can run again on the same DB.
DAY="$(sql "SELECT d::date FROM generate_series('$TODAY'::date - 60, '$TODAY'::date - 1, interval '1 day') d
             WHERE NOT EXISTS (SELECT 1 FROM settlement_batches WHERE merchant_id = '$MERCHANT_ID' AND batch_date = d::date)
             ORDER BY d DESC LIMIT 1")"
DAY_BEFORE="$(node -e "const d=new Date('${DAY}T00:00:00Z');d.setUTCDate(d.getUTCDate()-1);console.log(d.toISOString().slice(0,10))")"
# Close the day before first: it claims any older unbatched activity (the
# seed leaves some), so the batch checked below holds only $DAY's activity.
FLUSH="$(settle --date="$DAY_BEFORE" --merchant="$MERCHANT_ID" | grep "merchant=$MERCHANT_ID")"
echo "  closed $DAY_BEFORE first (older activity): ${FLUSH#  }"
DAY_AFTER="$(node -e "const d=new Date('${DAY}T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);console.log(d.toISOString().slice(0,10))")"
CAP_AT="$DAY 11:00:00+03"; REF_AT="$DAY 15:00:00+03"
# Rate: the fee_schedules row in effect at the capture, else mdr_bps (capture.ts's rule).
read -r RATE DISCOUNT <<<"$(sql "SELECT COALESCE((SELECT mdr_bps FROM fee_schedules WHERE merchant_id = m.id AND effective_from <= '$CAP_AT'
                                      ORDER BY effective_from DESC, created_at DESC LIMIT 1), m.mdr_bps), m.negotiated_discount_bps
                                  FROM merchants m WHERE m.id = '$MERCHANT_ID'" | tr '|' ' ')"
SET_CAP=8000; SET_REF=4000
SET_FEE=$((SET_CAP * RATE / 10000)); SET_REV=$((SET_FEE * SET_REF / SET_CAP))
if [ "$DISCOUNT" != "0" ] || [ $((SET_CAP * RATE % 10000)) != 0 ] || [ $((SET_FEE * SET_REF % SET_CAP)) != 0 ]; then
  echo "  setup: rate $RATE bps / discount $DISCOUNT bps gives a rounded fee; pick other amounts" >&2; exit 1
fi
SET_TXN="$(sql "
  WITH t AS (
    INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference, reference, occurred_at)
    VALUES ('$MERCHANT_ID', 'partially_refunded', $SET_CAP, $SET_CAP, $SET_REF, 'demo-acq-' || gen_random_uuid(), 'demo-refund-settle', '$CAP_AT')
    RETURNING id),
  ev AS (
    INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
    SELECT id, 'captured', $SET_CAP, 'system', '$CAP_AT'::timestamptz FROM t
    UNION ALL SELECT id, 'refund_partial', -$SET_REF, 'system', '$REF_AT'::timestamptz FROM t),
  r AS (
    INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
    SELECT id, '$MERCHANT_ID'::uuid, $SET_REF, $SET_REV, 'succeeded', 'demo-acq-r-' || gen_random_uuid(), 'demo setup', 'merchant_api_key', gen_random_uuid(), '$REF_AT' FROM t),
  cap AS (SELECT gen_random_uuid() AS g), ref AS (SELECT gen_random_uuid() AS g),
  le AS (
    INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
    SELECT cap.g, '$MERCHANT_ID'::uuid, t.id, x.acct, x.dir, x.amt, x.at::timestamptz, x.descr FROM t, cap, (VALUES
      ('card_scheme_clearing', 'debit',  $SET_CAP, '$CAP_AT', 'capture: gross'),
      ('merchant_payable',     'credit', $SET_CAP, '$CAP_AT', 'capture: gross'),
      ('merchant_payable',     'debit',  $SET_FEE, '$CAP_AT', 'capture: MDR fee'),
      ('platform_fee_revenue', 'credit', $SET_FEE, '$CAP_AT', 'capture: MDR fee')) x(acct, dir, amt, at, descr)
    UNION ALL
    SELECT ref.g, '$MERCHANT_ID'::uuid, t.id, x.acct, x.dir, x.amt, x.at::timestamptz, x.descr FROM t, ref, (VALUES
      ('merchant_payable',     'debit',  $SET_REF, '$REF_AT', 'refund: gross'),
      ('card_scheme_clearing', 'credit', $SET_REF, '$REF_AT', 'refund: gross'),
      ('platform_fee_revenue', 'debit',  $SET_REV, '$REF_AT', 'refund: MDR fee reversal'),
      ('merchant_payable',     'credit', $SET_REV, '$REF_AT', 'refund: MDR fee reversal')) x(acct, dir, amt, at, descr))
  SELECT id FROM t")"
echo "  setup (SQL): txn ${SET_TXN:0:8} on $DAY: capture $(bd $SET_CAP) (fee $SET_FEE at $RATE bps), refund $(bd $SET_REF) (fee reversed $SET_REV)"

OUT="$(settle --date="$DAY" --merchant="$MERCHANT_ID")"
LINE="$(grep "merchant=$MERCHANT_ID" <<<"$OUT")"
echo "  go run ./cmd/settlement run-batch --date=$DAY --merchant=${MERCHANT_ID:0:8}..."
echo "    ${LINE#  }"
BATCH="$(sed -n 's/.*batch=\([0-9a-f-]*\).*/\1/p' <<<"$LINE")"
CLI_NET="$(sed -n 's/.*netPayout=\([0-9-]*\).*/\1/p' <<<"$LINE")"
IFS='|' read -r B_STATUS B_GROSS B_FEE B_REF B_REV B_NET <<<"$(sql "SELECT status, gross_fils, fee_fils, refund_fils, refund_fee_reversed_fils, net_payout_fils
                                                                     FROM settlement_batches WHERE id = '$BATCH'")"
check "$B_STATUS" "paid" "batch ${BATCH:0:8} for $DAY is closed and paid"
check "$(sql "SELECT count(*) FROM transaction_events WHERE transaction_id = '$SET_TXN' AND event_type = 'captured' AND settlement_batch_id = '$BATCH'")|$(sql "SELECT count(*) FROM refunds WHERE transaction_id = '$SET_TXN' AND settlement_batch_id = '$BATCH'")" "1|1" "the setup capture and its refund are both in this batch"
# Each term is read from the source rows, not from the batch:
#   captures     = capture events this batch claimed
#   fees         = the net MDR fee the ledger charged those payments at capture
#   refunds, fee reversals = refund rows this batch claimed
IFS='|' read -r X_CAP X_FEE X_REF X_REV <<<"$(sql "
  SELECT (SELECT COALESCE(SUM(amount_fils), 0) FROM transaction_events
           WHERE settlement_batch_id = '$BATCH' AND event_type IN ('captured', 'partially_captured')),
         (SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0) FROM ledger_entries
           WHERE account_id = 'platform_fee_revenue' AND description NOT LIKE 'refund:%'
             AND transaction_id IN (SELECT transaction_id FROM transaction_events WHERE settlement_batch_id = '$BATCH')),
         (SELECT COALESCE(SUM(amount_fils), 0) FROM refunds WHERE settlement_batch_id = '$BATCH'),
         (SELECT COALESCE(SUM(fee_reversed_fils), 0) FROM refunds WHERE settlement_batch_id = '$BATCH')")"
X_NET=$((X_CAP - X_FEE - X_REF + X_REV))
PAID="$(sql "SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries WHERE settlement_batch_id = '$BATCH' AND account_id = 'platform_cash' AND direction = 'credit'")"
echo "  captures $X_CAP - fees $X_FEE - refunds $X_REF + fee reversals $X_REV = $X_NET fils ($(bd $X_NET))"
echo "  batch: gross $B_GROSS fee $B_FEE refunds $B_REF fee reversed $B_REV net $B_NET | CLI netPayout $CLI_NET | payout ledger leg $PAID"
check "$B_NET|$CLI_NET|$PAID" "$X_NET|$X_NET|$X_NET" "net payout = captures - fees - refunds + fee reversals, to the last fils (batch, CLI and payout leg)"

api GET "/v1/settlement/reconciliation?from=$DAY&to=$DAY_AFTER"
echo "  reconciliation $DAY: $(jq -c 'del(.periodFrom, .periodTo)' <<<"$BODY")"
check "$CODE|$(jq -r '"\(.gapFils)|\(.explained)"' <<<"$BODY")" "200|0|true" "reconciliation gap = 0 for $DAY (explained)"

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL PASS"; else echo "RESULT: $FAILS FAIL"; fi
exit "$FAILS"
