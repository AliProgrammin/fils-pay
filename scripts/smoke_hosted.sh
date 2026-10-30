#!/usr/bin/env bash
# Smoke test for a hosted FilsPay (ops/docker-compose.prod.yml), through the
# public URL only: no database access needed.
#
#   BASE_URL=https://filspay.example.com scripts/smoke_hosted.sh
#   BASE_URL=http://localhost:8088 scripts/smoke_hosted.sh
#
# Needs curl and jq. Logins use the seeded demo users and read the OTP from
# `devOtpCode`, so the server must run with OTP_DEV_EXPOSE=true (demo only).
# Over plain http the server must also run with COOKIE_SECURE=false, or the
# session cookies are dropped.
#
# Side effects (on the demo data): releases any refunds hold on Alpha Retail Co,
# creates an API key, one 10.000 BD payment and one 4.000 BD refund.
set -uo pipefail

BASE_URL="${BASE_URL:?set BASE_URL, e.g. http://localhost:8088}"
BASE_URL="${BASE_URL%/}"
MERCHANT_NAME="Alpha Retail Co"
OWNER_EMAIL="owner@alpharetail.example"
OWNER_PASSWORD="FilsPaySeed!2026"         # db/seed/generate.ts SEED_USER_PASSWORD
ADMIN_EMAIL="finance@filspay.test"
ADMIN_PASSWORD="FilsPayAdminSeed!2026"    # db/seed/generate.ts SEED_ADMIN_PASSWORD
CARD='{"pan":"4242424242424242","expiryMonth":12,"expiryYear":2030,"cvv":"123"}'

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
FAILS=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', want '$2': $(head -c 300 "$WORK/body"))"; fi; }
finish() {
  echo
  if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL PASS"; else echo "RESULT: $FAILS FAIL"; fi
  exit "$FAILS"
}
key() { printf 'smoke-%s-%s' "$(date +%s)" "$RANDOM$RANDOM"; }

# api JAR METHOD PATH [JSON] [IDEMPOTENCY-KEY] -> sets CODE and BODY
api() {
  local args=(-s -o "$WORK/body" -w '%{http_code}' -X "$2" "$BASE_URL$3" -b "$1" -c "$1")
  [ -n "${4:-}" ] && args+=(-H 'Content-Type: application/json' --data "$4")
  [ -n "${5:-}" ] && args+=(-H "Idempotency-Key: $5")
  [ -n "${AUTH_KEY:-}" ] && args+=(-H "Authorization: Bearer $AUTH_KEY")
  CODE="$(curl "${args[@]}")"
  BODY="$(cat "$WORK/body")"
}

# The simulated acquirer fails ~2% of calls with 502. Retry with the SAME
# idempotency key, as a real client must.
api_retry() {
  local i
  for i in 1 2 3 4 5; do
    api "$@"
    [ "$CODE" != "502" ] && return
  done
}

# login JAR LOGIN_PATH VERIFY_PATH JSON LABEL -> 0 on success
login() {
  local otp
  api "$1" POST "$2" "$4"
  if [ "$CODE" != "200" ]; then fail "$5 password step ($CODE $BODY)"; return 1; fi
  otp="$(jq -r '.devOtpCode // empty' <<<"$BODY")"
  if [ -z "$otp" ]; then
    fail "$5: no devOtpCode in the login response (server needs OTP_DEV_EXPOSE=true for this test)"
    return 1
  fi
  api "$1" POST "$3" "{\"code\":\"$otp\"}"
  check "$CODE" "200" "$5 logged in (password + OTP)"
  [ "$CODE" = "200" ]
}

echo "FilsPay hosted smoke test against $BASE_URL"
echo

