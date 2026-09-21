package conformance

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testCanonicalSkillSDK(t *testing.T, runtime runtimeSpec, python string) {
	script, err := filepath.Abs(filepath.Join("..", "examples", "skill_suggestion.py"))
	if err != nil {
		t.Fatal(err)
	}
	const rank = `{"model":"synthetic-skill-ranker","answers":{` +
		`"which":{"type":"choice","choice":"slides-edit","confidence":0.8,"probabilities":{"notes-organize":0.05,"slides-author":0.3,"slides-edit":0.55,"tables-audit":0.1}},` +
		`"gate::acts_on_user_system":{"type":"noul","noul":0.9},` +
		`"gate::would_follow_documented_procedure":{"type":"noul","noul":0.9},` +
		`"gate::prose_suffices":{"type":"noul","noul":0.1}},"usage":{"input_tokens":20,"output_tokens":4}}`
	const rerank = `{"model":"synthetic-skill-verifier","answers":{` +
		`"which":{"type":"choice","choice":"slides-author","confidence":0.9,"probabilities":{"slides-author":0.8,"slides-edit":0.15,"tables-audit":0.05}},` +
		`"fits::slides-author":{"type":"noul","noul":0.1},` +
		`"fits::slides-edit":{"type":"noul","noul":0.8},` +
		`"fits::tables-audit":{"type":"noul","noul":0.1}},"usage":{"input_tokens":30,"output_tokens":4}}`
	// The cookbook gates the second Choice on max(fits), not on its winner's fit.
	// A different first-pass winner makes accidentally returning pass one observable.
	abstain := strings.ReplaceAll(rank, `"noul":0.9`, `"noul":0.1`)
	abstain = strings.Replace(abstain, `"gate::prose_suffices":{"type":"noul","noul":0.1}`, `"gate::prose_suffices":{"type":"noul","noul":0.9}`, 1)
	for _, tc := range []struct {
		name     string
		replies  []reply
		stdout   string
		exitCode int
	}{
		{"rank-then-verify", []reply{{body: rank}, {body: rerank}}, "slides-author\n", 0},
		{"model-abstention", []reply{{body: abstain}}, "no suggestion\n", 0},
		{"failure-is-not-abstention", []reply{{status: 422, body: `{"detail":{"message":"RAW_CAUSE_CANARY BACKEND_LOCAL_KEY_CANARY /synthetic/PRIVATE_ROOT_CANARY"}}`}}, "", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trace := &callTrace{}
			local := upstream(t, trace, "local", tc.replies...)
			g := start(t, runtime, registry("local", "", backend("local", local.URL, nil)), nil)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, python, script, "--model", "routing-demo", "Create a new slide deck from an outline.")
			command.WaitDelay = time.Second
			dir := t.TempDir()
			command.Dir = dir
			// In particular, do not inherit SKILLS_LIBRARY_PATH. The canonical
			// application must select its committed synthetic public corpus.
			command.Env = []string{
				"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "TMPDIR=" + dir,
				"PYTHONDONTWRITEBYTECODE=1", "PYTHONNOUSERSITE=1",
				"TYPESAFE_ENDPOINT=" + g.url, "TYPESAFE_API_KEY=" + publicKey,
			}
			var stdout, stderr limitedLog
			command.Stdout, command.Stderr = &stdout, &stderr
			err := command.Run()
			exitCode := 0
			if err != nil {
				if exit, ok := err.(*exec.ExitError); ok {
					exitCode = exit.ExitCode()
				} else {
					t.Fatalf("canonical example could not execute: %v", err)
				}
			}
			if ctx.Err() != nil {
				t.Fatal("canonical example did not finish within 10s")
			}
			if exitCode != tc.exitCode || stdout.String() != tc.stdout {
				t.Fatalf("canonical example exit=%d stdout=%q stderr=%q; want exit=%d stdout=%q", exitCode, stdout.String(), stderr.String(), tc.exitCode, tc.stdout)
			}
			if tc.exitCode == 0 && stderr.String() != "" {
				t.Errorf("successful example wrote stderr: %s", stderr.String())
			}
			for _, canary := range []string{publicKey, backendKey("local"), privateRoot, "RAW_CAUSE_CANARY"} {
				if strings.Contains(stdout.String()+stderr.String(), canary) {
					t.Error("canonical example exposed a synthetic secret/root/cause")
				}
			}
			destinations := make([]string, len(tc.replies))
			for i := range destinations {
				destinations[i] = "local"
			}
			trace.want(t, destinations...)
		})
	}
}
