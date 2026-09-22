package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const decisionStoreVersion = 1

type decisionStore struct {
	db       *sql.DB
	maxBytes int64
}

func openDecisionStore(path string, maxBytes int64) (*decisionStore, error) {
	if maxBytes <= 0 {
		return nil, errors.New("cache max bytes must be positive")
	}
	db, err := openPrivateSQLite(path)
	if err != nil {
		return nil, err
	}
	store := &decisionStore{db: db, maxBytes: maxBytes}
	if err := store.initialize(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := checkPrivateSQLiteFiles(path); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

// Cache and audit stores share private-file handling, never schemas or retention.
func openPrivateSQLite(path string) (*sql.DB, error) {
	if path == "" || strings.ContainsAny(path, "\x00?#") || strings.HasPrefix(path, "file:") || path == ":memory:" {
		return nil, errors.New("SQLite path must be a plain local file path")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve SQLite path: %w", err)
	}
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return nil, fmt.Errorf("create SQLite directory: %w", err)
	}
	info, err := os.Stat(parent)
	if err != nil {
		return nil, fmt.Errorf("inspect SQLite directory: %w", err)
	}
	// A private directory also protects SQLite's sidecars during creation. Never
	// change permissions on a preexisting user directory to make it acceptable.
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("SQLite directory must be private (0700 or stricter)")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err == nil {
		if err := file.Close(); err != nil {
			return nil, fmt.Errorf("close new SQLite file: %w", err)
		}
	} else if !errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("create SQLite file: %w", err)
	}
	if err := checkPrivateSQLiteFiles(path); err != nil {
		return nil, err
	}

	// Build our own URI from the validated filename; caller-controlled URI
	// parameters cannot enable memory databases or alter connection settings.
	dsn := url.URL{Scheme: "file", Path: path}
	params := url.Values{}
	params.Set("mode", "rw")
	params.Set("_pragma", "busy_timeout(5000)")
	params.Set("_txlock", "immediate")
	dsn.RawQuery = params.Encode()
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, fmt.Errorf("open SQLite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

func checkPrivateSQLiteFiles(path string) error {
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		info, err := os.Lstat(path + suffix)
		if errors.Is(err, os.ErrNotExist) && suffix != "" {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect SQLite file: %w", err)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			return errors.New("SQLite database and sidecars must be regular files with mode 0600")
		}
	}
	return nil
}

func (s *decisionStore) initialize() error {
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("open cache transaction: %w", err)
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read cache version: %w", err)
	}
	switch version {
	case 0:
		var tables int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil {
			return fmt.Errorf("inspect unversioned cache: %w", err)
		}
		if tables != 0 {
			return errors.New("cache database has an unrecognized unversioned schema")
		}
		if _, err := tx.ExecContext(ctx, `CREATE TABLE decisions (
			key TEXT PRIMARY KEY NOT NULL,
			response BLOB NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			response_size INTEGER NOT NULL CHECK (response_size = length(response) AND response_size > 0)
		) WITHOUT ROWID;
		CREATE INDEX decisions_expiry ON decisions(expires_at);
		CREATE INDEX decisions_age ON decisions(created_at, key);
		CREATE TABLE decision_bytes (id INTEGER PRIMARY KEY CHECK (id = 1), size INTEGER NOT NULL CHECK (size >= 0));
		INSERT INTO decision_bytes VALUES (1, 0);
		CREATE TRIGGER decisions_insert AFTER INSERT ON decisions BEGIN
			UPDATE decision_bytes SET size = size + new.response_size WHERE id = 1;
		END;
		CREATE TRIGGER decisions_delete AFTER DELETE ON decisions BEGIN
			UPDATE decision_bytes SET size = size - old.response_size WHERE id = 1;
		END;
		CREATE TRIGGER decisions_update AFTER UPDATE OF response_size ON decisions BEGIN
			UPDATE decision_bytes SET size = size + new.response_size - old.response_size WHERE id = 1;
		END;
		PRAGMA user_version = 1;`); err != nil {
			return fmt.Errorf("create cache schema: %w", err)
		}
	case decisionStoreVersion:
		rows, err := tx.QueryContext(ctx, "SELECT key, response, created_at, expires_at, response_size FROM decisions LIMIT 0")
		if err != nil {
			return fmt.Errorf("read cache schema: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close cache schema query: %w", err)
		}
	default:
		return fmt.Errorf("unsupported cache schema version %d (supported: %d)", version, decisionStoreVersion)
	}
	// Also enforce a reduced size budget when an existing store is reopened.
	if err := s.pruneOldest(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit cache initialization: %w", err)
	}
	var journal string
	if err := s.db.QueryRowContext(ctx, "PRAGMA journal_mode = WAL").Scan(&journal); err != nil {
		return fmt.Errorf("enable cache WAL: %w", err)
	}
	if journal != "wal" {
		return fmt.Errorf("cache WAL unavailable: journal mode %q", journal)
	}
	return nil
}

func (s *decisionStore) Get(ctx context.Context, key string, now int64) ([]byte, error) {
	var body []byte
	err := s.db.QueryRowContext(ctx, "SELECT response FROM decisions WHERE key = ? AND expires_at > ?", key, now).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read cache entry: %w", err)
	}
	// Scanning into []byte transfers an independent copy to the caller.
	return body, nil
}

func (s *decisionStore) Put(ctx context.Context, key string, body []byte, now, expires int64) error {
	if len(body) == 0 {
		return errors.New("cache response must not be empty")
	}
	if int64(len(body)) > s.maxBytes {
		// Refusing a single oversized response must not evict useful entries.
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin cache write: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM decisions WHERE expires_at <= ?", now); err != nil {
		return fmt.Errorf("prune expired cache entries: %w", err)
	}
	if expires > now {
		if _, err := tx.ExecContext(ctx, `INSERT INTO decisions (key, response, created_at, expires_at, response_size)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET response = excluded.response, created_at = excluded.created_at,
			expires_at = excluded.expires_at, response_size = excluded.response_size`, key, body, now, expires, len(body)); err != nil {
			return fmt.Errorf("write cache entry: %w", err)
		}
	}
	if err := s.pruneOldest(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit cache write: %w", err)
	}
	return nil
}

func (s *decisionStore) pruneOldest(ctx context.Context, tx *sql.Tx) error {
	// SQLite maintains the payload counter even when another process writes.
	// Normal inserts cost O(1) accounting, not a scan of the entire ledger.
	var size int64
	if err := tx.QueryRowContext(ctx, "SELECT size FROM decision_bytes WHERE id = 1").Scan(&size); err != nil {
		return fmt.Errorf("read cache byte count: %w", err)
	}
	for size > s.maxBytes {
		var key string
		var removed int64
		if err := tx.QueryRowContext(ctx, "SELECT key, response_size FROM decisions ORDER BY created_at, key LIMIT 1").Scan(&key, &removed); err != nil {
			return fmt.Errorf("find oldest cache entry: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM decisions WHERE key = ?", key); err != nil {
			return fmt.Errorf("evict oldest cache entry: %w", err)
		}
		size -= removed
	}
	return nil
}

func (s *decisionStore) Close() error {
	return s.db.Close()
}
