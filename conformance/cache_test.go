package conformance

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const cacheHeader = "X-One-System-Cache"

type decisionCacheCases struct {
	Invariants       []string          `json:"invariants"`
	Environment      map[string]string `json:"environment"`
	Request          string            `json:"request"`
	LeafResponse     string            `json:"leaf_response"`
	ReplayedResponse string            `json:"replayed_response"`
	DistinctRequests []struct {
		Name    string `json:"name"`
		Request string `json:"request"`
	} `json:"distinct_requests"`
	InvalidModes []struct {
		Name   string   `json:"name"`
		Values []string `json:"values"`
	} `json:"invalid_modes"`
	IgnoredModes     [][]string `json:"ignored_modes"`
	RejectedSettings []struct {
		Name        string            `json:"name"`
		Environment map[string]string `json:"environment"`
	} `json:"rejected_settings"`
	ChangedLimit map[string]any `json:"changed_limit"`
}

func decisionCaseData(t *testing.T) decisionCacheCases {
	t.Helper()
	var data decisionCacheCases
	fixture(t, "decision-cache", &data)
	return data
}

// The ledger must outlive one launch directory, so the caller owns its path.
// t.TempDir hands out 0755 subdirectories, which both gateways rightly refuse,
// so tests point at a nested path the gateway itself creates privately.
func ledgerPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "ledger", "decisions.sqlite")
}

