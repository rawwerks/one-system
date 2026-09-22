package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestDecisionCacheRejectsCorruptionAndFailsOpenOnlyOnline(t *testing.T) {
	u := newCacheTestUpstreams(t, nil, nil)
	r, _ := newCacheTestRouter(t, u.config(t))
	first := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
	cacheTestAssertResponse(t, first, http.StatusOK, "miss")
	original := cacheTestDecode(t, first)
	// Simulate a damaged on-disk answer, not an upstream inference failure.
	if _, err := r.cache.store.db.ExecContext(context.Background(),
		"UPDATE decisions SET response = ?, response_size = ?", []byte(`{"broken":true}`), len(`{"broken":true}`)); err != nil {
		t.Fatal(err)
	}
	cacheTestAssertError(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "replay")), 503, "cache_unavailable")
	u.assertCalls(t, 1, 1)
	recovered := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
	cacheTestAssertResponse(t, recovered, http.StatusOK, "error")
	u.assertCalls(t, 2, 2)
	cacheTestAssertHit(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "replay")), original)

	if err := r.cache.store.Close(); err != nil {
		t.Fatal(err)
	}
	cacheTestAssertError(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "replay")), 503, "cache_unavailable")
	u.assertCalls(t, 2, 2)
	online := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
	cacheTestAssertResponse(t, online, http.StatusOK, "error")
	if got := cacheTestDecode(t, online).Usage; got.Input == 0 {
		t.Fatalf("online fallback hid actual inference usage: %+v", got)
	}
	u.assertCalls(t, 3, 3)
}

func TestDecisionCacheSkipsResponsesExpandedBeyondReplayLimit(t *testing.T) {
	u := newCacheTestUpstreams(t, nil, func(w http.ResponseWriter, req *http.Request) {
		// Legal upstream JSON is smaller than the transport limit, but '<'
		// expands to six bytes when the gateway serializes the response.
		body := `{"model":"leaf","answers":{"q":{"type":"noul","noul":0.9}},"usage":{"input_tokens":5,"output_tokens":3},"padding":"` + strings.Repeat("<", 2<<20) + `"}`
		_, _ = w.Write([]byte(body))
	})
	c := u.config(t)
	c.cache.MaxBytes = 64 << 20
	r, _ := newCacheTestRouter(t, c)
	first := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
	cacheTestAssertResponse(t, first, http.StatusOK, "miss")
	if usage := cacheTestDecode(t, first).Usage; usage.Input != 7 || usage.Output != 4 {
		t.Fatalf("online response lost inference usage: %+v", usage)
	}
	replay := cacheTestServe(r, cacheTestRequest(cacheTestBody, "replay"))
	cacheTestAssertError(t, replay, http.StatusNotFound, "cache_miss")
	cacheTestAssertResponse(t, replay, http.StatusNotFound, "miss")
	u.assertCalls(t, 1, 1)
}
