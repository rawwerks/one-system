package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

type rawSelectorFixture struct {
	name      string
	state     json.RawMessage
	questions map[string]json.RawMessage
}

func rawSelectorFixtures(t testing.TB) (*router, []rawSelectorFixture) {
	t.Helper()
	var template map[string]json.RawMessage
	if err := json.Unmarshal(backendSelectionQuestion, &template); err != nil {
		t.Fatal(err)
	}
	r := &router{
		config: config{name: "routing-demo", selector: "local", backends: map[string]backend{
			"local":  {Model: "local-model", Description: "Local synthetic backend"},
			"remote": {Model: "remote-model", Description: "Remote synthetic backend"},
		}},
		selectorTemplate: template,
	}
	question := json.RawMessage(`{"type":"noul","instructions":"Is this synthetic?"}`)
	few := map[string]json.RawMessage{"q": question}
	many := make(map[string]json.RawMessage, 4096)
	for i := range 4096 {
		many["q"+strconv.Itoa(i)] = question
	}
	return r, []rawSelectorFixture{
		{"small", json.RawMessage(`"synthetic"`), few},
		{"large_state", json.RawMessage(`"` + strings.Repeat("a", 512<<10) + `"`), few},
		{"many_questions", json.RawMessage(`"synthetic"`), many},
	}
}

func TestRawSelectorConstructionHasBoundedAllocations(t *testing.T) {
	r, fixtures := rawSelectorFixtures(t)
	eligible := []string{"local", "remote"}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			// Raw disclosure passes through existing state. It must not allocate
			// proportional summaries or caller-question metadata that is discarded.
			// Keep the budget generous across Go versions, and do not run in parallel:
			// TotalAlloc is process-wide. Fixture setup and GC are outside the sample.
			runtime.GC()
			if _, _, err := r.selectionRequest(fixture.state, fixture.questions, eligible, true); err != nil {
				t.Fatal(err)
			}
			const calls = 32
			const bytesPerCall = 64 << 10
			var before, after runtime.MemStats
			var payload map[string]any
			runtime.ReadMemStats(&before)
			for range calls {
				var err error
				payload, _, err = r.selectionRequest(fixture.state, fixture.questions, eligible, true)
				if err != nil {
					t.Fatal(err)
				}
			}
			runtime.ReadMemStats(&after)
			runtime.KeepAlive(payload)
			allocated := after.TotalAlloc - before.TotalAlloc
			if allocated > calls*bytesPerCall {
				t.Fatalf("raw selector construction allocated %d bytes/call; budget is %d", allocated/calls, bytesPerCall)
			}
		})
	}
}

func BenchmarkRawSelectorConstruction(b *testing.B) {
	r, fixtures := rawSelectorFixtures(b)
	eligible := []string{"local", "remote"}
	for _, fixture := range fixtures {
		b.Run(fixture.name, func(b *testing.B) {
			var payload map[string]any
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				var err error
				payload, _, err = r.selectionRequest(fixture.state, fixture.questions, eligible, true)
				if err != nil {
					b.Fatal(err)
				}
			}
			runtime.KeepAlive(payload)
		})
	}
}

