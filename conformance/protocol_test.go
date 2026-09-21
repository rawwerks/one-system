package conformance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func testHTTP(t *testing.T, runtime runtimeSpec) {
	var cases struct {
		Cases []struct {
			Name          string `json:"name"`
			Method        string `json:"method"`
			Path          string `json:"path"`
			Authorization string `json:"authorization"`
			Body          string `json:"body"`
			Status        int    `json:"status"`
			Type          string `json:"type"`
			Authenticate  string `json:"authenticate"`
			Allow         string `json:"allow"`
		} `json:"cases"`
	}
	fixture(t, "http-errors", &cases)
	trace := &callTrace{}
	local := upstream(t, trace, "local")
	g := start(t, runtime, registry("local", "", backend("local", local.URL, nil)), nil)
	for _, tc := range cases.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			auth := tc.Authorization
			if auth == "valid" {
				auth = "Bearer " + publicKey
			}
			status, headers, body := g.request(t, tc.Method, tc.Path, auth, []byte(tc.Body))
			publicError(t, status, headers, body, tc.Status, tc.Type)
			if headers.Get("WWW-Authenticate") != tc.Authenticate || headers.Get("Allow") != tc.Allow {
				t.Errorf("wrong authentication/method negotiation headers: %v", headers)
			}
		})
	}
	status, headers, body := g.request(t, http.MethodGet, "/v1/models", "Bearer "+publicKey, nil)
	wantStatus(t, status, 200, body)
	var catalog struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &catalog); err != nil || len(catalog.Models) != 2 || catalog.Models[0].Name != "routing-demo" || catalog.Models[1].Name != "local" {
		t.Errorf("public model catalog must advertise automatic and configured aliases: %s", body)
	}
	if headers.Get("Cache-Control") != "no-store" {
		t.Error("public model catalog is cacheable")
	}
	trace.want(t)
}

func testUpstreamErrors(t *testing.T, runtime runtimeSpec) {
	type scenario struct {
		name     string
		request  string
		response reply
		status   int
		code     string
	}
	var cases []scenario
	for _, status := range []int{400, 401, 403, 407, 422, 429, 503} {
		want := status
		code := "upstream_rejected"
		if status == 400 || status == 401 || status == 403 || status == 407 {
			want = 502
		}
		if status == 407 {
			// Fetch exposes proxy authentication responses as network failures.
			code = "upstream_unavailable"
		}
		cases = append(cases, scenario{
			name:     fmt.Sprintf("http-%d", status),
			response: reply{status: status, body: `{"detail":{"error_type":"RAW_CAUSE_CANARY","message":"BACKEND_LOCAL_KEY_CANARY /synthetic/PRIVATE_ROOT_CANARY PRIVATE_STATE_CANARY"}}`},
			status:   want, code: code,
		})
	}
	cases = append(cases,
		scenario{name: "invalid-json", response: reply{body: `RAW_CAUSE_CANARY`}, status: 502, code: "invalid_upstream_response"},
		scenario{name: "multiple-documents", response: reply{body: basicResponse + basicResponse}, status: 502, code: "invalid_upstream_response"},
		scenario{name: "missing-answer", response: reply{body: `{"model":"leaf","answers":{"other":{"type":"noul","noul":0.8}},"usage":{"input_tokens":1,"output_tokens":0}}`}, status: 502, code: "mismatched_answers"},
		scenario{name: "extra-answer", response: reply{body: `{"model":"leaf","answers":{"q":{"type":"noul","noul":0.8},"extra":{"type":"noul","noul":0.1}},"usage":{"input_tokens":1,"output_tokens":0}}`}, status: 502, code: "mismatched_answers"},
		scenario{name: "wrong-answer-type", response: reply{body: `{"model":"leaf","answers":{"q":{"type":"choice","choice":"x","confidence":1,"probabilities":{"x":1}}},"usage":{"input_tokens":1,"output_tokens":0}}`}, status: 502, code: "mismatched_answers"},
		scenario{name: "invalid-noul", response: reply{body: `{"model":"leaf","answers":{"q":{"type":"noul","noul":"PRIVATE_STATE_CANARY"}},"usage":{"input_tokens":1,"output_tokens":0}}`}, status: 502, code: "invalid_upstream_response"},
		scenario{name: "unrequested-choice", request: `{"model":"routing-demo","state":"x","questions":{"q":{"type":"choice","criteria":{"yes":"Yes","no":"No"}}}}`, response: reply{body: `{"model":"leaf","answers":{"q":{"type":"choice","choice":"unconfigured","confidence":1,"probabilities":{"yes":1,"no":0}}},"usage":{"input_tokens":1,"output_tokens":0}}`}, status: 502, code: "mismatched_answers"},
	)
	trace := &callTrace{}
	replies := make([]reply, len(cases))
	for i, tc := range cases {
		replies[i] = tc.response
	}
	local := upstream(t, trace, "local", replies...)
	g := start(t, runtime, registry("local", "", backend("local", local.URL, nil)), nil)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := tc.request
			if request == "" {
				request = basicRequest
			}
			status, headers, body := g.post(t, []byte(request))
			publicError(t, status, headers, body, tc.status, tc.code)
		})
	}
	destinations := make([]string, len(cases))
	for i := range destinations {
		destinations[i] = "local"
	}
	trace.want(t, destinations...)
	t.Run("421-is-not-retried", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local",
			reply{status: 421, body: "RAW_CAUSE_CANARY"},
			reply{body: basicResponse},
		)
		g := start(t, runtime, registry("local", "", backend("local", local.URL, nil)), nil)
		status, headers, body := g.post(t, []byte(basicRequest))
		// A replay would reach the success response and incur another inference.
		trace.want(t, "local")
		publicError(t, status, headers, body, 421, "upstream_rejected")
	})
}

