package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Decision-cache behavior visible over HTTP is specified for both gateways in
// conformance/cache_test.go. These tests need the router or store internals:
// coalescing, planted corruption, Go's serialized size, stdout logging, and
// the SQLite store's expiry, eviction and file handling.

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

func privateDecisionTestDir(t *testing.T) string {
	t.Helper()
	path := t.TempDir()
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDecisionStorePersistsIndependentResponses(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "private", "decisions.sqlite")
	store, err := openDecisionStore(path, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	body := []byte(`{"answer":true}`)
	if err := store.Put(ctx, "decision", body, 10, 100); err != nil {
		t.Fatal(err)
	}
	body[0] = '!'
	first, err := store.Get(ctx, "decision", 11)
	if err != nil || string(first) != `{"answer":true}` {
		t.Fatalf("stored response=%q, err=%v", first, err)
	}
	first[0] = '!'
	second, err := store.Get(ctx, "decision", 12)
	if err != nil || string(second) != `{"answer":true}` {
		t.Fatalf("response was aliased: %q, err=%v", second, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, "decision", 12); err == nil {
		t.Fatal("read after close succeeded")
	}
	if err := store.Put(ctx, "other", []byte("other"), 12, 100); err == nil {
		t.Fatal("write after close succeeded")
	}
	store, err = openDecisionStore(path, 100)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	persisted, err := store.Get(ctx, "decision", 13)
	if err != nil || string(persisted) != `{"answer":true}` {
		t.Fatalf("reopened response=%q, err=%v", persisted, err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		info, err := os.Stat(path + suffix)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Errorf("file %q has mode %o, want 0600", suffix, info.Mode().Perm())
		}
	}
}

func TestDecisionStoreExpiresWithoutReadRefresh(t *testing.T) {
	ctx := context.Background()
	store, err := openDecisionStore(filepath.Join(privateDecisionTestDir(t), "decisions.sqlite"), 100)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.Put(ctx, "decision", []byte("answer"), 10, 20); err != nil {
		t.Fatal(err)
	}
	for _, now := range []int64{10, 19, 20, 21} {
		body, err := store.Get(ctx, "decision", now)
		if err != nil {
			t.Fatal(err)
		}
		if now < 20 && string(body) != "answer" {
			t.Errorf("at %d got %q, want answer", now, body)
		}
		if now >= 20 && body != nil {
			t.Errorf("at expiry %d got %q, want miss", now, body)
		}
	}
}

func TestDecisionStoreEvictsOldestWithinByteBudget(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(privateDecisionTestDir(t), "decisions.sqlite")
	store, err := openDecisionStore(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if store != nil {
			_ = store.Close()
		}
	})
	put := func(key, body string, now int64) {
		t.Helper()
		if err := store.Put(ctx, key, []byte(body), now, 100); err != nil {
			t.Fatal(err)
		}
	}
	assertEntries := func(want map[string]string) {
		t.Helper()
		total := 0
		for _, key := range []string{"a", "b", "c", "oversized"} {
			body, err := store.Get(ctx, key, 10)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != want[key] {
				t.Errorf("key %s=%q, want %q", key, body, want[key])
			}
			total += len(body)
		}
		if total > 10 {
			t.Errorf("cached %d response bytes, budget is 10", total)
		}
	}
	put("a", "aaaa", 1)
	put("b", "bbbb", 2)
	if _, err := store.Get(ctx, "a", 2); err != nil {
		t.Fatal(err)
	}
	put("c", "cccc", 3)
	assertEntries(map[string]string{"b": "bbbb", "c": "cccc"})
	put("oversized", "01234567890", 4)
	put("b", "01234567890", 4)
	assertEntries(map[string]string{"b": "bbbb", "c": "cccc"})
	put("b", "BBBBBB", 5)
	assertEntries(map[string]string{"b": "BBBBBB", "c": "cccc"})
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = openDecisionStore(path, 6)
	if err != nil {
		t.Fatal(err)
	}
	assertEntries(map[string]string{"b": "BBBBBB"})
}

func TestDecisionStorePrunesExpiredBeforeUsefulEntries(t *testing.T) {
	ctx := context.Background()
	store, err := openDecisionStore(filepath.Join(privateDecisionTestDir(t), "decisions.sqlite"), 8)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.Put(ctx, "useful", []byte("keep"), 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "expired", []byte("gone"), 2, 3); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "new", []byte("next"), 3, 100); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"useful": "keep", "expired": "", "new": "next"} {
		body, err := store.Get(ctx, key, 3)
		if err != nil || string(body) != want {
			t.Errorf("key %s=%q, want %q, err=%v", key, body, want, err)
		}
	}
}

func TestDecisionStoreRejectsUnsupportedVersion(t *testing.T) {
	path := filepath.Join(privateDecisionTestDir(t), "decisions.sqlite")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("PRAGMA user_version = 42"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := openDecisionStore(path, 100)
	if err == nil {
		_ = store.Close()
		t.Fatal("unsupported cache version was accepted")
	}
}

func TestDecisionStoreRejectsUnsafeOrBrokenPaths(t *testing.T) {
	for _, path := range []string{"", ":memory:", "file:cache.sqlite?mode=memory", "cache.sqlite?mode=memory"} {
		store, err := openDecisionStore(path, 100)
		if err == nil {
			_ = store.Close()
			t.Errorf("unsafe path %q was accepted", path)
		}
	}
	parent := t.TempDir()
	if err := os.Chmod(parent, 0755); err != nil {
		t.Fatal(err)
	}
	if store, err := openDecisionStore(filepath.Join(parent, "cache.sqlite"), 100); err == nil {
		_ = store.Close()
		t.Fatal("nonprivate parent directory was accepted")
	}
	info, err := os.Stat(parent)
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("existing parent directory was changed: info=%v, err=%v", info, err)
	}
	broken := filepath.Join(privateDecisionTestDir(t), "broken.sqlite")
	if err := os.WriteFile(broken, []byte("not a SQLite database"), 0600); err != nil {
		t.Fatal(err)
	}
	if store, err := openDecisionStore(broken, 100); err == nil {
		_ = store.Close()
		t.Fatal("corrupt database was accepted")
	}
}
