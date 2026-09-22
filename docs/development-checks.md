# Development checks and review

Start with [CONTRIBUTING](../CONTRIBUTING.md) for the development environment. These are maintainer checks, not prerequisites for using a packaged gateway.

Run commands from the repository root. Go is required for the Go implementation and shared conformance suite; `mise.toml` pins the development toolchain. Hono uses Node 24 and Bun. Python example setup uses `uv` and Python 3.12, separately from the optional Torch environment.

Review `mise.toml`, run `mise trust` for a new checkout, then `mise install`. Make resolves the pinned Node executable through mise when available, so a Bun compatibility command named `node` cannot silently replace it. Without mise, put Node 24 on `PATH` or pass `NODE=/path/to/node`.

For the full gateway development environment, run `make setup-dev`, then `make doctor` and `make check-dev`. These targets do not install the optional Laya inference stack. `make doctor PROFILE=go` (or `hono` / `examples`) checks one part of the setup. Use `make check-secrets` to scan shareable working files, staged changes, and Git refs with secret values redacted. It does not replace review of private prompt/response content.

```sh
make setup build
make setup-hono build-hono
make setup-examples
make setup-verification
make check
make check-scenarios
make check-conformance
make check-worker
make check-worker-local
```

`make check-conformance` builds both servers, checks the prepared SDK environment, and drives their public HTTP endpoints against synthetic upstreams. It covers routing/disclosure, protocol fidelity, errors, credentials, bounds, disconnect cancellation, configuration, and the skill application through the official Python SDK. It does not call paid inference or load a private skill corpus.

Persistence conformance also exercises Go/Node cache interoperability, restart,
separate logging without caching, exact gateway/selector/backend bodies, rejected
requests, explicit-off behavior and storage failures that must prevent inference
or selector fallback. `make check-hono` runs the native cache/logging boundary
tests; `make check-worker-local` exercises D1/R2 using actual local workerd.

`make check` alone skips dual-runtime conformance unless its runtime environment variables are supplied. Hono build includes type checking. `check-worker` bundles and performs a Wrangler deployment dry run; it does not deploy or prove production Worker behavior. Dependency installation can require internet access even though the tests use local synthetic services.

The conformance runner verifies that Hono is running under real Node 24. `make check-conformance NODE=/path/to/node` selects that binary explicitly; direct Go test runs can set `ONE_SYSTEM_NODE_BINARY`. Bun is used as a package/script runner, not as a replacement for the Node server runtime.

`make check-examples` and `make check-conformance` require a prepared example environment; they do not install Python packages. The interpreter defaults to `.build/example-venv/bin/python`; point `EXAMPLE_VENV` at an existing environment directory to reuse an installation with `typesafe-sdk==0.7.0` and PyYAML. If a package age policy blocks setup, keep the pins and use an existing compatible environment or wait until the release is eligible.

Example installation uses the committed, hashed [`examples/requirements.lock`](../examples/requirements.lock). Regenerate it deliberately with `make update-examples-lock` when updating the inline dependency metadata, then review and test the resulting versions. A copied virtual environment is not a portable substitute for setup.

`hono/package-lock.json` and `verification/package-lock.json` are authoritative for
their separate packages. Local setup uses Bun with frozen locks and a three-day
minimum release age; migration-generated `bun.lock` files are ignored. Hono's
hosted setup uses `npm ci`; verifier setup uses `make setup-verification` in both
environments. The official JavaScript SDK stays out of gateway runtime dependencies.
`make check-verification` checks verifier lock consistency, TypeScript types, and
the existing verification tests; it does not install dependencies or call inference.

## System One reviews System One

`make verify` is the primary completion check: native tests plus graph-linked
System One judgments. We use it while developing the verifier itself. See the
[verification workflow](../verification/README.md) and [agent instructions](../AGENTS.md).


The [agent review questions](../examples/agent-review.questions.json) turn concrete
code-quality concerns into native Choice questions. The
[review registry](../examples/jev-lint.backends.json) pins the sole evaluator to
`jev-1.13.0`; set `ONE_SYSTEM_CONFIG=examples/jev-lint.backends.json` in `.env`,
run either gateway, and submit review requests with `model: "jev-lint"` through
the same authenticated interface used by other applications. Submit only source
you have reviewed for private content.

Freeze the selected questions before editing, send named source files in
`state.sources`, and preserve the exact request, response, and returned model.
Repeat with the same questions and evaluator after the change. Treat its answers
as review signals, then verify the change with source inspection, regression
tests, and shared conformance. Benchmark claims must identify the measured
function; they do not describe whole-request latency.

## Offline parity review

[The review collector](../examples/parity_review.py) emits an ordinary request without sending HTTP or changing source files. After reviewing the selected public source for private data, collect a scoped request:

