package settlement

import (
	"context"
	"testing"
	"time"
)

// Two rows with the same effective_from: the later-entered one (newest
// created_at) wins, same as apps/api feeSchedule.ts.
func TestEffectiveMdrBpsAt_SameEffectiveFromNewestCreatedWins_Fix(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	effective := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

	// Insert the correction first so heap order does not hide the bug.
	for _, row := range []struct {
		bps     int64
		created time.Time
	}{
		{225, time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)}, // same-day correction, entered later
		{245, time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)},
	} {
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES ($1, $2, $3, $4)
		`, merchantID, row.bps, effective, row.created); err != nil {
			t.Fatalf("insert schedule: %v", err)
		}
	}

	got := EffectiveMdrBpsAt(loadSchedules(t, pool, merchantID), effective.Add(time.Hour), 250)
	if got != 225 {
		t.Errorf("EffectiveMdrBpsAt = %d, want 225 (newest created_at on the same effective_from)", got)
	}
}
