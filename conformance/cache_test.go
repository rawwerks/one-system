package conformance

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
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

	t.Run("unsupported-selector-precedes-cache-lookup", func(t *testing.T) {
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
					config := registry("local", "", selector, backend("remote", remote.URL, nil))
					path := ledgerPath(t)
					g := start(t, runtime, config, nil, cacheEnvironment(path, data.Environment, map[string]string{"ONE_SYSTEM_CACHE_MODE": serverMode})...)
					if unavailable {
						db := openLog(t, path)
						if _, err := db.Exec("DROP TABLE decisions"); err != nil {
							t.Fatal(err)
						}
					}
					// Both leaves accept the caller; the selector cannot answer
					// the generated Choice. Cache errors/misses must not mask it.
					for _, mode := range []string{"", "replay"} {
						status, headers, body := g.post(t, []byte(data.Request), header{cacheHeader, mode})
						publicError(t, status, headers, body, 422, "unsupported_capability")
						cacheStatus(t, headers, "")
					}
					trace.want(t)
				})
			}
		}
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
		trace := &callTrace{}
		scripted := []reply{{status: 503, body: "RAW_CAUSE_CANARY"}, {body: data.LeafResponse}}
		local := upstream(t, trace, "local", scripted...)
		config := registry("local", "", backend("local", local.URL, nil))
		g := start(t, runtime, config, nil, cacheEnvironment(ledgerPath(t), data.Environment, nil)...)
		status, headers, body := g.post(t, []byte(data.Request))
		publicError(t, status, headers, body, 503, "upstream_rejected")
		// A cache-enabled host reports its cache on every response after the
		// hook, including this failure.
		cacheStatus(t, headers, "miss")
		trace.want(t, "local")
		status, headers, body = g.post(t, []byte(data.Request), header{cacheHeader, "replay"})
		publicError(t, status, headers, body, 404, "cache_miss")
		trace.want(t, "local")
		status, headers, body = g.post(t, []byte(data.Request))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "miss")
		trace.want(t, "local", "local")
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

// One ledger file, both implementations. Written by one and replayed by the
// other in replay mode, so a hit cannot be an accident of fresh inference.
func testDecisionCacheInterop(t *testing.T, runtimes []runtimeSpec) {
	data := decisionCaseData(t)
	for _, direction := range [][2]int{{0, 1}, {1, 0}} {
		writer, reader := runtimes[direction[0]], runtimes[direction[1]]
		t.Run(writer.name+"-writes-"+reader.name+"-replays", func(t *testing.T) {
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
