package splits

import (
	"context"
	"testing"
)

// G3: a split payout pays each child, so each child needs its own
// disbursement instruction, written in the payout transaction (not by the
// webhook dispatcher, which only runs for merchants with an endpoint).
func TestPayoutSplitBatch_RecordsOneDisbursementPerChild_Fix(t *testing.T) {
	pool := fixPool(t)
	ctx := context.Background()
	_, batchID := seedSplitBatch(t, pool, 1001, []int64{3333, 3333, 3334})

	if _, err := PayoutSplitBatch(ctx, pool, batchID); err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}

	rows, err := pool.Query(ctx, `
		SELECT d.child_merchant_id::text, d.amount_fils, s.allocated_fils, d.disbursement_reference
		  FROM settlement_payout_disbursements d
		  JOIN settlement_batch_splits s
		    ON s.settlement_batch_id = d.settlement_batch_id AND s.child_merchant_id = d.child_merchant_id
		 WHERE d.settlement_batch_id = $1`, batchID)
	if err != nil {
		t.Fatalf("query disbursements: %v", err)
	}
	defer rows.Close()
	n, total := 0, int64(0)
	for rows.Next() {
		var child, ref string
		var amount, allocated int64
		if err := rows.Scan(&child, &amount, &allocated, &ref); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if amount != allocated {
			t.Errorf("child %s disbursement = %d, want its allocation %d", child, amount, allocated)
		}
		if len(ref) < 5 || ref[:5] != "disb_" {
			t.Errorf("child %s reference = %q, want disb_ prefix", child, ref)
		}
		n++
		total += amount
	}
	if n != 3 || total != 1001 {
		t.Errorf("got %d child disbursements totalling %d, want 3 totalling 1001", n, total)
	}
}
