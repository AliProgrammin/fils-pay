import { useCallback, useEffect, useId, useState } from "react";
import { getBusinessProfile, updateBusinessProfile } from "../../api/businessProfile.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import { useToast } from "../../components/Toast.js";
import { errorMessage } from "../../errors.js";
import { dash, dateTime } from "../../format.js";
import type { BusinessProfileDto } from "../../types.js";
import {
  BUSINESS_TYPES,
  PROFILE_FIELD_MAX,
  buildProfilePatch,
  businessTypeLabel,
  checkProfileForm,
  toProfileForm,
  type ProfileErrors,
  type ProfileForm,
} from "./businessProfileForm.js";

/**
 * `GET`/`PATCH /v1/merchants/:merchantId/business-profile`. Every role can
 * read it; only `owner`/`finance` can change it, so a `support` user sees
 * the facts and no Edit button. The PATCH sends only the changed fields.
 * Editing does not change the shop's onboarding status.
 */
export function BusinessProfilePage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [profile, setProfile] = useState<BusinessProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ProfileErrors>({});
  const [saving, setSaving] = useState(false);
  const notify = useToast();

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      setProfile(await getBusinessProfile(merchantId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(): void {
    if (!profile) return;
    setForm(toProfileForm(profile));
    setFieldErrors({});
    setError(null);
  }

  function setField(key: keyof ProfileForm, value: string): void {
    if (!form) return;
    const next = { ...form, [key]: value };
    setForm(next);
    // Once a field shows an error, re-check it as the person types.
    if (fieldErrors[key]) setFieldErrors({ ...fieldErrors, [key]: checkProfileForm(next)[key] });
  }

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || !profile || !form || saving) return;
    const problems = checkProfileForm(form);
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;
    const patch = buildProfilePatch(profile, form);
    if (Object.keys(patch).length === 0) {
      setForm(null);
      notify("No changes to save");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      setProfile(await updateBusinessProfile(merchantId, patch));
      setForm(null);
      notify("Business profile saved");
    } catch (err) {
      setError(errorMessage(err, "businessProfileUpdate"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Settings · business profile</p>
          <h1>Business profile</h1>
        </div>
        {profile && !form ? (
          <RequireRole allow={["owner", "finance"]}>
            <button type="button" className="dash-button dash-button-primary" onClick={startEdit}>
              Edit
            </button>
          </RequireRole>
        ) : null}
      </div>

      {error ? <p className="dash-error" role="alert">{error}</p> : null}

      {profile && !form ? (
        <>
          <dl className="dash-dl">
            <dt>Legal name</dt>
            <dd>{profile.legalName}</dd>
            <dt>Registration number</dt>
            <dd>{profile.registrationNumber}</dd>
            <dt>Business type</dt>
            <dd>{businessTypeLabel(profile.businessType)}</dd>
            <dt>Contact email</dt>
            <dd>{profile.contactEmail}</dd>
            <dt>Contact phone</dt>
            <dd>{profile.contactPhone}</dd>
            <dt>Address</dt>
            <dd>{profile.addressLine1}</dd>
            <dt>Address line 2</dt>
            <dd>{dash(profile.addressLine2)}</dd>
            <dt>City</dt>
            <dd>{profile.city}</dd>
            <dt>Postal code</dt>
            <dd>{dash(profile.postalCode)}</dd>
            <dt>Country</dt>
            <dd>{profile.country}</dd>
            <dt>Last changed</dt>
            <dd>{dateTime(profile.updatedAt)}</dd>
          </dl>
          <RequireRole allow={["support"]}>
            <p className="dash-note">Only the shop owner or a finance user can change these details.</p>
          </RequireRole>
        </>
      ) : null}

      {form ? (
        <form className="dash-form dash-card" noValidate onSubmit={(e) => void handleSave(e)}>
          <TextField label="Legal name" field="legalName" form={form} errors={fieldErrors} onChange={setField} autoComplete="organization" />
          <TextField label="Registration number" field="registrationNumber" form={form} errors={fieldErrors} onChange={setField} />
          <label>
            Business type
            <select value={form.businessType} onChange={(e) => setField("businessType", e.target.value)}>
              {BUSINESS_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <TextField label="Contact email" field="contactEmail" type="email" form={form} errors={fieldErrors} onChange={setField} autoComplete="email" />
          <TextField label="Contact phone" field="contactPhone" type="tel" form={form} errors={fieldErrors} onChange={setField} autoComplete="tel" />
          <TextField label="Address" field="addressLine1" form={form} errors={fieldErrors} onChange={setField} autoComplete="address-line1" />
          <TextField label="Address line 2 (optional)" field="addressLine2" form={form} errors={fieldErrors} onChange={setField} autoComplete="address-line2" />
          <TextField label="City" field="city" form={form} errors={fieldErrors} onChange={setField} autoComplete="address-level2" />
          <TextField label="Postal code (optional)" field="postalCode" form={form} errors={fieldErrors} onChange={setField} autoComplete="postal-code" />
          <TextField label="Country code" field="country" form={form} errors={fieldErrors} onChange={setField} maxLength={2} autoComplete="country" />
          <div className="dash-actions">
            <button type="submit" className="dash-button dash-button-primary" disabled={saving} aria-busy={saving || undefined}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="dash-button" disabled={saving} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}
    </section>
  );
}

/** One labelled text box with its error line under it. */
function TextField({
  label,
  field,
  form,
  errors,
  onChange,
  type = "text",
  maxLength = PROFILE_FIELD_MAX,
  autoComplete = "off",
}: {
  label: string;
  field: keyof ProfileForm;
  form: ProfileForm;
  errors: ProfileErrors;
  onChange: (key: keyof ProfileForm, value: string) => void;
  type?: "text" | "email" | "tel";
  maxLength?: number;
  autoComplete?: string;
}) {
  const noteId = useId();
  const error = errors[field];
  return (
    <>
      <label>
        {label}
        <input
          type={type}
          maxLength={maxLength}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(noteId, error)}
          value={form[field]}
          onChange={(e) => onChange(field, e.target.value)}
        />
      </label>
      <FieldNote id={noteId} error={error} />
    </>
  );
}
