// Package conformance exercises both independent implementations over public HTTP.
// Run with ONE_SYSTEM_GO_BINARY, ONE_SYSTEM_HONO_ENTRY, and ONE_SYSTEM_SKILL_PYTHON
// set to absolute paths for the built runtimes and isolated official-SDK interpreter.
// ONE_SYSTEM_NODE_BINARY selects an explicit Node 24 executable when PATH may be
// rewritten by toolchain launchers; Bun's node shim is intentionally rejected.
// ONE_SYSTEM_RUNTIMES=go or hono runs one implementation as a fast inner loop and
// skips cross-runtime interop; unset (or go,hono) is the dual specification run.
// No production routing code is imported and no live inference or private data is used.
package conformance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	publicKey     = "PUBLIC_KEY_CANARY"
	privateRoot   = "/synthetic/PRIVATE_ROOT_CANARY"
	bodyLimit     = 8 << 20
	basicRequest  = `{"model":"routing-demo","state":"PRIVATE_STATE_CANARY","questions":{"q":{"type":"noul","instructions":"Is this synthetic?"}}}`
	basicResponse = `{"model":"resolved-leaf","answers":{"q":{"type":"noul","noul":0.9}},"usage":{"input_tokens":11,"output_tokens":3}}`
)

type runtimeSpec struct {
	name    string
	command string
	args    []string
}

func conformanceNode() (string, error) {
	name := os.Getenv("ONE_SYSTEM_NODE_BINARY")
	if name == "" {
		name = "node"
	}
	node, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("Node 24 is required; set ONE_SYSTEM_NODE_BINARY to its executable")
	}
	// Toolchain launchers may rewrite PATH, and Bun installs a binary named
	// node. Verify the process identity instead of trusting its executable name.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, node, "-p", `JSON.stringify({node:process.versions.node,bun:process.versions.bun})`).Output()
	var versions struct {
		Node string `json:"node"`
		Bun  string `json:"bun"`
	}
	if err != nil || json.Unmarshal(output, &versions) != nil || !strings.HasPrefix(versions.Node, "24.") || versions.Bun != "" {
		return "", fmt.Errorf("Hono conformance requires actual Node 24, not Bun or another runtime; set ONE_SYSTEM_NODE_BINARY to its executable")
	}
	return node, nil
}

// selectedRuntimes reads ONE_SYSTEM_RUNTIMES: "go", "hono" or "go,hono".
// Unset or empty selects both, which is the specification run. A single
// runtime is only a fast inner loop; it never replaces the dual run.
func selectedRuntimes() ([]string, error) {
	value := strings.TrimSpace(os.Getenv("ONE_SYSTEM_RUNTIMES"))
	if value == "" {
		return []string{"go", "hono"}, nil
	}
	seen := map[string]bool{}
	for _, name := range strings.Split(value, ",") {
		name = strings.TrimSpace(name)
		if name != "go" && name != "hono" {
			return nil, fmt.Errorf("ONE_SYSTEM_RUNTIMES=%q: each entry must be go or hono", value)
		}
		if seen[name] {
			return nil, fmt.Errorf("ONE_SYSTEM_RUNTIMES=%q names %s twice", value, name)
		}
		seen[name] = true
	}
	var names []string
	for _, name := range []string{"go", "hono"} {
		if seen[name] {
			names = append(names, name)
		}
	}
	return names, nil
}