```sh
mkdir -p "$HOME/scratch/one-system-review"
python3 examples/parity_review.py --model jev-lint --confirm-reviewed \
  --source router.go --source hono/src/app.ts \
  --invariant routing.soft-eligibility \
  --check conformance=not-run \
  > "$HOME/scratch/one-system-review/request.json"
```

The explicit `--model jev-lint` targets the review registry described above when the request is later submitted; select a different model explicitly for another gateway configuration. The explicit allowlist excludes runtime registries, private corpora, credential files, and historical inference evidence. Optional `--diff-base` includes reviewed diffs; `--impact-stdin` accepts projected dependency-impact data. Check results are caller-reported, not executed or verified by the collector. Inspect the whole generated request before any separate submission to a reviewer. Model review signals do not prove correctness.

`make true-up-check` builds and checks the declared dependency graph using `true-up 0.2.1`; `make true-up-impact BASE=HEAD` reports edit coverage. The graph is regenerable and uncommitted. These checks establish declared dependency coverage, not semantic equivalence; dependency declaration changes require human approval under the shared contract.

Checking is local-first. Run `make setup-hooks` once per clone, and again after `.githooks` changes. It copies the hooks into the clone's shared Git directory and points `core.hooksPath` there, so every worktree is gated whatever branch it holds; `make doctor` fails while the installed hooks are missing or outdated. `.githooks/pre-commit` runs Gitleaks on staged changes. `.githooks/pre-push` runs `make setup-dev check-push` on the tip commit of each pushed branch or tag in a clean detached checkout under `${XDG_CACHE_HOME:-~/.cache}/one-system/pre-push`, so uncommitted work is neither tested nor touched, and blocks the push on failure. A branch that predates `check-push` is held to `check-dev`. `check-push` is `check-dev` plus `go test -race`, `go vet` and the `true-up` gate: everything the hosted gateway workflow checks. A tree that has passed the same targets is not checked again; git notes and deleted refs are not checked; a commit that cannot be resolved or checked out blocks the push. `make check-commit REV=<commit>` runs the same gate without pushing. `jj git push` runs no Git hooks, so run `make check-commit` before it. Skip one push with `ONE_SYSTEM_SKIP_PRE_PUSH=1` and say so in review. `ONE_SYSTEM_PRE_PUSH_TARGETS` and `ONE_SYSTEM_PRE_PUSH_DIR` exist for the hook's own tests; a pass under other targets is never reused for the suite.

The repository `core.hooksPath` replaces a global one, so global hooks stop running for this clone; a global dispatcher is an alternative only if it runs both repository hooks. `make check-secrets` works independently of hook configuration.

All hosted workflows run only on explicit manual dispatch, never on branch or
version-tag pushes: `gh workflow run conformance.yml --ref <branch-or-tag>` and
`gh workflow run check.yml --ref <branch-or-tag>`. They provide optional hosted
and macOS coverage, not a required publishing service. For native macOS evidence,
use an actual Mac or explicitly request the relevant workflow; Linux checks and
cross-compilation cannot provide it. The manual `release.yml` workflow builds and
verifies bundles without publishing. Follow the
[local release recipe](../CONTRIBUTING.md#publish-a-go-release) to publish without
Actions; the local push gate, security review, and semantic verification
obligations still apply.

This policy applies to revisions containing these workflow definitions. Older
revisions retain their old triggers and publishing steps; review those definitions
before pushing a tag at, or dispatching a workflow against, historical source.

No local result certifies a deployed Worker. Recorded experiment evidence from earlier development is not part of this repository.

## Validate the Laya adapter


Adapter checks are separate from gateway-only development and CI:

```sh
# First complete the full developer setup in CONTRIBUTING.md, plus an adapter setup.
LAYA_MODEL_PATH=models/laya LAYA_RUNTIME=torch make check-laya
LAYA_MODEL_PATH=models/laya LAYA_RUNTIME=mlx make check-laya  # Apple Silicon
```

`check-laya` runs System One verification with the real adapter profile. It requires
the full Go/Hono/SDK developer setup (including true-up and Gitleaks), an installed
adapter runtime, `LAYA_MODEL_PATH`, and hosted evaluator credentials; missing
evidence is incomplete. `make check-laya-startup` collects startup/runtime
observations without a checkpoint. Full scenarios cover Choice, Score and Noul
HTTP inference, structured legends, authentication, overflow rejection, live Go
forwarding and graceful shutdown. `check-laya` sources `.env`; sourced assignments
override exported variables. See [System One scenarios](../verification/SCENARIOS.md).

Earlier recorded experiments are historical results, not proof that every current
runtime or machine has been tested. On request, CI runs Linux and macOS gateway checks and a separate
optional-adapter workflow; it does not download a checkpoint or prove inference.
