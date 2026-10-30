package settlement

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A shutdown signal (ctx cancelled) during a run must let the merchant
// batch in flight finish and commit, and must not start the next merchant.
func TestRunDailyBatch_ShutdownDrainsInFlightBatch(t *testing.T) {
	pool := mustPool(t)
	bg := context.Background()
	// An old date of its own: the pass walks every merchant.
	businessDate := time.Date(2020, 2, 3, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	first := insertMerchantWithIDPrefix(t, pool, 0x00, 250)
	insertCaptureEvent(t, pool, first, 250, 10_000, start.Add(time.Hour))
	last := insertMerchantWithIDPrefix(t, pool, 0xff, 250)
	insertCaptureEvent(t, pool, last, 250, 10_000, start.Add(time.Hour))

	// Hold first's batch row locked, so the run blocks inside first's
	// CloseBatch transaction: that is "mid-run".
	if _, err := pool.Exec(bg, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status) VALUES ($1, $2, 'open')
	`, first, businessDate); err != nil {
		t.Fatalf("pre-insert batch: %v", err)
	}
	holder, err := pool.Begin(bg)
	if err != nil {
		t.Fatalf("begin holder: %v", err)
	}
	defer holder.Rollback(bg) //nolint:errcheck
	var holderPID int
	if err := holder.QueryRow(bg, `SELECT pg_backend_pid()`).Scan(&holderPID); err != nil {
		t.Fatalf("holder pid: %v", err)
	}
	if _, err := holder.Exec(bg, `
		SELECT 1 FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2 FOR UPDATE
	`, first, businessDate); err != nil {
		t.Fatalf("lock batch row: %v", err)
	}

	// Batches for merchants after first that already exist (earlier runs
	// of this test share the date); the run must not add to them.
	countLater := func() int {
		t.Helper()
		var n int
		if err := pool.QueryRow(bg, `
			SELECT count(*) FROM settlement_batches WHERE batch_date = $1 AND merchant_id::text > $2::text
		`, businessDate, first).Scan(&n); err != nil {
			t.Fatalf("count later batches: %v", err)
		}
		return n
	}
	laterBefore := countLater()

	ctx, sigterm := context.WithCancel(bg)
	defer sigterm()
	type result struct {
		report DailyBatchReport
		err    error
	}
	done := make(chan result, 1)
	go func() {
		report, err := RunDailyBatch(ctx, pool, businessDate, nil)
		done <- result{report, err}
	}()

	// Wait until the run is blocked on first's batch row.
	deadline := time.Now().Add(20 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(bg, `
			SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
		`, holderPID).Scan(&waiting); err != nil {
			t.Fatalf("poll blocked: %v", err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("run never reached first merchant's batch")
		}
		time.Sleep(20 * time.Millisecond)
	}

	sigterm()
	time.Sleep(200 * time.Millisecond) // the signal lands while first's transaction is open
	if err := holder.Rollback(bg); err != nil {
		t.Fatalf("release lock: %v", err)
	}

	var res result
	select {
	case res = <-done:
	case <-time.After(DrainTimeout + 10*time.Second):
		t.Fatal("RunDailyBatch did not return after the shutdown signal")
	}
	if !errors.Is(res.err, context.Canceled) {
		t.Errorf("RunDailyBatch error = %v, want one wrapping context.Canceled (stopped by shutdown)", res.err)
	}

	var status string
	if err := pool.QueryRow(bg, `
		SELECT status FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2
	`, first, businessDate).Scan(&status); err != nil {
		t.Fatalf("read first batch: %v", err)
	}
	if status != "paid" {
		t.Errorf("in-flight batch status = %q, want paid (it must finish and commit)", status)
	}

	if started := countLater() - laterBefore; started != 0 {
		t.Errorf("%d merchant batch(es) started after the shutdown signal, want 0", started)
	}

	for _, r := range res.report.MerchantResults {
		if r.MerchantID == last {
			t.Error("merchant after the signal must not be in the report")
		}
	}
}

// DrainContext must outlive the stop signal, but only by the grace period.
func TestDrainContext_OutlivesStopByGraceOnly(t *testing.T) {
	stop, sigterm := context.WithCancel(context.Background())
	work, cancel := DrainContext(stop, 100*time.Millisecond)
	defer cancel()

	sigterm()
	time.Sleep(20 * time.Millisecond)
	if work.Err() != nil {
		t.Fatal("work context cancelled at once by the stop signal, want it to drain")
	}
	select {
	case <-work.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("work context not cancelled after the grace period")
	}
}
