package internalapi

import (
	"net/http"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/settlement"
)

// G2: closing today (or a future day) would settle a day that is still
// taking captures. The internal API must refuse it.
func TestRunBatch_RejectsTodayAndFuture_Fix(t *testing.T) {
	server := newTestServer(t, nil)
	today := settlement.InBusinessDayLocation(time.Now())
	for _, d := range []time.Time{today, today.AddDate(0, 0, 1)} {
		body := `{"date":"` + d.Format("2006-01-02") + `"}`
		resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("date %s: status = %d, want 400", d.Format("2006-01-02"), resp.StatusCode)
			continue
		}
		var e errorResponse
		decodeJSON(t, resp, &e)
		if e.Error != "business_date_not_closed" {
			t.Errorf("date %s: error = %q, want business_date_not_closed", d.Format("2006-01-02"), e.Error)
		}
	}
}
