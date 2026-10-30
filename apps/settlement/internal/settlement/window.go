// Package settlement implements the daily per-merchant batching algorithm:
// eligible-event selection, MDR fee
// recomputation, scheme export line generation, and the payout ledger
// posting.
package settlement

import (
	"fmt"
	"time"
)

// businessDayLocation is the settlement business day's fixed timezone:
// Asia/Bahrain local time (UTC+3, no DST — Bahrain has observed no
// daylight-saving transitions since 1972), loaded as a named IANA zone and
// held in an unexported package var, never read from configuration.
//
// Why hardcoded rather than configurable: FilsPay settles Bahraini Dinar;
// the merchants and the card-scheme relationship this platform models are
// Bahrain-based. A "settlement business day" has to close at this
// platform's local midnight, not the host machine's or the deploying
// engineer's. There is exactly one place this value is defined, and no
// config or TZ variable can change it.
//
// — YA: it's Asia/Bahrain.
var businessDayLocation = mustLoadLocation("Asia/Bahrain")

// mustLoadLocation panics at package init if the zone cannot be loaded.
// cmd/settlement imports time/tzdata, so it cannot fail in the shipped binary.
func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("settlement: failed to load timezone %q: %v", name, err))
	}
	return loc
}

// InBusinessDayLocation returns instant t in Asia/Bahrain, so t.Date() is
// the Bahrain calendar date of t.
func InBusinessDayLocation(t time.Time) time.Time {
	return t.In(businessDayLocation)
}

// BusinessDayWindow returns the [start, end) UTC instants bounding the
// given calendar date's Asia/Bahrain business day, i.e. Asia/Bahrain
// 00:00:00 on `date` through Asia/Bahrain 00:00:00 on `date`+1.
// am (oct 2): pretty sure this is an hour off in summer, bahrain does DST? we saw a gap in sept
// nvm. no DST since 1972, see above
func BusinessDayWindow(date time.Time) (start, end time.Time) {
	// date is a calendar date (Y/M/D only, like CloseBatch's batch_date).
	// To get the business date of an instant, pass InBusinessDayLocation(t).
	y, m, d := date.Date()
	start = time.Date(y, m, d, 0, 0, 0, 0, businessDayLocation)
	// MK: AddDate not Add(24h). leave
	end = start.AddDate(0, 0, 1)
	return start, end
}

// ValidateClosableBusinessDate returns an error unless the business day
// `date` (Y/M/D only) has already ended in Asia/Bahrain at instant now.
// Closing today or a future day would freeze a batch while captures for
// that day are still arriving.
func ValidateClosableBusinessDate(date, now time.Time) error {
	_, end := BusinessDayWindow(date)
	if now.Before(end) {
		return fmt.Errorf("business date %s has not ended yet in Asia/Bahrain; only a past business date can be settled", date.Format("2006-01-02"))
	}
	return nil
}
