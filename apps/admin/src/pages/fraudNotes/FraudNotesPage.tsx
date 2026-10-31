import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listFraudNotes } from "../../api/fraudNotes.js";
import { errorMessage } from "../../errors.js";
import { StatusChip } from "../../components/StatusChip.js";
import { formatDateTime } from "../../format.js";
import { Pager } from "../../components/Pager.js";
import { usePagedList } from "../../components/usePagedList.js";
import type { FraudNoteDto } from "../../types.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import { checkTransactionId, checkUuid, filterUuidInput, isUuid } from "../../inputRules.js";

/**
 * "Fraud notes" — the acquirer's fraud-review verdicts, as received on
 * POST /v1/acquirer/callbacks. Read-only: a verdict changes nothing on the
 * transaction or the ledger. A confirmed-fraud note still needs a person to
 * decide on a void or a refund. Filters (merchant id, transaction id) live
 * in the URL, like every other list here.
 */
export function FraudNotesPage() {
  const merchantNoteId = useId();
  const transactionNoteId = useId();

  const [searchParams] = useSearchParams();
  const appliedMerchantId = searchParams.get("merchantId") ?? "";
  const appliedTransactionId = searchParams.get("transactionId") ?? "";
  // A malformed id in the URL can never match: no request, just say so.
  const urlValid =
    (appliedMerchantId === "" || isUuid(appliedMerchantId)) &&
    (appliedTransactionId === "" || isUuid(appliedTransactionId));

  const notes = usePagedList<FraudNoteDto>(
    JSON.stringify([appliedMerchantId, appliedTransactionId]),
    async (cursor, limit) => {
      const page = await listFraudNotes({
        merchantId: appliedMerchantId || undefined,
        transactionId: appliedTransactionId || undefined,
        limit,
        cursor,
      });
      return { rows: page.items, nextCursor: page.nextCursor };
    },
    urlValid,
  );

  const [merchantId, setMerchantId] = useState(appliedMerchantId);
  const [transactionId, setTransactionId] = useState(appliedTransactionId);
  const [merchantIdError, setMerchantIdError] = useState<string | null>(null);
  const [transactionIdError, setTransactionIdError] = useState<string | null>(null);

  // Keep the boxes in step with the URL (back/forward, Clear filters, a link in).
  useEffect(() => setMerchantId(appliedMerchantId), [appliedMerchantId]);
  useEffect(() => setTransactionId(appliedTransactionId), [appliedTransactionId]);

  const hasFilters = appliedMerchantId !== "" || appliedTransactionId !== "";
  const rows = notes.rows;
  const loadError = !urlValid
    ? "The merchant id or transaction id in this link is not valid. Clear the filters and try again."
    : notes.error
      ? errorMessage(notes.error)
      : null;

  function applyFilters(event: React.FormEvent): void {
    event.preventDefault();
    const m = merchantId.trim();
    const t = transactionId.trim();
    const mError = m === "" ? null : checkUuid(m);
    const tError = t === "" ? null : checkTransactionId(t);
    setMerchantIdError(mError);
    setTransactionIdError(tError);
    if (mError || tError) return;
    notes.updateParams((params) => {
      if (m) params.set("merchantId", m);
      else params.delete("merchantId");
      if (t) params.set("transactionId", t);
      else params.delete("transactionId");
    });
  }

  function clearFilters(): void {
    setMerchantIdError(null);
    setTransactionIdError(null);
    notes.updateParams((params) => {
      params.delete("merchantId");
      params.delete("transactionId");
    });
  }

  return (
    <section>
      <header className="admin-page-head">
        <p className="admin-kicker">Acquirer verdicts · Read-only</p>
        <h1>Fraud notes</h1>
        <p className="admin-lede">
          The bank&apos;s fraud-review verdicts on card payments, most recent first. A note changes
          nothing by itself: a payment marked <strong>confirmed fraud</strong> still needs a person to
          decide on a void or a refund.
        </p>
      </header>

      <form className="admin-form admin-form-inline" noValidate onSubmit={applyFilters}>
        <label>
          Merchant id
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="00000000-0000-0000-0000-000000000000"
            aria-invalid={merchantIdError ? true : undefined}
            aria-describedby={describedBy(merchantNoteId, merchantIdError)}
            value={merchantId}
            onChange={(e) => {
              const next = filterUuidInput(e.target.value);
              setMerchantId(next);
              if (merchantIdError) setMerchantIdError(next === "" ? null : checkUuid(next));
            }}
          />
        </label>
        <label>
          Transaction id
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="00000000-0000-0000-0000-000000000000"
            aria-invalid={transactionIdError ? true : undefined}
            aria-describedby={describedBy(transactionNoteId, transactionIdError)}
            value={transactionId}
            onChange={(e) => {
              const next = filterUuidInput(e.target.value);
              setTransactionId(next);
              if (transactionIdError) setTransactionIdError(next === "" ? null : checkTransactionId(next));
            }}
          />
        </label>
        <button type="submit" className="admin-btn-primary">Filter</button>
        {hasFilters ? (
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
        <FieldNote id={merchantNoteId} error={merchantIdError} />
        <FieldNote id={transactionNoteId} error={transactionIdError} />
      </form>

      {loadError ? <p className="admin-error" role="alert">{loadError}</p> : null}

      <div className="admin-table-wrap">
        <table className="admin-table admin-table-cards">
          <thead>
            <tr>
              <th>Received</th>
              <th>Outcome</th>
              <th>Merchant</th>
              <th>Transaction</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.id}>
                <td className="admin-card-head">{formatDateTime(item.receivedAt)}</td>
                <td data-label="Outcome">
                  <StatusChip value={item.outcome} />
                </td>
                <td data-label="Merchant">
                  <Link to={`/merchants/${item.merchantId}`} title={`Open merchant ${item.merchantId}`}>
                    {item.merchantName}
                  </Link>
                </td>
                <td data-label="Transaction">
                  <code title={item.transactionId}>{item.transactionId.slice(0, 8)}…</code>
                </td>
                <td data-label="Note" className="admin-note">{item.note}</td>
              </tr>
            ))}
            {rows.length === 0 && !notes.loading && !loadError ? (
              <tr>
                <td colSpan={5} className="admin-empty">
                  {hasFilters ? (
                    <>
                      No fraud notes match these filters.{" "}
                      <button type="button" className="admin-btn-small" onClick={clearFilters}>
                        Clear filters
                      </button>
                    </>
                  ) : (
                    "No fraud notes yet. They appear here when the bank sends a fraud-review verdict."
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {notes.loading ? <p className="admin-loading" role="status">Loading fraud notes…</p> : null}

      <Pager
        page={notes.page}
        size={notes.size}
        count={rows.length}
        hasNext={notes.hasNext}
        loading={notes.loading}
        onPrev={notes.goPrev}
        onNext={notes.goNext}
        onSize={notes.setSize}
      />
    </section>
  );
}