// Upstreams are intentionally adversarial here. The live model proof is separate.
func TestInvalidTrafficNeverEscapesTheContract(t *testing.T) {
	for _, tc := range []struct {
		name           string
		state          string
		selected       string
		leafAnswer     any
		wantStatus     int
		wantSelections int32
		wantLeafCalls  int32
	}{
		{"invalid request", "null", "local", 0.9, 422, 0, 0},
		{"unconfigured destination", `"hello"`, "unconfigured", 0.9, 502, 1, 0},
		{"invalid backend answer", `"hello"`, "local", "not a probability", 502, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var selections, leafCalls atomic.Int32
			selector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				selections.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model": "selector",
					"answers": map[string]any{"backend": map[string]any{
						"type": "choice", "choice": tc.selected, "confidence": 1,
						"probabilities": map[string]float64{"local": 1, "hosted": 0},
					}},
					"usage": map[string]int{"input_tokens": 1, "output_tokens": 1},
				})
			}))
			defer selector.Close()
			leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				leafCalls.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model":   "leaf",
					"answers": map[string]any{"q": map[string]any{"type": "noul", "noul": tc.leafAnswer}},
					"usage":   map[string]int{"input_tokens": 1, "output_tokens": 0},
				})
			}))
			defer leaf.Close()
			r, err := newRouter(config{name: "routing-demo", publicKey: "test-key", selector: "hosted",
				backends: map[string]backend{
					"local":  {ID: "local", BaseURL: leaf.URL, Model: "leaf", Description: "local", key: "test-key"},
					"hosted": {ID: "hosted", BaseURL: selector.URL, Model: "selector", Description: "hosted", key: "test-key"},
				}}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			defer r.client.CloseIdleConnections()
			body := `{"model":"routing-demo","state":` + tc.state + `,"questions":{"q":{"type":"noul","instructions":"Is this positive?"}}}`
			req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer test-key")
			response := httptest.NewRecorder()
			r.ServeHTTP(response, req)
			if response.Code != tc.wantStatus {
				t.Fatalf("status=%d, want=%d: %s", response.Code, tc.wantStatus, response.Body.String())
			}
			if selections.Load() != tc.wantSelections || leafCalls.Load() != tc.wantLeafCalls {
				t.Fatalf("unexpected inference calls: selector=%d, leaf=%d", selections.Load(), leafCalls.Load())
			}
		})
	}
}

func TestSingleBackendDoesNotRequireRoutingCapability(t *testing.T) {
	leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var request struct {
			Questions map[string]struct{ Type string }
		}
		if err := json.NewDecoder(req.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		answers := make(map[string]any, len(request.Questions))
		for id, question := range request.Questions {
			if question.Type != "noul" {
				writeAPIError(w, apiError{422, "unsupported_question", "This model supports only Noul questions"})
				return
			}
			answers[id] = map[string]any{"type": "noul", "noul": 0.9}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "noul-only", "answers": answers,
			"usage": map[string]int{"input_tokens": 4, "output_tokens": 1},
		})
	}))
	defer leaf.Close()
	r, err := newRouter(config{name: "routing-demo", publicKey: "test-key", selector: "only",
		backends: map[string]backend{
			"only": {ID: "only", BaseURL: leaf.URL, Model: "noul-only", Description: "Noul only", key: "test-key"},
		}}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer r.client.CloseIdleConnections()
	req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(
		`{"model":"routing-demo","state":"Great service","questions":{"q":{"type":"noul","instructions":"Is this positive?"}}}`))
	req.Header.Set("Authorization", "Bearer test-key")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("a supported Noul request required unsupported routing capability: status=%d body=%s", response.Code, response.Body.String())
	}
}

// The caller's state is the private half of a request. Routing decides on the
// developer-authored questions plus derived metadata, so the selector must
// never receive the state itself -- not even when the selector is remote.
func TestSelectorNeverReceivesCallerState(t *testing.T) {
	const canary = "CANARY-PRIVATE-STATE-MUST-NOT-LEAVE"
	var selectorBody atomic.Value
	selector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		raw, _ := io.ReadAll(req.Body)
		selectorBody.Store(string(raw))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "selector",
			"answers": map[string]any{"backend": map[string]any{
				"type": "choice", "choice": "local", "confidence": 1,
				"probabilities": map[string]float64{"local": 1, "hosted": 0},
			}},
			"usage": map[string]int{"input_tokens": 1, "output_tokens": 1},
		})
	}))
	defer selector.Close()
	leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model":   "leaf",
			"answers": map[string]any{"q": map[string]any{"type": "noul", "noul": 0.9}},
			"usage":   map[string]int{"input_tokens": 1, "output_tokens": 0},
		})
	}))
	defer leaf.Close()
	r, err := newRouter(config{name: "routing-demo", publicKey: "test-key", selector: "hosted",
		backends: map[string]backend{
			"local":  {ID: "local", BaseURL: leaf.URL, Model: "leaf", Description: "local", key: "test-key"},
			"hosted": {ID: "hosted", BaseURL: selector.URL, Model: "selector", Description: "hosted", key: "test-key"},
		}}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer r.client.CloseIdleConnections()
	body := `{"model":"routing-demo","state":{"message":"` + canary + `"},` +
		`"questions":{"q":{"type":"noul","instructions":"Is this positive?"}}}`
	req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-key")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d: %s", response.Code, response.Body.String())
	}
	sent, _ := selectorBody.Load().(string)
	if sent == "" {
		t.Fatal("the selector was never called")
	}
	if strings.Contains(sent, canary) {
		t.Fatalf("the caller's state reached the selector: %s", sent)
	}
	// The routing signal must survive: questions and derived metadata still travel.
	if !strings.Contains(sent, "Is this positive?") || !strings.Contains(sent, "input_summary") {
		t.Fatalf("the selector lost the question definitions or the input summary: %s", sent)
	}
}

