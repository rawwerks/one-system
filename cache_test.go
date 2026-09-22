package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const cacheTestBody = `{"model":"routing-demo","state":{"user_id":"acct-17","email":"alice@example.test","revision":9007199254740992},"questions":{"q":{"type":"noul","instructions":"Is this positive?"}}}`

type cacheTestUpstreams struct {
	selector   *httptest.Server
	leaf       *httptest.Server
	selections atomic.Int32
	leafCalls  atomic.Int32
}

func newCacheTestUpstreams(t *testing.T, selectorHandler, leafHandler http.HandlerFunc) *cacheTestUpstreams {
	t.Helper()
	u := &cacheTestUpstreams{}
	if selectorHandler == nil {
		selectorHandler = cacheTestWriteSelection
	}
	if leafHandler == nil {
		leafHandler = func(w http.ResponseWriter, req *http.Request) {
			cacheTestWriteLeaf(w, req, 0.9)
		}
	}
	u.selector = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		u.selections.Add(1)
		selectorHandler(w, req)
	}))
	t.Cleanup(u.selector.Close)
	u.leaf = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		u.leafCalls.Add(1)
		leafHandler(w, req)
	}))
	t.Cleanup(u.leaf.Close)
	return u
}

func cacheTestWriteSelection(w http.ResponseWriter, req *http.Request) {
	var request struct {
		Questions map[string]struct {
			Criteria map[string]json.RawMessage
		}
	}
	if err := json.NewDecoder(req.Body).Decode(&request); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	probabilities := make(map[string]float64)
	for id := range request.Questions["backend"].Criteria {
		probabilities[id] = 0
	}
	probabilities["local"] = 1
	_ = json.NewEncoder(w).Encode(map[string]any{
		"model": "selector",
		"answers": map[string]any{"backend": map[string]any{
			"type": "choice", "choice": "local", "confidence": 1,
			"probabilities": probabilities,
		}},
		"usage": map[string]int{"input_tokens": 2, "output_tokens": 1},
	})
}

func cacheTestWriteLeaf(w http.ResponseWriter, req *http.Request, probability float64) {
	var request struct {
		Model     string
		Questions map[string]json.RawMessage
	}
	if err := json.NewDecoder(req.Body).Decode(&request); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	answers := make(map[string]any, len(request.Questions))
	for id := range request.Questions {
		answers[id] = map[string]any{"type": "noul", "noul": probability}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"model": request.Model, "answers": answers,
		"usage": map[string]int{"input_tokens": 5, "output_tokens": 3},
	})
}

func (u *cacheTestUpstreams) config(t *testing.T) config {
	t.Helper()
	return config{
		name: "routing-demo", publicKey: "test-key", selector: "hosted",
		backends: map[string]backend{
			"local":  {ID: "local", BaseURL: u.leaf.URL, Model: "leaf", Description: "local", key: "leaf-key"},
			"hosted": {ID: "hosted", BaseURL: u.selector.URL, Model: "selector", Description: "hosted", key: "selector-key"},
		},
		cache: cacheSettings{
			Path: filepath.Join(t.TempDir(), "private", "decisions.sqlite"), Mode: "readwrite",
			Namespace: "cache-test", Epoch: "epoch-1", TTL: time.Hour, MaxBytes: 1 << 20,
		},
	}
}

func (u *cacheTestUpstreams) assertCalls(t *testing.T, selections, leafCalls int32) {
	t.Helper()
	if gotSelections, gotLeafCalls := u.selections.Load(), u.leafCalls.Load(); gotSelections != selections || gotLeafCalls != leafCalls {
		t.Fatalf("upstream calls: selector=%d leaf=%d; want selector=%d leaf=%d", gotSelections, gotLeafCalls, selections, leafCalls)
	}
}

