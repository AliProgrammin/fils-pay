import { useCallback, useRef, useState } from "react";

/**
 * Busy state for one action button. `run(fn)` does nothing while a previous
 * run is still going, so a fast double click can never submit twice — the
 * ref guard holds even before React has re-rendered the button as disabled.
 */
export function useAction(): [boolean, <R>(fn: () => Promise<R>) => Promise<R | undefined>] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, run];
}