// Escalating away from the fallback backend discloses the caller's state to
// another operator and cannot be undone, so a low-confidence selection must
// stay on the private backend rather than leak on a coin flip.
func TestLowConfidenceEscalationStaysOnFallbackBackend(t *testing.T) {
	for _, tc := range []struct {
		name       string
		confidence float64
		threshold  float64
		wantLeaf   int32
		wantRemote int32
	}{
		{"below threshold stays local", 0.30, 0.70, 1, 0},
		{"above threshold escalates", 0.90, 0.70, 0, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var remoteAnswers, leafCalls atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				var request struct {
					Questions map[string]json.RawMessage `json:"questions"`
				}
				raw, _ := io.ReadAll(req.Body)
				_ = json.Unmarshal(raw, &request)
				if _, selecting := request.Questions[selectorID]; selecting {
					_ = json.NewEncoder(w).Encode(map[string]any{
						"model": "selector",
						"answers": map[string]any{"backend": map[string]any{
							"type": "choice", "choice": "hosted", "confidence": tc.confidence,
							"probabilities": map[string]float64{"local": 1 - tc.confidence, "hosted": tc.confidence},
						}},
						"usage": map[string]int{"input_tokens": 1, "output_tokens": 1},
					})
					return
				}
				remoteAnswers.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model":   "selector",
					"answers": map[string]any{"q": map[string]any{"type": "noul", "noul": 0.9}},
					"usage":   map[string]int{"input_tokens": 1, "output_tokens": 0},
				})
			}))
			defer remote.Close()
			leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				leafCalls.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model":   "leaf",
					"answers": map[string]any{"q": map[string]any{"type": "noul", "noul": 0.9}},
					"usage":   map[string]int{"input_tokens": 1, "output_tokens": 0},
				})
			}))
			defer leaf.Close()
			r, err := newRouter(config{name: "routing-demo", publicKey: "test-key", selector: "hosted",
				fallback: "local", escalationConfidence: tc.threshold,
				backends: map[string]backend{
					"local":  {ID: "local", BaseURL: leaf.URL, Model: "leaf", Description: "local", key: "test-key"},
					"hosted": {ID: "hosted", BaseURL: remote.URL, Model: "selector", Description: "hosted", key: "test-key"},
				}}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			defer r.client.CloseIdleConnections()
			req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(
				`{"model":"routing-demo","state":"private","questions":{"q":{"type":"noul","instructions":"Is this positive?"}}}`))
			req.Header.Set("Authorization", "Bearer test-key")
			response := httptest.NewRecorder()
			r.ServeHTTP(response, req)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d: %s", response.Code, response.Body.String())
			}
			if leafCalls.Load() != tc.wantLeaf || remoteAnswers.Load() != tc.wantRemote {
				t.Fatalf("confidence=%.2f threshold=%.2f: local=%d (want %d), hosted=%d (want %d)",
					tc.confidence, tc.threshold, leafCalls.Load(), tc.wantLeaf, remoteAnswers.Load(), tc.wantRemote)
			}
		})
	}
}

