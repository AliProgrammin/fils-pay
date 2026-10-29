import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPIRE_HOLDS_SQL } from "./expire_holds.js";

test("expiry is a single status UPDATE that re-checks status, never a DELETE", () => {
  assert.equal(
    EXPIRE_HOLDS_SQL,
    "UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()",
  );
  assert.doesNotMatch(EXPIRE_HOLDS_SQL, /DELETE/i);
});
