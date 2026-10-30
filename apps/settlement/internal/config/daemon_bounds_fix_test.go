package config

import (
	"strings"
	"testing"
)

// G10: a poll interval of 0 (or less) panics in time.NewTicker, and a run
// delay of 1440 minutes or more is never reached inside a day, so no day is
// ever closed. Load must reject both with a clear error.
func TestLoad_RejectsBadDaemonTiming_Fix(t *testing.T) {
	cases := []struct {
		name, poll, delay, wantInErr string
	}{
		{"poll zero", "0", "15", "SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS"},
		{"poll negative", "-5", "15", "SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS"},
		{"delay one day", "60", "1440", "SETTLEMENT_DAEMON_RUN_DELAY_MINUTES"},
		{"delay negative", "60", "-1", "SETTLEMENT_DAEMON_RUN_DELAY_MINUTES"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withEnv(t, map[string]string{
				"DATABASE_URL": "postgres://a/db",
				"SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS": c.poll,
				"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES":     c.delay,
			})
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), c.wantInErr) {
				t.Fatalf("Load() err = %v, want an error naming %s", err, c.wantInErr)
			}
		})
	}
}

func TestLoad_AcceptsDaemonTimingBounds_Fix(t *testing.T) {
	withEnv(t, map[string]string{
		"DATABASE_URL": "postgres://a/db",
		"SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS": "1",
		"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES":     "1439",
	})
	if _, err := Load(); err != nil {
		t.Fatalf("Load() err = %v, want nil", err)
	}
	withEnv(t, map[string]string{"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES": "0"})
	if _, err := Load(); err != nil {
		t.Fatalf("Load() with delay 0: err = %v, want nil", err)
	}
}
