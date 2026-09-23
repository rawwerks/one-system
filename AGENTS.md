# Developing One System

This file is for coding agents maintaining One System. User-facing explanations
belong in README.md; contribution setup and procedures belong in CONTRIBUTING.md.
Keep tracked instructions portable across contributors' machines.

## Required before any repository work

Every agent working on this repository must read
[the complete official TypeSafe skill](third_party/typesafe-skills/skills/typesafe-ai/SKILL.md)
before beginning any task, including reviews, documentation, tests, or implementation.
This applies to delegated agents as well. Do not rely on a summary or prior knowledge
as a substitute. If the skill is missing, initialize the submodule below and read it
before proceeding. If it cannot be loaded, report the blocker and stop repository work.

Follow the skill's guidance to consult the relevant live documentation. Jev returns typed
judgments and probabilities; application code composes them into behavior.

The upstream skills repository is a pinned Git submodule. If it is absent, run:

```sh
git submodule update --init --recursive
```

Keep upstream skill files unmodified. Update the submodule revision deliberately,
review the upstream changes, and commit the new gitlink with any affected project
guidance. Do not silently follow the upstream branch during builds or tests.

## Work and verify

Read CONTRIBUTING.md for setup, checks, and private-data handling. Inspect the
working tree and coordinate file ownership with other active agents before editing.
Preserve unrelated changes. Keep credentials, machine-specific paths, private
inputs, and generated experiment output out of tracked documentation.

Run the checks relevant to the change while developing, and `make check` before
declaring meaningful work done or ready for main. It is the one gate; the pre-push
hook and hosted workflow run exactly it. Routing or API-contract changes need both
gateway implementations and their shared conformance tests;
`make check-conformance ONE_SYSTEM_RUNTIMES=go` (or `hono`) is the fast inner loop.
Use `make true-up-impact BASE=<ref>` to list the implementations and conformance
cases that derive from a changed spec file; edit coverage is not semantic proof.

Use One System to build One System. Before changing meaningful behavior, read the
relevant contract and tests. `make review [BASE=<ref>]` sends your changed files
through One System to pinned Jev once and prints advisory judgments; confirm any
finding with a test or by reading the source. Keep model questions as versioned
artifacts and evaluate their judgments on representative cases; do not tune a
question merely to make an implementation pass. Missing credentials mean the
review did not run; say so rather than implying it passed.

Executable assertions establish behavior; a clear model answer is not a
correctness certificate. Do not weaken a test, delete a dependency declaration,
or relabel a finding just to get green. Hosted workflows run only on explicit
manual dispatch; releases follow [the release recipe](CONTRIBUTING.md#publish-a-go-release).
Local Linux checks do not establish native macOS coverage. The push gate, its note
guard and how to push with jj are described once, in
[the one gate](docs/development-checks.md#the-one-gate). A blocked push is a
finding to fix, not a reason to bypass the note guard.

Keep Go and Hono independent; they implement one spec in two languages, and the
conformance suite drives both over HTTP. Verification tooling belongs above their HTTP
interfaces. Python remains an implementation dependency for existing adapter/SDK consumers.
Do not add Python tests or test discovery. Cross-language scenarios belong in
`verification/` as TypeScript with deterministic verdicts and actual execution evidence.
Add shared verification tooling in TypeScript. Do not add inference engines to the gateways.

Stage new source files before verification so true-up can resolve them. Keep
prompts, contracts, tests, docs, and dependency declarations in sync. Save agent
handoff details in local-only Mycelium notes; normal local note reading and writing
remain supported. Never run `mycelium.sh sync-init`, push notes refs, or publish a
mirror containing notes. Never publish local review bodies or logs without
reviewing their source and response contents for private information.

See [verification tooling](verification/README.md) and [setup](CONTRIBUTING.md).