func withUsage(response, input, output string) string {
	return strings.Replace(response, `"input_tokens":11,"output_tokens":3`, `"input_tokens":`+input+`,"output_tokens":`+output, 1)
}

func testUsage(t *testing.T, runtime runtimeSpec) {
	for _, tc := range []struct {
		name           string
		selectorInput  string
		selectorOutput string
		leafInput      string
		leafOutput     string
		wantInput      string
		wantOutput     string
		code           string
	}{
		{"above-js-safe-integer", "9007199254740993", "1", "1", "3", "9007199254740994", "4", ""},
		{"signed-int64-exact-boundary", "9007199254740993", "3", "9214364837600034814", "9223372036854775804", "9223372036854775807", "9223372036854775807", ""},
		{"input-aggregate-overflow", "1", "0", "9223372036854775807", "3", "", "", "invalid_usage"},
		{"output-aggregate-overflow", "0", "1", "11", "9223372036854775807", "", "", "invalid_usage"},
		{"negative-usage", "0", "0", "-1", "3", "", "", "invalid_upstream_response"},
		{"single-count-exceeds-int64", "0", "0", "9223372036854775808", "3", "", "", "invalid_upstream_response"},
		{"fractional-usage", "0", "0", "1.5", "3", "", "", "invalid_upstream_response"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trace := &callTrace{}
			remote := upstream(t, trace, "remote", reply{body: selectionResponse("local", "1", tc.selectorInput, tc.selectorOutput)})
			local := upstream(t, trace, "local", reply{body: withUsage(basicResponse, tc.leafInput, tc.leafOutput)})
			g := start(t, runtime, registry("remote", "", backend("local", local.URL, nil), backend("remote", remote.URL, nil)), nil)
			status, headers, body := g.post(t, []byte(basicRequest))
			trace.want(t, "remote", "local")
			if tc.code != "" {
				publicError(t, status, headers, body, 502, tc.code)
			} else {
				wantStatus(t, status, 200, body)
				losslessJSON(t, object(t, body)["usage"], []byte(`{"input_tokens":`+tc.wantInput+`,"output_tokens":`+tc.wantOutput+`}`))
			}
		})
	}
}

func testRedirect(t *testing.T, runtime runtimeSpec) {
	trace := &callTrace{}
	sink := upstream(t, trace, "remote", reply{body: basicResponse})
	local := upstream(t, trace, "local", reply{status: 307, body: `RAW_CAUSE_CANARY`, headers: map[string]string{"Location": sink.URL + "/v1/systemone"}})
	g := start(t, runtime, registry("local", "", backend("local", local.URL, nil)), nil)
	status, headers, body := g.post(t, []byte(basicRequest))
	publicError(t, status, headers, body, 502, "upstream_rejected")
	// The redirect points at the same hostname with another port: a default HTTP
	// client may keep Authorization on precisely this kind of redirect.
	trace.want(t, "local")
}