func newCacheTestRouter(t *testing.T, c config) (*router, func()) {
	t.Helper()
	r, err := newRouter(c, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	closeRouter := func() {
		once.Do(func() {
			if err := r.Close(); err != nil {
				t.Errorf("closing router: %v", err)
			}
		})
	}
	t.Cleanup(closeRouter)
	return r, closeRouter
}

func cacheTestRequest(body, mode string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-key")
	if mode != "" {
		req.Header.Set("X-One-System-Cache", mode)
	}
	return req
}

func cacheTestServe(r *router, req *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	r.ServeHTTP(response, req)
	return response
}

func cacheTestAssertResponse(t *testing.T, response *httptest.ResponseRecorder, status int, cacheStatus string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status=%d, want=%d: %s", response.Code, status, response.Body.String())
	}
	if cacheStatus != "" && response.Header().Get("X-One-System-Cache") != cacheStatus {
		t.Fatalf("cache status=%q, want=%q: %s", response.Header().Get("X-One-System-Cache"), cacheStatus, response.Body.String())
	}
}

type cacheTestResponse struct {
	Model   string
	Answers map[string]any
	Usage   tokenUsage
}

func cacheTestDecode(t *testing.T, response *httptest.ResponseRecorder) cacheTestResponse {
	t.Helper()
	var result cacheTestResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decoding response: %v: %s", err, response.Body.String())
	}
	return result
}

func cacheTestAssertHit(t *testing.T, response *httptest.ResponseRecorder, original cacheTestResponse) {
	t.Helper()
	cacheTestAssertResponse(t, response, http.StatusOK, "hit")
	hit := cacheTestDecode(t, response)
	if hit.Model != original.Model || !reflect.DeepEqual(hit.Answers, original.Answers) {
		t.Fatalf("cached decision changed: got=%+v original=%+v", hit, original)
	}
	if hit.Usage.Input != 0 || hit.Usage.Output != 0 {
		t.Fatalf("cache hit charged inference usage: %+v", hit.Usage)
	}
}

func cacheTestAssertError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	cacheTestAssertResponse(t, response, status, "")
	var result struct {
		Detail  []struct{ Type string }
		Answers json.RawMessage
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Detail) != 1 || result.Detail[0].Type != code || len(result.Answers) != 0 {
		t.Fatalf("expected %q error without cached answers: %s", code, response.Body.String())
	}
	if response.Header().Get("X-One-System-Cache") == "hit" {
		t.Fatal("rejected request reported a cache hit")
	}
}

func TestDecisionCacheHitPreservesDecisionAndValidation(t *testing.T) {
	u := newCacheTestUpstreams(t, nil, nil)
	r, _ := newCacheTestRouter(t, u.config(t))
	first := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
	cacheTestAssertResponse(t, first, http.StatusOK, "miss")
	original := cacheTestDecode(t, first)
	if original.Model != "leaf" || !reflect.DeepEqual(original.Answers, map[string]any{"q": map[string]any{"type": "noul", "noul": 0.9}}) || original.Usage.Input != 7 || original.Usage.Output != 4 {
		t.Fatalf("unexpected live decision: %+v", original)
	}
	cacheTestAssertHit(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "")), original)

	unauthorized := cacheTestRequest(cacheTestBody, "replay")
	unauthorized.Header.Set("Authorization", "Bearer wrong-key")
	cacheTestAssertError(t, cacheTestServe(r, unauthorized), http.StatusUnauthorized, "unauthorized")
	invalid := strings.Replace(cacheTestBody, `"type":"noul"`, `"type":"unknown"`, 1)
	cacheTestAssertError(t, cacheTestServe(r, cacheTestRequest(invalid, "replay")), http.StatusUnprocessableEntity, "schema_validation")
	unsupported := strings.Replace(cacheTestBody, `"model":"routing-demo"`, `"model":"leaf"`, 1)
	cacheTestAssertError(t, cacheTestServe(r, cacheTestRequest(unsupported, "replay")), http.StatusUnprocessableEntity, "unsupported_model")
	u.assertCalls(t, 1, 1)
}

