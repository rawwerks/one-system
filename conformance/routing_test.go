package conformance

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func testModelRegistry(t *testing.T, runtime runtimeSpec) {
	t.Run("configuration-name-controls-discovery-and-routing", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local", reply{body: basicResponse}, reply{body: basicResponse})
		remote := upstream(t, trace, "remote", reply{body: selectionResponse("local", "1", "2", "1")})
		config := registry("remote", "", backend("remote", remote.URL, nil), backend("local", local.URL, nil))
		config["name"] = "Private_Demo-2"
		g := start(t, runtime, config, nil)
		status, _, body := g.request(t, http.MethodGet, "/v1/models", "Bearer "+publicKey, nil)
		wantStatus(t, status, 200, body)
		var catalogue struct {
			Models []struct {
				Name string `json:"name"`
			} `json:"models"`
		}
		if err := json.Unmarshal(body, &catalogue); err != nil {
			t.Fatal(err)
		}
		names := make([]string, len(catalogue.Models))
		for i, model := range catalogue.Models {
			names[i] = model.Name
		}
		if strings.Join(names, ",") != "Private_Demo-2,local,remote" {
			t.Fatalf("configured route and sorted backend catalogue = %v", names)
		}
		for _, unknown := range []string{"one-system", "routing-demo"} {
			request := strings.Replace(basicRequest, "routing-demo", unknown, 1)
			status, headers, body := g.post(t, []byte(request))
			publicError(t, status, headers, body, 422, "unsupported_model")
		}
		trace.want(t)
		request := strings.Replace(basicRequest, "routing-demo", "Private_Demo-2", 1)
		status, _, body = g.post(t, []byte(request))
		wantStatus(t, status, 200, body)
		calls := trace.want(t, "remote", "local")
		selection := object(t, calls[0].body)
		if strings.Contains(string(selection["state"]), "PRIVATE_STATE_CANARY") {
			t.Error("configuration naming disclosed private state to the selector")
		}
		expected := object(t, []byte(basicRequest))
		expected["model"] = json.RawMessage(`"local-model"`)
		losslessJSON(t, calls[1].body, encode(t, expected))
		expectedResponse := object(t, []byte(basicResponse))
		expectedResponse["usage"] = json.RawMessage(`{"input_tokens":13,"output_tokens":4}`)
		losslessJSON(t, body, encode(t, expectedResponse))
		status, _, body = g.post(t, []byte(strings.Replace(basicRequest, "routing-demo", "local", 1)))
		wantStatus(t, status, 200, body)
		losslessJSON(t, body, []byte(basicResponse))
		trace.want(t, "remote", "local", "local")
	})
	t.Run("former-project-alias-has-no-special-backend-meaning", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local", reply{body: basicResponse})
		b := backend("local", local.URL, nil)
		b["id"] = "one-system"
		g := start(t, runtime, registry("one-system", "", b), nil)
		status, _, body := g.post(t, []byte(strings.Replace(basicRequest, "routing-demo", "one-system", 1)))
		wantStatus(t, status, 200, body)
		losslessJSON(t, body, []byte(basicResponse))
		calls := trace.want(t, "local")
		if string(object(t, calls[0].body)["model"]) != `"local-model"` {
			t.Error("explicit backend ID was not translated to its native model")
		}
	})
	for _, rawState := range []bool{false, true} {
		t.Run("selector-checks-actual-state-shape/"+map[bool]string{false: "summary-object", true: "original-string"}[rawState], func(t *testing.T) {
			trace := &callTrace{}
			local := upstream(t, trace, "local", reply{body: selectionResponse("remote", "1", "0", "0")})
			remote := upstream(t, trace, "remote", reply{body: basicResponse})
			b := backend("local", local.URL, nil)
			b["capabilities"] = map[string]any{"question_types": []string{"choice", "noul"}, "structured_state": false}
			fallback := ""
			if rawState {
				fallback = "local"
			}
			g := start(t, runtime, registry("local", fallback, b, backend("remote", remote.URL, nil)), nil)
			status, headers, body := g.post(t, []byte(basicRequest))
			if rawState {
				wantStatus(t, status, 200, body)
				trace.want(t, "local", "remote")
			} else {
				publicError(t, status, headers, body, 422, "unsupported_capability")
				trace.want(t)
			}
		})
	}
	t.Run("named-model-is-lossless-and-skips-selector", func(t *testing.T) {
		var data struct {
			Request  json.RawMessage `json:"request"`
			Response json.RawMessage `json:"upstream_response"`
		}
		fixture(t, "native-lossless", &data)
		trace := &callTrace{}
		local := upstream(t, trace, "local", reply{body: string(data.Response)})
		selector := upstream(t, trace, "selector")
		// Explicit selection ignores soft preferences and never calls the selector.
		g := start(t, runtime, registry("selector", "selector", backend("local", local.URL, map[string]any{"max_characters": 1}), backend("selector", selector.URL, nil)), nil)
		request := object(t, data.Request)
		request["model"] = json.RawMessage(`"local"`)
		status, _, body := g.post(t, encode(t, request))
		wantStatus(t, status, 200, body)
		losslessJSON(t, body, data.Response)
		calls := trace.want(t, "local")
		request["model"] = json.RawMessage(`"local-model"`)
		losslessJSON(t, calls[0].body, encode(t, request))
	})
	for _, tc := range []struct {
		name    string
		caps    map[string]any
		request string
	}{
		{"question-type", map[string]any{"question_types": []string{"choice"}}, basicRequest},
		{"case-alias-type", map[string]any{"question_types": []string{"choice"}}, `{"model":"routing-demo","state":"x","questions":{"q":{"type":"noul","Type":"choice","criteria":{"a":"A","b":"B"}}}}`},
		{"case-alias-criteria", map[string]any{"question_types": []string{"choice"}, "max_criteria": 2}, `{"model":"routing-demo","state":"x","questions":{"q":{"type":"choice","criteria":{"a":"A","b":"B","c":"C"},"Criteria":{"a":"A","b":"B"}}}}`},
		{"question-count", map[string]any{"question_types": []string{"noul"}, "max_questions": 1}, `{"model":"routing-demo","state":"x","questions":{"a":{"type":"noul"},"b":{"type":"noul"}}}`},
		{"structured-state", map[string]any{"question_types": []string{"noul"}, "structured_state": false}, `{"model":"routing-demo","state":{"x":1},"questions":{"q":{"type":"noul"}}}`},
		{"too-few-criteria", map[string]any{"question_types": []string{"choice"}, "min_criteria": 2}, `{"model":"routing-demo","state":"x","questions":{"q":{"type":"choice","criteria":{"a":"A"}}}}`},
		{"too-many-criteria", map[string]any{"question_types": []string{"score"}, "max_criteria": 2}, `{"model":"routing-demo","state":"x","questions":{"q":{"type":"score","criteria":["a","b","c"]}}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trace := &callTrace{}
			local := upstream(t, trace, "local")
			b := backend("local", local.URL, nil)
			b["capabilities"] = tc.caps
			g := start(t, runtime, registry("local", "local", b), nil)
			for _, model := range []string{"routing-demo", "local"} {
				request := strings.Replace(tc.request, `"model":"routing-demo"`, `"model":"`+model+`"`, 1)
				status, headers, body := g.post(t, []byte(request))
				publicError(t, status, headers, body, 422, "unsupported_capability")
			}
			trace.want(t)
		})
	}
	t.Run("soft-restoration-cannot-restore-incapable-backend", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local")
		remote := upstream(t, trace, "remote", reply{body: basicResponse})
		b := backend("local", local.URL, nil)
		b["capabilities"] = map[string]any{"question_types": []string{"choice"}}
		g := start(t, runtime, registry("local", "local", b, backend("remote", remote.URL, map[string]any{"max_characters": 1})), nil)
		status, _, body := g.post(t, []byte(basicRequest))
		wantStatus(t, status, 200, body)
		trace.want(t, "remote")
	})
	for _, mode := range []string{"selector-failure", "low-confidence", "feature-fallback"} {
		t.Run("incapable-"+mode, func(t *testing.T) {
			trace := &callTrace{}
			local := upstream(t, trace, "local")
			response := reply{status: 503}
			if mode == "low-confidence" {
				response = reply{body: selectionResponse("remote", "0.1", "0", "0")}
			}
			if mode == "feature-fallback" {
				response = reply{body: basicResponse}
			}
			selector := upstream(t, trace, "selector", response)
			remote := upstream(t, trace, "remote")
			b := backend("local", local.URL, nil)
			b["capabilities"] = map[string]any{"question_types": []string{"choice"}}
			config := registry("selector", "local", b, backend("selector", selector.URL, nil), backend("remote", remote.URL, nil))
			config["escalation_confidence"] = 0.8
			var questions json.RawMessage
			if mode == "feature-fallback" {
				questions = json.RawMessage(`{"q":{"type":"noul"}}`)
				config["selection"] = map[string]any{"questions_file": "routing.questions.v1.json", "escalate_to": "remote", "rules": []any{map[string]any{"question": "q", "above": 0.95}}}
			}
			g := start(t, runtime, config, questions)
			status, headers, body := g.post(t, []byte(basicRequest))
			publicError(t, status, headers, body, 422, "unsupported_capability")
			trace.want(t, "selector")
		})
	}
	t.Run("selector-capability-checked-on-routing-questions", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local")
		remote := upstream(t, trace, "remote")
		b := backend("local", local.URL, nil)
		b["capabilities"] = map[string]any{"question_types": []string{"noul"}}
		g := start(t, runtime, registry("local", "local", b, backend("remote", remote.URL, nil)), nil)
		status, headers, body := g.post(t, []byte(basicRequest))
		publicError(t, status, headers, body, 422, "unsupported_capability")
		trace.want(t)
	})
	t.Run("capability-discovery-is-authenticated-and-honest", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local")
		remote := upstream(t, trace, "remote")
		b := backend("local", local.URL, nil)
		caps := map[string]any{"question_types": []string{"choice", "noul"}, "max_questions": 16, "min_criteria": 2, "structured_state": false}
		b["capabilities"] = caps
		g := start(t, runtime, registry("local", "", b, backend("remote", remote.URL, nil)), nil)
		status, headers, body := g.request(t, http.MethodGet, "/v1/capabilities", "", nil)
		publicError(t, status, headers, body, 401, "unauthorized")
		status, headers, body = g.request(t, http.MethodPost, "/v1/capabilities", "Bearer "+publicKey, nil)
		publicError(t, status, headers, body, 405, "method_not_allowed")
		status, headers, body = g.request(t, http.MethodGet, "/v1/capabilities", "Bearer "+publicKey, nil)
		wantStatus(t, status, 200, body)
		losslessJSON(t, body, encode(t, map[string]any{"version": 1, "models": []any{map[string]any{"name": "local", "capabilities": caps}, map[string]any{"name": "remote", "capabilities": nil}}}))
		if headers.Get("Cache-Control") != "no-store" {
			t.Error("capabilities are cacheable")
		}
		trace.want(t)
	})
}

type routingFixture struct {
	Request             json.RawMessage `json:"request"`
	LeafResponse        json.RawMessage `json:"leaf_response"`
	ExpectedSummary     json.RawMessage `json:"expected_summary"`
	ExpectedDefinitions json.RawMessage `json:"expected_definitions"`
	ExpectedTask        json.RawMessage `json:"expected_task"`
	FeatureQuestions    json.RawMessage `json:"feature_questions"`
	FeatureCases        []struct {
		Name              string      `json:"name"`
		ChoiceProbability json.Number `json:"choice_probability"`
		Noul              json.Number `json:"noul"`
		Score             json.Number `json:"score"`
		Destination       string      `json:"expected_destination"`
	} `json:"feature_cases"`
	Metrics []struct {
		Name    string          `json:"name"`
		State   json.RawMessage `json:"state"`
		Summary json.RawMessage `json:"expected_summary"`
	} `json:"metrics"`
}

func testNativeLossless(t *testing.T, runtime runtimeSpec) {
	var data struct {
		Request  json.RawMessage `json:"request"`
		Response json.RawMessage `json:"upstream_response"`
		Status   int             `json:"expected_status"`
		Calls    []string        `json:"expected_calls"`
	}
	fixture(t, "native-lossless", &data)
	trace := &callTrace{}
	local := upstream(t, trace, "local", reply{body: string(data.Response)})
	g := start(t, runtime, registry("local", "", backend("local", local.URL, nil)), nil)
	status, _, body := g.post(t, data.Request)
	wantStatus(t, status, data.Status, body)
	losslessJSON(t, body, data.Response)
	calls := trace.want(t, data.Calls...)
	wantRequest := object(t, data.Request)
	wantRequest["model"] = json.RawMessage(`"local-model"`)
	losslessJSON(t, calls[0].body, encode(t, wantRequest))
}

func testSelectorDisclosure(t *testing.T, runtime runtimeSpec) {
	var data routingFixture
	fixture(t, "routing", &data)
	for _, disclose := range []bool{false, true} {
		name := "remote-selector-summary-only"
		if disclose {
			name = "fallback-selector-raw-state-only"
		}
		t.Run(name, func(t *testing.T) {
			trace := &callTrace{}
			selector := reply{body: selectionResponse("local", "0.9", "2", "1")}
			leaf := reply{body: string(data.LeafResponse)}
			localReplies, remoteReplies := []reply{leaf}, []reply{selector}
			selectorID := "remote"
			if disclose {
				selectorID = "local"
				localReplies, remoteReplies = []reply{selector, leaf}, nil
			}
			local := upstream(t, trace, "local", localReplies...)
			remote := upstream(t, trace, "remote", remoteReplies...)
			g := start(t, runtime, registry(selectorID, "local", backend("local", local.URL, nil), backend("remote", remote.URL, nil)), nil)
			status, _, body := g.post(t, data.Request)
			wantStatus(t, status, 200, body)
			calls := trace.want(t, selectorID, "local")
			selection := object(t, calls[0].body)
			if disclose {
				losslessJSON(t, selection["state"], object(t, data.Request)["state"])
			} else {
				want := map[string]json.RawMessage{"question_definitions": data.ExpectedDefinitions, "input_summary": data.ExpectedSummary}
				losslessJSON(t, selection["state"], encode(t, want))
				if strings.Contains(string(calls[0].body), "PRIVATE_STATE_CANARY") {
					t.Error("remote selector received the caller's private state")
				}
			}
			questions := object(t, selection["questions"])
			question := object(t, questions["backend"])
			losslessJSON(t, question["criteria"], []byte(`{"local":"CAPABILITY_LOCAL_CANARY","remote":"CAPABILITY_REMOTE_CANARY"}`))
			if strings.Contains(string(selection["state"]), "CAPABILITY_") {
				t.Error("backend capability descriptions appeared in selector evidence instead of criteria only")
			}
			losslessJSON(t, object(t, body)["usage"], []byte(`{"input_tokens":13,"output_tokens":4}`))
			losslessJSON(t, object(t, calls[1].body)["state"], object(t, data.Request)["state"])
		})
	}
	// These literal expectations intentionally do not call either runtime's summary code.
	t.Run("compact-unicode-metrics", func(t *testing.T) {
		trace := &callTrace{}
		var selectorReplies, leafReplies []reply
		for range data.Metrics {
			selectorReplies = append(selectorReplies, reply{body: selectionResponse("local", "1", "0", "0")})
			leafReplies = append(leafReplies, reply{body: basicResponse})
		}
		local := upstream(t, trace, "local", leafReplies...)
		remote := upstream(t, trace, "remote", selectorReplies...)
		g := start(t, runtime, registry("remote", "local", backend("local", local.URL, nil), backend("remote", remote.URL, nil)), nil)
		for i, metric := range data.Metrics {
			t.Run(metric.Name, func(t *testing.T) {
				// Keep the fixture's raw whitespace: reformatting must not inflate the summary.
				request := []byte(`{"model":"routing-demo","state":` + string(metric.State) + `,"questions":{"q":{"type":"noul","instructions":"Is this synthetic?"}}}`)
				status, _, body := g.post(t, request)
				wantStatus(t, status, 200, body)
				calls := trace.snapshot()
				if len(calls) != 2*(i+1) {
					t.Fatalf("metric request caused %d cumulative upstream calls, want %d", len(calls), 2*(i+1))
				}
				state := object(t, object(t, calls[2*i].body)["state"])
				losslessJSON(t, state["input_summary"], metric.Summary)
			})
		}
	})
}

func testFeatureRules(t *testing.T, runtime runtimeSpec) {
	var data routingFixture
	fixture(t, "routing", &data)
	for _, tc := range data.FeatureCases {
		t.Run(tc.Name, func(t *testing.T) {
			trace := &callTrace{}
			// The selected label and confidence disagree with the complex probability:
			// feature rules must read the named probability, not either of those fields.
			response := `{"model":"feature-selector","answers":{` +
				`"domain":{"type":"choice","choice":"simple","confidence":0.01,"probabilities":{"complex":` + tc.ChoiceProbability.String() + `,"simple":0.4999}},` +
				`"reasoning":{"type":"noul","noul":` + tc.Noul.String() + `},` +
				`"difficulty":{"type":"score","score":` + tc.Score.String() + `,"confidence":0.01,"legend":{"0":"Simple","1":"Hard"},"probabilities":{"0":0.5,"1":0.5}}},` +
				`"usage":{"input_tokens":2,"output_tokens":1}}`
			localReplies := []reply{{body: response}}
			var remoteReplies []reply
			if tc.Destination == "local" {
				localReplies = append(localReplies, reply{body: string(data.LeafResponse)})
			} else {
				remoteReplies = append(remoteReplies, reply{body: string(data.LeafResponse)})
			}
			local := upstream(t, trace, "local", localReplies...)
			remote := upstream(t, trace, "remote", remoteReplies...)
			config := registry("local", "local", backend("local", local.URL, nil), backend("remote", remote.URL, nil))
			config["escalation_confidence"] = 0.99
			config["selection"] = map[string]any{
				"questions_file": "routing.questions.v1.json", "escalate_to": "remote",
				"rules": []any{
					map[string]any{"question": "domain", "choice": "complex", "above": 0.5},
					map[string]any{"question": "reasoning", "above": 0.5},
					map[string]any{"question": "difficulty", "above": 0.5},
				},
			}
			g := start(t, runtime, config, data.FeatureQuestions)
			status, _, body := g.post(t, data.Request)
			wantStatus(t, status, 200, body)
			calls := trace.want(t, "local", tc.Destination)
			selector := object(t, calls[0].body)
			losslessJSON(t, selector["state"], data.ExpectedTask)
			losslessJSON(t, selector["questions"], data.FeatureQuestions)
			if strings.Contains(string(calls[0].body), "PRIVATE_STATE_CANARY") {
				t.Error("feature selection disclosed caller state even though selector equals fallback")
			}
			losslessJSON(t, object(t, body)["usage"], []byte(`{"input_tokens":13,"output_tokens":4}`))
		})
	}
}

func testEligibility(t *testing.T, runtime runtimeSpec) {
	const choiceQuestions = `{"q":{"type":"choice","criteria":{"a":"A","b":"B","c":"C"}}}`
	const scoreQuestions = `{"q":{"type":"score","criteria":["A","B","C"]}}`
	const twoChoices = `{"a":{"type":"choice","criteria":{"x":"X","y":"Y"}},"z":{"type":"choice","criteria":{"x":"X","y":"Y"}}}`
	choiceResponse := `{"model":"leaf","answers":{"q":{"type":"choice","choice":"a","confidence":1,"probabilities":{"a":1,"b":0,"c":0}}},"usage":{"input_tokens":1,"output_tokens":1}}`
	scoreResponse := `{"model":"leaf","answers":{"q":{"type":"score","score":1,"confidence":1,"legend":{"0":"A","1":"B","2":"C"},"probabilities":{"0":0,"1":1,"2":0}}},"usage":{"input_tokens":1,"output_tokens":1}}`
	twoChoiceResponse := `{"model":"leaf","answers":{"a":{"type":"choice","choice":"x","confidence":1,"probabilities":{"x":1,"y":0}},"z":{"type":"choice","choice":"x","confidence":1,"probabilities":{"x":1,"y":0}}},"usage":{"input_tokens":1,"output_tokens":1}}`
	var data routingFixture
	fixture(t, "routing", &data)
	for _, tc := range []struct {
		name         string
		request      string
		response     string
		localLimits  map[string]any
		remoteLimits map[string]any
		calls        []string
	}{
		{"character-limit-excludes-before-inference", basicRequest, basicResponse, map[string]any{"max_characters": 21}, nil, []string{"remote"}},
		{"character-limit-equality-remains-eligible", basicRequest, basicResponse, map[string]any{"max_characters": 22}, nil, []string{"local", "local"}},
		{"max-questions-excludes", string(data.Request), string(data.LeafResponse), map[string]any{"max_questions": 1}, nil, []string{"remote"}},
		{"max-questions-equality", string(data.Request), string(data.LeafResponse), map[string]any{"max_questions": 2}, nil, []string{"local", "local"}},
		{"wide-choice-excludes", `{"model":"routing-demo","state":"x","questions":` + choiceQuestions + `}`, choiceResponse, map[string]any{"max_criteria": 2}, nil, []string{"remote"}},
		{"wide-score-excludes", `{"model":"routing-demo","state":"x","questions":` + scoreQuestions + `}`, scoreResponse, map[string]any{"max_criteria": 2}, nil, []string{"remote"}},
		{"criteria-limit-is-widest-not-sum", `{"model":"routing-demo","state":"x","questions":` + twoChoices + `}`, twoChoiceResponse, map[string]any{"max_criteria": 2}, nil, []string{"local", "local"}},
		{"zero-eligible-restores-all", basicRequest, basicResponse, map[string]any{"max_characters": 1}, map[string]any{"max_characters": 1}, []string{"local", "local"}},
		{"rounded-fraction-equality", `{"model":"routing-demo","state":"éaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","questions":{"q":{"type":"noul"}}}`, basicResponse, map[string]any{"max_non_ascii_letter_fraction": 0.03}, nil, []string{"local", "local"}},
		{"rounded-fraction-excludes", `{"model":"routing-demo","state":"éaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","questions":{"q":{"type":"noul"}}}`, basicResponse, map[string]any{"max_non_ascii_letter_fraction": 0.02}, nil, []string{"remote"}},
		{"whitespace-and-astral-codepoints", "{\"model\":\"routing-demo\",\"state\": {\n  \"m\" : \"éa界😀 9\"\n },\"questions\":{\"q\":{\"type\":\"noul\"}}}", basicResponse, map[string]any{"max_characters": 14, "max_non_ascii_letter_fraction": 0.5}, nil, []string{"local", "local"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trace := &callTrace{}
			var localReplies, remoteReplies []reply
			if len(tc.calls) == 1 {
				remoteReplies = []reply{{body: tc.response}}
			} else {
				localReplies = []reply{{body: selectionResponse("local", "1", "0", "0")}, {body: tc.response}}
			}
			local := upstream(t, trace, "local", localReplies...)
			remote := upstream(t, trace, "remote", remoteReplies...)
			g := start(t, runtime, registry("local", "local", backend("local", local.URL, tc.localLimits), backend("remote", remote.URL, tc.remoteLimits)), nil)
			status, _, body := g.post(t, []byte(tc.request))
			wantStatus(t, status, 200, body)
			calls := trace.want(t, tc.calls...)
			if len(calls) == 2 {
				question := object(t, object(t, object(t, calls[0].body)["questions"])["backend"])
				losslessJSON(t, question["criteria"], []byte(`{"local":"CAPABILITY_LOCAL_CANARY","remote":"CAPABILITY_REMOTE_CANARY"}`))
			}
		})
	}
	for _, fails := range []bool{false, true} {
		name := "selector-sees-only-eligible-criteria"
		if fails {
			name = "soft-limits-do-not-block-error-fallback"
		}
		t.Run(name, func(t *testing.T) {
			trace := &callTrace{}
			selectorReply := reply{body: selectionResponse("remote", "1", "0", "0")}
			destination := "remote"
			var localReplies, remoteReplies []reply
			if fails {
				selectorReply = reply{status: 503, body: `RAW_CAUSE_CANARY`}
				destination = "local"
				localReplies = []reply{{body: basicResponse}}
			} else {
				remoteReplies = []reply{{body: basicResponse}}
			}
			local := upstream(t, trace, "local", localReplies...)
			remote := upstream(t, trace, "remote", remoteReplies...)
			selector := upstream(t, trace, "selector", selectorReply)
			config := registry("selector", "local",
				backend("local", local.URL, map[string]any{"max_characters": 1}),
				backend("remote", remote.URL, nil), backend("selector", selector.URL, nil))
			g := start(t, runtime, config, nil)
			status, _, body := g.post(t, []byte(basicRequest))
			wantStatus(t, status, 200, body)
			calls := trace.want(t, "selector", destination)
			question := object(t, object(t, object(t, calls[0].body)["questions"])["backend"])
			losslessJSON(t, question["criteria"], []byte(`{"remote":"CAPABILITY_REMOTE_CANARY","selector":"CAPABILITY_SELECTOR_CANARY"}`))
		})
	}
}

func testFallback(t *testing.T, runtime runtimeSpec) {
	for _, tc := range []struct {
		name     string
		fallback string
		selector reply
		leaf     reply
		calls    []string
		status   int
		code     string
	}{
		{"selector-error-fails-closed", "local", reply{status: 401, body: `{"detail":{"error_type":"RAW_CAUSE_CANARY","message":"BACKEND_REMOTE_KEY_CANARY /synthetic/PRIVATE_ROOT_CANARY"}}`}, reply{body: basicResponse}, []string{"remote", "local"}, 200, ""},
		{"selector-error-without-fallback", "", reply{status: 401, body: `{"detail":{"message":"RAW_CAUSE_CANARY"}}`}, reply{}, []string{"remote"}, 502, "upstream_rejected"},
		{"invalid-selector-response-falls-back", "local", reply{body: `{"broken":"RAW_CAUSE_CANARY"}`}, reply{body: basicResponse}, []string{"remote", "local"}, 200, ""},
		// A choice outside the offered backends is an invalid answer, never a destination.
		{"unconfigured-selection-without-fallback", "", reply{body: selectionResponse("unconfigured", "1", "2", "1")}, reply{}, []string{"remote"}, 502, "mismatched_answers"},
		{"leaf-error-is-not-retried", "local", reply{body: selectionResponse("remote", "1", "2", "1")}, reply{status: 422, body: `{"detail":{"message":"PRIVATE_STATE_CANARY"}}`}, []string{"remote", "remote"}, 422, "upstream_rejected"},
		{"low-confidence-stays-private", "local", reply{body: selectionResponse("remote", "0.7499", "2", "1")}, reply{body: basicResponse}, []string{"remote", "local"}, 200, ""},
		{"legacy-confidence-equality-escalates", "local", reply{body: selectionResponse("remote", "0.75", "2", "1")}, reply{body: basicResponse}, []string{"remote", "remote"}, 200, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trace := &callTrace{}
			remoteReplies := []reply{tc.selector}
			var localReplies []reply
			if len(tc.calls) > 1 {
				if tc.calls[1] == "local" {
					localReplies = []reply{tc.leaf}
				} else {
					remoteReplies = append(remoteReplies, tc.leaf)
				}
			}
			local := upstream(t, trace, "local", localReplies...)
			remote := upstream(t, trace, "remote", remoteReplies...)
			config := registry("remote", tc.fallback, backend("local", local.URL, nil), backend("remote", remote.URL, nil))
			if tc.fallback != "" {
				config["escalation_confidence"] = 0.75
			}
			g := start(t, runtime, config, nil)
			status, headers, body := g.post(t, []byte(basicRequest))
			if tc.status == 200 {
				wantStatus(t, status, 200, body)
			} else {
				publicError(t, status, headers, body, tc.status, tc.code)
			}
			trace.want(t, tc.calls...)
		})
	}
}
