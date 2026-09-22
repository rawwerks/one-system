package main

import (
	"encoding/json"
	"os"
	"testing"
)

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
}
