type Tone = "ok" | "warn" | "bad" | "dark" | "neutral";

const TONES: Record<string, Tone> = {
  active: "ok",
  approved: "ok",
  passed: "ok",
  posted: "ok",
  live: "ok",
  on: "ok",
  succeeded: "ok",
  paid: "ok",
  closed: "neutral",
  submitted: "warn",
  under_review: "warn",
  pending_approval: "warn",
  pending: "warn",
  open: "warn",
  failed: "bad",
  exhausted: "bad",
  rejected: "bad",
  suspended: "bad",
  disabled: "bad",
  revoked: "bad",
  "not passed": "bad",
  off: "bad",
  test: "dark",
};

/** A status value shown as a coloured chip. The text is the raw value, so
 *  nothing is renamed; the colour only adds a quick visual read. */
export function StatusChip({ value, tone }: { value: string; tone?: Tone }) {
  const resolved = tone ?? TONES[value] ?? "neutral";
  return <span className={`admin-chip admin-chip-${resolved}`}>{value}</span>;
}
