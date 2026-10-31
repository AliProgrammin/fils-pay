import { checkEmail } from "../../inputRules.js";
import type { BusinessProfileDto, BusinessProfilePatch, BusinessType } from "../../types.js";

/** The `business_type` CHECK values (migration 0014), in plain words. */
export const BUSINESS_TYPES: { value: BusinessType; label: string }[] = [
  { value: "sole_proprietorship", label: "Sole proprietorship" },
  { value: "llc", label: "Limited liability company (W.L.L.)" },
  { value: "partnership", label: "Partnership" },
  { value: "public_company", label: "Public company (B.S.C.)" },
  { value: "other", label: "Other" },
];

export function businessTypeLabel(type: string): string {
  return BUSINESS_TYPES.find((t) => t.value === type)?.label ?? type.replace(/_/g, " ");
}

/** No API limit; a value longer than this is a mistake. */
export const PROFILE_FIELD_MAX = 200;

/** Every editable field as the text in its box. */
export type ProfileForm = Required<{ [K in keyof BusinessProfilePatch]: string }>;
export type ProfileErrors = Partial<Record<keyof ProfileForm, string>>;

export function toProfileForm(profile: BusinessProfileDto): ProfileForm {
  return {
    legalName: profile.legalName,
    registrationNumber: profile.registrationNumber,
    businessType: profile.businessType,
    country: profile.country,
    contactEmail: profile.contactEmail,
    contactPhone: profile.contactPhone,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2 ?? "",
    city: profile.city,
    postalCode: profile.postalCode ?? "",
  };
}

/** The columns that are NOT NULL in the database. */
const REQUIRED: { key: keyof ProfileForm; message: string }[] = [
  { key: "legalName", message: "Enter the legal name of the business" },
  { key: "registrationNumber", message: "Enter the commercial registration number" },
  { key: "contactPhone", message: "Enter a contact phone number" },
  { key: "addressLine1", message: "Enter the address" },
  { key: "city", message: "Enter the city" },
];

/**
 * Field errors to show; empty when the form may be sent. The API does not
 * check these fields itself (it only refuses unknown ones), so this is
 * what stops an empty name, or a country the `CHAR(2)` column refuses.
 */
export function checkProfileForm(form: ProfileForm): ProfileErrors {
  const errors: ProfileErrors = {};
  for (const { key, message } of REQUIRED) {
    if (form[key].trim() === "") errors[key] = message;
  }
  const email = checkEmail(form.contactEmail);
  if (email) errors.contactEmail = email;
  const phone = form.contactPhone.trim();
  if (phone !== "" && !/^\+?[\d\s()-]{7,20}$/.test(phone)) {
    errors.contactPhone = "Enter a phone number with digits only, for example +973 1700 0000";
  }
  if (!/^[A-Z]{2}$/.test(form.country.trim().toUpperCase())) {
    errors.country = "Enter the two-letter country code, for example BH";
  }
  if (!BUSINESS_TYPES.some((t) => t.value === form.businessType)) {
    errors.businessType = "Choose the type of business";
  }
  for (const key of Object.keys(form) as (keyof ProfileForm)[]) {
    if (!errors[key] && form[key].length > PROFILE_FIELD_MAX) {
      errors[key] = `This is too long (at most ${PROFILE_FIELD_MAX} characters)`;
    }
  }
  return errors;
}

/** The PATCH body: only the fields that changed, trimmed. An emptied
 *  optional field is sent as null, which clears it. */
export function buildProfilePatch(profile: BusinessProfileDto, form: ProfileForm): BusinessProfilePatch {
  const before = toProfileForm(profile);
  const patch: Record<string, string | null> = {};
  for (const key of Object.keys(form) as (keyof ProfileForm)[]) {
    let value = form[key].trim();
    if (key === "country") value = value.toUpperCase();
    if (value === before[key]) continue;
    patch[key] = value === "" && (key === "addressLine2" || key === "postalCode") ? null : value;
  }
  return patch as BusinessProfilePatch;
}
