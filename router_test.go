package main

import (
	"encoding/json"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// Routing behavior is specified over HTTP for both gateways in conformance/.
// Only properties that need the router's internals stay here.

type rawSelectorFixture struct {
	name      string
	state     json.RawMessage
	questions map[string]json.RawMessage
}

func rawSelectorFixtures(t testing.TB) (*router, []rawSelectorFixture) {
	t.Helper()
	var template map[string]json.RawMessage
	if err := json.Unmarshal(backendSelectionQuestion, &template); err != nil {
		t.Fatal(err)
	}
	r := &router{
		config: config{name: "routing-demo", selector: "local", backends: map[string]backend{
			"local":  {Model: "local-model", Description: "Local synthetic backend"},
			"remote": {Model: "remote-model", Description: "Remote synthetic backend"},
		}},
		selectorTemplate: template,
	}
	question := json.RawMessage(`{"type":"noul","instructions":"Is this synthetic?"}`)
	few := map[string]json.RawMessage{"q": question}
	many := make(map[string]json.RawMessage, 4096)
	for i := range 4096 {
		many["q"+strconv.Itoa(i)] = question
	}
	return r, []rawSelectorFixture{
		{"small", json.RawMessage(`"synthetic"`), few},
		{"large_state", json.RawMessage(`"` + strings.Repeat("a", 512<<10) + `"`), few},
		{"many_questions", json.RawMessage(`"synthetic"`), many},
	}
}

func TestRawSelectorConstructionHasBoundedAllocations(t *testing.T) {
	r, fixtures := rawSelectorFixtures(t)
	eligible := []string{"local", "remote"}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			// Raw disclosure passes through existing state. It must not allocate
			// proportional summaries or caller-question metadata that is discarded.
			// Keep the budget generous across Go versions, and do not run in parallel:
			// TotalAlloc is process-wide. Fixture setup and GC are outside the sample.
			runtime.GC()
			if _, _, err := r.selectionRequest(fixture.state, fixture.questions, eligible, true); err != nil {
				t.Fatal(err)
			}
			const calls = 32
			const bytesPerCall = 64 << 10
			var before, after runtime.MemStats
			var payload map[string]any
			runtime.ReadMemStats(&before)
			for range calls {
				var err error
				payload, _, err = r.selectionRequest(fixture.state, fixture.questions, eligible, true)
				if err != nil {
					t.Fatal(err)
				}
			}
			runtime.ReadMemStats(&after)
			runtime.KeepAlive(payload)
			allocated := after.TotalAlloc - before.TotalAlloc
			if allocated > calls*bytesPerCall {
				t.Fatalf("raw selector construction allocated %d bytes/call; budget is %d", allocated/calls, bytesPerCall)
			}
		})
	}
}

func BenchmarkRawSelectorConstruction(b *testing.B) {
	r, fixtures := rawSelectorFixtures(b)
	eligible := []string{"local", "remote"}
	for _, fixture := range fixtures {
		b.Run(fixture.name, func(b *testing.B) {
			var payload map[string]any
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				var err error
				payload, _, err = r.selectionRequest(fixture.state, fixture.questions, eligible, true)
				if err != nil {
					b.Fatal(err)
				}
			}
			runtime.KeepAlive(payload)
		})
	}
}
