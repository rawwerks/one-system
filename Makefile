GO ?= go
UV ?= uv
PYTHON ?= python3
EXAMPLE_PYTHON ?= 3.12
BUN ?= bun
JS_RUN ?= $(BUN) run --cwd hono
# Resolve the pinned executable, since toolchain launchers may leave a Bun
# compatibility binary named node ahead of the real runtime on PATH.
NODE ?= $(shell command -v mise >/dev/null 2>&1 && mise which node 2>/dev/null || command -v node)
TRUE_UP ?= true-up
ONE_SYSTEM_RUNTIMES ?=
EXAMPLE_VENV ?= .build/example-venv
PROFILE ?= all
BUNDLE_OUT ?= .build/downloads

# These checks regenerate and consume the same Hono bundles. Keep this aggregate
# ordered even under make -j so workerd cannot read a half-written bundle.
.NOTPARALLEL: check

.PHONY: help setup setup-dev setup-hono setup-examples setup-laya setup-laya-mlx setup-hooks update-examples-lock doctor
.PHONY: build build-hono build-conformance package-go check-go-packages serve serve-hono serve-laya review
.PHONY: check check-commit check-go check-go-static check-hono check-worker check-worker-local check-conformance check-scenarios check-examples check-laya check-laya-startup check-verification check-secrets check-example-env true-up-build true-up-check true-up-impact

help:
	@printf '%s\n' \
	  'One System: a System One API router with model-based selection for multiple backends.' \
	  'Full developer setup: mise install && make setup-dev; inspect with make doctor.' \
	  'The one gate: make check (everything; the pre-push hook and hosted workflow run exactly this).' \
	  'Fast loop: make check-go; make check-conformance ONE_SYSTEM_RUNTIMES=go (or hono).' \
	  'Advisory dogfooding: make review [BASE=main] sends changed files through One System to pinned Jev once.' \
	  'Push gate: make setup-hooks once per clone; pre-push then runs make setup-dev check on each pushed branch or tag tip.' \
	  'Same gate without pushing: make check-commit REV=HEAD (required before jj git push, which runs no Git hooks).' \
	  'Hosted workflows are opt-in only: gh workflow run conformance.yml, check.yml, or release.yml --ref <revision>.' \
	  'Go router bootstrap: mise install && mise exec -- make setup build' \
	  'Go binary bundles: make package-go; make check-go-packages (four targets, host-native synthetic smoke).' \
	  'Go releases: publish verified local bundles with gh; see CONTRIBUTING.md. Branches and tags never trigger hosted workflows.' \
	  'Hono bootstrap: make setup-hono build-hono (Node 24/Bun; no Go or Python runtime required).' \
	  'Hono local service: make serve-hono (same ONE_SYSTEM_* and backend credential variables).' \
	  'Shared HTTP conformance: make check-conformance (isolated servers, synthetic upstreams, no paid inference).' \
	  'Example dependencies: make setup-examples (isolated SDK/YAML environment; no Torch; EXAMPLE_VENV overrides its path).' \
	  'Checks use the prepared example environment without installing packages.' \
	  'Public example checks: make check-examples. Private corpus binding: SKILLS_LIBRARY_PATH; never publish its value.' \
	  'Worker deployment check: make check-worker (bundle only; no account required).' \
	  'Worker local runtime check: make check-worker-local (synthetic loopback services, no deployment).' \
	  'Cross-language scenarios: make check-scenarios (offline, deterministic).' \
	  'Dependency checks: make true-up-check (true-up 0.2.1; newly added source files must be tracked).' \
	  'Edit coverage: make true-up-impact BASE=HEAD (advisory, not semantic proof).' \
	  'Optional local adapter: make setup-laya (requires uv; checkpoint supplied separately).' \
	  'Apple Silicon GPU: make setup-laya-mlx, then LAYA_RUNTIME=mlx make serve-laya.' \
	  'Optional adapter scenarios: make check-laya (requires an installed adapter and LAYA_MODEL_PATH).' \
	  'Configuration: backends.json (required name routing-demo, selector ID and HTTP backends; secrets referenced by env name).' \
	  'Configured backend IDs invoke that backend directly; the registry name enables automatic selection, with no implicit alias.' \
	  'Hard capabilities reject unsupported requests on every route; legacy limits remain soft preferences.' \
	  'Integration review/probe/gate: examples/system_one_check.py --help; no inference runtime management.' \
	  'Optional per-backend limits {max_characters,max_non_ascii_letter_fraction,max_questions,' \
	  'max_criteria} drop backends' \
	  'by preference; hard capabilities are never restored. One survivor skips selection.' \
	  'Optional fallback (backend ID) plus escalation_confidence (0-1) keep a request on the' \
	  'fallback unless the selector clears the threshold, and on selector failure.' \
	  'The selector receives the caller state only when the selector IS the fallback backend;' \
	  'otherwise it routes on question definitions plus size/script metadata (not an anonymity guarantee).' \
	  'Optional selection {questions_file,escalate_to,rules} asks the selector concrete questions' \
	  'about the task (the caller question instructions, never the state) and decides in code.' \
	  'A rule is {question,choice,above}: choice tests that choice probability, noul/score their value.' \
	  'Routing prompts are versioned artifacts, not hard-coded strings: examples/routing.questions.json.' \
	  'Privacy example: set ONE_SYSTEM_CONFIG=examples/privacy.backends.json in .env; make serve; request model privacy-demo.' \
	  '  (eligibility can select a sole destination directly; otherwise task rules govern escalation).' \
	  'Router env: ONE_SYSTEM_API_KEY plus backend credential variables from backends.json.' \
	  'Service targets and check-laya load .env if present; keep it mode 0600 and untracked.' \
	  'Laya env: LOCAL_API_KEY and LAYA_MODEL_PATH (existing English Laya checkpoint directory).' \
	  'Start separate terminals: make serve-laya ; make serve' \
	  'Query: POST /v1/systemone. Models: GET /v1/models. Capability extension: GET /v1/capabilities.' \
	  'Examples: examples/english.json and examples/multilingual.json use model routing-demo; match it to the active registry.' \
	  'Pinned Jev review: set ONE_SYSTEM_CONFIG=examples/jev-lint.backends.json in .env; make serve; request model jev-lint.' \
	  'Agent review: examples/agent-review.questions.json supplies native questions; send named source files in state.sources.' \
	  'Public-release review: examples/public_release_review.py --dry-run plans; --confirm-send sends every non-ignored file; --history adds all refs.' \
	  'Selector disclosure follows the configured mode; instructions and criteria may contain private data.' \
	  'Optional cache: ONE_SYSTEM_CACHE_PATH plus ONE_SYSTEM_CACHE_EPOCH; off without storage.' \
	  'Optional sensitive exchange history: ONE_SYSTEM_LOG_PATH (separate SQLite file); off without storage.' \
	  'Workers use optional ONE_SYSTEM_CACHE_DB (D1) and ONE_SYSTEM_LOG_BUCKET (R2) bindings. See docs/configuration.md.' \
	  'GET requests and POST requests require a Bearer key; listen addresses default to loopback.'

