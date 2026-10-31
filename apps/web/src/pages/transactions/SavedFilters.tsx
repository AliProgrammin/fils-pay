import { useEffect, useState } from "react";
import { createSavedFilter, listSavedFilters, type SavedFilterDto } from "../../api/reporting.js";
import { errorMessage } from "../../errors.js";
import { useAction } from "../../components/useAction.js";
import { useToast } from "../../components/Toast.js";
import {
  SAVED_FILTER_NAME_MAX,
  checkFilterName,
  fromSavedFilter,
  sameFilters,
  toSavedFilter,
  type PageFilters,
} from "./reportFilters.js";

/**
 * `GET` and `POST /v1/reporting/saved-filters`. Any merchant user can save
 * the current filters under a name; one click on a name applies them. The
 * API has no rename or delete, so neither does this list.
 */
export function SavedFilters({
  current,
  hasFilters,
  onApply,
}: {
  current: PageFilters;
  hasFilters: boolean;
  onApply: (filters: PageFilters) => void;
}) {
  const notify = useToast();
  const [saved, setSaved] = useState<SavedFilterDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, runSave] = useAction();

  useEffect(() => {
    let cancelled = false;
    listSavedFilters()
      .then((rows) => {
        if (!cancelled) setSaved(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(): Promise<void> {
    const problem = checkFilterName(name, saved.map((f) => f.name));
    if (problem) {
      setSaveError(problem);
      return;
    }
    setSaveError(null);
    await runSave(async () => {
      try {
        const created = await createSavedFilter({ name: name.trim(), filter: toSavedFilter(current) });
        setSaved((rows) => [created, ...rows]);
        setName("");
        notify("Filters saved");
      } catch (err) {
        setSaveError(errorMessage(err));
      }
    });
  }

  return (
    <fieldset className="dash-filters">
      <legend>Saved filters</legend>
      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}
      {loadError ? <p className="dash-error" role="alert">{loadError}</p> : null}
      {!loading && !loadError && saved.length === 0 ? (
        <p className="dash-muted">None yet. Choose filters above, then save them here.</p>
      ) : null}
      {saved.length > 0 ? (
        <div className="dash-presets" role="group" aria-label="Saved filters">
          {saved.map((item) => {
            const filters = fromSavedFilter(item.filter);
            return (
              <button
                key={item.id}
                type="button"
                className="dash-preset"
                disabled={filters === null}
                title={filters === null ? "Saved outside the dashboard. This page can't show these filters." : undefined}
                aria-pressed={filters !== null && sameFilters(filters, current)}
                onClick={() => filters && onApply(filters)}
              >
                {item.name}
              </button>
            );
          })}
        </div>
      ) : null}
      {hasFilters ? (
        <form
          className="dash-form dash-form-inline"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Save current filters as
            <input
              type="text"
              maxLength={SAVED_FILTER_NAME_MAX}
              placeholder="For example: October refunds"
              value={name}
              aria-invalid={saveError ? true : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setSaveError(null);
              }}
            />
          </label>
          <button type="submit" className="dash-button dash-button-small" disabled={saving} aria-busy={saving || undefined}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saveError ? <p className="dash-field-error" role="alert">{saveError}</p> : null}
        </form>
      ) : null}
    </fieldset>
  );
}
