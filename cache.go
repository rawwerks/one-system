package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Bump when routing, adapter semantics, or the cache entry contract changes.
// Mutable remote model aliases additionally require an operator epoch and TTL.
const decisionRevision = "one-system-routing-v2"

type cacheSettings struct {
	Path      string
	Mode      string
	Namespace string
	Epoch     string
	TTL       time.Duration
	MaxBytes  int64
}

func loadCacheSettings() (cacheSettings, error) {
	c := cacheSettings{
		Path:      os.Getenv("ONE_SYSTEM_CACHE_PATH"),
		Mode:      os.Getenv("ONE_SYSTEM_CACHE_MODE"),
		Namespace: envDefault("ONE_SYSTEM_CACHE_NAMESPACE", "default"),
		Epoch:     os.Getenv("ONE_SYSTEM_CACHE_EPOCH"),
		TTL:       time.Hour, MaxBytes: 64 << 20,
	}
	if c.Mode == "" {
		c.Mode = "off"
		if c.Path != "" {
			c.Mode = "readwrite"
		}
	}
	if value := os.Getenv("ONE_SYSTEM_CACHE_TTL"); value != "" {
		duration, err := time.ParseDuration(value)
		if err != nil {
			return c, errors.New("ONE_SYSTEM_CACHE_TTL must be a duration")
		}
		c.TTL = duration
	}
	if value := os.Getenv("ONE_SYSTEM_CACHE_MAX_BYTES"); value != "" {
		size, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return c, errors.New("ONE_SYSTEM_CACHE_MAX_BYTES must be an integer")
		}
		c.MaxBytes = size
	}
	return c, c.validate()
}

func (c cacheSettings) validate() error {
	if c.Mode == "" || c.Mode == "off" {
		return nil
	}
	if c.Mode != "readwrite" && c.Mode != "replay" {
		return errors.New("ONE_SYSTEM_CACHE_MODE must be off, readwrite, or replay")
	}
	if strings.TrimSpace(c.Path) == "" || strings.TrimSpace(c.Namespace) == "" || strings.TrimSpace(c.Epoch) == "" {
		return errors.New("enabled cache requires a path, namespace, and explicit ONE_SYSTEM_CACHE_EPOCH")
	}
	if c.TTL < time.Millisecond || c.TTL > 365*24*time.Hour || c.MaxBytes < 1 || c.MaxBytes > 1<<40 {
		return errors.New("cache TTL must be 1ms through 365d and max bytes must be 1 through 1099511627776")
	}
	return nil
}

type decisionCache struct {
	store    *decisionStore
	settings cacheSettings
	revision string
	mu       sync.Mutex
	pending  map[string]chan struct{}
}

func newDecisionCache(c config) (*decisionCache, error) {
	if err := c.cache.validate(); err != nil {
		return nil, err
	}
	if c.cache.Mode == "" || c.cache.Mode == "off" {
		return nil, nil
	}
	// Credential rotation partitions decisions without persisting credentials.
	store, err := openDecisionStore(c.cache.Path, c.cache.MaxBytes)
	if err != nil {
		return nil, errors.New("could not open decision cache")
	}
	return &decisionCache{store: store, settings: c.cache, revision: configurationRevision(c), pending: make(map[string]chan struct{})}, nil
}

// Fixed fields, then the task-selection policy, then nine fields per backend
// sorted by registry ID. Length framing keeps strings reproducible in Go and JS;
// numbers and optional settings use JSON, whose number format is ES6 in both,
// with null marking an absent setting. Every setting that changes which backend
// answers, or whether a request is accepted, belongs here: a decision replayed
// under different routing is wrong even though it was once valid.
func configurationRevision(c config) string {
	return configurationRevisionWith(c, digest(officialOpenAPI), digest(backendSelectionQuestion))
}

// The pinned contract digests are parameters so that shared cross-runtime
// vectors stay stable when the schema or the selector question changes: both
// implementations then agree on the protocol, and a separate assertion keeps
// each host's own digest honest.
func configurationRevisionWith(c config, openAPIDigest, selectorQuestionDigest string) string {
	parts := [][]byte{[]byte(decisionRevision), []byte(openAPIDigest),
		[]byte(selectorQuestionDigest), []byte(c.cache.Epoch), []byte(c.name),
		[]byte(c.selector), []byte(c.fallback), revisionJSON(c.escalationConfidence),
		[]byte(digest([]byte(c.publicKey)))}
	if c.selection == nil {
		parts = append(parts, []byte("selection:none"))
	} else {
		questions := make([]string, 0, len(c.selection.questions))
		for id := range c.selection.questions {
			questions = append(questions, id)
		}
		sort.Strings(questions)
		parts = append(parts, []byte("selection:rules"), []byte(c.selection.EscalateTo),
			revisionJSON(c.selection.Rules), revisionJSON(len(questions)))
		for _, id := range questions {
			parts = append(parts, []byte(id), c.selection.questions[id])
		}
	}
	ids := make([]string, 0, len(c.backends))
	for id := range c.backends {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		b := c.backends[id]
		parts = append(parts, []byte(id), []byte(b.ID), []byte(b.BaseURL),
			[]byte(b.Model), []byte(b.APIKeyEnv), []byte(b.Description),
			revisionJSON(b.Limits), revisionJSON(b.Capabilities), []byte(digest([]byte(b.key))))
	}
	return framedDigest("one-system-config-v2\x00", parts...)
}

// These are plain numbers, strings, booleans, and slices, which always encode.
func revisionJSON(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic("configuration revision: " + err.Error())
	}
	return data
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

