import { statusLabel } from "../format.js";

/** A status as a coloured chip (`dash-status-<status>` picks the colour).
 *  The raw value keeps its class; the visible text is plain words. */
export function StatusChip({ status }: { status: string }) {
  return <span className={`dash-status dash-status-${status}`}>{statusLabel(status)}</span>;
}
