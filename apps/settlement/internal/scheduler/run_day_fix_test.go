package scheduler

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/settlement"
)

// G1: a merchant that fails its payout must not stop the daemon from
// notifying the merchants that were paid in the same pass.
func TestRunDay_NotifiesPaidMerchantsWhenAnotherMerchantFails_Fix(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	businessDate := time.Date(2020, 1, 7, 0, 0, 0, 0, time.UTC)
	start, _ := settlement.BusinessDayWindow(businessDate)

	merchant := func(prefix byte) uuid.UUID {
		id := uuid.New()
		id[0], id[1] = prefix, prefix
		if _, err := pool.Exec(ctx, `
			INSERT INTO merchants (id, display_name, mdr_bps, status, test_mode)
			VALUES ($1, $2, 250, 'active', false)`, id, "run-day-fix-"+id.String()); err != nil {
			t.Fatalf("insert merchant: %v", err)
		}
		return id
	}
	capture := func(m uuid.UUID) {
		var txn uuid.UUID
		if err := pool.QueryRow(ctx, `
			INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
			VALUES ($1, 'captured', 10000, 10000, $2, $3) RETURNING id`, m, "acq-"+uuid.NewString(), start.Add(time.Hour)).Scan(&txn); err != nil {
			t.Fatalf("insert transaction: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
			VALUES ($1, 'captured', 10000, 'system', $2)`, txn, start.Add(time.Hour)); err != nil {
			t.Fatalf("insert event: %v", err)
		}
	}

	broken := merchant(0x00)
	child := merchant(0x80)
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
		VALUES ($1, $2, 5000)`, broken, child); err != nil {
		t.Fatalf("insert split: %v", err)
	}
	capture(broken)
	good := merchant(0xff)
	capture(good)

	runDay(ctx, pool, businessDate)

	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM outbox_events oe
		  JOIN settlement_batches sb ON sb.id = oe.aggregate_id
		 WHERE oe.event_type = 'settlement.paid' AND sb.merchant_id = $1 AND sb.batch_date = $2`,
		good, businessDate).Scan(&n); err != nil {
		t.Fatalf("query outbox: %v", err)
	}
	if n != 1 {
		t.Errorf("settlement.paid events for the good merchant = %d, want 1", n)
	}
}
