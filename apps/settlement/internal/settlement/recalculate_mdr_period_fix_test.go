package settlement

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// A correction is posted with the effective date of the period it corrects
// (docs/ARCHITECTURE.md "The ledger"). The recalculation changes the batch's
// net payout in the batch's period, so its ledger legs must fall in that same
// business day, or reconciliation shows a gap in both periods.
func TestRecalculateMDR_AdjustmentDatedInBatchPeriod_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 4, 22, 0, 0, 0, 0, time.UTC)
	start, end := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))

	if _, err := CloseBatch(ctx, pool, merchantID, businessDate); err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}
	from, to := recalcWindow(businessDate)
	if _, err := RecalculateMDR(ctx, pool, merchantID, from, to); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	t.Logf("merchant %s", merchantID)

	var outside, legs int64
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE occurred_at < $2 OR occurred_at >= $3), COUNT(*)
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND description = 'MDR recalculation adjustment'
	`, merchantID, start, end).Scan(&outside, &legs); err != nil {
		t.Fatalf("read adjustment legs: %v", err)
	}
	if legs != 2 {
		t.Fatalf("adjustment legs = %d, want 2", legs)
	}
	if outside != 0 {
		t.Errorf("%d adjustment leg(s) dated outside the batch's business day [%s, %s)", outside, start, end)
	}
}

// Reporting's payout trend is built from outbox events. A recalculation that
// changes a closed batch's fee must enqueue an event with the new figures in
// the same transaction, or the trend keeps the old fee and net.
func TestRecalculateMDR_EnqueuesCorrectedBatchEvent_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 4, 23, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}
	from, to := recalcWindow(businessDate)
	if _, err := RecalculateMDR(ctx, pool, merchantID, from, to); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}

	var raw []byte
	err = pool.QueryRow(ctx, `
		SELECT payload FROM outbox_events
		 WHERE aggregate_id = $1 AND event_type = 'settlement.batch_closed'
		 ORDER BY id DESC LIMIT 1
	`, closed.BatchID).Scan(&raw)
	if err != nil {
		t.Fatalf("read latest batch event: %v", err)
	}
	var payload struct {
		FeeFils       int64 `json:"feeFils"`
		NetPayoutFils int64 `json:"netPayoutFils"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.FeeFils != 300 || payload.NetPayoutFils != 9_700 {
		t.Errorf("latest batch event fee %d net %d, want fee 300 net 9700", payload.FeeFils, payload.NetPayoutFils)
	}
}
