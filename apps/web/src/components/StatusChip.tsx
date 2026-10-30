/** A status as a coloured chip (`dash-status-<status>` picks the colour).
 *  The raw value keeps its class; only the visible text loses underscores. */
export function StatusChip({ status }: { status: string }) {
  return <span className={`dash-status dash-status-${status}`}>{status.replace(/_/g, " ")}</span>;
}
