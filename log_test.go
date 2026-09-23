package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exchange-history behavior visible over HTTP is specified for both gateways
// in conformance/logging_test.go. These tests need internals: broken request
// and response readers, a transport that fails with secrets in its error, and
// direct inspection of storage paths, aliases and file modes.

// No root test asserts write latency; a slow race-instrumented SQLite commit
// must not turn a correct rejection into logging_unavailable.
func init() { logWriteTimeout = time.Minute }

func loggingTestConfig(t *testing.T, u *cacheTestUpstreams) config {
	t.Helper()
	c := u.config(t)
	c.cache = cacheSettings{}
	c.log = logSettings{Path: filepath.Join(t.TempDir(), "private", "exchanges.sqlite"), Mode: "record"}
	return c
}

func readLogRecords(t *testing.T, db *sql.DB) []logRecord {
	t.Helper()
	rows, err := db.Query("SELECT record FROM log_events ORDER BY rowid")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var records []logRecord
	for rows.Next() {
		var raw string
		var record logRecord
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(raw), &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return records
}

func logBody(t *testing.T, record logRecord) []byte {
	t.Helper()
	body, err := base64.StdEncoding.DecodeString(record.BodyBase64)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

type logBrokenReader struct {
	body []byte
}

func (r *logBrokenReader) Read(p []byte) (int, error) {
	if len(r.body) == 0 {
		return 0, errors.New("private-disconnect-reason")
	}
	n := copy(p, r.body)
	r.body = r.body[n:]
	return n, nil
}

func TestExchangeLogCapturesRejectedAndIncompleteInboundBodies(t *testing.T) {
	for _, tc := range []struct {
		name, body, auth, path string
		broken                 bool
		status                 int
		code                   string
		complete               bool
	}{
		{"malformed", "{broken", "test-key", "/v1/systemone", false, 422, "schema_validation", true},
		{"unauthorized", "sensitive rejected body", "wrong-key", "/v1/systemone", false, 401, "unauthorized", true},
		{"unknown path", "unrouted body", "test-key", "/missing", false, 404, "not_found", true},
		{"disconnected", "{partial", "test-key", "/v1/systemone", true, 422, "invalid_body", false},
		{"oversized", strings.Repeat("x", maxBodyBytes+1), "test-key", "/v1/systemone", false, 422, "invalid_body", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := newCacheTestUpstreams(t, nil, nil)
			r, _ := newCacheTestRouter(t, loggingTestConfig(t, u))
			req := cacheTestRequest(tc.body, "")
			req.URL.Path = tc.path
			req.Header.Set("Authorization", "Bearer "+tc.auth)
			if tc.broken {
				req.Body = io.NopCloser(&logBrokenReader{body: []byte(tc.body)})
			}
			response := cacheTestServe(r, req)
			cacheTestAssertError(t, response, tc.status, tc.code)
			u.assertCalls(t, 0, 0)
			records := readLogRecords(t, r.logs.db)
			if len(records) != 2 {
				t.Fatalf("rejected exchange has %d records", len(records))
			}
			want := tc.body[:min(len(tc.body), maxBodyBytes)]
			if string(logBody(t, records[0])) != want || records[0].BodyComplete != tc.complete || records[0].Path != tc.path {
				t.Fatal("request capture changed bytes or concealed truncation")
			}
			if records[1].Error != tc.code || *records[1].Status != tc.status || !bytes.Equal(logBody(t, records[1]), response.Body.Bytes()) {
				t.Fatal("rejection response not recorded exactly")
			}
		})
	}
}

type logRoundTripper func(*http.Request) (*http.Response, error)

func (f logRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestExchangeLogCapturesUpstreamErrorsWithoutTransportSecrets(t *testing.T) {
	for _, tc := range []struct {
		name         string
		status       int
		body         string
		broken       bool
		publicStatus int
		code         string
	}{
		{"rejected", 429, "private upstream error body", false, 429, "upstream_rejected"},
		{"invalid JSON", 200, "not JSON", false, 502, "invalid_upstream_response"},
		{"disconnected", 200, "partial upstream", true, 502, "invalid_upstream_response"},
		{"oversized", 200, strings.Repeat("x", maxBodyBytes+1), false, 502, "invalid_upstream_response"},
		{"network", 0, "", false, 502, "upstream_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := newCacheTestUpstreams(t, nil, nil)
			c := loggingTestConfig(t, u)
			r, _ := newCacheTestRouter(t, c)
			r.client.Transport = logRoundTripper(func(*http.Request) (*http.Response, error) {
				if tc.status == 0 {
					return nil, errors.New("https://user:transport-secret@private.invalid/?credential=transport-secret")
				}
				var body io.Reader = strings.NewReader(tc.body)
				if tc.broken {
					body = &logBrokenReader{body: []byte(tc.body)}
				}
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(body)}, nil
			})
			request := strings.Replace(cacheTestBody, `"model":"routing-demo"`, `"model":"local"`, 1)
			response := cacheTestServe(r, cacheTestRequest(request, ""))
			cacheTestAssertError(t, response, tc.publicStatus, tc.code)
			records := readLogRecords(t, r.logs.db)
			if len(records) != 4 {
				t.Fatalf("upstream failure produced %d records", len(records))
			}
			upstream := records[2]
			wantComplete := tc.status != 0 && !tc.broken && len(tc.body) <= maxBodyBytes
			if upstream.Scope != "backend" || upstream.Kind != "response" || upstream.Status == nil || *upstream.Status != tc.status || upstream.BodyComplete != wantComplete || upstream.Error != tc.code {
				t.Fatalf("incorrect failure trace: %+v", upstream)
			}
			if string(logBody(t, upstream)) != tc.body[:min(len(tc.body), maxBodyBytes)] {
				t.Fatal("upstream error body lost or rewritten")
			}
			for _, record := range records {
				raw, _ := json.Marshal(record)
				if bytes.Contains(raw, []byte("transport-secret")) || bytes.Contains(raw, []byte("private-disconnect-reason")) {
					t.Fatal("raw transport exception was recorded")
				}
			}
		})
	}
}

