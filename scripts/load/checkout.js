// FilsPay checkout load test (k6). See docs/submission/CAPACITY.md and scripts/load/run.sh.
//
// One iteration = one customer checkout, the same calls the real flow makes:
//   SCENARIO=link (default): the merchant creates a payment link (API key),
//     the customer opens the checkout page (/pay/<token> + GET link) and pays
//     (POST /v1/payment-links/<token>/pay with an Idempotency-Key). A second
//     pay with the same key (double click) must not charge twice.
//   SCENARIO=api: POST /v1/transactions (authorize) then
//     POST /v1/transactions/<id>/capture, each with an Idempotency-Key. The
//     authorize is sent twice with the same key: the replay must return the
//     same transaction id.
//
// A 502 (simulated acquirer error) or 503/429 (server busy) is retried with
// the SAME key, as a real client must. 402 (declined card) is a valid answer.
//
// Env: BASE_URL, SCENARIO, MODE (ramp | steady | overload), VUS, RAMP, DURATION,
//      THINK (seconds between customer steps), RUN_ID (tags references).
import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = (__ENV.BASE_URL || "http://localhost:8097").replace(/\/$/, "");
const SCENARIO = __ENV.SCENARIO || "link";
const MODE = __ENV.MODE || "steady";
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || "2m";
const THINK = Number(__ENV.THINK || 1);
const RUN_ID = __ENV.RUN_ID || `load-${Date.now()}`;
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const AMOUNT_FILS = 1250;

const checkoutsOk = new Counter("checkouts_ok"); // paid / captured
const checkoutsDeclined = new Counter("checkouts_declined"); // 402, valid answer
const checkoutsFailed = new Counter("checkouts_failed"); // anything else
const shed = new Counter("shed_responses"); // 503/429 the server turned away
const serverErrors = new Counter("server_errors"); // other 5xx or timeouts
const checkoutTime = new Trend("checkout_duration", true);

// 402 is a business answer, 409 is the expected answer to a double click.
// 502 (acquirer) and 503 (busy) are retried and counted by the counters below.
http.setResponseCallback(http.expectedStatuses(200, 201, 402, 409));

function scenarios() {
  if (MODE === "ramp") {
    // Steps of STEP users, each held STEP_HOLD, up to VUS.
    const step = Number(__ENV.STEP || 10);
    const hold = __ENV.STEP_HOLD || "60s";
    const stages = [];
    for (let v = step; v <= VUS; v += step) stages.push({ duration: "10s", target: v }, { duration: hold, target: v });
    return { ramp: { executor: "ramping-vus", startVUs: 0, stages, gracefulRampDown: "30s" } };
  }
  // Users arrive over RAMP (not all in the same millisecond), then stay.
  const stages = [{ duration: __ENV.RAMP || "30s", target: VUS }, { duration: DURATION, target: VUS }];
  return { steady: { executor: "ramping-vus", startVUs: 0, stages, gracefulRampDown: "30s" } };
}

