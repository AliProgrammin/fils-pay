package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// ADR-0002: CloseBatch must journal gross - amount_fils per line:
// credit card_scheme_clearing, debit scheme_rounding_residue.
func TestCloseBatch_JournalsSchemeRoundingResidue_Fix(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 26, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	// Residues: 4747 -> 7, 1239 -> 9, 4740 -> 0 (no group for a zero residue).
	for i, amount := range []money.Fils{4747, 1239, 4740} {
		insertCaptureEvent(t, pool, merchantID, mdrBps, amount, start.Add(time.Duration(i+1)*time.Hour))
	}

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var residueDebits, clearingCredits int64
	var groups int
	err = pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'scheme_rounding_residue' AND direction = 'debit'), 0),
		       COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'card_scheme_clearing' AND direction = 'credit'), 0),
		       COUNT(DISTINCT entry_group_id)
		  FROM ledger_entries
		 WHERE settlement_batch_id = $1 AND merchant_id = $2
	`, result.BatchID, merchantID).Scan(&residueDebits, &clearingCredits, &groups)
	if err != nil {
		t.Fatalf("query residue legs: %v", err)
	}
	if residueDebits != 16 || clearingCredits != 16 {
		t.Errorf("residue debit = %d, clearing credit = %d, want 16 and 16", residueDebits, clearingCredits)
	}
	if groups != 2 {
		t.Errorf("residue entry groups = %d, want 2 (one per line with a non-zero residue)", groups)
	}

	// The ledger now ties to the scheme file: gross - residue = exported.
	var exported int64
	if err := pool.QueryRow(context.Background(), `
		SELECT SUM(amount_fils) FROM scheme_export_lines WHERE settlement_batch_id = $1`, result.BatchID).Scan(&exported); err != nil {
		t.Fatalf("sum export: %v", err)
	}
	if int64(result.GrossFils)-residueDebits != exported {
		t.Errorf("gross %d - residue %d != exported %d", result.GrossFils, residueDebits, exported)
	}
}
