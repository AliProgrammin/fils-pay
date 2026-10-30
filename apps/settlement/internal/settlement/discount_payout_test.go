package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// H4: apps/api capture.ts now posts the negotiated discount legs inside the
// capture transaction, sized as MDR fee - ComputeSettlementFee. This test
// writes exactly those legs (seed Alpha Retail: 275 bps MDR, 75 bps
// discount, 100.000 BD: fee 2,750, discount 21, net fee 2,729), then closes
// and pays the batch. merchant_payable must end at exactly 0.
func TestCloseAndPayout_DiscountedCaptureLeavesPayableZero(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps, discountBps = 275, 75
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	if _, err := pool.Exec(ctx, `UPDATE merchants SET negotiated_discount_bps = $2 WHERE id = $1`, merchantID, discountBps); err != nil {
		t.Fatalf("set discount: %v", err)
	}
	businessDate := time.Date(2026, 3, 21, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	occurredAt := start.Add(time.Hour)

	txnID, feeFils := insertCaptureEvent(t, pool, merchantID, mdrBps, 100_000, occurredAt)
	discountFils := feeFils - ComputeSettlementFee(100_000, mdrBps, discountBps)
	if feeFils != 2750 || discountFils != 21 {
		t.Fatalf("fee=%d discount=%d, want 2750 and 21 (the legs apps/api posts)", feeFils, discountFils)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, $5, 'capture: negotiated discount adjustment'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'capture: negotiated discount adjustment')
	`, uuid.New(), merchantID, txnID, int64(discountFils), occurredAt); err != nil {
		t.Fatalf("insert discount legs: %v", err)
	}

	closeResult, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closeResult.FeeFils != 2729 {
		t.Fatalf("batch fee = %d, want 2729", closeResult.FeeFils)
	}
	if _, err := PayoutBatch(ctx, pool, closeResult.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}

	var payable int64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&payable); err != nil {
		t.Fatalf("sum merchant_payable: %v", err)
	}
	if payable != 0 {
		t.Errorf("merchant_payable after close+payout = %d, want 0", payable)
	}
}
