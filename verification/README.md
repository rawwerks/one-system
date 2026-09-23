# Verification tooling

TypeScript tooling that sits above both gateways' HTTP interfaces. It runs on
Node 24 with no package dependencies; `make check-verification` type-checks it
and runs its tests.

| File | Purpose | Make target |
| --- | --- | --- |
| `scenarios.ts` + `repository.ts`, `examples.ts`, `worker.ts`, `persistence-worker.ts`, `laya.ts` | Cross-language scenarios with deterministic verdicts ([coverage](SCENARIOS.md)) | `check-scenarios`, `check-examples`, `check-worker-local`, `check-laya`, `check-laya-startup` |
| `package-go.ts`, `check-go-packages.ts` | Build and verify the downloadable Go bundles | `package-go`, `check-go-packages` |
| `review.ts` | Advisory review of changed files through One System to pinned Jev | `review` |
| `*.test.ts` | Tests for the tooling itself, the installer and the pre-push hook | `check-verification` |

Scenario runs write private evidence under `.build/scenarios/`; `make review`
writes its exact request and response under `.build/review/`. Both may contain
repository source and model output: keep them untracked and review them before
sharing. Real credentials are never recorded; scenarios may record explicitly
synthetic credentials to verify authentication and forwarding.

`make review` is advisory, never a gate. It sends the files changed since `BASE`
(default `HEAD`; `FILES="a b"` overrides) in `state.sources` with
[`agent-review.questions.json`](../examples/agent-review.questions.json)
(`QUESTIONS=path` overrides) to backend `hosted` of
[`jev-lint.backends.json`](../examples/jev-lint.backends.json), through a temporary
authenticated Go gateway. It needs `TYPESAFE_API_KEY` and may incur charges.
Confirm any finding with a test or by reading the source.

To add a scenario, append a row with an explicit contract and a deterministic
`passed` verdict computed from the actual observation, in the collector that owns
the group. Report unavailable prerequisites as `{ status: 'incomplete' }` rather
than passing.
