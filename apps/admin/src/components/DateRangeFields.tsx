import { useId } from "react";
import { bahrainToday, DATE_PRESETS, presetRange } from "../dateRange.js";

/**
 * From / To native date inputs (Bahrain dates) plus quick presets. "To" is
 * inclusive here; callers send `exclusiveTo(to)` to the API. Neither date may
 * be after today (Bahrain). The caller checks `rangeError` and makes no
 * request while there is one; this component only shows it.
 */
export function DateRangeFields({
  from,
  to,
  onChange,
  error,
  required = false,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  error: string | null;
  required?: boolean;
}) {
  const errorId = useId();
  const today = bahrainToday();
  const describedBy = error ? errorId : undefined;
  return (
    <>
      <label>
        From
        <input
          type="date"
          required={required}
          max={today}
          value={from}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange({ from: e.target.value, to })}
        />
      </label>
      <label>
        To
        <input
          type="date"
          required={required}
          min={from || undefined}
          max={today}
          value={to}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange({ from, to: e.target.value })}
        />
      </label>
      <div className="admin-presets" role="group" aria-label="Quick dates">
        {DATE_PRESETS.map((preset) => {
          const range = presetRange(preset.id);
          return (
            <button
              key={preset.id}
              type="button"
              className="admin-preset"
              aria-pressed={range.from === from && range.to === to}
              onClick={() => onChange(range)}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="admin-field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
