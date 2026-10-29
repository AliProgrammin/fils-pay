package splits

import "github.com/filspay/settlement/internal/money"

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights with
// the largest-remainder method, so the shares always sum to netPayout.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	weights := make([]int64, len(children))
	for i, c := range children {
		weights[i] = c.WeightBps
	}
	return money.AllocateRemainder(netPayout, weights)
}
