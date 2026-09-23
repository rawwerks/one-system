package conformance

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

type logRecord struct {
	Version    int    `json:"version"`
	ID         string `json:"id"`
	RequestID  string `json:"request_id"`
	ExchangeID string `json:"exchange_id"`
	Kind       string `json:"kind"`
	Scope      string `json:"scope"`
	Time       int64  `json:"time"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Body       string `json:"body_base64"`
	Complete   bool   `json:"body_complete"`
	Status     int    `json:"status"`
	Cache      string `json:"cache"`
}

// sqliteDSN waits for the gateway's own write lock instead of failing at
// once with SQLITE_BUSY: full-sync commits can stall on a loaded machine.
func sqliteDSN(path string) string {
	dsn := url.URL{Scheme: "file", Path: path, RawQuery: url.Values{"_pragma": {"busy_timeout(10000)"}}.Encode()}
	return dsn.String()
}

func openLog(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func logRecords(t *testing.T, db *sql.DB) []logRecord {
	t.Helper()
	rows, err := db.Query("SELECT record FROM log_events ORDER BY rowid")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var records []logRecord
	ids := map[string]bool{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var record logRecord
		if err := json.Unmarshal([]byte(raw), &record); err != nil {
			t.Fatal(err)
		}
		if record.Version != 1 || record.ID == "" || ids[record.ID] || record.RequestID == "" || record.ExchangeID == "" || record.Time <= 0 || record.Method == "" {
			t.Fatalf("unusable record identity: %s", raw)
		}
		ids[record.ID] = true
		// Headers and query strings are not part of the opt-in body history.
		for _, secret := range []string{publicKey, backendKey("local"), backendKey("remote"), "COOKIE_CANARY", "QUERY_CANARY"} {
			if strings.Contains(raw, secret) {
				t.Fatalf("record contains transport secret %q", secret)
			}
		}
		if record.Scope != "gateway" || record.Path == "/v1/systemone" {
			records = append(records, record)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return records
}

func loggedBody(t *testing.T, record logRecord) []byte {
	t.Helper()
	body, err := base64.StdEncoding.DecodeString(record.Body)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// assertPrivateFiles checks the database and any SQLite sidecars that exist.
func assertPrivateFiles(t *testing.T, path string) {
	t.Helper()
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		info, err := os.Stat(path + suffix)
		if suffix != "" && os.IsNotExist(err) {
			continue
		}
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("history file %q is not private: %v %v", suffix, info, err)
		}
	}
}

func logPair(t *testing.T, records []logRecord, requestID, scope string) (logRecord, logRecord) {
	t.Helper()
	var request, response []logRecord
	for _, record := range records {
		if record.RequestID != requestID || record.Scope != scope {
			continue
		}
		if record.Kind == "request" {
			request = append(request, record)
		}
		if record.Kind == "response" {
			response = append(response, record)
		}
	}
	if len(request) != 1 || len(response) != 1 {
		t.Fatalf("%s exchange is not one durable pair: %d requests, %d responses", scope, len(request), len(response))
	}
	if request[0].ExchangeID != response[0].ExchangeID || request[0].ID == response[0].ID {
		t.Fatal("exchange cannot be correlated")
	}
	return request[0], response[0]
}

// assertCommittedRequest runs inside an upstream handler: a second SQLite
// connection must already see the exact request that is about to execute, not
// an uncommitted or buffered write. It runs off the test goroutine, so it only
// reports errors.
func assertCommittedRequest(t *testing.T, path, scope string, received []byte) {
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		t.Error(err)
		return
	}
	defer db.Close()
	var raw string
	if err := db.QueryRow("SELECT record FROM log_events ORDER BY rowid DESC LIMIT 1").Scan(&raw); err != nil {
		t.Errorf("%s ran before any committed request record: %v", scope, err)
		return
	}
	var record logRecord
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		t.Error(err)
		return
	}
	body, err := base64.StdEncoding.DecodeString(record.Body)
	if err != nil || record.Kind != "request" || record.Scope != scope || !bytes.Equal(body, received) {
		t.Errorf("%s ran before its exact request was committed: %s", scope, raw)
	}
}

func testExchangeLogging(t *testing.T, runtime runtimeSpec) {
	t.Run("upstream-pairs-use-actual-escaped-path", func(t *testing.T) {
		trace := &callTrace{}
		paths := make(chan string, 2)
		path := filepath.Join(t.TempDir(), "private", "history.sqlite")
		selection := `{"model":"selector","answers":{"backend":{"type":"choice","choice":"local","confidence":1,"probabilities":{"local":1,"remote":0}}},"usage":{"input_tokens":2,"output_tokens":1}}`
		handler := func(scope, body string) reply {
			return reply{handle: func(w http.ResponseWriter, req *http.Request) {
				paths <- req.URL.EscapedPath()
				calls := trace.snapshot()
				assertCommittedRequest(t, path, scope, calls[len(calls)-1].body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(body))
			}}
		}
		remote := upstream(t, trace, "remote", handler("selector", selection))
		local := upstream(t, trace, "local", handler("backend", basicResponse))
		prefix := "/tenant%2Fteam/%E2%98%83"
		config := registry("remote", "", backend("local", local.URL+prefix, nil), backend("remote", remote.URL+prefix, nil))
		g := start(t, runtime, config, nil, "ONE_SYSTEM_LOG_PATH="+path)
		status, _, body := g.request(t, http.MethodPost, "/v1/systemone?private=QUERY_CANARY", "Bearer "+publicKey, []byte(basicRequest))
		wantStatus(t, status, 200, body)
		calls := trace.snapshot()
		if len(calls) != 2 || calls[0].destination != "remote" || calls[1].destination != "local" {
			t.Fatalf("unexpected upstream calls: %+v", calls)
		}
		observed := map[string]string{"selector": <-paths, "backend": <-paths}
		records := logRecords(t, openLog(t, path))
		if len(records) != 6 {
			t.Fatalf("expected three exchange pairs, got %d records", len(records))
		}
		id := records[0].RequestID
		for scope, actual := range observed {
			if actual != prefix+"/v1/systemone" {
				t.Fatalf("%s fixture received unexpected escaped path %q", scope, actual)
			}
			request, response := logPair(t, records, id, scope)
			if request.Path != actual || response.Path != actual {
				t.Fatalf("%s logged request=%q response=%q, fixture received %q", scope, request.Path, response.Path, actual)
			}
		}
		request, response := logPair(t, records, id, "gateway")
		if request.Path != "/v1/systemone" || response.Path != "/v1/systemone" {
			t.Fatal("inbound path gained query or upstream prefix")
		}
		for _, record := range records {
			raw, _ := json.Marshal(record)
			if bytes.Contains(raw, []byte(remote.URL)) || bytes.Contains(raw, []byte(local.URL)) {
				t.Fatal("record exposed the upstream origin")
			}
		}
	})

	t.Run("explicit-off-never-opens-configured-storage", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local", reply{body: basicResponse}, reply{body: basicResponse})
		config := registry("local", "", backend("local", local.URL, nil))
		path := filepath.Join(t.TempDir(), "uncreated", "disabled.sqlite")
		g := start(t, runtime, config, nil, "ONE_SYSTEM_LOG_MODE=off", "ONE_SYSTEM_LOG_PATH="+path,
			"ONE_SYSTEM_CACHE_MODE=off", "ONE_SYSTEM_CACHE_PATH="+path)
		for range 2 {
			status, headers, body := g.post(t, []byte(basicRequest), header{cacheHeader, "replay"})
			wantStatus(t, status, 200, body)
			cacheStatus(t, headers, "")
		}
		trace.want(t, "local", "local")
		if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
			t.Fatalf("disabled features touched storage: %v", err)
		}
	})

	t.Run("logging-settings-reject-unsafe-deployment", func(t *testing.T) {
		config := registry("local", "", backend("local", "http://127.0.0.1:1", nil))
		for _, env := range [][]string{
			{"ONE_SYSTEM_LOG_MODE=record"},
			{"ONE_SYSTEM_LOG_MODE=unknown"},
			{"ONE_SYSTEM_LOG_PATH=:memory:"},
			{"ONE_SYSTEM_LOG_PATH=file:history.sqlite"},
		} {
			g := launch(t, runtime, config, nil, env...)
			assertRejectedConfig(t, g)
		}
		path := filepath.Join(t.TempDir(), "private", "same.sqlite")
		g := launch(t, runtime, config, nil, "ONE_SYSTEM_LOG_PATH="+path, "ONE_SYSTEM_CACHE_PATH="+path, "ONE_SYSTEM_CACHE_EPOCH=synthetic-v1")
		assertRejectedConfig(t, g)
	})

	for _, reversed := range []bool{false, true} {
		name := "history-is-cache-journal"
		if reversed {
			name = "cache-is-history-journal"
		}
		t.Run(name+"-rejects-before-mutating-history", func(t *testing.T) {
			trace := &callTrace{}
			local := upstream(t, trace, "local", reply{body: basicResponse})
			config := registry("local", "", backend("local", local.URL, nil))
			base := filepath.Join(t.TempDir(), "private", "cache.sqlite")
			cachePath, logPath := base, base+"-journal"
			if reversed {
				cachePath, logPath = logPath, cachePath
			}
			seed := start(t, runtime, config, nil, "ONE_SYSTEM_LOG_PATH="+logPath, "ONE_SYSTEM_CACHE_MODE=off")
			status, _, body := seed.post(t, []byte(basicRequest))
			wantStatus(t, status, 200, body)
			seed.stop(t)
			before, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			g := launch(t, runtime, config, nil, "ONE_SYSTEM_LOG_PATH="+logPath,
				"ONE_SYSTEM_CACHE_PATH="+cachePath, "ONE_SYSTEM_CACHE_EPOCH=synthetic-v1")
			assertRejectedConfig(t, g)
			after, err := os.ReadFile(logPath)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatalf("startup changed existing history before rejecting overlapping storage: %v", err)
			}
			for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
				path := cachePath + suffix
				if path == logPath {
					continue
				}
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("startup touched cache family before rejecting overlap: %s: %v", suffix, err)
				}
			}
			db := openLog(t, logPath)
			records := logRecords(t, db)
			var incoming logRecord
			for _, record := range records {
				if record.Scope == "gateway" && record.Kind == "request" {
					incoming = record
				}
			}
			if !bytes.Equal(loggedBody(t, incoming), []byte(basicRequest)) {
				t.Fatal("prior request history was lost")
			}
			trace.want(t, "local")
		})
	}

	t.Run("cache-hits-bypass-rejections-and-restart-retain-distinct-exchanges", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local", reply{body: basicResponse}, reply{body: basicResponse})
		config := registry("local", "", backend("local", local.URL, nil))
		dir := filepath.Join(t.TempDir(), "private")
		path := filepath.Join(dir, "history.sqlite")
		environment := []string{"ONE_SYSTEM_LOG_PATH=" + path, "ONE_SYSTEM_CACHE_PATH=" + filepath.Join(dir, "cache.sqlite"), "ONE_SYSTEM_CACHE_EPOCH=synthetic-v1"}
		g := start(t, runtime, config, nil, environment...)
		var returned [][]byte
		for _, mode := range []string{"", "", "bypass"} {
			status, _, body := g.request(t, http.MethodPost, "/v1/systemone?private=QUERY_CANARY", "Bearer "+publicKey, []byte(basicRequest), header{cacheHeader, mode}, header{"Cookie", "COOKIE_CANARY"})
			wantStatus(t, status, 200, body)
			returned = append(returned, body)
		}
		status, _, malformed := g.post(t, []byte("{broken"))
		wantStatus(t, status, 422, malformed)
		status, _, denied := g.request(t, http.MethodPost, "/v1/systemone", "Bearer wrong", []byte(basicRequest))
		wantStatus(t, status, 401, denied)
		calls := trace.want(t, "local", "local")
		assertPrivateFiles(t, path)
		g.stop(t)
		db := openLog(t, path)
		records := logRecords(t, db)
		var incoming []logRecord
		for _, record := range records {
			if record.Scope == "gateway" && record.Kind == "request" {
				incoming = append(incoming, record)
			}
		}
		if len(incoming) != 5 {
			t.Fatalf("history has %d requests, want all five", len(incoming))
		}
		wantBodies := append(returned, malformed, denied)
		for i, request := range incoming {
			req, res := logPair(t, records, request.RequestID, "gateway")
			want := []byte(basicRequest)
			if i == 3 {
				want = []byte("{broken")
			}
			if !req.Complete || !bytes.Equal(loggedBody(t, req), want) || !res.Complete || !bytes.Equal(loggedBody(t, res), wantBodies[i]) {
				t.Fatalf("exchange %d lost exact request/response bytes", i)
			}
			if i < 3 && res.Cache != []string{"miss", "hit", "bypass"}[i] {
				t.Fatalf("exchange %d lost cache outcome: %q", i, res.Cache)
			}
			if req.Method != http.MethodPost || res.Method != http.MethodPost {
				t.Fatalf("exchange %d lost its method: %q/%q", i, req.Method, res.Method)
			}
			if i == 0 || i == 2 {
				sent, leaf := logPair(t, records, request.RequestID, "backend")
				if !bytes.Equal(loggedBody(t, leaf), []byte(basicResponse)) {
					t.Fatal("original upstream response/usage was changed")
				}
				if !bytes.Equal(loggedBody(t, sent), calls[i/2].body) {
					t.Fatal("logged upstream request differs from the bytes the upstream received")
				}
			} else {
				for _, event := range records {
					if event.RequestID == request.RequestID && event.Scope != "gateway" {
						t.Fatal("cache hit or rejected request records an upstream call")
					}
				}
			}
		}
		before := len(records)
		second := start(t, runtime, config, nil, environment...)
		status, headers, body := second.post(t, []byte(basicRequest))
		wantStatus(t, status, 200, body)
		cacheStatus(t, headers, "hit")
		second.stop(t)
		if got := len(logRecords(t, db)); got != before+2 {
			t.Fatalf("restart overwrote history: %d records, want %d", got, before+2)
		}
		// Cache maintenance must never prune exchange history.
		if _, err := openLog(t, filepath.Join(dir, "cache.sqlite")).Exec("DELETE FROM decisions"); err != nil {
			t.Fatal(err)
		}
		if got := len(logRecords(t, db)); got != before+2 {
			t.Fatalf("clearing decisions changed history: %d records, want %d", got, before+2)
		}
		trace.want(t, "local", "local")
	})

	t.Run("logging-without-cache-retains-upstream-error-and-selector", func(t *testing.T) {
		trace := &callTrace{}
		selection := `{"model":"selector","answers":{"backend":{"type":"choice","choice":"local","confidence":1,"probabilities":{"local":1,"remote":0}}},"usage":{"input_tokens":2,"output_tokens":1}}`
		remote := upstream(t, trace, "remote", reply{body: selection})
		local := upstream(t, trace, "local", reply{status: 503, body: "synthetic upstream failure body"})
		config := registry("remote", "", backend("local", local.URL, nil), backend("remote", remote.URL, nil))
		path := filepath.Join(t.TempDir(), "private", "history.sqlite")
		g := start(t, runtime, config, nil, "ONE_SYSTEM_LOG_PATH="+path)
		status, headers, body := g.post(t, []byte(basicRequest))
		publicError(t, status, headers, body, 503, "upstream_rejected")
		cacheStatus(t, headers, "")
		trace.want(t, "remote", "local")
		records := logRecords(t, openLog(t, path))
		if len(records) != 6 {
			t.Fatalf("expected gateway + selector + backend pairs, got %d", len(records))
		}
		id := records[0].RequestID
		_, selector := logPair(t, records, id, "selector")
		_, leaf := logPair(t, records, id, "backend")
		_, gateway := logPair(t, records, id, "gateway")
		if !selector.Complete || !bytes.Equal(loggedBody(t, selector), []byte(selection)) || leaf.Status != 503 || !leaf.Complete || string(loggedBody(t, leaf)) != "synthetic upstream failure body" || !bytes.Equal(loggedBody(t, gateway), body) {
			t.Fatal("audit lost original upstream error or selector response")
		}
	})

	t.Run("failed-hit-log-preserves-cache-outcome-without-reexecuting", func(t *testing.T) {
		trace := &callTrace{}
		local := upstream(t, trace, "local", reply{body: basicResponse})
		config := registry("local", "", backend("local", local.URL, nil))
		dir := filepath.Join(t.TempDir(), "private")
		path := filepath.Join(dir, "history.sqlite")
		g := start(t, runtime, config, nil, "ONE_SYSTEM_LOG_PATH="+path, "ONE_SYSTEM_CACHE_PATH="+filepath.Join(dir, "cache.sqlite"), "ONE_SYSTEM_CACHE_EPOCH=synthetic-v1")
		status, _, body := g.post(t, []byte(basicRequest))
		wantStatus(t, status, 200, body)
		db := openLog(t, path)
		if _, err := db.Exec(`CREATE TRIGGER fail_gateway_response BEFORE INSERT ON log_events WHEN json_extract(NEW.record, '$.scope') = 'gateway' AND json_extract(NEW.record, '$.kind') = 'response' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`); err != nil {
			t.Fatal(err)
		}
		status, headers, body := g.post(t, []byte(basicRequest))
		publicError(t, status, headers, body, 503, "logging_unavailable")
		if got := headers.Get(cacheHeader); got != "hit" {
			t.Fatalf("failed audit hid the completed cache lookup: got %q, want hit", got)
		}
		trace.want(t, "local")
	})

	t.Run("each-recording-failure-stops-before-the-next-step", func(t *testing.T) {
		trace := &callTrace{}
		selection := reply{body: selectionResponse("local", "1", "2", "1")}
		remote := upstream(t, trace, "remote", selection, selection, selection, selection)
		local := upstream(t, trace, "local", reply{body: basicResponse}, reply{body: basicResponse})
		config := registry("remote", "local", backend("local", local.URL, nil), backend("remote", remote.URL, nil))
		path := filepath.Join(t.TempDir(), "private", "history.sqlite")
		g := start(t, runtime, config, nil, "ONE_SYSTEM_LOG_PATH="+path)
		db := openLog(t, path)
		var want []string
		for i, tc := range []struct {
			scope, kind string
			executed    []string
		}{
			{"gateway", "request", nil},
			{"selector", "request", nil},
			// Selection already ran, but the fallback must not run after it.
			{"selector", "response", []string{"remote"}},
			{"backend", "request", []string{"remote"}},
			// Executed inference is neither retried nor rolled back.
			{"backend", "response", []string{"remote", "local"}},
			{"gateway", "response", []string{"remote", "local"}},
		} {
			t.Run(tc.scope+"-"+tc.kind, func(t *testing.T) {
				trigger := fmt.Sprintf("fail_point_%d", i)
				if _, err := db.Exec(`CREATE TRIGGER ` + trigger + ` BEFORE INSERT ON log_events WHEN json_extract(NEW.record, '$.scope') = '` + tc.scope + `' AND json_extract(NEW.record, '$.kind') = '` + tc.kind + `' BEGIN SELECT RAISE(ABORT, 'RAW_CAUSE_CANARY'); END`); err != nil {
					t.Fatal(err)
				}
				defer func() {
					if _, err := db.Exec("DROP TRIGGER " + trigger); err != nil {
						t.Fatal(err)
					}
				}()
				status, headers, body := g.post(t, []byte(basicRequest))
				// publicError also proves the storage error text never reaches the caller.
				publicError(t, status, headers, body, 503, "logging_unavailable")
				want = append(want, tc.executed...)
				trace.want(t, want...)
			})
		}
	})

	t.Run("storage-failure-blocks-inference-and-selector-fallback", func(t *testing.T) {
		trace := &callTrace{}
		remote := upstream(t, trace, "remote", reply{status: 503, body: "synthetic selector failure"})
		local := upstream(t, trace, "local")
		config := registry("remote", "local", backend("local", local.URL, nil), backend("remote", remote.URL, nil))
		path := filepath.Join(t.TempDir(), "private", "history.sqlite")
		g := start(t, runtime, config, nil, "ONE_SYSTEM_LOG_PATH="+path)
		db := openLog(t, path)
		_, err := db.Exec(`CREATE TRIGGER fail_selector_record BEFORE INSERT ON log_events WHEN json_extract(NEW.record, '$.scope') = 'selector' AND json_extract(NEW.record, '$.kind') = 'response' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`)
		if err != nil {
			t.Fatal(err)
		}
		status, headers, body := g.post(t, []byte(basicRequest))
		publicError(t, status, headers, body, 503, "logging_unavailable")
		trace.want(t, "remote")
		if _, err := db.Exec("DROP TABLE log_events"); err != nil {
			t.Fatal(err)
		}
		status, headers, body = g.post(t, []byte(basicRequest))
		publicError(t, status, headers, body, 503, "logging_unavailable")
		trace.want(t, "remote")
	})
}
