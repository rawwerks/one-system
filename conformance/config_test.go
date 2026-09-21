package conformance

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func testStrictConfig(t *testing.T, runtime runtimeSpec) {
	for _, tc := range []struct {
		name      string
		change    func(map[string]any)
		questions string
	}{
		{"unknown-registry-field", func(c map[string]any) { c["hidden_retry"] = true }, ""},
		{"unknown-backend-field", func(c map[string]any) { configBackends(c)[0]["secret_override"] = "RAW_CAUSE_CANARY" }, ""},
		{"unknown-limit-field", func(c map[string]any) { configBackends(c)[0]["limits"] = map[string]any{"max_tokens": 100} }, ""},
		{"unknown-selection-field", func(c map[string]any) { configSelection(c)["retry"] = true }, ""},
		{"unknown-rule-field", func(c map[string]any) { configSelection(c)["rules"].([]any)[0].(map[string]any)["gte"] = 0.5 }, ""},
		{"missing-configuration-name", func(c map[string]any) { delete(c, "name") }, ""},
		{"empty-configuration-name", func(c map[string]any) { c["name"] = "" }, ""},
		{"null-configuration-name", func(c map[string]any) { c["name"] = nil }, ""},
		{"nonstring-configuration-name", func(c map[string]any) { c["name"] = 42 }, ""},
		{"invalid-configuration-name", func(c map[string]any) { c["name"] = "private/demo" }, ""},
		{"configuration-name-collision", func(c map[string]any) { c["name"] = "local" }, ""},
		{"capability-empty-types", func(c map[string]any) {
			configBackends(c)[0]["capabilities"] = map[string]any{"question_types": []string{}}
		}, ""},
		{"capability-unknown-type", func(c map[string]any) {
			configBackends(c)[0]["capabilities"] = map[string]any{"question_types": []string{"text"}}
		}, ""},
		{"capability-duplicate-type", func(c map[string]any) {
			configBackends(c)[0]["capabilities"] = map[string]any{"question_types": []string{"noul", "noul"}}
		}, ""},
		{"capability-missing-types", func(c map[string]any) { configBackends(c)[0]["capabilities"] = map[string]any{"max_questions": 1} }, ""},
		{"capability-unknown-field", func(c map[string]any) {
			configBackends(c)[0]["capabilities"] = map[string]any{"question_types": []string{"noul"}, "max_tokens": 512}
		}, ""},
		{"capability-invalid-range", func(c map[string]any) {
			configBackends(c)[0]["capabilities"] = map[string]any{"question_types": []string{"choice"}, "min_criteria": 3, "max_criteria": 2}
		}, ""},
		{"capability-zero-count", func(c map[string]any) {
			configBackends(c)[0]["capabilities"] = map[string]any{"question_types": []string{"noul"}, "max_questions": 0}
		}, ""},
		{"capability-invalid-structured-state", func(c map[string]any) {
			configBackends(c)[0]["capabilities"] = map[string]any{"question_types": []string{"noul"}, "structured_state": "yes"}
		}, ""},
		{"missing-selector", func(c map[string]any) { delete(c, "selector") }, ""},
		{"unknown-selector", func(c map[string]any) { c["selector"] = "missing" }, ""},
		{"unknown-fallback", func(c map[string]any) { c["fallback"] = "missing" }, ""},
		{"no-backends", func(c map[string]any) { c["backends"] = []map[string]any{} }, ""},
		{"duplicate-backend-id", func(c map[string]any) { configBackends(c)[1]["id"] = "local" }, ""},
		{"invalid-backend-id", func(c map[string]any) { configBackends(c)[0]["id"] = "local/private" }, ""},
		{"missing-backend-description", func(c map[string]any) { delete(configBackends(c)[0], "description") }, ""},
		{"missing-backend-secret", func(c map[string]any) { configBackends(c)[0]["api_key_env"] = "CONFORMANCE_UNSET_SECRET" }, ""},
		{"non-loopback-plain-http", func(c map[string]any) { configBackends(c)[0]["base_url"] = "http://example.invalid" }, ""},
		{"url-userinfo", func(c map[string]any) {
			configBackends(c)[0]["base_url"] = "https://user:RAW_CAUSE_CANARY@example.invalid"
		}, ""},
		{"url-query", func(c map[string]any) {
			configBackends(c)[0]["base_url"] = "https://example.invalid?key=RAW_CAUSE_CANARY"
		}, ""},
		{"url-fragment", func(c map[string]any) { configBackends(c)[0]["base_url"] = "https://example.invalid#RAW_CAUSE_CANARY" }, ""},
		{"zero-max-characters", func(c map[string]any) { configBackends(c)[0]["limits"] = map[string]any{"max_characters": 0} }, ""},
		{"zero-max-questions", func(c map[string]any) { configBackends(c)[0]["limits"] = map[string]any{"max_questions": 0} }, ""},
		{"fractional-max-questions", func(c map[string]any) { configBackends(c)[0]["limits"] = map[string]any{"max_questions": 1.5} }, ""},
		{"too-small-max-criteria", func(c map[string]any) { configBackends(c)[0]["limits"] = map[string]any{"max_criteria": 1} }, ""},
		{"fraction-outside-unit-interval", func(c map[string]any) {
			configBackends(c)[0]["limits"] = map[string]any{"max_non_ascii_letter_fraction": 1.01}
		}, ""},
		{"feature-needs-fallback", func(c map[string]any) { delete(c, "fallback") }, ""},
		{"feature-needs-distinct-destination", func(c map[string]any) { configSelection(c)["escalate_to"] = "local" }, ""},
		{"feature-needs-known-destination", func(c map[string]any) { configSelection(c)["escalate_to"] = "unknown" }, ""},
		{"feature-needs-rules", func(c map[string]any) { configSelection(c)["rules"] = []any{} }, ""},
		{"feature-rule-needs-known-question", func(c map[string]any) {
			configSelection(c)["rules"] = []any{map[string]any{"question": "missing", "above": 0.5}}
		}, ""},
		{"feature-rule-threshold-too-high", func(c map[string]any) {
			configSelection(c)["rules"] = []any{map[string]any{"question": "route", "above": 1.01}}
		}, ""},
		{"feature-rule-threshold-negative", func(c map[string]any) {
			configSelection(c)["rules"] = []any{map[string]any{"question": "route", "above": -0.01}}
		}, ""},
		{"feature-questions-empty", nil, `{}`},
		{"feature-questions-not-map", nil, `[]`},
		{"feature-question-unknown-type", nil, `{"route":{"type":"unsupported"}}`},
		{"feature-question-invalid-instructions", nil, `{"route":{"type":"noul","instructions":42}}`},
		{"feature-question-missing-choice-criteria", nil, `{"route":{"type":"choice"}}`},
		{"feature-unreferenced-question-invalid", nil, `{"route":{"type":"noul"},"unused":{"type":"unsupported"}}`},
		{"feature-rule-needs-choice", nil, `{"route":{"type":"choice","criteria":{"yes":"Escalate","no":"Stay"}}}`},
		{"feature-rule-needs-known-choice", func(c map[string]any) {
			configSelection(c)["rules"].([]any)[0].(map[string]any)["choice"] = "missing"
		}, `{"route":{"type":"choice","criteria":{"yes":"Escalate","no":"Stay"}}}`},
		{"feature-questions-over-limit", nil, `{"route":{"type":"noul"}}` + strings.Repeat(" ", 1<<20)},
		{"feature-questions-missing-file", func(c map[string]any) { configSelection(c)["questions_file"] = "missing.synthetic.json" }, ""},
		{"legacy-confidence-needs-fallback", func(c map[string]any) {
			delete(c, "selection")
			delete(c, "fallback")
			c["escalation_confidence"] = 0.5
		}, ""},
		{"legacy-confidence-outside-unit-interval", func(c map[string]any) { delete(c, "selection"); c["escalation_confidence"] = 1.01 }, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Port 1 is only an inert URL; invalid startup must never contact a backend.
			config := registry("local", "local", backend("local", "http://127.0.0.1:1", nil), backend("remote", "http://127.0.0.1:1", nil))
			config["selection"] = map[string]any{
				"questions_file": "routing.questions.v1.json", "escalate_to": "remote",
				"rules": []any{map[string]any{"question": "route", "above": 0.5}},
			}
			if tc.change != nil {
				tc.change(config)
			}
			questions := tc.questions
			if questions == "" {
				questions = `{"route":{"type":"noul","instructions":"Does this need reasoning?"}}`
			}
			g := launch(t, runtime, config, json.RawMessage(questions))
			assertRejectedConfig(t, g)
		})
	}
	t.Run("trailing-config-document", func(t *testing.T) {
		config := registry("local", "", backend("local", "http://127.0.0.1:1", nil))
		g := launch(t, runtime, json.RawMessage(string(encode(t, config))+` {"RAW_CAUSE_CANARY":true}`), nil)
		assertRejectedConfig(t, g)
	})
	t.Run("registry-over-limit-after-valid-document", func(t *testing.T) {
		config := registry("local", "", backend("local", "http://127.0.0.1:1", nil))
		// A bounded decoder must distinguish real EOF from hitting its limit.
		g := launch(t, runtime, json.RawMessage(string(encode(t, config))+strings.Repeat(" ", 1<<20)), nil)
		assertRejectedConfig(t, g)
	})
	t.Run("registry-at-limit", func(t *testing.T) {
		config := registry("local", "", backend("local", "http://127.0.0.1:1", nil))
		raw := string(encode(t, config))
		start(t, runtime, json.RawMessage(raw+strings.Repeat(" ", (1<<20)-len(raw))), nil)
	})
	t.Run("feature-questions-at-limit", func(t *testing.T) {
		config := registry("local", "local", backend("local", "http://127.0.0.1:1", nil), backend("remote", "http://127.0.0.1:1", nil))
		config["selection"] = map[string]any{
			"questions_file": "routing.questions.v1.json", "escalate_to": "remote",
			"rules": []any{map[string]any{"question": "route", "choice": "__proto__", "above": 0.5}},
		}
		raw := `{"route":{"type":"choice","criteria":{"__proto__":"Escalate","":"Stay"}}}`
		start(t, runtime, config, json.RawMessage(raw+strings.Repeat(" ", (1<<20)-len(raw))))
	})
}

func configBackends(config map[string]any) []map[string]any {
	return config["backends"].([]map[string]any)
}

func configSelection(config map[string]any) map[string]any {
	return config["selection"].(map[string]any)
}

func assertRejectedConfig(t *testing.T, g *gateway) {
	t.Helper()
	select {
	case <-g.done:
		if g.err == nil {
			t.Error("invalid registry exited successfully instead of failing startup")
		}
	case <-time.After(4 * time.Second):
		t.Fatal("invalid registry was accepted or startup did not fail promptly")
	}
	for _, canary := range []string{publicKey, backendKey("local"), privateRoot, "RAW_CAUSE_CANARY"} {
		if strings.Contains(g.log.String(), canary) {
			t.Error("configuration error leaked a synthetic credential/root/cause")
		}
	}
}
