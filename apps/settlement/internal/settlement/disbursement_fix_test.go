package settlement

import (
	"context"
	"strings"
	"testing"
	"time"
)

// G3: "pay posts payout legs and records disbursement" (ARCHITECTURE.md).
// The disbursement instruction must exist for every paid batch, even for a
// merchant with no webhook endpoint, and a re-run must not add a second one.
func TestPayoutBatch_RecordsDisbursementOnce_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps) // no webhook endpoint
	businessDate := time.Date(2026, 3, 26, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
			t.Fatalf("PayoutBatch #%d: %v", i+1, err)
		}
	}

	var n int
	var amount int64
	var ref string
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(amount_fils), 0), COALESCE(max(disbursement_reference), '')
		  FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`, closed.BatchID).Scan(&n, &amount, &ref); err != nil {
		t.Fatalf("query disbursements: %v", err)
	}
	if n != 1 {
		t.Fatalf("disbursement rows = %d, want 1", n)
	}
	if amount != int64(closed.NetPayoutFils) {
		t.Errorf("disbursement amount = %d, want net payout %d", amount, closed.NetPayoutFils)
	}
	if !strings.HasPrefix(ref, "disb_") {
		t.Errorf("disbursement reference = %q, want disb_ prefix", ref)
	}
}
