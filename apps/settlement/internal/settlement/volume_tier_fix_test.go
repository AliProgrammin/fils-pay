package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// C12: the platform-wide volume-tier discount has no written finance
// sign-off (docs/HANDOVER.md: "I said no until finance signs off in
// writing"). A batch closed after platform volume passes the old
// 2,000,000.000 BD threshold must charge the merchant's full rate.
func TestCloseBatch_PastVolumeThreshold_ChargesFullRate_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2100000000 WHERE id = 1`); err != nil {
		t.Fatalf("seed counter: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE platform_stats SET total_processed_fils = 0 WHERE id = 1`)
	})

	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 21, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	// 250 bps of 10,000 fils = 250 fils. With the unapproved 15 bps bonus it was 235.
	if result.FeeFils != money.Fils(250) {
		t.Errorf("FeeFils = %d, want 250 (full MDR, no unapproved tier discount)", result.FeeFils)
	}
	if got := VolumeTierMdrBonusBps(2_100_000_000); got != 0 {
		t.Errorf("VolumeTierMdrBonusBps past threshold = %d, want 0", got)
	}
}