func cacheEnvironment(path string, base map[string]string, overrides map[string]string) []string {
	settings := map[string]string{"ONE_SYSTEM_CACHE_PATH": path}
	for name, value := range base {
		settings[name] = value
	}
	for name, value := range overrides {
		settings[name] = value
	}
	names := make([]string, 0, len(settings))
	for name := range settings {
		names = append(names, name)
	}
	sort.Strings(names)
	environment := make([]string, 0, len(names))
	for _, name := range names {
		environment = append(environment, name+"="+settings[name])
	}
	return environment
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func cacheStatus(t *testing.T, headers http.Header, want string) {
	t.Helper()
	if got := headers.Get(cacheHeader); got != want {
		t.Errorf("%s=%q, want %q", cacheHeader, got, want)
	}
}

func cacheBackends(t *testing.T, trace *callTrace, replies int, limits map[string]any) (map[string]any, func()) {
	t.Helper()
	scripted := make([]reply, replies)
	data := decisionCaseData(t)
	for i := range scripted {
		scripted[i] = reply{body: data.LeafResponse}
	}
	local := upstream(t, trace, "local", scripted...)
	// One eligible backend keeps the upstream call count unambiguous: every
	// inference is exactly one call, so a hit is provable by its absence.
	return registry("local", "", backend("local", local.URL, limits)), local.Close
}

func testDecisionCache(t *testing.T, runtime runtimeSpec) {
	data := decisionCaseData(t)

	t.Run("capability-rejections-precede-cache-lookup", func(t *testing.T) {
		// Neither leaf declares Score, so no automatic or direct route accepts it.
		score := `{"model":"routing-demo","state":"x","questions":{"q":{"type":"score","criteria":["A","B"]}}}`
		requests := map[string]string{"unsupported-selector": data.Request}
		for _, model := range []string{"routing-demo", "local", "remote"} {
			requests["unsupported-question/"+model] = strings.Replace(score, "routing-demo", model, 1)
		}
		for _, serverMode := range []string{"readwrite", "replay"} {
			for _, unavailable := range []bool{false, true} {
				name := serverMode + "/empty"
				if unavailable {
					name = serverMode + "/unavailable"
				}
				t.Run(name, func(t *testing.T) {
					trace := &callTrace{}
					local := upstream(t, trace, "local")
					remote := upstream(t, trace, "remote")
					selector := backend("local", local.URL, nil)
					selector["capabilities"] = map[string]any{"question_types": []string{"noul"}}
					other := backend("remote", remote.URL, nil)
					other["capabilities"] = map[string]any{"question_types": []string{"noul", "choice"}}
					config := registry("local", "", selector, other)
					path := ledgerPath(t)
					g := start(t, runtime, config, nil, cacheEnvironment(path, data.Environment, map[string]string{"ONE_SYSTEM_CACHE_MODE": serverMode})...)
					if unavailable {
						db := openLog(t, path)
						if _, err := db.Exec("DROP TABLE decisions"); err != nil {
							t.Fatal(err)
						}
					}
					// Both leaves accept the caller's Noul; the selector cannot
					// answer the generated Choice. No leaf accepts Score. Cache
					// errors, misses or replay 404s must not mask any rejection,
					// and a rejected request never reaches the ledger at all.
					for _, name := range sortedKeys(requests) {
						for _, mode := range []string{"", "replay"} {
							status, headers, body := g.post(t, []byte(requests[name]), header{cacheHeader, mode})
							publicError(t, status, headers, body, 422, "unsupported_capability")
							cacheStatus(t, headers, "")
						}
					}
					trace.want(t)
				})
			}
		}
	})
	t.Run("routed-hit-skips-selection-and-validation-precedes-lookup", func(t *testing.T) {
		trace := &callTrace{}
		remote := upstream(t, trace, "remote", reply{body: selectionResponse("local", "1", "2", "1")})
		local := upstream(t, trace, "local", reply{body: data.LeafResponse})
		config := registry("remote", "", backend("local", local.URL, nil), backend("remote", remote.URL, nil))
		g := start(t, runtime, config, nil, cacheEnvironment(ledgerPath(t), data.Environment, nil)...)
		status, headers, body := g.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "miss")
		losslessJSON(t, object(t, body)["usage"], []byte(`{"input_tokens":13,"output_tokens":4}`))
		trace.want(t, "remote", "local")
		// A hit replaces the whole routed decision: neither the selector nor
		// the leaf runs again, and neither one's usage is charged.
		status, headers, body = g.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "hit")
		losslessJSON(t, body, []byte(data.ReplayedResponse))
		// A stored decision never answers a request that authentication or
		// validation rejects, even when the caller asks for replay only.
		for _, tc := range []struct {
			name, auth, request string
			status              int
			code                string
		}{
			{"wrong-credential", "Bearer WRONG_KEY_CANARY", data.Request, 401, "unauthorized"},
			{"invalid-question-type", "Bearer " + publicKey, strings.Replace(data.Request, `"type":"noul"`, `"type":"unknown"`, 1), 422, "schema_validation"},
			{"unknown-model", "Bearer " + publicKey, strings.Replace(data.Request, `"model":"routing-demo"`, `"model":"resolved-leaf"`, 1), 422, "unsupported_model"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				status, headers, body := g.request(t, http.MethodPost, "/v1/systemone", tc.auth, []byte(tc.request), header{cacheHeader, "replay"})
				publicError(t, status, headers, body, tc.status, tc.code)
				if headers.Get(cacheHeader) == "hit" || strings.Contains(string(body), "answers") {
					t.Errorf("a rejected request was answered from the ledger: %v %s", headers, body)
				}
			})
		}
		trace.want(t, "remote", "local")
	})
	t.Run("miss-then-hit-answers-without-inference", func(t *testing.T) {
		trace := &callTrace{}
		config, _ := cacheBackends(t, trace, 1+len(data.DistinctRequests), nil)
		g := start(t, runtime, config, nil, cacheEnvironment(ledgerPath(t), data.Environment, nil)...)
		status, headers, body := g.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "miss")
		losslessJSON(t, body, []byte(data.LeafResponse))
		trace.want(t, "local")
		// The identical request must be answered from the ledger: same answers,
		// no new upstream call, and no tokens reported for inference that did
		// not happen.
		status, headers, body = g.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "hit")
		losslessJSON(t, body, []byte(data.ReplayedResponse))
		trace.want(t, "local")
		// Keys cover the exact request bytes, so formatting, member order and
		// an adjacent integer lexeme must all miss rather than collide.
		want := []string{"local"}
		for _, tc := range data.DistinctRequests {
			t.Run(tc.Name, func(t *testing.T) {
				status, headers, body := g.post(t, []byte(tc.Request))
				wantStatus(t, status, 200, body)
				cacheStatus(t, headers, "miss")
				// The variant is stored under its own key, not dropped.
				status, headers, body = g.post(t, []byte(tc.Request), header{cacheHeader, "replay"})
				wantStatus(t, status, 200, body)
				cacheStatus(t, headers, "hit")
			})
			want = append(want, "local")
			trace.want(t, want...)
		}
	})

	t.Run("replay-reads-and-bypass-does-neither", func(t *testing.T) {
		trace := &callTrace{}
		config, _ := cacheBackends(t, trace, 3, nil)
		g := start(t, runtime, config, nil, cacheEnvironment(ledgerPath(t), data.Environment, nil)...)
		// Replay must never infer, so an unseen request is a 404 rather than
		// an answer the caller did not ask to pay for.
		status, headers, body := g.post(t, []byte(data.Request), header{cacheHeader, "replay"})
		publicError(t, status, headers, body, 404, "cache_miss")
		cacheStatus(t, headers, "miss")
		trace.want(t)
		// Bypass infers and stores nothing, proven by the replay that follows.
		status, headers, body = g.post(t, []byte(data.Request), header{cacheHeader, "bypass"})
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "bypass")
		trace.want(t, "local")
		status, headers, body = g.post(t, []byte(data.Request), header{cacheHeader, "replay"})
		publicError(t, status, headers, body, 404, "cache_miss")
		trace.want(t, "local")
		status, headers, body = g.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "miss")
		trace.want(t, "local", "local")
		// Bypass also refuses to read an entry that now exists.
		status, headers, body = g.post(t, []byte(data.Request), header{cacheHeader, "bypass"})
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "bypass")
		trace.want(t, "local", "local", "local")
		status, headers, body = g.post(t, []byte(data.Request), header{cacheHeader, "replay"})
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "hit")
		losslessJSON(t, body, []byte(data.ReplayedResponse))
		trace.want(t, "local", "local", "local")
	})

	t.Run("invalid-cache-modes-are-rejected-without-a-status", func(t *testing.T) {
		trace := &callTrace{}
		config, _ := cacheBackends(t, trace, 0, nil)
		g := start(t, runtime, config, nil, cacheEnvironment(ledgerPath(t), data.Environment, nil)...)
		for _, tc := range data.InvalidModes {
			t.Run(tc.Name, func(t *testing.T) {
				extra := make([]header, 0, len(tc.Values))
				for _, value := range tc.Values {
					extra = append(extra, header{cacheHeader, value})
				}
				status, headers, body := g.post(t, []byte(data.Request), extra...)
				publicError(t, status, headers, body, 422, "invalid_cache_mode")
				// The request never reached the ledger, so it has no status.
				cacheStatus(t, headers, "")
			})
		}
		trace.want(t)
	})

	t.Run("server-replay-mode-refuses-bypass", func(t *testing.T) {
		trace := &callTrace{}
		config, _ := cacheBackends(t, trace, 0, nil)
		environment := cacheEnvironment(ledgerPath(t), data.Environment, map[string]string{"ONE_SYSTEM_CACHE_MODE": "replay"})
		g := start(t, runtime, config, nil, environment...)
		status, headers, body := g.post(t, []byte(data.Request), header{cacheHeader, "bypass"})
		publicError(t, status, headers, body, 422, "invalid_cache_mode")
		status, headers, body = g.post(t, []byte(data.Request))
		publicError(t, status, headers, body, 404, "cache_miss")
		cacheStatus(t, headers, "miss")
		trace.want(t)
	})

	t.Run("a-failed-decision-is-never-stored", func(t *testing.T) {
		invalidNoul := strings.Replace(data.LeafResponse, `"noul":0.9`, `"noul":"RAW_CAUSE_CANARY"`, 1)
		mismatched := strings.Replace(data.LeafResponse, `"answers":{"q"`, `"answers":{"other"`, 1)
		for _, tc := range []struct {
			name     string
			routed   bool
			failure  reply
			status   int
			code     string
			attempts []string
		}{
			{"leaf-rejection", false, reply{status: 503, body: "RAW_CAUSE_CANARY"}, 503, "upstream_rejected", []string{"local"}},
			{"invalid-answer", false, reply{body: invalidNoul}, 502, "invalid_upstream_response", []string{"local"}},
			{"mismatched-answer", false, reply{body: mismatched}, 502, "mismatched_answers", []string{"local"}},
			{"selector-rejection", true, reply{status: 503, body: "RAW_CAUSE_CANARY"}, 503, "upstream_rejected", []string{"remote"}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				trace := &callTrace{}
				var config map[string]any
				success := []string{"local"}
				if tc.routed {
					remote := upstream(t, trace, "remote", tc.failure, reply{body: selectionResponse("local", "1", "2", "1")})
					local := upstream(t, trace, "local", reply{body: data.LeafResponse})
					config = registry("remote", "", backend("local", local.URL, nil), backend("remote", remote.URL, nil))
					success = []string{"remote", "local"}
				} else {
					local := upstream(t, trace, "local", tc.failure, reply{body: data.LeafResponse})
					config = registry("local", "", backend("local", local.URL, nil))
				}
				g := start(t, runtime, config, nil, cacheEnvironment(ledgerPath(t), data.Environment, nil)...)
				status, headers, body := g.post(t, []byte(data.Request))
				publicError(t, status, headers, body, tc.status, tc.code)
				// A cache-enabled host reports its cache on every response after the
				// hook, including this failure.
				cacheStatus(t, headers, "miss")
				trace.want(t, tc.attempts...)
				status, headers, body = g.post(t, []byte(data.Request), header{cacheHeader, "replay"})
				publicError(t, status, headers, body, 404, "cache_miss")
				trace.want(t, tc.attempts...)
				status, headers, body = g.post(t, []byte(data.Request))
				wantStatus(t, status, 200, body)
				cacheStatus(t, headers, "miss")
				trace.want(t, append(tc.attempts, success...)...)
			})
		}
	})

	t.Run("a-decision-survives-restart-and-a-routing-change-partitions", func(t *testing.T) {
		trace := &callTrace{}
		config, _ := cacheBackends(t, trace, 2, nil)
		environment := cacheEnvironment(ledgerPath(t), data.Environment, nil)
		first := start(t, runtime, config, nil, environment...)
		status, headers, body := first.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "miss")
		trace.want(t, "local")
		first.stop(t)
		second := start(t, runtime, config, nil, environment...)
		status, headers, body = second.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "hit")
		losslessJSON(t, body, []byte(data.ReplayedResponse))
		trace.want(t, "local")
		second.stop(t)
		// A decision is only valid for the routing that produced it, so a
		// changed limit must start a fresh partition rather than replay.
		changed := configBackends(config)[0]
		changed["limits"] = data.ChangedLimit
		third := start(t, runtime, config, nil, environment...)
		status, headers, body = third.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "miss")
		trace.want(t, "local", "local")
	})

	t.Run("a-host-without-a-ledger-is-invisible", func(t *testing.T) {
		trace := &callTrace{}
		config, _ := cacheBackends(t, trace, len(data.IgnoredModes), nil)
		g := start(t, runtime, config, nil)
		want := []string{}
		for index, values := range data.IgnoredModes {
			extra := make([]header, 0, len(values))
			for _, value := range values {
				extra = append(extra, header{cacheHeader, value})
			}
			status, headers, body := g.post(t, []byte(data.Request), extra...)
			wantStatus(t, status, 200, body)
			// Not "off" or "disabled": a host without the feature adds nothing,
			// so a client can tell "never infers" from "has no ledger".
			if got, present := headers[http.CanonicalHeaderKey(cacheHeader)]; present {
				t.Errorf("%v: a host without a ledger announced %v", values, got)
			}
			want = append(want, "local")
			if len(trace.snapshot()) != index+1 {
				t.Fatalf("%v: a cache request header must not suppress inference", values)
			}
		}
		trace.want(t, want...)
	})

	t.Run("invalid-cache-settings-fail-startup", func(t *testing.T) {
		for _, tc := range data.RejectedSettings {
			t.Run(tc.Name, func(t *testing.T) {
				config := registry("local", "", backend("local", "http://127.0.0.1:1", nil))
				g := launch(t, runtime, config, nil, cacheEnvironment(ledgerPath(t), data.Environment, tc.Environment)...)
				assertRejectedConfig(t, g)
			})
		}
		t.Run("exposed-parent-directory", func(t *testing.T) {
			exposed := filepath.Join(t.TempDir(), "shared")
			if err := os.Mkdir(exposed, 0755); err != nil {
				t.Fatal(err)
			}
			config := registry("local", "", backend("local", "http://127.0.0.1:1", nil))
			// A preexisting directory is never relaxed to fit the cache.
			g := launch(t, runtime, config, nil, cacheEnvironment(filepath.Join(exposed, "decisions.sqlite"), data.Environment, nil)...)
			assertRejectedConfig(t, g)
			if info, err := os.Stat(exposed); err != nil || info.Mode().Perm() != 0755 {
				t.Fatalf("startup changed the permissions of an existing directory: %v %v", info, err)
			}
		})
	})
}