// A backend that cannot represent its input does not report low confidence --
// it answers confidently and wrongly. Declared limits must therefore remove it
// from routing before any inference runs, and insignificant JSON whitespace
// must never change that verdict.
func TestDeclaredLimitsRouteWithoutInference(t *testing.T) {
	maxChars, maxNonASCII, maxQuestions, maxCriteria := 100, 0.02, 3, 4
	wide := make([]string, 0, 6)
	for i := 0; i < 6; i++ {
		wide = append(wide, `"c`+string(rune('a'+i))+`":"option"`)
	}
	for _, tc := range []struct {
		name           string
		state          string
		questions      string
		wantSelections int32
		wantLeafCalls  int32
	}{
		{"english fits the private backend", `"short ascii request"`, "", 1, 1},
		{"non-latin script is unrepresentable", `"サブスクリプションの料金が二重に請求されました"`, "", 0, 0},
		{"oversized state is unrepresentable", `"` + strings.Repeat("a", 200) + `"`, "", 0, 0},
		{"whitespace alone never changes routing", "{\n  \"m\" : \"short ascii request\"\n}", "", 1, 1},
		// Capability is not only about the state: a tiny input can carry a rubric
		// the private backend cannot represent, which it rejects rather than answers.
		{"too many criteria is unrepresentable", `"short ascii request"`,
			`{"q":{"type":"choice","instructions":"Pick one","criteria":{` + strings.Join(wide, ",") + `}}}`, 0, 0},
		{"too many questions is unrepresentable", `"short ascii request"`,
			`{"a":{"type":"noul","instructions":"One?"},"b":{"type":"noul","instructions":"Two?"},` +
				`"c":{"type":"noul","instructions":"Three?"},"d":{"type":"noul","instructions":"Four?"}}`, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var selections, leafCalls atomic.Int32
			leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				var request struct {
					Questions map[string]json.RawMessage `json:"questions"`
				}
				raw, _ := io.ReadAll(req.Body)
				_ = json.Unmarshal(raw, &request)
				if _, selecting := request.Questions[selectorID]; selecting {
					selections.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"model": "leaf",
						"answers": map[string]any{"backend": map[string]any{
							"type": "choice", "choice": "local", "confidence": 1,
							"probabilities": map[string]float64{"local": 1},
						}},
						"usage": map[string]int{"input_tokens": 1, "output_tokens": 1},
					})
					return
				}
				leafCalls.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model":   "leaf",
					"answers": map[string]any{"q": map[string]any{"type": "noul", "noul": 0.9}},
					"usage":   map[string]int{"input_tokens": 1, "output_tokens": 0},
				})
			}))
			defer leaf.Close()
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				// Answer whatever was asked, so the assertion is about routing.
				var request struct {
					Questions map[string]struct {
						Type     string                     `json:"type"`
						Criteria map[string]json.RawMessage `json:"criteria"`
					} `json:"questions"`
				}
				raw, _ := io.ReadAll(req.Body)
				_ = json.Unmarshal(raw, &request)
				answers := make(map[string]any, len(request.Questions))
				for id, q := range request.Questions {
					if q.Type == "choice" {
						for name := range q.Criteria {
							answers[id] = map[string]any{"type": "choice", "choice": name,
								"confidence": 1, "probabilities": map[string]float64{name: 1}}
							break
						}
						continue
					}
					answers[id] = map[string]any{"type": "noul", "noul": 0.9}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model": "remote", "answers": answers,
					"usage": map[string]int{"input_tokens": 1, "output_tokens": 0},
				})
			}))
			defer remote.Close()
			r, err := newRouter(config{name: "routing-demo", publicKey: "test-key", selector: "local", fallback: "local",
				backends: map[string]backend{
					"local": {ID: "local", BaseURL: leaf.URL, Model: "leaf", Description: "local", key: "test-key",
						Limits: &limits{MaxCharacters: &maxChars, MaxNonASCIILetterFraction: &maxNonASCII,
							MaxQuestions: &maxQuestions, MaxCriteria: &maxCriteria}},
					"hosted": {ID: "hosted", BaseURL: remote.URL, Model: "remote", Description: "hosted", key: "test-key"},
				}}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			defer r.client.CloseIdleConnections()
			questions := tc.questions
			if questions == "" {
				questions = `{"q":{"type":"noul","instructions":"Is this positive?"}}`
			}
			body := `{"model":"routing-demo","state":` + tc.state + `,"questions":` + questions + `}`
			req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer test-key")
			response := httptest.NewRecorder()
			r.ServeHTTP(response, req)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d: %s", response.Code, response.Body.String())
			}
			if selections.Load() != tc.wantSelections || leafCalls.Load() != tc.wantLeafCalls {
				t.Fatalf("private backend inference: selector=%d (want %d), answer=%d (want %d)",
					selections.Load(), tc.wantSelections, leafCalls.Load(), tc.wantLeafCalls)
			}
		})
	}
}

