import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

/**
 * In-page confirmation for a risky action. A modal `<dialog>` with
 * role="alertdialog": focus moves to Cancel when it opens and returns to the
 * control that opened it when it closes; Escape cancels. Cancel never sends a
 * request — only the confirm button calls `onConfirm`.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  busy = false,
  danger = true,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  danger?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const cancelHandler = useRef(onCancel);
  cancelHandler.current = onCancel;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();

    // Escape fires "cancel": keep the dialog in React's control.
    function handleCancel(event: Event): void {
      event.preventDefault();
      if (!busyRef.current) cancelHandler.current();
    }
    // Keep Tab inside the dialog: wrap from the last control to the first.
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, textarea, a[href]"),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("keydown", handleKeyDown);
      if (dialog.open) dialog.close();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="admin-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      <p className="admin-dialog-kicker">{danger ? "Confirm risky action" : "Confirm"}</p>
      <h2 id={titleId}>{title}</h2>
      <div id={bodyId} className="admin-dialog-body">
        {children}
      </div>
      {error ? (
        <p className="admin-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="admin-dialog-actions">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? "admin-btn-danger" : "admin-btn-primary"}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy && busyLabel ? busyLabel : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
