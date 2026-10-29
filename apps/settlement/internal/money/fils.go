// Package money is the Go port of packages/money/src/fils.ts's integer-fils
// arithmetic, matching its rounding exactly. int64 covers
// amount*rateBasisPoints at any realistic scale, so there are no bigint
// intermediates here.
package money

import "fmt"

// Fils is a validated integer number of fils. 1 BD = 1000 fils.
type Fils int64

// ApplyRateFils applies a rate expressed in basis points to an amount, e.g.
// ApplyRateFils(10000, 250) applies a 2.50% MDR to 10.000 BD and returns
// 250. Uses BankersRoundDiv for deterministic half-to-even rounding.
func ApplyRateFils(amount Fils, rateBasisPoints int64) Fils {
	return Fils(BankersRoundDiv(int64(amount)*rateBasisPoints, 10_000))
}

// BankersRoundDiv performs round-half-to-even integer division of
// numerator/denominator, matching packages/money/src/fils.ts's
// bankersRoundDiv's tie-breaking rule exactly, so Go and TypeScript never
// disagree about a shared rounding decision.
func BankersRoundDiv(numerator, denominator int64) int64 {
	if denominator == 0 {
		panic("BankersRoundDiv: denominator must not be zero")
	}
	negative := (numerator < 0) != (denominator < 0)
	absNum, absDen := abs64(numerator), abs64(denominator)
	quotient, remainder := absNum/absDen, absNum%absDen
	twiceRemainder := remainder * 2

	var rounded int64
	switch {
	case twiceRemainder < absDen:
		rounded = quotient
	case twiceRemainder > absDen:
		rounded = quotient + 1
	default: // exact tie: round to even
		if quotient%2 == 0 {
			rounded = quotient
		} else {
			rounded = quotient + 1
		}
	}
	if negative {
		return -rounded
	}
	return rounded
}

func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// String satisfies fmt.Stringer for readable test failure output and log
// lines (fils integer, no unit conversion — never used for money display,
// which has no requirement in apps/settlement).
func (f Fils) String() string {
	return fmt.Sprintf("%dfils", int64(f))
}

// AllocateRemainder splits total into len(weights) integer shares
// proportional to weights, using the largest-remainder method (the Go port
// of packages/money's allocateRemainder). Shares always sum to total
// exactly; leftover fils go to the largest remainders, ties by lower index.
// Weights must be non-negative and not all zero; total must be >= 0.
func AllocateRemainder(total Fils, weights []int64) []Fils {
	var sum int64
	for _, w := range weights {
		if w < 0 {
			panic("AllocateRemainder: weights must be non-negative")
		}
		sum += w
	}
	if sum == 0 {
		panic("AllocateRemainder: weights must not all be zero")
	}
	shares := make([]Fils, len(weights))
	remainders := make([]int64, len(weights))
	leftover := int64(total)
	for i, w := range weights {
		product := int64(total) * w
		shares[i] = Fils(product / sum)
		remainders[i] = product % sum
		leftover -= int64(shares[i])
	}
	for ; leftover > 0; leftover-- {
		best := 0
		for i := range remainders {
			if remainders[i] > remainders[best] {
				best = i
			}
		}
		shares[best]++
		remainders[best] = -1
	}
	return shares
}