// A broken selector must not become a disclosure. With a fallback configured the
// request stays on the private backend instead of failing or escalating.
func TestSelectorFailureFailsClosedOntoFallback(t *testing.T) {
	var leafCalls atomic.Int32
	selector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		writeAPIError(w, apiError{422, "unsupported", "selector cannot evaluate this"})
	}))
	defer selector.Close()
	leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		leafCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model":   "leaf",
			"answers": map[string]any{"q": map[string]any{"type": "noul", "noul": 0.9}},
			"usage":   map[string]int{"input_tokens": 1, "output_tokens": 0},
		})
	}))
	defer leaf.Close()
	r, err := newRouter(config{name: "routing-demo", publicKey: "test-key", selector: "hosted", fallback: "local",
		backends: map[string]backend{
			"local":  {ID: "local", BaseURL: leaf.URL, Model: "leaf", Description: "local", key: "test-key"},
			"hosted": {ID: "hosted", BaseURL: selector.URL, Model: "selector", Description: "hosted", key: "test-key"},
		}}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer r.client.CloseIdleConnections()
	req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(
		`{"model":"routing-demo","state":"private","questions":{"q":{"type":"noul","instructions":"Is this positive?"}}}`))
	req.Header.Set("Authorization", "Bearer test-key")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("a failed selector broke the request instead of failing closed: status=%d body=%s",
			response.Code, response.Body.String())
	}
	if leafCalls.Load() != 1 {
		t.Fatalf("the request did not fall back to the private backend: calls=%d", leafCalls.Load())
	}
}