setup:
	$(GO) mod download

setup-dev: setup setup-hono setup-examples

# The optional inference adapter is separate from gateway development.
setup-laya:
	$(UV) run --no-project --python 3.12 python scripts/check_package_age.py
	$(UV) sync --locked --python 3.12

setup-laya-mlx:
	$(UV) run --no-project --python 3.12 python scripts/check_package_age.py
	$(UV) sync --locked --python 3.12 --extra mlx

# hono/bun.lock is the only JavaScript lock; installs honor the three-day release age.
setup-hono:
	$(BUN) install --cwd hono --frozen-lockfile --minimum-release-age 259200

setup-examples:
	mkdir -p .build
	$(UV) venv --no-project --allow-existing --python "$(EXAMPLE_PYTHON)" "$(EXAMPLE_VENV)"
	$(UV) pip sync --require-hashes --python "$(EXAMPLE_VENV)/bin/python" examples/requirements.lock

update-examples-lock:
	$(UV) pip compile examples/skill_suggestion.py --universal --generate-hashes --output-file examples/requirements.lock

# Replaces any inherited hook chain. Hooks are copied into the shared Git
# directory, not referenced from a checkout, so every worktree of this clone is
# gated whatever branch it holds. Run again after .githooks changes.
setup-hooks:
	@hooks="$$(git rev-parse --path-format=absolute --git-common-dir)/hooks" && mkdir -p "$$hooks" && \
	  install -m 0755 .githooks/pre-commit .githooks/pre-push "$$hooks/" && \
	  git config --local core.hooksPath "$$hooks" && echo "Repository hooks installed in $$hooks"

# The push gate for one commit without pushing; jj git push runs no Git hooks.
REV ?= HEAD
check-commit:
	@printf 'refs/heads/check-commit %s refs/heads/check-commit -\n' "$$(git rev-parse --verify '$(REV)^{commit}')" | .githooks/pre-push

