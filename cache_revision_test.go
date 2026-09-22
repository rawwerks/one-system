package main

import (
	"encoding/json"
	"testing"
)

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
