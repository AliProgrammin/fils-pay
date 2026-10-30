import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import "../dashboard.css";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Shown big, e.g. "57.000 BHD". */
  amount?: string;
  confirmLabel: string;
  cancelLabel?: string;
}

/**
 * The dashboard's replacement for `window.confirm`: a modal alert dialog in
 * the dashboard theme. Built on `<dialog>.showModal()`, so the rest of the
 * page is inert while it is open. Focus moves to the cancel button (the safe
 * choice), Escape cancels, and focus goes back to where it was on close.
 */
function ConfirmDialog({
  options,
  onClose,
}: {
  options: ConfirmOptions;
  onClose: (confirmed: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      returnTo?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="dash-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => {
        // Escape: close through React state, not the browser's own close.
        event.preventDefault();
        onClose(false);
      }}
    >
      <div className="dash-dialog-head">
        <h2 className="dash-panel-title" id={titleId}>
          {options.title}
        </h2>
      </div>
      <div className="dash-dialog-body">
        {options.amount ? <p className="dash-dialog-amount">{options.amount}</p> : null}
        <p id={messageId} className="dash-dialog-message">
          {options.message}
        </p>
        <div className="dash-dialog-actions">
          <button ref={cancelRef} type="button" className="dash-button" onClick={() => onClose(false)}>
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button type="button" className="dash-button dash-button-primary" onClick={() => onClose(true)}>
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * `const [dialog, confirm] = useConfirmDialog();` then render `{dialog}` and
 * `if (!(await confirm({...}))) return;` where `window.confirm` used to be.
 * Resolves `true` only when the person presses the confirm button.
 */
export function useConfirmDialog(): [ReactNode, (options: ConfirmOptions) => Promise<boolean>] {
  const [pending, setPending] = useState<{
    options: ConfirmOptions;
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      }),
    [],
  );

  const dialog = pending ? (
    <ConfirmDialog
      options={pending.options}
      onClose={(confirmed) => {
        setPending(null);
        pending.resolve(confirmed);
      }}
    />
  ) : null;

  return [dialog, confirm];
}
