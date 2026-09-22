package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func privateDecisionTestDir(t *testing.T) string {
	t.Helper()
	path := t.TempDir()
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDecisionStorePersistsIndependentResponses(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "private", "decisions.sqlite")
	store, err := openDecisionStore(path, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	body := []byte(`{"answer":true}`)
	if err := store.Put(ctx, "decision", body, 10, 100); err != nil {
		t.Fatal(err)
	}
	body[0] = '!'
	first, err := store.Get(ctx, "decision", 11)
	if err != nil || string(first) != `{"answer":true}` {
		t.Fatalf("stored response=%q, err=%v", first, err)
	}
	first[0] = '!'
	second, err := store.Get(ctx, "decision", 12)
	if err != nil || string(second) != `{"answer":true}` {
		t.Fatalf("response was aliased: %q, err=%v", second, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, "decision", 12); err == nil {
		t.Fatal("read after close succeeded")
	}
	if err := store.Put(ctx, "other", []byte("other"), 12, 100); err == nil {
		t.Fatal("write after close succeeded")
	}
	store, err = openDecisionStore(path, 100)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	persisted, err := store.Get(ctx, "decision", 13)
	if err != nil || string(persisted) != `{"answer":true}` {
		t.Fatalf("reopened response=%q, err=%v", persisted, err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		info, err := os.Stat(path + suffix)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Errorf("file %q has mode %o, want 0600", suffix, info.Mode().Perm())
		}
	}
}

func TestDecisionStoreExpiresWithoutReadRefresh(t *testing.T) {
	ctx := context.Background()
	store, err := openDecisionStore(filepath.Join(privateDecisionTestDir(t), "decisions.sqlite"), 100)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.Put(ctx, "decision", []byte("answer"), 10, 20); err != nil {
		t.Fatal(err)
	}
	for _, now := range []int64{10, 19, 20, 21} {
		body, err := store.Get(ctx, "decision", now)
		if err != nil {
			t.Fatal(err)
		}
		if now < 20 && string(body) != "answer" {
			t.Errorf("at %d got %q, want answer", now, body)
		}
		if now >= 20 && body != nil {
			t.Errorf("at expiry %d got %q, want miss", now, body)
		}
	}
}

func TestDecisionStoreEvictsOldestWithinByteBudget(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(privateDecisionTestDir(t), "decisions.sqlite")
	store, err := openDecisionStore(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if store != nil {
			_ = store.Close()
		}
	})
	put := func(key, body string, now int64) {
		t.Helper()
		if err := store.Put(ctx, key, []byte(body), now, 100); err != nil {
			t.Fatal(err)
		}
	}
	assertEntries := func(want map[string]string) {
		t.Helper()
		total := 0
		for _, key := range []string{"a", "b", "c", "oversized"} {
			body, err := store.Get(ctx, key, 10)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != want[key] {
				t.Errorf("key %s=%q, want %q", key, body, want[key])
			}
			total += len(body)
		}
		if total > 10 {
			t.Errorf("cached %d response bytes, budget is 10", total)
		}
	}
	put("a", "aaaa", 1)
	put("b", "bbbb", 2)
	if _, err := store.Get(ctx, "a", 2); err != nil {
		t.Fatal(err)
	}
	put("c", "cccc", 3)
	assertEntries(map[string]string{"b": "bbbb", "c": "cccc"})
	put("oversized", "01234567890", 4)
	put("b", "01234567890", 4)
	assertEntries(map[string]string{"b": "bbbb", "c": "cccc"})
	put("b", "BBBBBB", 5)
	assertEntries(map[string]string{"b": "BBBBBB", "c": "cccc"})
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = openDecisionStore(path, 6)
	if err != nil {
		t.Fatal(err)
	}
	assertEntries(map[string]string{"b": "BBBBBB"})
}

func TestDecisionStorePrunesExpiredBeforeUsefulEntries(t *testing.T) {
	ctx := context.Background()
	store, err := openDecisionStore(filepath.Join(privateDecisionTestDir(t), "decisions.sqlite"), 8)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.Put(ctx, "useful", []byte("keep"), 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "expired", []byte("gone"), 2, 3); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "new", []byte("next"), 3, 100); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"useful": "keep", "expired": "", "new": "next"} {
		body, err := store.Get(ctx, key, 3)
		if err != nil || string(body) != want {
			t.Errorf("key %s=%q, want %q, err=%v", key, body, want, err)
		}
	}
}

func TestDecisionStoreRejectsUnsupportedVersion(t *testing.T) {
	path := filepath.Join(privateDecisionTestDir(t), "decisions.sqlite")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("PRAGMA user_version = 42"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := openDecisionStore(path, 100)
	if err == nil {
		_ = store.Close()
		t.Fatal("unsupported cache version was accepted")
	}
}

func TestDecisionStoreRejectsUnsafeOrBrokenPaths(t *testing.T) {
	for _, path := range []string{"", ":memory:", "file:cache.sqlite?mode=memory", "cache.sqlite?mode=memory"} {
		store, err := openDecisionStore(path, 100)
		if err == nil {
			_ = store.Close()
			t.Errorf("unsafe path %q was accepted", path)
		}
	}
	parent := t.TempDir()
	if err := os.Chmod(parent, 0755); err != nil {
		t.Fatal(err)
	}
	if store, err := openDecisionStore(filepath.Join(parent, "cache.sqlite"), 100); err == nil {
		_ = store.Close()
		t.Fatal("nonprivate parent directory was accepted")
	}
	info, err := os.Stat(parent)
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("existing parent directory was changed: info=%v, err=%v", info, err)
	}
	broken := filepath.Join(privateDecisionTestDir(t), "broken.sqlite")
	if err := os.WriteFile(broken, []byte("not a SQLite database"), 0600); err != nil {
		t.Fatal(err)
	}
	if store, err := openDecisionStore(broken, 100); err == nil {
		_ = store.Close()
		t.Fatal("corrupt database was accepted")
	}
}
