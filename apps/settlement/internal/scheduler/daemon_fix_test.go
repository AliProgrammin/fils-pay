package scheduler

import (
	"testing"
	"time"
)

// The close must run runDelay minutes after Bahrain midnight (UTC+3), not
// after UTC midnight (03:00 Bahrain).
func TestDueBusinessDate_BahrainMidnight_Fix(t *testing.T) {
	const delay = 15
	cases := []struct {
		name     string
		now      time.Time // UTC instant
		wantDue  bool
		wantDate string
	}{
		// 00:10 Bahrain 15 May: inside the grace period, nothing due yet.
		{"before delay", time.Date(2026, 5, 14, 21, 10, 0, 0, time.UTC), false, ""},
		// 00:20 Bahrain 15 May: 14 May just ended, close it now.
		{"after delay", time.Date(2026, 5, 14, 21, 20, 0, 0, time.UTC), true, "2026-05-14"},
		// 02:59 Bahrain 15 May: still 14 May to close, not 13 May.
		{"before UTC midnight", time.Date(2026, 5, 14, 23, 59, 0, 0, time.UTC), true, "2026-05-14"},
		// 12:00 Bahrain 15 May.
		{"midday", time.Date(2026, 5, 15, 9, 0, 0, 0, time.UTC), true, "2026-05-14"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			date, due := dueBusinessDate(c.now, delay)
			if due != c.wantDue {
				t.Fatalf("due = %v, want %v", due, c.wantDue)
			}
			if due && date.Format("2006-01-02") != c.wantDate {
				t.Errorf("business date = %s, want %s", date.Format("2006-01-02"), c.wantDate)
			}
		})
	}
}
