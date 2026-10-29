package internalapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// FP-203: the admin "Rebuild cached balances" button must rebuild from
// ledger_entries (HANDOVER, Balances), not from scheme_export_lines.
func TestRebuildBalances_ReadsLedgerNotSchemeExport_Fix(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool)
	occurredAt := time.Date(2026, 4, 13, 9, 0, 0, 0, time.UTC)
	txnID := insertCaptureEvent(t, pool, merchantID, 12000, occurredAt)

	// Fee leg: the ledger says the merchant is owed 12000 - 300 = 11700.
	_, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'merchant_payable', 'debit',  300, $4, 'fee'),
		  ($1, $2, $3, 'platform_fee_revenue', 'credit', 300, $4, 'fee')
	`, uuid.New(), merchantID, txnID, occurredAt)
	if err != nil {
		t.Fatalf("seed fee legs: %v", err)
	}

	// The scheme export shows the gross 12000, which is not what the merchant is owed.
	var batchID uuid.UUID
	err = pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, '2026-04-13', 'closed', 12000, 300, 11700, now()) RETURNING id
	`, merchantID).Scan(&batchID)
	if err != nil {
		t.Fatalf("seed batch: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, line_sequence)
		VALUES ($1, $2, 12000, 1)
	`, batchID, txnID)
	if err != nil {
		t.Fatalf("seed export line: %v", err)
	}

	resp := post(t, server, "/internal/rebuild-balances", "Bearer "+testToken, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var diffs map[string]rebuildDiffResponse
	decodeJSON(t, resp, &diffs)
	if got := diffs[merchantID.String()].After; got != 11700 {
		t.Errorf("after = %d, want 11700 (ledger merchant_payable balance)", got)
	}
}
