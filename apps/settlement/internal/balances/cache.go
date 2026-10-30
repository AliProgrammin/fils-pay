// Package balances maintains merchant_balances, a cache with one meaning:
// the merchant's merchant_payable balance in ledger_entries (credits minus
// debits). ledger_entries stays the only source of truth.
//
// Rule for every writer of merchant_balances:
//   - apps/settlement sets the cache from the ledger (RefreshFromLedger)
//     inside the same transaction, after each step that can post
//     merchant_payable legs (batch close, payout, split payout, MDR
//     recalculation), and the rebuild does the same for every merchant.
//   - apps/api paths that post a merchant_payable leg and touch the cache
//     (manual credits, CSV adjustment import, journaled balance adjustment)
//     add exactly that leg's amount in the same transaction.
//   - capture and refund post merchant_payable legs but do not touch the
//     cache; the merchant's next settlement step (or a rebuild) brings it
//     back to the ledger figure.
//
// So a write either equals the ledger or moves with it by the same amount;
// nothing adds a figure that has no ledger leg behind it.
package balances

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// RefreshFromLedger sets merchantID's cached balance to its ledger
// merchant_payable balance and returns the cached value before and after.
// It locks the cache row BEFORE it reads the ledger: an apps/api writer that
// posts a leg and then adds its delta either finishes first (its leg is then
// seen by the sum) or waits on the lock and adds on top of the fresh figure.
// When batchID is not uuid.Nil it is stored as last_settlement_batch_id.
func RefreshFromLedger(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID) (before, after money.Fils, err error) {
	if _, err = tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 0, now())
		ON CONFLICT (merchant_id) DO NOTHING
	`, merchantID); err != nil {
		return 0, 0, fmt.Errorf("balances: refresh %s: ensure cache row: %w", merchantID, err)
	}

	var cachedBefore int64
	if err = tx.QueryRow(ctx, `
		SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1 FOR UPDATE
	`, merchantID).Scan(&cachedBefore); err != nil {
		return 0, 0, fmt.Errorf("balances: refresh %s: lock cache row: %w", merchantID, err)
	}

	var ledgerPayable int64
	if err = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&ledgerPayable); err != nil {
		return 0, 0, fmt.Errorf("balances: refresh %s: sum ledger: %w", merchantID, err)
	}

	if _, err = tx.Exec(ctx, `
		UPDATE merchant_balances
		   SET cached_payable_fils = $2,
		       last_settlement_batch_id = COALESCE($3, last_settlement_batch_id),
		       updated_at = now()
		 WHERE merchant_id = $1
	`, merchantID, ledgerPayable, nullableID(batchID)); err != nil {
		return 0, 0, fmt.Errorf("balances: refresh %s: write cache: %w", merchantID, err)
	}
	return money.Fils(cachedBefore), money.Fils(ledgerPayable), nil
}

func nullableID(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}
