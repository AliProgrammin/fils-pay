package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// insertRefund writes what apps/api's processRefund writes for one refund:
// the refunds row (unbatched) and its ledger legs (gross back to the
// scheme, fee reversal back to the merchant).
func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeReversed money.Fils, occurredAt time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', $5, 'test', 'merchant_api_key', $6, $7)
		RETURNING id
	`, txnID, merchantID, int64(amount), int64(feeReversed), "acq-refund-"+uuid.New().String(), uuid.New(), occurredAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertRefund: %v", err)
	}
	group := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'merchant_payable',     'debit',  $4, $5, 'refund: gross'),
		  ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $5, 'refund: gross')
	`, group, merchantID, txnID, int64(amount), occurredAt)
	if err != nil {
		t.Fatalf("insertRefund: gross legs: %v", err)
	}
	if feeReversed > 0 {
		_, err = pool.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, $5, 'refund: MDR fee reversal'),
			  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'refund: MDR fee reversal')
		`, group, merchantID, txnID, int64(feeReversed), occurredAt)
		if err != nil {
			t.Fatalf("insertRefund: fee legs: %v", err)
		}
	}
	return id
}

func refundBatchID(t *testing.T, pool *pgxpool.Pool, refundID uuid.UUID) *uuid.UUID {
	t.Helper()
	var batchID *uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batchID); err != nil {
		t.Fatalf("refundBatchID: %v", err)
	}
	return batchID
}

// Net payout = captures - fees - refunds + fee reversals, and the refund is
// claimed by the batch so it is never deducted twice.
func TestCloseBatch_DeductsRefundsFromNetPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 4, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))
	refundID := insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	want := result.GrossFils - result.FeeFils - 4_000 + 100
	if result.NetPayoutFils != want {
		t.Errorf("NetPayoutFils = %d, want %d (gross %d - fee %d - refund 4000 + fee reversal 100)",
			result.NetPayoutFils, want, result.GrossFils, result.FeeFils)
	}
	if result.RefundFils != 4_000 || result.RefundFeeReversedFils != 100 {
		t.Errorf("RefundFils/RefundFeeReversedFils = %d/%d, want 4000/100", result.RefundFils, result.RefundFeeReversedFils)
	}

	var storedNet, storedRefund, storedRev int64
	if err := pool.QueryRow(ctx, `
		SELECT net_payout_fils, refund_fils, refund_fee_reversed_fils FROM settlement_batches WHERE id = $1
	`, result.BatchID).Scan(&storedNet, &storedRefund, &storedRev); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if storedNet != int64(want) || storedRefund != 4_000 || storedRev != 100 {
		t.Errorf("stored batch net/refund/rev = %d/%d/%d, want %d/4000/100", storedNet, storedRefund, storedRev, want)
	}
	if got := refundBatchID(t, pool, refundID); got == nil || *got != result.BatchID {
		t.Errorf("refund settlement_batch_id = %v, want %s", got, result.BatchID)
	}

	// Re-closing the same day is a no-op: the refund is not deducted twice.
	again, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("second CloseBatch: %v", err)
	}
	if !again.AlreadyClosed || again.NetPayoutFils != want {
		t.Errorf("re-close: AlreadyClosed=%v net=%d, want true/%d", again.AlreadyClosed, again.NetPayoutFils, want)
	}
}

// A refund larger than a day's net is not deducted into a negative payout:
// it stays unbatched and is claimed by the next batch that can absorb it.
func TestCloseBatch_CarriesRefundForwardWhenDayCannotAbsorbIt(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	day1 := time.Date(2026, 4, 21, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	day3 := day1.AddDate(0, 0, 2)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)
	start3, _ := BusinessDayWindow(day3)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start1.Add(time.Hour))
	if _, err := CloseBatch(ctx, pool, merchantID, day1); err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}

	// Day 2: a full refund, no sales. Net would be -9,750: do not claim it.
	refundID := insertRefund(t, pool, merchantID, txnID, 10_000, 250, start2.Add(time.Hour))
	r2, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if r2.NetPayoutFils != 0 || r2.RefundFils != 0 {
		t.Errorf("day2 net/refund = %d/%d, want 0/0", r2.NetPayoutFils, r2.RefundFils)
	}
	if got := refundBatchID(t, pool, refundID); got != nil {
		t.Errorf("day2 must not claim the refund, got batch %s", got)
	}

	// Day 3: enough sales to absorb it. The day-2 refund is claimed now.
	insertCaptureEvent(t, pool, merchantID, mdrBps, 20_000, start3.Add(time.Hour))
	r3, err := CloseBatch(ctx, pool, merchantID, day3)
	if err != nil {
		t.Fatalf("CloseBatch day3: %v", err)
	}
	want := r3.GrossFils - r3.FeeFils - 10_000 + 250
	if r3.NetPayoutFils != want || r3.RefundFils != 10_000 {
		t.Errorf("day3 net/refund = %d/%d, want %d/10000", r3.NetPayoutFils, r3.RefundFils, want)
	}
	if got := refundBatchID(t, pool, refundID); got == nil || *got != r3.BatchID {
		t.Errorf("day3 refund batch = %v, want %s", got, r3.BatchID)
	}
}

// A fee recalculation on a closed batch keeps the refunds it claimed in the
// payout: net = gross - newFee - refunds + fee reversals.
func TestRecalculateMDR_KeepsClaimedRefundsInNetPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 4, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))
	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr: %v", err)
	}
	if _, err := RecalculateMDR(ctx, pool, merchantID, businessDate, businessDate.AddDate(0, 0, 1)); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	var gross, fee, net int64
	if err := pool.QueryRow(ctx, `SELECT gross_fils, fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`,
		closed.BatchID).Scan(&gross, &fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee == int64(closed.FeeFils) {
		t.Fatalf("fee did not change (%d); test setup is wrong", fee)
	}
	if want := gross - fee - 4_000 + 100; net != want {
		t.Errorf("net after recalc = %d, want %d", net, want)
	}
}
