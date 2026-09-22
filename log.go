package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type logSettings struct {
	Path string
	Mode string
}

func loadLogSettings() (logSettings, error) {
	c := logSettings{Path: os.Getenv("ONE_SYSTEM_LOG_PATH"), Mode: os.Getenv("ONE_SYSTEM_LOG_MODE")}
	if c.Mode == "" {
		c.Mode = "off"
		if c.Path != "" {
			c.Mode = "record"
		}
	}
	return c, c.validate()
}

func (c logSettings) validate() error {
	if c.Mode == "" || c.Mode == "off" {
		return nil
	}
	if c.Mode != "record" {
		return errors.New("ONE_SYSTEM_LOG_MODE must be off or record")
	}
	if strings.TrimSpace(c.Path) == "" {
		return errors.New("ONE_SYSTEM_LOG_MODE=record requires ONE_SYSTEM_LOG_PATH")
	}
	return nil
}

// Separate file families keep audit retention independent from cache eviction and
// schema versions, including SQLite sidecars and existing filesystem aliases.
func separateStoragePaths(cachePath, logPath string) error {
	if cachePath == "" || logPath == "" {
		return nil
	}
	canonical := func(path string) (string, error) {
		path, err := filepath.Abs(path)
		if err != nil {
			return "", err
		}
		suffix := ""
		for {
			resolved, err := filepath.EvalSymlinks(path)
			if err == nil {
				return filepath.Join(resolved, suffix), nil
			}
			parent := filepath.Dir(path)
			if !errors.Is(err, os.ErrNotExist) || parent == path {
				return "", err
			}
			if _, inspectErr := os.Lstat(path); !errors.Is(inspectErr, os.ErrNotExist) {
				return "", errors.New("could not inspect persistence path")
			}
			suffix = filepath.Join(filepath.Base(path), suffix)
			path = parent
		}
	}
	type fileIdentity struct {
		path string
		info os.FileInfo
	}
	family := func(path string) ([4]fileIdentity, error) {
		var files [4]fileIdentity
		for i, suffix := range [...]string{"", "-wal", "-shm", "-journal"} {
			resolved, err := canonical(path + suffix)
			if err != nil {
				return files, errors.New("could not resolve persistence paths")
			}
			info, err := os.Stat(resolved)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return files, errors.New("could not inspect persistence paths")
			}
			files[i] = fileIdentity{path: resolved, info: info}
		}
		return files, nil
	}
	cache, err := family(cachePath)
	if err != nil {
		return err
	}
	logs, err := family(logPath)
	if err != nil {
		return err
	}
	for _, cacheFile := range cache {
		for _, logFile := range logs {
			if cacheFile.path == logFile.path || (cacheFile.info != nil && logFile.info != nil && os.SameFile(cacheFile.info, logFile.info)) {
				return errors.New("ONE_SYSTEM_LOG_PATH must differ from ONE_SYSTEM_CACHE_PATH, including SQLite sidecars")
			}
		}
	}
	return nil
}

type logRecord struct {
	Version      int    `json:"version"`
	ID           string `json:"id"`
	RequestID    string `json:"request_id"`
	ExchangeID   string `json:"exchange_id"`
	Kind         string `json:"kind"`
	Scope        string `json:"scope"`
	Time         int64  `json:"time"`
	Method       string `json:"method"`
	Path         string `json:"path"`
	BodyBase64   string `json:"body_base64"`
	BodyComplete bool   `json:"body_complete"`
	Status       *int   `json:"status,omitempty"`
	Cache        string `json:"cache,omitempty"`
	Error        string `json:"error,omitempty"`
}

type exchangeLog struct {
	db *sql.DB
}

func newExchangeLog(settings logSettings) (*exchangeLog, error) {
	if err := settings.validate(); err != nil {
		return nil, err
	}
	if settings.Mode == "" || settings.Mode == "off" {
		return nil, nil
	}
	db, err := openPrivateSQLite(settings.Path)
	if err != nil {
		return nil, errors.New("could not open exchange log")
	}
	logs := &exchangeLog{db: db}
	if err := logs.initialize(); err != nil {
		_ = db.Close()
		return nil, errors.New("could not initialize exchange log")
	}
	if err := checkPrivateSQLiteFiles(settings.Path); err != nil {
		_ = db.Close()
		return nil, errors.New("exchange log files must be private")
	}
	return logs, nil
}