func TestConformance(t *testing.T) {
	goBinary, honoEntry, skillPython := os.Getenv("ONE_SYSTEM_GO_BINARY"), os.Getenv("ONE_SYSTEM_HONO_ENTRY"), os.Getenv("ONE_SYSTEM_SKILL_PYTHON")
	if goBinary == "" && honoEntry == "" {
		t.Skip("dual-runtime HTTP conformance NOT EXERCISED: set ONE_SYSTEM_GO_BINARY, ONE_SYSTEM_HONO_ENTRY, and ONE_SYSTEM_SKILL_PYTHON (or run make check-conformance)")
	}
	names, err := selectedRuntimes()
	if err != nil {
		t.Fatal(err)
	}
	artifacts := map[string]string{"go": goBinary, "hono": honoEntry}
	required := []string{skillPython}
	for _, name := range names {
		if artifacts[name] == "" || skillPython == "" {
			if len(names) == 2 {
				t.Fatal("an intentional conformance run requires ONE_SYSTEM_GO_BINARY, ONE_SYSTEM_HONO_ENTRY, and ONE_SYSTEM_SKILL_PYTHON; refusing partial coverage (set ONE_SYSTEM_RUNTIMES=go or hono for a single-runtime inner loop)")
			}
			t.Fatalf("ONE_SYSTEM_RUNTIMES=%s requires ONE_SYSTEM_%s and ONE_SYSTEM_SKILL_PYTHON", name, map[string]string{"go": "GO_BINARY", "hono": "HONO_ENTRY"}[name])
		}
		required = append(required, artifacts[name])
	}
	for _, path := range required {
		if !filepath.IsAbs(path) {
			t.Fatalf("runtime path must be absolute: %q", path)
		}
		if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
			t.Fatalf("runtime artifact is not a regular file: %q (%v)", path, err)
		}
	}
	var runtimes []runtimeSpec
	for _, name := range names {
		if name == "go" {
			runtimes = append(runtimes, runtimeSpec{"go", goBinary, nil})
			continue
		}
		node, err := conformanceNode()
		if err != nil {
			t.Fatal(err)
		}
		runtimes = append(runtimes, runtimeSpec{"hono", node, []string{honoEntry}})
	}
	if len(runtimes) == 1 {
		t.Logf("SINGLE-RUNTIME inner loop (ONE_SYSTEM_RUNTIMES=%s): cross-runtime interop is skipped; run make check-conformance before declaring work done", names[0])
	}
	for _, runtime := range runtimes {
		t.Run(runtime.name, func(t *testing.T) {
			t.Run("native-lossless", func(t *testing.T) { testNativeLossless(t, runtime) })
			t.Run("selector-disclosure", func(t *testing.T) { testSelectorDisclosure(t, runtime) })
			t.Run("feature-rules", func(t *testing.T) { testFeatureRules(t, runtime) })
			t.Run("eligibility", func(t *testing.T) { testEligibility(t, runtime) })
			t.Run("model-registry", func(t *testing.T) { testModelRegistry(t, runtime) })
			t.Run("verification-evidence", func(t *testing.T) { testVerificationEvidence(t, runtime) })
			t.Run("fallback", func(t *testing.T) { testFallback(t, runtime) })
			t.Run("http", func(t *testing.T) { testHTTP(t, runtime) })
			t.Run("upstream-errors", func(t *testing.T) { testUpstreamErrors(t, runtime) })
			t.Run("usage", func(t *testing.T) { testUsage(t, runtime) })
			t.Run("redirect", func(t *testing.T) { testRedirect(t, runtime) })
			t.Run("bounds", func(t *testing.T) { testBounds(t, runtime) })
			t.Run("disconnect", func(t *testing.T) { testDisconnect(t, runtime) })
			t.Run("strict-config", func(t *testing.T) { testStrictConfig(t, runtime) })
			t.Run("canonical-skill-sdk", func(t *testing.T) { testCanonicalSkillSDK(t, runtime, skillPython) })
			t.Run("decision-cache", func(t *testing.T) { testDecisionCache(t, runtime) })
			t.Run("exchange-logging", func(t *testing.T) { testExchangeLogging(t, runtime) })
		})
	}
	t.Run("decision-cache-interop", func(t *testing.T) { testDecisionCacheInterop(t, runtimes) })
}

type observedCall struct {
	destination      string
	method           string
	path             string
	authorization    string
	body             []byte
	contentLength    int64
	transferEncoding []string
}

type callTrace struct {
	mu    sync.Mutex
	calls []observedCall
}

func (trace *callTrace) snapshot() []observedCall {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	return append([]observedCall(nil), trace.calls...)
}

func (trace *callTrace) want(t *testing.T, destinations ...string) []observedCall {
	t.Helper()
	calls := trace.snapshot()
	got := make([]string, len(calls))
	for i, call := range calls {
		got[i] = call.destination
		if call.method != http.MethodPost || call.path != "/v1/systemone" {
			t.Errorf("upstream %s received %s %s", call.destination, call.method, call.path)
		}
		if call.authorization != "Bearer "+backendKey(call.destination) {
			t.Errorf("upstream %s received another destination's credential", call.destination)
		}
		if call.contentLength != int64(len(call.body)) || len(call.transferEncoding) != 0 {
			t.Errorf("upstream %s requires exact UTF-8 Content-Length: got %d for %d bytes, transfer encodings %v", call.destination, call.contentLength, len(call.body), call.transferEncoding)
		}
	}
	if strings.Join(got, ",") != strings.Join(destinations, ",") {
		t.Fatalf("upstream call order=%v, want %v", got, destinations)
	}
	return calls
}

type reply struct {
	status  int
	body    string
	headers map[string]string
	handle  func(http.ResponseWriter, *http.Request)
}

