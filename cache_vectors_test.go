package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Shared cross-runtime protocol vectors. The Hono gateway runs the same file
// in hono/src/cache.test.ts, so a divergence in the configuration revision,
// the JSON encoding of a routing setting, or the operator TTL syntax fails a
// test instead of silently partitioning one host's ledger from the other's.
type cacheProtocolVectors struct {
	AssetDigests map[string]struct{ SHA256 string } `json:"asset_digests"`
	Durations    []struct {
		Text        string `json:"text"`
		Nanoseconds string `json:"nanoseconds"`
		Invalid     bool   `json:"invalid"`
	} `json:"durations"`
	Revisions []struct {
		Name                   string            `json:"name"`
		Epoch                  string            `json:"epoch"`
		OpenAPIDigest          string            `json:"openapi_digest"`
		SelectorQuestionDigest string            `json:"selector_question_digest"`
		APIKey                 string            `json:"api_key"`
		Secrets                map[string]string `json:"secrets"`
		Registry               string            `json:"registry"`
		Questions              map[string]string `json:"questions"`
		Revision               string            `json:"revision"`
	} `json:"revisions"`
}

func readCacheProtocolVectors(t *testing.T) cacheProtocolVectors {
	t.Helper()
	data, err := os.ReadFile("examples/cache-revision-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors cacheProtocolVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Revisions) == 0 || len(vectors.Durations) == 0 || len(vectors.AssetDigests) == 0 {
		t.Fatal("cross-runtime vectors must cover asset digests, durations and revisions")
	}
	return vectors
}

// The revision vectors deliberately use synthetic artifact digests so they
// stay stable. This is the assertion that keeps each host's real digest
// honest: both implementations hash the same pinned files.
func TestCacheArtifactDigestsMatchPinnedFiles(t *testing.T) {
	sources := map[string][]byte{
		"schema/typesafe.openapi.json":             officialOpenAPI,
		"contract/backend-selection.question.json": backendSelectionQuestion,
	}
	vectors := readCacheProtocolVectors(t)
	if len(vectors.AssetDigests) != len(sources) {
		t.Fatalf("asset digests cover %d artifacts, want %d", len(vectors.AssetDigests), len(sources))
	}
	for path, embedded := range sources {
		onDisk, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if digest(onDisk) != digest(embedded) {
			t.Errorf("%s: the embedded copy no longer matches the file on disk", path)
		}
		if got := digest(embedded); got != vectors.AssetDigests[path].SHA256 {
			t.Errorf("%s digest is %s but the shared vectors expect %s; update the vectors deliberately, because every stored decision repartitions", path, got, vectors.AssetDigests[path].SHA256)
		}
	}
}

func TestCacheDurationVectors(t *testing.T) {
	for _, tc := range readCacheProtocolVectors(t).Durations {
		t.Run(tc.Text, func(t *testing.T) {
			got, err := time.ParseDuration(tc.Text)
			if tc.Invalid {
				if err == nil {
					t.Fatalf("%q parsed as %d ns but the shared vectors reject it", tc.Text, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("%q: %v", tc.Text, err)
			}
			if want := tc.Nanoseconds; want != int64String(int64(got)) {
				t.Fatalf("%q parsed as %s ns, want %s", tc.Text, int64String(int64(got)), want)
			}
		})
	}
}

func int64String(value int64) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}

// Configuration revisions are computed from a real registry document so the
// vector exercises parsing and normalization too, not just the framing.
func TestConfigurationRevisionVectors(t *testing.T) {
	for _, tc := range readCacheProtocolVectors(t).Revisions {
		t.Run(tc.Name, func(t *testing.T) {
			dir := t.TempDir()
			for name, source := range tc.Questions {
				writeVectorFile(t, filepath.Join(dir, name), source)
			}
			writeVectorFile(t, filepath.Join(dir, "registry.json"), tc.Registry)
			chdirForTest(t, dir)
			// Clear any operator cache configuration; the epoch is supplied by
			// the vector so the revision never depends on this machine.
			for _, name := range []string{"ONE_SYSTEM_CACHE_PATH", "ONE_SYSTEM_CACHE_MODE", "ONE_SYSTEM_CACHE_NAMESPACE", "ONE_SYSTEM_CACHE_EPOCH", "ONE_SYSTEM_CACHE_TTL", "ONE_SYSTEM_CACHE_MAX_BYTES", "ONE_SYSTEM_LOG_PATH", "ONE_SYSTEM_LOG_MODE"} {
				t.Setenv(name, "")
			}
			t.Setenv("ONE_SYSTEM_CONFIG", "registry.json")
			t.Setenv("ONE_SYSTEM_API_KEY", tc.APIKey)
			for name, value := range tc.Secrets {
				t.Setenv(name, value)
			}
			c, err := loadConfig()
			if err != nil {
				t.Fatalf("shared vector registry must load: %v", err)
			}
			c.cache.Epoch = tc.Epoch
			if got := configurationRevisionWith(c, tc.OpenAPIDigest, tc.SelectorQuestionDigest); got != tc.Revision {
				t.Fatalf("cross-runtime configuration revision mismatch: got %s, want %s", got, tc.Revision)
			}
		})
	}
}

// Go 1.23 is the module language version, so t.Chdir is unavailable. These
// tests never run in parallel, so restoring the directory is sufficient.
func chdirForTest(t *testing.T, dir string) {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previous); err != nil {
			t.Fatal(err)
		}
	})
}

func writeVectorFile(t *testing.T, path, source string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
}
