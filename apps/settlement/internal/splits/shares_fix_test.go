package splits

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// Per-child ApplyRateFils loses or invents fils. Shares must sum to net exactly.
func TestChildShares_SumToNetWithRemainders_Fix(t *testing.T) {
	cases := []struct {
		name       string
		netPayout  money.Fils
		weightsBps []int64
		want       []money.Fils
	}{
		{"100 over thirds", 100, []int64{3333, 3333, 3334}, []money.Fils{33, 33, 34}},
		{"1001 over thirds", 1001, []int64{3333, 3333, 3334}, []money.Fils{334, 333, 334}},
		{"7 over three", 7, []int64{2500, 2500, 5000}, []money.Fils{2, 2, 3}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			shares := ChildShares(tc.netPayout, children)
			var total money.Fils
			for i, s := range shares {
				total += s
				if s != tc.want[i] {
					t.Errorf("share[%d] = %d, want %d", i, s, tc.want[i])
				}
			}
			if total != tc.netPayout {
				t.Errorf("sum of shares %d != net payout %d", total, tc.netPayout)
			}
		})
	}
}

func fixPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func fixMerchant(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO merchants (display_name, mdr_bps, status)
		VALUES ('split-fix', 250, 'active') RETURNING id
	`).Scan(&id)
	if err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	return id
}

func seedSplitBatch(t *testing.T, pool *pgxpool.Pool, netPayout int64, weights []int64) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	parent := fixMerchant(t, pool)
	for _, w := range weights {
		child := fixMerchant(t, pool)
		if _, err := pool.Exec(ctx, `
			INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
			VALUES ($1, $2, $3)`, parent, child, w); err != nil {
			t.Fatalf("insert split child: %v", err)
		}
	}
	// Give the parent a payable balance to pay out from.
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'card_scheme_clearing', 'debit', $3, now(), 'seed'),
		       ($1, $2, 'merchant_payable', 'credit', $3, now(), 'seed')`, uuid.New(), parent, netPayout); err != nil {
		t.Fatalf("seed ledger: %v", err)
	}
	var batchID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, '2026-07-01', 'closed', $2, 0, $2, now()) RETURNING id`, parent, netPayout).Scan(&batchID); err != nil {
		t.Fatalf("insert batch: %v", err)
	}
	return parent, batchID
}

func TestPayoutSplitBatch_PaysExactNet_Fix(t *testing.T) {
	pool := fixPool(t)
	_, batchID := seedSplitBatch(t, pool, 100, []int64{3333, 3333, 3334})

	result, err := PayoutSplitBatch(context.Background(), pool, batchID)
	if err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}
	var total money.Fils
	for _, s := range result.Shares {
		total += s.AllocatedFils
	}
	if total != 100 {
		t.Errorf("shares sum to %d, want 100", total)
	}
	var stored int64
	if err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(allocated_fils), 0) FROM settlement_batch_splits WHERE settlement_batch_id = $1`, batchID).Scan(&stored); err != nil {
		t.Fatalf("sum splits: %v", err)
	}
	if stored != 100 {
		t.Errorf("settlement_batch_splits sum = %d, want 100", stored)
	}
}

func TestPayoutSplitBatch_RejectsWeightsNotSummingTo10000_Fix(t *testing.T) {
	pool := fixPool(t)
	_, batchID := seedSplitBatch(t, pool, 10000, []int64{5000, 4000})

	_, err := PayoutSplitBatch(context.Background(), pool, batchID)
	if err == nil || !strings.Contains(err.Error(), "10000") {
		t.Fatalf("PayoutSplitBatch err = %v, want a weights-sum error", err)
	}
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM settlement_batches WHERE id = $1`, batchID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != "closed" {
		t.Errorf("batch status = %q, want closed (not paid)", status)
	}
}
