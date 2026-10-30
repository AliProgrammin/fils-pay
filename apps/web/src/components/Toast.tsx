import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The one toast for the whole app: a short themed notice after an action
 * worked ("Webhook disabled", "Link copied"). It sits in a live region with
 * role="status", so a screen reader reads it too. No sound. Failures do not
 * use it: they stay on the page as the existing inline error messages.
 */
type Tone = "ok" | "error";
interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

const SHOW_MS = 3500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const notify = useCallback(
    (message: string, tone: Tone = "ok") => {
      const id = nextId.current++;
      // Keep at most three on screen; the newest is last.
      setItems((current) => [...current.slice(-2), { id, message, tone }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), SHOW_MS));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="fp-toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={item.tone === "error" ? "fp-toast fp-toast-error" : "fp-toast"}>
            <span>{item.message}</span>
            <button type="button" className="fp-toast-close" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, tone?: Tone) => void {
  return useContext(ToastContext);
}
