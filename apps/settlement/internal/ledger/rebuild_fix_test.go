package ledger

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func cachedBalance(t *testing.T, merchantID uuid.UUID) int64 {
	t.Helper()
	pool := mustPool(t)
	var v int64
	if err := pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&v); err != nil {
		t.Fatalf("read cache: %v", err)
	}
	return v
}

// `rebuild-balances --merchant=X` calls RebuildMerchantBalance. It must
// write the rebuilt figure to the cache, not only read it.
func TestRebuildMerchantBalance_WritesCache_Fix(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)
	postLedgerLeg(t, pool, merchantID, "credit", 20000)
	postLedgerLeg(t, pool, merchantID, "debit", 500)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, 999999)`, merchantID); err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	got, err := RebuildMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if got != 19500 {
		t.Errorf("RebuildMerchantBalance = %d, want 19500", got)
	}
	if cached := cachedBalance(t, merchantID); cached != 19500 {
		t.Errorf("cached_payable_fils = %d, want 19500 (the rebuild must write)", cached)
	}
}

// A payout commits its merchant_payable debit and cache delta while a full
// rebuild is running. The rebuild must lock the cache row before it reads
// the ledger, so the final cache equals the ledger.
func TestRebuildAllBalances_ConcurrentPayoutNotClobbered_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	postLedgerLeg(t, pool, merchantID, "credit", 10000)
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, 10000)`, merchantID); err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	// Payout transaction, the same writes PayoutBatch makes, left open.
	payout, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin payout: %v", err)
	}
	defer payout.Rollback(ctx) //nolint:errcheck
	if _, err := payout.Exec(ctx, `
		UPDATE merchant_balances SET cached_payable_fils = cached_payable_fils - 4000 WHERE merchant_id = $1`, merchantID); err != nil {
		t.Fatalf("payout cache delta: %v", err)
	}
	if _, err := payout.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'merchant_payable', 'debit', 4000, now(), 'payout'),
		       ($1, $2, 'platform_cash', 'credit', 4000, now(), 'payout')`, uuid.New(), merchantID); err != nil {
		t.Fatalf("payout legs: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := RebuildAllBalances(ctx, pool)
		done <- err
	}()
	time.Sleep(300 * time.Millisecond) // let the rebuild reach the payout's row lock
	if err := payout.Commit(ctx); err != nil {
		t.Fatalf("commit payout: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("RebuildAllBalances: %v", err)
	}

	if cached := cachedBalance(t, merchantID); cached != 6000 {
		t.Errorf("cached_payable_fils = %d, want 6000 (ledger 10000 - 4000 payout)", cached)
	}
}