func upstream(t *testing.T, trace *callTrace, id string, replies ...reply) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	next := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, bodyLimit+1024))
		if err != nil {
			t.Errorf("reading synthetic upstream request: %v", err)
		}
		trace.mu.Lock()
		trace.calls = append(trace.calls, observedCall{id, r.Method, r.URL.Path, r.Header.Get("Authorization"), body, r.ContentLength, append([]string(nil), r.TransferEncoding...)})
		trace.mu.Unlock()
		mu.Lock()
		index := next
		next++
		mu.Unlock()
		if index >= len(replies) {
			t.Errorf("scripted upstream %s received unexpected call %d; only %d responses configured", id, index+1, len(replies))
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		response := replies[index]
		if response.handle != nil {
			response.handle(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		for key, value := range response.headers {
			w.Header().Set(key, value)
		}
		status := response.status
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, response.body)
	}))
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
	})
	return server
}

func backendKey(id string) string { return "BACKEND_" + strings.ToUpper(id) + "_KEY_CANARY" }

func backend(id, url string, limits map[string]any) map[string]any {
	value := map[string]any{
		"id": id, "base_url": url, "model": id + "-model",
		"api_key_env": "CONFORMANCE_" + strings.ToUpper(id) + "_KEY",
		"description": "CAPABILITY_" + strings.ToUpper(id) + "_CANARY",
	}
	if limits != nil {
		value["limits"] = limits
	}
	return value
}

func registry(selector, fallback string, backends ...map[string]any) map[string]any {
	value := map[string]any{"name": "routing-demo", "selector": selector, "backends": backends}
	if fallback != "" {
		value["fallback"] = fallback
	}
	return value
}

type limitedLog struct {
	mu   sync.Mutex
	data []byte
}

func (log *limitedLog) Write(p []byte) (int, error) {
	log.mu.Lock()
	defer log.mu.Unlock()
	n := len(p)
	if left := (64 << 10) - len(log.data); left > 0 {
		if len(p) > left {
			p = p[:left]
		}
		log.data = append(log.data, p...)
	}
	return n, nil
}

func (log *limitedLog) String() string {
	log.mu.Lock()
	defer log.mu.Unlock()
	return string(log.data)
}

type gateway struct {
	url       string
	client    *http.Client
	transport *http.Transport
	command   *exec.Cmd
	done      chan struct{}
	err       error // written before done is closed
	log       limitedLog
}

type header struct{ name, value string }

func launch(t *testing.T, runtime runtimeSpec, config any, questions json.RawMessage, environment ...string) *gateway {
	t.Helper()
	dir := t.TempDir()
	if len(questions) != 0 {
		writeFile(t, filepath.Join(dir, "routing.questions.v1.json"), questions)
	}
	var raw []byte
	if literal, ok := config.(json.RawMessage); ok {
		raw = literal
	} else {
		raw = encode(t, config)
	}
	configPath := filepath.Join(dir, "registry.json")
	writeFile(t, configPath, raw)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	g := &gateway{
		url:       "http://" + addr,
		client:    &http.Client{Transport: transport, Timeout: requestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		transport: transport,
		command:   exec.Command(runtime.command, runtime.args...), done: make(chan struct{}),
	}
	g.command.Dir = dir
	// Do not inherit developer credentials, proxy settings, Node hooks, or private roots.
	g.command.Env = []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "TMPDIR=" + dir,
		"ONE_SYSTEM_CONFIG=" + configPath, "ONE_SYSTEM_ADDR=" + addr,
		"ONE_SYSTEM_API_KEY=" + publicKey, "SKILLS_LIBRARY_PATH=" + privateRoot,
	}
	for _, id := range []string{"local", "remote", "selector"} {
		g.command.Env = append(g.command.Env, "CONFORMANCE_"+strings.ToUpper(id)+"_KEY="+backendKey(id))
	}
	g.command.Env = append(g.command.Env, environment...)
	g.command.Stdout, g.command.Stderr = &g.log, &g.log
	if err := g.command.Start(); err != nil {
		t.Fatalf("starting %s: %v", runtime.name, err)
	}
	go func() {
		g.err = g.command.Wait()
		close(g.done)
	}()
	t.Cleanup(func() {
		transport.CloseIdleConnections()
		select {
		case <-g.done:
			return
		default:
		}
		_ = g.command.Process.Signal(os.Interrupt)
		select {
		case <-g.done:
		case <-time.After(time.Second):
			_ = g.command.Process.Kill()
			select {
			case <-g.done:
			case <-time.After(3 * time.Second):
				t.Error("gateway process did not exit after kill")
			}
		}
	})
	return g
}

// Generous bounds for a slow host (the gate runs in a fresh checkout that also
// installs dependencies). They only cap waiting: no assertion depends on
// either deadline expiring, and a healthy gateway answers in milliseconds.
const (
	readinessTimeout = 30 * time.Second
	requestTimeout   = 20 * time.Second
)

