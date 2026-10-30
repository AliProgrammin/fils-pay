package settlement

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// insertMerchantWithIDPrefix inserts an active merchant whose id starts with
// the given byte, so a test can control where RunDailyBatch (which walks
// merchants in id order) meets it.
func insertMerchantWithIDPrefix(t *testing.T, pool *pgxpool.Pool, prefix byte, mdrBps int64) uuid.UUID {
	t.Helper()
	id := uuid.New()
	id[0], id[1] = prefix, prefix
	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchants (id, display_name, mdr_bps, status, test_mode)
		VALUES ($1, $2, $3, 'active', false)
	`, id, "run-daily-fix-"+id.String(), mdrBps)
	if err != nil {
		t.Fatalf("insertMerchantWithIDPrefix: %v", err)
	}
	return id
}

// InsertBrokenSplitParent makes a split parent whose child weights sum to
// 5000 bps, so PayoutSplitBatch always fails for it.
func insertBrokenSplitParent(t *testing.T, pool *pgxpool.Pool, prefix byte) uuid.UUID {
	t.Helper()
	parent := insertMerchantWithIDPrefix(t, pool, prefix, 250)
	child := insertActiveMerchant(t, pool, 250)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
		VALUES ($1, $2, 5000)
	`, parent, child)
	if err != nil {
		t.Fatalf("insertBrokenSplitParent: %v", err)
	}
	return parent
}

// G1: one merchant whose payout fails must not stop the pass for the
// merchants after it. The pass still returns an error that names the
// broken merchant.
func TestRunDailyBatch_BrokenMerchantDoesNotBlockLaterMerchants_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	// An old date: the pass walks every merchant, so keep it clear of the
	// seed's business days.
	businessDate := time.Date(2020, 1, 6, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	broken := insertBrokenSplitParent(t, pool, 0x00)
	insertCaptureEvent(t, pool, broken, 250, 10_000, start.Add(time.Hour))
	good := insertMerchantWithIDPrefix(t, pool, 0xff, 250)
	insertCaptureEvent(t, pool, good, 250, 10_000, start.Add(time.Hour))

	report, err := RunDailyBatch(ctx, pool, businessDate, nil)
	if err == nil {
		t.Fatal("RunDailyBatch returned nil error, want an error naming the broken merchant")
	}
	if !strings.Contains(err.Error(), broken.String()) {
		t.Errorf("error %q does not name the broken merchant %s", err, broken)
	}

	var status string
	if err := pool.QueryRow(ctx, `
		SELECT status FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2
	`, good, businessDate).Scan(&status); err != nil {
		t.Fatalf("good merchant has no batch: %v", err)
	}
	if status != "paid" {
		t.Errorf("good merchant batch status = %q, want paid", status)
	}

	found := false
	for _, r := range report.MerchantResults {
		if r.MerchantID == good {
			found = true
		}
		if r.MerchantID == broken {
			t.Errorf("broken merchant must not be reported as processed")
		}
	}
	if !found {
		t.Error("good merchant missing from the report")
	}
}
