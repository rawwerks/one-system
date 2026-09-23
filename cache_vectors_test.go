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

func TestDecisionKeyPortableVectors(t *testing.T) {
	data, err := os.ReadFile("examples/cache-key-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Name, Namespace, Revision, Request, SHA256 string }
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			if got := decisionKey(v.Namespace, v.Revision, []byte(v.Request)); got != v.SHA256 {
				t.Fatalf("cross-runtime key mismatch: got %s, want %s", got, v.SHA256)
			}
		})
	}
	// Each framed input partitions on its own; the conformance suite proves
	// the exact-request-bytes partition over HTTP.
	base := decisionKey("cache-test", "revision", []byte("{}"))
	for name, key := range map[string]string{
		"namespace": decisionKey("another-scope", "revision", []byte("{}")),
		"revision":  decisionKey("cache-test", "revision-2", []byte("{}")),
		"framing":   decisionKey("cache-test", "revision{", []byte("}")),
	} {
		if key == base {
			t.Errorf("a changed %s reused the decision key", name)
		}
	}
}

func cacheRevisionBase() config {
	one, half, yes := 1, 0.5, true
	return config{
		name: "routing-demo", addr: "127.0.0.1:8080", publicKey: "test-key", selector: "hosted",
		fallback: "local", escalationConfidence: 0.8,
		selection: &featureSelection{
			QuestionsFile: "examples/routing.questions.json", EscalateTo: "hosted",
			Rules:     []selectionRule{{Question: "needs_reasoning", Choice: "yes", Above: 0.7}},
			questions: map[string]json.RawMessage{"needs_reasoning": json.RawMessage(`{"type":"noul","instructions":"Does this need reasoning?"}`)},
		},
		backends: map[string]backend{
			"local": {ID: "local", BaseURL: "http://127.0.0.1:1", Model: "leaf", APIKeyEnv: "LOCAL_API_KEY", Description: "local", key: "leaf-key",
				Limits:       &limits{MaxCharacters: &one, MaxNonASCIILetterFraction: &half, MaxQuestions: &one, MaxCriteria: &one},
				Capabilities: &capabilities{QuestionTypes: []string{"noul"}, MaxQuestions: &one, MinCriteria: &one, MaxCriteria: &one, StructuredState: &yes}},
			"hosted": {ID: "hosted", BaseURL: "http://127.0.0.1:2", Model: "selector", Description: "hosted", key: "selector-key"},
		},
		cache: cacheSettings{Epoch: "epoch-1"},
	}
}

// A cached decision is only valid for the routing that produced it. Every
// setting that can change which backend answers, or whether a request is
// accepted, must therefore change the configuration revision.
func TestConfigurationRevisionCoversRoutingConfiguration(t *testing.T) {
	two, quarter, no := 2, 0.25, false
	local := func(change func(*backend)) func(*config) {
		return func(c *config) {
			b := c.backends["local"]
			l, k := *b.Limits, *b.Capabilities
			b.Limits, b.Capabilities = &l, &k
			change(&b)
			c.backends["local"] = b
		}
	}
	for _, tc := range []struct {
		name   string
		change func(*config)
	}{
		{"registry name", func(c *config) { c.name = "privacy-demo" }},
		{"epoch", func(c *config) { c.cache.Epoch = "epoch-2" }},
		{"public credential", func(c *config) { c.publicKey = "rotated-public-key" }},
		{"selector", func(c *config) { c.selector = "local" }},
		{"backend ID", local(func(b *backend) { b.ID = "renamed" })},
		{"backend model", local(func(b *backend) { b.Model = "leaf-v2" })},
		{"backend URL", local(func(b *backend) { b.BaseURL += "/alternate" })},
		{"backend credential variable", local(func(b *backend) { b.APIKeyEnv = "OTHER_API_KEY" })},
		{"backend credential", local(func(b *backend) { b.key = "rotated-leaf-key" })},
		{"registry description", local(func(b *backend) { b.Description = "changed routing criteria" })},
		{"fallback", func(c *config) { c.fallback = "hosted" }},
		{"no fallback", func(c *config) { c.fallback = "" }},
		{"escalation confidence", func(c *config) { c.escalationConfidence = 0.81 }},
		{"selection removed", func(c *config) { c.selection = nil }},
		{"selection escalation target", func(c *config) { c.selection.EscalateTo = "local" }},
		{"selection rule question", func(c *config) { c.selection.Rules[0].Question = "other" }},
		{"selection rule choice", func(c *config) { c.selection.Rules[0].Choice = "no" }},
		{"selection rule threshold", func(c *config) { c.selection.Rules[0].Above = 0.71 }},
		{"selection rule added", func(c *config) {
			c.selection.Rules = append(c.selection.Rules, selectionRule{Question: "needs_reasoning", Above: 0.9})
		}},
		{"selection question wording", func(c *config) {
			c.selection.questions["needs_reasoning"] = json.RawMessage(`{"type":"noul","instructions":"Is careful reasoning required?"}`)
		}},
		{"selection question ID", func(c *config) {
			c.selection.questions["renamed"] = c.selection.questions["needs_reasoning"]
			delete(c.selection.questions, "needs_reasoning")
		}},
		{"limits removed", local(func(b *backend) { b.Limits = nil })},
		{"limit characters", local(func(b *backend) { b.Limits.MaxCharacters = &two })},
		{"limit characters unset", local(func(b *backend) { b.Limits.MaxCharacters = nil })},
		{"limit script fraction", local(func(b *backend) { b.Limits.MaxNonASCIILetterFraction = &quarter })},
		{"limit questions", local(func(b *backend) { b.Limits.MaxQuestions = &two })},
		{"limit criteria", local(func(b *backend) { b.Limits.MaxCriteria = &two })},
		{"capabilities removed", local(func(b *backend) { b.Capabilities = nil })},
		{"capability question types", local(func(b *backend) { b.Capabilities.QuestionTypes = []string{"noul", "choice"} })},
		{"capability questions", local(func(b *backend) { b.Capabilities.MaxQuestions = &two })},
		{"capability minimum criteria", local(func(b *backend) { b.Capabilities.MinCriteria = &two })},
		{"capability maximum criteria", local(func(b *backend) { b.Capabilities.MaxCriteria = &two })},
		{"capability structured state", local(func(b *backend) { b.Capabilities.StructuredState = &no })},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := configurationRevision(cacheRevisionBase())
			if again := configurationRevision(cacheRevisionBase()); again != before {
				t.Fatalf("revision is not deterministic: %s then %s", before, again)
			}
			changed := cacheRevisionBase()
			tc.change(&changed)
			if configurationRevision(changed) == before {
				t.Fatal("answer-affecting change kept the same revision; stale decisions would be replayed")
			}
		})
	}
	t.Run("embedded selector question", func(t *testing.T) {
		before := configurationRevision(cacheRevisionBase())
		original := backendSelectionQuestion
		t.Cleanup(func() { backendSelectionQuestion = original })
		backendSelectionQuestion = append(append([]byte{}, original...), ' ')
		if configurationRevision(cacheRevisionBase()) == before {
			t.Fatal("changed selector question kept the same revision")
		}
	})
}
