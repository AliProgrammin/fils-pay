package settlement

import (
	"context"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// float32 / REAL is exact only up to 2^24 = 16,777,216 fils (16,777.216 BD).
// The lifetime total must stay exact past that.
func TestUpdateLifetimePayoutMonitoringEstimate_LargeValuesExact_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, net := range []money.Fils{16_777_217, 3, 1_234_567_891} {
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, net); err != nil {
			t.Fatalf("UpdateLifetimePayoutMonitoringEstimate(%d): %v", net, err)
		}
	}

	var got string
	if err := tx.QueryRow(ctx, `
		SELECT lifetime_net_payout_monitoring_estimate::text FROM merchants WHERE id = $1
	`, merchantID).Scan(&got); err != nil {
		t.Fatalf("read back estimate: %v", err)
	}
	if got != "1251345111" {
		t.Fatalf("lifetime estimate = %s, want exactly 1251345111", got)
	}
}
