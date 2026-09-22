# One System verifies One System

Run `make verify` after [developer setup](../CONTRIBUTING.md). It uses Node 24 and
the official `@typesafe-ai/sdk` pinned in this directory. `make setup-dev` includes
`make setup-verification`, which installs that dependency independently of the
gateways. Set `TYPESAFE_API_KEY` for the hosted evaluator through your ignored
environment file or shell. The
command starts a temporary authenticated One System gateway with
`examples/jev-lint.backends.json` (automatic route `jev-lint`) and explicitly
requests backend ID `hosted`, the pinned `jev-1.13.0` evaluator, through its
ordinary HTTP API. `jev-lint` is the registry's name, not a rename of One System;
direct backend dispatch remains distinct from the automatic route.

Verification runs the native development suite, including both Go and Hono HTTP
conformance, then evaluates the declared semantic obligations. True-up resolves
the named source facts from each obligation's declared dependencies. Requests
contain only the explicitly exportable documentation/code chunks and synthetic
test observations. Review these sources before sending them to a hosted model.

The SDK constructs and authenticates System One requests. The verifier disables
SDK retries and logging and rejects redirects. A custom fetch hook bounds bodies
and records exact UTF-8 evidence before the SDK interprets HTTP errors. Raw-response
mode retains strict JSON parsing (including BOM rejection); answer validation,
model identity checks, sanitized failures, and verdict composition remain verifier
policy. This integration does not change or resolve semantic findings.

Exported source files and individual HTTP request/response bodies retain their
2 MiB limits. Local scenario aggregate files have a separate 16 MiB bound; they
are not submitted as one model state. Size failures stop verification rather than
silently dropping observations or truncating evidence.
Fixture snapshots describe synthetic inputs, not content observed on outgoing
requests. They omit Git administrative metadata; actual HTTP and CLI captures
establish what the application sent, returned or refused.

For manual review consumers, pass `--model jev-lint` when targeting that registry
automatically, or `--model hosted` for direct dispatch. Other registries advertise
their own required name first in authenticated `GET /v1/models`, followed by
backend IDs. There is no implicit `one-system` model; see the
[configuration and migration guide](../docs/configuration.md#registry-names-and-migration).

## Completion policy

<!-- true-up:anchor id=completion-policy -->
A failed native check makes verification fail. Missing semantic evaluations,
insufficient context, or evidence from changed source makes it incomplete.
A semantic contradiction needs review. Only passing native checks, current
evidence, and clear answers to every declared semantic obligation produce a
passed result. These outcomes cover the declared checks and recorded cases;
they do not certify every behavior, approve a merge, or prove graph completeness.
<!-- true-up:end id=completion-policy -->

The runner returns 0 for passed, 1 for native failure, 2 for incomplete, and 3
for semantic findings. Make maps any nonzero recipe result to 2; scripts needing
the distinct codes can run `node verification/verify.ts` with credentials already
in their environment. Choice probabilities and confidence remain in the report;
the native selected choice is authoritative, including exact ties. There is no
uncalibrated confidence threshold or retry loop toward a green answer.

`make verify VERIFY_ARGS=--native-only` runs offline checks but exits 2 and records
semantic checks as not run. `make check-dev` is the ordinary offline development
loop. Missing credentials never silently turn full verification into a pass.

## Evidence and scope

Each invocation creates a fresh `.build/verification/<run>/` directory. Use
`VERIFY_ARGS="--output my-run"` to choose a new run name. Existing directories
are refused. `report.json` links native outcomes, each semantic answer, and exact
request/response hashes. The directory also contains source snapshots, the
resolved graph, native logs, actual HTTP observations, and model request/response
bodies. Bounded, complete UTF-8 error replies are retained before validation;
partial, oversized or invalid UTF-8 replies retain the request only. Real
credentials and their authorization headers are excluded. Scenarios may record
explicitly synthetic credentials to verify authentication and forwarding. Keep these artifacts
private until reviewed; they can contain repository source and model output.
Repository and scratch roots are normalized before subprocess evidence is exported.
This does not make raw process logs or local inputs safe to publish.

The semantic scope is explicitly declared:

- `routing.hard-capabilities`: compare the documented type/criteria constraints
  with actual Go/Hono observations for two bypass regressions and a supported
  Choice control, through both automatic and named routing.
- `verification.evidence-integrity`: use the same System One evaluator to compare
  this completion policy with executions of the verifier's own outcome function.

- `system.repository`, `system.examples`, and `system.worker`: execute the
  cross-language scenarios described in [SCENARIOS.md](SCENARIOS.md), then compare
  each actual outcome with its contract in an isolated state. At most eight
  evaluation requests run concurrently; questions about the same case share state.
  Worker observations also cover opt-in D1 cache and R2 exchange history:
  exact replay, distinct recorded hits, error bodies, fail-closed writes,
  large-body capture, restart and retention independent of cache eviction.
  The existing per-scenario semantic question applies unchanged to these new
  observations; native Go/Hono conformance additionally exercises file-backed
  recording and cross-runtime cache replay.
- `system.laya`: optional real adapter verification with `--include-laya`; missing
  runtime or checkpoint leaves that profile incomplete.

Native tests remain authoritative for status codes, invocation counts, evidence
identity and content integrity. The semantic layer connects observations to
prose. The verifier's own native tests cover malformed model responses, missing
or stale evidence, duplicate/missing observations and incomplete outcomes.

## Extending the checks

Each JSON file in `obligations/` contains a stable obligation ID, named source
inputs, an evidence adapter and native Choice questions. Independent questions
over shared state run in one request; independent obligations run concurrently.
Add the declared `derives-facts-from` edges in `.true-up.json` and, where needed,
an explicit exportable source in `evidence.ts`. A graph edge alone cannot permit
an arbitrary private file to be sent to a model.

Start with an executable regression or observed outcome. Ask one narrow question
per semantic relationship and include `insufficient_context`. Freeze questions
before a comparison and retain failures. New dependencies and question changes
are reviewable source changes, not automatic repairs for a failed result.