// Cross-runtime key format: SHA-256 of this ASCII domain followed by three
// length-framed byte strings (uint64 big-endian length, bytes). Namespace and
// revision are UTF-8; request is the exact received body, not parsed JSON.
// Keeping number lexemes and strings intact prefers safe misses over collisions.
func decisionKey(namespace, revision string, request []byte) string {
	return framedDigest("one-system-decision-v1\x00", []byte(namespace), []byte(revision), request)
}

func framedDigest(domain string, parts ...[]byte) string {
	h := sha256.New()
	_, _ = h.Write([]byte(domain))
	var length [8]byte
	for _, part := range parts {
		binary.BigEndian.PutUint64(length[:], uint64(len(part)))
		_, _ = h.Write(length[:])
		_, _ = h.Write(part)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Hold only per-key ownership, never a SQLite transaction, during inference.
// Followers re-read the store after the leader releases. A canceled follower
// does not cancel the leader; failed/oversized writes permit a later retry.
func (c *decisionCache) acquire(ctx context.Context, key string) (func(), error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		if done, exists := c.pending[key]; exists {
			c.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-done:
				continue
			}
		}
		done := make(chan struct{})
		c.pending[key] = done
		c.mu.Unlock()
		return func() {
			c.mu.Lock()
			delete(c.pending, key)
			close(done)
			c.mu.Unlock()
		}, nil
	}
}

// Close releases both independent stores and the upstream transport.
func (r *router) Close() error {
	r.client.CloseIdleConnections()
	var err error
	if r.cache != nil {
		err = r.cache.store.Close()
	}
	if r.logs != nil {
		err = errors.Join(err, r.logs.db.Close())
	}
	return err
}

// Returns a write key, an ownership release function, and whether the response
// is complete. A blank key means the successful response must not be persisted.
func (r *router) beginDecision(w http.ResponseWriter, req *http.Request, body []byte, questions map[string]json.RawMessage) (string, func(), bool) {
	started := time.Now()
	release := func() {}
	// Without a cache this host must match one that never had the feature: the
	// request header is ignored like any unknown header and nothing is added.
	if r.cache == nil {
		return "", release, false
	}
	values := req.Header.Values("X-One-System-Cache")
	mode := req.Header.Get("X-One-System-Cache")
	if len(values) > 1 || (mode != "" && mode != "bypass" && mode != "replay") {
		writeAPIError(w, apiError{422, "invalid_cache_mode", "X-One-System-Cache must be bypass or replay"})
		return "", release, true
	}
	c := r.cache
	replay := mode == "replay" || c.settings.Mode == "replay"
	if mode == "bypass" {
		if replay {
			writeAPIError(w, apiError{422, "invalid_cache_mode", "Bypass is unavailable in replay-only mode"})
			return "", release, true
		}
		w.Header().Set("X-One-System-Cache", "bypass")
		return "", release, false
	}
	key := decisionKey(c.settings.Namespace, c.revision, body)
	if !replay {
		var err error
		release, err = c.acquire(req.Context(), key)
		if err != nil {
			writeAPIError(w, apiError{503, "request_canceled", "Request ended while awaiting a decision"})
			return "", func() {}, true
		}
	}
	data, err := c.store.Get(req.Context(), key, time.Now().UnixMilli())
	if err == nil && data != nil {
		data, err = r.replayResponse(data, questions)
		if err == nil {
			w.Header().Set("X-One-System-Cache", "hit")
			// A hit skips the route log. Record it without the key, the backend
			// or any content: only that a stored decision was served.
			r.logger.Info("cache_hit", "latency_ms", time.Since(started).Milliseconds(), "status", http.StatusOK)
			_, _ = w.Write(data)
			return "", release, true
		}
	}
	if err != nil {
		// Do not log SQLite errors or cached content: either may contain data.
		r.logger.Warn("cache_read_failed")
		w.Header().Set("X-One-System-Cache", "error")
		if replay {
			writeAPIError(w, apiError{503, "cache_unavailable", "Cached decision could not be read or validated"})
			return "", release, true
		}
	} else {
		w.Header().Set("X-One-System-Cache", "miss")
	}
	if replay {
		writeAPIError(w, apiError{404, "cache_miss", "No unexpired decision exists for this exact request"})
		return "", release, true
	}
	return key, release, false
}

func (r *router) replayResponse(data []byte, questions map[string]json.RawMessage) ([]byte, error) {
	if len(data) > maxBodyBytes || validateJSON(r.responseSchema, data) != nil {
		return nil, errors.New("invalid cached response")
	}
	var response map[string]json.RawMessage
	var answers map[string]json.RawMessage
	if json.Unmarshal(data, &response) != nil || json.Unmarshal(response["answers"], &answers) != nil || !answersMatch(questions, answers) {
		return nil, errors.New("mismatched cached answers")
	}
	response["usage"] = json.RawMessage(`{"input_tokens":0,"output_tokens":0}`)
	return json.Marshal(response)
}

// response is request-owned and already validated and serialized for the caller.
// Only the persisted copy loses the original inference usage.
func (r *router) rememberDecision(ctx context.Context, key string, response map[string]json.RawMessage) {
	if key == "" {
		return
	}
	response["usage"] = json.RawMessage(`{"input_tokens":0,"output_tokens":0}`)
	data, err := json.Marshal(response)
	if err == nil && len(data) <= maxBodyBytes {
		now := time.Now().UnixMilli()
		err = r.cache.store.Put(ctx, key, data, now, now+r.cache.settings.TTL.Milliseconds())
	}
	if err != nil {
		r.logger.Warn("cache_write_failed")
	}
}