doctor:
	$(PYTHON) scripts/doctor.py --profile "$(PROFILE)" --node "$(NODE)" --go "$(GO)" --bun "$(BUN)" --uv "$(UV)" --example-venv "$(EXAMPLE_VENV)"

check-secrets:
	$(PYTHON) scripts/check_secrets.py

check-example-env:
	@test -x "$(EXAMPLE_VENV)/bin/python" || { echo 'Run make setup-examples first, or set EXAMPLE_VENV to an existing SDK environment.' >&2; exit 1; }
	@"$(EXAMPLE_VENV)/bin/python" -c 'from importlib.metadata import version; import typesafe_sdk, yaml; assert version("typesafe-sdk") == "0.7.0", "examples require typesafe-sdk 0.7.0"'

build:
	$(GO) build -o bin/one-system .

package-go:
	mkdir -p "$(dir $(BUNDLE_OUT))"
	$(NODE) verification/package-go.ts "$(BUNDLE_OUT)"

check-go-packages:
	$(NODE) verification/check-go-packages.ts "$(BUNDLE_OUT)"

build-hono:
	PATH="$(dir $(NODE)):$$PATH" $(JS_RUN) build

build-conformance:
	mkdir -p .build
	$(GO) build -o .build/one-system .

# The one gate. .githooks/pre-push and the hosted workflow run exactly this;
# the component targets below are for faster feedback while developing.
check: check-verification check-go-static check-hono check-conformance check-scenarios check-worker true-up-check check-secrets
# The gate always drives both implementations, whatever the environment or command line says.
check: override ONE_SYSTEM_RUNTIMES = go,hono

check-go:
	$(GO) test ./...

# Every Go test under the race detector, plus vet; the gate runs this instead of check-go.
check-go-static:
	$(GO) list ./...
	$(GO) test -race ./...
	$(GO) vet ./...

check-hono: build-hono
	$(NODE) --test hono/dist/cache.test.js hono/dist/logging.test.js

check-worker:
	PATH="$(dir $(NODE)):$$PATH" $(JS_RUN) check-worker

check-worker-local: build-hono
	$(NODE) verification/scenarios.ts --group worker

check-conformance: build-conformance build-hono check-example-env
	ONE_SYSTEM_GO_BINARY="$(abspath .build/one-system)" \
	ONE_SYSTEM_HONO_ENTRY="$(abspath hono/dist/node.js)" \
	ONE_SYSTEM_NODE_BINARY="$$(command -v "$(NODE)")" \
	ONE_SYSTEM_SKILL_PYTHON="$(abspath $(EXAMPLE_VENV)/bin/python)" \
	ONE_SYSTEM_RUNTIMES="$(ONE_SYSTEM_RUNTIMES)" \
	$(GO) test -count=1 ./conformance -timeout 5m

# Cross-language scenarios; each observation carries its own deterministic verdict.
check-scenarios: check-example-env build-hono build-conformance
	EXAMPLE_VENV="$(abspath $(EXAMPLE_VENV))" $(NODE) verification/scenarios.ts --group all

check-examples: check-example-env
	EXAMPLE_VENV="$(abspath $(EXAMPLE_VENV))" $(NODE) verification/scenarios.ts --group examples

check-laya-startup:
	$(NODE) verification/scenarios.ts --group laya-startup

check-laya:
	@set -a; test ! -f .env || . ./.env; set +a; exec $(NODE) verification/scenarios.ts --group laya

true-up-build:
	$(TRUE_UP) build

# Declared spec edges must resolve, and nothing may reference a machine-local path.
true-up-check: true-up-build
	$(TRUE_UP) --policy
	$(TRUE_UP) --externalities

BASE ?= HEAD
true-up-impact: true-up-build
	$(TRUE_UP) --impact --since $(BASE) --proof --json

serve:
	@set -a; test ! -f .env || . ./.env; set +a; exec ./bin/one-system

serve-hono: build-hono
	@set -a; test ! -f .env || . ./.env; set +a; exec $(NODE) hono/dist/node.js

serve-laya:
	@set -a; test ! -f .env || . ./.env; set +a; exec .venv/bin/python -m adapters.laya

# Advisory, never a gate: one request per run, answers are review signals.
review: build-conformance
	@set -a; test ! -f .env || . ./.env; set +a; exec $(NODE) verification/review.ts

check-verification:
	$(NODE) hono/node_modules/typescript/bin/tsc -p verification/tsconfig.json
	$(NODE) --test verification/*.test.ts
