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

Run the checks relevant to the change. Routing or API-contract changes require
both gateway implementations and their shared conformance tests. Use the declared
true-up graph to inspect dependent artifacts; dependency/edit coverage does not
prove semantic correctness. Keep model questions as versioned artifacts and
evaluate their judgments on representative cases.

Use One System to build One System. This is a core development requirement.

Before changing meaningful behavior, read the relevant contract, tests and
verification obligations. Keep questions versioned and inspect their evidence;
do not tune a question merely to make an implementation pass.

Run `make verify` during development and before declaring meaningful work done
or ready for main. It runs native checks, collects real Go/Hono HTTP traces,
resolves true-up dependencies, and asks System One the declared semantic questions.
Use its findings to improve the code, documentation, questions, or tests, then
rerun the affected checks. Preserve negative results in local run directories.

`make check-dev` provides offline feedback. `make verify VERIFY_ARGS=--native-only`
records an incomplete verification; missing credentials or unavailable inference
do not count as completed dogfooding. Report the missing step explicitly.

Hosted workflows run only on explicit manual dispatch, never on branch or tag
pushes, so nothing checks a push unless the local gate does. Releases are built
and published locally using [the release recipe](CONTRIBUTING.md#publish-a-go-release);
the optional hosted release workflow verifies bundles but never publishes.
Local Linux checks do not establish native macOS coverage. Run `make setup-hooks`
in a new clone and after `.githooks` changes;
the pre-push hook then runs `make setup-dev check-push` on the tip of each pushed
branch or tag in a clean checkout and blocks a failing push, from every worktree.
The hook rejects non-deletion pushes from or to `refs/notes/*` before validation,
even with `ONE_SYSTEM_SKIP_PRE_PUSH=1`; note deletions are allowed.
Git `--no-verify` and `jj git push` do not enforce hooks and must not publish notes.
Run `make check-commit` before `jj git push`. A blocked push is a finding to fix,
not a reason to bypass the note guard.

Executable assertions establish behavior. Semantic checks compare scoped evidence
with documented promises. A clear answer is not a correctness certificate. Do
not weaken a test, delete a dependency, or relabel a finding just to get green.
Record and justify any reviewed change to questions or dependency declarations.

Keep Go and Hono independent. The verification consumer belongs above their HTTP
interfaces. Python remains an implementation dependency for existing adapter/SDK consumers.
Do not add Python tests or test discovery. Cross-language scenarios belong in
the System One verifier, with versioned questions and actual execution evidence.
Add shared verification tooling in TypeScript. Do not add inference engines to the gateways.

Stage new source files before verification so true-up can resolve them. Keep
prompts, contracts, tests, docs, and dependency declarations in sync. Save agent
handoff details in local-only Mycelium notes; normal local note reading and writing
remain supported. Never run `mycelium.sh sync-init`, push notes refs, or publish a
mirror containing notes. Never publish local verification bodies or logs without
reviewing their source and response contents for private information.

See [the verification workflow](verification/README.md) and [setup](CONTRIBUTING.md).