// Feature-based selection asks the selector about the task, never the state.
// The policy lives in code, so the routing question stays in distribution for a
// small model -- and the caller's data stays out of the routing call entirely.
func TestFeatureSelectionRoutesOnTaskWithoutTheState(t *testing.T) {
	const canary = "CANARY-PRIVATE-STATE-MUST-NOT-LEAVE"
	questions := map[string]json.RawMessage{"domain": json.RawMessage(
		`{"type":"choice","instructions":"What domain does ` + "`request`" + ` belong to?",` +
			`"criteria":{"math_or_logic":"calculation","chitchat":"small talk"}}`)}
	for _, tc := range []struct {
		name       string
		mathProb   float64
		wantRemote int32
		wantLeaf   int32
	}{
		{"rule fires so the request escalates", 0.94, 1, 0},
		{"rule quiet so the request stays private", 0.11, 0, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var selectorBody atomic.Value
			var remoteAnswers, leafCalls atomic.Int32
			leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				raw, _ := io.ReadAll(req.Body)
				var request struct {
					Questions map[string]json.RawMessage `json:"questions"`
				}
				_ = json.Unmarshal(raw, &request)
				if _, routing := request.Questions["domain"]; routing {
					selectorBody.Store(string(raw))
					_ = json.NewEncoder(w).Encode(map[string]any{
						"model": "leaf",
						"answers": map[string]any{"domain": map[string]any{
							"type": "choice", "choice": "math_or_logic", "confidence": 0.8,
							"probabilities": map[string]float64{
								"math_or_logic": tc.mathProb, "chitchat": 1 - tc.mathProb},
						}},
						"usage": map[string]int{"input_tokens": 1, "output_tokens": 1},
					})
					return
				}
				leafCalls.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model":   "leaf",
					"answers": map[string]any{"q": map[string]any{"type": "noul", "noul": 0.9}},
					"usage":   map[string]int{"input_tokens": 1, "output_tokens": 0},
				})
			}))
			defer leaf.Close()
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				remoteAnswers.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model":   "remote",
					"answers": map[string]any{"q": map[string]any{"type": "noul", "noul": 0.9}},
					"usage":   map[string]int{"input_tokens": 1, "output_tokens": 0},
				})
			}))
			defer remote.Close()
			r, err := newRouter(config{name: "routing-demo", publicKey: "test-key", selector: "local", fallback: "local",
				selection: &featureSelection{
					EscalateTo: "hosted", questions: questions,
					Rules: []selectionRule{{Question: "domain", Choice: "math_or_logic", Above: 0.5}},
				},
				backends: map[string]backend{
					"local":  {ID: "local", BaseURL: leaf.URL, Model: "leaf", Description: "local", key: "test-key"},
					"hosted": {ID: "hosted", BaseURL: remote.URL, Model: "remote", Description: "hosted", key: "test-key"},
				}}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			defer r.client.CloseIdleConnections()
			body := `{"model":"routing-demo","state":{"message":"` + canary + `"},"questions":{"q":{` +
				`"type":"noul","instructions":"Is the claim arithmetically correct?"}}}`
			req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer test-key")
			response := httptest.NewRecorder()
			r.ServeHTTP(response, req)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d: %s", response.Code, response.Body.String())
			}
			sent, _ := selectorBody.Load().(string)
			if sent == "" {
				t.Fatal("the routing questions were never asked")
			}
			if strings.Contains(sent, canary) {
				t.Fatalf("the caller's state reached the routing call: %s", sent)
			}
			if !strings.Contains(sent, "Is the claim arithmetically correct?") {
				t.Fatalf("the routing call lost the task text: %s", sent)
			}
			if leafCalls.Load() != tc.wantLeaf || remoteAnswers.Load() != tc.wantRemote {
				t.Fatalf("p(math_or_logic)=%.2f: local=%d (want %d), hosted=%d (want %d)",
					tc.mathProb, leafCalls.Load(), tc.wantLeaf, remoteAnswers.Load(), tc.wantRemote)
			}
		})
	}
}

// Every upstream request is schema-validated before it is sent, so an upstream
// 400 cannot be the caller's doing -- it means the router's own configuration,
// such as a mistyped model name, is wrong. Reporting that as a client error
// blames the caller for an operator mistake. A 422 still passes through,
// because that one really does describe the caller's content.
func TestUpstreamConfigurationErrorsAreNotBlamedOnTheCaller(t *testing.T) {
	for _, tc := range []struct {
		name     string
		upstream int
		want     int
	}{
		{"malformed upstream request is ours", 400, 502},
		{"unsupported content is the caller's", 422, 422},
		{"upstream credentials are ours", 401, 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				writeAPIError(w, apiError{tc.upstream, "upstream", "upstream said no"})
			}))
			defer leaf.Close()
			r, err := newRouter(config{name: "routing-demo", publicKey: "test-key", selector: "only",
				backends: map[string]backend{
					"only": {ID: "only", BaseURL: leaf.URL, Model: "leaf", Description: "only", key: "test-key"},
				}}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			defer r.client.CloseIdleConnections()
			req := httptest.NewRequest(http.MethodPost, "/v1/systemone", strings.NewReader(
				`{"model":"routing-demo","state":"x","questions":{"q":{"type":"noul","instructions":"Is this positive?"}}}`))
			req.Header.Set("Authorization", "Bearer test-key")
			response := httptest.NewRecorder()
			r.ServeHTTP(response, req)
			if response.Code != tc.want {
				t.Fatalf("upstream %d surfaced as %d, want %d", tc.upstream, response.Code, tc.want)
			}
		})
	}
}