export const options = {
  scenarios: scenarios(),
  setupTimeout: "120s",
  // Fixed SLO used for the capacity estimate (docs/submission/CAPACITY.md).
  thresholds:
    MODE === "overload"
      ? {
          // No pass/fail past capacity: these only make k6 report how fast
          // refused (503) and served (200/201) answers come back.
          "http_req_duration{status:503}": ["max>=0"],
          "http_req_duration{status:200}": ["max>=0"],
          "http_req_duration{status:201}": ["max>=0"],
        }
      : {
          // Non-payment calls fast; pay includes two acquirer round trips
          // (0.1-0.4 s each, simulated), so it gets its own bound.
          "http_req_duration{name:create link}": ["p(95)<300"],
          "http_req_duration{name:get link}": ["p(95)<300"],
          "http_req_duration{name:checkout page}": ["p(95)<300"],
          "http_req_duration{name:pay}": ["p(95)<1500"],
          "http_req_duration{name:authorize}": ["p(95)<1000"],
          "http_req_duration{name:capture}": ["p(95)<1000"],
          checkouts_failed: ["count==0"],
          server_errors: ["count==0"],
          shed_responses: ["count==0"],
        },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const json = (body) => JSON.stringify(body);
// One reference per checkout, so scripts/load/verify.sql can match DB rows.
const ref = () => `${RUN_ID}-${__VU}-${__ITER}`;
// Think time with +-50% jitter, so users do not move in lockstep.
const think = () => sleep(THINK * (0.5 + Math.random()));
const key = () => `${RUN_ID}-${__VU}-${__ITER}-${Math.random().toString(36).slice(2)}`;

function post(path, body, headers, name) {
  return http.post(`${BASE}${path}`, json(body), {
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    tags: { name },
    timeout: "30s",
  });
}

// Retries a busy (503/429) or acquirer-error (502) answer with the same key.
function postRetry(path, body, headers, name) {
  return retry(() => post(path, body, headers, name));
}

function getRetry(path, name) {
  return retry(() => http.get(`${BASE}${path}`, { tags: { name }, timeout: "30s" }));
}

function retry(send) {
  let res;
  for (let i = 0; i < 8; i++) {
    res = send();
    if (res.status === 503 || res.status === 429) {
      shed.add(1);
      sleep(Number(res.headers["Retry-After"] || 1));
      continue;
    }
    // A 502 from the API's simulated acquirer is an expected, retryable
    // answer; any other 5xx or a timeout (status 0) is a server error.
    const acquirerError = res.status === 502 && String(res.body).includes("acquirer_unavailable");
    if (acquirerError) continue;
    if (res.status === 0 || res.status >= 500) serverErrors.add(1);
    return res;
  }
  return res;
}

function login(loginPath, verifyPath, body) {
  const jar = http.cookieJar();
  const res = post(loginPath, body, {}, "setup");
  if (res.status !== 200) fail(`login ${loginPath}: ${res.status} ${res.body}`);
  const code = res.json("devOtpCode");
  if (!code) fail("no devOtpCode: the server needs OTP_DEV_EXPOSE=true");
  const v = post(verifyPath, { code }, {}, "setup");
  if (v.status !== 200) fail(`otp ${verifyPath}: ${v.status} ${v.body}`);
  return jar;
}

// Seeded demo merchant (db/seed/generate.ts). Issues one API key for the run.
export function setup() {
  login("/v1/admin/auth/login", "/v1/admin/auth/otp/verify", {
    email: "finance@filspay.test",
    password: "FilsPayAdminSeed!2026",
  });
  const m = http.get(`${BASE}/v1/admin/merchants?q=Alpha%20Retail`, { tags: { name: "setup" } });
  const merchant = (m.json("merchants") || []).find((x) => x.displayName === "Alpha Retail Co");
  if (!merchant) fail(`merchant not found: ${m.status} ${m.body}`);
  login("/v1/auth/login", "/v1/auth/otp/verify", {
    merchantId: merchant.id,
    email: "owner@alpharetail.example",
    password: "FilsPaySeed!2026",
  });
  const k = post(`/v1/merchants/${merchant.id}/api-keys`, { label: `load test ${RUN_ID}` }, {}, "setup");
  if (k.status !== 201) fail(`api key: ${k.status} ${k.body}`);
  http.cookieJar().clear(BASE);
  return { merchantId: merchant.id, apiKey: k.json("rawKey") };
}

function linkCheckout(data) {
  const auth = { Authorization: `Bearer ${data.apiKey}` };
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  const created = postRetry(
    `/v1/merchants/${data.merchantId}/payment-links`,
    { amountFils: AMOUNT_FILS, expiresAt, reference: ref() },
    auth,
    "create link",
  );
  if (!check(created, { "link created": (r) => r.status === 201 })) return "failed";
  const token = created.json("token");
  think();

  const started = Date.now();
  const page = getRetry(`/pay/${token}`, "checkout page");
  const link = getRetry(`/v1/payment-links/${token}`, "get link");
  check(page, { "checkout page 200": (r) => r.status === 200 });
  if (!check(link, { "link read": (r) => r.status === 200 })) return "failed";
  think();

  const idem = { "Idempotency-Key": key() };
  const paid = postRetry(`/v1/payment-links/${token}/pay`, { card: CARD }, idem, "pay");
  checkoutTime.add(Date.now() - started);
  if (paid.status === 402) return "declined";
  if (!check(paid, { "paid 200": (r) => r.status === 200 && r.json("status") === "paid" })) return "failed";

  // Double click: same key, must not create a second payment.
  const again = postRetry(`/v1/payment-links/${token}/pay`, { card: CARD }, idem, "pay again");
  check(again, { "double click not charged": (r) => r.status === 409 && r.json("error") === "payment_link_already_paid" });
  return again.status === 409 ? "ok" : "failed";
}

function apiCheckout(data) {
  const auth = { Authorization: `Bearer ${data.apiKey}` };
  const started = Date.now();
  const authKey = { ...auth, "Idempotency-Key": key() };
  const body = { amountFils: AMOUNT_FILS, card: CARD, reference: ref() };
  const authz = postRetry("/v1/transactions", body, authKey, "authorize");
  if (authz.status === 402) return "declined";
  if (!check(authz, { "authorized 201": (r) => r.status === 201 })) return "failed";
  const id = authz.json("id");

  const replay = postRetry("/v1/transactions", body, authKey, "authorize replay");
  if (!check(replay, { "replay same id": (r) => r.status === 201 && r.json("id") === id })) return "failed";
  think();

  const cap = postRetry(`/v1/transactions/${id}/capture`, {}, { ...auth, "Idempotency-Key": key() }, "capture");
  checkoutTime.add(Date.now() - started);
  if (cap.status === 402) return "declined";
  return check(cap, { "captured 200": (r) => r.status === 200 && r.json("status") === "captured" }) ? "ok" : "failed";
}

export default function (data) {
  const outcome = SCENARIO === "api" ? apiCheckout(data) : linkCheckout(data);
  if (outcome === "ok") checkoutsOk.add(1);
  else if (outcome === "declined") checkoutsDeclined.add(1);
  else checkoutsFailed.add(1);
  think();
}