// Settings, explicit off and non-file storage are specified over HTTP in
// conformance/logging_test.go. These checks inspect the opened store directly.
func TestExchangeLogPrivateStorage(t *testing.T) {
	private := privateDecisionTestDir(t)
	path := filepath.Join(private, "log.sqlite")
	logs, err := newExchangeLog(logSettings{Path: path, Mode: "record"})
	if err != nil {
		t.Fatal(err)
	}
	defer logs.db.Close()
	if _, err := logs.begin(context.Background(), "gateway", "GET", "/v1/models", nil, true, ""); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		info, err := os.Stat(path + suffix)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("unsafe log file %q: %v, %v", suffix, info, err)
		}
	}
	if err := separateStoragePaths(path, filepath.Join(private, ".", "log.sqlite")); err == nil {
		t.Fatal("same cache/log file accepted")
	}
	alias := filepath.Join(private, "alias.sqlite")
	if err := os.Link(path, alias); err != nil {
		t.Fatal(err)
	}
	if err := separateStoragePaths(path, alias); err == nil {
		t.Fatal("cache/log hard-link alias accepted")
	}
	directoryAlias := filepath.Join(t.TempDir(), "private-alias")
	if err := os.Symlink(private, directoryAlias); err != nil {
		t.Fatal(err)
	}
	if err := separateStoragePaths(filepath.Join(private, "not-created", "store.sqlite"), filepath.Join(directoryAlias, "not-created", "store.sqlite")); err == nil {
		t.Fatal("cache/log alias through an existing ancestor symlink accepted")
	}
	unsafeFile := filepath.Join(private, "readable.sqlite")
	if err := os.WriteFile(unsafeFile, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unsafeFile, 0644); err != nil {
		t.Fatal(err)
	}
	if logs, err := newExchangeLog(logSettings{Path: unsafeFile, Mode: "record"}); err == nil {
		_ = logs.db.Close()
		t.Fatal("readable log database accepted")
	}
	public := t.TempDir()
	if err := os.Chmod(public, 0755); err != nil {
		t.Fatal(err)
	}
	if logs, err := newExchangeLog(logSettings{Path: filepath.Join(public, "log.sqlite"), Mode: "record"}); err == nil {
		_ = logs.db.Close()
		t.Fatal("public log directory accepted")
	}
}

func TestSeparateStorageFileFamilies(t *testing.T) {
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		t.Run(suffix, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "uncreated", "cache.sqlite")
			for _, pair := range [][2]string{{path, path + suffix}, {path + suffix, path}} {
				if err := separateStoragePaths(pair[0], pair[1]); err == nil {
					t.Fatal("overlapping SQLite file families accepted")
				}
			}
			if _, err := os.Stat(filepath.Dir(path)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("path inspection created storage")
			}
		})
	}
}

func TestSeparateStorageFileFamilyAliases(t *testing.T) {
	for _, cacheSuffix := range []string{"", "-wal", "-shm", "-journal"} {
		for _, logSuffix := range []string{"", "-wal", "-shm", "-journal"} {
			t.Run("cache"+cacheSuffix+"/log"+logSuffix, func(t *testing.T) {
				dir := t.TempDir()
				cachePath, logPath := filepath.Join(dir, "cache.sqlite"), filepath.Join(dir, "log.sqlite")
				if err := os.WriteFile(cachePath+cacheSuffix, []byte("existing history"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Link(cachePath+cacheSuffix, logPath+logSuffix); err != nil {
					t.Fatal(err)
				}
				if err := separateStoragePaths(cachePath, logPath); err == nil {
					t.Fatal("hard-linked SQLite family members accepted")
				}
			})
		}
	}
	dir := t.TempDir()
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(dir, "uncreated", "cache.sqlite")
	if err := separateStoragePaths(cachePath, filepath.Join(alias, "uncreated", "cache.sqlite-journal")); err == nil {
		t.Fatal("family collision through a symlinked ancestor accepted")
	}
	if err := separateStoragePaths(cachePath, filepath.Join(alias, "uncreated", "history.sqlite")); err != nil {
		t.Fatalf("distinct file families rejected: %v", err)
	}
}

func TestSeparateStoragePathsFailClosedOnInspectionErrors(t *testing.T) {
	for _, target := range []string{"missing", "loop"} {
		t.Run(target, func(t *testing.T) {
			dir := t.TempDir()
			cachePath, logPath := filepath.Join(dir, "cache.sqlite"), filepath.Join(dir, "log.sqlite")
			link := logPath + "-journal"
			destination := filepath.Join(dir, "missing")
			if target == "loop" {
				destination = link
			}
			if err := os.Symlink(destination, link); err != nil {
				t.Fatal(err)
			}
			for _, pair := range [][2]string{{cachePath, logPath}, {logPath, cachePath}} {
				if err := separateStoragePaths(pair[0], pair[1]); err == nil {
					t.Fatal("unresolvable SQLite sidecar accepted")
				}
			}
		})
	}
}
