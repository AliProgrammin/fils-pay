package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/ledger"
)

func ledgerPayable(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int64 {
	t.Helper()
	var v int64
	if err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`, merchantID).Scan(&v); err != nil {
		t.Fatalf("ledgerPayable: %v", err)
	}
	return v
}

func cachedPayable(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int64 {
	t.Helper()
	var v int64
	if err := pool.QueryRow(context.Background(), `
		SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&v); err != nil {
		t.Fatalf("cachedPayable: %v", err)
	}
	return v
}

// G4: merchant_balances has one meaning, the ledger's merchant_payable.
// After a rebuild, a normal close and payout must leave the cache equal to
// the ledger. Before the fix the close added net on top of a cache that
// already held it, so the cache stayed high by that day's net for good.
func TestMerchantBalances_MatchLedgerAfterRebuildCloseAndPay_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 27, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))

	if _, err := ledger.RebuildMerchantBalance(ctx, pool, merchantID); err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if got, want := cachedPayable(t, pool, merchantID), ledgerPayable(t, pool, merchantID); got != want {
		t.Errorf("after close: cache = %d, ledger merchant_payable = %d", got, want)
	}

	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if got, want := cachedPayable(t, pool, merchantID), ledgerPayable(t, pool, merchantID); got != want {
		t.Errorf("after payout: cache = %d, ledger merchant_payable = %d", got, want)
	}

}
