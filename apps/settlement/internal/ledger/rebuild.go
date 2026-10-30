// Package ledger rebuilds merchant_balances from ledger_entries. Nothing
// automatic calls this — the incremental path is in internal/balances.
// Used by the `rebuild-balances` CLI subcommand and the admin
// "Rebuild cached balances" button.
package ledger

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
	"github.com/filspay/settlement/internal/money"
)

// RebuildMerchantBalance recomputes merchantID's cached balance from
// ledger_entries, writes it to merchant_balances, and returns it. Backs
// `rebuild-balances --merchant=X`.
func RebuildMerchantBalance(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID) (money.Fils, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): begin: %w", merchantID, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	diff, err := rebuildMerchantInTx(ctx, tx, merchantID)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): commit: %w", merchantID, err)
	}
	return diff.Rebuilt, nil
}

// rebuildMerchantInTx sets merchantID's cache to its ledger merchant_payable
// balance (balances.RefreshFromLedger, the same step settlement runs after
// every posting) and reports the before/after figures.
func rebuildMerchantInTx(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID) (RebuildDiff, error) {
	before, after, err := balances.RefreshFromLedger(ctx, tx, merchantID, uuid.Nil)
	if err != nil {
		return RebuildDiff{}, fmt.Errorf("ledger: rebuild: %w", err)
	}
	return RebuildDiff{MerchantID: merchantID, CachedBefore: before, Rebuilt: after}, nil
}

// RebuildDiff is the before/after state for one merchant, printed by the
// rebuild-balances CLI subcommand so an operator sees exactly what
// changed.
//
// Changed reports drift against the ledger: a false result means the cache
// already matched ledger_entries for that merchant.
type RebuildDiff struct {
	MerchantID   uuid.UUID
	CachedBefore money.Fils
	Rebuilt      money.Fils
}

// Changed reports whether the cached value differed from the rebuilt,
// authoritative one.
func (d RebuildDiff) Changed() bool {
	return d.CachedBefore != d.Rebuilt
}

// RebuildAllBalances recomputes every merchant's balance the same way and
// overwrites merchant_balances in one transaction. Returns the full
// before/after map so a caller can print exactly what changed.
func RebuildAllBalances(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Ordered, so concurrent rebuilds take row locks in the same order.
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT merchant_id FROM (
			SELECT merchant_id FROM ledger_entries WHERE account_id = 'merchant_payable'
			UNION
			SELECT merchant_id FROM merchant_balances
		) merchants
		ORDER BY merchant_id
	`)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: select merchant ids: %w", err)
	}

	var merchantIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("ledger: RebuildAllBalances: scan merchant id: %w", err)
		}
		merchantIDs = append(merchantIDs, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: iterate merchant ids: %w", err)
	}
	rows.Close()

	diffs := make(map[uuid.UUID]RebuildDiff, len(merchantIDs))
	for _, merchantID := range merchantIDs {
		diff, err := rebuildMerchantInTx(ctx, tx, merchantID)
		if err != nil {
			return nil, fmt.Errorf("ledger: RebuildAllBalances: %w", err)
		}
		diffs[merchantID] = diff
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: commit: %w", err)
	}

	return diffs, nil
}