func testBounds(t *testing.T, runtime runtimeSpec) {
	trace := &callTrace{}
	prefix := `{"model":"routing-demo","state":"`
	suffix := `","questions":{"q":{"type":"noul"}}}`
	atLimit := []byte(prefix + strings.Repeat("x", bodyLimit-len(prefix)-len(suffix)) + suffix)
	responsePrefix := strings.TrimSuffix(basicResponse, "}") + `,"padding":"`
	responseSuffix := `"}`
	responseAtLimit := responsePrefix + strings.Repeat("x", bodyLimit-len(responsePrefix)-len(responseSuffix)) + responseSuffix
	readCancelled := make(chan struct{})
	local := upstream(t, trace, "local",
		reply{body: basicResponse},
		reply{body: responseAtLimit},
		reply{handle: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, err := io.WriteString(w, strings.Repeat(" ", bodyLimit+1))
			if err == nil {
				w.(http.Flusher).Flush()
			}
			select {
			case <-r.Context().Done():
				close(readCancelled)
			case <-time.After(4 * time.Second):
			}
		}},
	)
	g := start(t, runtime, registry("local", "", backend("local", local.URL, nil)), nil)
	t.Run("request-at-limit", func(t *testing.T) {
		status, _, body := g.post(t, atLimit)
		wantStatus(t, status, 200, body)
	})
	t.Run("request-over-limit", func(t *testing.T) {
		overLimit := append([]byte(" "), atLimit...)
		status, headers, body := g.post(t, overLimit)
		publicError(t, status, headers, body, 422, "invalid_body")
	})
	t.Run("response-at-limit", func(t *testing.T) {
		status, _, body := g.post(t, []byte(basicRequest))
		wantStatus(t, status, 200, body)
		losslessJSON(t, body, []byte(responseAtLimit))
	})
	t.Run("response-over-limit-stops-reading", func(t *testing.T) {
		status, headers, body := g.post(t, []byte(basicRequest))
		publicError(t, status, headers, body, 502, "invalid_upstream_response")
		select {
		case <-readCancelled:
		case <-time.After(2 * time.Second):
			t.Error("gateway did not cancel the oversized upstream stream")
		}
	})
	trace.want(t, "local", "local", "local")
}

func testDisconnect(t *testing.T, runtime runtimeSpec) {
	for _, selecting := range []bool{false, true} {
		name := "leaf"
		if selecting {
			name = "selector"
		}
		t.Run(name, func(t *testing.T) {
			trace := &callTrace{}
			started, cancelled := make(chan struct{}), make(chan struct{})
			local := upstream(t, trace, "local", reply{handle: func(w http.ResponseWriter, r *http.Request) {
				close(started)
				select {
				case <-r.Context().Done():
					close(cancelled)
				case <-time.After(4 * time.Second):
				}
			}})
			config := registry("local", "", backend("local", local.URL, nil))
			if selecting {
				remote := upstream(t, trace, "remote")
				config = registry("local", "local", backend("local", local.URL, nil), backend("remote", remote.URL, nil))
			}
			g := start(t, runtime, config, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.url+"/v1/systemone", bytes.NewBufferString(basicRequest))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+publicKey)
			req.Header.Set("Content-Type", "application/json")
			done := make(chan error, 1)
			go func() {
				response, err := g.client.Do(req)
				if response != nil {
					_ = response.Body.Close()
				}
				done <- err
			}()
			select {
			case <-started:
			case <-time.After(2 * time.Second):
				t.Fatal("upstream did not receive the request before disconnect")
			}
			cancel()
			select {
			case err := <-done:
				if err == nil {
					t.Error("caller disconnect unexpectedly completed successfully")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("caller cancellation did not terminate HTTP request")
			}
			select {
			case <-cancelled:
			case <-time.After(2 * time.Second):
				t.Error("caller disconnect was not propagated to upstream HTTP context")
			}
			trace.want(t, "local")
		})
	}
}
