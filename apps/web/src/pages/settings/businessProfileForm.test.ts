import assert from "node:assert/strict";
import test from "node:test";
import { buildProfilePatch, checkProfileForm, toProfileForm } from "./businessProfileForm.js";
import type { BusinessProfileDto } from "../../types.js";

const PROFILE: BusinessProfileDto = {
  merchantId: "00000000-0000-4000-8000-000000000001",
  legalName: "Alpha Retail Co W.L.L.",
  registrationNumber: "CR-12345",
  businessType: "llc",
  country: "BH",
  contactEmail: "owner@alpharetail.example",
  contactPhone: "+973 1700 0000",
  addressLine1: "Building 1, Road 2",
  addressLine2: "Flat 3",
  city: "Manama",
  postalCode: null,
  updatedAt: "2026-09-01T10:00:00.000Z",
};

test("an unchanged form sends an empty patch", () => {
  assert.deepEqual(buildProfilePatch(PROFILE, toProfileForm(PROFILE)), {});
});

test("the patch carries only changed fields, trimmed", () => {
  const form = { ...toProfileForm(PROFILE), city: "  Muharraq ", contactPhone: "+973 1711 1111" };
  assert.deepEqual(buildProfilePatch(PROFILE, form), { city: "Muharraq", contactPhone: "+973 1711 1111" });
});

test("an emptied optional field is sent as null, so it is cleared", () => {
  const form = { ...toProfileForm(PROFILE), addressLine2: "   " };
  assert.deepEqual(buildProfilePatch(PROFILE, form), { addressLine2: null });
});

test("the country is sent in capitals", () => {
  const form = { ...toProfileForm(PROFILE), country: "sa" };
  assert.deepEqual(buildProfilePatch(PROFILE, form), { country: "SA" });
});

test("a valid profile has no errors", () => {
  assert.deepEqual(checkProfileForm(toProfileForm(PROFILE)), {});
});

test("required fields, email, phone and country are checked", () => {
  const errors = checkProfileForm({
    ...toProfileForm(PROFILE),
    legalName: " ",
    city: "",
    contactEmail: "not-an-email",
    contactPhone: "call me",
    country: "BHR",
  });
  assert.deepEqual(Object.keys(errors).sort(), ["city", "contactEmail", "contactPhone", "country", "legalName"]);
  // Optional fields may be empty.
  assert.deepEqual(checkProfileForm({ ...toProfileForm(PROFILE), addressLine2: "", postalCode: "" }), {});
});