func TestDecisionCacheUsesExactRequestBytes(t *testing.T) {
	u := newCacheTestUpstreams(t, nil, nil)
	r, _ := newCacheTestRouter(t, u.config(t))
	cacheTestAssertResponse(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "")), http.StatusOK, "miss")
	for i, tc := range []struct {
		name string
		body string
	}{
		{"question instructions", strings.Replace(cacheTestBody, "Is this positive?", "Is this negative?", 1)},
		{"question ID", strings.Replace(cacheTestBody, `"q":`, `"other-question":`, 1)},
		{"opaque user ID", strings.Replace(cacheTestBody, "acct-17", "acct-18", 1)},
		{"email", strings.Replace(cacheTestBody, "alice@example.test", "bob@example.test", 1)},
		{"adjacent large integer", strings.Replace(cacheTestBody, "9007199254740992", "9007199254740993", 1)},
		{"only whitespace", " " + cacheTestBody + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first := cacheTestServe(r, cacheTestRequest(tc.body, ""))
			cacheTestAssertResponse(t, first, http.StatusOK, "miss")
			cacheTestAssertHit(t, cacheTestServe(r, cacheTestRequest(tc.body, "")), cacheTestDecode(t, first))
			u.assertCalls(t, int32(i+2), int32(i+2))
		})
	}
}

func TestDecisionCacheNeverStoresUpstreamFailures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		selector bool
		status   int
		body     string
		wantCode int
	}{
		{"selector rejection", true, http.StatusServiceUnavailable, `{"detail":[]}`, http.StatusServiceUnavailable},
		{"leaf rejection", false, http.StatusTooManyRequests, `{"detail":[]}`, http.StatusTooManyRequests},
		{"invalid answer schema", false, http.StatusOK, `{"model":"leaf","answers":{"q":{"type":"noul","noul":"invalid"}},"usage":{"input_tokens":5,"output_tokens":3}}`, http.StatusBadGateway},
		{"mismatched answer ID", false, http.StatusOK, `{"model":"leaf","answers":{"other":{"type":"noul","noul":0.9}},"usage":{"input_tokens":5,"output_tokens":3}}`, http.StatusBadGateway},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var failing atomic.Bool
			failing.Store(true)
			handler := func(w http.ResponseWriter, req *http.Request) {
				if failing.Load() {
					w.WriteHeader(tc.status)
					_, _ = io.WriteString(w, tc.body)
					return
				}
				if tc.selector {
					cacheTestWriteSelection(w, req)
				} else {
					cacheTestWriteLeaf(w, req, 0.9)
				}
			}
			var selectorHandler, leafHandler http.HandlerFunc
			if tc.selector {
				selectorHandler = handler
			} else {
				leafHandler = handler
			}
			u := newCacheTestUpstreams(t, selectorHandler, leafHandler)
			r, _ := newCacheTestRouter(t, u.config(t))
			for range 2 {
				cacheTestAssertResponse(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "")), tc.wantCode, "")
			}
			if tc.selector {
				u.assertCalls(t, 2, 0)
			} else {
				u.assertCalls(t, 2, 2)
			}
			cacheTestAssertError(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "replay")), http.StatusNotFound, "cache_miss")
			failing.Store(false)
			first := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
			cacheTestAssertResponse(t, first, http.StatusOK, "miss")
			cacheTestAssertHit(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "")), cacheTestDecode(t, first))
			if tc.selector {
				u.assertCalls(t, 3, 1)
			} else {
				u.assertCalls(t, 3, 3)
			}
		})
	}
}

