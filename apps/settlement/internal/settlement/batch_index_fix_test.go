package settlement

import (
	"context"
	"strings"
	"testing"
)

// G9: looking up a batch's events by settlement_batch_id needs an index;
// without one each lookup scans all of transaction_events.
func TestTransactionEventsHasPartialSettlementBatchIndex_Fix(t *testing.T) {
	pool := mustPool(t)
	var def string
	err := pool.QueryRow(context.Background(), `
		SELECT indexdef FROM pg_indexes
		 WHERE tablename = 'transaction_events' AND indexname = 'idx_transaction_events_settlement_batch'`).Scan(&def)
	if err != nil {
		t.Fatalf("index idx_transaction_events_settlement_batch not found: %v", err)
	}
	if !strings.Contains(def, "(settlement_batch_id)") || !strings.Contains(def, "WHERE (settlement_batch_id IS NOT NULL)") {
		t.Errorf("index definition = %q, want a partial index on settlement_batch_id WHERE NOT NULL", def)
	}
}
