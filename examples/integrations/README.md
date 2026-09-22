# Adding servers without owning inference

One System is HTTP/API plumbing. Existing compatible servers need a registry
entry and fixtures. A different wire protocol may need an isolated HTTP
translation; it must not invent decision probabilities or move model execution
into the gateway. Do not add loaders, tokenizers, trained prompt compilers,
GPU scheduling, engine dependencies, or a general plugin framework.

The gateway supports an explicit subset per server. A backend offering only
Choice remains useful. Capabilities reject unsupported requests; they do not
emulate missing features. Native confidence and distributions pass through.
Document semantic differences in the model description and candidate evidence.
Runtime-specific context validation remains upstream.

## Small admission workflow

1. Describe the use case, proposed HTTP integration, primitive subset, sources
   and unknowns in a candidate JSON file. Pin source revisions. Specify a
   `target` containing `endpoint`, request `model` and expected `response_model`
   before probing. These identify an observed server, not an attested checkpoint.
2. Ask the frozen [integration questions](../integration-review.questions.json)
   through One System using the official SDK. They examine inference ownership,
   semantic honesty, bounded integration, usefulness and the smallest wire path.
3. Probe the already-running external server directly and through its named
   gateway alias, using identical synthetic fixtures. Keep explicit capabilities
   and real native validation; do not add special gateway branches to pass tests.
4. Run the evidence gate. It never changes a registry or downloads anything.
   Registration for real traffic remains an explicit operator action.

Use the prepared SDK environment (`make setup-examples` if needed). The CLI
does not install packages or start servers. `--output` must name a new ignored
local directory. Requests, actual HTTP bodies (without headers), responses,
model identity and hashes are retained. Inputs may contain sensitive content:
select them explicitly and review them before sending to a hosted evaluator.

Prepare a review state, then submit through a running gateway configured with
`examples/jev-lint.backends.json`. Its named `hosted` alias resolves to the pinned
evaluator `jev-1.13.0`. Export the gateway key as `ONE_SYSTEM_API_KEY` locally.

```sh
mkdir -p evidence/local
jq '{candidate: .}' examples/integrations/simple-jev-choice-score.json \
  > evidence/local/candidate-state.json
.build/example-venv/bin/python examples/system_one_check.py review \
  --endpoint http://127.0.0.1:8092 --model hosted --expected-model jev-1.13.0 \
  --state evidence/local/candidate-state.json \
  --questions examples/integration-review.questions.json \
  --output evidence/local/candidate-review
```

The [Simple Jev registry](../simple-jev.backends.json) uses an independent public
demo for Choice/Score. Run either gateway with this registry and export its
public key as `ONE_SYSTEM_API_KEY`. The demo documents no authentication, but
our credential interface requires a nonempty binding; set `SIMPLE_JEV_API_KEY`
to a nonsecret placeholder such as `anonymous-demo`, never another provider's
credential. Requests below contain synthetic data. Verify the public model list
when using the example later: aliases and demo quotas can change.

```sh
.build/example-venv/bin/python examples/system_one_check.py probe \
  --endpoint http://127.0.0.1:8090 \
  --native-key-env SIMPLE_JEV_API_KEY \
  --candidate examples/integrations/simple-jev-choice-score.json \
  --fixtures examples/integrations/choice-score.fixtures.json \
  --output evidence/local/candidate-probe

.build/example-venv/bin/python examples/system_one_check.py gate \
  --candidate examples/integrations/simple-jev-choice-score.json \
  --review evidence/local/candidate-review \
  --probe evidence/local/candidate-probe
```

The candidate is the single source for the gateway alias, native endpoint,
request model and expected response model. The probe derives these values from
`id` and `target`; only the gateway endpoint and credential bindings are separate.

The probe uses actual official SDK serialization and typed parsing, validates
answer coverage, probability distributions, maximum-probability choices
(including ties), rubric mapping and expected scores,
checks model identity and SDK model discovery, and compares complete native and
gateway outputs. Default absolute numerical tolerance is `1e-6`; usage and
integer values must match exactly. A changed label fails. Every proposed
primitive must appear in the fixtures. No retries or redirects occur.

This is a fixture parity test, not a benchmark or universal certification.
It does not establish calibration, true token accounting, endpoint checkpoint
identity, all input combinations, concurrency or production availability.
The shared gateway conformance suite separately verifies hard rejection,
fallback paths, opaque keys, numeric preservation, credentials and host parity.
Add candidate-specific boundary/permutation fixtures as needed; native changes
under question renaming are observations, not a license to rewrite its prompt.

## Gate decisions

| Result | Meaning |
| --- | --- |
| `reject` | A review identifies an inference-boundary, semantic or scope violation. |
| `hold` | Evidence is missing or ambiguous; reported question IDs identify follow-up work. |
| `needs_endpoint_test` | Review supports a bounded integration but matching probe evidence is absent. |
| `ready_for_opt_in` | The reviewed proposal and recorded endpoint fixtures passed; no registry was changed. |

