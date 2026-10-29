package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// The scheme amount must be the truncated amount_fils / 1000, never the
// gross rounded by NUMERIC(10,2). 4747 fils -> amount_fils 4740 -> "4.74".
func TestSchemeExportAmountMatchesTruncatedFils_Fix(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	want := map[string]bool{"4.74": true, "1.23": true, "1.00": true, "12.34": true}
	for i, amount := range []money.Fils{4747, 1239, 1005, 12344} {
		insertCaptureEvent(t, pool, merchantID, mdrBps, amount, start.Add(time.Duration(i+1)*time.Hour))
	}

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	lines, err := LoadSchemeExportLines(context.Background(), pool, result.BatchID)
	if err != nil {
		t.Fatalf("LoadSchemeExportLines: %v", err)
	}
	// Lines are ordered by transaction id, so compare as a set.
	for _, line := range lines {
		if !want[line.Amount] {
			t.Errorf("line %d amount = %q, want one of 4.74, 1.23, 1.00, 12.34", line.LineSequence, line.Amount)
		}
	}

	var mismatched int
	err = pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM scheme_export_lines
		 WHERE settlement_batch_id = $1 AND amount <> amount_fils::numeric / 1000
	`, result.BatchID).Scan(&mismatched)
	if err != nil {
		t.Fatalf("count mismatched: %v", err)
	}
	if mismatched != 0 {
		t.Errorf("%d line(s) have amount <> amount_fils / 1000", mismatched)
	}
}
