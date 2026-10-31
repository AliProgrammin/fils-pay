import assert from "node:assert/strict";
import test from "node:test";
import { checkKycFile, kycAccept, kycDocumentLabel } from "./kycForm.js";
import { KYC_MAX_FILE_BYTES } from "../../inputRules.js";

test("a file must be chosen and must not be empty", () => {
  assert.equal(checkKycFile("owner_id", null), "Choose a file to upload");
  assert.equal(checkKycFile("owner_id", { name: "id.png", size: 0 }), "This file is empty. Choose another file");
});

test("the size limit matches the API's 8 MB default, inclusive", () => {
  assert.equal(checkKycFile("owner_id", { name: "id.png", size: KYC_MAX_FILE_BYTES }), null);
  assert.equal(
    checkKycFile("owner_id", { name: "id.png", size: KYC_MAX_FILE_BYTES + 1 }),
    "This file is 8.0 MB. The largest file you can upload is 8 MB",
  );
});

test("commercial registration and bank letter need a .pdf name; other types do not", () => {
  assert.match(checkKycFile("commercial_registration", { name: "cr.jpg", size: 10 }) ?? "", /must be a PDF/);
  assert.match(checkKycFile("bank_letter", { name: "letter", size: 10 }) ?? "", /must be a PDF/);
  assert.equal(checkKycFile("bank_letter", { name: "Letter.PDF", size: 10 }), null);
  // The API decides an image's type from its bytes, so the name is not checked here.
  assert.equal(checkKycFile("owner_id", { name: "scan", size: 10 }), null);
});

test("the file picker offers only PDFs for a PDF-only type", () => {
  assert.equal(kycAccept("commercial_registration"), ".pdf,application/pdf");
  assert.match(kycAccept("proof_of_address"), /image\/png/);
});

test("document types read as plain words", () => {
  assert.equal(kycDocumentLabel("owner_id"), "Owner ID (CPR or passport)");
  assert.equal(kycDocumentLabel("something_new"), "something new");
});
