package settlement

import (
	"context"
	"testing"
	"time"
)

// A paid batch's money already left. Recalculation must not rewrite its
// fee or net payout, nor post adjustments or move the balance cache for it.
func TestRecalculateMDR_NeverTouchesPaidBatch_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 4, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}
	ledgerBefore := countRows(t, pool, `SELECT COUNT(*) FROM ledger_entries WHERE merchant_id = $1`, merchantID)

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 0 {
		t.Errorf("adjusted %d batch(es), want 0 (batch is paid)", len(result.Adjusted))
	}
	var fee, net int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != int64(closed.FeeFils) || net != int64(closed.NetPayoutFils) {
		t.Errorf("paid batch rewritten: fee %d net %d, want fee %d net %d", fee, net, closed.FeeFils, closed.NetPayoutFils)
	}
	if after := countRows(t, pool, `SELECT COUNT(*) FROM ledger_entries WHERE merchant_id = $1`, merchantID); after != ledgerBefore {
		t.Errorf("ledger rows %d -> %d, want no new adjustment legs", ledgerBefore, after)
	}
}

// Recalculation must charge each event the rate CloseBatch charges:
// the fee_schedules row in effect at the event time, not merchants.mdr_bps.
func TestRecalculateMDR_UsesEffectiveFeeSchedule_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 4, 21, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertFeeSchedule(t, pool, merchantID, 200, start.Add(-30*24*time.Hour))
	insertCaptureEvent(t, pool, merchantID, 200, 10_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 0 {
		t.Errorf("adjusted %+v, want nothing: the contracted rate (200 bps schedule) did not change", result.Adjusted)
	}
	var fee int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&fee); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != int64(closed.FeeFils) {
		t.Errorf("fee_fils = %d, want %d", fee, closed.FeeFils)
	}
}
