package conformance

import (
	"encoding/json"
	"testing"
)

func testVerificationEvidence(t *testing.T, runtime runtimeSpec) {
	var data struct {
		Capabilities map[string]any  `json:"capabilities"`
		Response     json.RawMessage `json:"upstream_response"`
		Cases        []struct {
			Name        string `json:"name"`
			QuestionRaw string `json:"question_raw"`
			Status      int    `json:"expected_status"`
			Calls       int    `json:"expected_upstream_calls"`
		} `json:"cases"`
	}
	fixture(t, "capability-verification", &data)
	for _, tc := range data.Cases {
		for _, model := range []string{"routing-demo", "local"} {
			t.Run(tc.Name+"/"+model, func(t *testing.T) {
				trace := &callTrace{}
				local := upstream(t, trace, "local", reply{body: string(data.Response)})
				b := backend("local", local.URL, nil)
				b["capabilities"] = data.Capabilities
				g := start(t, runtime, registry("local", "local", b), nil)
				// Preserve order and capitalization to exercise the actual decoder.
				request := `{"model":"` + model + `","state":"synthetic capability verification","questions":{"q":` + tc.QuestionRaw + `}}`
				status, headers, body := g.post(t, []byte(request))
				calls := trace.snapshot()
				if len(calls) != tc.Calls {
					t.Errorf("upstream calls=%d, want %d", len(calls), tc.Calls)
				}
				if tc.Status == 422 {
					publicError(t, status, headers, body, tc.Status, "unsupported_capability")
				} else {
					wantStatus(t, status, tc.Status, body)
					losslessJSON(t, body, data.Response)
					trace.want(t, "local")
				}
			})
		}
	}
}