func (l *exchangeLog) initialize() error {
	var journal string
	if err := l.db.QueryRow("PRAGMA journal_mode = WAL").Scan(&journal); err != nil {
		return err
	}
	if journal != "wal" {
		return errors.New("exchange log requires WAL")
	}
	if _, err := l.db.Exec("PRAGMA synchronous = FULL"); err != nil {
		return err
	}
	_, err := l.db.Exec(`CREATE TABLE IF NOT EXISTS log_events (
		id TEXT PRIMARY KEY NOT NULL,
		request_id TEXT NOT NULL,
		exchange_id TEXT NOT NULL,
		record TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS log_events_request ON log_events(request_id);`)
	if err != nil {
		return err
	}
	rows, err := l.db.Query("SELECT id, request_id, exchange_id, record FROM log_events LIMIT 0")
	if err != nil {
		return err
	}
	return rows.Close()
}

func (l *exchangeLog) append(ctx context.Context, record logRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	// A disconnected client must not erase the response trace. Persistence has
	// its own bounded deadline; each INSERT returns only after its durable commit.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_, err = l.db.ExecContext(ctx, "INSERT INTO log_events (id, request_id, exchange_id, record) VALUES (?, ?, ?, ?)",
		record.ID, record.RequestID, record.ExchangeID, string(data))
	return err
}

func newLogID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

func (l *exchangeLog) begin(ctx context.Context, scope, method, path string, body []byte, complete bool, code string) (*logRecord, error) {
	id, err := newLogID()
	if err != nil {
		return nil, err
	}
	exchangeID, err := newLogID()
	if err != nil {
		return nil, err
	}
	requestID := id
	if gateway, ok := ctx.Value(gatewayLogKey{}).(*gatewayLogContext); ok {
		requestID = gateway.requestID
	}
	record := &logRecord{Version: 1, ID: id, RequestID: requestID, ExchangeID: exchangeID,
		Kind: "request", Scope: scope, Time: time.Now().UnixMilli(), Method: method, Path: path, Error: code}
	record.capture(body, complete)
	if err := l.append(ctx, *record); err != nil {
		return nil, err
	}
	// Only correlation metadata is needed after the durable request write.
	record.BodyBase64 = ""
	return record, nil
}

func (r *logRecord) capture(body []byte, complete bool) {
	if len(body) > maxBodyBytes {
		body, complete = body[:maxBodyBytes], false
	}
	r.BodyBase64 = base64.StdEncoding.EncodeToString(body)
	r.BodyComplete = complete
}

func (l *exchangeLog) finish(ctx context.Context, request *logRecord, status int, body []byte, complete bool, cache, code string) error {
	id, err := newLogID()
	if err != nil {
		return err
	}
	record := logRecord{Version: 1, ID: id, RequestID: request.RequestID, ExchangeID: request.ExchangeID,
		Kind: "response", Scope: request.Scope, Time: time.Now().UnixMilli(), Method: request.Method,
		Path: request.Path, Status: &status, Cache: cache, Error: code}
	record.capture(body, complete)
	return l.append(ctx, record)
}

func loggingUnavailable() *apiError {
	return &apiError{http.StatusServiceUnavailable, "logging_unavailable", "Exchange logging is unavailable"}
}

type gatewayLogKey struct{}

type gatewayLogContext struct {
	requestID string
	body      []byte
	err       error
}

func gatewayRequestBody(w http.ResponseWriter, req *http.Request) ([]byte, error) {
	if captured, ok := req.Context().Value(gatewayLogKey{}).(*gatewayLogContext); ok {
		return captured.body, captured.err
	}
	return io.ReadAll(http.MaxBytesReader(w, req.Body, maxBodyBytes))
}

// The gateway's response is buffered until its audit INSERT commits. This records
// generated bytes, not a promise that a disconnected client received them.
func (r *router) serveLoggedHTTP(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	body, readErr := io.ReadAll(http.MaxBytesReader(w, req.Body, maxBodyBytes))
	code := ""
	if readErr != nil {
		code = "invalid_body"
	}
	request, err := r.logs.begin(req.Context(), "gateway", req.Method, req.URL.EscapedPath(), body, readErr == nil, code)
	if err != nil {
		writeAPIError(w, *loggingUnavailable())
		return
	}
	ctx := context.WithValue(req.Context(), gatewayLogKey{}, &gatewayLogContext{requestID: request.RequestID, body: body, err: readErr})
	response := &loggedResponseWriter{header: make(http.Header)}
	r.serveHTTP(response, req.WithContext(ctx))
	status := response.status
	if status == 0 {
		status = http.StatusOK
	}
	for key, values := range response.header {
		w.Header()[key] = values
	}
	if err := r.logs.finish(ctx, request, status, response.body.Bytes(), true, response.header.Get("X-One-System-Cache"), response.errorCode); err != nil {
		writeAPIError(w, *loggingUnavailable())
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(response.body.Bytes())
}

type loggedResponseWriter struct {
	header    http.Header
	status    int
	body      bytes.Buffer
	errorCode string
}

func (w *loggedResponseWriter) Header() http.Header { return w.header }

func (w *loggedResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *loggedResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(body)
}
