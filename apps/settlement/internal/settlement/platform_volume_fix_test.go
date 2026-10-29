package settlement

import (
	"context"
	"testing"
)

// The platform volume counter must not overflow at 2,147,483,647 fils
// (INTEGER / int32 max), only 7% above the 2,000,000,000 tier threshold.
func TestRecordPlatformProcessedVolume_PastInt32Max_Fix(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2147000000 WHERE id = 1`); err != nil {
		t.Fatalf("seed counter: %v", err)
	}

	_, err = ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("ReadAndLockPlatformProcessedFils: %v", err)
	}
	if err := RecordPlatformProcessedVolume(ctx, tx, 1_000_000); err != nil {
		t.Fatalf("RecordPlatformProcessedVolume: %v", err)
	}

	var got int64
	if err := tx.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&got); err != nil {
		t.Fatalf("read back total: %v", err)
	}
	if got != 2_148_000_000 {
		t.Fatalf("total_processed_fils = %d, want 2148000000", got)
	}

	after, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if bonus := VolumeTierMdrBonusBps(after); bonus != 15 {
		t.Errorf("tier bonus past int32 max = %d, want 15", bonus)
	}
}
