package main

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Acceptance must be decided by the running code, not by the absence of a
// ledger entry. Each case plants a valid decision under the exact key of a
// request this configuration rejects; the rejection must still win.
func TestDecisionCacheNeverAnswersRejectedRequest(t *testing.T) {
	for _, tc := range []struct {
		name, model string
	}{
		{"automatic selection", "routing-demo"},
		{"direct backend", "local"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := newCacheTestUpstreams(t, nil, nil)
			c := u.config(t)
			for id, b := range c.backends {
				b.Capabilities = &capabilities{QuestionTypes: []string{"choice"}}
				c.backends[id] = b
			}
			r, _ := newCacheTestRouter(t, c)
			body := strings.Replace(cacheTestBody, `"model":"routing-demo"`, `"model":"`+tc.model+`"`, 1)
			now := time.Now().UnixMilli()
			planted := `{"model":"leaf","answers":{"q":{"type":"noul","noul":0.5}},"usage":{"input_tokens":0,"output_tokens":0}}`
			key := decisionKey(c.cache.Namespace, r.cache.revision, []byte(body))
			if err := r.cache.store.Put(context.Background(), key, []byte(planted), now, now+time.Hour.Milliseconds()); err != nil {
				t.Fatal(err)
			}
			for _, mode := range []string{"", "replay"} {
				cacheTestAssertError(t, cacheTestServe(r, cacheTestRequest(body, mode)), http.StatusUnprocessableEntity, "unsupported_capability")
			}
			u.assertCalls(t, 0, 0)
		})
	}
}

func TestDecisionCacheRejectsUnsupportedSelectorBeforeLookup(t *testing.T) {
	for _, serverMode := range []string{"readwrite", "replay"} {
		for _, unavailable := range []bool{false, true} {
			name := serverMode + "/stored"
			if unavailable {
				name = serverMode + "/unavailable"
			}
			t.Run(name, func(t *testing.T) {
				u := newCacheTestUpstreams(t, nil, nil)
				c := u.config(t)
				c.cache.Mode = serverMode
				selector := c.backends[c.selector]
				selector.Capabilities = &capabilities{QuestionTypes: []string{"noul"}}
				c.backends[c.selector] = selector
				r, _ := newCacheTestRouter(t, c)
				now := time.Now().UnixMilli()
				key := decisionKey(c.cache.Namespace, r.cache.revision, []byte(cacheTestBody))
				planted := `{"model":"leaf","answers":{"q":{"type":"noul","noul":0.5}},"usage":{"input_tokens":0,"output_tokens":0}}`
				if err := r.cache.store.Put(context.Background(), key, []byte(planted), now, now+time.Hour.Milliseconds()); err != nil {
					t.Fatal(err)
				}
				if unavailable {
					if err := r.cache.store.Close(); err != nil {
						t.Fatal(err)
					}
				}
				// Both leaves support the caller's Noul, but the legacy routing
				// question is Choice. Neither a hit nor a failed read may win.
				for _, mode := range []string{"", "replay"} {
					response := cacheTestServe(r, cacheTestRequest(cacheTestBody, mode))
					cacheTestAssertError(t, response, http.StatusUnprocessableEntity, "unsupported_capability")
					if value := response.Header().Get("X-One-System-Cache"); value != "" {
						t.Fatalf("rejected selector reached cache lookup: %q", value)
					}
				}
				u.assertCalls(t, 0, 0)
			})
		}
	}
}

// A hit bypasses the route log, so it must leave its own record: operators
// otherwise see traffic vanish when the cache is enabled.
func TestDecisionCacheHitIsLogged(t *testing.T) {
	u := newCacheTestUpstreams(t, nil, nil)
	var logs bytes.Buffer
	r, err := newRouter(u.config(t), slog.New(slog.NewJSONHandler(&logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close() })
	cacheTestAssertResponse(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "")), http.StatusOK, "miss")
	logs.Reset()
	cacheTestAssertResponse(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "")), http.StatusOK, "hit")
	line := logs.String()
	for _, want := range []string{`"msg":"cache_hit"`, `"latency_ms":`, `"status":200`} {
		if !strings.Contains(line, want) {
			t.Fatalf("hit log %q lacks %s", line, want)
		}
	}
	for _, private := range []string{"acct-17", "alice@example.test", "Is this positive?"} {
		if strings.Contains(line, private) {
			t.Fatalf("hit log discloses request content %q", private)
		}
	}
}

// The shared contract does not know the cache. A router without one must be
// indistinguishable from a host that never had it: cache request headers are
// ignored like any unknown header, and no cache response header is added.
func TestDisabledDecisionCacheIsInvisible(t *testing.T) {
	u := newCacheTestUpstreams(t, nil, nil)
	c := u.config(t)
	c.cache = cacheSettings{}
	r, _ := newCacheTestRouter(t, c)
	if r.cache != nil {
		t.Fatal("cache must be absent without ONE_SYSTEM_CACHE_PATH")
	}
	for i, values := range [][]string{nil, {"replay"}, {"bypass"}, {"unknown-mode"}, {"replay", "bypass"}} {
		request := cacheTestRequest(cacheTestBody, "")
		for _, value := range values {
			request.Header.Add("X-One-System-Cache", value)
		}
		response := cacheTestServe(r, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%v: status=%d, want=200: %s", values, response.Code, response.Body.String())
		}
		if got, present := response.Header()["X-One-System-Cache"]; present {
			t.Fatalf("%v: disabled cache added response header %v", values, got)
		}
		u.assertCalls(t, int32(i+1), int32(i+1))
	}
}
