package settlement

import (
	"context"
	"testing"
	"time"
)

// G2: a capture whose occurred_at falls on a day that is already closed
// (it was written late, or the day was closed early) must be settled by the
// next batch, the same way refunds are carried forward.
func TestCloseBatch_LateCaptureIsCarriedForward_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	day1 := time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	start1, end1 := BusinessDayWindow(day1)

	insertCaptureEvent(t, pool, merchantID, mdrBps, 5_000, start1.Add(time.Hour))
	first, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch(day1): %v", err)
	}
	if first.GrossFils != 5_000 {
		t.Fatalf("day1 gross = %d, want 5000", first.GrossFils)
	}

	// Lands after day1 closed, stamped one minute before day1's midnight.
	insertCaptureEvent(t, pool, merchantID, mdrBps, 7_000, end1.Add(-time.Minute))

	second, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch(day2): %v", err)
	}
	if second.GrossFils != 7_000 || second.EventCount != 1 {
		t.Errorf("day2 gross = %d events = %d, want 7000 and 1 (the late day1 capture)", second.GrossFils, second.EventCount)
	}
	unbatched := countRows(t, pool, `
		SELECT count(*) FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1 AND te.settlement_batch_id IS NULL`, merchantID)
	if unbatched != 0 {
		t.Errorf("%d capture event(s) left unbatched, want 0", unbatched)
	}
}

// G2: a business day can only be closed once it has ended in Bahrain.
func TestValidateClosableBusinessDate_Fix(t *testing.T) {
	// 2026-09-01 10:00 Bahrain.
	now := time.Date(2026, 9, 1, 7, 0, 0, 0, time.UTC)
	cases := []struct {
		date    string
		wantErr bool
	}{
		{"2026-08-31", false}, // yesterday: closed
		{"2026-09-01", true},  // today: still open
		{"2026-09-02", true},  // future
	}
	for _, c := range cases {
		d, _ := time.Parse("2006-01-02", c.date)
		err := ValidateClosableBusinessDate(d, now)
		if (err != nil) != c.wantErr {
			t.Errorf("ValidateClosableBusinessDate(%s) err = %v, wantErr %v", c.date, err, c.wantErr)
		}
	}
	// 00:30 Bahrain on 2026-09-02 is still 2026-09-01 in UTC; 2026-09-01 is now closable.
	late := time.Date(2026, 9, 1, 21, 30, 0, 0, time.UTC)
	d, _ := time.Parse("2006-01-02", "2026-09-01")
	if err := ValidateClosableBusinessDate(d, late); err != nil {
		t.Errorf("2026-09-01 at 00:30 Bahrain on 09-02: got %v, want nil", err)
	}
}