func TestDecisionCacheReplaySurvivesReopenAndNeverInfersOnMiss(t *testing.T) {
	u := newCacheTestUpstreams(t, nil, nil)
	c := u.config(t)
	r, closeRouter := newCacheTestRouter(t, c)
	cacheTestAssertError(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "replay")), http.StatusNotFound, "cache_miss")
	u.assertCalls(t, 0, 0)
	first := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
	cacheTestAssertResponse(t, first, http.StatusOK, "miss")
	original := cacheTestDecode(t, first)
	cacheTestAssertHit(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "replay")), original)
	closeRouter()

	c.cache.Mode = "replay"
	reopened, _ := newCacheTestRouter(t, c)
	cacheTestAssertHit(t, cacheTestServe(reopened, cacheTestRequest(cacheTestBody, "")), original)
	unseen := strings.Replace(cacheTestBody, "acct-17", "unseen-account", 1)
	cacheTestAssertError(t, cacheTestServe(reopened, cacheTestRequest(unseen, "")), http.StatusNotFound, "cache_miss")
	cacheTestAssertResponse(t, cacheTestServe(reopened, cacheTestRequest(cacheTestBody, "bypass")), http.StatusUnprocessableEntity, "")
	u.assertCalls(t, 1, 1)
}

func TestDecisionCacheBypassNeitherReadsNorWrites(t *testing.T) {
	var probability atomic.Int32
	probability.Store(1)
	u := newCacheTestUpstreams(t, nil, func(w http.ResponseWriter, req *http.Request) {
		cacheTestWriteLeaf(w, req, float64(probability.Load())/10)
	})
	r, _ := newCacheTestRouter(t, u.config(t))
	first := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
	cacheTestAssertResponse(t, first, http.StatusOK, "miss")
	original := cacheTestDecode(t, first)
	probability.Store(8)
	bypassed := cacheTestServe(r, cacheTestRequest(cacheTestBody, "bypass"))
	cacheTestAssertResponse(t, bypassed, http.StatusOK, "bypass")
	live := cacheTestDecode(t, bypassed)
	if reflect.DeepEqual(live.Answers, original.Answers) || live.Usage.Input != 7 || live.Usage.Output != 4 {
		t.Fatalf("bypass did not return the new live decision: %+v", live)
	}
	cacheTestAssertHit(t, cacheTestServe(r, cacheTestRequest(cacheTestBody, "")), original)
	u.assertCalls(t, 2, 2)

	unseen := strings.Replace(cacheTestBody, "acct-17", "bypassed-account", 1)
	cacheTestAssertResponse(t, cacheTestServe(r, cacheTestRequest(unseen, "bypass")), http.StatusOK, "bypass")
	cacheTestAssertError(t, cacheTestServe(r, cacheTestRequest(unseen, "replay")), http.StatusNotFound, "cache_miss")
	u.assertCalls(t, 3, 3)
	cacheTestAssertResponse(t, cacheTestServe(r, cacheTestRequest(unseen, "")), http.StatusOK, "miss")
	u.assertCalls(t, 4, 4)
}

