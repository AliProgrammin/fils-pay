import { useEffect, useState } from "react";
import { useToast } from "./Toast.js";

/**
 * A small copy button. Shows "Copied" for a moment and a toast
 * ("Link copied"). If the browser refuses the clipboard, says so plainly:
 * the value is on screen and can be selected by hand.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedMessage = "Copied",
  ariaLabel,
}: {
  value: string;
  label?: string;
  copiedMessage?: string;
  ariaLabel?: string;
}) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      notify(copiedMessage);
    } catch {
      notify("Could not copy. Select the text and copy it by hand.", "error");
    }
  }

  return (
    <button
      type="button"
      className="dash-button dash-button-small dash-copy-button"
      aria-label={ariaLabel}
      onClick={() => void copy()}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