# 1. Health and the two front ends ------------------------------------------
api "$WORK/none" GET /healthz
check "$CODE" "200" "GET /healthz"
api "$WORK/none" GET /readyz
check "$(jq -r .status <<<"$BODY" 2>/dev/null)" "ready" "GET /readyz reports ready"
api "$WORK/none" GET /
if [ "$CODE" = "200" ] && grep -q 'id="root"' "$WORK/body"; then pass "merchant web app HTML at /"; else fail "merchant web app at / ($CODE)"; fi
api "$WORK/none" GET /dashboard/transactions
if [ "$CODE" = "200" ] && grep -q 'id="root"' "$WORK/body"; then pass "SPA fallback for /dashboard/transactions"; else fail "SPA fallback ($CODE)"; fi
api "$WORK/none" GET /admin/
if [ "$CODE" = "200" ] && grep -q 'FilsPay Operations' "$WORK/body"; then pass "admin console HTML at /admin/"; else fail "admin console at /admin/ ($CODE)"; fi

# 2. Admin: find the merchant, release any refunds hold ------------------------
ADMIN_JAR="$WORK/admin"
login "$ADMIN_JAR" /v1/admin/auth/login /v1/admin/auth/otp/verify \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "admin $ADMIN_EMAIL" || finish
api "$ADMIN_JAR" GET "/v1/admin/merchants?q=Alpha%20Retail"
MERCHANT_ID="$(jq -r --arg n "$MERCHANT_NAME" '.merchants[] | select(.displayName == $n) | .id' <<<"$BODY" 2>/dev/null | head -1)"
if [ -n "$MERCHANT_ID" ]; then pass "admin found $MERCHANT_NAME ($MERCHANT_ID)"; else fail "admin merchant search ($CODE $BODY)"; finish; fi
api "$ADMIN_JAR" PUT "/v1/admin/merchants/$MERCHANT_ID/refunds-enabled" '{"enabled":true}'
check "$CODE" "200" "finance admin released any refunds hold on $MERCHANT_NAME"

# 3. Merchant owner: log in, list transactions ---------------------------------
JAR="$WORK/merchant"
login "$JAR" /v1/auth/login /v1/auth/otp/verify \
  "{\"merchantId\":\"$MERCHANT_ID\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" "owner $OWNER_EMAIL" || finish
api "$JAR" GET "/v1/transactions?limit=5"
COUNT="$(jq -r '(.transactions // .items // []) | length' <<<"$BODY" 2>/dev/null)"
if [ "$CODE" = "200" ] && [ "${COUNT:-0}" -gt 0 ]; then pass "listed transactions ($COUNT shown)"; else fail "list transactions ($CODE $BODY)"; fi

# 4. API key -> authorize -> capture -> partial refund ------------------------
api "$JAR" POST "/v1/merchants/$MERCHANT_ID/api-keys" '{"label":"hosted smoke test"}'
API_KEY="$(jq -r '.rawKey // empty' <<<"$BODY")"
check "$CODE" "201" "owner issued an API key"
[ -n "$API_KEY" ] || finish

AUTH_KEY="$API_KEY" api_retry "$WORK/none" POST /v1/transactions \
  "{\"amountFils\":10000,\"card\":$CARD,\"reference\":\"hosted-smoke\"}" "$(key)"
TXN="$(jq -r '.id // empty' <<<"$BODY")"
check "$CODE" "201" "authorized 10.000 BD with the API key"
[ -n "$TXN" ] || finish

api_retry "$JAR" POST "/v1/transactions/$TXN/capture" '{}' "$(key)"
check "$CODE" "200" "captured $TXN"

api_retry "$JAR" POST "/v1/merchants/$MERCHANT_ID/refunds" \
  "{\"transactionId\":\"$TXN\",\"amountFils\":4000,\"reason\":\"hosted smoke partial refund\"}" "$(key)"
check "$CODE" "200" "partial refund of 4.000 BD"
check "$(jq -r .transactionStatus <<<"$BODY" 2>/dev/null)" "partially_refunded" "status after partial refund"

api "$JAR" GET "/v1/transactions/$TXN"
check "$(jq -r '"\(.capturedFils)/\(.refundedFils)"' <<<"$BODY" 2>/dev/null)" "10000/4000" "transaction shows captured 10000, refunded 4000 fils"

finish
