package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Net payout must be exact integer gross - fee, never float32 BD math.
func TestNetPayableFils_ExactInteger_Fix(t *testing.T) {
	cases := []struct{ gross, fee, want money.Fils }{
		{10_000, 250, 9_750},
		{20_000_001, 500_000, 19_500_001},
		{123_456_789, 3_086_420, 120_370_369},
		{9_999_999_999, 1, 9_999_999_998},
	}
	for _, c := range cases {
		if got := NetPayableFils(c.gross, c.fee); got != c.want {
			t.Errorf("NetPayableFils(%d, %d) = %d, want %d", c.gross, c.fee, got, c.want)
		}
	}
}