Readiness exits zero; other decisions exit one. Malformed, mismatched or failed
execution exits two with a JSON error code and a safe explanation on stderr.
The gate takes a candidate and evidence directories, then verifies the complete
bundles itself. Review request/response, wire captures, current rubric and
order-sensitive candidate hashes must match. Probe fixtures, requests, responses,
wire captures, hashes, target, parity and primitive coverage must agree. A report
without its evidence files cannot pass. Once review supports the integration,
an omitted probe yields `needs_endpoint_test`; a supplied corrupt or incomplete
bundle fails validation.
Editing evidence, questions or the proposal requires a fresh review/probe.
Files are local evidence, not signed attestations: the gate assumes an operator
who controls and reviews them. It is not a security boundary against fabricated
reports or prompt injection. A chosen-label probability below `0.8` causes a
conservative hold. That threshold is an explicit, uncalibrated review heuristic;
it is not an estimate of correctness or a cross-model confidence standard.

The source-reviewed Kev and Nimble cards intentionally lack a tested endpoint;
they cannot become ready from documentation alone. Nimble's question IDs and
option keys affect its trained prompt; preserve and disclose that behavior.
Simple Jev's Noul uses graded support, so the example excludes it instead of
converting it to binary probability. `library-only-extractor.json` is a synthetic
negative control that the gate should reject, not a claim about a real project.

## Use the same tool as a code linter

`review` accepts any explicit state file and native question artifact. For code
review, supply reviewed files under `state.sources` and use
`examples/agent-review.questions.json`. Include both Go and Hono sources when
checking shared behavior. Freeze questions/evaluator for before-and-after runs.
Keep historical runs, including uncertain or failed findings. Do not tune a
rubric or lower thresholds simply to make the current patch pass.

The critical questions include inference in the gateway, hard-capability bypass,
named-model substitution and model-specific core branches. They supplement
deterministic tests and source inspection. `make check-examples` (also exposed as `make check-review`) collects actual
review/probe/gate CLI and SDK scenarios against a synthetic loopback HTTP server,
including corrupted evidence and contradictory answers. The offline collector
requires no inference credentials. `make verify` passes these observed outcomes
to versioned System One questions; failed exact checks or missing evidence can
never become a positive verification.

## Review who a whole file is written for

When reader fit matters, use the existing `review` command with
[`file-audience.questions.json`](../file-audience.questions.json). Its four
independent native Nouls ask whether **this file as written** is for:

| Question | Reader |
| --- | --- |
| `audience.internal_humans` | People maintaining or developing this project |
| `audience.external_humans` | People using, integrating or evaluating this project |
| `audience.internal_agents` | AI agents maintaining or developing this project |
| `audience.external_agents` | AI agents using, integrating or evaluating this project |

These are overlapping roles, not a single-choice taxonomy: multiple audiences,
all four, or none can apply. Each answer is its own probability of yes; the four
values need not sum to one. Public contributor guidance can be internal-facing.
Audience is neither confidentiality nor a quality grade, and a human-readable
file is not automatically written for agents merely because an agent can read it.

Judge the addressed reader, not someone an agent is helping. A substantive
section for an audience counts even when other sections address different
readers. Contributor setup and dogfooding to develop this project are internal
work; using the product in another application is an external role.

Use the output to inspect unexpected reader assumptions, not to rewrite a file
until a probability rises. The labeled controls include mixed audiences,
generated data, human-only governance and an agent helping a human. They expose
primary-audience and reader/beneficiary confusion; they do not establish accuracy
on arbitrary repository files or justify an automatic audience gate.

Use the prepared environment and pinned gateway described above, with
`ONE_SYSTEM_API_KEY` exported locally. After reviewing the specifically selected
public `README.md` for private content, run from the repository root:

```sh
mkdir -p evidence/local
jq -n --arg path README.md --rawfile content README.md \
  '{path: $path, content: $content}' > evidence/local/file-audience-state.json
.build/example-venv/bin/python examples/system_one_check.py review \
  --endpoint http://127.0.0.1:8092 --model hosted --expected-model jev-1.13.0 \
  --state evidence/local/file-audience-state.json \
  --questions examples/file-audience.questions.json \
  --output evidence/local/file-audience-review
```

`state.path` identifies the file; `state.content` is its complete, exact text,
including the end of the file. The questions treat source content as data, not
instructions to obey. Do not send excerpts, silently truncate, or aggregate chunk
answers into a whole-file classification. If the complete request exceeds a
gateway/backend limit, report the explicit failure and no audience result; other
failed requests are not audience answers either.

The existing export warning applies: hosted evaluation sends the entire selected
file off-machine. Keep the state and evidence ignored under `evidence/local/`;
choose a new output directory for each run. Unlike the chunked release report,
this evidence includes source content in request bodies, along with raw answers,
returned model and wire bodies. `passed: true` means a valid exchange with the
expected model, not audience suitability or quality approval.

[`file-audience.fixtures.json`](../file-audience.fixtures.json) supplies labeled
whole-file controls for evaluating model judgments, not authoritative model
outputs or a claim of accuracy. This optional review adds no release gate,
required receipt or file header. Privacy/exposure checks remain the separate
[chunk-based public-release review](../../docs/public-release-review.md).
