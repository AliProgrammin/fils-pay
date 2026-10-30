/**
 * H8 (docs/bugs/hunt-2.md): parsePromotionalDiscountFils parsed BD with
 * parseFloat * 100 — wrong unit (1 BD = 1000 fils) and float maths, so
 * "4.750" became 475 instead of 4750. It had no callers and is deleted;
 * text BD amounts go through @filspay/money's parseBhdToFils.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBhdToFils } from "@filspay/money";
import * as discountAdjustment from "./discountAdjustment.js";

test("H8: the float BD parser is gone; parseBhdToFils gives the right fils", () => {
  assert.equal("parsePromotionalDiscountFils" in discountAdjustment, false);
  assert.equal(parseBhdToFils("4.750"), 4750);
});