func start(t *testing.T, runtime runtimeSpec, config any, questions json.RawMessage, environment ...string) *gateway {
	t.Helper()
	g := launch(t, runtime, config, questions, environment...)
	deadline := time.Now().Add(readinessTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-g.done:
			t.Fatalf("gateway exited before readiness: %v\n%s", g.err, g.log.String())
		default:
		}
		req, _ := http.NewRequest(http.MethodGet, g.url+"/v1/models", nil)
		req.Header.Set("Authorization", "Bearer "+publicKey)
		response, err := g.client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return g
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("gateway was not HTTP-ready within %s\n%s", readinessTimeout, g.log.String())
	return nil
}

// stop waits for an ordinary shutdown so subsequent launches test persistence.
func (g *gateway) stop(t *testing.T) {
	t.Helper()
	select {
	case <-g.done:
		return
	default:
	}
	if err := g.command.Process.Signal(os.Interrupt); err != nil {
		t.Fatal(err)
	}
	select {
	case <-g.done:
	case <-time.After(10 * time.Second):
		_ = g.command.Process.Kill()
		t.Fatal("gateway did not stop")
	}
	g.transport.CloseIdleConnections()
}

func (g *gateway) request(t *testing.T, method, path, auth string, body []byte, extra ...header) (int, http.Header, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, g.url+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	for _, item := range extra {
		req.Header.Add(item.name, item.value)
	}
	response, err := g.client.Do(req)
	if err != nil {
		t.Fatalf("public HTTP request failed: %v", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, bodyLimit+1024))
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, raw
}

func (g *gateway) post(t *testing.T, body []byte, extra ...header) (int, http.Header, []byte) {
	t.Helper()
	return g.request(t, http.MethodPost, "/v1/systemone", "Bearer "+publicKey, body, extra...)
}

func fixture(t *testing.T, name string, value any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "contract", "cases", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(value); err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func encode(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func object(t *testing.T, data []byte) map[string]json.RawMessage {
	t.Helper()
	var result map[string]json.RawMessage
	if err := json.Unmarshal(data, &result); err != nil || result == nil {
		t.Fatalf("expected JSON object: %s (%v)", data, err)
	}
	return result
}

func losslessJSON(t *testing.T, got, want []byte) {
	t.Helper()
	decode := func(raw []byte) any {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var result any
		if err := decoder.Decode(&result); err != nil {
			t.Fatalf("invalid JSON: %s (%v)", raw, err)
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			t.Fatalf("extra JSON data: %s", raw)
		}
		return result
	}
	if !reflect.DeepEqual(decode(got), decode(want)) {
		t.Errorf("lossless JSON mismatch\ngot:  %s\nwant: %s", got, want)
	}
}

func wantStatus(t *testing.T, got, want int, body []byte) {
	t.Helper()
	if got != want {
		t.Fatalf("status=%d, want=%d: %s", got, want, body)
	}
}

func publicError(t *testing.T, status int, headers http.Header, body []byte, wantStatusCode int, code string) {
	t.Helper()
	wantStatus(t, status, wantStatusCode, body)
	if !strings.HasPrefix(headers.Get("Content-Type"), "application/json") || headers.Get("Cache-Control") != "no-store" {
		t.Errorf("public error lacks JSON/no-store headers: %v", headers)
	}
	var envelope struct {
		Detail []struct {
			Loc     []any  `json:"loc"`
			Message string `json:"msg"`
			Type    string `json:"type"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || len(envelope.Detail) != 1 {
		t.Fatalf("public error must contain canonical detail array: %s", body)
	}
	entry := envelope.Detail[0]
	if len(entry.Loc) == 0 || entry.Message == "" || entry.Type != code {
		t.Errorf("public error lacks canonical location/message/type %q: %s", code, body)
	}
	for _, canary := range []string{publicKey, backendKey("local"), backendKey("remote"), backendKey("selector"), privateRoot, "PRIVATE_STATE_CANARY", "WRONG_KEY_CANARY", "RAW_CAUSE_CANARY"} {
		if strings.Contains(string(body), canary) || strings.Contains(fmt.Sprint(headers), canary) {
			t.Errorf("public error exposed synthetic secret/root/input/cause canary")
		}
	}
}

func selectionResponse(choice string, confidence string, input, output string) string {
	return `{"model":"selector-result","answers":{"backend":{"type":"choice","choice":"` + choice + `","confidence":` + confidence + `,"probabilities":{"local":0.8,"remote":0.2,"selector":0}}},"usage":{"input_tokens":` + input + `,"output_tokens":` + output + `}}`
}
