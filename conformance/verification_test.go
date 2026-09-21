package conformance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// This deliberately excludes observedCall's headers, credentials, and URLs.
// Only the synthetic corpus below may be captured for semantic verification.
type verificationCall struct {
	BodyRaw string `json:"body_raw"`
}

type verificationEvidence struct {
	Version        int                `json:"version"`
	Obligation     string             `json:"obligation"`
	Runtime        string             `json:"runtime"`
	Case           string             `json:"case"`
	Model          string             `json:"model"`
	RequestRaw     string             `json:"request_raw"`
	Capabilities   map[string]any     `json:"capabilities"`
	ResponseStatus int                `json:"response_status"`
	ResponseBody   string             `json:"response_body"`
	UpstreamCalls  []verificationCall `json:"upstream_calls"`
}

func saveVerificationEvidence(dir string, record verificationEvidence) error {
	if dir == "" {
		return nil
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("ONE_SYSTEM_VERIFY_EVIDENCE_DIR must be absolute")
	}
	name := record.Runtime + "--" + record.Case + "--" + record.Model + ".json"
	if filepath.Base(name) != name {
		return fmt.Errorf("invalid verification evidence identity")
	}
	raw, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// A fresh output directory is required: never silently mix runs or follow
	// an existing evidence-file symlink.
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(append(raw, '\n'))
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

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
				record := verificationEvidence{
					Version: 1, Obligation: "routing.hard-capabilities", Runtime: runtime.name,
					Case: tc.Name, Model: model, RequestRaw: request, Capabilities: data.Capabilities,
					ResponseStatus: status, ResponseBody: string(body), UpstreamCalls: []verificationCall{},
				}
				for _, call := range calls {
					record.UpstreamCalls = append(record.UpstreamCalls, verificationCall{BodyRaw: string(call.body)})
				}
				// Persist failures too; semantic review needs observations, not just
				// the traces that happened to satisfy the deterministic assertions.
				if err := saveVerificationEvidence(os.Getenv("ONE_SYSTEM_VERIFY_EVIDENCE_DIR"), record); err != nil {
					t.Errorf("saving verification evidence: %v", err)
				}
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

func TestVerificationEvidenceWriter(t *testing.T) {
	record := verificationEvidence{Version: 1, Obligation: "routing.hard-capabilities", Runtime: "go", Case: "supported-choice", Model: "local", UpstreamCalls: []verificationCall{}}
	if err := saveVerificationEvidence("", record); err != nil {
		t.Fatalf("disabled evidence writer: %v", err)
	}
	if err := saveVerificationEvidence("relative", record); err == nil {
		t.Fatal("accepted a relative evidence directory")
	}
	dir := t.TempDir()
	if err := saveVerificationEvidence(dir, record); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "go--supported-choice--local.json")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("evidence must be a private file: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"authorization", "headers", "environment", "base_url"} {
		if strings.Contains(string(raw), field) {
			t.Errorf("unexpected private field %q", field)
		}
	}
	var decoded verificationEvidence
	if err := json.Unmarshal(raw, &decoded); err != nil || decoded.Version != 1 || decoded.UpstreamCalls == nil {
		t.Fatalf("invalid evidence schema: %v", err)
	}
	if err := saveVerificationEvidence(dir, record); err == nil {
		t.Fatal("silently overwrote evidence from an earlier run")
	}
}