// One ledger file, every pairing of implementations. Written by one and
// replayed by the other in replay mode, so a hit cannot be an accident of fresh
// inference. Same-runtime pairs also prove that a reopened server in replay
// mode answers from disk. Cross-runtime pairs need both runtimes selected.
func testDecisionCacheInterop(t *testing.T, runtimes []runtimeSpec) {
	data := decisionCaseData(t)
	selected := map[string]runtimeSpec{}
	for _, runtime := range runtimes {
		selected[runtime.name] = runtime
	}
	for _, pair := range [][2]string{{"go", "go"}, {"go", "hono"}, {"hono", "go"}, {"hono", "hono"}} {
		t.Run(pair[0]+"-writes-"+pair[1]+"-replays", func(t *testing.T) {
			writer, writerSelected := selected[pair[0]]
			reader, readerSelected := selected[pair[1]]
			if !writerSelected || !readerSelected {
				t.Skipf("CROSS-RUNTIME INTEROP NOT EXERCISED: %s-writes-%s-replays needs both runtimes; unset ONE_SYSTEM_RUNTIMES for the full specification run", pair[0], pair[1])
			}
			trace := &callTrace{}
			// Both launches must see the identical registry: base URLs and
			// credentials are part of the configuration revision.
			config, _ := cacheBackends(t, trace, 1, nil)
			shared := ledgerPath(t)
			environment := cacheEnvironment(shared, data.Environment, nil)
			author := start(t, writer, config, nil, environment...)
			status, headers, body := author.post(t, []byte(data.Request))
			wantStatus(t, status, 200, body)
			cacheStatus(t, headers, "miss")
			trace.want(t, "local")
			// Close the database before the other implementation opens it.
			author.stop(t)
			replayed := start(t, reader, config, nil,
				cacheEnvironment(shared, data.Environment, map[string]string{"ONE_SYSTEM_CACHE_MODE": "replay"})...)
			status, headers, body = replayed.post(t, []byte(data.Request))
			wantStatus(t, status, 200, body)
			cacheStatus(t, headers, "hit")
			losslessJSON(t, body, []byte(data.ReplayedResponse))
			// Replay mode cannot infer, and the upstream saw no second call.
			trace.want(t, "local")
			// An unseen request is still a miss on the shared file.
			status, headers, body = replayed.post(t, []byte(data.DistinctRequests[0].Request))
			publicError(t, status, headers, body, 404, "cache_miss")
			trace.want(t, "local")
			replayed.stop(t)
		})
	}
}