func TestDecisionCachePartitionsConfigurationIdentity(t *testing.T) {
	u := newCacheTestUpstreams(t, nil, nil)
	base := u.config(t)
	alternate := base.backends["hosted"]
	alternate.ID = "alternate"
	base.backends["alternate"] = alternate
	r, closeRouter := newCacheTestRouter(t, base)
	first := cacheTestServe(r, cacheTestRequest(cacheTestBody, ""))
	cacheTestAssertResponse(t, first, http.StatusOK, "miss")
	original := cacheTestDecode(t, first)
	closeRouter()

	for i, tc := range []struct {
		name   string
		change func(*config)
	}{
		{"epoch", func(c *config) { c.cache.Epoch = "epoch-2" }},
		{"namespace", func(c *config) { c.cache.Namespace = "another-scope" }},
		{"public credential", func(c *config) { c.publicKey = "rotated-public-key" }},
		{"selector", func(c *config) { c.selector = "alternate" }},
		{"backend model", func(c *config) { b := c.backends["local"]; b.Model = "leaf-v2"; c.backends["local"] = b }},
		{"backend URL", func(c *config) { b := c.backends["local"]; b.BaseURL += "/alternate"; c.backends["local"] = b }},
		{"backend credential", func(c *config) { b := c.backends["local"]; b.key = "rotated-leaf-key"; c.backends["local"] = b }},
		{"registry description", func(c *config) {
			b := c.backends["local"]
			b.Description = "changed routing criteria"
			c.backends["local"] = b
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := base
			c.backends = make(map[string]backend, len(base.backends))
			for id, b := range base.backends {
				c.backends[id] = b
			}
			tc.change(&c)
			r, closeRouter := newCacheTestRouter(t, c)
			request := cacheTestRequest(cacheTestBody, "")
			request.Header.Set("Authorization", "Bearer "+c.publicKey)
			first := cacheTestServe(r, request)
			cacheTestAssertResponse(t, first, http.StatusOK, "miss")
			repeat := cacheTestRequest(cacheTestBody, "replay")
			repeat.Header.Set("Authorization", "Bearer "+c.publicKey)
			cacheTestAssertHit(t, cacheTestServe(r, repeat), cacheTestDecode(t, first))
			u.assertCalls(t, int32(i+2), int32(i+2))
			closeRouter()
		})
	}
	base.cache.Mode = "replay"
	reopened, _ := newCacheTestRouter(t, base)
	cacheTestAssertHit(t, cacheTestServe(reopened, cacheTestRequest(cacheTestBody, "")), original)
	u.assertCalls(t, 9, 9)
}

type cacheTestReadSignal struct {
	io.Reader
	read chan struct{}
	once sync.Once
}

func (r *cacheTestReadSignal) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err == io.EOF {
		r.once.Do(func() { close(r.read) })
	}
	return n, err
}

func cacheTestAwait[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case result := <-ch:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for cache request")
		var zero T
		return zero
	}
}

func TestDecisionCacheCoalescesRequestsAndReleasesCanceledWaiter(t *testing.T) {
	selectionEntered := make(chan struct{})
	releaseSelection := make(chan struct{})
	var entered, release sync.Once
	defer release.Do(func() { close(releaseSelection) })
	u := newCacheTestUpstreams(t, func(w http.ResponseWriter, req *http.Request) {
		entered.Do(func() { close(selectionEntered) })
		<-releaseSelection
		cacheTestWriteSelection(w, req)
	}, nil)
	r, _ := newCacheTestRouter(t, u.config(t))
	leader := make(chan *httptest.ResponseRecorder, 1)
	go func() { leader <- cacheTestServe(r, cacheTestRequest(cacheTestBody, "")) }()
	cacheTestAwait(t, selectionEntered)

	// All followers enter while the leader is held inside upstream inference.
	const followers = 4
	responses := make(chan *httptest.ResponseRecorder, followers)
	for range followers {
		body := &cacheTestReadSignal{Reader: strings.NewReader(cacheTestBody), read: make(chan struct{})}
		req := cacheTestRequest(cacheTestBody, "")
		req.Body = io.NopCloser(body)
		go func() { responses <- cacheTestServe(r, req) }()
		cacheTestAwait(t, body.read)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body := &cacheTestReadSignal{Reader: strings.NewReader(cacheTestBody), read: make(chan struct{})}
	req := cacheTestRequest(cacheTestBody, "").WithContext(ctx)
	req.Body = io.NopCloser(body)
	canceled := make(chan *httptest.ResponseRecorder, 1)
	go func() { canceled <- cacheTestServe(r, req) }()
	cacheTestAwait(t, body.read)
	cancel()
	cacheTestAwait(t, canceled)

	// A canceled follower must return without canceling or waiting for the leader.
	release.Do(func() { close(releaseSelection) })
	first := cacheTestAwait(t, leader)
	cacheTestAssertResponse(t, first, http.StatusOK, "miss")
	original := cacheTestDecode(t, first)
	for range followers {
		cacheTestAssertHit(t, cacheTestAwait(t, responses), original)
	}
	u.assertCalls(t, 1, 1)
}
