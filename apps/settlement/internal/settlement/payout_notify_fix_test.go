package settlement

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Incident 2026-08-21: the daemon tick and a manual `run-batch` ran
// EnqueuePayoutNotifications at the same time; both passed the NOT EXISTS
// check and both inserted settlement.paid, so the merchant got two payout
// notifications. Concurrent scans must enqueue exactly one event per batch.
func TestEnqueuePayoutNotificationsConcurrentScansEnqueueOnce(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	base := time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC)
	var batches []uuid.UUID
	for i := 0; i < 5; i++ {
		batches = append(batches, insertBatch(t, pool, merchantID, base.AddDate(0, 0, i), "paid", 10_000+int64(i)))
	}

	const scanners = 8
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, scanners)
	for i := 0; i < scanners; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
				errs <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("EnqueuePayoutNotifications: %v", err)
	}

	for _, b := range batches {
		if got := countPaidEvents(t, pool, b); got != 1 {
			t.Fatalf("batch %s: expected exactly 1 settlement.paid event, got %d", b, got)
		}
	}
}
