/**
 * The line under a form field: its error (announced, red) or else a quiet
 * note such as "40 characters left". Point the field's aria-describedby at
 * `id` with `describedBy(...)` so screen readers read it with the field.
 */
export function FieldNote({ id, error, note }: { id: string; error?: string | null; note?: string | null }) {
  if (error) {
    return (
      <p className="dash-field-error" id={id} role="alert">
        {error}
      </p>
    );
  }
  if (note) {
    return (
      <p className="dash-muted dash-hint" id={id} aria-live="polite">
        {note}
      </p>
    );
  }
  return null;
}

/** The aria-describedby value for a field whose FieldNote may be empty. */
export function describedBy(id: string, error?: string | null, note?: string | null): string | undefined {
  return error || note ? id : undefined;
}
